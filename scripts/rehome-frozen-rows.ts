#!/usr/bin/env tsx
/**
 * rehome-frozen-rows — the operator re-home for frozen-misroute queue rows,
 * the scriptable equivalent of the bank:tui operator's retarget (K path).
 *
 * The route:health strict gate flags rows where a PROPERTY-price evaluation
 * was filed under a FROZEN policy key (the `MNOGU EFTINA CENA E TOA` family).
 * Those rows can never be edited (the pool is frozen) and keep the strict
 * gate red until their QUESTION is re-homed to its own learn.* route.
 *
 * What this script does, per flagged row:
 *   - compute the learn.* slug exactly like the TUI's suggestion
 *     (BankReview.learnKeySlug — same namespace a k-push from the review UI
 *     and a cron-created key land in);
 *   - validate it with the TUI's own key rules (validateBankKey);
 *   - set review_key (the retarget) + review_reason (the audit note). The
 *     ORIGINAL bank_key is NEVER rewritten — the routing evidence stays;
 *   - leave review_status untouched (the row stays visible as pending in the
 *     review UI, so the operator still sees it and can bank the wording).
 *
 * route:health reads review_key and stops flagging the row (the finding was
 * about the effective route, and the row has left the frozen key).
 *
 * Usage:
 *   npx tsx scripts/rehome-frozen-rows.ts            # dry-run: prints the plan
 *   npx tsx scripts/rehome-frozen-rows.ts --apply    # scans every data/*.db
 *   npx tsx scripts/rehome-frozen-rows.ts --apply --db data/tui.db
 *
 * --apply takes a <db>.pre-rehome-<timestamp>.bak copy first — the original
 * evidence file is never modified without a rollback point.
 */
import '../src/compat/node16';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { analyzeRows, type HealthRow } from '../src/scripts/routeHealth';
import { learnKeySlug, validateBankKey } from '../src/bank/review';

const apply = process.argv.includes('--apply');

function argValues(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => { if (a === name && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
}

function dbPaths(): string[] {
  const explicit = argValues('--db');
  if (explicit.length) return explicit;
  const dir = path.resolve('data');
  try {
    return fs.readdirSync(dir).filter(n => n.endsWith('.db')).map(n => path.join(dir, n));
  } catch {
    return [];
  }
}

function readRows(file: string): HealthRow[] | undefined {
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='enrichment_queue'").get();
    if (!has) return undefined;
    return db.prepare(
      `SELECT id, state, event_type AS eventType, bank_key AS bankKey, user_msg AS userMsg,
              review_key AS reviewKey, created_at AS createdAt
         FROM enrichment_queue ORDER BY id DESC LIMIT 5000`,
    ).all() as HealthRow[];
  } catch {
    return undefined;
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

let totalRehomed = 0;
for (const file of dbPaths()) {
  const rows = readRows(file);
  if (!rows) continue;
  const { findings } = analyzeRows(rows);
  const plan = findings
    .filter(f => f.kind === 'frozen-misroute' && f.id !== undefined)
    .map(f => {
      const row = rows.find(r => r.id === f.id)!;
      const alreadyHome = (row.reviewKey ?? '').trim();
      const slug = alreadyHome || learnKeySlug(row.userMsg);
      return { row, target: slug, keyError: validateBankKey(slug), alreadyHome };
    })
    .filter(p => !p.alreadyHome);
  if (plan.length === 0) continue;

  console.log(`\n${path.basename(file)} — ${plan.length} row(s) to re-home${apply ? '' : ' (DRY-RUN)'}`);
  for (const p of plan) {
    const note = `re-homed from frozen ${p.row.bankKey} (rehome-frozen-rows) — original serve kept as routing evidence`;
    if (p.keyError) {
      console.log(`  #${p.row.id} → REFUSED: ${p.keyError}`);
      continue;
    }
    console.log(`  #${p.row.id} "${p.row.userMsg.slice(0, 60)}" · ${p.row.bankKey} → review_key=${p.target}`);
    if (!apply) continue;

    // ROLLBACK POINT before the first write of this db.
    const bak = `${file}.pre-rehome-${Date.now()}.bak`;
    if (!fs.existsSync(bak)) fs.copyFileSync(file, bak);
    console.log(`    backup: ${path.basename(bak)}`);

    const db = new Database(file);
    try {
      const changed = db.prepare(
        'UPDATE enrichment_queue SET review_key = ?, review_reason = ? WHERE id = ? AND (review_key IS NULL OR review_key = \'\')',
      ).run(p.target, note, p.row.id).changes;
      if (changed) {
        totalRehomed += changed;
        console.log(`    ✓ re-homed (#${p.row.id} → ${p.target})`);
      } else {
        console.log(`    = already re-homed by a concurrent pass`);
      }
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  }
}

if (!apply) console.log('\n(dry-run: rerun with --apply to write)');
process.exitCode = 0;
console.log(`\ndone: ${totalRehomed} row(s) re-homed`);
