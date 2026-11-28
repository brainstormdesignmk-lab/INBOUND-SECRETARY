#!/usr/bin/env npx tsx
// route:link — attach an OUTCOME to every unlinked classifier verdict.
//
// Read the runbook first (docs/classifier-build-runbook.md, Phase 1). The
// verdict's own event is never the label; the label is what happened next:
// a human correction, a silent pause (clean), a repeat, or a funnel move.
//
//   npm run route:link                 # link the unlinked tail
//   npm run route:link -- --limit 500  # bound the pass
//
// Read-only on the chat tables; writes ONLY classify_turns.outcome.

import { Db } from '../src/store/db';
import { ClassifyTurnStore } from '../src/store/classifyTurns';
import { linkOutcomes } from '../src/scripts/routeCorpus';

const args = process.argv.slice(2);
const limitArg = args.indexOf('--limit');
const limit = limitArg !== -1 ? Number(args[limitArg + 1]) : 2_000;

const db = new Db(process.env.DB_PATH || 'data/lina.db');
const store = new ClassifyTurnStore(db);
const before = store.count();
const stats = linkOutcomes(db, store, { limit });

console.log(`[route:link] ledger=${before} scanned=${stats.scanned} linked=${stats.linked}`);
const outcomes = Object.entries(stats.byOutcome).sort((a, b) => b[1] - a[1]);
for (const [name, n] of outcomes) console.log(`  ${name.padEnd(10)} ${n}`);
const tiers = Object.entries(stats.byTier).sort((a, b) => b[1] - a[1]);
for (const [name, n] of tiers) console.log(`  tier ${name.padEnd(7)} ${n}`);
console.log(`[route:link] still unlinked=${store.unlinked().length}`);
db.close();
