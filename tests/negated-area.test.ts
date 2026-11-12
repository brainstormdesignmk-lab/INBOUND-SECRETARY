// A NEGATED AREA IS THE AREA HE EXCLUDED, NOT THE ONE HE WANTS
// (#1 field capture, 2026-11-12).
//
//   [08:46] ГЛЕДАВ ЕДНА КУЌА КАЈ ВАС НА САЈТ ЗА ИЗДАВАЊЕ
//   [08:47] ИМАШЕ ДОБРА ЦЕНА И ЛОКАЦИЈА
//   [08:48] КУЌАВА БЕШЕ КАЈ УНИВЕРЗАЛНА НЕ ВО СКОЈЕ СЕВЕР
//   [08:48] КИРИЈАТА БЕШЕ 200 ИЛИ 250 ЕВРА
//
// The client was CORRECTING the bot («not in Скопје Север»), and the denial
// read as a wish: `detectLocation` returned «Скопје Север», the search locked
// to the district he had just ruled out, and every later answer named a
// geography he never asked for. The live session proved it — `slots.location`
// and `slots.poiArea` both held «Скопје Север» while EB 50 (the house he meant,
// near Универзална Сала) is filed under Центар.
//
// The existing negation rule only knew the want-verb family («не сакам
// Карпош»). The preposition family — не/ne (+ ми е, сум, беше …) во/на/кај/кон
// — carries the same reading and had no rule at all.
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
import { setLearnedBank } from '../src/data/responseBank';
import { detectLocation } from '../src/llm/deterministic';

setLearnedBank({
  variants: () => [], addVariant: () => false, addExample: () => false,
  metric: () => {}, retrieve: () => undefined,
} as any);

const cfg = loadConfig();
let offlineMap: OfflineMapStore | undefined;
const map = (): OfflineMapStore => (offlineMap ??= new OfflineMapStore(cfg.skopjePoisDb));

const FEED_AREAS = ['Центар', 'Центар (населба)', 'Скопје Север', 'Чаир', 'Водно', 'Карпош III'];

// ── 1. THE DETECTOR — every negated prepositional shape ──────────────────────

test('detectLocation: «не во Скопје Север» names the area he EXCLUDED', () => {
  // The exact field sentence: the denial trails the place he named.
  assert.equal(detectLocation('КУЌАВА БЕШЕ КАЈ УНИВЕРЗАЛНА НЕ ВО СКОЈЕ СЕВЕР', FEED_AREAS), undefined);
  assert.equal(detectLocation('ne vo skopje sever', FEED_AREAS), undefined);
  assert.equal(detectLocation('не во центар', FEED_AREAS), undefined);
});

test('detectLocation: the copula and auxiliary forms are the same denial', () => {
  for (const text of [
    'не ми е во Скопје Север',
    'не е во Чаир',
    'не сум во Чаир',
    'не беше во Чаир',
    'не сум бил во Чаир',
    'ne sum vo cair',
    'ne bese vo cair',
    'ниту во Чаир',
  ]) {
    assert.equal(detectLocation(text, FEED_AREAS), undefined, `«${text}» is a denial, not an area`);
  }
});

test('detectLocation: «само не во Чаир» excludes it and nothing becomes the area', () => {
  assert.equal(detectLocation('samo ne vo cair', FEED_AREAS), undefined);
  assert.equal(detectLocation('не на Водно', FEED_AREAS), undefined);
  assert.equal(detectLocation('не кај Чаир', FEED_AREAS), undefined);
});

test('detectLocation: a reversal keeps the area he DID name', () => {
  // The denial is bounded by punctuation/reversal words — the affirmed half
  // survives, in either order.
  assert.equal(detectLocation('НЕ ВО СКОПЈЕ СЕВЕР АМА ВО ЦЕНТАР', FEED_AREAS), 'Центар (населба)');
  assert.equal(detectLocation('ne sum vo cair, vo vodno sum', FEED_AREAS), 'Водно');
  assert.equal(detectLocation('ne vo cair ama vo karpos 3', FEED_AREAS), 'Карпош III');
});

test('detectLocation: an affirmation is untouched (no over-negation)', () => {
  assert.equal(detectLocation('BARAM STAN VO CENTAR', FEED_AREAS), 'Центар (населба)');
  assert.equal(detectLocation('СТАН ВО ЦЕНТАР НЕ Е СКАП', FEED_AREAS), 'Центар (населба)');
  assert.equal(detectLocation('ми треба стан во Чаир', FEED_AREAS), 'Чаир');
});

