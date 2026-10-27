#!/usr/bin/env tsx
/**
 * transcript-replay — play a pasted conversation through the REAL pipeline and
 * print what every party sees.
 *
 *   npx tsx scripts/transcript-replay.ts chat.txt
 *   npm run replay -- chat.txt                 # same thing
 *   cat chat.txt | npx tsx scripts/transcript-replay.ts -
 *   npm run replay -- chat.txt --llm           # use the configured model too
 *   npm run replay -- tests/fixtures/transcripts/2157-cancel-wrong-eb.txt --check
 *
 * Why: a capture ("the owner was told EB 47 while the house is 62") is only
 * worth arguing about once it is a REPLAY. This runs the same InboundHandler,
 * VisitScheduler and deterministic detectors production runs, in an in-memory
 * DB, and prints the client panel, the owner panel and the operator log after
 * every turn — so a fix, or a regression, is visible as the message a party
 * would actually receive.
 *
 * Captures live in tests/fixtures/transcripts/ (*.txt). They are the same
 * format this tool reads, and `tests/transcript-fixtures.test.ts` replays all
 * of them offline, asserting the `# EXPECT` lines they carry — so a reported
 * bug keeps a replayable, checked transcript.
 *
 * The format (and the directives) are documented in scripts/transcriptReplay.ts.
 *
 * FLAGS
 *   --llm        use the configured LLM client (Gemini/Groq); default is
 *                deterministic-only, so a replay is reproducible and free
 *   --offline    do not fetch the live feed (visit lanes still run)
 *   --check      also evaluate the file's `# EXPECT` lines and exit non-zero on
 *                a failure
 *   --eb <n>     same as !eb at the start
 */

import '../src/compat/node16';
import * as fs from 'fs';
import { createLlm } from '../src/llm/factory';
import { loadConfig } from '../src/config';
import { Property, mapRow } from '../src/data/properties';
import { FEED_URL, NoLlm, checkExpectations, parseExpectations, parseTranscript, runTranscript } from './transcriptReplay';

/** Tiny argv split: `--flag` booleans, `--key value` pairs, one positional. */
function parseArgv(argv: string[]): { positional?: string; bools: Set<string>; vals: Map<string, string> } {
  const bools = new Set<string>();
  const vals = new Map<string, string>();
  let positional: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--eb') { vals.set(a, argv[++i] ?? ''); continue; }
    if (a.startsWith('--')) { bools.add(a); continue; }
    positional = a;
  }
  return { positional, bools, vals };
}

(async () => {
  const { positional: path, bools, vals } = parseArgv(process.argv.slice(2));
  const offline = bools.has('--offline');
  const check = bools.has('--check');

  const source = !path || path === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(path, 'utf8');
  let lines = parseTranscript(source);
  const startEb = Number(vals.get('--eb') ?? NaN);
  if (Number.isFinite(startEb)) lines = [{ kind: 'directive', name: 'eb', arg: String(startEb) }, ...lines];
  if (lines.length === 0) { console.error('empty transcript'); process.exit(2); }

  let properties: Property[] = [];
  if (!offline) {
    try {
      const raw = await (await fetch(FEED_URL)).json() as { properties: Record<string, unknown>[] };
      properties = raw.properties.map(mapRow).filter((r): r is Property => !!r);
      console.log(`feed: ${properties.length} properties (live)\n`);
    } catch (e) {
      console.log(`feed: FAILED (${(e as Error).message}) — continuing without it\n`);
    }
  } else {
    console.log('feed: off (--offline)\n');
  }

  const result = await runTranscript(lines, {
    properties,
    llm: bools.has('--llm') ? createLlm(loadConfig()) : new NoLlm(),
  });

  for (const seed of result.seeds) console.log(`  (seed: ${seed})`);
  if (result.seeds.length > 0) console.log();
  for (const turn of result.turns) {
    console.log(`[${turn.at}] КЛИЕНТ: ${turn.text}`);
    for (const m of turn.clientMsgs) console.log('  ЛИНА → КЛИЕНТ: ' + m.replace(/\n/g, '\n                '));
    for (const m of turn.ownerMsgs) console.log(`  ЛИНА → СОПСТВЕНИК (ЕБ ${m.eb}): ${m.text.replace(/\n/g, '\n                            ')}`);
    for (const m of turn.operatorLogs) console.log('  ЛОГ: ' + m.replace(/\n/g, ' '));
    console.log(`  (состојба: ${turn.state})\n`);
  }

  if (check) {
    const failures = checkExpectations(result, parseExpectations(source));
    if (failures.length > 0) {
      console.error(`EXPECT FAILED:\n  - ${failures.join('\n  - ')}`);
      process.exit(1);
    }
    console.log(`EXPECT: ${parseExpectations(source).length} expectation(s) hold`);
  }
})().catch(e => { console.error(e); process.exit(1); });
