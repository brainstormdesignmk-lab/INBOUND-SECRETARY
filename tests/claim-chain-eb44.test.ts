// THE [12:26]–[12:35] CHAIN, REBUILT AS A CONTRACT.
//
// The operator's capture, and what the appliance answered on 2026-11-13:
//
//   [12:25] гледав една куќа кај вас на сајт во скопје север
//   [12:26] околу 130000 беше
//           ЛИНА: «Токму во близина на Скопје Север моментално немам
//           недвижност што одговара точно на тие податоци.» … and then it
//           listed EB 44 — the very house, in that very area, at that price.
//   [12:31] дали се продааа уште ?
//           ЛИНА: «Тоа се наоѓа во населбата Скопје Север.»   ← a LOCATION answer
//   [12:31] па зошто уште ја имате во понуда на страницата
//           ЛИНА: the price-freshness disclaimer, and the state moved to closing
//   [12:35] зошто ми кажа дека е стара понуда и дека ја нема веќе ?
//           ЛИНА: the 500-ден visit-fee disclosure
//
// Five rules come out of it, and this file pins them on the REAL pipeline
// (`InboundHandler.handle`, real feed facts, LLM off):
//
//   1. AVAILABILITY IS THE FEED'S COLUMN, not "the row is in our database"
//      (`dostapno_od` — the feed said «Веднаш» over a property the appliance
//      called archived).
//   2. A FILTERED MISS NEVER CLAIMS THE STOCK IS EMPTY — a filter is not a
//      registry, and the [12:26] sentence contradicted itself in one breath.
//   3. AN AVAILABILITY QUESTION IS NEVER ANSWERED AS A LOCATION, in the typed
//      form «дали се продааа уште?» either.
//   4. AN UNRESOLVED SUBJECT IS A QUESTION («за која од двете?»), not a guess
//      between two listed flats.
//   5. A CHALLENGE ABOUT OUR OWN WORDS IS ANSWERED FROM THE TURN RECORD —
//      never by a fee/price script, and never while moving the funnel.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property, mapRow, availabilityOf, pricePerM2 } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { buildAvailabilityClaim } from '../src/llm/prompts';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

/** EB 44 and EB 55 as the live feed held them on the capture day. */
const ROWS: Property[] = [
  {
    eb: 44, id: 44, location: 'Скопје Север', address: 'Скопје Север',
    price: 130000, bedrooms: 4, sqm: 150, service: 'buy', house: true,
    lat: 42.0345, lon: 21.4149, geo_source: 'osm_street_anchor',
    dostapnoOd: 'Веднаш', features: ['парно'],
    details: 'Куќа со двор, 4 собни, во Скопје Север.',
  } as Property,
  {
    eb: 55, id: 55, location: 'Влае', address: 'Влае',
    price: 40000, bedrooms: 3, sqm: 240, service: 'buy', house: true,
    lat: 42.0123, lon: 21.3900, geo_source: 'osm_building',
    dostapnoOd: 'Веднаш',
    details: 'Куќа за реновирање во Влае.',
  } as Property,
  {
    eb: 66, id: 66, location: 'Центар', address: 'Рузвелтова',
    price: 137000, bedrooms: 3, sqm: 79, service: 'buy',
    lat: 41.9965, lon: 21.4315, geo_source: 'osm_building',
    dostapnoOd: 'Веднаш', features: ['лифт', 'парно'],
    details: 'Трособен стан во центар, две спални, две тераси, лифт и парно.',
  } as Property,
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  async getById(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  async getAllEbs(): Promise<Set<number>> { return new Set(this.rows.map(r => r.eb)); }
  get healthy(): boolean { return true; }
}

function makeHandler(): { handler: InboundHandler; sessions: SessionStore; say: (t: string) => Promise<string>; chatId: string } {
  const mapPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claim-chain-')), 'map.db');
  writeMap(mapPath, [], []);
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_chatId, text) => { sent.push(text); } });
  const props = new FakeProps(ROWS);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(mapPath) }),
  });
  const chatId = 'capture-1226';
  sessions.set(freshSession('test', chatId));
  const say = async (text: string): Promise<string> => {
    await handler.handle('test', chatId, text);
    return sent[sent.length - 1] ?? '';
  };
  return { handler, sessions, say, chatId };
}

test('the feed availability column is mapped, and a missing one says so', () => {
  const live = mapRow({ evidenten_broj: 44, adresa: 'Скопје Север', naselba: 'Скопје Север', cena_eur: 130000, dostapno_od: 'Веднаш' });
  assert.ok(live, 'the row maps');
  assert.equal(live!.dostapnoOd, 'Веднаш');
  assert.equal(availabilityOf(live!).kind, 'now');

  const dated = mapRow({ evidenten_broj: 9, adresa: 'X', dostapno_od: '01.12.2026' });
  assert.deepEqual(availabilityOf(dated!), { kind: 'from', when: 'од 01.12.2026' });

  const unknown = mapRow({ evidenten_broj: 8, adresa: 'X' });
  assert.equal(availabilityOf(unknown!).kind, 'unknown');
});

test('[12:35] the availability claim quotes the feed, never «постои во нашата база»', () => {
  const house = ROWS[0]!;
  const claim = buildAvailabilityClaim(house);
  assert.match(claim, /достапна веднаш/u, `the feed's own datum: ${claim}`);
  assert.doesNotMatch(claim, /пост ои|постои во|во нашата база/iu, `no database-provenance claim: ${claim}`);

  const noDatum: Property = { eb: 7, id: 7, address: 'X', price: 1000, sqm: 10 } as Property;
  const honest = buildAvailabilityClaim(noDatum);
  assert.match(honest, /потврдува сопственикот/u, `an absent column hands the confirmation to the owner: ${honest}`);
  assert.doesNotMatch(honest, /веднаш/u, `no invention: ${honest}`);
});

