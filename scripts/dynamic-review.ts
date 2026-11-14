#!/usr/bin/env tsx
/**
 * dynamic-review — the human gate in front of the learning loop (Phase 6).
 *
 * An answer the LLM wrote is stored QUARANTINED (`bank_dynamic.reviewed = 0`):
 * it was served to the client whose question produced it, and it may not be
 * recalled for anyone else until a human says the sentence is true and general.
 * `validateDynamicAnswer` is hygiene (no invented EB, no borrowed place, no
 * promise), NOT truth — a row that passes it can still be wrong for the next
 * client, which is exactly the `[22:58]`/learn.koja-cenata class.
 *
 * Usage:
 *   npm run bank:review-dynamic                     list rows awaiting review
 *   npm run bank:review-dynamic -- --db data/tui.db list
 *   npm run bank:review-dynamic -- approve <id>     allow recall for clients
 *   npm run bank:review-dynamic -- reject <id>      retire it (kept as history)
 *
 * Exit code: 0 = done, 1 = bad args / missing database / unknown id.
 */
import '../src/compat/node16';

import * as fs from 'fs';
import * as path from 'path';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';

const args = process.argv.slice(2);
const dbArg = (() => {
  const i = args.indexOf('--db');
  return i >= 0 ? args[i + 1] : 'data/lina.db';
})();
const positional = args.filter((a, i) => a !== '--db' && args[i - 1] !== '--db');
const command = positional[0] ?? 'list';
const idArg = positional[1];

if (!dbArg) {
  console.error('[dynamic-review] --db needs a path');
  process.exit(1);
}
const dbFile = path.resolve(process.cwd(), dbArg);
// Never CREATE a database: a mistyped path would report an empty review queue,
// which reads as "nothing to review" and is the opposite of information.
if (!fs.existsSync(dbFile)) {
  console.error(`[dynamic-review] no such database: ${dbFile}`);
  process.exit(1);
}

const clip = (s: string, n = 78): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

let db: Db;
try {
  db = new Db(dbFile);
} catch (e) {
  console.error(`[dynamic-review] cannot open ${dbFile}: ${(e as Error).message}`);
  process.exit(1);
}

const hasTable = (name: string): boolean =>
  !!db.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name);

if (!hasTable('bank_dynamic')) {
  console.log(`[dynamic-review] db=${dbFile} — no bank_dynamic table (nothing has been learned here yet)`);
  db.db.close();
  process.exit(0);
}

const bank = new BankStore(db);

if (command === 'list') {
  const rows = bank.dynamicAwaitingReview();
  console.log(`[dynamic-review] db=${dbFile} awaiting review: ${rows.length}`);
  for (const r of rows) {
    console.log(`  #${r.id} ${r.key} (state=${r.state})`);
    console.log(`    Q: ${clip(r.msg)}`);
    console.log(`    A: ${clip(r.answer, 120)}`);
  }
  if (rows.length > 0) {
    console.log('[dynamic-review] approve <id> to let it serve other clients, reject <id> to retire it');
  }
  db.db.close();
  process.exit(0);
}

if (command !== 'approve' && command !== 'reject') {
  console.error(`[dynamic-review] unknown command "${command}" — use list | approve <id> | reject <id>`);
  db.db.close();
  process.exit(1);
}
const id = Number(idArg);
if (!Number.isInteger(id) || id <= 0) {
  console.error(`[dynamic-review] ${command} needs a row id (see the list)`);
  db.db.close();
  process.exit(1);
}

// ONLY A QUARANTINED ROW IS REVIEWABLE. Approving an already-approved row would
// be a no-op that reads as success, and approving a PROCESSED row would revive
// retired prose — both are silent lies about what the operator just did.
const row = db.db.prepare(
  `SELECT id, key, msg FROM bank_dynamic WHERE id = ? AND processed = 0 AND reviewed = 0`,
).get(id) as { id: number; key: string; msg: string } | undefined;
if (!row) {
  console.error(`[dynamic-review] #${id} is not awaiting review (missing, already approved, or retired)`);
  db.db.close();
  process.exit(1);
}

const ok = command === 'approve' ? bank.approveDynamic(id) : bank.rejectDynamic(id);
console.log(`[dynamic-review] #${id} ${command === 'approve' ? 'APPROVED — recallable' : 'REJECTED — retired, kept as history'}`);
console.log(`  ${row.key} :: ${clip(row.msg)}`);
db.db.close();
process.exit(ok ? 0 : 1);
