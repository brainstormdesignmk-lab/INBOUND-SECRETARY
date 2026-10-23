// EVIDENCE CHIPS (P5.2) — the review UI's detail pane shows the negative rules
// and the route tuple where the operator decides. Pinned: rule matching is
// whole-phrase and case/whitespace-normalized (the same normalization the
// serve-time neverServes veto uses), chips are replayable evidence only, and
// a row with no rules carries only its own tuple.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { EnrichmentStore } from '../src/store/enrichment';
import { BankReview } from '../src/bank/review';

const Q = 'MNOGU EFTINA CENA E TOA';
const OTHER = 'kade ima reptil tamu ?';

function setup() {
  const db = new Db(':memory:');
  const bank = new BankStore(db);
  const en = new EnrichmentStore(db);
  const review = new BankReview(db, bank, en);
  return { db, bank, en, review };
}

test('a negative rule against the row\'s question shows as a veto chip', () => {
  const { bank, en, review } = setup();
  bank.addNegativeRule(Q, 'fee.', 'trigger row #235');
  en.insert({
    chatId: 'c1', state: 'closing', eventType: 'FEE_PUSH_FAST',
    userMsg: Q, replyText: 'x', replySource: 'deterministic',
  });
  const chips = review.evidenceChips(review.list('enrichment')[0]);
  const veto = chips.find(c => c.startsWith('не служи:'));
  assert.ok(veto, `veto chip missing: ${chips.join(' | ')}`);
  assert.equal(veto, 'не служи: fee.*');
});

test('rule matching is case/whitespace-normalized, never substring', () => {
  const { bank, en, review } = setup();
  bank.addNegativeRule('mnogu eftina cena e toa', 'fee.');
  en.insert({
    chatId: 'c2', state: 'closing', eventType: 'FEE_PUSH_FAST',
    userMsg: 'Mnogu   EFTINA cena e toa', replyText: 'x', replySource: 'deterministic',
  });
  assert.ok(
    review.evidenceChips(review.list('enrichment')[0]).some(c => c === 'не служи: fee.*'),
    'case/spacing drift must not hide the veto chip',
  );
});

test('an unrelated rule does not chip the row', () => {
  const { bank, en, review } = setup();
  bank.addNegativeRule(OTHER, 'fee.');
  en.insert({
    chatId: 'c3', state: 'closing', eventType: 'FEE_PUSH_FAST',
    userMsg: Q, replyText: 'x', replySource: 'deterministic',
  });
  const chips = review.evidenceChips(review.list('enrichment')[0]);
  assert.equal(chips.some(c => c.startsWith('не служи:')), false);
  assert.ok(chips.some(c => c.startsWith('tuple: ')), 'the tuple chip is always there');
});

test('the tuple chip addresses money residue explicitly and stays silent on mixed scripts drift', () => {
  const { en, review } = setup();
  en.insert({
    chatId: 'c4', state: 'idle', eventType: 'STAY',
    userMsg: 'пари?', replyText: 'x', replySource: 'dynamic',
  });
  en.insert({
    chatId: 'c5', state: 'idle', eventType: 'STAY',
    userMsg: 'kako si', replyText: 'x', replySource: 'dynamic',
  });
  const moneyRow = review.list('enrichment').find(i => i.userMsg === 'пари?')!;
  const moneyChips = review.evidenceChips(moneyRow);
  assert.ok(moneyChips.includes('адреса: unknown.unknown.ask'), `residue chip: ${moneyChips.join(' | ')}`);
  const plainRow = review.list('enrichment').find(i => i.userMsg === 'kako si')!;
  assert.equal(
    review.evidenceChips(plainRow).some(c => c.startsWith('адреса:')),
    false,
    'a non-money turn has no residue address',
  );
});
