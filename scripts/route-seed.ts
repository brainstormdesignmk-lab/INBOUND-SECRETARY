#!/usr/bin/env npx tsx
// route:seed — stage learned routes from the teachable corpus.
//
//   npm run route:seed                 # stage every clean identity (idempotent)
//   npm run route:seed -- --dry        # report what would be staged
//
// Rows arrive STAGED and never serve until LINA_ROUTES=serve AND they have
// shadow evidence. Commitment events are refused by the store itself.

import { Db } from '../src/store/db';
import { ClassifyTurnStore } from '../src/store/classifyTurns';
import { RouteStore } from '../src/store/routes';
import { buildCorpus } from '../src/scripts/routeCorpus';
import { parseRouteSig } from '../src/llm/routeSig';

const dry = process.argv.includes('--dry');
const db = new Db(process.env.DB_PATH || 'data/lina.db');
const ledger = new ClassifyTurnStore(db);
const routes = new RouteStore(db);
const rows = buildCorpus(ledger);

const counts = { inserted: 0, exists: 0, conflict: 0, refused: 0 };
const refusals: string[] = [];
for (const row of rows) {
  // The signature JSON is stored verbatim; a corrupted one is dead on arrival.
  const sig = parseRouteSig(
    (ledger.byKey(row.norm, row.sigKey, 1)[0]?.sig) ?? '{}',
  );
  if (!sig) { counts.refused++; refusals.push(`${row.norm}: unparseable sig`); continue; }
  if (dry) { counts.inserted++; continue; }
  const res = routes.upsertFromCorpus({
    norm: row.norm, state: row.state, sig: JSON.stringify(sig), sigKey: row.sigKey,
    event: row.event, source: 'corpus', note: `outcome=${row.outcome}`,
  });
  counts[res.action]++;
  if (res.action === 'refused') refusals.push(`${row.norm} (${row.event}): ${res.reason}`);
}

console.log(`[route:seed] corpus=${rows.length} ${dry ? '(dry run)' : ''}`);
console.log(`  inserted=${counts.inserted} exists=${counts.exists} conflict=${counts.conflict} refused=${counts.refused}`);
for (const r of refusals.slice(0, 20)) console.log(`  refused: ${r}`);
const stats = routes.stats();
console.log(`[route:seed] table: total=${stats.total} active=${stats.active} staged=${stats.staged} frozen=${stats.frozen} retired=${stats.retired}`);
db.close();
