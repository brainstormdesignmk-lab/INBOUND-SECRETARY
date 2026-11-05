/**
 * NEAR IS ONE KILOMETRE — AND BEYOND IT THE FUNNEL ASKS (the owner's [23:29]
 * rule, stated for every type and both markets):
 *
 *   «NEAR means until 1 km from the mentioned landmark / a property distant
 *    1.5 km is not near the landmark. If they are exhausted she may ask to
 *    serve something more distant in the same naselba or change the naselba
 *    to some other. WAIT for the pick, then serve a pair again.»
 *
 * What the capture did instead: three turns in a row served far pairs under a
 * disclaimer («немам во непосредна близина … Еве ги најблиските опции во
 * Центар:»), measured from a school the client had never named («Драга
 * Стојановска»), and «DRUGI» re-served them. The client never got to choose.
 *
 * The contract pinned here:
 *   • nothing in the criteria inside 1 km → the turn NAMES the place, states the
 *     MEASURED distance and asks the ONE binary question — farther in THIS
 *     naselba, or ANOTHER one — with NO cards;
 *   • a card beyond 1 km never rides an anchored pair, even when a near card
 *     leads the same batch (the [23:38] pair at 250 m + 1.8 km);
 *   • the client's pick steers the next pair: «подалеку во истата населба»
 *     keeps the area lock; «друга населба» drops it and serves elsewhere;
 *   • a bare «DRUGI» while the question is open is NOT a pick — it re-asks,
 *     because serving would be the far pair the ring just refused.
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

// Градежен Факултет sits at 42.00013, 21.41868 (the map's own row); the anchor
// derives «Центар» from it, so the pool is area-locked to Центар.
const NEAR: Property = {
  eb: 901, id: 901, location: 'Центар', price: 95000, bedrooms: 3, sqm: 55, size: '55 м²',
  service: 'buy', lat: 42.0015, lon: 21.4210,
};
// ≈1.8 km east, still filed in Центар — the "farther in the SAME naselba" stock.
const FAR_SAME_AREA: Property = {
  eb: 902, id: 902, location: 'Центар', price: 99000, bedrooms: 3, sqm: 60, size: '60 м²',
  service: 'buy', lat: 42.0001, lon: 21.4407,
};
// ≈3.2 km east, Аеродром — the "another naselba" stock, outside the area lock.
const FAR_OTHER_AREA: Property = {
  eb: 903, id: 903, location: 'Аеродром', price: 98000, bedrooms: 3, sqm: 58, size: '58 м²',
  service: 'buy', lat: 42.0001, lon: 21.4567,
};

// A rent row 300 m from the school: it never rides the buy search, but it is
// what tells the map which naselba the place sits in (areaAtPlace reads the
// feed's own rows around the pin), so the area lock the widen works against
// exists exactly as it does in production.
const AREA_ANCHOR_ROW: Property = {
  eb: 900, id: 900, location: 'Центар', price: 300, bedrooms: 3, sqm: 50, size: '50 м²',
  service: 'rent', lat: 42.0010, lon: 21.4200,
};

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

/** The intake the [23:27] capture used: a flat, buy, two rooms, up to 120.000. */
async function intake(say: (m: string) => Promise<string>): Promise<string> {
  await say('ZDRAVO SAKAM DA KUPAM STAN KAJ GRADEZEN FAKULTET');
  return say('DVE SPALNI DO 120000');
}