test('[12:26] a filtered miss on a live listing never says «немам недвижност» and never lists the flat it denied', async () => {
  const { say } = makeHandler();
  await say('гледав една куќа кај вас на сајт во скопје север');
  const second = await say('околу 130000 беше');
  assert.ok(second.length > 0, 'the turn must answer');
  // THE CONTRADICTION: an absence claim followed by the very property. The
  // claim may name a DESCRIPTION it did not find, never the stock.
  assert.doesNotMatch(second, /немам недвижност што одговара/iu,
    `the filtered-miss wording is the [12:26] defect: ${second}`);
  if (/немам|нема недвижност/iu.test(second)) {
    assert.match(second, /(точно|таква)/iu,
      `a miss must be about the description, not the stock: ${second}`);
  }
});

test('[12:31] «дали се продааа уште ?» is an availability question, never a location', async () => {
  const { say, sessions, chatId } = makeHandler();
  const s = sessions.get(chatId)!;
  s.state = 'property_locate';
  s.slots.currentBatch = [44, 55];
  s.slots.presentedIds = [44, 55];
  sessions.set(s);
  const reply = await say('дали се продааа уште ?');
  // THE DEFECT: a LOCATION answer. The pre-existing contract decides WHICH flat
  // (the last presented one, §4b) and the answer names its Евидентен број, so a
  // client who meant the other card corrects it in one word — that part is
  // pinned by tests/capture-0706-check-then-visit.test.ts and is NOT changed
  // here. What changes is the LANE: availability is answered as availability.
  assert.doesNotMatch(reply, /населбата/u,
    `a location answer to an availability question is the defect: ${reply}`);
  assert.match(reply, /Евидентен број (?:44|55)/u, `the flat is named: ${reply}`);
  assert.match(reply, /достапн/iu, `availability is stated: ${reply}`);
});

test('[12:31] a challenge about our own listing is answered from the record, not by a price script', async () => {
  const { say, sessions, chatId } = makeHandler();
  // The state the capture was in: the absence claim went out two turns earlier.
  const s = sessions.get(chatId)!;
  s.state = 'closing';
  s.slots.currentBatch = [44, 55];
  s.slots.presentedIds = [44, 55];
  s.recentTurns = [{
    at: Date.now() - 60_000, chatId, channel: 'test', text: 'околу 130000 беше',
    stateBefore: 'property_locate', stateAfter: 'property_locate', lanes: [],
    facts: [], replies: ['Токму во близина на Скопје Север моментално немам недвижност што одговара точно на тие податоци. Евидентен број 44 — куќа, во Скопје Север, 150 м², 130.000 евра.'],
  }];
  sessions.set(s);

  const reply = await say('па зошто уште ја имате во понуда на страницата');
  assert.doesNotMatch(reply, /последната цена|price\.freshness|последната евидентирана цена/iu,
    `the price-freshness disclaimer is the [12:31] defect: ${reply}`);
  assert.doesNotMatch(reply, /500\s*денари/u, `never a fee script: ${reply}`);
  // THE CORRECTION IS ABOUT EB 44 — the flat the offending sentence named, not
  // the tail of the batch.
  assert.match(reply, /Евидентен број 44/u, `the challenged flat is the subject: ${reply}`);
  assert.match(reply, /(не беше точн|разјаснам)/iu, `an explanation is owed: ${reply}`);
  assert.equal(sessions.get(chatId)!.state, 'closing',
    'an explanation never moves the funnel');
});

test('[12:35] «зошто ми кажа дека е стара понуда…» is answered honestly, never with the visit fee', async () => {
  const { say, sessions, chatId } = makeHandler();
  const s = sessions.get(chatId)!;
  s.state = 'closing';
  s.slots.propertyId = 44;
  s.slots.interestedPropertyId = 44;
  s.slots.feeDisclosed = true;      // the fee is already on the table — the
  s.slots.ownerContactPending = true; // arms that swallowed the question
  sessions.set(s);

  const reply = await say('зошто ми кажа дека е стара понуда и дека ја нема веќе ?');
  assert.doesNotMatch(reply, /500\s*денари|денари \(10 евра\)/u,
    `the fee disclosure answering an explanation request is the [12:35] defect: ${reply}`);
  assert.match(reply, /Евидентен број 44/u, `the flat is named: ${reply}`);
  assert.match(reply, /достапн/iu, `availability is stated from the feed: ${reply}`);
  // AUDIT: the record of the turn is what answered, and it says which turn it
  // was explaining.
  const lastTurn = sessions.get(chatId)!.lastTurn;
  assert.ok(lastTurn?.facts.some(f => f.startsWith('subject=44')), `the subject is audited: ${lastTurn?.facts.join(',')}`);
});

test('[13:16] «kolku bi mu dosla cenata po kvadrat?» is the flat\'s arithmetic, not the district band', async () => {
  const { say, sessions, chatId } = makeHandler();
  const s = sessions.get(chatId)!;
  s.slots.propertyId = 66;
  s.slots.interestedPropertyId = 66;
  s.slots.currentBatch = [66];
  s.slots.presentedIds = [66];
  sessions.set(s);

  const reply = await say('KOLKU BI MU DOSLA CENATA PO KVADRAT ?');
  const rate = pricePerM2(ROWS[2]!)!;
  assert.match(reply, /1\.734/u, `137.000 / 79 м² = ${rate}: ${reply}`);
  assert.doesNotMatch(reply, /1\.286|2\.889|варираат/iu,
    `the district band is the [13:16] defect: ${reply}`);
  assert.equal(sessions.get(chatId)!.state, 'idle',
    'a factual answer does not move the funnel');
});
