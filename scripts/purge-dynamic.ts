#!/usr/bin/env tsx
/**
 * purge-dynamic — remove learned prose that must never be served.
 *
 * The [08:35–08:38] transcript taught the bank two answers it should never
 * have learned: a name answer in the model's own wording and an age answer
 * that revealed „Јас сум дигитален асистент, па немам години“. The runtime
 * guards now refuse to GENERATE or RECALL such prose, but the rows are still
 * in the database — and the nightly digest will fold a personal question into
 * bank_examples and bank_variants if it runs before they are gone.
 *
 * This tool deletes exactly that class, from every table the digest touches:
 *
 *   bank_dynamic ...... the stored question/answer pairs
 *   bank_examples ..... the trigger phrasings the digest mined from them
 *   bank_variants ..... any stored variant that reveals a machine identity
 *   enrichment_queue .. the serve log rows that point at them (so a replay can
 *                       log a clean turn instead of being deduped)
 *
 * Usage:
 *   npm run bank:purge-personal -- --db data/tui.db          (report only)
 *   npm run bank:purge-personal -- --db data/tui.db --apply  (delete)
 *
 * Exit code: 0 = done (including nothing to purge), 1 = bad args / DB error.
 */

import '../src/compat/node16';

import * as fs from 'fs';
import * as path from 'path';
import { Db } from '../src/store/db';
import { detectPersonalAsk, revealsMachineIdentity } from '../src/llm/personal';

interface Row { id: number; key: string; state: string; msg: string; answer: string }

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbArg = (() => {
  const i = args.indexOf('--db');
  return i >= 0 ? args[i + 1] : 'data/lina.db';
})();

if (!dbArg) {
  console.error('[purge-dynamic] --db needs a path');
  process.exit(1);
}

const dbFile = path.resolve(process.cwd(), dbArg);
// Never CREATE a database here: a mistyped path would otherwise look like a
// clean sweep of an empty store.
if (!fs.existsSync(dbFile)) {
  console.error(`[purge-dynamic] no such database: ${dbFile}`);
  process.exit(1);
}
let db: Db;
try {
  db = new Db(dbFile);
} catch (e) {
  console.error(`[purge-dynamic] cannot open ${dbFile}: ${(e as Error).message}`);
  process.exit(1);
}

const clip = (s: string, n = 64): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function reasonFor(row: Row): string | undefined {
  if (detectPersonalAsk(row.msg)) return 'personal ask (owned by the deterministic personal lane)';
  if (revealsMachineIdentity(row.answer)) return 'machine-identity reveal';
  return undefined;
}

/** Old TUI snapshots predate bank_dynamic — a missing table is "nothing to
 *  purge", never a crash that leaves the operator unsure the sweep ran. */
function hasTable(name: string): boolean {
  return !!db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);
}

const rows = hasTable('bank_dynamic')
  ? db.db.prepare('SELECT id, key, state, msg, answer FROM bank_dynamic ORDER BY id ASC').all() as Row[]
  : [];
const doomed = rows
  .map(row => ({ row, reason: reasonFor(row) }))
  .filter((x): x is { row: Row; reason: string } => !!x.reason);

// The digest-mined copies of the same turns.
const examples = (hasTable('bank_examples')
  ? db.db.prepare('SELECT id, key, msg FROM bank_examples ORDER BY id ASC').all() as Array<{ id: number; key: string; msg: string }>
  : [])
  .filter(e => !!detectPersonalAsk(e.msg));
const variants = (hasTable('bank_variants')
  ? db.db.prepare('SELECT id, key, text FROM bank_variants ORDER BY id ASC').all() as Array<{ id: number; key: string; text: string }>
  : [])
  .filter(v => revealsMachineIdentity(v.text));
const queueIds = (hasTable('enrichment_queue')
  ? db.db.prepare(
    `SELECT id, bank_key, user_msg FROM enrichment_queue WHERE reply_source IN ('dynamic', 'dynamic-recall')`,
  ).all() as Array<{ id: number; bank_key: string | null; user_msg: string }>
  : [])
  .filter(q => !!detectPersonalAsk(q.user_msg) || (!!q.bank_key && doomed.some(d => d.row.key === q.bank_key)));

console.log(`[purge-dynamic] db=${dbFile} mode=${apply ? 'APPLY' : 'dry-run'}`);
console.log(`[purge-dynamic] bank_dynamic: ${doomed.length} of ${rows.length} rows`);
for (const d of doomed) {
  console.log(`  #${d.row.id} ${d.row.key} — ${d.reason}`);
  console.log(`    Q: ${clip(d.row.msg)}`);
  console.log(`    A: ${clip(d.row.answer, 96)}`);
}
console.log(`[purge-dynamic] bank_examples: ${examples.length}${examples.length ? ` (e.g. #${examples[0].id} ${clip(examples[0].msg)})` : ''}`);
console.log(`[purge-dynamic] bank_variants: ${variants.length}${variants.length ? ` (e.g. #${variants[0].id} ${variants[0].key})` : ''}`);
console.log(`[purge-dynamic] enrichment_queue: ${queueIds.length} serve-log rows`);

if (!apply) {
  console.log('[purge-dynamic] report only — re-run with --apply to delete');
  db.db.close();
  process.exit(0);
}

const tx = db.db.transaction(() => {
  const delDyn = db.db.prepare('DELETE FROM bank_dynamic WHERE id = ?');
  for (const d of doomed) delDyn.run(d.row.id);
  const delEx = db.db.prepare('DELETE FROM bank_examples WHERE id = ?');
  for (const e of examples) delEx.run(e.id);
  const delVar = db.db.prepare('DELETE FROM bank_variants WHERE id = ?');
  for (const v of variants) delVar.run(v.id);
  const delQueue = db.db.prepare('DELETE FROM enrichment_queue WHERE id = ?');
  for (const q of queueIds) delQueue.run(q.id);
});
tx();
db.db.close();
console.log('[purge-dynamic] deleted — the deterministic personal lane owns these turns now');