test('nothing inside 1 km: the place, the measured distance and ONE binary question — no cards', async () => {
  const { say, sessions, chatId } = makeHandler([AREA_ANCHOR_ROW, FAR_SAME_AREA, FAR_OTHER_AREA], 'ring-ask');
  const answer = await intake(say);
  const s = sessions.get(chatId)!;

  assert.equal(s.slots.poiAnchor, 'Градежен Факултет', `the place stays the anchor: ${s.slots.poiAnchor}`);
  assert.equal(s.slots.poiTooFarAsk, true, `the ring question is open: ${answer}`);
  assert.equal(s.state, 'presentation', `the funnel keeps its state: ${answer}`);
  // The rule is named with its number, so the client knows what "near" meant.
  assert.match(answer, /во непосредна близина на Градежен Факултет/u, `the place is named: ${answer}`);
  assert.match(answer, /\(до 1 km\)/u, `the ring is one kilometre: ${answer}`);
  assert.match(answer, /најблиску што имам е на [\d.,]+ km/u, `the distance is measured: ${answer}`);
  // Both ways out, in one question.
  assert.match(answer, /истата населба/u, `the same-naselba option: ${answer}`);
  assert.match(answer, /друга населба/u, `the other-naselba option: ${answer}`);
  // Nothing was served — the whole point of the ask.
  assert.doesNotMatch(answer, /Евидентен број/u, `no card rides the ring question: ${answer}`);
});

test('a card beyond 1 km never rides an anchored pair, even behind a near card', async () => {
  const { say, sessions, chatId } = makeHandler([NEAR, FAR_SAME_AREA], 'ring-per-card');
  const answer = await intake(say);
  const s = sessions.get(chatId)!;
  assert.ok(!s.slots.poiTooFarAsk, `near stock exists, so no ask: ${answer}`);
  assert.match(answer, /Евидентен број 901/u, `the near flat is served: ${answer}`);
  assert.doesNotMatch(answer, /Евидентен број 902/u,
    `the 1,8 km flat is NOT "близу до Градежен Факултет": ${answer}`);
});

test('«подалеку во истата населба» serves the far pair INSIDE the same naselba', async () => {
  const { say, sessions, chatId } = makeHandler([AREA_ANCHOR_ROW, FAR_SAME_AREA, FAR_OTHER_AREA], 'ring-area');
  await intake(say);
  const answer = await say('PODALEKU VO ISTATA NASELBA');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.poiWidenScope, 'area', `the pick is remembered: ${answer}`);
  assert.equal(s.slots.poiTooFarAsk, undefined, `the question is spent: ${answer}`);
  assert.match(answer, /Евидентен број 902/u, `the same-naselba stock is served: ${answer}`);
  assert.doesNotMatch(answer, /Евидентен број 903/u, `another naselba is not this answer: ${answer}`);
  assert.match(answer, /во истата населба/u, `the opener names the widen it used: ${answer}`);
});

test('«друга населба» drops the area lock and serves elsewhere', async () => {
  const { say, sessions, chatId } = makeHandler([AREA_ANCHOR_ROW, FAR_SAME_AREA, FAR_OTHER_AREA], 'ring-city');
  await intake(say);
  const answer = await say('DAJ VO DRUGA NASELBA');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.poiWidenScope, 'city', `the pick is remembered: ${answer}`);
  assert.equal(s.slots.location, undefined, `the old area lock is released: ${answer}`);
  assert.match(answer, /Евидентен број 903/u, `the other-naselba stock is served: ${answer}`);
  assert.doesNotMatch(answer, /Евидентен број 902/u, `the old naselba is not this answer: ${answer}`);
  assert.match(answer, /во друга населба/u, `the opener names the widen it used: ${answer}`);
});

test('a bare «DRUGI» while the ring question is open re-asks — it is not a widen pick', async () => {
  const { say, chatId, sessions } = makeHandler([AREA_ANCHOR_ROW, FAR_SAME_AREA, FAR_OTHER_AREA], 'ring-drugo');
  await intake(say);
  const answer = await say('DRUGI');
  assert.match(answer, /истата населба/u, `the same question stands: ${answer}`);
  assert.doesNotMatch(answer, /Евидентен број/u, `no far card is smuggled in: ${answer}`);
  assert.equal(sessions.get(chatId)!.slots.poiWidenScope, undefined, `nothing was picked: ${answer}`);
});
