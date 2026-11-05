/**
 * THE [03:42]–[04:05] BATCH — five faults the owner reported in one session.
 *
 *   [03:37] EDNA SPALNA DO 120 000 ILI SO DVE SPALNI MOZE DO 250000
 *   [03:42] A AERODROM NESTO OKOLU KAPITOL
 *   [03:43] ЛИНА: Секако. Да барам истите критериуми (една или две спални и
 *                  до 250.000 евра) околу ТЦ Капитол?      ← the 120.000 tier
 *                                                             disappeared
 *   [03:43] DA
 *   [03:43] ЛИНА: … EB 53 (двособен, 55.000) + EB 82 (трособен, 143.000)
 *   [03:45] DAJ MI STO IMAS PODALEKU
 *   [03:45] ЛИНА: Тоа е сè што имав двособни до 120.000 евра во Аеродром —
 *                  понатаму ги покажувам трособни.     ← «трисобни» in the old
 *                  wording; and «подалеку» answered with «ги исцрпивме» while a
 *                  трособен sat 1,4 km away in the same area
 *   [03:45] NA KOJA ULICA E OVOJ ?                     ← the last batch held ONE
 *                  card (EB 75); the answer described EB 53, a card from the
 *                  batch before it (feed-order tail, not presentation order)
 *   [04:05] NE MI ODGOVARA PETOK VOOPSTO. DA OSTAVIME ZA PONEDNIK VO 6 MOZE?
 *   [04:05] ЛИНА: Не, тоа е на 3,9 километри од Mezzo, а недвижноста е во
 *                  Аеродром.                          ← a visit counter answered
 *                  with a PLACE-DISTANCE line («6 MOZE» → «Mezzo»)
 *
 * The contracts pinned here:
 *   • two categories with a cap each keep BOTH figures — in the confirmation and
 *     in the serve, each card under ITS OWN cap (a later message that merely
 *     restates the same range must not wipe the split);
 *   • a wanted category with NOTHING in stock is said as such at the start of
 *     the serve («Моментално во системот нема …»); «Тоа е сè што имав …» is for
 *     a category that WAS shown IN THIS GEOGRAPHY and has now run out;
 *   • the three-room plural is «трособни»;
 *   • a farther ask after a near serve releases the 1 km ring INSIDE the same
 *     naselba (the owner's rule) instead of declaring the search drained;
 *   • a demonstrative with no number means the ONLY card of the last serve;
 *   • a scheduling message (day/clock) inside a visit state is visit traffic —
 *     never a place question — and the owner is re-asked with the term the
 *     client actually proposed.
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
import { extractPoiConfirmPlace, detectVisitTime } from '../src/llm/deterministic';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  async locations(): Promise<string[]> {
    return [...new Set(this.rows.map(r => (r.location ?? '').trim()).filter(Boolean))];
  }
  get healthy(): boolean { return true; }
}

// The first serve of the capture happened in the area the client already had
// (Центар here — the transcript's pair came from Центар too, «Тоа е сè што имав
// двособни до 120.000 евра во Центар»), so the cards near ТЦ Капитол are fresh
// when the place arrives. That is what makes the second serve a real pair
// instead of the tail of the first batch.
const TSENTAR_ROWS: Property[] = [
  // One bedroom (двособен), 99.000 — inside its own 120.000 cap.
  { eb: 69, id: 69, location: 'Центар', address: 'Ул. Димитар Миладинов 4', price: 99000, bedrooms: 2, sqm: 51, size: '51 м²', service: 'buy', lat: 41.9985, lon: 21.4330 },
  // Two bedrooms (трособен), 178.000 — inside its own 250.000 cap.
  { eb: 91, id: 91, location: 'Центар', address: 'Ул. Соларис 7', price: 178000, bedrooms: 3, sqm: 71, size: '71 м²', service: 'buy', lat: 41.9950, lon: 21.4400 },
];

// ТЦ Капитол is at 41.9852634,21.467315 — distances below are real.
const AERODROM_ROWS: Property[] = [
  // ONE bedroom (двособен) up to 120.000 — the small tier, 70 m from the mall.
  { eb: 53, id: 53, location: 'Аеродром', address: 'Ул. ТЦ Бисер 2', price: 55000, bedrooms: 2, sqm: 44, size: '44 м²', service: 'buy', lat: 41.98515, lon: 21.46646, landmark: 'ТЦ Бисер' },
  // TWO bedrooms (трособен) up to 250.000 — 340 m away.
  { eb: 82, id: 82, location: 'Аеродром', address: 'Ул. Јане Сандански 60', price: 143000, bedrooms: 3, sqm: 77, size: '77 м²', service: 'buy', lat: 41.9883, lon: 21.4673, landmark: 'Градинка Срничка' },
  // The same two-bedroom tier, 1,4 km away (outside the 1 km ring, same area).
  { eb: 75, id: 75, location: 'Аеродром', address: 'Ул. Њуделхиска 12', price: 154000, bedrooms: 3, sqm: 76, size: '76 м²', service: 'buy', lat: 41.9727, lon: 21.4673, landmark: 'KAM маркет' },
  // A двособен at 130.000: 10.000 OVER the cap the client gave for that tier.
  { eb: 90, id: 90, location: 'Аеродром', address: 'Ул. Скупи 4', price: 130000, bedrooms: 2, sqm: 50, size: '50 м²', service: 'buy', lat: 41.9850, lon: 21.4700 },
];

const TIER_ROWS: Property[] = [...TSENTAR_ROWS, ...AERODROM_ROWS];

// The same search with NOTHING in the one-bedroom tier near the mall at all.
const NO_SMALL_TIER_ROWS: Property[] = [
  ...TSENTAR_ROWS,
  ...AERODROM_ROWS.filter(r => r.eb !== 53 && r.eb !== 90),
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
  return { handler, say, sessions, chatId: id, sent };
}

const TIERS = 'EDNA SPALNA DO 120 000 ILI SO DVE SPALNI MOZE DO 250000';

test('[03:42] the confirmation names BOTH caps — one figure per category', async () => {
  const { say } = makeHandler(TIER_ROWS, 'tier-echo');
  await say('ZDRAVO SAKAM DA KUPAM STAN VO CENTAR');
  await say(TIERS);
  const confirm = await say('A NESTO OKOLU KAPITOL');
  assert.match(confirm, /120\.000/u, `the small tier's own cap must survive the echo: ${confirm}`);
  assert.match(confirm, /250\.000/u, `the big tier's cap is named too: ${confirm}`);
  assert.match(confirm, /ТЦ Капитол/u, `in the place the client named: ${confirm}`);
  // One tier is «една спална», the other «две спални» — never a merged range.
  assert.match(confirm, /една спална/u, confirm);
  assert.match(confirm, /две спални/u, confirm);
});

test('[03:43] the serve keeps one card per tier, each under ITS OWN cap', async () => {
  const { say, sessions, chatId } = makeHandler(TIER_ROWS, 'tier-serve');
  await say('ZDRAVO SAKAM DA KUPAM STAN VO CENTAR');
  await say(TIERS);
  await say('A NESTO OKOLU KAPITOL');
  const pair = await say('DA');
  const s = sessions.get(chatId)!;

  // The 130.000 двособен is 10.000 over the cap he named for that category.
  assert.doesNotMatch(pair, /Евидентен број 90/u, `over-cap row must not ride: ${pair}`);
  assert.match(pair, /Евидентен број 53/u, `the in-cap one-bedroom card: ${pair}`);
  assert.match(pair, /Евидентен број 82/u, `the two-bedroom card: ${pair}`);
  assert.deepEqual(s.slots.categoryBudgets, { '2': '120000', '3': '250000' },
    'the split survives every message that merely restates the same range');
});

test('[03:45] a category that was NEVER served here is a gap in the system, not «сè што имав»', async () => {
  const { say, chatId, sessions } = makeHandler(NO_SMALL_TIER_ROWS, 'never-had');
  await say('ZDRAVO SAKAM DA KUPAM STAN VO CENTAR');
  await say(TIERS);
  await say('A NESTO OKOLU KAPITOL');
  const first = await say('DA');
  assert.match(first, /Моментално во системот нема двособни до 120\.000 евра/u,
    `the owner's wording for a category with no stock: ${first}`);
  assert.match(first, /Аеродром/u, `the area it is true for: ${first}`);
  assert.doesNotMatch(first, /Тоа е сè што имав/u,
    `nothing of that category was ever shown HERE, so nothing ran out: ${first}`);
  // The cards that DO exist still ride the same turn.
  assert.match(first, /Евидентен број 82/u, `the available tier is served: ${first}`);
  assert.equal(sessions.get(chatId)!.slots.categoriesServed?.includes(2), false,
    'the missing category was never on the table in this geography');
});

test('[03:45] «подалеку» serves the farther card in the SAME naselba — «Тоа е сè што имав» and «трособни»', async () => {
  const { say, sessions, chatId } = makeHandler(TIER_ROWS, 'exhausted');
  await say('ZDRAVO SAKAM DA KUPAM STAN VO CENTAR');
  await say(TIERS);
  await say('A NESTO OKOLU KAPITOL');
  await say('DA'); // the near pair: EB 53 + EB 82
  const farther = await say('DAJ MI STO IMAS PODALEKU');
  const s = sessions.get(chatId)!;
  // The ring is released INSIDE the anchor's naselba, not the whole city.
  assert.equal(s.slots.poiWidenScope, 'area', `the farther ask is the same-naselba widen: ${farther}`);
  assert.doesNotMatch(farther, /Ги исцрпивме/u, `the search is not drained: ${farther}`);
  assert.match(farther, /Евидентен број 75/u, `the 1,4 km card in the same area is served: ${farther}`);
  // The one-bedroom tier WAS shown here and is now gone: the drained wording.
  assert.match(farther, /Тоа е сè што имав двособни до 120\.000 евра/u,
    `the tier was served and is now gone: ${farther}`);
  assert.match(farther, /трособни/u, `the owner's three-room plural: ${farther}`);
  assert.doesNotMatch(farther, /трисобни/u, `never «трисобни»: ${farther}`);
});

test('[03:45] «NA KOJA ULICA E OVOJ?» means the ONLY card of the last serve', async () => {
  const { say } = makeHandler(TIER_ROWS, 'one-card');
  await say('ZDRAVO SAKAM DA KUPAM STAN VO CENTAR');
  await say(TIERS);
  await say('A NESTO OKOLU KAPITOL');
  const pair = await say('DA');
  // A pair was shown first — feed order puts EB 53 first, EB 82 second.
  const firstOfPair = pair.match(/Евидентен број (\d+)/u)?.[1];
  assert.ok(firstOfPair, `a pair must be served first: ${pair}`);
  const single = await say('DAJ MI STO IMAS PODALEKU');
  const onlyCard = single.match(/Евидентен број (\d+)/u)?.[1];
  assert.ok(onlyCard, `a second batch must be served: ${single}`);
  // Only ONE card in that last batch, so the demonstrative can only mean it.
  assert.equal((single.match(/Евидентен број \d+/gu) ?? []).length, 1,
    `the last batch holds exactly one card: ${single}`);

  const answer = await say('NA KOJA ULICA E OVOJ ?');
  assert.match(answer, new RegExp(`Евидентен број ${onlyCard}`, 'u'),
    `the only card of the last serve is the subject: ${answer}`);
  assert.doesNotMatch(answer, new RegExp(`Евидентен број ${firstOfPair}`, 'u'),
    `not a card from the batch before it: ${answer}`);
  assert.match(answer, /се наоѓа/u, `a location answer, not a deflection: ${answer}`);
});

test('[04:05] a place candidate that is a CLOCK phrase is not a place', () => {
  // The exact string the capture produced: «vo 6 moze» → «MOZE» → «Mezzo».
  assert.equal(extractPoiConfirmPlace('NE MI ODGOVARA PETOK VOOPSTO. DA OSTAVIME ZA PONEDNIK VO 6 MOZE?'), undefined);
  assert.equal(extractPoiConfirmPlace('DA OSTAVIME ZA PONEDELNIK VO 6 MOZE?'), undefined);
  assert.equal(extractPoiConfirmPlace('MOZE VO 6 ?'), undefined);
  // A real place that carries a number is untouched.
  assert.equal(extractPoiConfirmPlace('da ne e vo 26 juli ?')?.toLowerCase(), '26 juli');
  assert.equal(extractPoiConfirmPlace('da ne e vo skopjanka ?'), 'skopjanka');
});

test('[04:05] the term is the PROPOSAL — the refused clause is not the visit time', () => {
  assert.equal(
    detectVisitTime('NE MI ODGOVARA PETOK VOOPSTO. DA OSTAVIME ZA PONEDNIK VO 6 MOZE?'),
    'DA OSTAVIME ZA PONEDNIK VO 6 MOZE');
  // A single-clause rejection keeps its own shape (the follow-up owns it).
  assert.equal(detectVisitTime('NE MOZAM VO 18:00 DALI MOZE POKASNO'),
    'NE MOZAM VO 18:00 DALI MOZE POKASNO');
});

test('[04:05] a visit counter during the owner ping-pong never becomes a place-distance answer', async () => {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps([
    { eb: 78, id: 78, location: 'Аеродром', price: 36000, service: 'buy', sqm: 74, size: '74 м²', address: 'Партизерска 10', lat: 41.996, lon: 21.428, geo_source: 'stored' } as Property,
  ]);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties, appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  const asks: string[] = [];
  handler.onOwnerAsk = (_c, _eb, q) => asks.push(q);
  const chat = 'visit-counter';
  const say = async (m: string) => { await handler.handle('test', chat, m); return sessions.get(chat)!; };

  await say('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await say('DALI E SEUSTE DOSTAPEN ?');
  await say('DA');
  await say('DA, SE SOGLASUVAM');
  await say('ZORAN 078/914 196');
  let s = await say('UTRE POPLADNE POSLE 6');
  assert.equal(s.state, 'owner_checking', `setup: ${s.state}`);
  // The owner cannot do Thursday and offers Friday 17:00.
  handler.ownerAnswer(chat, 78, { status: 'counter', ownerTime: 'Петок во 5' });
  await new Promise(r => setTimeout(r, 60));
  const before = asks.length;

  s = await say('NE MI ODGOVARA PETOK VOOPSTO. DA OSTAVIME ZA PONEDNIK VO 6 MOZE?');
  const reply = sent[sent.length - 1] ?? '';
  // 1. the visit negotiation survives — the chat is still waiting on a term
  assert.equal(s.state, 'owner_checking', `the ping-pong must continue: ${s.state}`);
  // 2. NO place answer: no kilometre figure, no maps pin, no invented landmark
  assert.doesNotMatch(reply, /километр|km од|maps\.google/u, `never a distance answer: ${reply}`);
  assert.doesNotMatch(reply, /Mezzo/u, `never a place the client did not name: ${reply}`);
  // 3. the owner is asked again, with the term the CLIENT proposed
  assert.equal(asks.length, before + 1, `the owner must be re-asked: ${JSON.stringify(asks)}`);
  const ask = asks[asks.length - 1]!;
  assert.match(ask, /Понеделник, \d{2}\.\d{2}\.\d{4} во 18:00/u,
    `the new proposal is the Monday 18:00 the client named: ${ask}`);
  assert.match(ask, /не е во можност/u, `the follow-up wording: ${ask}`);
});
