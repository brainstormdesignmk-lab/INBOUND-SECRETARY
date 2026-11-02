/**
 * THE [00:11]–[00:15] CAPTURE — the railway words, the two places, and the info ask.
 *
 *   [00:11] ZDRAVO DAKAM DA KUPAM STAN DO ZELEXNICKA , SKOPJANKA
 *   [00:12] STO IMATE DOSTAPNO VO MOMENTOV ?
 *   [00:12] Лина: «Имам три недвижности близу Железничка Зграда» …   ← the wrong row
 *   [00:13] «Имам две недвижности близу Железничка станица Скопје» — both around one
 *   [00:15] DAJ MI INFO ZA 91
 *   [00:15] Лина: «Би требало да е сеуште достапен.»               ← availability
 *
 * Three contracts:
 *   1. «железничка» ALONE is the operating station (Железничка станица
 *      Скопје) — never «Железничка Зграда», the row the fuzzy pass returned.
 *   2. «стара железничка» — the words a Skopjan uses for the OLD building —
 *      pins to «Стара Железничка Станица», and is searched as that place.
 *   3. Two places in one ask are served ONE CARD EACH, in the documented
 *      cycle (1/2 first), each card stating its distance to its OWN place.
 *   4. «DAJ MI INFO ZA <eb>» is a request for the flat's FACTS (the card), not
 *      an availability question — no «Би требало да е сеуште достапен».
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

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

const cfg = loadConfig();
// Real pins, so the pair is measured against the shipped map:
//   Железничка станица Скопје  41.9909627, 21.445889
//   ТЦ Скопјанка               41.9891272, 21.4506228
const ROWS: Property[] = [
  // ~15 m from the station.
  { eb: 91, id: 91, location: 'Центар', price: 178000, bedrooms: 3, sqm: 71, size: '71 м²',
    service: 'buy', lat: 41.9911, lon: 21.4461, floor: 5, totalFloors: 9,
    features: ['лифт', 'греење на струја'],
    details: 'Трисобен стан, на петти кат, со лифт.' },
  // ~40 m from ТЦ Скопјанка.
  { eb: 75, id: 75, location: 'Центар', price: 154000, bedrooms: 3, sqm: 76, size: '76 м²',
    service: 'buy', lat: 41.9890, lon: 21.4503, features: ['парно'] },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string, rows: Property[] = ROWS) {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(rows)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(rows),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  const chatId = id;
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId, sent };
}

test('bare «ZELEXNICKA» is the operating station, not the «Железничка Зграда» row', async () => {
  const { say, sessions, chatId } = makeHandler('zel-bare');
  await say('ZDRAVO SAKAM DA KUPAM STAN BLISKU DO ZELEXNICKA');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.poiAnchor, 'Железничка станица Скопје',
    `one word is the station Skopjani mean: ${s.slots.poiAnchor}`);
  assert.notEqual(s.slots.poiAnchor, 'Железничка Зграда');
});

test('«STARA ZELEZNICKA» is pinned to the OLD building and searched there', async () => {
  const { say, sessions, chatId } = makeHandler('zel-stara');
  await say('DAJ MI PONUDI OKOLU STARA ZELEZNICKA');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.poiAnchor, 'Стара Железничка Станица',
    `the qualifier selects the old building: ${s.slots.poiAnchor}`);
  assert.notEqual(s.slots.poiAnchor, 'Железничка станица Скопје');
});

test('[00:11] two railway places are served ONE CARD EACH, each with its own distance', async () => {
  const { say, sessions, chatId } = makeHandler('zel-pair');
  await say('ZDRAVO DAKAM DA KUPAM STAN DO ZELEXNICKA , SKOPJANKA');
  assert.deepEqual(sessions.get(chatId)!.slots.poiPlaces?.map(p => p.name),
    ['Железничка станица Скопје', 'ТЦ Скопјанка'],
    'both places the client named are kept, in his order');

  const reply = await say('STO IMATE DOSTAPNO VO MOMENTOV ?');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.currentBatch?.length, 2, `a pair of two cards: ${reply}`);
  const anchors = (s.slots.currentBatch ?? []).map(id => s.slots.pairAnchorOf?.[String(id)]?.name).filter(Boolean);
  assert.deepEqual(anchors, ['Железничка станица Скопје', 'ТЦ Скопјанка'],
    `one card drawn for each place, in order: ${JSON.stringify(anchors)}`);
  assert.match(reply, /Железничка станица Скопје[\s\S]*ТЦ Скопјанка|ТЦ Скопјанка[\s\S]*Железничка станица Скопје/,
    `the opener names both places: ${reply}`);
});

test('[00:15] «DAJ MI INFO ZA 91» answers the FLAT, never its availability', async () => {
  const { say } = makeHandler('zel-info');
  await say('ZDRAVO DAKAM DA KUPAM STAN DO ZELEXNICKA , SKOPJANKA');
  await say('STO IMATE DOSTAPNO VO MOMENTOV ?');
  const reply = await say('DAJ MI INFO ZA 91');

  assert.match(reply, /Евидентен број 91/, `the card he asked for: ${reply}`);
  assert.match(reply, /71 м²/, `the stored surface is the fact he wanted: ${reply}`);
  assert.doesNotMatch(reply, /Би требало да е сеуште достапен/,
    `availability is not an answer to an info ask: ${reply}`);
  assert.doesNotMatch(reply, /Дали сакате да го исконтактирам сопственикот/,
    `no owner-contact turn: ${reply}`);
});
