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
import { placeTemplateFrom, renderPlaceTemplate, PLACE_TEMPLATE_KEY, PLACE_SLOT } from '../src/llm/placeTemplate';

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

function makeHandler() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const props = new FakeProps(ROWS);
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

/** The [22:59] answer, verbatim — the prose the operator kept. */
const ANSWER_KAPITOL =
  'Здраво! Во близина на Капитол Мол имаме одлични понуди, па со задоволство би Ви помогнала да го најдеме вистинскиот избор за Вас. Кажете ми, дали Ве интересира купување или изнајмување на недвижност?';
const TMPL =
  'Здраво! Во близина на {place} имаме одлични понуди, па со задоволство би Ви помогнала да го најдеме вистинскиот избор за Вас. Кажете ми, дали Ве интересира купување или изнајмување на недвижност?';

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
});

test('A: the stored template serves the same place in OTHER words — no LLM', async () => {
  const { handler, bank, sent, sessions } = makeHandler();
  bank.addDynamic('dynamic:idle:sto-imte-interesno', 'idle', Q_TAUGHT, ANSWER_KAPITOL,
    { template: TMPL, place: 'ТЦ Капитол' });

  // Different wording, same place: exact recall cannot help, the template can.
  await handler.handle('test', 'a1', Q_REWORDED);
  const served = sent[sent.length - 1] ?? '';
  assert.equal(served, TMPL.split('{place}').join('ТЦ Капитол'),
    `the stored prose must serve with the map's own place name: ${served}`);
  const s = sessions.get('a1')!;
  assert.equal(s.slots.inventoryPending, true, 'the type ask is owed on the next turn');
  assert.match(s.slots.poiAnchor ?? '', /капитол/iu, `anchor: ${s.slots.poiAnchor}`);
});

test('B: three clean serves promote the wording into the copy layer, and a NEW place is served from it', async () => {
  const { handler, bank, sent } = makeHandler();
  bank.addDynamic('dynamic:idle:sto-imte-interesno', 'idle', Q_TAUGHT, ANSWER_KAPITOL,
    { template: TMPL, place: 'ТЦ Капитол' });
  assert.deepEqual(bank.variants(PLACE_TEMPLATE_KEY), [], 'nothing promoted yet');

  for (const chat of ['b1', 'b2', 'b3']) await handler.handle('test', chat, Q_REWORDED);
  assert.deepEqual(bank.variants(PLACE_TEMPLATE_KEY), [TMPL],
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

test('a corrected answer stops serving its template and restarts the count', async () => {
  const { handler, bank, sent } = makeHandler();
  bank.addDynamic('dynamic:idle:sto-imte-interesno', 'idle', Q_TAUGHT, ANSWER_KAPITOL,
    { template: TMPL, place: 'ТЦ Капитол' });
  const row = bank.dynamicRows(100).find(r => r.msg === Q_TAUGHT);
  assert.ok(row, 'the row is stored');

  // The operator corrects the prose (F9): its templated copy is wrong too.
  assert.ok(bank.updateDynamicAnswer(row!.id, 'Извинете, тоа не е точно. Ќе проверам кај сопственикот и ќе Ви потврдам.'));
  assert.equal(bank.retrievePlaceTemplate('ТЦ Капитол'), undefined, 'the template is gone with the correction');

  await handler.handle('test', 'c1', Q_REWORDED);
  const served = sent[sent.length - 1] ?? '';
  assert.ok(!served.includes('одлични понуди'), `the corrected row must not serve its old template: ${served}`);
});
