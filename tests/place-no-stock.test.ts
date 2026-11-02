/**
 * A PLACE THE MAP KNOWS, WITH NOTHING WITHIN REACH — what Lina serves.
 *
 *   [client] ZDRAVO SAKAM DA KUPAM STAN BLISKU DO BUNJAKOVEC
 *   [client] EDNA SPALNA
 *   [client] DO 120000
 *   [ЛИНА  ] Во моментов немам недвижност во непосредна близина на Буњаковец.
 *            Еве ги најблиските опции во реонот:  … 3,2 km од Буњаковец …
 *
 * The same rule as [23:26]: the client named a place and the search must stay
 * honest about it. The stock is 3.2 km away, so the answer is three facts and
 * one offer —
 *   1. the place is NAMED (never silently swapped for another town),
 *   2. the MEASURED distance to the nearest option (not a vague «далеку»),
 *   3. the districts the cards actually come from (the old line said «во
 *      реонот» while the cards sat in Аеродром and the anchor had no feed area),
 *   4. the widen offered as a statement, so the message keeps ONE question.
 * The far rows are an explicit ALTERNATIVE — never presented as the answer to
 * «близу до X».
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
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

// Буњаковец (Центар) is the place; these flats sit ~3.2 km east in Аеродром.
const FAR_ROWS: Property[] = [
  { eb: 501, id: 501, location: 'Аеродром', address: 'Ул. Јане Сандански 20', price: 112000, bedrooms: 2, sqm: 58, size: '58 м²', service: 'buy', lat: 41.9800, lon: 21.4500 },
  { eb: 502, id: 502, location: 'Аеродром', address: 'Ул. Јане Сандански 44', price: 118000, bedrooms: 2, sqm: 60, size: '60 м²', service: 'buy', lat: 41.9812, lon: 21.4512 },
];

// The same criteria, but 100 m from the place: the honesty line must NOT fire.
const NEAR_ROWS: Property[] = [
  { eb: 511, id: 511, location: 'Центар', address: 'Ул. Буњаковец 8', price: 112000, bedrooms: 2, sqm: 58, size: '58 м²', service: 'buy', lat: 41.9960, lon: 21.4360 },
  { eb: 512, id: 512, location: 'Центар', address: 'Ул. Буњаковец 12', price: 118000, bedrooms: 2, sqm: 60, size: '60 м²', service: 'buy', lat: 41.9962, lon: 21.4358 },
];

function makeHandler(rows: Property[], id: string) {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(rows);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent[sent.length - 1] ?? '';
  };
  return { say, sessions, chatId: id };
}

test('stock exists but only kilometres away: the place is named, the distance is measured, the widen is offered', async () => {
  const { say, sessions, chatId } = makeHandler(FAR_ROWS, 'no-stock-far');
  await say('ZDRAVO SAKAM DA KUPAM STAN BLISKU DO BUNJAKOVEC');
  await say('EDNA SPALNA');
  const reply = await say('DO 120000');
  const s = sessions.get(chatId)!;

  assert.equal(s.state, 'presentation', `the paired criteria serve: ${reply}`);
  assert.equal(s.slots.poiAnchor, 'Буњаковец', `the place stays the anchor, got ${s.slots.poiAnchor}`);
  // 1. the place is named in the honesty sentence
  assert.match(reply, /немам недвижност во непосредна близина на Буњаковец/u,
    `the absence is stated about the place he named: ${reply}`);
  // 2. the distance is MEASURED, not vague
  assert.match(reply, /најблиску што имам е на \d+([.,]\d+)?\s*(?:km|км|метри)/u,
    `the nearest option comes with its distance: ${reply}`);
  assert.match(reply, /3,2\s*(?:km|км)/iu, `the real distance (≈3.2 km): ${reply}`);
  // 3. the district the cards are actually in — never the old «во реонот»
  assert.match(reply, /во Аеродром/u, `the cards' own district is named: ${reply}`);
  assert.doesNotMatch(reply, /во реонот/u, `no vague district: ${reply}`);
  // 4. the widen, as a statement the funnel can act on
  assert.match(reply, /друга населба/u, `the other-neighbourhoods option is offered: ${reply}`);
  // The far rows are an alternative — the cards are there, and the honesty line
  // leads them instead of a proximity claim.
  assert.match(reply, /Евидентен број 501/u, `the nearest option is served: ${reply}`);
  assert.ok(reply.indexOf('немам недвижност') < reply.indexOf('501'),
    `the honesty line comes FIRST: ${reply}`);
  assert.doesNotMatch(reply, /Еве ги најблиските опции до Буњаковец/u,
    `never the in-reach opener over far cards: ${reply}`);
});

test('stock within reach keeps the plain anchored opener — no absence line', async () => {
  const { say, sessions, chatId } = makeHandler(NEAR_ROWS, 'no-stock-near');
  await say('ZDRAVO SAKAM DA KUPAM STAN BLISKU DO BUNJAKOVEC');
  await say('EDNA SPALNA');
  const reply = await say('DO 120000');
  assert.equal(sessions.get(chatId)!.state, 'presentation', reply);
  assert.match(reply, /Еве ги најблиските опции до Буњаковец/u, `the anchored opener: ${reply}`);
  assert.doesNotMatch(reply, /немам недвижност/u, `nothing absent when stock is near: ${reply}`);
  assert.match(reply, /Евидентен број 51[12]/u, `the near pair is served: ${reply}`);
});
