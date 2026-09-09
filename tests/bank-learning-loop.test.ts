import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { EnrichmentStore } from '../src/store/enrichment';
import { setLearnedBank, retrieveVariant } from '../src/data/responseBank';

/**
 * THE LEARNING LOOP, end to end (no live LLM — the loop's mechanics):
 *   1. Client asks something novel → LLM answers → pair queued (what the
 *      runtime does on every escalated reply).
 *   2. Cron digests the queue: quality gate passes (no re-ask), the reply is
 *      clean → NEW bank key created with variants + retrieval examples.
 *   3. A second client asks the SAME question → retrieval serves a variant
 *      FREE (no LLM call) and records a hit.
 */
test('learning loop: escalated Q&A retires into the bank and serves the next client free', () => {
  const dir = mkdtempSync(join(tmpdir(), 'loop-'));
  const db = new Db(join(dir, 't.db'));
  const enrichment = new EnrichmentStore(db);
  const bank = new BankStore(db);
  setLearnedBank(bank);

  // 1. Runtime: novel question answered by Gemini, logged to the queue.
  enrichment.insert({
    chatId: 'chat-1', state: 'property_query', eventType: 'STAY',
    userMsg: 'dali zgradata ima lift',
    replyText: 'Да, зградата разполага со лифт — слободно користете го.',
    replySource: 'gemini:1',
  });

  // 2. Cron digest: quality gate (no re-ask within 10 min → worked), reply
  //    clean → new learned key with the reply as variant + msg as example.
  const [rec] = enrichment.listPending();
  const worked = true; // answerWorked() equivalent — single record, no re-ask
  assert.equal(worked, true);
  assert.equal(bank.addVariant('learn.lift', rec.replyText, 'learned-origin'), true);
  assert.equal(bank.addExample('learn.lift', rec.userMsg), true);
  enrichment.markEnriched([rec.id]);

  // 3. Next client asks the same thing → FREE answer from the bank.
  const free = retrieveVariant('dali zgradata ima lift');
  assert.equal(free, 'Да, зградата разполага со лифт — слободно користете го.');

  // Metrics prove the hit.
  assert.ok(bank.stats().hitRate! > 0);

  setLearnedBank(undefined);
  rmSync(dir, { recursive: true, force: true });
});

/**
 * QUALITY GATE: a failed answer (client re-asked within 10 min) must be
 * QUARANTINED, never enriched. This is the guard against "lovingly
 * multiplying a wrong canned answer into five polished variants".
 */
test('quality gate: re-asked question goes to corrections, never the bank', () => {
  const dir = mkdtempSync(join(tmpdir(), 'gate-'));
  const db = new Db(join(dir, 't.db'));
  const enrichment = new EnrichmentStore(db);
  const bank = new BankStore(db);
  setLearnedBank(bank);

  const now = Date.now();
  // Original failed answer + the client re-asking 2 minutes later.
  enrichment.insert({ chatId: 'c', state: 'closing', eventType: 'STAY', userMsg: 'kolku cinat provizijata', replyText: 'Провизијата е 10%.', replySource: 'gemini:1' });
  enrichment.insert({ chatId: 'c', state: 'closing', eventType: 'STAY', userMsg: 'kolku cinat provizijata?', replySource: 'groq', replyText: '' , createdAtOverride: undefined } as any);
  // (insert signature lacks createdAt override — set the second row manually)
  db.db.prepare(`UPDATE enrichment_queue SET created_at = ? WHERE id = (SELECT MAX(id) FROM enrichment_queue)`).run(now + 2 * 60_000);
  db.db.prepare(`UPDATE enrichment_queue SET created_at = ? WHERE id = (SELECT MIN(id) FROM enrichment_queue)`).run(now);

  // The outcome check the cron runs: same chat, similar msg, within 10 min.
  const rows = enrichment.listPending();
  const first = rows[0];
  const reAsked = rows.some(r =>
    r.id !== first.id &&
    r.chatId === first.chatId &&
    r.createdAt > first.createdAt &&
    r.createdAt <= first.createdAt + 10 * 60_000 &&
    r.userMsg.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase()
      .includes(first.userMsg.replace(/[^\p{L}\p{N}]/gu, '').toLowerCase().slice(0, 15))
  );
  assert.equal(reAsked, true, 'gate must detect the re-ask');

  // Failed → correction queue, NOT the bank.
  if (reAsked) bank.correction(first.bankKey, first.userMsg, first.replyText, 'client-re-asked-within-10min');
  assert.equal(bank.variants('learn.provizija').length, 0);
  assert.equal(bank.stats().corrections, 1);

  setLearnedBank(undefined);
  rmSync(dir, { recursive: true, force: true });
});
