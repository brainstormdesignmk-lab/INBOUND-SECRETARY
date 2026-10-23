// OPERATOR CORRECTION INTAKE — the path that was missing.
//
// The 2026-10 F9 session: the operator typed the right wording, it landed in
// bank_corrections.reply, loop-a read only the trigger message, and the
// enrichment row kept the WRONG prose. The correction is now the thing that is
// stored: queue row rewritten, key bound, operator's exact text staged, both
// texts audited.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { EnrichmentStore } from '../src/store/enrichment';
import { applyOperatorCorrection } from '../src/bank/operatorCorrection';

const Q = 'kade e stanot so ev br 26 ?';
const WRONG = 'За жал, не можам да го најдам 26 во нашата евиденција.';
const RIGHT = 'Станот е во Центар и уште е достапен, па можам да ја закажам посетата денес.';
const OTHER = 'Ќе го проверам тоа кај сопственикот и ќе Ви одговорам веднаш.';

function setup(opts: { key?: string | null } = {}) {
  const db = new Db(':memory:');
  const bank = new BankStore(db);
  const en = new EnrichmentStore(db);
  en.insert({
    chatId: 'c1', state: 'presentation', eventType: 'DETERMINISTIC_FAST',
    userMsg: Q, replyText: WRONG, replySource: 'deterministic',
    bankKey: opts.key === undefined ? 'feature.after.show' : opts.key ?? undefined,
  });
  const row = en.listPending()[0];
  return { db, bank, en, row };
}

