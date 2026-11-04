/**
 * A + B OF THE CLOSED LOOP (the [22:58] capture round).
 *
 *   A — the generated answer the clients accepted is stored TWICE: verbatim,
 *       and with its place replaced by {place} plus the anchor it was written
 *       for. Recalling by PLACE (not by phrasing) is what makes it recyclable:
 *       «STO IMA KAJ KAPITOL MOL» served the sentence taught by «STO IMTE
 *       INTERESNO KAJ KAPITOL MOL ?», with no model call.
 *   B — after PLACE_PROMOTE_AFTER clean serves the template is promoted into
 *       the bank's copy layer, so it survives the dynamic store's FIFO purge
 *       and serves a place that never had a row at all.
 *
 * The district guard is the safety half: «во Аеродром имаме…» is true only in
 * Аеродром, so it is never templated (verbatim recall only) — otherwise one
 * district's stock claim would be handed to a place in another one.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { EnrichmentStore } from '../src/store/enrichment';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { BankStore } from '../src/store/bank';
import { setLearnedBank } from '../src/data/responseBank';
import { placeTemplateFrom, renderPlaceTemplate, PLACE_TEMPLATE_KEY, PLACE_SLOT, assertsStockAtPlace } from '../src/llm/placeTemplate';

/** Any model call in these tests is a defect: the template must serve. */
class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('no LLM may be called'); }
}

