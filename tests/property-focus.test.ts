// PHASE 3 — PROPERTY FOCUS: subject × predicate × certainty.
//
// Why this file exists: the identity defects (44/54/63) were all one bug — a
// lane answered a PREDICATE about the wrong SUBJECT, or the right subject with
// the wrong predicate, because each lane re-derived "which flat?" from whichever
// slot was nearest. `src/handlers/focus.ts` is now the one resolution, and these
// are its contracts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePropertyFocus, detectFocusPredicate, focusClarifyAsk } from '../src/handlers/focus';

const slots = (o: Partial<{ propertyId: number; interestedPropertyId: number; presentedIds: number[]; currentBatch: number[] }>) => o;

test('the predicate is read before the subject, and the rate beats the plain price', () => {
  assert.equal(detectFocusPredicate('колку му доаѓа цената по квадрат?'), 'perM2');
  assert.equal(detectFocusPredicate('kolku e cenata po m2?'), 'perM2');
  assert.equal(detectFocusPredicate('дали се продааа уште ?'), 'availability');
  assert.equal(detectFocusPredicate('DALI E SEUSTE DOSTAPEN ?'), 'availability');
  // A location word inside a fee/price sentence must not steal the predicate:
  // availability is tested before location for exactly this reason.
  assert.equal(detectFocusPredicate('дали е достапна во Центар?'), 'availability');
  assert.equal(detectFocusPredicate('каде се наоѓа станот?'), 'location');
  assert.equal(detectFocusPredicate('на кој спрат е?'), 'floor');
  assert.equal(detectFocusPredicate('колку е цената?'), 'price');
});

test('precedence: a named EB wins, then the card just served, then the slot, then the batch', () => {
  const named = resolvePropertyFocus('каде е ЕБ 66 ?', slots({
    propertyId: 44, presentedIds: [44, 55], currentBatch: [44, 55],
  }));
  assert.equal(named.certainty, 'bound');
  assert.equal(named.eb, 66, 'the flat he named, not the one on the table');
  assert.equal(named.source, 'named');

  // THE LAST SERVE OUTRANKS A STALE SLOT ([04:15] capture): the pointer still
  // holds 44 while 55 is the card on screen.
  const served = resolvePropertyFocus('дали е достапна?', slots({
    propertyId: 44, presentedIds: [44, 55], currentBatch: [44, 55],
  }));
  assert.equal(served.eb, 55, 'the last presented card');
  assert.equal(served.source, 'last-presented');

  const slotOnly = resolvePropertyFocus('дали е достапна?', slots({ propertyId: 44, interestedPropertyId: 44 }));
  assert.equal(slotOnly.eb, 44);
  assert.equal(slotOnly.source, 'slot');

  const batchOnly = resolvePropertyFocus('дали е достапна?', slots({ currentBatch: [70, 76] }));
  assert.equal(batchOnly.eb, 76, 'the batch tail is the last resort');
  assert.equal(batchOnly.source, 'batch');
});

test('certainty: nothing on the table is «none», a described flat among several is «ambiguous»', () => {
  const none = resolvePropertyFocus('колку му доаѓа цената по квадрат?', slots({}));
  assert.equal(none.certainty, 'none');
  assert.equal(none.eb, undefined, 'no subject is invented');
  assert.equal(none.predicate, 'perM2');

  // «гарсоњерата» names ONE of two cards by its type — the binder scores it,
  // so the focus must not silently take the tail (the [23:09] EB 70/76 defect).
  const ambiguous = resolvePropertyFocus('дали гарсоњерата е слободна?', slots({
    presentedIds: [70, 76], currentBatch: [70, 76],
  }));
  assert.equal(ambiguous.certainty, 'ambiguous');
  assert.deepEqual(ambiguous.candidates, [70, 76]);

  // …but a described flat with only ONE card on the table is still bound: there
  // is nothing to be ambiguous about.
  const single = resolvePropertyFocus('дали гарсоњерата е слободна?', slots({ presentedIds: [76] }));
  assert.equal(single.certainty, 'bound');
  assert.equal(single.eb, 76);
});

test('the clarify ask names the candidates, and never invents one', () => {
  const two = focusClarifyAsk(resolvePropertyFocus('дали е слободна?', slots({ presentedIds: [70, 76] })));
  assert.match(two, /70/u);
  assert.match(two, /76/u);
  assert.ok(two.trim().endsWith('?'), `a question, not a statement: ${two}`);

  const empty = focusClarifyAsk(resolvePropertyFocus('дали е слободна?', slots({})));
  assert.doesNotMatch(empty, /\d/u, `no evident number may be fabricated: ${empty}`);
  assert.ok(empty.trim().endsWith('?'), `a question: ${empty}`);
});
