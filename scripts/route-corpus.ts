#!/usr/bin/env npx tsx
// route:corpus — what the teachable corpus actually contains.
//
//   npm run route:corpus                     # stats by state, event, week
//   npm run route:corpus -- --emit out.jsonl # write corpus rows
//   npm run route:corpus -- --since 2026-11-01
//
// A corpus row is a CLEAN turn with its route identity (norm + state + sigKey).
// Distinct vs repeated identities is the honest coverage measure: an
// exact-match table can only ever serve the repeated ones.

import { writeFileSync } from 'fs';
import { Db } from '../src/store/db';
import { ClassifyTurnStore } from '../src/store/classifyTurns';
import { buildCorpus, corpusStats } from '../src/scripts/routeCorpus';

const args = process.argv.slice(2);
const emitIdx = args.indexOf('--emit');
const sinceIdx = args.indexOf('--since');
const sinceMs = sinceIdx !== -1 ? Date.parse(args[sinceIdx + 1]!) : 0;
if (sinceIdx !== -1 && !Number.isFinite(sinceMs)) {
  console.error('[route:corpus] --since needs a parseable date');
  process.exit(2);
}

const db = new Db(process.env.DB_PATH || 'data/lina.db');
const store = new ClassifyTurnStore(db);
const rows = buildCorpus(store, { sinceMs });
const stats = corpusStats(rows);

console.log(`[route:corpus] teachable rows=${stats.total}`);
console.log(`[route:corpus] identities=${stats.distinctIdentities} repeated=${stats.repeatedIdentities}`);
const show = (label: string, m: Record<string, number>): void => {
  const entries = Object.entries(m).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return;
  console.log(`  ${label}:`);
  for (const [k, n] of entries.slice(0, 20)) console.log(`    ${k.padEnd(18)} ${n}`);
};
show('by state', stats.byState);
show('by event', stats.byEvent);
show('by day', stats.byWeek);

if (emitIdx !== -1) {
  const out = args[emitIdx + 1];
  if (!out) { console.error('[route:corpus] --emit needs a path'); process.exit(2); }
  writeFileSync(out, rows.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`[route:corpus] wrote ${rows.length} row(s) → ${out}`);
}
db.close();
