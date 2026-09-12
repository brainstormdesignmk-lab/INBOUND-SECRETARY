import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Db } from '../src/store/db';
import { BankStore, FROZEN_BANK_KEYS, DATA_DRIVEN_KEYS, MAX_VARIANTS_PER_KEY } from '../src/store/bank';
import { setLearnedBank, getLearnedBank, pickVariant, retrieveVariant } from '../src/data/responseBank';

// The learned bank layer: SQLite storage, retrieval, frozen keys, metrics.
function freshBank(): { store: BankStore; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'bank-'));
  const db = new Db(join(dir, 't.db'));
  return { store: new BankStore(db), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test('bank store: addVariant + variants roundtrip', () => {
  const { store, cleanup } = freshBank();
  assert.equal(store.addVariant('k1', 'Одговор еден.'), true);
  assert.equal(store.addVariant('k1', 'Одговор еден.'), false); // idempotent
  assert.deepEqual(store.variants('k1'), ['Одговор еден.']);
  cleanup();
});

test('frozen keys are rejected at the store layer', () => {
  const { store, cleanup } = freshBank();
  for (const key of FROZEN_BANK_KEYS) {
    assert.equal(store.addVariant(key, 'обид за запишување.'), false, key);
  }
  assert.deepEqual(store.variants('fee.ask.rent'), []);
  cleanup();
});

test('forceAddVariant: the human-directed carve-out for frozen keys', () => {
  const { store, cleanup } = freshBank();
  // The cron/learning loop must NEVER grow a frozen key...
  assert.equal(store.addVariant('fee.why', 'крон обид — мора да биде одбиен.'), false);
  // ...but an approved one-off gap-fill may (cap + dedupe still apply).
  assert.equal(store.forceAddVariant('fee.why', 'Ова е човечки прегледана варијанта за протоколот.'), true);
  assert.equal(store.forceAddVariant('fee.why', 'Ова е човечки прегледана варијанта за протоколот.'), false); // idempotent
  assert.deepEqual(store.variants('fee.why'), ['Ова е човечки прегледана варијанта за протоколот.']);
  // Cap still enforced through the force path.
  for (let i = 0; i < MAX_VARIANTS_PER_KEY + 5; i++) store.forceAddVariant('fee.why', `полнење варијанта број ${i} со текст.`);
  assert.equal(store.variants('fee.why').length, MAX_VARIANTS_PER_KEY);
  cleanup();
});

test('variant cap: MAX_VARIANTS_PER_KEY enforced', () => {
  const { store, cleanup } = freshBank();
  for (let i = 0; i < MAX_VARIANTS_PER_KEY + 5; i++) store.addVariant('cap', `варијанта број ${i} со доволно текст.`);
  assert.equal(store.variants('cap').length, MAX_VARIANTS_PER_KEY);
  cleanup();
});

test('retrieval: exact example match serves the key', () => {
  const { store, cleanup } = freshBank();
  store.addExample('parking.ask', 'dali imate parking za stanot');
  store.addVariant('parking.ask', 'Паркинг постои во зградата.');
  setLearnedBank(store);
  const line = retrieveVariant('Dali imate parking za stanot?');
  assert.equal(line, 'Паркинг постои во зградата.');
  setLearnedBank(undefined);
  cleanup();
});

test('retrieval: trigram similarity matches paraphrase', () => {
  const { store, cleanup } = freshBank();
  store.addExample('pets.ask', 'dali e dozvoleno kuce vo stanot');
  store.addVariant('pets.ask', 'Маскотата е добредојдена по договор.');
  setLearnedBank(store);
  const line = retrieveVariant('dali e dozvoleno kuce vo stan');
  assert.equal(line, 'Маскотата е добредојдена по договор.');
  setLearnedBank(undefined);
  cleanup();
});

test('retrieval: unmatched message returns undefined (escalates)', () => {
  const { store, cleanup } = freshBank();
  store.addExample('a.k', 'kako e vremeto denes');
  setLearnedBank(store);
  assert.equal(retrieveVariant('baram stan vo aerodrom do 300 evra'), undefined);
  setLearnedBank(undefined);
  cleanup();
});

test('metrics: hit/miss accounting drives hit-rate', () => {
  const { store, cleanup } = freshBank();
  store.metric('k', true);
  store.metric('k', true);
  store.metric('k', false);
  const s = store.stats();
  assert.ok(Math.abs(s.hitRate! - 2 / 3) < 1e-9);
  cleanup();
});

test('pickVariant merges seed + learned layers', () => {
  const { store, cleanup } = freshBank();
  store.addVariant('offtopic.redirect', 'Тоа е надвор од темата, но ајде да најдеме стан.');
  setLearnedBank(store);
  const v = pickVariant('offtopic.redirect');
  assert.ok(v && v.length > 10);
  setLearnedBank(undefined);
  cleanup();
});

test('corrections quarantine failed answers', () => {
  const { store, cleanup } = freshBank();
  store.correction('some.key', 'прашање кое не беше одговорено добро', 'лош одговор', 'client-re-asked-within-10min');
  assert.equal(store.stats().corrections, 1);
  cleanup();
});

test('self-test passes on healthy store', () => {
  const { store, cleanup } = freshBank();
  assert.doesNotThrow(() => store.selfTest());
  cleanup();
});

test('module-level attach works for runtime wiring', () => {
  const { store, cleanup } = freshBank();
  setLearnedBank(store);
  assert.equal(getLearnedBank(), store);
  setLearnedBank(undefined);
  assert.equal(getLearnedBank(), undefined);
  cleanup();
});

// ---- DATA-DRIVEN EXCLUSION: facts live in the property row, never in prose ----

test('data-driven keys are excluded from variant + example storage', () => {
  const { store, cleanup } = freshBank();
  for (const key of DATA_DRIVEN_KEYS) {
    assert.equal(store.addVariant(key, 'Некоја реченица со факти.'), false, key);
    assert.equal(store.addExample(key, 'dali e dostapen stanot'), false, key + ' example');
  }
  // The exact mistake class that motivated the rule:
  assert.equal(store.addVariant('price.ask', 'Станот чини 185.000 евра.'), false);
  cleanup();
});

test('price-digit guard: prose carrying a price is rejectable', () => {
  // Mirrors replyIsClean in enrichBank.ts — price in bank prose = stale fact.
  const PRICE_RE = /\d[\d\s.,]{2,}\s*(евра|денари|мкд|eur|evra)/i;
  assert.ok(PRICE_RE.test('Станот со Евидентен број 78 чини 185.000 евра.'));
  assert.ok(PRICE_RE.test('Цената е 99.000 евра'));
  assert.ok(!PRICE_RE.test('Може ли да Ви помогнам со нешто друго?'));
  assert.ok(!PRICE_RE.test('Имотот има 3 спални соби.')); // counts without price units
});

test('markdown guard: bold/heading/bullet prose is rejectable', () => {
  const MD_RE = /\*\*|^#|^\-\s/m;
  assert.ok(MD_RE.test('**Локација:** Центар'));
  assert.ok(MD_RE.test('# Наслов'));
  assert.ok(MD_RE.test('- прва точка'));
  assert.ok(!MD_RE.test('Обична реченица во разговор, без форматирање.'));
});

test('frozen set includes commission/contact law after extension', () => {
  for (const key of ['provision.who.buy', 'contact.ask.name', 'owner.contact.refusal']) {
    assert.ok(FROZEN_BANK_KEYS.has(key), key);
  }
});
