// F9 WRITE-BACK — correct the reply and make the correction durable NOW.
//
// The contract:
//   • the row is found by EXACT (state, normalised msg) — never fuzzy recall,
//     which could overwrite a different question's answer;
//   • rewriting replaces `bank_dynamic.answer` in place, so the next identical
//     ask recalls the corrected prose (no model call);
//   • the serve-log row is updated too, so the nightly digest cannot fold the
//     old prose into bank_variants;
//   • the operator's text passes the same persona/no-facts/hygiene gate as a
//     generated answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { EnrichmentStore } from '../src/store/enrichment';
import { validateDynamicAnswer } from '../src/llm/dynamicFallback';

const Q = 'kade ima reptil tamu ?';
const OLD = 'Ова не е во моите записи. Ќе проверам кај сопственикот и ќе Ви кажам.';
const NEW = 'Тоа е во близина на Центар. Ќе го проверам кај сопственикот и ќе Ви кажам.';

function seed(db: Db): BankStore {
  const bank = new BankStore(db);
  assert.equal(bank.addDynamic('dynamic:idle:reptil', 'idle', Q, OLD), true);
  return bank;
}

test('findDynamicRow: exact state + normalised message, never a different state', () => {
  const db = new Db(':memory:');
  const bank = seed(db);
  assert.equal(bank.findDynamicRow('idle', '  KADE IMA   REPTIL TAMU ? ')?.key, 'dynamic:idle:reptil');
  assert.equal(bank.findDynamicRow('presentation', Q), undefined, 'state is part of the identity');
  assert.equal(bank.findDynamicRow('idle', 'kade ima reptil?'), undefined, 'a reworded question is another row');
});

test('rewriteDynamic: replaces the answer in place and the recall serves it', () => {
  const db = new Db(':memory:');
  const bank = seed(db);
  const r = bank.rewriteDynamic('idle', Q, NEW);
  assert.equal(r.ok, true);
  assert.equal(r.key, 'dynamic:idle:reptil');
  assert.ok(r.id && r.id > 0);
  const recalled = bank.retrieveDynamicExact(Q, 'idle');
  assert.equal(recalled?.answer, NEW, 'the corrected prose must be what recall returns');
  assert.equal(validateDynamicAnswer(NEW, Q).length, 0, 'a written answer must satisfy the runtime gate');
});

test('rewriteDynamic refuses empty text and a missing row', () => {
  const db = new Db(':memory:');
  const bank = seed(db);
  assert.equal(bank.rewriteDynamic('idle', Q, '   ').ok, false);
  assert.equal(bank.rewriteDynamic('idle', 'nesto drugo?', NEW).ok, false);
});

test('the F9 gate rejects a correction that reveals a machine identity', () => {
  const bad = 'Јас сум дигитален асистент, па немам години, но ќе Ви помогнам.';
  assert.ok(validateDynamicAnswer(bad, 'KOLKU GODINI IMAS LINA ?').length > 0);
});

test('enrichment rewriteReply updates the newest matching serve-log row', () => {
  const db = new Db(':memory:');
  const en = new EnrichmentStore(db);
  en.insert({ chatId: 'c1', state: 'idle', eventType: 'LEARNED_RECALL', userMsg: Q, replyText: OLD, replySource: 'dynamic' });
  en.insert({ chatId: 'c1', state: 'idle', eventType: 'LEARNED_RECALL', userMsg: 'drugo?', replyText: 'друг одговор', replySource: 'dynamic' });
  assert.equal(en.rewriteReply('c1', OLD, NEW), 1);
  const rows = en.listRecent(2);
  assert.equal(rows[0].replyText, 'друг одговор', 'the newer unrelated row is untouched');
  assert.equal(rows[1].replyText, NEW, 'the row carrying the corrected reply is updated');
  assert.equal(en.rewriteReply('c1', OLD, NEW), 0, 'idempotent — the old text is gone');
});
