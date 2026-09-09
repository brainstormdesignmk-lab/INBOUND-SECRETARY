import { test } from 'node:test';
import assert from 'node:assert';
import { detectNearbyAsk } from '../src/llm/deterministic';

// Grammar spec for detectNearbyAsk — order-free, Cyrillic-canonical
// (normalizeMc), guarded. Case matrix mirrors tmp/nb-probe.ts.

test('nearby ask: POSITIVE — the production miss (DOBRO + sto ima drugo vo blizina na zgradata)', () => {
  // The exact line the fee-confirmation FSM state swallowed as fee agreement.
  assert.equal(detectNearbyAsk('DOBRO , A STO IMA DRUGO VO BLIZINA NA ZGRADATA?'), true);
  assert.equal(detectNearbyAsk('sto ima drugo vo blizina na zgradata'), true);
});

test('nearby ask: POSITIVE — every word order of the grammar', () => {
  // subject + MOD + HAVE
  assert.equal(detectNearbyAsk('sto uste ima vo blizina?'), true);
  assert.equal(detectNearbyAsk('sto drugo ima okolu?'), true);
  // subject + HAVE + MOD (the order the enumerated list never covered)
  assert.equal(detectNearbyAsk('sto ima drugo vo blizina'), true);
  assert.equal(detectNearbyAsk('shto ima uste okolu zgradata'), true);
  assert.equal(detectNearbyAsk('sto ima dopolnitelno vo blizina'), true);
  // bare subject + anchor
  assert.equal(detectNearbyAsk('nesto drugo vo blizina?'), true);
  assert.equal(detectNearbyAsk('shto drugo vo blizina na zgradata'), true);
  // copula filler
  assert.equal(detectNearbyAsk('shto uste e vo blizina?'), true);
  // noun-head filler
  assert.equal(detectNearbyAsk('koi drugi objekti okolu'), true);
  // have-initial (inverted question)
  assert.equal(detectNearbyAsk('ima li nesto drugo vo blizina'), true);
  assert.equal(detectNearbyAsk('ima li nesto okolu'), true);
  // anchor-initial
  assert.equal(detectNearbyAsk('sproti drugo vo blizina'), true);
});

test('nearby ask: POSITIVE — Cyrillic and mixed-script homoglyph typos', () => {
  assert.equal(detectNearbyAsk('што има друго во близина на зградата'), true);
  assert.equal(detectNearbyAsk('Што уште има во близина?'), true);
  assert.equal(detectNearbyAsk('нешто друго во близина?'), true);
  assert.equal(detectNearbyAsk('има ли нешто друго околу'), true);
  // Cyrillic а/о inside Latin words — normalizeMc canonicalizes them
  assert.equal(detectNearbyAsk('sto imа drugo vo blizina'), true);
  assert.equal(detectNearbyAsk('shtо drugо vo blizina'), true);
  assert.equal(detectNearbyAsk('sproти drugo vo blizina'), true);
});

test('nearby ask: NEGATIVE — bare search questions without a proximity anchor', () => {
  assert.equal(detectNearbyAsk('sto ima?'), false);
  assert.equal(detectNearbyAsk('shto imate interesno?'), false);
  assert.equal(detectNearbyAsk('sto uste imate?'), false);
  assert.equal(detectNearbyAsk('imate li nesto?'), false);
});

test('nearby ask: NEGATIVE — property SEARCH wishes (subject not interrogative / area target)', () => {
  assert.equal(detectNearbyAsk('baram stan vo blizina na centar'), false);
  assert.equal(detectNearbyAsk('sakam stan vo blizina na tic poliklinika'), false);
  assert.equal(detectNearbyAsk('baram stan blizu centar'), false);
  assert.equal(detectNearbyAsk('stan vo blizina na park'), false);
  // anchor names a target AREA — the search pipeline owns it
  assert.equal(detectNearbyAsk('nesto vo blizina na centar'), false);
});

test('nearby ask: NEGATIVE — exact-address asks keep priority', () => {
  assert.equal(detectNearbyAsk('kade tocno vo blizina e ulicata i brojot'), false);
  assert.equal(detectNearbyAsk('moram da znam adresata vo blizina'), false);
});

test('nearby ask: NEGATIVE — long sentences and unrelated messages', () => {
  assert.equal(detectNearbyAsk(
    'dobro se soglasuvam so uslovot za procenka ama kazi mi sto ima drugo vo blizina na zgradata uste ednas'), false);
  assert.equal(detectNearbyAsk('dali e uste dostapen 76?'), false);
  assert.equal(detectNearbyAsk('kade se naogja?'), false);
  assert.equal(detectNearbyAsk('zdravo'), false);
  assert.equal(detectNearbyAsk('sakam da iznajmam stan'), false);
  assert.equal(detectNearbyAsk('kolku cini najmot?'), false);
});
