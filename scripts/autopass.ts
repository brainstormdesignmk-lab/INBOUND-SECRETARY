#!/usr/bin/env tsx
/**
 * autopass — the running face of src/bank/autoPass.ts (runbook P5.3).
 *
 *   npm run bank:autoreject            # PASS 1 dry — what would bounce
 *   npm run bank:autoreject -- --apply # PASS 1 write
 *   npm run bank:rekey                 # PASS 2 dry — what would auto-stage
 *   npm run bank:rekey -- --apply      # PASS 2 write
 *   --db <path>                        # override the review master
 *
 * The decision and write logic lives in the LIBRARY (runAutoReject /
 * runRekey); this file only parses arguments and prints. The bank:tui 'P'
 * menu calls the very same runners on the same review master, so a write
 * from either face is byte-identical in the database and the audit trail.
 *
 * Both passes read the PENDING enrichment queue on the review master
 * (REVIEW_MASTER_DB, same DB bank:tui opens in place) and are mechanical:
 * PASS 1 dismisses genre-mismatched serves into bank_corrections (the
 * signal survives, unlike the UI's X), PASS 2 stages rows whose wording
 * already validates under the RESOLVED key. Dry is the default in both.
 */
import '../src/compat/node16';
import * as path from 'path';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { EnrichmentStore } from '../src/store/enrichment';
import { BankReview } from '../src/bank/review';
import { runAutoReject, runRekey } from '../src/bank/autoPass';
import { REVIEW_MASTER_DB } from '../src/bank/liveDb';

const args = process.argv.slice(2);
const PASS = args[0] === 'rekey' ? 'rekey' : 'reject';   // default = pass 1
const APPLY = args.includes('--apply');
const dbIndex = args.indexOf('--db');
const dbPath = path.resolve(process.cwd(), dbIndex >= 0 ? args[dbIndex + 1] : REVIEW_MASTER_DB);

const db = new Db(dbPath);
const bank = new BankStore(db);
const en = new EnrichmentStore(db);
const review = new BankReview(db, bank, en);

const run = PASS === 'rekey'
  ? runRekey(review, { apply: APPLY })
  : runAutoReject(review, { apply: APPLY });
const action = PASS === 'rekey' ? 'staged' : 'dismissed+recorded';

console.log(`\nPASS ${PASS === 'rekey' ? 2 : 1} · ${PASS === 'rekey' ? 'rekey' : 'auto-reject'} · ${APPLY ? 'APPLY' : 'DRY'} · ${dbPath} · pending: ${run.total}`);
for (const line of run.lines) console.log(`  ${line}`);
console.log(run.affected === 0
  ? (PASS === 'rekey'
    ? '  — nothing re-key-able among the pending rows —'
    : '  — no genre mismatches among the pending rows —')
  : `  ${run.affected} row(s) ${APPLY ? action : `would be ${action}`}`);
