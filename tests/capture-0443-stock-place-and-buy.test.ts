// THE [04:43]–[04:54] CAPTURE — the stock ask, the second measurement, and the
// flat «KAJ DRZAVNA».
//
// Three defects, one class: the turn named something and Lina answered
// something else.
//
//   1. «DAJ MI STO IMA ZA POD KIRIJA KAJ UNIVERZALNA» was answered «Еве ги
//      сите станови:» with EB 76, 48, 41 — the whole rent book dumped, no price
//      limit, no bedroom count, in a chat where the client had not said either.
//      The owner's rule: a stock ask first ASKS the two criteria that make a
//      pair meaningful, then serves a pair.
//   2. «48 NA KOLKU METRA E DO SITI MOL ?» — the unit «metra» was not in the
//      distance lane's list, so the message fell out of the measurement lane and
//      the POI-confirm arm replied «Не, тоа е на 3,9 километри од Skopje
//      Downtown Hostel» (a different place). The follow-up «A DO LEPTOKARIJA ?»
//      carries no cue at all and re-served the card instead of the distance.
//   3. «IMASE EDEN STAN TROSOBEN TUKA KAJ DRZAVNA BLISKU» found no place: the
//      «државна болница» alias demanded the noun «болница», so the bare
//      adjective Skopjani use fell through to the substring pass and resolved to
//      «Reptil Market br.11 Drzavna bolnica» — a pet shop NAMED after the
//      hospital — or to nothing at all. The recall then served an Аеродром pair
//      (and, in the field, a business premise) instead of the flat the client
//      had in mind, and «DALI SE PRODAVA USTE?» answered about those.
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
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { BankStore } from '../src/store/bank';
import { EnrichmentStore } from '../src/store/enrichment';
import {
  isDistanceQuestion, extractDistancePlace, extractBareDistancePlace,
} from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// The capture's own geography. EB 48 is the rent flat near Сити Мол; EB 66 is
// the трособен near Државна болница (the УКЦ complex on Бул. Водњанска).
// EB 75/82 are the Аеродром pair the recall served instead, and EB 42 is the
// business premise that once rode along with the apartments.
const ROWS: Property[] = [
  { eb: 48, id: 48, location: 'Карпош III', address: 'Скопје Сити Мол', price: 250,
    bedrooms: 3, sqm: 60, size: '60 м²', service: 'rent', lat: 42.0040, lon: 21.3940 },
  { eb: 76, id: 76, location: 'Центар', address: 'Амбасада на Црна Гора', price: 200,
    bedrooms: 0, sqm: 24, size: '24 м²', service: 'rent', studio: true, lat: 41.9962, lon: 21.4330 },
  { eb: 41, id: 41, location: 'Ѓорче Петров', address: 'Трговски центар К', price: 250,
    bedrooms: 2, sqm: 55, size: '55 м²', service: 'rent', lat: 42.0053, lon: 21.3782 },
  { eb: 42, id: 42, location: 'Центар', address: 'Католичка црква', price: 1000,
    bedrooms: 3, sqm: 126, size: '126 м²', service: 'rent', business: true, lat: 41.9980, lon: 21.4310 },
  { eb: 66, id: 66, location: 'Центар', address: 'Државна болница', price: 149000,
    bedrooms: 3, sqm: 82, size: '82 м²', service: 'buy', lat: 41.9930, lon: 21.4180 },
  { eb: 67, id: 67, location: 'Центар', address: 'Државна болница', price: 190000,
    bedrooms: 2, sqm: 70, size: '70 м²', service: 'buy', lat: 41.9936, lon: 21.4172 },
  { eb: 75, id: 75, location: 'Аеродром', address: 'Фас-Вас', price: 154000,
    bedrooms: 3, sqm: 76, size: '76 м²', service: 'buy', lat: 41.9836, lon: 21.4730 },
  { eb: 82, id: 82, location: 'Аеродром', address: 'Фас-Вас', price: 143000,
    bedrooms: 3, sqm: 77, size: '77 м²', service: 'buy', lat: 41.9838, lon: 21.4735 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

function makeHandler() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    bank: new BankStore(db),
    classifier: new Classifier(llm, cfg, properties),
    responder: new Responder(llm, cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, {
      osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb),
    }),
    enrichment: new EnrichmentStore(db),
  } as never);
  const chatId = 'capture-0443';
  const send = async (m: string) => {
    const before = sent.length;
    await handler.handle('test', chatId, m);
    return { session: sessions.get(chatId)!, reply: sent.slice(before).join('\n') };
  };
  return { send, chatId, sessions };
}

/** How many distinct Евидентен број values a reply puts on the table. */
function ebsIn(text: string): number[] {
  return [...new Set([...text.matchAll(/Евидентен број\s+(\d+)/gu)].map(m => Number(m[1])))];
}

