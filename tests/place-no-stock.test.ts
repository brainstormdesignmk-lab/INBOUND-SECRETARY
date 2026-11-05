/**
 * A PLACE THE MAP KNOWS, WITH NOTHING WITHIN ONE KILOMETRE — what Lina serves.
 *
 *   [client] ZDRAVO SAKAM DA KUPAM STAN BLISKU DO BUNJAKOVEC
 *   [client] EDNA SPALNA
 *   [client] DO 120000
 *   [ЛИНА  ] Во моментов немам недвижност во непосредна близина на Буњаковец
 *            (до 1 km) — најблиску што имам е на 3,2 km. Сакате ли да Ви
 *            покажам нешто подалеку во истата населба, или да погледнеме во
 *            друга населба?
 *
 * THE OWNER'S [23:29] RULE REPLACED THE OLD DISCLAIMER-SERVE: NEAR is 1 km, and
 * when the stock is outside the ring the turn ASKS the two ways out and WAITS —
 * it does not put the far pair on the table behind a disclaimer (the old shape
 * is kept below as history: «Еве ги најблиските опции во реонот: … 3,2 km …»).
 * The place is still NAMED (never swapped for another town), the distance is
 * still MEASURED (not a vague «далеку»), and the far rows are served only after
 * the client picks a widen.
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
  { eb: 511, id: 511, location: 'Центар', address: 'Ул. Буњаковец 8', price: 112000, bedrooms: 2, sqm: 58, size: '58 м²', service: 'buy', lat: 41.9978, lon: 21.4198 },
  { eb: 512, id: 512, location: 'Центар', address: 'Ул. Буњаковец 12', price: 118000, bedrooms: 2, sqm: 60, size: '60 м²', service: 'buy', lat: 41.9980, lon: 21.4200 },
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

test('stock exists but only kilometres away: the place is named, the distance is measured, the widen is ASKED', async () => {
  const { say, sessions, chatId } = makeHandler(FAR_ROWS, 'no-stock-far');
  await say('ZDRAVO SAKAM DA KUPAM STAN BLISKU DO BUNJAKOVEC');
  await say('EDNA SPALNA');
  const reply = await say('DO 120000');
  const s = sessions.get(chatId)!;

  // 1. the place is named in the honesty sentence
  assert.match(reply, /немам недвижност во непосредна близина на Буњаковец/u,
    `the absence is stated about the place he named: ${reply}`);
  // 2. the ring is the owner's number, and the distance is MEASURED
  assert.match(reply, /\(до 1 km\)/u, `the one-kilometre ring is stated: ${reply}`);
  assert.match(reply, /најблиску што имам е на [\d.,]+\s*(?:km|км|метри)/u,
    `the nearest option comes with its distance: ${reply}`);
  assert.match(reply, /3,2\s*(?:km|км)/iu, `the real distance (≈3.2 km): ${reply}`);
  // 3. BOTH ways out, as ONE question — and the choice is the client's
  assert.match(reply, /истата населба/u, `the same-naselba option is offered: ${reply}`);
  assert.match(reply, /друга населба/u, `the other-neighbourhoods option is offered: ${reply}`);
  // 4. NOTHING is served: the far rows are not the answer to «близу до X»
  assert.doesNotMatch(reply, /Евидентен број 50[12]/u, `no far card rides the ask: ${reply}`);
  assert.equal(s.slots.poiTooFarAsk, true, `the ring question is open: ${reply}`);
  assert.equal(s.state, 'presentation', `the funnel stays where it is: ${reply}`);
});

test('the widen pick serves the far pair, with its measured distance', async () => {
  const { say } = makeHandler(FAR_ROWS, 'no-stock-far-pick');
  await say('ZDRAVO SAKAM DA KUPAM STAN BLISKU DO BUNJAKOVEC');
  await say('EDNA SPALNA');
  await say('DO 120000');
  const reply = await say('PODALEKU VO ISTATA NASELBA');
  assert.match(reply, /Евидентен број 50[12]/u, `the picked widen serves the stock: ${reply}`);
  assert.match(reply, /на 3,2\s*(?:km|км)/iu, `the card keeps its real distance: ${reply}`);
  assert.match(reply, /во истата населба/u, `the opener names the widen the client picked: ${reply}`);
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
