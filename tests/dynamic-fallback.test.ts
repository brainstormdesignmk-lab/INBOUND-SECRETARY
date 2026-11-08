// P-RUNTIME DYNAMIC FALLBACK — the closed loop's runtime half.
//
// Unroutable question → recall from bank_dynamic (0 ms) → miss → one
// constrained Gemini call → validate (P1 baseline + hygiene + no-facts) →
// serve + store immediately. Any dirty output degrades to the pre-existing
// path with NOTHING stored — a wrong answer must never become permanent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { validateDynamicAnswer, recallDynamic, dynamicAnswer, generateDynamic, dynamicSlug, namesPropertyType, typeEstablished, dynamicRowViolations } from '../src/llm/dynamicFallback';
import { renderPlaceTemplate } from '../src/llm/placeTemplate';
import { LlmClient } from '../src/llm/types';
import { ChatSession } from '../src/fsm/session';

function fresh(): { bank: BankStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dynfb-'));
  const db = new Db(join(dir, 't.db'));
  return { bank: new BankStore(db), dir };
}

const CLEAN = 'Секогаш почнуваме со преглед на документацијата на недвижноста. Дали сакате да организираме посета за да ги видите документите во оригинал?';

test('validation: clean pass, fact violations, hygiene violations, promises', () => {
  assert.deepEqual(validateDynamicAnswer(CLEAN), []);
  // price named → forbidden fact
  assert.ok(validateDynamicAnswer('Станот чини 50.000 евра. Дали Ве интересира?').some(v => v.includes('concrete fact')));
  // EB named
  assert.ok(validateDynamicAnswer('Имотот со Евидентен број 41 е слободен?').length > 0);
  // promise
  assert.ok(validateDynamicAnswer('Ветувам целосна поддршка. Дали продолжуваме?').some(v => v.includes('forbidden')));
  // hygiene: latin junk line
  assert.ok(validateDynamicAnswer('totally latin answer without question mark').length > 0);
});

// THE [21:20] CAPTURE: «ZDRAVO , STO IMATE INTERESNO OKOLU KAPITOL MOL ?» was
// answered «Дали барате СТАН за купување или за изнајмување?» — a place was
// named, never a flat. The bank copy is clean; the leak is the GENERATED path,
// and prompt wording is not a guard. The service question may only presume a
// type the client established.
test('[21:20] the service question never presumes a property type', () => {
  const leak = 'Здраво! Локацијата околу Капитол Мол е популарна. Дали барате стан за купување или за изнајмување?';
  assert.equal(namesPropertyType(leak), true);
  assert.ok(validateDynamicAnswer(leak).some(v => v.includes('property type the client never mentioned')),
    `the type-presuming service ask must be rejected: ${JSON.stringify(validateDynamicAnswer(leak))}`);
  assert.ok(validateDynamicAnswer(leak, 'ZDRAVO , STO IMATE INTERESNO OKOLU KAPITOL MOL ?', { typeKnown: false }).length > 0,
    'a place-named opening does not establish the type');

  // THE CANONICAL LINE passes — service on «недвижност», category asked later.
  const clean = 'Здраво! Локацијата околу Капитол Мол е популарна. Дали Ве интересира купување или изнајмување на недвижност?';
  assert.deepEqual(validateDynamicAnswer(clean, 'ZDRAVO , STO IMATE INTERESNO OKOLU KAPITOL MOL ?', { typeKnown: false }), []);

  // Once the client established it, the flat wording is legitimate.
  assert.deepEqual(validateDynamicAnswer(leak, 'sakam da kupam stan', { typeKnown: true }), []);
  // …and naming it in the MESSAGE establishes it without a slot.
  assert.equal(typeEstablished({}, 'sakam da kupam stan'), true);
  assert.deepEqual(validateDynamicAnswer(leak, 'sakam da kupam stan'), []);
  // A flat slot (applySlots already ran) does too.
  assert.equal(typeEstablished({ flat: true }), true);

  // WHOLE WORDS ONLY: ordinary vocabulary is not a type.
  assert.equal(namesPropertyType('стандардна постапка, станбена површина, станарот'), false);
  // The category question enumerating every type is NOT a service ask — the
  // funnel already owns it (AGENTS §4, the sanctioned enumeration).
  assert.deepEqual(validateDynamicAnswer('За да Ви понудам соодветни опции, кажете ми — барате стан, куќа, деловен простор или плац?'), []);
});

