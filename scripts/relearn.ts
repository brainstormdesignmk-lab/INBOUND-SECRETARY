#!/usr/bin/env tsx
/**
 * bank:relearn — P2 of the closed-loop bank: your correction becomes the teacher.
 *
 * Until now a correction fixed the TRIGGER (detectors, via loop-a). This
 * fixes the ANSWER: hand Gemini the wrong reply, the correction, and the
 * key's P1 contract — the generalization it returns (5+ variants, all
 * constraint-checked) is STAGED for bank:review. Nothing serves until you
 * promote it. This is "one correction → N correct variants".
 *
 * FROZEN KEYS: fee.* / price.ask etc. are untouchable by the cron — but a
 * human correction unlocks exactly one staged regeneration round (the
 * correction is the key that fits the lock). Data-driven keys stay locked
 * forever: property facts are never prose.
 *
 * Usage:
 *   npm run bank:relearn -- --key fee.ask.buy --correction 12   # from bank_corrections
 *   npm run bank:relearn -- --key fee.ask.buy --text "…"        # ad-hoc correction
 *   npm run bank:relearn -- --list                              # staged candidates
 *   npm run bank:relearn -- --promote 34 35 36                  # approve staged rows
 *   npm run bank:relearn -- --reject 37                          # drop a staged row
 *   npm run bank:relearn -- --pending                            # captures awaiting a key
 *   npm run bank:relearn -- --bind 12 visit.interest             # verbatim, NO Gemini
 *   npm run bank:relearn -- --bind-file binds.txt                # many at once
 *   npm run bank:relearn -- --digest-dynamic                     # stage answers for review
 *   npm run bank:relearn -- --from-corrections [--dry] [--limit N]  # LOOP B batch (also in bank:tui: P)
 *
 * The four no-model commands are implemented in src/scripts/relearnBank.ts and
 * also ship COMPILED as dist/scripts/relearnBank.js — the atoms have no tsx, and
 * these are the commands that make sense to run there.
 *
 * --bind is the FREE half of the digest (step 3 of the loop). A dynamic row is
 * a client phrase the deterministic layer could not name + a generated answer.
 * The phrase→key binding is a routing fact, so a human supplies only the KEY and
 * nothing is generated: the phrase is written into bank_examples verbatim, the
 * dynamic row is deleted, and the next occurrence is served by the key's own
 * seeded/learned variants. Phrases under 4 chars have no retrieval path at all
 * (addExample's floor) — those are detector work, and --bind says so.
 */

import '../src/compat/node16';
import * as fs from 'fs';
import * as path from 'path';

import { Db } from '../src/store/db';
import { BankStore, FROZEN_BANK_KEYS } from '../src/store/bank';
import { main as relearnBankMain } from '../src/scripts/relearnBank';
import { loadConfig } from '../src/config';
import { constraintsFor } from '../src/llm/bankConstraints';
import { relearnCore, relearnFromCorrections, RelearnCoreResult } from '../src/bank/loopB';

const dbPath = process.argv.includes('--db') ? path.resolve(fs.realpathSync(process.argv[process.argv.indexOf('--db') + 1])) : loadConfig().dbPath;
const db = new Db(dbPath);
const bank = new BankStore(db);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function relearn(key: string, wrongReply: string, correction: string, correctionMsg: string): Promise<void> {
  console.log(`[relearn] ${key} — frozen: ${FROZEN_BANK_KEYS.has(key) ? 'yes (unlocked by this correction, STAGED only)' : 'no'}`);
  console.log(`[relearn] contract: ${constraintsFor(key).note}`);
  console.log(`[relearn] wrong reply: "${wrongReply.slice(0, 80)}…"`);
  const r: RelearnCoreResult = await relearnCore(bank, key, wrongReply, correction, correctionMsg);
  if (!r.ok) { console.error(`✗ ${key}: ${r.error}`); process.exit(1); }
  console.log(`[relearn] staged ${r.staged}/${r.kept} candidates for ${key} — review with: npm run bank:relearn -- --list, promote with --promote <id>`);
}

/** The CLI face of the LOOP-B batch — the implementation lives in
 *  src/bank/loopB.ts so the bank:tui 'P' menu runs the very same code. */
async function runBatch(): Promise<void> {
  await relearnFromCorrections(bank, {
    apply: !process.argv.includes('--dry'),
    limit: Number(arg('--limit') ?? 10),
    correctionText: arg('--text'),
    log: line => console.log(line),
  });
}

function list(): void {
  const rows = bank.stagedVariants();
  if (rows.length === 0) { console.log('(no staged candidates)'); return; }
  const byKey = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byKey.get(r.key) ?? [];
    arr.push(r);
    byKey.set(r.key, arr);
  }
  for (const [key, arr] of byKey) {
    console.log(`\n${key} (${arr.length} staged):`);
    for (const r of arr) console.log(`  #${r.id}  ${r.text.slice(0, 100)}${r.text.length > 100 ? '…' : ''}`);
  }
  console.log(`\npromote: npm run bank:relearn -- --promote <id>…   reject: npm run bank:relearn -- --reject <id>`);
}

async function main(): Promise<void> {
  // The no-model commands (digest / pending / bind / bind-file) live in src/ so
  // the ATOM can run them compiled (no tsx there). One implementation, two
  // entry points — see src/scripts/relearnBank.ts.
  const bankCli = relearnBankMain(process.argv.slice(2), { bank, db });
  if (bankCli !== undefined) process.exit(bankCli);
  if (process.argv.includes('--list')) { list(); return; }
  const promote = process.argv.includes('--promote');
  const reject = process.argv.includes('--reject');
  if (promote || reject) {
    const ids = process.argv.slice(process.argv.indexOf(promote ? '--promote' : '--reject') + 1)
      .filter(a => /^\d+$/.test(a)).map(Number);
    let n = 0;
    for (const id of ids) n += (promote ? bank.promoteVariant(id) : bank.deleteStagedVariant(id)) ? 1 : 0;
    console.log(`${promote ? 'promoted' : 'rejected'} ${n}/${ids.length} staged variant(s)`);
    return;
  }
  if (process.argv.includes('--from-corrections')) { await runBatch(); return; }
  const key = arg('--key');
  if (!key) {
    console.error('usage: npm run bank:relearn -- --key <key> (--correction <id> | --text "...") [--msg "..."]');
    console.error('       npm run bank:relearn -- --list | --promote <id>… | --reject <id>…');
    process.exit(1);
  }
  let wrongReply = '';
  let correction = '';
  let msg = '';
  const corrId = arg('--correction');
  if (corrId) {
    const rows = [...bank.correctionsByStatus('new'), ...bank.correctionsByStatus('staged'), ...bank.correctionsByStatus('processed')];
    const r = rows.find(x => x.id === Number(corrId));
    if (!r) { console.error(`correction #${corrId} not found`); process.exit(1); }
    wrongReply = r.reply;
    msg = r.msg;
    correction = arg('--text') ?? `See the supervisor's intent: the served reply was wrong for this situation. Key policy: ${constraintsFor(key).note ?? 'answer the client correctly'}.`;
  } else {
    wrongReply = arg('--wrong') ?? '(unrecorded)';
    correction = arg('--text');
    msg = arg('--msg') ?? '';
    if (!correction) { console.error('--text <correction> is required (or use --correction <id>)'); process.exit(1); }
  }
  await relearn(key, wrongReply, correction, msg);
}

main().catch(e => { console.error('[relearn] fatal:', e); process.exit(1); });