// ── 2. THE TURN — the field conversation end to end ──────────────────────────

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// The two houses the field chat was about: EB 50 is the one he meant (Центар,
// «помеѓу Универзална сала и Треска»), EB 62 the Скопје Север house that the
// negated mention wrongly put on the table.
const C50: Property = {
  eb: 50, id: 50, uuid: 'c50', address: 'Христо Смирненски 41', location: 'Центар',
  service: 'rent', house: true, price: 250, sqm: 74, size: '74 м²',
  lat: 41.99621, lon: 21.4144,
} as Property;
const N62: Property = {
  eb: 62, id: 62, uuid: 'n62', address: 'Визбегово', location: 'Скопје Север',
  service: 'rent', house: true, price: 250, sqm: 140, size: '140 м²',
  lat: 42.0210, lon: 21.4510,
} as Property;

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://feed-not-used'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(p => p.eb === eb); }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(p => p.id === id); }
  async locations(): Promise<string[]> { return [...new Set(this.rows.map(r => r.location ?? '').filter(Boolean))]; }
  get healthy(): boolean { return true; }
}

function makeHandler(): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps([C50, N62]);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions,
    classifier: new Classifier(llm, cfg, props),
    responder: new Responder(llm, cfg),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: map() }),
  });
  return { handler, sessions, sent };
}

test('e2e recall: a denied area is not the area the archive recall is anchored at', async () => {
  // THE RECALL LANE READS AREAS THROUGH ITS OWN DOOR (`areaNamed` scans the
  // literal spans of the message), so the same denial must hold there too: the
  // recalled listing is at Универзална, never in the district he ruled out.
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'field-0848-recall';
  await handler.handle('test', chatId, 'ИМАВТЕ ЕДНА КУЌА КАЈ УНИВЕРЗАЛНА НЕ ВО СКОПЈЕ СЕВЕР, КИРИЈАТА БЕШЕ 250 ЕВРА');
  const s = sessions.get(chatId)!;
  assert.notEqual(s.slots.location, 'Скопје Север',
    `the recall took the denied district: ${JSON.stringify(s.slots.location)}`);
  assert.notEqual(s.slots.poiArea, 'Скопје Север');
  assert.ok(!sent.some(m => m.includes('Скопје Север')),
    `the recall must not name the excluded district: ${sent.join(' | ')}`);

  // The same denial with NO place beside it: the LITERAL span path is the only
  // reader left, and it must honour the negation too.
  const bareChat = 'field-0848-recall-bare';
  await handler.handle('test', bareChat, 'ИМАВТЕ ЕДНА КУЌА НЕ ВО СКОПЈЕ СЕВЕР, КИРИЈАТА БЕШЕ 250 ЕВРА');
  const bare = sessions.get(bareChat)!;
  assert.notEqual(bare.slots.location, 'Скопје Север',
    `the bare denial became the area: ${JSON.stringify(bare.slots.location)}`);
});

test('e2e [08:48]: «кај Универзална НЕ ВО СКОЈЕ СЕВЕР» leaves no Скопје Север anywhere', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'field-0848';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ГЛЕДАВ ЕДНА КУЌА КАЈ ВАС НА САЈТ ЗА ИЗДАВАЊЕ');
  await send('ИМАШЕ ДОБРА ЦЕНА И ЛОКАЦИЈА');
  let s = await send('КУЌАВА БЕШЕ КАЈ УНИВЕРЗАЛНА НЕ ВО СКОЈЕ СЕВЕР');

  // The denial is not a location, in either slot the search reads.
  assert.notEqual(s.slots.location, 'Скопје Север',
    `the denied area must never become the search's area: ${JSON.stringify(s.slots.location)}`);
  assert.notEqual(s.slots.poiArea, 'Скопје Север');
  // …and it never reaches the copy (the operator's «invented area» report).
  assert.ok(!sent.some(m => m.includes('Скопје Север')),
    `no reply may name the area he ruled out: ${sent.join(' | ')}`);

  // The price he remembers then finds the house he MEANT — EB 50, in Центар.
  s = await send('КИРИЈАТА БЕШЕ 200 ИЛИ 250 ЕВРА');
  const last = sent[sent.length - 1];
  assert.ok(/50/u.test(last), `the house he meant is EB 50, got: ${last}`);
  assert.ok(!last.includes('Скопје Север'), `the Скопје Север house is not his: ${last}`);
  assert.ok(s.slots.currentBatch?.includes(50) || s.slots.propertyId === 50 || s.slots.interestedPropertyId === 50,
    `EB 50 must be the property in play: ${JSON.stringify({ batch: s.slots.currentBatch, id: s.slots.propertyId, interest: s.slots.interestedPropertyId })}`);
});
