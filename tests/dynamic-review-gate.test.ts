// PHASE 6 — THE REVIEW GATE (proposal: "learning loop on safe units").
//
// The loop used to store AND serve immediately: recall → miss → generate →
// validate → serve + store. Validation is hygiene (no invented EB, no borrowed
// place, no promise), not truth — and a stored row is served to a client who
// never saw the question it was written for. `data/tui.db` held 24 such rows,
// reusable before any human had read them.
//
// Pinned here:
//   1. a MODEL-WRITTEN row is quarantined → it is NOT recalled for the next
//      client, even for the same words;
//   2. it IS served to the client whose turn generated it (that is the live
//      answer, not the bank);
//   3. approval makes it recallable; rejection retires it for good;
//   4. an operator/tool-seeded row is trusted (the human already vouched for the
//      prose) — the flag records WHOSE words they are, which is the whole rule.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { generateDynamic, recallDynamic, dynamicAnswer } from '../src/llm/dynamicFallback';
import { freshSession } from '../src/fsm/session';

const ASK = 'DALI RABOTITE VO SABOTA?';
// No weekday/hour the client did not name — `validateDynamicAnswer` refuses an
// answer that pins one (a stored sentence must be true for ANY client).
const ANSWER = 'Во сабота агенцијата е отворена — дали сакате да закажеме посета?';

/** A stand-in brain: one clean, on-topic answer. */
const llm = { complete: async () => ANSWER } as never;

const store = (): { db: Db; bank: BankStore } => {
  const db = new Db(':memory:');
  return { db, bank: new BankStore(db) };
};

test('a model-written answer is served this turn but quarantined for everyone else', async () => {
  const { db, bank } = store();
  const session = freshSession('rev-gate', 'test');
  const generated = await generateDynamic(llm, session, ASK, bank);
  assert.ok(generated, 'the generating turn gets its answer');
  assert.equal(generated!.text, ANSWER);

  // The row exists — and it is unreviewed.
  const rows = bank.dynamicRows();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.reviewed, 0, 'a model-written row must be quarantined');
  assert.equal(bank.dynamicAwaitingReview().length, 1);

  // A DIFFERENT client asking the same thing gets no recall.
  assert.equal(recallDynamic(bank, ASK), undefined,
    'an unreviewed answer must never be recalled for another client');
  db.db.close();
});

test('approval makes the row recallable; rejection retires it', async () => {
  const { db, bank } = store();
  const session = freshSession('rev-approve', 'test');
  await generateDynamic(llm, session, ASK, bank);
  const id = bank.dynamicRows()[0]!.id;

  assert.equal(bank.approveDynamic(id), true);
  assert.equal(bank.dynamicAwaitingReview().length, 0);
  const recalled = recallDynamic(bank, ASK);
  assert.ok(recalled, 'an approved row is the free answer we wanted');
  assert.equal(recalled!.text, ANSWER);

  // A second client's row, rejected: never served, and out of the queue.
  // Seeded directly as a QUARANTINED row so the test is about approve/reject
  // semantics, not about what the mock brain happens to answer (a generated row
  // is refused by validation when the answer does not fit THAT question).
  const ASK2 = 'DALI IMATE PARKING VO CENTAR?';
  bank.addDynamic('dynamic:idle:parking', 'idle', ASK2,
    'Паркингот зависи од конкретната недвижност — дали сакате да Ви ги покажам опциите?',
    { unreviewed: true });
  const id2 = bank.dynamicAwaitingReview().find(r => r.msg.includes('PARKING'))?.id;
  assert.ok(id2, 'the second row is awaiting review');
  assert.equal(bank.rejectDynamic(id2!), true);
  assert.equal(recallDynamic(bank, ASK2), undefined, 'a rejected answer is never served');
  assert.equal(bank.approveDynamic(id2!), false, 'a retired row cannot be approved back to life');
  db.db.close();
});

test('an operator-seeded row is trusted — the flag records whose words they are', () => {
  const { db, bank } = store();
  bank.addDynamic('dynamic:idle:seeded', 'idle', 'KAKO DA ZAKAZAM POSETA?', 'Ќе Ви помогнам веднаш.');
  const rows = bank.dynamicRows();
  assert.equal(rows[0]!.reviewed, 1, 'prose a human wrote is not quarantined');
  assert.ok(recallDynamic(bank, 'KAKO DA ZAKAZAM POSETA?'));
  db.db.close();
});

test('dynamicAnswer: the first client pays the LLM call, the second gets the approved row free', async () => {
  const { db, bank } = store();
  const first = await dynamicAnswer(llm, freshSession('rev-a', 'test'), ASK, bank);
  assert.ok(first);
  const id = bank.dynamicAwaitingReview()[0]!.id;
  bank.approveDynamic(id);
  const second = await dynamicAnswer({ complete: async () => { throw new Error('must not be called'); } } as never,
    freshSession('rev-b', 'test'), ASK, bank);
  assert.equal(second?.source, 'dynamic-recall', 'the approved row answers with no LLM call');
  db.db.close();
});
