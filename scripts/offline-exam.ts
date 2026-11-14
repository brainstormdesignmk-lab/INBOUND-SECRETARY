#!/usr/bin/env tsx
/**
 * offline-exam — Phase 7: turn "free mode" from a LABEL into a MEASUREMENT.
 *
 * The appliance claims it answers known questions with no LLM. That claim has
 * never been measured, only asserted by the absence of a key in a config file.
 * This exam replays a fixed battery of real client turns through the REAL
 * handler with a brain that ALWAYS FAILS (a 429 on every call), so whatever is
 * served, is served without help. It reports:
 *
 *   deterministic %   — turns answered by code (the funnel's own lanes)
 *   bank %            — turns answered from a stored variant/approved row
 *   LLM calls / 100   — how often the appliance ASKED for help (each attempt is
 *                       counted even though the call throws: that is the honest
 *                       number for a quota-exhausted day)
 *   silent %          — turns where nothing at all was sent (the real failures)
 *   lanes / turn      — route tags per turn (a lane that logs nothing is a lane
 *                       the operator cannot see in `route:health`)
 *
 * Usage:
 *   npm run exam:offline                human table
 *   npm run exam:offline -- --json      machine output
 *   npm run exam:offline -- --strict    exit 1 when a threshold is missed
 *
 * Thresholds (--strict): silent ≤ 5%, deterministic+bank ≥ 80%. They are the
 * contract we are willing to publish, not a wish: raise them only with a batch
 * that earns it.
 */
import '../src/compat/node16';

import * as fs from 'fs';
import * as path from 'path';
import { InboundHandler } from '../src/handlers/inbound';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { SessionStore, freshSession } from '../src/fsm/session';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { LandmarkService } from '../src/geo/landmarks';
import { Db } from '../src/store/db';
import { EnrichmentStore } from '../src/store/enrichment';
import { loadConfig } from '../src/config';
import { setLearnedBank } from '../src/data/responseBank';

setLearnedBank({ variants: () => [], addVariant: () => false, addExample: () => false, metric: () => {}, retrieve: () => undefined } as never);

/** Every call fails — the appliance must answer without it, or the turn is a
 *  measured miss. The counter is the point: an ATTEMPT is a dependency. */
class CountingLlm {
  calls = 0;
  async complete(): Promise<string> { this.calls += 1; throw new Error('429 quota exhausted (exam)'); }
}

class FakeProps extends PropertyService {
  fail = false;
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> {
    if (this.fail) throw new Error('feed down (exam)');
    return this.rows;
  }
  get healthy(): boolean { return !this.fail; }
}

const ROWS: Property[] = [
  { eb: 44, id: 44, location: 'Скопје Север', price: 130000, service: 'buy', bedrooms: 4, size: '150 м²', house: true, dostapnoOd: 'Веднаш', lat: 42.0345, lon: 21.4149 },
  { eb: 55, id: 55, location: 'Капиштец', price: 120000, service: 'buy', bedrooms: 2, size: '68 м²', house: true, dostapnoOd: 'Веднаш' },
  { eb: 78, id: 78, location: 'Капиштец', price: 185000, service: 'buy', bedrooms: 3, size: '82 м²', dostapnoOd: '01.12.2026' },
  { eb: 79, id: 79, location: 'Водно', price: 300, service: 'rent', bedrooms: 2, size: '35 м²', dostapnoOd: 'Веднаш' },
];

/** THE BATTERY: the corpus captures plus the everyday lines the appliance must
 *  own with no brain (greeting, criteria, fee, commission, visit, goodbye). The
 *  corpus is read, never rewritten — an exam that edits its own questions is
 *  measuring the edit. */
const canon = [
  'ZDRAVO', 'BARAM STAN VO CENTAR', 'DO 150000 EVRA', 'DALI USTE E NA PRODAZBA 78?',
  'KOLKU E ZA POSETA?', 'NE SAKAM DA PLATAM ZA POSETA', 'KOLKU E PROVIZIJATA?',
  'KOJ JA PLAKJA PROVIZIJATA?', 'DOBRO, SE SOGLASUVAM SO USLOVITE', 'MOZE VO SABOTA?',
  'KAKVI DOKUMENTI MI TREBAAT?', 'NE FALA, CAO', 'GOSPODINE, DOBAR DEN',
  'KOJ BI MI GO PREPORACALE?', 'STO IMA KAJ GRADSKI PARK?', 'KAKO SE DVIGA KREDIT?',
];

