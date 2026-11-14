// THE CODE-OWNED ANSWERS — where the review screen says they live.
//
// The screen paints a frozen/data-driven row orange and prints `file → symbol`
// instead of offering an edit. That is only useful if the path is TRUE, so this
// test checks the map against the repo: every source it names must exist, and
// the symbol it names must actually appear in that file. A rename that forgets
// this map fails here instead of sending the operator to a file that no longer
// says what the screen claims.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { codeSourceFor, codeSourceLine, isCodeConstant } from '../src/bank/codeSource';
import { FROZEN_BANK_KEYS, DATA_DRIVEN_KEYS } from '../src/store/bank';
import { RESPONSE_BANK } from '../src/data/responses';

function findProjectRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) return dir;
    const parent = path.resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`cannot find project root from ${from}`);
}
const ROOT = findProjectRoot(__dirname);

test('every code-owned key resolves to a file that exists and a symbol it contains', () => {
  const keys = [...FROZEN_BANK_KEYS, ...DATA_DRIVEN_KEYS];
  const missing: string[] = [];
  for (const key of keys) {
    const src = codeSourceFor(key);
    if (!src) { missing.push(`${key}: no source`); continue; }
    const file = path.join(ROOT, src.file);
    if (!fs.existsSync(file)) { missing.push(`${key}: missing file ${src.file}`); continue; }
    const body = fs.readFileSync(file, 'utf8');
    if (!body.includes(src.symbol)) missing.push(`${key}: ${src.file} has no ${src.symbol}`);
  }
  assert.deepEqual(missing, [], missing.join('\n'));
});

test('seeded policy wording points at the generated seed file, with the warning', () => {
  const src = codeSourceFor('contact.ask.name.phone');
  assert.equal(src?.file, 'src/data/responses.ts');
  assert.equal(src?.symbol, '"contact.ask.name.phone"');
  assert.match(src?.note ?? '', /generateResponses/);
  assert.ok((RESPONSE_BANK['contact.ask.name.phone'] ?? []).length > 0);
});

test('the info-miss lines point at their constants in infoAnswer.ts', () => {
  assert.equal(codeSourceLine('info.no.year'), 'src/llm/infoAnswer.ts → INFO_NO_YEAR_LINE');
  assert.equal(codeSourceLine('info.no.renovation'), 'src/llm/infoAnswer.ts → INFO_NO_RENOVATION_LINE');
  assert.equal(codeSourceLine('info.no.floors'), 'src/llm/infoAnswer.ts → INFO_NO_FLOORS_LINE');
  assert.equal(codeSourceLine('info.no.data'), 'src/llm/infoAnswer.ts → INFO_NO_DATA_LINE');
});

test('an ordinary learn key is not code-owned — no source, no orange', () => {
  assert.equal(codeSourceFor('learn.kade-e-stanot'), undefined);
  assert.equal(codeSourceLine('learn.kade-e-stanot'), undefined);
  assert.equal(codeSourceFor(null), undefined);
  assert.equal(isCodeConstant('learn.kade-e-stanot'), false);
});

// ORANGE = CODE ONLY. A frozen key that serves from a seed POOL is still bank
// material (blue); only a key with no pool at all is orange.
test('orange is reserved for code constants, not seeded frozen keys', () => {
  assert.equal(isCodeConstant('info.no.year'), true);
  assert.equal(isCodeConstant('info.no.renovation'), true);
  assert.equal(isCodeConstant('price.ask'), true);
  assert.equal(isCodeConstant('contact.ask.name.phone'), false, '17 seed variants — bank material');
  assert.equal(isCodeConstant('fee.ask.buy'), false);
  // The availability claim has NO pool: it is composed from the feed column
  // `dostapno_od` (the [12:35] capture), so it is code-owned like info.no.*.
  assert.equal(isCodeConstant('availability.claim'), true);
  assert.equal(codeSourceLine('availability.claim'), 'src/llm/prompts.ts → buildAvailabilityClaim');
  assert.equal(isCodeConstant('learn.kade-e-stanot'), false);
});

// The row colour is driven by the review verdict, not by the key text: only a
// refused key (`flag === 'key'`) is painted orange. A learn row stays normal.
//
// ROUTING IS NOT COPY: a frozen SEEDED pool (contact.ask.*) is bank material
// whose QUESTION can be re-homed to a learn.* route, so its row is actionable,
// not orange. Orange is reserved for a CODE CONSTANT (info.no.*, price.ask),
// where no wording can be banked at all.
test('review flags only the code-owned row as orange material', async () => {
  const { Db } = await import('../src/store/db');
  const { BankStore } = await import('../src/store/bank');
  const { EnrichmentStore } = await import('../src/store/enrichment');
  const { BankReview } = await import('../src/bank/review');
  const db = new Db(':memory:');
  const en = new EnrichmentStore(db);
  const review = new BankReview(db, new BankStore(db), en);
  en.insert({ chatId: 'c1', state: 'contact_collection', eventType: 'CONTACT_ASK',
    userMsg: 'kako se vika?', replyText: 'Ве молам кажете го Вашето име.', replySource: 'deterministic',
    bankKey: 'contact.ask.name.phone' });
  en.insert({ chatId: 'c1', state: 'presentation', eventType: 'LEARNED_RECALL',
    userMsg: 'kade e stanot?', replyText: 'Ќе го проверам кај сопственикот.', replySource: 'dynamic',
    bankKey: 'learn.kade-e-stanot' });
  en.insert({ chatId: 'c1', state: 'property_query', eventType: 'INFO_ASK',
    userMsg: 'od koja godina e zgradata?', replyText: 'Немам податок во базата.', replySource: 'deterministic',
    bankKey: 'info.no.year' });
  const rows = review.list('enrichment');
  const seeded = rows.find(r => r.key === 'contact.ask.name.phone')!;
  const constant = rows.find(r => r.key === 'info.no.year')!;
  const learn = rows.find(r => r.key === 'learn.kade-e-stanot')!;
  assert.notEqual(seeded.flag, 'key', 'a frozen SEED pool is route-open, not orange');
  assert.match(review.suggestKey(seeded), /^learn\./, 'its question gets a bankable home');
  assert.equal(constant.flag, 'key', 'a code constant has nothing to bank');
  assert.equal(review.suggestKey(constant), 'info.no.year');
  assert.equal(learn.flag, 'ok');
  assert.ok(codeSourceFor(constant.key!));
  assert.equal(codeSourceFor(review.suggestKey(learn)), undefined);
});
