import { rmSync } from 'fs';
import { loadConfig } from '../config';
import { Db } from '../store/db';
import { SessionStore } from '../fsm/session';
import { AppointmentStore } from '../store/appointments';
import { EscalationStore } from '../store/escalations';
import { MetaStore } from '../store/meta';
import { createLlm } from '../llm/factory';
import { Classifier } from '../llm/classify';
import { Responder } from '../llm/respond';
import { InboundHandler } from '../handlers/inbound';
import { ChannelRegistry } from '../channels/types';
import { FakeViber } from './fakeViber';
import { fakePropertyService } from './fixture';
import { PERSONAS } from './personas';
import { AssertionRunner, buildAssertions } from './assertions';
import * as readline from 'readline/promises';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

function argValue(flag: string, args: string[]): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

function isArg(flag: string, args: string[]): boolean {
  return args.includes(flag);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  // Default runs ALL personas (incl. the 'mile' escalation scenario) —
  // the acceptance test is not complete if a persona is sliced off.
  const owners = parseInt(argValue('--owners', args) ?? '5', 10) || 5;
  const interactive = isArg('--interactive', args);
  const only = argValue('--scenario', args);
  const cfg = loadConfig();

  if (!cfg.groqApiKey && !cfg.geminiApiKey) {
    console.error('[sim] no LLM key in .env (GROQ_API_KEY / GEMINI_API_KEY) — simulator needs a real LLM brain');
    process.exit(2);
  }

  // Fresh DB per run — a previous (possibly interrupted) run must never leak stale
  // sessions (e.g. a chat left 'terminated' would silence that persona forever).
  // Remove the WAL/SHM companions too: deleting only the main file while stale
  // -wal/-shm remain makes better-sqlite3 fail with SQLITE_IOERR_SHORT_READ.
  rmSync('data/sim.db', { force: true });
  rmSync('data/sim.db-wal', { force: true });
  rmSync('data/sim.db-shm', { force: true });
  const db = new Db('data/sim.db'); // separate DB: never pollutes production counters
  const sessions = new SessionStore(db);
  const appointments = new AppointmentStore(db);
  const escalations = new EscalationStore(db);
  const meta = new MetaStore(db);

  const llm = createLlm(cfg);
  const classifier = new Classifier(llm, cfg, fakePropertyService());
  const responder = new Responder(llm, cfg);

  const fake = new FakeViber((cfg as { simFast?: boolean }).simFast === true);
  const channels = new ChannelRegistry();
  channels.register(fake);

  // Automated runs: local owner agent = instant deterministic verdicts (no waiting).
  // Must be set on cfg BEFORE the pipeline is built — ownerAgent is readonly and
  // chosen inside the InboundHandler constructor from deps.cfg.ownerAgentMode.
  cfg.ownerAgentMode = 'local';

  const pipeline = new InboundHandler({
    cfg, db, sessions, classifier, responder,
    properties: fakePropertyService(),
    appointments, escalations, meta, channels,
  });

  const personas = PERSONAS
    .filter(p => !only || p.key === only)
    .slice(0, owners);

  if (personas.length === 0) {
    console.error('[sim] no personas matched');
    process.exit(2);
  }

  console.log(`[sim] ${personas.length} owner(s) chatting simultaneously through ONE pipeline`);
  console.log(`[sim] fast=${(cfg as { simFast?: boolean }).simFast === true} interactive=${interactive}\n`);

  const rl = interactive
    ? readline.createInterface({ input: process.stdin, output: process.stdout })
    : null;

  const maxSteps = Math.max(...personas.map(p => p.script.length));
  const started = Date.now();

  outer:
  for (let i = 0; i < maxSteps; i++) {
    const batch = personas.filter(p => p.script[i]);
    // Staggered start so LLM calls genuinely overlap (the anti-ban test condition).
    await Promise.all(batch.map(async (p, idx) => {
      await sleep(idx * 120 + Math.random() * 200);
      const step = p.script[i];
      console.log(`[${p.key}] >> ${step.text}`);
      fake.pushUser(p.key, step.text);
      try {
        await pipeline.handle('viber', p.key, step.text, { kind: 'text', senderName: p.name });
      } catch (e) {
        console.error(`[sim] ${p.key} step ${i} failed:`, (e as Error).message);
      }
    }));

    if (interactive && rl) {
      for (;;) {
        const line = await rl.question('— Enter: next round | inject <key> <text> | q: quit —\n> ');
        if (line.trim() === '') break;
        if (line.trim().toLowerCase() === 'q') break outer;
        const m = line.trim().match(/^inject\s+(\w+)\s+(.+)$/);
        if (m) {
          const target = personas.find(x => x.key === m[1]);
          if (!target) { console.log(`unknown persona: ${m[1]} (have: ${personas.map(x => x.key).join(', ')})`); continue; }
          fake.pushUser(target.key, m[2]);
          await pipeline.handle('viber', target.key, m[2], { kind: 'text', senderName: target.name });
          break;
        }
        console.log('commands: <Enter> = next round, "inject <key> <text>", "q" = quit');
      }
    }
  }

  if (rl) rl.close();

  // Transcripts
  for (const p of personas) {
    console.log(`\n===== ${p.name} (${p.key}) — transcript =====`);
    for (const m of fake.log[p.key] ?? []) {
      console.log(`${m.role === 'user' ? '👤' : '🤖'} ${m.text}`);
    }
  }
  console.log(`\n[sim] ${fake.sends} outbound messages sent via fake channel in ${Date.now() - started} ms`);

  // Rule checks
  const runner = new AssertionRunner();
  buildAssertions(runner, { personas, fake, db, sessions });
  const results = runner.run();
  const ok = runner.summary(results);

  db.close();
  process.exit(ok ? 0 : 1);
}

main().catch(e => {
  console.error('[sim] fatal:', e);
  process.exit(1);
});
