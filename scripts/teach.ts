#!/usr/bin/env tsx
/**
 * bank:teach — record the answer the operator WANTS, verbatim.
 *
 * `bank:tui` (E, then A) does this for a queued turn you can see. This CLI is
 * for the other case: the operator knows the right wording and the turn is
 * easier to name than to re-find on screen ("the one where it said 26 July"),
 * or the turn is already gone from the log (`--ask`). It takes the correction
 * straight into the bank — no LLM regeneration, no paraphrase.
 *
 * What it writes (the one operator-correction intake):
 *   - the enrichment row's reply becomes the corrected text (so ENRICHMENT
 *     shows the right line and the nightly digest cannot re-learn the wrong
 *     one);
 *   - the operator's exact wording becomes a STAGED bank variant under the
 *     resolved key, with the client message as its retrieval example;
 *   - bank_corrections keeps the mistake AND the replacement.
 *
 * Usage:
 *   npm run bank:teach -- --list                    newest queued turns
 *   npm run bank:teach -- --list --chat client-1
 *   npm run bank:teach -- --id 195 --text "..."
 *   npm run bank:teach -- --chat client-1 --find "26 juli" --text "..."
 *   npm run bank:teach -- --id 195 --key learn.kade-e-26 --text "..."
 *   npm run bank:teach -- --id 195 --text "..." --serve   (stage + promote)
 *
 *   npm run bank:teach -- --ask "kako se vikas?" --key personal.name \
 *       --text "Се викам Лина. Дали барате стан за купување или изнајмување?"
 *
 * `--ask` is the "the correction just arose" path: no queue row needed. The
 * question is the retrieval example, the text is staged under the key, and the
 * audit row keeps both the question and the wording. This is how a correction
 * dictated in conversation lands in the bank when the original turn is already
 * gone from the log.
 *
 * --db defaults to the same live database `npm run bank:tui` opens.
 */

import '../src/compat/node16';

import * as fs from 'fs';
import * as path from 'path';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { EnrichmentStore } from '../src/store/enrichment';
import { applyOperatorCorrection } from '../src/bank/operatorCorrection';
import { pickLiveDb } from '../src/bank/liveDb';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = process.argv[i + 1];
  return !v || v.startsWith('--') ? '' : v;
}

const flag = (name: string): boolean => process.argv.includes(`--${name}`);

function usage(): never {
  console.log(`usage:
  npm run bank:teach -- --list [--chat <id>] [--limit 40]
  npm run bank:teach -- --id <row> --text "<corrected answer>" [--key <bank.key>] [--serve]
  npm run bank:teach -- --chat <id> --find "<text from the question/reply>" --text "<corrected answer>"
  npm run bank:teach -- --ask "<client question>" --key <bank.key> --text "<corrected answer>"

options: --db <path>  --key <key>  --serve  --list  --chat <id>  --limit <n>`);
  process.exit(1);
}

// Default DB: the chat TUI's own log (data/tui.db), because that is where the
// turns being corrected were served from. pickLiveDb's mtime rule is wrong
// here: any tool that merely opens data/lina.db refreshes its mtime and wins
// the race, and the correction would land in an empty database.
const dbArg = arg('db');
const tuiDb = path.resolve(process.cwd(), 'data/tui.db');
const dbPath = dbArg
  ? path.resolve(process.cwd(), dbArg)
  : process.env.DB_PATH
    ? path.resolve(process.cwd(), process.env.DB_PATH)
    : fs.existsSync(tuiDb)
      ? tuiDb
      : pickLiveDb(process.cwd());
const db = new Db(dbPath);
const bank = new BankStore(db);
const enrichment = new EnrichmentStore(db);

const chat = arg('chat');
const find = arg('find') ?? '';
const limit = Number(arg('limit') ?? 40) || 40;

const ask = arg('ask') ?? '';