const ROWS: Property[] = [
  { eb: 53, id: 53, location: 'Аеродром', address: 'Ул. Јане Сандански 1', price: 55000, bedrooms: 1, sqm: 44, size: '44 м²', service: 'buy', lat: 41.9850, lon: 21.4660 },
  { eb: 88, id: 88, location: 'Аеродром', address: 'Ул. Јане Сандански 20', price: 133000, bedrooms: 2, sqm: 68, size: '68 м²', service: 'buy', lat: 41.9812, lon: 21.4512 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(rows: Property[] = ROWS) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const props = new FakeProps(rows);
  const bank = new BankStore(db);
  const handler = new InboundHandler({
    cfg, db, sessions, bank,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  return { handler, bank, sent, sessions };
}

/** The [22:59] answer, verbatim — the prose the operator kept, and the one the
 *  owner KILLED at [20:38]: it asserts stock at a place nobody looked at. */
const ANSWER_KAPITOL =
  'Здраво! Во близина на Капитол Мол имаме одлични понуди, па со задоволство би Ви помогнала да го најдеме вистинскиот избор за Вас. Кажете ми, дали Ве интересира купување или изнајмување на недвижност?';
const TMPL =
  'Здраво! Во близина на {place} имаме одлични понуди, па со задоволство би Ви помогнала да го најдеме вистинскиот избор за Вас. Кажете ми, дали Ве интересира купување или изнајмување на недвижност?';

/** The place prose the owner asked for: the place named NEUTRALLY and the market
 *  question — no claim about what we have there. Templates are still recyclable
 *  (the slot works the same); only the stock claim is gone. */
const ANSWER_SAFE =
  'Здраво! Во врска со Капитол Мол, дали Ве интересира купување на недвижност или претпочитате изнајмување?';
const TMPL_SAFE =
  'Здраво! Во врска со {place}, дали Ве интересира купување на недвижност или претпочитате изнајмување?';

/** The phrasing the row was TAUGHT under. */
const Q_TAUGHT = 'STO IMTE INTERESNO KAJ KAPITOL MOL ?';
/** The SAME place, different words — the exact recall would miss this one. */
const Q_REWORDED = 'STO IMA KAJ KAPITOL MOL ?';
/** A DIFFERENT place the map knows. */
const Q_OTHER_PLACE = 'STO IMTE INTERESNO KAJ OLYMPICO ?';

test('the place becomes a slot; a district-bound sentence never does', () => {
  const tpl = placeTemplateFrom(ANSWER_KAPITOL, ['ТЦ Капитол', 'Капитол Мол']);
  assert.ok(tpl, 'the [22:59] answer is templatable');
  assert.equal(tpl, TMPL);
  assert.ok(tpl!.includes(PLACE_SLOT));
  assert.ok(!/капитол|kapitol/iu.test(tpl!), 'no word of the old place survives');

  // The longest form wins, so no orphan word of the name is left behind.
  assert.equal(placeTemplateFrom('Околу ТЦ Капитол има многу содржини. Дали да побараме?', ['ТЦ Капитол', 'Капитол']),
    'Околу {place} има многу содржини. Дали да побараме?');

  // DISTRICT-BOUND is not place-bound: «во Аеродром» is true only there.
  assert.equal(placeTemplateFrom('Во Аеродром имаме добри понуди. Дали Ве интересира купување или изнајмување?',
    ['ТЦ Капитол', 'Капитол Мол']), undefined);

  // No surface form of the anchor in the answer → nothing to template.
  assert.equal(placeTemplateFrom('Имаме одлични понуди во близина. Дали Ве интересира купување или изнајмување?',
    ['ТЦ Капитол']), undefined);

  assert.equal(renderPlaceTemplate(TMPL, 'ТЦ Олимпико'), TMPL.split('{place}').join('ТЦ Олимпико'));

  // NO STOCK CLAIM (the [20:38] owner rule): the claim is recognised in the
  // stored prose and NOT in the claim-free wording the seed now serves.
  assert.equal(assertsStockAtPlace(TMPL), true, '«имаме одлични понуди» is a stock claim');
  assert.equal(assertsStockAtPlace('Имаме интересни опции во регионот околу Капитол.'), true);
  assert.equal(assertsStockAtPlace(TMPL_SAFE), false, 'the owner wording claims nothing');
  assert.equal(assertsStockAtPlace('Дали Ве интересира купување на недвижност или претпочитате изнајмување?'), false,
    'a question is never a claim');
});

test('A: the stored template serves the same place in OTHER words — no LLM', async () => {
  const { handler, bank, sent, sessions } = makeHandler();
  bank.addDynamic('dynamic:idle:sto-imte-interesno', 'idle', Q_TAUGHT, ANSWER_SAFE,
    { template: TMPL_SAFE, place: 'ТЦ Капитол' });

  // Different wording, same place: exact recall cannot help, the template can.
  await handler.handle('test', 'a1', Q_REWORDED);
  const served = sent[sent.length - 1] ?? '';
  assert.equal(served, TMPL_SAFE.split('{place}').join('ТЦ Капитол'),
    `the stored prose must serve with the map's own place name: ${served}`);
  const s = sessions.get('a1')!;
  assert.equal(s.slots.inventoryPending, true, 'the type ask is owed on the next turn');
  assert.match(s.slots.poiAnchor ?? '', /капитол/iu, `anchor: ${s.slots.poiAnchor}`);
});

test('B: three clean serves promote the wording into the copy layer, and a NEW place is served from it', async () => {
  const { handler, bank, sent } = makeHandler();
  bank.addDynamic('dynamic:idle:sto-imte-interesno', 'idle', Q_TAUGHT, ANSWER_SAFE,
    { template: TMPL_SAFE, place: 'ТЦ Капитол' });
  assert.deepEqual(bank.variants(PLACE_TEMPLATE_KEY), [], 'nothing promoted yet');

  for (const chat of ['b1', 'b2', 'b3']) await handler.handle('test', chat, Q_REWORDED);
  assert.deepEqual(bank.variants(PLACE_TEMPLATE_KEY), [TMPL_SAFE],
    'the third clean serve promotes the template into the bank copy layer');

  // A place with NO row at all: the promoted copy carries it.
  setLearnedBank(bank);
  try {
    await handler.handle('test', 'b4', Q_OTHER_PLACE);
    const served = sent[sent.length - 1] ?? '';
    assert.match(served, /Олимпико/iu, `the promoted copy serves a new place: ${served}`);
    assert.ok(!/капитол/iu.test(served), `the old place must never leak: ${served}`);
  } finally { setLearnedBank(undefined); }
});

test('[20:38] a template that CLAIMS stock at the place is never served', async () => {
  // The owner's capture: «Здраво! Имаме одлични опции во регинот околу
  // Беверли Хилс…» was the first thing a client heard. We have no idea what is
  // there yet, so the sentence is a fabricated fact — killed at the source:
  // the place prose is the market question.
  const { handler, bank, sent } = makeHandler([]);
  bank.addDynamic('dynamic:idle:sto-interesno', 'idle', Q_TAUGHT, ANSWER_KAPITOL,
    { template: TMPL, place: 'ТЦ Капитол' });

  await handler.handle('test', 'z1', Q_REWORDED);
  const served = sent[sent.length - 1] ?? '';
  assert.notEqual(served, TMPL.split('{place}').join('ТЦ Капитол'),
    `the stock claim must not serve, not even with the right place: ${served}`);
  assert.equal(assertsStockAtPlace(served), false, `the prose claims nothing: ${served}`);
  // What answers is the bank's claim-free prose — still about the place, still
  // the market question, and still no model call and no card.
  assert.match(served, /Капитол/iu, `the place is still acknowledged: ${served}`);
  assert.match(served, /купување[\s\S]{0,40}изнајмување/iu, `the market question: ${served}`);
  assert.doesNotMatch(served, /Евидентен број/u, `no card is invented: ${served}`);
});

test('[10:16] where the feed has no cards, the TAUGHT prose answers the stock ask — no LLM', async () => {
  // The [10:16] capture: «ZDRAVO , STO INTERESNO IMATE OKOLU BEVERLI HILS ?».
  // The feed holds nothing near that place, so the turn used to fall to the
  // generic funnel line. The answer the operator accepted was generated once
  // and stored; THIS is the lane that serves it back, wording and all, with no
  // model call — and the market question is still owed, so the next turn asks
  // the TYPE (never bedrooms: nobody said «стан»).
  const { handler, bank, sent, sessions } = makeHandler([]);
  bank.addDynamic('dynamic:idle:sto-interesno', 'idle', Q_TAUGHT, ANSWER_SAFE,
    { template: TMPL_SAFE, place: 'ТЦ Капитол' });

  await handler.handle('test', 'p1', Q_REWORDED);
  const served = sent[sent.length - 1] ?? '';
  assert.equal(served, TMPL_SAFE.split('{place}').join('ТЦ Капитол'),
    `the stored prose answers where no card can: ${served}`);
  const s = sessions.get('p1')!;
  // The serve can come from the pre-classifier lane, which leaves the opening
  // state as it was — what must hold is that NO market was presumed from the
  // prose and the type is still owed.
  assert.equal(s.slots.service, undefined, 'no market is inferred by the prose');
  assert.equal(s.slots.inventoryPending, true, 'the type is still owed');

  // The verbatim [10:16] phrasing is DETERMINISTICALLY classified, so it never
  // reaches the pre-classifier lane — this one proves the drained/empty-pool
  // leg serves the same prose (the capture that started it all).
  await handler.handle('test', 'p2', 'ZDRAVO , STO INTERESNO IMATE OKOLU KAPITOL MOL ?');
  assert.equal(sent[sent.length - 1] ?? '', TMPL_SAFE.split('{place}').join('ТЦ Капитол'),
    `the classified stock ask still gets the taught prose: ${sent[sent.length - 1]}`);

  await handler.handle('test', 'p1', 'ZA KUPUVANJE SUM ZAINTERESIRAN');
  const typeAsk = sent[sent.length - 1] ?? '';
  assert.match(typeAsk, /тип|стан, куќа|деловен простор или плац/iu,
    `the TYPE is asked, never assumed: ${typeAsk}`);
  assert.doesNotMatch(typeAsk, /спалн/iu, `no bedrooms question for a flat nobody named: ${typeAsk}`);
});

test('a corrected answer stops serving its template and restarts the count', async () => {
  const { handler, bank, sent } = makeHandler();
  // A TAUGHT wording the deterministic prose does NOT share. ANSWER_KAPITOL and
  // the bank's own `place.stock.ask` seed are the same sentence, so storing it
  // here made "the template was not served" unprovable — the prose legitimately
  // answers the same question in the same words, and the assertion could not
  // tell the two apart.
  // Claim-free, so the ONLY reason it does not serve is the correction.
  const TAUGHT_OTHER = 'Во врска со Капитол Мол, дали Ве интересира купување или изнајмување на недвижност?';
  const TMPL_OTHER = 'Во врска со {place}, дали Ве интересира купување или изнајмување на недвижност?';
  bank.addDynamic('dynamic:idle:sto-imte-interesno', 'idle', Q_TAUGHT, TAUGHT_OTHER,
    { template: TMPL_OTHER, place: 'ТЦ Капитол' });
  const row = bank.dynamicRows(100).find(r => r.msg === Q_TAUGHT);
  assert.ok(row, 'the row is stored');

  // The operator corrects the prose (F9): its templated copy is wrong too.
  assert.ok(bank.updateDynamicAnswer(row!.id, 'Извинете, тоа не е точно. Ќе проверам кај сопственикот и ќе Ви потврдам.'));
  assert.equal(bank.retrievePlaceTemplate('ТЦ Капитол'), undefined, 'the template is gone with the correction');

  await handler.handle('test', 'c1', Q_REWORDED);
  const served = sent[sent.length - 1] ?? '';
  // The TAUGHT wording must not serve — but the [17:30] prose lane is the stock
  // ask's own deterministic answer now, and its seeds share the «одлични
  // понуди» phrase. The discriminator is the ROW's sentence, not that phrase:
  // the corrected/taught text must be gone, and the generic prose must answer.
  assert.notEqual(served, TMPL_OTHER.split('{place}').join('ТЦ Капитол'),
    `the corrected row must not serve its old template: ${served}`);
  assert.ok(!served.includes('Извинете, тоа не е точно'),
    `and it must not serve the corrected text as a card answer: ${served}`);
  assert.match(served, /Капитол/i, `the stock ask is still answered about the place: ${served}`);
  assert.doesNotMatch(served, /Евидентен број/u, `and no card is invented: ${served}`);
});
