/**
 * THE [04:05]–[04:28] CAPTURE — four turns, four defects, one contract each.
 *
 *   [04:05] STO TI E TOA NA 1.4KM ?
 *           ЛИНА [deterministic:place-ring]: «… немам недвижност во непосредна
 *           близина на ТЦ Скопјанка (до 1 km) — најблиску што имам е на 1,4 km.
 *           Сакате ли…?» — the SAME paragraph again.
 *           The ring line states a MEASURED distance and serves nothing, so the
 *           client asks WHICH flat stands there. The row is known (the ring was
 *           computed on it); the turn repeated the paragraph instead, then
 *           hallucinated («точните детали … ги немам») on the same row.
 *
 *   [04:12] KOJ STAN SE NAOGJA NA 1.4KM OD SKOPJANKA ? / KOJ E TOJ STAN ?
 *           the same repeat, then a model invention; and «1.4KM» silently moved
 *           the room criterion from трисобен to двособен («една» read out of a
 *           decimal).
 *
 *   [04:14] IMASE EDEN STAN KAJ VAS VO MADJAR MAALO SO DVE SPALNI …
 *           DALI GO IMATE USTE ?
 *           «Разбрав — значи баравте стан во близина на Фас-Вас (Аеродром)» —
 *           «кај вас» (at YOUR place) was read as the car-parts shop «Фас-Вас»,
 *           an anchor from a previous turn rang its own 1 km ring, and Аеродром
 *           cards answered a Маџар Маало question.
 *
 *   [04:18] OPISETE MI GO 91 … [04:19] NA KOJA ULICA E ?
 *           the description was answered with EB 47's card (the flat under
 *           discussion, not the one he named), and the address with EB 47's
 *           landmark.
 *
 *   [04:28] AJDE PROVERI DALI SE PRODAVA USTE PA KE SE DOGOVORIME
 *           «Би требало да е сеуште достапен. Дали сакате да го исконтактирам
 *           сопственикот…?» — he had JUST said the arrangement follows (a yes in
 *           any reading of it), and the funnel asked the same consent question
 *           again instead of taking his name and number.
 *
 * The fixtures are the capture's own rows; the map is the shipped offline DB.
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
import { detectBedrooms, detectProceedAfterCheck, detectRingNearestAsk } from '../src/llm/deterministic';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// THE RING FIXTURE (one row, ~1,5 km from ТЦ Скопјанка at 41.98873,21.44992).
// Маџар Маало genuinely sits ~700 m from that mall, so the ring test and the
// area test must NOT share a pool — a second row inside the ring would answer
// the ring question and the test would pass for the wrong reason.
const RING_ROWS: Property[] = [
  // трисобен (the room count «DVE SPALNI» asks for), 1,5 km from the mall.
  { eb: 70, id: 70, location: 'Центар', address: 'Скопјанка', price: 88000, bedrooms: 3, sqm: 60,
    size: '60 м²', service: 'buy', lat: 42.0000, lon: 21.4600 } as Property,
];

const ROWS: Property[] = [
  // ~1,5 km from ТЦ Скопјанка (41.98873,21.44992) — the ring's nearest row.
  { eb: 70, id: 70, location: 'Центар', address: 'Скопјанка', price: 88000, bedrooms: 2, sqm: 55,
    size: '55 м²', service: 'buy', lat: 42.0000, lon: 21.4600 } as Property,
  // Аеродром, anchored at Фас-Вас by an earlier turn.
  { eb: 75, id: 75, location: 'Аеродром', address: 'Фас-Вас', price: 154000, bedrooms: 3, sqm: 76,
    size: '76 м²', service: 'buy', lat: 41.9836, lon: 21.4730 } as Property,
  { eb: 82, id: 82, location: 'Аеродром', address: 'Фас-Вас', price: 143000, bedrooms: 3, sqm: 77,
    size: '77 м²', service: 'buy', lat: 41.9838, lon: 21.4735 } as Property,
  // The Маџар Маало pair the [04:14] recall is about.
  { eb: 60, id: 60, location: 'Маџар Маало', address: 'Маџар Маало', price: 95000, bedrooms: 2,
    sqm: 60, size: '60 м²', service: 'buy', lat: 41.9946, lon: 21.4456 } as Property,
  { eb: 61, id: 61, location: 'Маџар Маало', address: 'Маџар Маало', price: 122000, bedrooms: 3,
    sqm: 74, size: '74 м²', service: 'buy', lat: 41.9950, lon: 21.4460 } as Property,
  // The two Център flats of the describe/address pair.
  { eb: 91, id: 91, location: 'Центар', address: 'Апарт Хотел Соларис', price: 178000, bedrooms: 2,
    sqm: 71, size: '71 м²', service: 'buy', lat: 41.9945, lon: 21.4345,
    details: 'Две спални соби, дневна кујна-трпезарија и тераса. Лифт. Подземно паркинг место со доплата.' } as Property,
  { eb: 47, id: 47, location: 'Центар', address: 'Партизански', price: 150500, bedrooms: 2, sqm: 59,
    size: '59 м²', service: 'buy', lat: 41.9886, lon: 21.4302 } as Property,
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(p => p.id === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(p => p.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(chatId: string, rows: Property[] = ROWS) {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const props = new FakeProps(rows);
  const llm = new FailingLlm() as never;
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(llm, cfg, props),
    responder: new Responder(llm, cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  const say = async (m: string): Promise<string> => {
    const before = sent.length;
    await handler.handle('test', chatId, m);
    return sent.slice(before).join('\n');
  };
  return { say, sessions, chatId };
}

// ── the predicates ─────────────────────────────────────────────────────────

test('[04:05] a distance and a deictic are the ring row, not a bedroom count', () => {
  for (const t of [
    'STO TI E TOA NA 1.4KM ?',
    'KOJ STAN SE NAOGJA NA 1.4KM OD SKOPJANKA ?',
    'KOJ E TOJ STAN ?',
    'ШТО Е ТОА СТАНОТ ?',
    'KADE E TOJ STAN ?',
  ]) assert.equal(detectRingNearestAsk(t), true, `the identity ask must fire: ${t}`);
  for (const t of [
    'DA',                                  // the widen answer
    'PODALEKU VO ISTATA NASELBA',
    'NA KOJA ULICA E ?',                   // the address ladder
    'DAJ MI NESTO POSKAPO',
  ]) assert.equal(detectRingNearestAsk(t), false, `over-eager: ${t}`);
  // «1.4KM» is a MEASURE: the bare-token branch of detectBedrooms used to read
  // its 1 as «една спална» and moved the criterion from трисобен to двособен.
  assert.equal(detectBedrooms('STO TI E TOA NA 1.4KM ?'), undefined);
  assert.equal(detectBedrooms('NA 1,4 km'), undefined);
  assert.equal(detectBedrooms('2'), 3, 'a bare count is still an answer');
});

test('[04:28] a check followed by a proceed clause is consent', () => {
  for (const t of [
    'AJDE PROVERI DALI SE PRODAVA USTE PA KE SE DOGOVORIME',
    'proveri dali e dostapen pa ke se dogovorime',
    'proverete dali se izdava pa da se vidime',
    'ПРОВЕРИ ДАЛИ СЕ ПРОДАВА УШТЕ ПА ЌЕ СЕ ДОГОВОРИМЕ',
    'proveri dali e slobodno pa ke zakazime',
  ]) assert.equal(detectProceedAfterCheck(t), true, `the proceed clause must fire: ${t}`);
  for (const t of [
    'DALI E USTE DOSTAPEN ?',              // a plain availability question
    'DALI SE PRODAVA USTE ?',
    'KE SE DOGOVORIME PODOCNA',            // the arrangement, no check
    'PROVERI JA CENATA',
  ]) assert.equal(detectProceedAfterCheck(t), false, `over-eager: ${t}`);
});

// ── 1. the ring names its row ──────────────────────────────────────────────

test('[04:05] e2e: the ring names the flat it measured, and the asks follow it', async () => {
  const { say, sessions, chatId } = makeHandler('ring-row', RING_ROWS);
  await say('ZDRAVO');
  await say('DALI IMATE NESTO OKOLU TC SKOPJANKA ?');
  await say('DA KUPAM');
  await say('DVE SPALNI');
  const ring = await say('BILO KOLKU');
  assert.match(ring, /немам недвижност во непосредна близина/iu, `the ring line: ${ring}`);
  assert.match(ring, /на 1,\d km/u, `the measured distance is stated: ${ring}`);
  // THE QUESTION IS ANSWERED, not repeated (the capture's three identical turns).
  const who = await say('STO TI E TOA NA 1.4KM ?');
  assert.doesNotMatch(who, /немам недвижност во непосредна близина/iu,
    `the ring paragraph must not repeat: ${who}`);
  assert.match(who, /Евидентен број 70/u, `the nearest row is named: ${who}`);
  assert.match(who, /1,\d km/u, `with its distance: ${who}`);
  assert.match(who, /60 м²/u, `and its own facts: ${who}`);
  assert.equal(sessions.get(chatId)!.slots.propertyId, 70, 'the row becomes the flat under discussion');
  // The room criterion never moved (the «1.4» measure).
  assert.equal(sessions.get(chatId)!.slots.bedrooms, 3, 'a distance is not a bedroom answer');
  // A second identity ask answers the same flat — never the ring paragraph.
  const again = await say('KOJ E TOJ STAN ?');
  assert.match(again, /Евидентен број 70/u, `the same row: ${again}`);
  // …and the address ladder now belongs to THAT flat.
  const address = await say('NA KOJA ULICA E ?');
  assert.doesNotMatch(address, /немам недвижност/iu, `the address is asked of the flat: ${address}`);
  assert.match(address, /Евидентен број 70|Тоа се наоѓа/u, `the location answer: ${address}`);
});

// ── 2. «кај вас» is not Фас-Вас, and a new area retires the old anchor ─────

test('[04:14] e2e: a Маџар Маало recall is answered there, never at Фас-Вас', async () => {
  const { say, sessions, chatId } = makeHandler('madjar-maalо');
  await say('ZDRAVO');
  await say('BARAM STAN VO AERODROM KAJ FAS VAS');
  await say('DA KUPAM');
  await say('DVE SPALNI');
  await say('BILO KOLKU');
  const recall = await say('IMASE EDEN STAN KAJ VAS VO MADJAR MAALO SO DVE SPALNI');
  assert.doesNotMatch(recall, /Фас-Вас/iu, `«кај вас» is not the shop: ${recall}`);
  assert.doesNotMatch(recall, /Аеродром/u, `no Аеродром card answers a Маџар Маало recall: ${recall}`);
  assert.match(recall, /Маџар Маало/u, `the area the client named: ${recall}`);
  assert.match(recall, /Евидентен број 61/u, `the Маџар Маало трисобен: ${recall}`);
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.poiAnchor, undefined,
    `the anchor from another area is retired: ${JSON.stringify({ a: s.slots.poiAnchor, area: s.slots.poiArea })}`);
  // «DALI GO IMATE USTE ?» answers the card he just read, not a stale slot EB.
  const avail = await say('DALI GO IMATE USTE ?');
  assert.match(avail, /Евидентен број 61/u, `the last served flat: ${avail}`);
});

test('[04:14] the place-name guard refuses half of a hyphenated name', async () => {
  // The unit contract behind «кај вас» → «Фас-Вас»: «Вас» is the SECOND half of
  // the shop's own compound name, so it names nothing on its own.
  const { poiNameCoversClientWords } = await import('../src/handlers/inbound');
  assert.equal(poiNameCoversClientWords('VAS', 'Фас-Вас', 'car_parts'), false);
  assert.equal(poiNameCoversClientWords('VAS', 'Фас-Вас Аеродром', undefined), false);
  // …while a class word in front still binds its name (the [01:20] «РАМПА»).
  assert.equal(poiNameCoversClientWords('РАМПА', 'тобако РАМПА', 'tobacco'), true);
});

// ── 3. describing an EB names THAT flat ────────────────────────────────────

test('[04:18] e2e: «OPISETE MI GO 91» describes 91, and the address stays 91', async () => {
  const { say, sessions, chatId } = makeHandler('describe-91');
  await say('ZDRAVO');
  await say('INFOMI ZA 47');          // the discussion anchor is another flat
  const card = await say('OPISETE MI GO 91');
  assert.match(card, /Евидентен број 91/u, `the named flat is described: ${card}`);
  assert.doesNotMatch(card, /Евидентен број 47/u, `never the anchor flat: ${card}`);
  assert.equal(sessions.get(chatId)!.slots.propertyId, 91);
  const address = await say('NA KOJA ULICA E ?');
  // EB 47 stands by the Геолошки завод; 91 by the ГТЦ. The answer follows 91.
  assert.doesNotMatch(address, /Геолошки завод/iu, `not the other flat's landmark: ${address}`);
  assert.match(address, /трговски центар|ГТЦ/iu, `91's own landmark: ${address}`);
});

// ── 4. check-then-arrange takes the details ────────────────────────────────

test('[04:28] e2e: «proveri … pa ke se dogovorime» opens the money ladder for that flat', async () => {
  const { say, sessions, chatId } = makeHandler('check-then-arrange');
  await say('ZDRAVO');
  await say('INFOMI ZA 91');
  const fee = await say('AJDE PROVERI DALI SE PRODAVA USTE PA KE SE DOGOVORIME');
  // The fee is disclosed for the flat he named (the subject line), and the
  // answer is the ONE consent question — not a second «сакате да го
  // исконтактирам?» instead of the arrangement he asked for.
  assert.match(fee, /Евидентен број 91/u, `the fee names the flat: ${fee}`);
  assert.match(fee, /500 денари|10 евра/u, `the sanctioned fee: ${fee}`);
  assert.doesNotMatch(fee, /Би требало да е сеуште достапен/iu,
    `the availability ack is not the answer to a proceed clause: ${fee}`);
  // His yes takes the details.
  const contact = await say('DA');
  assert.equal(sessions.get(chatId)!.state, 'contact_collection',
    `the funnel collects the contact: ${JSON.stringify(sessions.get(chatId)!.slots)}`);
  assert.match(contact, /име|презиме|телефон/iu, `the contact ask: ${contact}`);
});
