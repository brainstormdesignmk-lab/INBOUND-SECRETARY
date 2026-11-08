#!/usr/bin/env tsx
/**
 * bank-dynamic-audit — purge stored dynamic prose that breaks today's contracts.
 *
 * Every rule `validateDynamicAnswer` enforces is enforced on RECALL too, so a
 * stale row can never serve. It could still POISON the loop, though: the
 * nightly digest folds `bank_dynamic` rows into `bank_variants` + `bank_examples`,
 * and a presumption that is refused at serve time would be re-learned as prose
 * under a real bank key. The digest now runs the same predicate per row before
 * folding (refused rows are deleted there, counted as `refused`), so this
 * sweep is the operator's on-demand view of the same rule — it lists the rows
 * and purges them without waiting for the nightly run.
 *
 * It checks exactly what serves: `dynamicRowViolations(row)` is the same
 * predicate as generation and recall (property type the client never named,
 * EB/amount/address/rooms/area/year/floor, machine identity, hygiene, promise
 * bans). The row's own `msg` is the client question, so a type presumption is
 * judged against the turn that produced it.
 *
 * Usage:
 *   npm run bank:audit-dynamic                        (default data/lina.db, report)
 *   npm run bank:audit-dynamic -- --db data/tui.db    (another store)
 *   npm run bank:audit-dynamic -- --apply             (delete the bad rows)
 *
 * Exit code: 0 = done (including nothing to purge), 1 = bad args / DB error.
 */

import '../src/compat/node16';

import * as fs from 'fs';
import * as path from 'path';
import { Db } from '../src/store/db';
import { dynamicRowViolations } from '../src/llm/dynamicFallback';

interface Row { id: number; key: string; state: string; msg: string; answer: string }

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbArg = (() => {
  const i = args.indexOf('--db');
  return i >= 0 ? args[i + 1] : 'data/lina.db';
})();

if (!dbArg) {
  console.error('[bank-dynamic-audit] --db needs a path');
  process.exit(1);
}

const dbFile = path.resolve(process.cwd(), dbArg);
// Never CREATE a database: a mistyped path would otherwise report a clean
// sweep of an empty store, which is the opposite of information.
if (!fs.existsSync(dbFile)) {
  console.error(`[bank-dynamic-audit] no such database: ${dbFile}`);
  process.exit(1);
}

let db: Db;
try {
  db = new Db(dbFile);
} catch (e) {
  console.error(`[bank-dynamic-audit] cannot open ${dbFile}: ${(e as Error).message}`);
  process.exit(1);
}

const clip = (s: string, n = 72): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Old TUI snapshots predate bank_dynamic — a missing table is "nothing to
 *  audit", never a crash that leaves the operator unsure the sweep ran. */
const hasTable = (name: string): boolean =>
  !!db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

const rows = hasTable('bank_dynamic')
  ? db.db.prepare('SELECT id, key, state, msg, answer FROM bank_dynamic ORDER BY id ASC').all() as Row[]
  : [];
const doomed = rows
  .map(row => ({ row, reasons: dynamicRowViolations(row) }))
  .filter((x): x is { row: Row; reasons: string[] } => x.reasons.length > 0);

console.log(`[bank-dynamic-audit] db=${dbFile} mode=${apply ? 'APPLY' : 'dry-run'}`);
console.log(`[bank-dynamic-audit] bank_dynamic: ${doomed.length} of ${rows.length} rows break a serve-time contract`);
for (const d of doomed) {
  console.log(`  #${d.row.id} ${d.row.key} (state=${d.row.state}) — ${d.reasons.join('; ')}`);
  console.log(`    Q: ${clip(d.row.msg)}`);
  console.log(`    A: ${clip(d.row.answer, 110)}`);
}

if (doomed.length === 0) {
  db.db.close();
  process.exit(0);
}
if (!apply) {
  console.log('[bank-dynamic-audit] report only — re-run with --apply to delete');
  db.db.close();
  process.exit(0);
}

const tx = db.db.transaction(() => {
  const del = db.db.prepare('DELETE FROM bank_dynamic WHERE id = ?');
  for (const d of doomed) del.run(d.row.id);
});
tx();
db.db.close();
console.log(`[bank-dynamic-audit] deleted ${doomed.length} row(s) — the deterministic path owns those turns now`);