test('[21:20] a generated service ask that presumes a flat is REFUSED and not stored', async () => {
  const { bank, dir } = fresh();
  const msg = 'ZDRAVO , STO IMATE INTERESNO OKOLU KAPITOL MOL ?';
  try {
    const leak = 'Здраво! Локацијата околу Капитол Мол е популарна и имаме интересни опции. Дали барате стан за купување или за изнајмување?';
    const res = await dynamicAnswer(new ScriptedLlm(leak), fakeSession(), msg, bank);
    assert.equal(res, undefined, 'the type-presuming answer must not serve — the deterministic line takes the turn');
    assert.equal(bank.retrieveDynamic(msg), undefined, 'and it must never be stored for recall');

    // The canonical wording passes the same gate and is served.
    const clean = 'Здраво! Локацијата околу Капитол Мол е популарна и имаме интересни опции. Дали Ве интересира купување или изнајмување на недвижност?';
    const ok = await dynamicAnswer(new ScriptedLlm(clean), fakeSession(), msg, bank);
    assert.equal(ok?.text, clean, 'the clean answer serves');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// EVERY OTHER INVENTED FACT — the [21:20] rule generalised. A generated answer
// may name only what the CLIENT established (knownFacts); rooms, area, year and
// floor are property-row data exactly like the price, so prose that supplies
// them is the same defect as «стан» in the service question.
test('invented property data is refused: rooms, area, year, floor', () => {
  const invented = [
    'Станот е двособен, со две спални соби. Дали Ве интересира да го видите?',
    'Има 68 квадрати и е целосно наместен. Дали да закажеме посета?',
    'Зградата е изградена во 2008 година. Дали сакате да организираме посета?',
    'Недвижноста се наоѓа на трети кат. Дали Ве интересира?',
  ];
  for (const a of invented) {
    assert.ok(validateDynamicAnswer(a).some(v => v.includes('concrete fact')), `must be refused: ${a}`);
  }
  // The honest miss names no datum — it hands off to the owner and must serve.
  assert.deepEqual(
    validateDynamicAnswer('Немам податок во системот за бројот на спални — ќе го прашам сопственикот и ќе Ви потврдам.', 'kolku spalni ima?'),
    [],
  );
});

// The sweep script and the serve path share ONE predicate, so a purge can never
// disagree with what recall refuses. The nightly digest would otherwise fold a
// refused row into bank_variants before anybody noticed.
test('the stored-row audit finds and purges rows that break the contracts', () => {
  const { bank, dir } = fresh();
  try {
    bank.addDynamic('dynamic:idle:kolku-spalni', 'idle', 'kolku spalni ima?', 'Станот е двособен, со две спални соби. Дали Ве интересира?');
    bank.addDynamic('dynamic:idle:sto-ima', 'idle', 'sto imate interesno okolu kapitol mol ?', 'Дали барате стан за купување или за изнајмување?');
    bank.addDynamic('dynamic:property_query:dozvola', 'property_query', 'dali ima dozvola?', CLEAN);
    const rows = bank.dynamicRows(1000);
    assert.equal(rows.length, 3);
    const dirty = rows.filter(r => dynamicRowViolations(r).length > 0);
    assert.deepEqual(dirty.map(r => r.key).sort(), ['dynamic:idle:kolku-spalni', 'dynamic:idle:sto-ima'],
      `both presumption rows must be flagged: ${JSON.stringify(dirty.map(d => [d.key, dynamicRowViolations(d)]))}`);
    for (const r of dirty) bank.deleteDynamic(r.id);
    assert.equal(bank.dynamicRowCount(), 1, 'only the clean row survives the purge');
    assert.equal(recallDynamic(bank, 'kolku spalni ima?'), undefined, 'a purged question no longer serves');
    assert.ok(recallDynamic(bank, 'dali ima dozvola?'), 'the clean row still recalls');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('slug: stable and state-scoped', () => {
  const a = dynamicSlug('property_query', 'dali stanot ima dozvola za koristenje?');
  const b = dynamicSlug('property_query', 'dali stanot ima dozvola za koristenje?');
  assert.equal(a, b);
  assert.ok(a.startsWith('dynamic:property_query:'));
  assert.ok(a.includes('dozvola'));
});

test('recall: stored answer returns; stale answer re-validated and degraded', () => {
  const { bank, dir } = fresh();
  try {
    bank.addDynamic('dynamic:property_query:dozvola', 'property_query', 'dali ima dozvola?', CLEAN);
    const hit = recallDynamic(bank, 'dali ima dozvola?');
    assert.ok(hit, 'clean stored answer recalls');
    assert.equal(hit!.source, 'dynamic-recall');
    // A stored answer that now violates hygiene (e.g. contract tightened)
    // must NOT serve.
    bank.addDynamic('dynamic:property_query:uplata', 'property_query', 'kakvo se plakja?', 'Секако, плаќа се 5000 евра веднаш!');
    assert.equal(recallDynamic(bank, 'kakvo se plakja?'), undefined, 'dirty stored row degrades');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

class ScriptedLlm implements LlmClient {
  constructor(private reply: string) {}
  async complete(): Promise<string> { return this.reply; }
}

class ThrowingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('must not be called'); }
}

function fail(): never { throw new Error('unreachable'); }

function fakeSession(): ChatSession {
  return {
    chatId: 'dyn-test',
    state: 'property_query',
    slots: { service: 'buy', location: 'Аеродром' },
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as ChatSession;
}

test('generate: clean LLM answer is served AND stored; recall hits next time', async () => {
  const { bank, dir } = fresh();
  try {
    const first = await dynamicAnswer(new ScriptedLlm(CLEAN), fakeSession(), 'kakvi dokumenti se potrebni za kupuvanje?', bank);
    assert.ok(first, 'clean answer must serve');
    assert.equal(first!.source, 'dynamic');
    // second call: recall (no LLM needed) — ThrowingLlm fails the test if called
    void fail;
    const second = await dynamicAnswer(new ThrowingLlm(), fakeSession(), 'kakvi dokumenti se potrebni za kupuvanje?', bank);
    assert.ok(second);
    assert.equal(second!.source, 'dynamic-recall');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// THE #29/#30 DEFECT, GENERATION HALF. An answer that names an area only the
// SESSION established («Ќе ги проверам… во Аеродром…») is fine copy for THIS
// client and poison as bank copy: any later client whose wording scores near
// the trigger would be told about an area he never mentioned. So the live turn
// keeps the answer and the store does not.
test('[23:09] an area only the session knew is served once, never banked', async () => {
  const { bank, dir } = fresh();
  try {
    const answer = 'Ќе ги проверам достапните станови за купување во Аеродром со малку повисок буџет. До која максимална сума би сакале да ја прошириме потрагата?';
    const q = 'A NESTO MALKU POSKAPO ?';
    // fakeSession() established Аеродром: the live turn is answered correctly.
    const res = await dynamicAnswer(new ScriptedLlm(answer), fakeSession(), q, bank);
    assert.ok(res, 'the live turn still gets the answer — the session named the area');
    assert.equal(bank.dynamicRowCount(), 0, 'but it is not bank copy: it needs the session context');

    // A client who never named an area is not even served it.
    const bare = fakeSession();
    bare.slots = { service: 'buy' };
    assert.equal(await dynamicAnswer(new ScriptedLlm(answer), bare, q, bank), undefined,
      'a sentence naming an area the client never mentioned must not serve');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// A — THE PLACE TEMPLATE IS STORED BESIDE THE PROSE (the [22:58] round).
// A stock-at-a-place answer is true only for the place it names, so the store
// keeps the {place} form + the anchor too: same place in other words needs no
// new generation, and (after B promotes it) another place needs none either.
// A district-bound sentence is refused by the templater, so this can never
// launder one district's claim into another's.
test('A: a stock-at-a-place answer is stored as a {place} template', async () => {
  const { bank, dir } = fresh();
  try {
    const session = fakeSession();
    session.slots.poiAnchor = 'ТЦ Капитол';
    const answer = 'Здраво! Во близина на Капитол Мол имаме одлични понуди, па со задоволство би Ви помогнала да ги најдеме вистинските опции. Кажете ми, дали Ве интересира купување или изнајмување на недвижност?';
    const res = await generateDynamic(new ScriptedLlm(answer), session, 'STO IMTE INTERESNO KAJ KAPITOL MOL ?', bank);
    assert.ok(res, 'the clean answer serves');
    const tpl = bank.retrievePlaceTemplate('ТЦ Капитол');
    assert.ok(tpl, 'the row carries a place template for its anchor');
    assert.match(tpl!.template, /\{place\}/u);
    assert.ok(!/капитол|kapitol/iu.test(tpl!.template),
      `no word of the old place may survive in the template: ${tpl!.template}`);
    assert.match(renderPlaceTemplate(tpl!.template, 'ТЦ Олимпико'), /ТЦ Олимпико/u,
      'the same wording renders for another place');
    // The verbatim answer is untouched — the row still serves its own phrasing.
    assert.equal(bank.retrieveDynamic('STO IMTE INTERESNO KAJ KAPITOL MOL ?')?.answer, answer);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('generate: dirty LLM output serves NOTHING and stores NOTHING', async () => {
  const { bank, dir } = fresh();
  try {
    const dirty = 'Цената е 143.000 евра и имотот е слободен веднаш.';
    const res = await dynamicAnswer(new ScriptedLlm(dirty), fakeSession(), 'kolku kuini imotot?', bank);
    assert.equal(res, undefined, 'dirty answer degrades');
    assert.equal(bank.dynamicGroups().length, 0, 'nothing stored');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('generate: LLM failure degrades silently', async () => {
  const { bank, dir } = fresh();
  try {
    const res = await dynamicAnswer(new class implements LlmClient {
      async complete(): Promise<string> { throw new Error('429'); }
    }, fakeSession(), 'neodgovoreno prasanje sluchaj?', bank);
    assert.equal(res, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('retrieveDynamicExact: exact/containment only, never trigram, state-scoped on top-of-funnel recall', () => {
  const { bank, dir } = fresh();
  try {
    assert.equal(bank.addDynamic('dynamic:closing:foo', 'closing', 'kade ima reptil', 'Одговорот од банката.'), true);
    // exact
    assert.equal(bank.retrieveDynamicExact('kade ima reptil', 'closing')?.answer, 'Одговорот од банката.');
    // containment (the stored phrase is inside the new sentence) — allowed
    assert.ok(bank.retrieveDynamicExact('kade ima reptil tamu?', 'closing'));
    // another FSM state must not serve it at the top of the funnel
    assert.equal(bank.retrieveDynamicExact('kade ima reptil', 'presentation'), undefined);
    // not a containment and under the trigram path's bar for this pair: no serve
    assert.equal(bank.retrieveDynamicExact('kade ima reptilche', 'closing'), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('retrieveExact: learned examples serve only the phrasing they literally saw', () => {
  const { bank, dir } = fresh();
  try {
    bank.addExample('learn.kazi-znaes', 'KAZI MI STO ZNAES ZA 58 ?');
    assert.equal(bank.retrieveExact('kazi mi sto znaes za 58 ?')?.key, 'learn.kazi-znaes');
    assert.equal(bank.retrieveExact('KAZI MI STO ZNAES ZA 58 ? i dali e sloboden')?.key, 'learn.kazi-znaes');
    assert.equal(bank.retrieveExact('kazi mi sto znaes za 59 ?'), undefined, 'one different token is not a literal match');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('relevance guard: a visit pitch cannot answer a factual question (the [00:33] year capture)', () => {
  const pitch = 'Извлеков неколку предлози прилагодени на Вашиот вкус, па дали би сакале да договориме време кога би ги посетиле?';
  const ask = 'od koja godina e zgradata?';
  assert.ok(
    validateDynamicAnswer(pitch, ask).some(v => v.includes('does not answer the question')),
    'a generic pitch must be rejected for a factual ask',
  );
  // The same pitch is legitimate when the client asked for a viewing.
  assert.deepEqual(validateDynamicAnswer(pitch, 'sakam da ja vidam stanot'), []);
  // The honest miss (the line the info lane serves) passes — and must.
  assert.deepEqual(
    validateDynamicAnswer('Немам податок во базата од која година е зградата — ќе го прашам сопственикот и ќе Ви потврдам.', ask),
    [],
  );
  // Without a message the old contract is unchanged (pure hygiene/facts).
  assert.deepEqual(validateDynamicAnswer(pitch), []);
});

test('recall refuses a stored pitch for the factual question it was wrongly learned from', () => {
  const { bank, dir } = fresh();
  try {
    const pitch = 'Извлеков неколку предлози прилагодени на Вашиот вкус, па дали би сакале да договориме време кога би ги посетиле?';
    bank.addDynamic('dynamic:presentation:koja-godina-zgradata', 'presentation', 'od koja godina e zgradata?', pitch);
    // The row exists, but recall re-validates with the question → no serve.
    assert.equal(recallDynamic(bank, 'od koja godina e zgradata?'), undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
