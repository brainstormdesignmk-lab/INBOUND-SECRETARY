// THE ASSENT FAMILY (src/llm/assent.ts) — one table, every lane.
//
// The [18:35] capture: the owner answered the Turn-0 address question
// («Дали адресата е точна?») with «tocno» and was asked AGAIN. The address
// lane's regex knew «точна» and the h-digraph «tochno», but an owner typing on
// a phone drops the h — and `normalizeMc('tocno')` is «тоцно» (c → ц), which
// matches neither the Cyrillic form nor the Latin original. So the word has to
// exist in BOTH spellings, and in ONE table, or the next lane will miss it.
//
// The contracts pinned here:
//   1. «tocno» / «точно» / «tochno» / «тоцно» confirm the address;
//   2. a NEGATED yes («ne e tocno») never confirms — it asks for the address;
//   3. a correction that names no address («adresata e druga») asks again
//      instead of filing the marker word as a street;
//   4. a QUESTION is not an answer («дали е точна?» asks back);
//   5. the generic lane's bare yes reads the same table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectOwnerAddressReply, detectAgreement } from '../src/llm/deterministic';
import { detectPolarity, isBareYes } from '../src/llm/assent';

// ── 1. the address turn ────────────────────────────────────────────────────
test('[18:35] every spelling of "correct" confirms the address', () => {
  const yes = [
    'tocno', 'TOCNO', 'tochno', 'tocna', 'tochna',
    'точно', 'точна', 'ТОЧНО',
    'tocno e', 'точно е',
    'da', 'да', 'da, tocno', 'да, точно',
    'ok', 'ок', 'во ред', 'vo red',
    'taka e', 'така е', 'pravilno', 'правилно',
    'potvrduvam', 'потврдувам', 'potvrdi', 'потврди',
  ];
  for (const word of yes) {
    assert.deepEqual(detectOwnerAddressReply(word), { status: 'confirm' },
      `«${word}» must confirm the address, not re-ask the question`);
  }
});

test('[18:35] a negated yes asks for the address instead of confirming it', () => {
  for (const word of ['ne e tocno', 'ne e tochno', 'не е точно', 'NE E TOCNO', 'ne tocno']) {
    assert.equal(detectOwnerAddressReply(word), undefined,
      `«${word}» is a NO — the question repeats, nothing is confirmed`);
  }
});

test('[18:35] a correction with no address in it asks again, it does not file a marker', () => {
  // The old arm applied the negation/announcement word itself as the street.
  for (const word of ['ne', 'adresata e druga', 'adresata e nova', 'ne e tocno']) {
    assert.equal(detectOwnerAddressReply(word), undefined, `«${word}» carries no address`);
  }
  // …while a real correction still lands, with its street.
  const fixed = detectOwnerAddressReply('ne, ulicata e Vasil Stefanovski 16');
  assert.equal(fixed?.status, 'correct');
  assert.match(fixed?.address ?? '', /Vasil Stefanovski 16/u);
  const lat = detectOwnerAddressReply('ne e tocno, ulica Makedonija 5');
  assert.equal(lat?.status, 'correct');
  assert.match(lat?.address ?? '', /Makedonija 5/u);
});

test('[18:35] a question back is not an answer', () => {
  for (const q of ['dali e tocna?', 'дали е точна?', 'tocna?']) {
    assert.equal(detectOwnerAddressReply(q), undefined, `«${q}» asks, it does not confirm`);
  }
});

// ── 2. the family itself ───────────────────────────────────────────────────
test('[assent] polarity reads both scripts and both spellings', () => {
  for (const word of ['tocno', 'tochno', 'точно', 'тоцно', 'da', 'ok', 'vo red', 'se soglasuvam', 'се согласувам']) {
    assert.equal(detectPolarity(word, { lane: 'address' }), 'yes', word);
  }
  for (const word of ['ne', 'no', 'ne e tocno', 'не е точно', 'gresno', 'грешно']) {
    assert.equal(detectPolarity(word, { lane: 'address' }), 'no', word);
  }
  // A negated yes is a no in ANY lane, whatever else the sentence carries.
  assert.equal(detectPolarity('tocno, ama ne e tocno', { lane: 'address' }), 'no');
  // No answer token at all.
  assert.equal(detectPolarity('koga moze da se vidi?', { lane: 'address' }), undefined);
});

test('[assent] «може» answers a TERM, never an address', () => {
  // It confirms a time question; it says nothing about a street, so the address
  // turn must not read it as a confirmation.
  assert.equal(detectPolarity('moze', { lane: 'generic' }), 'yes');
  assert.equal(detectPolarity('moze', { lane: 'address' }), undefined);
});

test('[assent] the bare yes is the same table', () => {
  for (const word of ['tocno', 'точно', 'tochno', 'тоцно', 'taka e', 'така е', 'vazi', 'важи', 'normalno']) {
    assert.equal(isBareYes(word), true, word);
    assert.equal(isBareYes(`${word}.`), true, `${word} + punctuation`);
  }
  // Inside a sentence it is not a bare yes, and a negated form never is.
  assert.equal(isBareYes('ova ne e normalno'), false);
  assert.equal(isBareYes('ne e tocno'), false);
  // …and the generic agreement lane reads it.
  assert.equal(detectAgreement('tocno'), true);
  assert.equal(detectAgreement('ne e tocno'), false);
});