test('the queue row shows the corrected text, not the raw wrong one', () => {
  const { en, bank, row } = setup();
  const r = applyOperatorCorrection(bank, en, {
    triggerMsg: Q, rightReply: RIGHT, wrongReply: WRONG, rowId: row.id,
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.queueUpdated, true);
  const after = en.byId(row.id)!;
  assert.equal(after.replyText, RIGHT, 'ENRICHMENT must show what the operator wrote');
  assert.notEqual(after.replyText, WRONG);
});

test('the operator\'s exact wording is staged under the resolved key', () => {
  const { bank, en, row } = setup();
  const r = applyOperatorCorrection(bank, en, {
    triggerMsg: Q, rightReply: RIGHT, wrongReply: WRONG, rowId: row.id,
  });
  assert.equal(r.key, 'feature.after.show');
  assert.equal(r.staged, true);

  const staged = bank.stagedVariants('feature.after.show');
  assert.equal(staged.length, 1);
  assert.equal(staged[0].text, RIGHT, 'verbatim — never regenerated');
  assert.equal(staged[0].source, 'operator');
  assert.match(staged[0].note ?? '', /ENRICHMENT #\d+/);
  // Staged is in the bank but NOT serving.
  assert.equal(bank.variants('feature.after.show').length, 0);
  // The client message becomes a retrieval example.
  const ex = en.byId(row.id)!.userMsg;
  assert.equal(ex, Q);
});

test('the audit keeps both texts: what served and what the human wanted', () => {
  const { bank, en, row, db } = setup();
  const r = applyOperatorCorrection(bank, en, {
    triggerMsg: Q, rightReply: RIGHT, wrongReply: WRONG, rowId: row.id,
  });
  const c = db.db.prepare('SELECT key, msg, reply, corrected, reason FROM bank_corrections WHERE id = ?')
    .get(r.correctionId) as { key: string; msg: string; reply: string; corrected: string; reason: string };
  assert.equal(c.key, 'feature.after.show');
  assert.equal(c.msg, Q);
  assert.equal(c.reply, WRONG, 'reply holds the mistake');
  assert.equal(c.corrected, RIGHT, 'corrected holds the replacement');
  assert.match(c.reason, /staged feature\.after\.show/);
});

test('a key-less turn is bound to a learn.* key derived from the question', () => {
  const { bank, en, row } = setup({ key: null });
  const r = applyOperatorCorrection(bank, en, { triggerMsg: Q, rightReply: RIGHT, rowId: row.id });
  assert.equal(r.ok, true, r.reason);
  assert.match(r.key, /^learn\./);
  assert.equal(en.byId(row.id)!.bankKey, r.key, 'the queue row is bound for the next digest');
  assert.equal(bank.stagedVariants(r.key)[0].text, RIGHT);
});

test('a dynamic group key becomes a learn key (a dynamic group is not a bank key)', () => {
  const { bank, en, row } = setup({ key: 'dynamic:presentation:ev-26' });
  const r = applyOperatorCorrection(bank, en, { triggerMsg: Q, rightReply: RIGHT, rowId: row.id });
  assert.equal(r.ok, true, r.reason);
  assert.doesNotMatch(r.key, /^dynamic:/);
});

test('dirty or fact-carrying prose is refused and nothing is written', () => {
  const { bank, en, row } = setup();
  for (const bad of [
    'Станот чини 120.000 евра и е одличен избор.',
    'Јас сум дигитален асистент, па немам години.',
    'Со цел да Ви помогнам, еве ги следните достапни опции од базата.',
  ]) {
    const r = applyOperatorCorrection(bank, en, { triggerMsg: Q, rightReply: bad, rowId: row.id });
    assert.equal(r.ok, false, `should refuse: ${bad}`);
  }
  assert.equal(en.byId(row.id)!.replyText, WRONG, 'queue untouched on refusal');
  assert.equal(bank.stagedVariants().length, 0);
});

test('data-driven keys are never turned into prose', () => {
  const { bank, en, row } = setup({ key: 'price.ask' });
  const r = applyOperatorCorrection(bank, en, { triggerMsg: Q, rightReply: RIGHT, rowId: row.id });
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /data-driven/i);
});

test('a frozen key may still be corrected (a human unlocked it), without examples', () => {
  const { bank, en, row, db } = setup({ key: 'fee.rule.hold' });
  const rule = 'Надоместот за посета е дел од ценовникот на Агенцијата и важи исто за секој клиент. Дали се согласувате со овој услов?';
  const r = applyOperatorCorrection(bank, en, { triggerMsg: Q, rightReply: rule, rowId: row.id });
  assert.equal(r.ok, true, r.reason);
  assert.equal(bank.stagedVariants('fee.rule.hold')[0].text, rule);
  const ex = db.db.prepare('SELECT COUNT(*) AS c FROM bank_examples WHERE key = ?').get('fee.rule.hold') as { c: number };
  assert.equal(ex.c, 0, 'frozen keys never take retrieval examples');
});

test('the same wording twice is accepted once (no duplicate staging)', () => {
  const { bank, en, row } = setup();
  const first = applyOperatorCorrection(bank, en, { triggerMsg: Q, rightReply: RIGHT, rowId: row.id });
  const again = applyOperatorCorrection(bank, en, { triggerMsg: Q, rightReply: RIGHT, rowId: row.id });
  assert.equal(first.staged, true);
  assert.equal(again.ok, true);
  assert.equal(again.staged, false, 'already banked');
  assert.equal(bank.stagedVariants('feature.after.show').length, 1);
});

test('a dictated persona line is accepted (pivot guard needs a clause start)', () => {
  // "…за да Ви помогнам околу недвижностите" is ordinary prose; the listing-
  // pivot signature only fires when it OPENS a sentence. This line was being
  // refused as a pivot, so the operator's own wording could not be banked.
  const { bank, en } = setup({ key: null });
  const age = 'Доволно години за да Ви помогнам околу недвижностите. Дали моментално барате стан за купување или за изнајмување?';
  const r = applyOperatorCorrection(bank, en, {
    triggerMsg: 'kolku godini imas lina ?', rightReply: age, key: 'personal.age',
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(bank.stagedVariants('personal.age')[0].text, age);
});

// P5.1 — the route correction writes a NEGATIVE RULE: the old family can no
// longer claim the same utterance.
test('a cross-family correction writes a negative rule for the old family', () => {
  const { bank, en, row } = setup({ key: 'fee.persuade.1.buy' });
  const r = applyOperatorCorrection(bank, en, {
    triggerMsg: Q, rightReply: RIGHT, wrongReply: WRONG, rowId: row.id,
    key: 'learn.where-26', // the operator re-homes the question (TUI K/E/A)
  });
  assert.equal(r.ok, true, r.reason);
  const rules = bank.negativeRules();
  assert.equal(rules.length, 1, 'exactly one rule for one correction');
  assert.equal(rules[0].forbid_family, 'fee.');
  assert.equal(rules[0].phrase, Q.toLowerCase());
  assert.match(rules[0].note ?? '', /route correction #\d+/);
  // The serve-time veto then refuses the exact phrase for that family.
  assert.equal(bank.neverServes(Q, 'fee.'), true);
  assert.equal(bank.neverServes(Q.toUpperCase(), 'fee.persuade.1.buy'), true, 'market noise is covered');
  // …but NOT for an unrelated family, and not for another phrase.
  assert.equal(bank.neverServes(Q, 'provision.'), false);
  assert.equal(bank.neverServes('kade e stanot so ev br 27 ?', 'fee.'), false);
});

test('a same-family correction writes NO rule (the wording stayed, only the text changed)', () => {
  const { bank, en, row } = setup({ key: 'learn.where-26' });
  const r = applyOperatorCorrection(bank, en, { triggerMsg: Q, rightReply: RIGHT, wrongReply: WRONG, rowId: row.id });
  assert.equal(r.ok, true, r.reason);
  assert.equal(bank.negativeRules().length, 0);
});

test('the rule is idempotent: correcting twice keeps one row', () => {
  const { bank, en, row } = setup({ key: 'fee.persuade.1.buy' });
  for (let i = 0; i < 2; i++) {
    applyOperatorCorrection(bank, en, {
      triggerMsg: Q, rightReply: RIGHT, wrongReply: WRONG, rowId: row.id, key: 'learn.where-26',
    });
  }
  assert.equal(bank.negativeRules().length, 1);
});

test('the row is found by the exact reply the operator is looking at', () => {
  const { bank, en } = setup();
  const r = applyOperatorCorrection(bank, en, {
    triggerMsg: Q, rightReply: OTHER, wrongReply: WRONG, chatId: 'c1',
  });
  assert.equal(r.ok, true, r.reason);
  assert.equal(r.rowId, 1);
  assert.equal(en.listRecent(1)[0].replyText, OTHER);
});