test('[04:46] the distance lane reads «METRA» and a bare «A DO …?» follow-up', () => {
  assert.equal(isDistanceQuestion('48 NA KOLKU METRA E DO SITI MOL ?'), true);
  assert.equal(extractDistancePlace('48 NA KOLKU METRA E DO SITI MOL ?'), 'SITI MOL');
  // The other inflections of the unit must keep working.
  assert.equal(isDistanceQuestion('NA KOLKU METRA E STANOT ?'), true);
  assert.equal(isDistanceQuestion('NA KOLKU МЕТРИ E ?'), true);
  // The follow-up shapes: a destination (either preposition), a cap is not one.
  assert.equal(extractBareDistancePlace('A DO LEPTOKARIJA ?'), 'LEPTOKARIJA');
  assert.equal(extractBareDistancePlace('do siti mol?'), 'siti mol');
  assert.equal(extractBareDistancePlace('A DO 250 EVRA ?'), undefined);
  assert.equal(extractBareDistancePlace('DOBRO'), undefined);
});

test('[04:43] a stock ask asks for the price limit and the rooms before serving', async () => {
  const { send } = makeHandler();
  const first = await send('DAJ MI STO IMA ZA POD KIRIJA KAJ UNIVERZALNA');
  // No dump: nothing is on the table yet, and the turn ASKS.
  assert.deepEqual(ebsIn(first.reply), [], `a stock ask must not dump the book: ${first.reply}`);
  assert.match(first.reply, /\?/u, 'the turn must ask for the missing criteria');
  assert.equal(first.session.slots.service, 'rent');
  // The anchor the client named is kept (Универзална Сала), not dropped.
  assert.equal(first.session.slots.poiAnchor, 'Универзална Сала');

  // With the criteria still unwritten the funnel keeps asking — it must not
  // serve the book in the meantime either.
  const second = await send('STAN');
  assert.deepEqual(ebsIn(second.reply), [], `still no dump before the criteria: ${second.reply}`);
  assert.match(second.reply, /\?/u);

  // A full criteria set is what earns a serve — a PAIR at most, never the book.
  const third = await send('DVE SPALNI');
  const fourth = await send('DO 400 EVRA');
  const served = ebsIn(fourth.reply);
  assert.ok(served.length <= 2, `a pair at most, got ${served.length}: ${fourth.reply}`);
  assert.ok(third.session.slots.budget === 400 || third.session.slots.bedrooms !== undefined);
});

test('[04:46] EB 48 measures to Сити Мол, and the follow-up to Лептокарија', async () => {
  const { send } = makeHandler();
  await send('INFOMI ZA 48');
  const first = await send('48 NA KOLKU METRA E DO SITI MOL ?');
  assert.match(first.reply, /Сити Мол/u, `the named place must be the one measured: ${first.reply}`);
  assert.match(first.reply, /(?:метри|километри)/u, `a measured distance is required: ${first.reply}`);
  // The card was already served a turn earlier; the measurement is the answer.
  assert.doesNotMatch(first.reply, /^Станот под Евидентен број 48/u);

  const second = await send('A DO LEPTOKARIJA ?');
  assert.match(second.reply, /Ле[пт]+окарија/iu, `the second place must be measured: ${second.reply}`);
  assert.match(second.reply, /(?:метри|километри)/u, `a measured distance is required: ${second.reply}`);
  assert.doesNotMatch(second.reply, /^Станот под Евидентен број 48/u);
});

test('[04:47] «KAJ DRZAVNA» is the hospital, and the recall serves the flat there', async () => {
  const { send } = makeHandler();
  // A BUY chat: the flow must stay on buy and never re-ask buy/rent.
  const a = await send('BARAM STAN');
  await send('ZA KUPUVANJE');
  const b = await send('TROSOBEN OKOLU 150 000');
  for (const step of [a, b]) {
    assert.doesNotMatch(step.reply, /(?:купување|изнајмување) \?/iu,
      `buy is already written — never re-ask it: ${step.reply}`);
  }
  assert.equal(b.session.slots.service, 'buy');

  const recall = await send('IMASE EDEN STAN TROSOBEN TUKA KAJ DRZAVNA BLISKU');
  // The place is the hospital complex, never the pet shop named after it.
  assert.equal(recall.session.slots.poiAnchor, 'Клинички центар');
  assert.match(recall.reply, /66/u, `the flat near Државна is EB 66: ${recall.reply}`);
  // No rent dump, no business premise dressed as an apartment.
  assert.doesNotMatch(recall.reply, /под кирија|за изнајмување/iu);
  assert.doesNotMatch(recall.reply, /деловен/u);
  assert.ok(!ebsIn(recall.reply).includes(42), 'a business premise is not an apartment');

  const availability = await send('DALI SE PRODAVA USTE?');
  // The ack pools rotate; the contract is the availability CLAIM („достапен /
  // слободен / активен / на располагање / во базата"), never one adjective.
  assert.match(availability.reply, /достап|слобод|активн|располага|база/u, availability.reply);
  assert.equal(availability.session.slots.propertyId, 66);
  assert.equal(availability.session.slots.service, 'buy');
});
