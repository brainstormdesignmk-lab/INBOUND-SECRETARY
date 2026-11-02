/**
 * THE [22:34] CAPTURE — an area NAMED IN A SEARCH ANSWER is a location, not
 * area advice.
 *
 *   [22:34] sakam da kupam stance vo aerodrom
 *   [22:34] ЛИНА [без LLM]: 1. Колку спални соби … 2. Која е максималната цена …
 *   [22:34] dvosoben stan do 100000 vo reon kaj biser i kapitol mol
 *   [22:34] ЛИНА [deterministic:fast]: Сите локации имаат сопствени погодности.
 *           За да можам да Ви дадам вистинска препорака, би сакала да знам дали
 *           за Вас е поважна близината до центарот, тивкиот крај или
 *           попристапната цена?
 *
 * The turn carried EVERY criterion the funnel had just asked for (двособен =
 * 2 rooms, до 100000, and the geography: «во реон кај Бисер и Капитол»), and
 * the answer was the generic neighborhood-preference paragraph. NEIGHBORHOOD
 * ASK's bare area nouns («населба», «кварт», «реон», «area»…) fired on the
 * word «реон» alone — a search that NAMES an area is not a question about
 * areas, and the place after «кај» is exactly the anchor the serve ranks by.
 *
 * The contract: such a message reaches the funnel, its criteria land in the
 * slots, and the flats nearest TC Бисер / Капитол in Аеродром are served.
 * Genuine area advice («дали е добра населбата Аеродром?») keeps its lane.
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
import { detectNeighborhoodAsk } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// The live map's «Biser Shopping Center» (41.9849838, 21.4656569) — TC Капитол
// stands ~130 m away, both in Аеродром's Ново Лисиче side.
const MALL = { lat: 41.9849838, lon: 21.4656569 };

const ROWS: Property[] = [
  // 120 m from the mall — the flat the capture was asking for.
  { eb: 601, id: 601, location: 'Аеродром', address: 'Ул. Ново Лисиче 4', price: 96000, bedrooms: 2, sqm: 58, size: '58 м²', service: 'buy', lat: MALL.lat + 0.0008, lon: MALL.lon + 0.0004 },
  // 400 m away, same profile — the second card of the pair.
  { eb: 602, id: 602, location: 'Аеродром', address: 'Ул. Ново Лисиче 18', price: 99000, bedrooms: 2, sqm: 61, size: '61 м²', service: 'buy', lat: MALL.lat - 0.0035, lon: MALL.lon + 0.0012 },
  // In Аеродром but ~2.4 km west, and cheaper: the anchor outranks price.
  { eb: 603, id: 603, location: 'Аеродром', address: 'Ул. Јане Сандански 20', price: 79000, bedrooms: 2, sqm: 55, size: '55 м²', service: 'buy', lat: 41.9870, lon: 21.4390 },
  // A 3-room flat AT the mall — in budget, but not the size he asked for.
  { eb: 604, id: 604, location: 'Аеродром', address: 'Ул. Ново Лисиче 8', price: 99000, bedrooms: 3, sqm: 72, size: '72 м²', service: 'buy', lat: MALL.lat + 0.0005, lon: MALL.lon + 0.0002 },
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
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
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

const CRITERIA = 'dvosoben stan do 100000 vo reon kaj biser i kapitol mol';

test('a search answer that names an area is not the area-advice lane', () => {
  assert.equal(detectNeighborhoodAsk(CRITERIA), false,
    'criteria + a named place is a SEARCH, never the neighborhood-preference paragraph');
  // Same family, another spelling: the area noun is not a question here either.
  assert.equal(detectNeighborhoodAsk('SAKAM STAN VO NASAELBA KARPOS DO 90000'), false,
    '«населба» inside a search answer does not make it area advice');
  // Genuine area advice keeps the lane.
  assert.equal(detectNeighborhoodAsk('DALI E DOBRA NASELBATA AERODROM ZA ZIVEEЊE?'), true,
    'a question about living in an area is still area advice');
  assert.equal(detectNeighborhoodAsk('VO KOJA NASELBA IMA NAJDOBRI STANOVI?'), true,
    'the which-area-is-best ask keeps its lane');
});

test('the bare place answer to «во кој дел?» is a location, never the area paragraph', async () => {
  // The same capture one criterion earlier: the client answers the funnel with
  // the place alone («во реон кај Бисер и Капитол») — no rooms, no price. The
  // area-advice paragraph is wrong here too: the words ARE the location slot,
  // and the funnel must move on to the criteria it still misses.
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return;
  const { say, sessions, chatId } = makeHandler('capture-2234-place-only');
  await say('sakam da kupam stance');
  const reply = await say('vo reon kaj biser i kapitol mol');
  const s = sessions.get(chatId)!;
  assert.ok(s.slots.poiAnchor, 'the place is the location answer');
  assert.doesNotMatch(reply, /Сите локации имаат сопствени погодности|поважна близината до центарот|тивкиот крај/iu,
    `a named place is never answered with the generic area paragraph: ${reply}`);
  assert.match(reply, /спалн|spaln/iu, `the funnel asks what is still missing: ${reply}`);
});

test('[22:34] the criteria turn serves the flats nearest TC Бисер / Капитол', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return; // no live map on this machine — pinned in offlineMap.test.ts
  const { say, sessions, chatId } = makeHandler('capture-2234');

  await say('sakam da kupam stance vo aerodrom');
  const s0 = sessions.get(chatId)!;
  assert.equal(s0.slots.service, 'buy');
  assert.equal(s0.slots.location, 'Аеродром');

  const reply = await say(CRITERIA);
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.bedrooms, 2, `двособен is the room count the funnel asked for, got ${s.slots.bedrooms}`);
  assert.equal(s.slots.budget, '100000');
  assert.ok(s.slots.poiAnchor, 'the place after «кај» is the anchor');
  assert.equal(s.state, 'presentation', `the criteria are complete — she serves: ${reply}`);

  assert.doesNotMatch(reply, /Сите локации имаат сопствени погодности|поважна близината до центарот|тивкиот крај/iu,
    `the generic area paragraph must never answer a completed search: ${reply}`);
  assert.match(reply, /Евидентен број 601/u, `the flat nearest the mall leads: ${reply}`);
  assert.match(reply, /Евидентен број 602/u, `the pair is the two nearest matches: ${reply}`);
  assert.ok(!/Евидентен број 603/u.test(reply),
    `the cheaper Аеродром flat is 2.4 km away — the anchor outranks price: ${reply}`);
  assert.ok(!/Евидентен број 604/u.test(reply),
    `a 3-room flat at the mall is not the двособен he asked for: ${reply}`);
});