function corpusTurns(): string[] {
  const file = path.join('tests', 'corpus', 'turns.jsonl');
  if (!fs.existsSync(file)) return [];
  const out: string[] = [];
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim() || line.startsWith('//')) continue;
    const row = JSON.parse(line) as { turns?: string[]; setup?: { batch?: number[] } };
    for (const t of row.turns ?? []) out.push(t);
  }
  return out;
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const strict = args.includes('--strict');
const cfg = loadConfig();
const db = new Db(':memory:');
const sessions = new SessionStore(db);
const properties = new FakeProps(ROWS);
const llm = new CountingLlm();
const channels = new ChannelRegistry();
const sent: string[] = [];
channels.register({ name: 'exam', send: async (_c: string, text: string) => { sent.push(text); } });
const handler = new InboundHandler({
  cfg, db, sessions, classifier: new Classifier(llm as never, cfg, properties),
  responder: new Responder(llm as never, cfg), properties,
  appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
  meta: new MetaStore(db), channels, enrichment: new EnrichmentStore(db),
  landmarks: new LandmarkService(db, { osm: false }),
});

(async () => {
  const turns = [...corpusTurns(), ...canon];
  const tally = { turns: 0, deterministic: 0, bank: 0, dynamic: 0, unknown: 0, llm: 0, silent: 0, lanes: 0, lanesLogged: 0 };
  const misses: Array<{ text: string; why: string }> = [];
  // Every turn runs in a FRESH session: the exam measures first-contact
  // coverage, not one chat's lucky context.
  for (const text of turns) {
    const chatId = `exam-${tally.turns}`;
    tally.turns += 1;
    const before = sent.length;
    const callsBefore = llm.calls;
    const orig = console.log;
    console.log = () => {};
    try {
      await handler.handle('exam', chatId, text);
    } finally {
      console.log = orig;
    }
    const s = sessions.get(chatId) ?? freshSession(chatId, 'exam');
    const audit = s.lastTurn;
    const served = sent.slice(before).join(' ');
    if (llm.calls > callsBefore) tally.llm += 1;
    const src = audit?.source ?? '';
    if (!served.trim()) {
      tally.silent += 1;
      misses.push({ text, why: 'nothing sent' });
    } else if (src === 'bank') tally.bank += 1;
    // A recall of a stored row is BANK COPY (a human approved it), even though
    // the store is called "dynamic": the source of truth is the reviewed text.
    else if (src === 'dynamic-recall') tally.bank += 1;
    else if (src.startsWith('dynamic')) tally.dynamic += 1;
    else if (src.startsWith('deterministic')) tally.deterministic += 1;
    else {
      // A served reply with no source is an untracked lane: it counts as a miss
      // in the audit column, never as "code" (that would flatter the number).
      tally.unknown += 1;
      misses.push({ text, why: `unattributed source (${src || 'empty'})` });
    }
    if (audit) { tally.lanes += 1; if (audit.lanes.length > 0) tally.lanesLogged += 1; }
    else misses.push({ text, why: 'no audit record' });
  }

  const pct = (n: number): number => (tally.turns === 0 ? 0 : Math.round((n / tally.turns) * 1000) / 10);
  const per100 = (n: number): number => (tally.turns === 0 ? 0 : Math.round((n / tally.turns) * 1000) / 10);
  const report = {
    turns: tally.turns,
    deterministicPct: pct(tally.deterministic),
    bankPct: pct(tally.bank),
    llmCallsPer100: per100(tally.llm),
    dynamicPct: pct(tally.dynamic),
    unattributedPct: pct(tally.unknown),
    silentPct: pct(tally.silent),
    auditCoveragePct: pct(tally.lanes),
    lanesPer100: per100(tally.lanesLogged),
    misses,
  };

  const fail = strict && (report.silentPct > 5 || report.deterministicPct + report.bankPct < 80);
  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(`[exam:offline] ${report.turns} first-contact turns, brain always failing (429 on every call)`);
    console.log(`  code (deterministic) : ${report.deterministicPct}%`);
    console.log(`  bank                 : ${report.bankPct}%`);
    console.log(`  LLM-written (dynamic): ${report.dynamicPct}%`);
    console.log(`  unattributed         : ${report.unattributedPct}%`);
    console.log(`  LLM calls / 100 turns: ${report.llmCallsPer100}`);
    console.log(`  silent (nothing sent): ${report.silentPct}%`);
    console.log(`  turn audit coverage  : ${report.auditCoveragePct}%`);
    console.log(`  lanes logged / 100   : ${report.lanesPer100}`);
    if (report.misses.length > 0) {
      console.log('  misses:');
      for (const m of report.misses.slice(0, 12)) console.log(`    - ${m.why}: ${JSON.stringify(m.text)}`);
    }
    console.log(fail ? '[exam:offline] STRICT: thresholds missed' : '[exam:offline] done');
  }
  db.db.close();
  process.exit(fail ? 1 : 0);
})();
