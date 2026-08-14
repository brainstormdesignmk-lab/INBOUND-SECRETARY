import { Db } from '../store/db';
import { SessionStore } from '../fsm/session';
import { FakeViber } from './fakeViber';
import { Persona } from './personas';

export interface CheckResult {
  name: string;
  pass: boolean;
  error?: string;
}

export class AssertionRunner {
  private checks: { name: string; fn: () => boolean | void }[] = [];

  add(name: string, fn: () => boolean | void): void {
    this.checks.push({ name, fn });
  }

  run(): CheckResult[] {
    return this.checks.map(c => {
      try {
        const r = c.fn();
        return { name: c.name, pass: r !== false };
      } catch (e) {
        return { name: c.name, pass: false, error: (e as Error).message };
      }
    });
  }

  summary(results: CheckResult[]): boolean {
    const failed = results.filter(r => !r.pass);
    console.log('\n===== RULE / ANTI-BAN ASSERTIONS =====');
    for (const r of results) {
      console.log(`${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.error ? ` — ${r.error}` : ''}`);
    }
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    return failed.length === 0;
  }
}

export function buildAssertions(
  runner: AssertionRunner,
  deps: { personas: Persona[]; fake: FakeViber; db: Db; sessions: SessionStore }
): void {
  const { personas, fake, db, sessions } = deps;
  const byKey = (k: string) => personas.find(p => p.key === k);
  const allAssistant = (k: string) => fake.assistant(k).map(m => m.text);

  // 1. The bedroom question must appear VERBATIM (prototype rule).
  for (const key of ['goran', 'elena', 'ana']) {
    if (!byKey(key)) continue;
    runner.add(`${key}: exact bedroom question asked`, () => {
      const joined = allAssistant(key).join('\n').toLowerCase();
      // Rule 9 requires the exact prescribed wording — but the model may embed it in a
      // longer question ("…колку спални соби би сакале да има станот и до која цена…"),
      // so match case-insensitively without requiring the trailing question mark.
      if (!joined.includes('колку спални соби би сакале да има станот')) {
        throw new Error('bedroom question not asked in the prescribed form');
      }
    });
  }

  // 2. Terminology: never "ID"; always "Евидентен број".
  for (const p of personas) {
    runner.add(`${p.key}: never uses "ID"`, () => {
      for (const m of fake.assistant(p.key).map(x => x.text)) {
        if (/\bID\b/.test(m)) throw new Error(`found "ID" in: ${m.slice(0, 140)}`);
      }
    });
    runner.add(`${p.key}: uses "Евидентен број" for listings`, () => {
      if (p.key === 'troll' || p.key === 'mile') return;
      const joined = allAssistant(p.key).join('\n');
      if (!joined.includes('Евидентен број')) throw new Error('term never used');
    });
  }

  // 3. Never list more than 2 properties in a single message.
  for (const p of personas) {
    runner.add(`${p.key}: max 2 properties per message`, () => {
      for (const m of fake.assistant(p.key).map(x => x.text)) {
        const n = (m.match(/Евидентен број/g) ?? []).length;
        if (n > 2) throw new Error(`listed ${n} properties in one message`);
      }
    });
  }

  // 4. Viewing fee (300/500/600 MKD) must NEVER appear before the owner shows interest.
  for (const key of ['goran', 'elena', 'ana']) {
    const p = byKey(key);
    if (!p) continue;
    const interestIdx = p.script.findIndex(s => s.tags?.includes('interest'));
    if (interestIdx < 0) continue;
    runner.add(`${key}: viewing fee not mentioned before interest`, () => {
      const msgs = fake.assistant(key);
      for (let i = 0; i < interestIdx && i < msgs.length; i++) {
        if (/(?:300|500|600)\s*МКД|надомест/i.test(msgs[i].text)) {
          throw new Error(`fee leaked in reply #${i + 1}: ${msgs[i].text.slice(0, 140)}`);
        }
      }
    });
  }

  // 5. Ана asks for a 3rd option → Lina asks WHY, does not dump another listing.
  const ana = byKey('ana');
  if (ana) {
    runner.add('ana: asks why before offering new options', () => {
      const reply = fake.assistant('ana')[2];
      if (!reply) throw new Error('no reply to the 3rd-listing request');
      if (!/зошто|\?/.test(reply.text)) throw new Error(`no why/question: ${reply.text.slice(0, 140)}`);
      if ((reply.text.match(/Евидентен број/g) ?? []).length > 0) {
        throw new Error('listed properties instead of asking why');
      }
    });
  }

  // 6. Troll: 3 strikes → terminated, absolute silence afterwards.
  const troll = byKey('troll');
  if (troll) {
    runner.add('troll: strikes=3 and state=terminated', () => {
      const s = sessions.get(troll.key);
      if (!s) throw new Error('no session');
      if (s.strikes !== 3 || s.state !== 'terminated') {
        throw new Error(`strikes=${s.strikes} state=${s.state}`);
      }
    });
    runner.add('troll: zero output after termination', () => {
      const msgs = fake.assistant('troll');
      const users = (fake.log[troll.key] ?? []).filter(m => m.role === 'user').length;
      if (msgs.length !== users - 1) {
        throw new Error(`expected ${users - 1} replies (nothing after 3rd strike), got ${msgs.length}`);
      }
    });
  }

  // 7. Escalation: Миле must land in NEEDS_MANAGER_ASSISTANCE (escalated state).
  const mile = byKey('mile');
  if (mile) {
    runner.add('mile: session escalated', () => {
      const s = sessions.get(mile.key);
      if (!s || s.state !== 'escalated') throw new Error(`state=${s?.state ?? 'none'}`);
    });
    runner.add('mile: escalation row persisted', () => {
      const rows = db.db.prepare('SELECT * FROM escalations').all() as Record<string, unknown>[];
      if (!rows.some(r => Object.values(r).join(' ').includes('Миле'))) {
        throw new Error('Миле escalation row missing');
      }
    });
  }

  // 8. Appointments: buy → 500 MKD, rent → 300 MKD.
  runner.add('appointments: Горан (buy) → 500 MKD', () => {
    const rows = db.db.prepare('SELECT * FROM appointments').all() as Record<string, unknown>[];
    const hit = rows.some(r => {
      const v = Object.values(r).join(' ');
      return v.includes('Горан') && v.includes('500');
    });
    if (!hit) throw new Error('Горан row missing or wrong fee');
  });
  runner.add('appointments: Елена (rent) → 300 MKD', () => {
    const rows = db.db.prepare('SELECT * FROM appointments').all() as Record<string, unknown>[];
    const hit = rows.some(r => {
      const v = Object.values(r).join(' ');
      return v.includes('Елена') && v.includes('300');
    });
    if (!hit) throw new Error('Елена row missing or wrong fee');
  });

  // 9. Viber per-chat budget: never approach 100 outbound msgs without a reply.
  for (const p of personas) {
    runner.add(`${p.key}: outboundCount < 100/hr`, () => {
      const s = sessions.get(p.key);
      if (s && s.outboundCount >= 100) throw new Error(`outboundCount=${s.outboundCount}`);
    });
  }
}