if (flag('list') || (!arg('id') && !flag('list') && !arg('text') && !ask)) {
  const rows = (chat
    ? enrichment.listPending(undefined, 500).filter(r => r.chatId === chat)
    : enrichment.listPending(undefined, 500)).reverse().slice(0, limit);
  console.log(`[teach] ${dbPath} — ${rows.length} newest pending turn(s)`);
  // Full text, never truncated: the whole point of the listing is that the
  // operator can recognise the turn (question + answer + target key) without
  // having to remember which one it was.
  for (const r of rows) {
    console.log(`\n#${r.id}  chat=${r.chatId}  state=${r.state}  key=${r.bankKey ?? '—'}  (${r.replySource})`);
    console.log(`   КЛИЕНТ: ${r.userMsg.replace(/\s+/g, ' ').trim()}`);
    console.log(`   ОДГОВОР: ${r.replyText.replace(/\s+/g, ' ').trim()}`);
  }
  db.close();
  process.exit(0);
}

const text = arg('text') ?? '';
if (!text.trim()) usage();

let row = arg('id') ? enrichment.byId(Number(arg('id'))) : null;
if (arg('id') && !row) {
  console.error(`[teach] no enrichment row #${arg('id')} in ${dbPath}`);
  process.exit(1);
}

if (!row && ask) {
  // Direct teaching: the turn is not in the log (already purged, or it came
  // from conversation). The question itself is what the key must retrieve.
  if (!arg('key')) {
    console.error('[teach] --ask needs --key (which bank key should answer this question)');
    process.exit(1);
  }
  const r = applyOperatorCorrection(bank, enrichment, {
    triggerMsg: ask, rightReply: text, key: arg('key'),
  });
  if (!r.ok) {
    console.error(`[teach] NOT written — ${r.reason}`);
    db.close();
    process.exit(1);
  }
  console.log(`[teach] "${ask}" → ${r.key} (no queue row — taught directly)`);
  console.log(`  staged: ${r.staged ? 'yes — approve it in bank:tui (STAGED → A)' : 'already banked (same wording exists)'}`);
  console.log(`  audit:  bank_corrections #${r.correctionId}`);
  if (flag('serve')) promote(r.key, text);
  db.close();
  process.exit(0);
}

if (!row) {
  if (!chat) {
    console.error('[teach] pick the turn with --id or --chat (run --list to see them)');
    process.exit(1);
  }
  const rows = enrichment.listPending(undefined, 500).filter(r => r.chatId === chat).reverse();
  const needle = find.trim().toLowerCase();
  const matches = needle
    ? rows.filter(r => r.userMsg.toLowerCase().includes(needle) || r.replyText.toLowerCase().includes(needle))
    : rows.slice(0, 1);
  if (matches.length === 0) {
    console.error(`[teach] nothing in ${chat} matches "${find}"`);
    process.exit(1);
  }
  if (matches.length > 1) {
    console.error(`[teach] ${matches.length} turns match — narrow it or use --id:`);
    for (const r of matches.slice(0, 10)) {
      console.error(`  #${r.id}  ${r.userMsg.replace(/\s+/g, ' ').slice(0, 80)}`);
    }
    process.exit(2);
  }
  row = matches[0];
}

const applied = applyOperatorCorrection(bank, enrichment, {
  triggerMsg: row.userMsg,
  rightReply: text,
  wrongReply: row.replyText,
  rowId: row.id,
  key: arg('key') || null,
});

if (!applied.ok) {
  console.error(`[teach] NOT written — ${applied.reason}`);
  db.close();
  process.exit(1);
}

console.log(`[teach] #${row.id} → ${applied.key}`);
console.log(`  queue:   ${applied.queueUpdated ? 'reply rewritten to the corrected text' : 'no queue row changed'}`);
console.log(`  staged:  ${applied.staged ? 'yes — approve it in bank:tui (STAGED → A)' : 'already banked (same wording exists)'}`);
console.log(`  audit:   bank_corrections #${applied.correctionId}`);

if (flag('serve')) promote(applied.key, text);

db.close();

function promote(key: string, wanted: string): void {
  const staged = bank.stagedVariants(key).find(v => v.text.trim() === wanted.trim());
  if (!staged) {
    console.error('[teach] --serve: no staged row to promote (already active?)');
  } else if (!bank.promoteVariant(staged.id)) {
    console.error(`[teach] --serve: promote failed for staged #${staged.id}`);
  } else {
    console.log(`  serving: staged #${staged.id} promoted → ${key} serves it now`);
  }
}
