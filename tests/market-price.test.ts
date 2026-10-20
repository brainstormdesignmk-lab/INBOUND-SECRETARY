// THE [16:57] CAPTURE — a market question answered with the intake question.
//
//   [16:57] KAZI MI KAKO SE DVIZAT CENIVE ZA STANOVI VO AERODROM (NASELBA)
//   [16:57] ЛИНА: Би сакала да проверам дали за Вас е подобра опција
//           купување или изнајмување на стан?
//
// No lane owned "how do FLAT prices move in X": the property-price lane only
// answers about the flat on the table, and detectService never saw a service.
// The answer must be the MEASURED €/m² band of the feed's own rows for that
// category in that area, in the agency's wording:
//
//   Цените варираат од <најниска> до <највисока> евра за м² во зависност од
//   местоположбата, квалитетот, годината на градба, опремата и условите што
//   ги нуди самиот објект.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property, pricePerM2, monthlyRent, rentUnitWord, rowsInArea, numberedAreasNamed, feedArea, deriveAreaFromText, mapRow } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { detectMarketPriceAsk, detectPriceExtremeAsk, extractPriceExtremeQuery, isFeeFrame } from '../src/llm/deterministic';
import { resolveIntent } from '../src/handlers/router';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

/** Feed-shaped rows: three flats for SALE in Аеродром (the band the client
 *  asked about), one RENTAL in Аеродром (a different segment — a monthly rent
 *  must never share a €/m² band with a sale price) and one flat in Центар
 *  (outside the asked area). */
const ROWS: Property[] = [
  { eb: 101, id: 101, address: 'Јане Сандански 1', location: 'Аеродром', price: 69000, sqm: 62, service: 'buy', bedrooms: 2 },
  { eb: 102, id: 102, address: 'Јане Сандански 3', location: 'Аеродром', price: 95000, sqm: 78, service: 'buy', bedrooms: 3 },
  { eb: 103, id: 103, address: 'Јане Сандански 5', location: 'Аеродром', price: 60500, sqm: 55, service: 'buy', bedrooms: 2 },
  { eb: 104, id: 104, address: 'Јане Сандански 7', location: 'Аеродром', price: 350, sqm: 45, service: 'rent', bedrooms: 1 },
  { eb: 105, id: 105, address: 'Македонија 10', location: 'Центар', price: 120000, sqm: 70, service: 'buy', bedrooms: 2 },
  { eb: 106, id: 106, address: 'Карпош II 4', location: 'Карпош II', price: 72000, sqm: 60, service: 'buy', bedrooms: 2 },
  { eb: 107, id: 107, address: 'Карпош III 9', location: 'Карпош III', price: 104000, sqm: 80, service: 'buy', bedrooms: 2 },
  { eb: 108, id: 108, address: 'Македонија 12', location: 'Центар', price: 70000, sqm: 50, service: 'buy', bedrooms: 1 },
  // 90.000 / 70 → 1.286 €/m² — the row the [17:44] client quoted back.
  { eb: 109, id: 109, address: 'Македонија 14', location: 'Центар', price: 90000, sqm: 70, service: 'buy', bedrooms: 2 },
  // Second rental so the rent band is a real range (350–400 евра месечно).
  { eb: 110, id: 110, address: 'Јане Сандански 9', location: 'Аеродром', price: 400, sqm: 50, service: 'rent', bedrooms: 2 },
  // NO м², highest price in the feed: must never be ranked or banded — the old
  // price/(sqm||1) scored it 500.000 €/m² and it won every "dearest" ask.
  { eb: 113, id: 113, address: 'Македонија 20', location: 'Центар', price: 500000, service: 'buy', bedrooms: 4 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  async locations(): Promise<string[]> {
    return [...new Set(this.rows.map(r => (r.location ?? '').trim()).filter(Boolean))];
  }
  get healthy(): boolean { return true; }
}

const cfg = loadConfig();
function makeHandler(rows: Property[] = ROWS): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const sent: string[] = [];
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const properties = new FakeProps(rows);
  const llm = new FailingLlm();
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(llm, cfg, properties),
    responder: new Responder(llm, cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent };
}

// ── 1. THE DETECTOR: every phrasing the client may type ─────────────────────

test('detectMarketPriceAsk: the [16:57] line and the whole phrasing family fire', () => {
  for (const text of [
    'KAZI MI KAKO SE DVIZAT CENIVE ZA STANOVI VO AERODROM (NASELBA)',
    'kako se dvizat cenite za stanovi vo aerodrom?',
    'КАКО СЕ ДВИЖАТ ЦЕНИТЕ ЗА СТАНОВИ ВО АЕРОДРОМ?',
    'KAKO SE DVIZAT CENIVE VO AERODROM?',
    'KAZI MI KAKOODAT CENITE ZA M2',
    'kazi mi kakoodat cenite za m2',
    'КАЖИ МИ КАКООДАТ ЦЕНИТЕ ЗА М2',
    'KAKVI SE CENITE?',
    'KAKO CENITE?',
    'KAKVA E CENATA ZA M2?',
    'KOJA CENA PO KVADRAT?',
    'KOJA E CENATA PO KVADRAT VO KARPOS?',
    'KOLKU E CENATA ZA M2 VO CENTAR?',
    'KOLKU E CENATA PO KVADRAT?',
    'CENI PO KVADRAT ZA STANOVI?',
    'KAKO ODAT CENITE NA STANOVITE VO AERODROM?',
    'KAKO SE MENUVAAT CENITE ZA KUKJI VO VLAE?',
    'цени по квадрат во аеродром?',
  ]) {
    assert.ok(detectMarketPriceAsk(text), `must fire: ${text}`);
  }
});

test('detectMarketPriceAsk: a single property\'s price is NOT a market question', () => {
  for (const text of [
    'KOLKU E CENATA?',
    'kolku e cenata na stanot?',
    'KOLKU E CENATA NA 61?',
    'DALI CENATA E FIKSNO?',
    'CENATA ZA M2 E VISOKA',
    'cenata e 120.000 evra',
    'dali moze da se spusti cenata?',
  ]) {
    assert.equal(detectMarketPriceAsk(text), false, `must NOT fire: ${text}`);
  }
});

test('the router mirror predicts MARKET_PRICE for the capture line', () => {
  assert.equal(resolveIntent('KAZI MI KAKO SE DVIZAT CENIVE ZA STANOVI VO AERODROM (NASELBA)', 'idle'), 'MARKET_PRICE');
  assert.equal(resolveIntent('KOLKU E CENATA?', 'property_locate'), 'FALLTHROUGH');
});

// ── 2. THE ANSWER: measured bands, agency wording ───────────────────────────

const EXPECTED_BAND =
  /цените варираат од 1\.100 до 1\.218 евра за м² во зависност од местоположбата, квалитетот, годината на градба, опремата и условите што ги нуди самиот објект\./u;

test('[16:57] the market question is answered with the €/m² band of the feed rows', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'capture-1657';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'KAZI MI KAKO SE DVIZAT CENIVE ZA STANOVI VO AERODROM (NASELBA)');
  const answer = sent[sent.length - 1] ?? '';

  assert.match(answer, /^Во Аеродром, /, `the area is named: ${answer}`);
  assert.match(answer, EXPECTED_BAND, `the measured band and the agency wording: ${answer}`);
  // The segment is SALE (three sale rows vs one rental): a 350 € rental must
  // never drag the band down to single digits.
  assert.ok(!/од [1-9] до/u.test(answer), `no rent row in a sale band: ${answer}`);
  // It is an answer, not the intake question.
  assert.ok(!/купување или изнајмување/u.test(answer), answer);
  assert.ok(!/Евидентен број|м²\s*—|чини/u.test(answer), `never a property card: ${answer}`);

  // The area stays under discussion for the next turn.
  assert.equal(sessions.get(chatId)?.slots.location, 'Аеродром');
});

// RENT IS MEASURED IN MONTHLY EUROS, NOT €/m²: „цените за изнајмување на
// станови варираат од 350 до 400 евра месечно“ — a rent of 350 € over 45 m²
// must never be reported as 8 €/m² next to a sale band in the same unit.
test('[16:57] a rental funnel measures MONTHLY rent, not €/m²', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'capture-1657-rent';
  const s = freshSession('test', chatId);
  s.slots.service = 'rent';
  sessions.set(s);

  await handler.handle('test', chatId, 'KAKVI SE CENITE ZA STANOVI VO AERODROM?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /цените за изнајмување на станови варираат од 350 до 400 евра месечно/u, answer);
  // No per-square-metre figure at all in a rent answer, and no sale band.
  assert.ok(!/за м²/u.test(answer), answer);
  assert.ok(!/1\.100|1\.218/u.test(answer), answer);
});

// THE CLIENT'S OWN WORDING (…ЦЕНИ ЗА ИЗНАЈМУВАЊЕ НА СТАНОВИ ВО …) must select
// the RENT segment even when the funnel never declared one. Before this, the
// rent wording fell into discovery and asked „на кој дел од градот?“.
test('the wording „за изнајмување“ selects the rent band by itself', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'rent-by-wording';
  sessions.set(freshSession('test', chatId)); // no service in the session

  await handler.handle('test', chatId, 'KAKVI SE CENITE ZA STANOVI ZA IZNAJMUVANJE VO AERODROM?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /^Во Аеродром, цените за изнајмување на станови варираат од 350 до 400 евра месечно/u, answer);
  assert.ok(!/за м²/u.test(answer), `rent is monthly, never per м²: ${answer}`);
  assert.ok(!/купување или изнајмување/u.test(answer), `an answer, not the intake question: ${answer}`);
});

test('[16:57] a single rental is quoted as ONE offer, never as a fake range', async () => {
  const { handler, sessions, sent } = makeHandler(ROWS.filter(r => r.eb !== 110));
  const chatId = 'capture-1657-rent-single';
  const s = freshSession('test', chatId);
  s.slots.service = 'rent';
  sessions.set(s);

  await handler.handle('test', chatId, 'KAKVI SE CENITE ZA STANOVI VO AERODROM?');
  const answer = sent[sent.length - 1] ?? '';
  // One row is a LISTING, not a price level (the thin-feed rule).
  assert.match(answer, /^Во Аеродром, во моментов имаме една активна понуда: 350 евра месечно\./u, answer);
});

test('a unit-only ask with no area measures the whole city segment', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'capture-m2';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'KAKVA CENA ZA M2?');
  const answer = sent[sent.length - 1] ?? '';
  // All sale flats: 1.100 (Аеродром) to 1.714 (Центар 120.000/70). With no
  // area prefix the band OPENS the sentence, so it is capitalized.
  assert.match(answer, /^Цените варираат од 1\.100 до 1\.714 евра за м²/u, answer);
});

test('[16:57] a follow-up price ask keeps the area under discussion', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'capture-1657-followup';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'KAKO SE DVIZAT CENITE ZA STANOVI VO AERODROM?');
  sent.length = 0;
  await handler.handle('test', chatId, 'A KOJA E CENATA PO KVADRAT?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /^Во Аеродром, /u, `the area carries over: ${answer}`);
  assert.match(answer, EXPECTED_BAND, answer);
});

// ── 3. ONE BAND PER AREA, FAMILY AREAS, AND THE CITY ───────────────

// THE [17:34] CAPTURE: the client named TWO areas („KARPOS ILI CENTAR“) and
// asked the €/m² question; Lina merged them into ONE band (1.286–2.889) that
// described neither neighborhood. Each named area must be measured on its own
// rows and get its own sentence.
test('[17:34] two named areas get two bands, not one merged band', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'capture-1734';
  const s = freshSession('test', chatId);
  // The state the previous turn leaves (the client answered „KARPOS ILI CENTAR“):
  // detectLocation joins the two canonical areas with a comma.
  s.slots.location = 'Центар (населба), Карпош III';
  sessions.set(s);

  await handler.handle('test', chatId, 'KAZI MI KAKOODAT CENITE ZA M2');
  const answer = sent[sent.length - 1] ?? '';
  const lines = answer.split('\n');

  // Центар: 90.000/70 → 1.286 (the row the client quoted back) and
  // 120.000/70 → 1.714
  assert.ok(lines.some(l => /^Во Центар, цените варираат од 1\.286 до 1\.714 евра за м²\.$/u.test(l)), answer);
  // Карпош: 72.000/60 → 1.200 and 104.000/80 → 1.300 (family, not just III)
  assert.ok(lines.some(l => /^Во Карпош, цените варираат од 1\.200 до 1\.300 евра за м²\.$/u.test(l)), answer);
  // Never the merged band.
  assert.ok(!/1\.200 до 2\.889|1\.286 до 2\.889/u.test(answer), answer);
  // The agency's dependency line closes the reply once (it OPENS that final
  // sentence, so it is capitalized — match case-insensitively).
  assert.equal((answer.match(/зависност од местоположбата/giu) ?? []).length, 1, answer);
});

test('[17:34] a bare KARPOS means the whole family (I–IV), a numbered one stays narrow', async () => {
  const family = makeHandler();
  const c1 = 'capture-karpos';
  family.sessions.set(freshSession('test', c1));
  await family.handler.handle('test', c1, 'KAKO SE DVIZAT CENITE ZA STANOVI VO KARPOS?');
  const wide = family.sent[family.sent.length - 1] ?? '';
  assert.match(wide, /^Во Карпош, цените варираат од 1\.200 до 1\.300 евра за м²/u, wide);

  const narrow = makeHandler();
  const c2 = 'capture-karpos-3';
  narrow.sessions.set(freshSession('test', c2));
  await narrow.handler.handle('test', c2, 'KAKO SE DVIZAT CENITE ZA STANOVI VO KARPOS III?');
  const only3 = narrow.sent[narrow.sent.length - 1] ?? '';
  // Карпош III holds ONE row: the answer says so instead of „цените се околу“.
  assert.match(only3, /^Во Карпош III, во моментов имаме една активна понуда: 1\.300 евра за м²/u, only3);
  assert.ok(!/1\.200/u.test(only3), only3);
});

// „KAKO ODAT CENITE ZA STANOVITE VO SKOPJE“ — a client from another city asks
// about the WHOLE city. The funnel's stored area must not narrow it.
test('[17:34] a Skopje ask measures the whole city, never the stored area', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'capture-skopje';
  const s = freshSession('test', chatId);
  s.slots.location = 'Аеродром';
  sessions.set(s);

  await handler.handle('test', chatId, 'KAKO ODAT CENITE ZA STANOVITE VO SKOPJE?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /^Во Скопје, цените варираат од 1\.100 до 1\.714 евра за м²/u, answer);
  assert.ok(!/Аеродром/u.test(answer), answer);
});

// ── 4. THE ENDS OF THE BAND: serve the cheapest / the dearest ────────────

// THE [17:44] CAPTURE: the client read the LOW end of the band („1.286“) and
// asked WHICH flat it is. The funnel asked for the bedroom count instead.
test('[17:44] the flat at the quoted price is served, not the bedroom question', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'capture-1744';
  const s = freshSession('test', chatId);
  s.slots.location = 'Центар (населба), Карпош III';
  sessions.set(s);

  await handler.handle('test', chatId, 'KOJ TI E TOJ STAN PO 1286E PO M2');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /Евидентен број 109/u, `the 1.286 €/m² row: ${answer}`);
  assert.match(answer, /1\.286 евра за м²/u, answer);
  assert.ok(!/спални соби/u.test(answer), `never the intake question: ${answer}`);
  assert.equal(sessions.get(chatId)?.slots.propertyId, 109);
});

// „POCNI OD NAJEVTINITE I POKAZI MI STO IMA / NAJSKAPITE“ — the serving order
// the client asked for, on the SEGMENT's own metric.
test('the cheapest flat is served from the low end of the feed', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'capture-cheapest';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'DAJ MI GO NAJEVTINIOT STAN VO AERODROM');
  const answer = sent[sent.length - 1] ?? '';
  // Аеродром sale: 1.100 (60.500/55, eb 103) is the lowest.
  assert.match(answer, /^Најевтиниот стан во Аеродром е со Евидентен број 103/u, answer);
  assert.match(answer, /60\.500 евра \(1\.100 евра за м²\)/u, answer);
});

test('the most expensive flat is served from the high end of the feed', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'capture-dearest';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'KOJ E NAJSKAPIOT STAN VO CENTAR?');
  const answer = sent[sent.length - 1] ?? '';
  // Центар sale: 120.000/70 → 1.714 (eb 105) is the highest. EB 113 prices at
  // 500.000 with NO м² — it must not win the slot (the guard, not luck).
  assert.match(answer, /^Најскапиот стан во Центар е со Евидентен број 105/u, answer);
  assert.match(answer, /120\.000 евра \(1\.714 евра за м²\)/u, answer);
  assert.ok(!/Евидентен број 113/u.test(answer), `a surface-less row is never a €/m² rank: ${answer}`);
  assert.ok(!/500\.000 евра за м²/u.test(answer), answer);
});

// The same serving order in a RENT funnel ranks on MONTHLY price — a 45 m²
// rental at 350 € is cheaper than a 50 m² at 400 € even though 350 € over
// fewer square metres would look dearer per m².
test('a rent funnel ranks the ends on monthly price, not €/m²', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'capture-rent-cheapest';
  const s = freshSession('test', chatId);
  s.slots.service = 'rent';
  sessions.set(s);

  await handler.handle('test', chatId, 'KOJ E NAJEVTINIOT STAN ZA IZNAJMUVANJE VO AERODROM?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /^Најевтиниот стан во Аеродром е со Евидентен број 104/u, answer);
  assert.match(answer, /350 евра месечно/u, answer);
  assert.ok(!/за м²/u.test(answer), `rent is quoted monthly: ${answer}`);
});

test('a city-wide extreme ask needs no area and still ranks the feed', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'capture-cheapest-city';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'POKAZI MI GO NAJEVTINIOT STAN');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /^Најевтиниот стан во сите населби е со Евидентен број 103/u, answer);
});

// ── 5. NUMBERED KARPOŠ (I/II/III/IV) + THE €/m² GUARD ──────────────────────

const KARPOS_ROWS: Property[] = [
  { eb: 201, id: 201, address: 'Карпош I 1', location: 'Карпош I', price: 55000, sqm: 50, service: 'buy', bedrooms: 2 },   // 1.100
  { eb: 202, id: 202, address: 'Карпош II 2', location: 'Карпош II', price: 72000, sqm: 60, service: 'buy', bedrooms: 2 }, // 1.200
  { eb: 203, id: 203, address: 'Карпош III 3', location: 'Карпош III', price: 104000, sqm: 80, service: 'buy', bedrooms: 2 }, // 1.300
  { eb: 204, id: 204, address: 'Карпош IV 4', location: 'Карпош IV', price: 90000, sqm: 45, service: 'buy', bedrooms: 2 }, // 2.000
];

test('pricePerM2: computed automatically, refused when the row cannot back it', () => {
  const row = (price: number, sqm?: number): Property =>
    ({ eb: 1, id: 1, address: '', location: 'Центар', price, sqm, service: 'buy' });
  assert.equal(pricePerM2(row(90000, 70)), 1286);
  assert.equal(pricePerM2(row(500000)), undefined, 'no м² → no per-м² figure, never price/1');
  assert.equal(pricePerM2(row(90000, 0)), undefined);
  assert.equal(pricePerM2(row(90000, 1)), undefined, '90.000 €/m² is a data slip, not a price');
  assert.equal(pricePerM2(row(0, 50)), undefined);
});

test('numberedAreasNamed: digits, roman numerals and ordinals bind to their place word', () => {
  const locs = ['Карпош I', 'Карпош II', 'Карпош III', 'Карпош IV', 'Центар'];
  assert.deepEqual(numberedAreasNamed('KARPOS 1 ILI KARPOS 4', locs), ['Карпош I', 'Карпош IV']);
  assert.deepEqual(numberedAreasNamed('kakvi se cenite vo karpos iii', locs), ['Карпош III']);
  assert.deepEqual(numberedAreasNamed('KARPOS IV', locs), ['Карпош IV']);
  assert.deepEqual(numberedAreasNamed('KARPOS', locs), [], 'bare KARPOS = the family, not a number');
  assert.deepEqual(numberedAreasNamed('KARPOS I CENTAR', locs), [], '„i“ is the conjunction here');
  // The feed may hold only III: the ask still names I, so the answer can say
  // there is no data for I instead of widening to the family.
  assert.deepEqual(numberedAreasNamed('KARPOS 1', ['Карпош III']), ['Карпош I']);
});

test('rowsInArea: Карпош 2 is Карпош II only, never the family', () => {
  assert.deepEqual(rowsInArea(KARPOS_ROWS, 'Карпош 2').map(p => p.eb), [202]);
  assert.deepEqual(rowsInArea(KARPOS_ROWS, 'KARPOS II').map(p => p.eb), [202]);
  assert.deepEqual(rowsInArea(KARPOS_ROWS, 'Карпош').map(p => p.eb), [201, 202, 203, 204]);
});

test('KARPOS 1 ILI KARPOS 4: two numbered areas, two lines, two prices', async () => {
  const { handler, sessions, sent } = makeHandler(KARPOS_ROWS);
  const chatId = 'karpos-1-4';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'KAKVI SE CENITE ZA STANOVI VO KARPOS 1 ILI KARPOS 4?');
  const answer = sent[sent.length - 1] ?? '';
  const lines = answer.split('\n');
  assert.ok(lines.some(l => /^Во Карпош I, во моментов имаме една активна понуда: 1\.100 евра за м²\.$/u.test(l)), answer);
  assert.ok(lines.some(l => /^Во Карпош IV, во моментов имаме една активна понуда: 2\.000 евра за м²\.$/u.test(l)), answer);
  assert.ok(!/1\.100 до 2\.000/u.test(answer), `no merged family band: ${answer}`);
});

test('a bare KARPOS still measures the whole family I–IV', async () => {
  const { handler, sessions, sent } = makeHandler(KARPOS_ROWS);
  const chatId = 'karpos-family';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'KAKVI SE CENITE ZA STANOVI VO KARPOS?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /^Во Карпош, цените варираат од 1\.100 до 2\.000 евра за м²/u, answer);
});

test('KARPOS 1 with no rows names the gap, then gives the FAMILY band labelled as the family', async () => {
  const { handler, sessions, sent } = makeHandler(KARPOS_ROWS.filter(r => r.location !== 'Карпош I'));
  const chatId = 'karpos-1-empty';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'KAKVI SE CENITE ZA STANOVI VO KARPOS 1?');
  const answer = sent[sent.length - 1] ?? '';
  // The gap is stated first — a numbered area is never silently widened.
  assert.match(answer, /^За Карпош I во моментов немам понуди\./u, answer);
  // Then the family band, NAMED as the family (the widening is not disguised
  // as Карпош I's own price).
  assert.match(answer, /За целата населба Карпош цените варираат од 1\.200 до 2\.000 евра за м²/u, answer);
  assert.ok(!/^Во Карпош I,/mu.test(answer), `never „Во Карпош I“ with a sibling band: ${answer}`);
});

test('an empty numbered area sets no price scope — a later ask is city-wide and says so', async () => {
  const { handler, sessions, sent } = makeHandler(KARPOS_ROWS.filter(r => r.location !== 'Карпош I'));
  const chatId = 'karpos-1-nostrand';
  const s = freshSession('test', chatId);
  s.slots.location = 'Карпош III';
  sessions.set(s);

  await handler.handle('test', chatId, 'KAKVI SE CENITE ZA STANOVI VO KARPOS 1?');
  // The no-data answer must not overwrite the area that DOES have rows, and it
  // must not claim a price scope it never measured.
  assert.equal(sessions.get(chatId)?.slots.location, 'Карпош III');

  sent.length = 0;
  await handler.handle('test', chatId, 'KOJ E NAJEVTINIOT STAN?');
  const answer = sent[sent.length - 1] ?? '';
  // No area in the message, no measured price scope → the whole feed, STATED.
  assert.match(answer, /^Најевтиниот стан во сите населби е со Евидентен број 202/u, answer);
});

test('the extreme lane narrows a numbered area too (KARPOS 3 ≠ IV)', async () => {
  const { handler, sessions, sent } = makeHandler(KARPOS_ROWS);
  const chatId = 'karpos-3-dearest';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'KOJ E NAJSKAPIOT STAN VO KARPOS 3?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /Евидентен број 203/u, answer);
  assert.ok(!/Евидентен број 204/u.test(answer), `Карпош 3 never returns a IV flat: ${answer}`);
});

test('offers without м² are reported as unrankable, never ranked', async () => {
  const rows: Property[] = [
    { eb: 301, id: 301, address: 'Непозната 1', location: 'Центар', price: 90000, service: 'buy', bedrooms: 2 },
  ];
  const { handler, sessions, sent } = makeHandler(rows);
  const chatId = 'no-sqm';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'KOJ E NAJSKAPIOT STAN VO CENTAR?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /без податок за квадратура/u, answer);
  assert.ok(!/Евидентен број 301/u.test(answer), `no card, no invented rank: ${answer}`);
});

test('[16:57] an area with no rows is answered honestly, never with a band', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'capture-1657-empty';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'KAKO SE DVIZAT CENITE ZA STANOVI VO BUTEL?');
  const answer = sent[sent.length - 1] ?? '';
  assert.ok(!/варираат од/u.test(answer), `no invented band: ${answer}`);
  // Но rows in Бутел at all → say so, and never offer "the current offers in
  // Бутел" that do not exist (the earlier wording promised them).
  assert.match(answer, /За Бутел во моментов немам понуди/u, answer);
});

// ── 6. SCOPE, CAP, COMPARATIVES, UNIT AND THE NO-m² LINE ─────────────────────

// A BARE extreme ask is CITY-WIDE — neither the discovery location nor the
// area of the previous band may narrow it (the replay answered „во Центар и
// Карпош III“ for a bare „DAJ MI GO NAJEVTINIOT STAN“). The client narrows by
// NAMING an area (or „Скопје“ for the whole city).
test('a bare extreme ask is city-wide, even right after an area band', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'scope-citywide';
  const s = freshSession('test', chatId);
  s.slots.location = 'Центар (населба), Карпош III';
  sessions.set(s);

  await handler.handle('test', chatId, 'KAKVI SE CENITE ZA STANOVI VO AERODROM?');
  sent.length = 0;
  await handler.handle('test', chatId, 'KOJ E NAJEVTINIOT STAN?');
  const answer = sent[sent.length - 1] ?? '';
  const firstLine = answer.split('\n')[0];
  assert.match(firstLine, /^Најевтиниот стан во сите населби е со Евидентен број 103/u, answer);
  // The CARD may name its own area; the SCOPE sentence must not.
  assert.ok(!/во Аеродром|во Центар|Карпош III/u.test(firstLine), `no stale area: ${answer}`);
});

// „SITE / ШТО ИМА“ is the WHOLE list: the cap scales with the ask instead of
// cutting every plural request at two cards.
test('a „site“ ask serves the whole list, not a pair', async () => {
  const { handler, sessions, sent } = makeHandler(KARPOS_ROWS);
  const chatId = 'cap-site';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'POKAZI GI SITE NAJEVTINI STANOVI VO KARPOS');
  const answer = sent[sent.length - 1] ?? '';
  for (const eb of [201, 202, 203, 204]) {
    assert.match(answer, new RegExp(`Евидентен број ${eb}`, 'u'), `all four rows: ${answer}`);
  }
});

// „ПОЕВТИНИ / ПОСКАПИ ОД <цена>“ is a one-sided ranking against the reference
// the client named, not a lookup of the flat AT that price.
test('comparatives rank strictly on one side of the quoted reference', async () => {
  const cheaper = makeHandler();
  const c1 = 'comparative-cheaper';
  cheaper.sessions.set(freshSession('test', c1));
  await cheaper.handler.handle('test', c1, 'DAJ MI POEVTINI STANOVI OD 1.200 EVRA ZA M2 VO AERODROM');
  const low = cheaper.sent[cheaper.sent.length - 1] ?? '';
  assert.match(low, /^Еве поевтини станови во Аеродром:/u, low);
  assert.match(low, /Евидентен број 103/u, low);
  assert.match(low, /Евидентен број 101/u, low);
  assert.ok(!/Евидентен број 102/u.test(low), `1.218 is not cheaper than 1.200: ${low}`);

  const dearer = makeHandler();
  const c2 = 'comparative-dearer';
  dearer.sessions.set(freshSession('test', c2));
  await dearer.handler.handle('test', c2, 'POKAZI MI POSKAPI STANOVI OD 1.200 EVRA ZA M2 VO AERODROM');
  const high = dearer.sent[dearer.sent.length - 1] ?? '';
  assert.match(high, /^Поскапиот стан во Аеродром е со Евидентен број 102/u, high);
  assert.ok(!/Евидентен број 103/u.test(high), high);
});

// A price quoted WITHOUT „po“ — a whole price beside a property noun — is a
// value lookup too, ranked on the price column.
test('a whole-price ask without „po“ finds the row at that price', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'value-total';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'KOJ E STANOT OD 90.000 EVRA?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /Евидентен број 109/u, answer);
  assert.match(answer, /90\.000 евра/u, answer);
  assert.ok(!/за м² е со/u.test(answer), `a whole price is not a €/m² figure: ${answer}`);
});

// The feed has no period column, so „месечно“ is only claimed when the rent
// figures themselves are monthly-sized.
test('a rent figure that is not monthly-sized drops the monthly claim', async () => {
  const rows: Property[] = [
    ...ROWS.filter(r => r.service !== 'rent'),
    { eb: 120, id: 120, address: 'Јане Сандански 11', location: 'Аеродром', price: 25, sqm: 40, service: 'rent', bedrooms: 1 },
    { eb: 121, id: 121, address: 'Јане Сандански 13', location: 'Аеродром', price: 400, sqm: 50, service: 'rent', bedrooms: 2 },
  ];
  const { handler, sessions, sent } = makeHandler(rows);
  const chatId = 'rent-unit';
  const s = freshSession('test', chatId);
  s.slots.service = 'rent';
  sessions.set(s);

  await handler.handle('test', chatId, 'KAKVI SE CENITE ZA STANOVI VO AERODROM?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /цените за изнајмување на станови варираат од 25 до 400 евра \(единицата не е наведена во огласот\)/u, answer);
  assert.ok(!/месечно/u.test(answer), `no monthly claim the feed cannot back: ${answer}`);
});

test('monthlyRent / rentUnitWord: the unit is read from the rows', () => {
  const rent = (price: number): Property =>
    ({ eb: 1, id: 1, address: '', location: 'Центар', price, service: 'rent' });
  assert.equal(monthlyRent(rent(350)), 350);
  assert.equal(monthlyRent(rent(25)), undefined, 'a per-day figure is not monthly');
  assert.equal(monthlyRent({ ...rent(350), service: 'buy' }), undefined);
  assert.equal(rentUnitWord([rent(350), rent(400)]), 'месечно');
  assert.equal(rentUnitWord([rent(350), rent(25)]), undefined, 'one foreign unit taints the band');
});

// The SAME empty-line wording in a multi-area answer as in a single-area one:
// „no offers“ and „offers without a measurable figure“ are different facts.
test('a multi-area reply distinguishes an empty area from an unmeasurable one', async () => {
  const rows: Property[] = [
    // Центар has an offer, but NO м² → no €/m² figure (not „no offers“).
    { eb: 401, id: 401, address: 'Македонија 30', location: 'Центар', price: 90000, service: 'buy', bedrooms: 2 },
    { eb: 402, id: 402, address: 'Карпош III 5', location: 'Карпош III', price: 104000, sqm: 80, service: 'buy', bedrooms: 2 },
  ];
  const { handler, sessions, sent } = makeHandler(rows);
  const chatId = 'multi-empty-line';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'KAKVI SE CENITE ZA STANOVI VO CENTAR ILI KARPOS?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /^За Центар во моментов немам доволно податоци за цена по м²\.$/mu, answer);
  assert.ok(!/За Центар во моментов немам понуди/u.test(answer), answer);
  assert.match(answer, /^Во Карпош, во моментов имаме една активна понуда: 1\.300 евра за м²\.$/mu, answer);
});

// ── 7. WORDING COVERAGE: ORDERING, BARE FIGURES, SERVICE WORDS, FEE FRAME ──

// The ordering comparatives and the „цена“ superlatives carry no reference and
// no najevtin/najskap token, so they used to match nothing and fell into the
// funnel. They are price ORDERS and must reach the price lane.
test('ordering comparatives and low/high price asks are detected', () => {
  for (const text of [
    'ПОЧНИ ОД ПОЕФТИНИТЕ ВО АЕРОДРОМ',
    'pocni od poevtinite vo aerodrom',
    'pochni od poeftinite vo aerodrom',
    'КОИ СЕ ПОЕФТИНИ ВО АЕРОДРОМ?',
    'koi se poeftini vo aerodrom?',
    'KOJA E NAJNISKATA CENA VO AERODROM?',
    'која е најниската цена во аеродром?',
  ]) {
    assert.equal(extractPriceExtremeQuery(text)?.mode, 'cheapest', `must be cheapest: ${text}`);
    assert.ok(detectPriceExtremeAsk(text), `must fire: ${text}`);
  }
  for (const text of ['KOJA E NAJVISOKATA CENA VO AERODROM?', 'која е највисоката цена во аеродром?']) {
    assert.equal(extractPriceExtremeQuery(text)?.mode, 'expensive', `must be expensive: ${text}`);
  }
  // A bare cheaper SEARCH keeps its own ladder — the price lane must not steal
  // the price.shy contract (cheapest-first from the pool, widen only on yes).
  assert.equal(extractPriceExtremeQuery('daj nesto poeftino vo toj reon'), undefined);
});

test('„почни од поефтините“ serves the cheap end of the named area', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'order-cheaper';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'ПОЧНИ ОД ПОЕФТИНИТЕ ВО АЕРОДРОМ');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /^Еве ги станови со најниска цена во Аеродром:/u, answer);
  assert.match(answer, /Евидентен број 103/u, answer);
  assert.match(answer, /Евидентен број 101/u, answer);
});

test('a low/high price ask without an adjective ranks the same ends', async () => {
  const low = makeHandler();
  const c1 = 'low-price';
  low.sessions.set(freshSession('test', c1));
  await low.handler.handle('test', c1, 'KOJA E NAJNISKATA CENA VO AERODROM?');
  assert.match(low.sent[low.sent.length - 1] ?? '', /^Најевтиниот стан во Аеродром е со Евидентен број 103/u);

  const high = makeHandler();
  const c2 = 'high-price';
  high.sessions.set(freshSession('test', c2));
  await high.handler.handle('test', c2, 'KOJA E NAJVISOKATA CENA VO AERODROM?');
  assert.match(high.sent[high.sent.length - 1] ?? '', /^Најскапиот стан во Аеродром е со Евидентен број 102/u);
});

// A figure without any currency or unit still names a price when the message is
// a who-ask over it („кој е станот од 1286?“, „1286 евра — кој е?“).
test('a bare / „од <figure>“ value ask is answered with the nearest row and a RANGE', async () => {
  for (const text of ['KOJ E STANOT OD 1250?', '1250 EVRA — KOJ E?']) {
    const { handler, sessions, sent } = makeHandler();
    const chatId = 'bare-value-' + text.length;
    sessions.set(freshSession('test', chatId));
    await handler.handle('test', chatId, text);
    const answer = sent[sent.length - 1] ?? '';
    assert.match(answer, /имаме понуди од 1\.100 до 1\.714 евра за м²/u, `the real range: ${text} → ${answer}`);
    assert.match(answer, /Евидентен број 102/u, answer); // 1.218 is the nearest to 1.250
    assert.ok(!/Евидентен број 103\b/u.test(answer), answer);
  }
});

test('a rent value ask that misses the exact figure answers with the range, not a refusal', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'rent-range';
  const s = freshSession('test', chatId);
  s.slots.service = 'rent';
  sessions.set(s);

  await handler.handle('test', chatId, 'KOJ E STANOT OD 300 EVRA?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /имаме понуди од 350 до 400 евра месечно/u, answer);
  assert.ok(!/Нема понуда точно/u.test(answer), `a missing exact 300 is a range, not a refusal: ${answer}`);
});

// „ЦЕНИТЕ ЗА ИЗНАЈМУВАЊЕ ВО АЕРОДРОМ?“ carries no колку/какo scaffold, so it
// never reached the rent band unless the session already held service='rent'.
test('a bare service word selects its own segment for the band', async () => {
  const rent = makeHandler();
  const c1 = 'service-rent';
  rent.sessions.set(freshSession('test', c1)); // NO service in the session
  await rent.handler.handle('test', c1, 'ЦЕНИТЕ ЗА ИЗНАЈМУВАЊЕ ВО АЕРОДРОМ?');
  assert.match(rent.sent[rent.sent.length - 1] ?? '',
    /^Во Аеродром, цените за изнајмување на станови варираат од 350 до 400 евра месечно/u);

  const rent2 = makeHandler();
  const c2 = 'service-kirija';
  rent2.sessions.set(freshSession('test', c2));
  await rent2.handler.handle('test', c2, 'kolku e kirijata vo aerodrom?');
  assert.match(rent2.sent[rent2.sent.length - 1] ?? '',
    /^Во Аеродром, цените за изнајмување на станови/u);

  const buy = makeHandler();
  const c3 = 'service-buy';
  buy.sessions.set(freshSession('test', c3));
  await buy.handler.handle('test', c3, 'ЦЕНИ ЗА КУПУВАЊЕ ВО АЕРОДРОМ?');
  const answer = buy.sent[buy.sent.length - 1] ?? '';
  assert.match(answer, /^Во Аеродром, цените варираат од 1\.100 до 1\.218 евра за м²/u, answer);
  assert.ok(!/изнајмување/u.test(answer), answer);
});

// THE FEE FRAME is structural: a fee noun beside a figure is fee traffic even
// when none of the named fee detectors knows the wording — the value reader
// must never serve a property card for it.
test('a fee frame with a price figure never reaches the property reader', async () => {
  assert.equal(isFeeFrame('ZA SEKOJ STAN PO 300DEN'), true);
  assert.equal(isFeeFrame('STANOT PO 1.200 EVRA ZA RAZGLEDUVANJE — KOJ E?'), true);
  assert.equal(isFeeFrame('KOJ E STANOT OD 1.200 EVRA ZA M2?'), false, 'a property price is not a fee frame');
  assert.equal(isFeeFrame('POKAZI GI SITE NAJEVTINI STANOVI VO KARPOS'), false, 'the show verb is not a fee noun');

  const { handler, sessions, sent } = makeHandler();
  const chatId = 'fee-frame';
  sessions.set(freshSession('test', chatId));
  await handler.handle('test', chatId, 'STANOT PO 1.200 EVRA ZA RAZGLEDUVANJE — KOJ E?');
  const answer = sent[sent.length - 1] ?? '';
  assert.ok(!/Евидентен број/u.test(answer), `never a property card for fee traffic: ${answer}`);
});

// ── 8. SERVING LIMITS: LIST PAGING, THIN BANDS, AREA-LESS ROWS ──────────────

// „ПОКАЖИ ГИ СИТЕ / ШТО ИМА“ is the whole list: five cards, and the follow-up
// „уште?“ continues the SAME ranked list (the discovery ladder never built a
// queue from this lane, so the remaining rows were unreachable).
test('„покажи ги сите“ serves five and „уште?“ continues the same list', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'list-paging';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'POKAZI GI SITE STANOVI');
  const first = sent[sent.length - 1] ?? '';
  assert.match(first, /^Еве ги сите станови:/u, first);
  // Ascending €/m²: 103 (1.100), 101 (1.113), 106 (1.200), 102 (1.218), 109 (1.286).
  for (const eb of [103, 101, 106, 102, 109]) {
    assert.match(first, new RegExp(`Евидентен број ${eb}`, 'u'), `first page: ${first}`);
  }
  assert.ok(!/Евидентен број 107/u.test(first), `only five on the first page: ${first}`);

  sent.length = 0;
  await handler.handle('test', chatId, 'УШТЕ?');
  const second = sent[sent.length - 1] ?? '';
  assert.match(second, /^Еве уште станови:/u, second);
  for (const eb of [107, 108, 105]) {
    assert.match(second, new RegExp(`Евидентен број ${eb}`, 'u'), `second page: ${second}`);
  }

  // The queue is spent: the next „уште?“ is the ordinary lane's answer, never a
  // repeat of this list.
  sent.length = 0;
  await handler.handle('test', chatId, 'УШТЕ?');
  const third = sent[sent.length - 1] ?? '';
  assert.ok(third.length > 0, 'an answer is still produced');
  assert.ok(!/^Еве уште/u.test(third), `the list queue is spent: ${third}`);
});

// ONE row is a listing, not a price level: the band says so instead of dressing
// a single offer up as „цените се околу“.
test('a one-row band is stated as a single offer', async () => {
  const sales = makeHandler(KARPOS_ROWS.filter(r => r.location === 'Карпош III'));
  const c1 = 'thin-band-sale';
  sales.sessions.set(freshSession('test', c1));
  await sales.handler.handle('test', c1, 'KAKVI SE CENITE ZA STANOVI VO KARPOS?');
  const sale = sales.sent[sales.sent.length - 1] ?? '';
  assert.match(sale, /^Во Карпош, во моментов имаме една активна понуда: 1\.300 евра за м²\./u, sale);
  assert.ok(!/цените се околу/u.test(sale), `never „цените се околу“ off one row: ${sale}`);

  const rent = makeHandler(ROWS.filter(r => r.eb !== 110));
  const c2 = 'thin-band-rent';
  const s = freshSession('test', c2);
  s.slots.service = 'rent';
  rent.sessions.set(s);
  await rent.handler.handle('test', c2, 'KAKVI SE CENITE ZA STANOVI ZA IZNAJMUVANJE VO AERODROM?');
  const rentAnswer = rent.sent[rent.sent.length - 1] ?? '';
  assert.match(rentAnswer, /една активна понуда: 350 евра месечно/u, rentAnswer);
});

// A row the feed leaves area-less joins its area through its OWN ad text — the
// October feed has such rows (EB 57/59/87) that no area-scoped ask could see.
test('an area-less row joins its area band through its own ad text', async () => {
  assert.equal(deriveAreaFromText('Се издава деловен простор во Строг Центар'), 'Центар');
  assert.equal(deriveAreaFromText('Се издава Деловен Простор во Палома Бјанка од 105 м2'), 'Центар');
  assert.equal(deriveAreaFromText('Се продава стан во Ново Лисиче, близу училиште'), 'Ново Лисиче');
  assert.equal(deriveAreaFromText('стан без наведена населба'), undefined);

  const mapped = mapRow({
    evidenten_broj: '57', adresa: 'Ѓуро Стругар', servis: 'Издава', cena_eur: 1000,
    opis: 'Се издава деловен простор во Строг Центар, можен попуст.',
  });
  assert.equal(mapped?.location, 'Центар', 'mapRow fills the area from the ad text');
  const unmapped = mapRow({ evidenten_broj: '999', adresa: 'Непозната', servis: 'Издава', cena_eur: 900, opis: '' });
  assert.equal(unmapped?.location, undefined, 'no alias hit → still area-less');

  const rows: Property[] = [
    { eb: 501, id: 501, address: 'Македонија 5', location: 'Центар', price: 105000, sqm: 70, service: 'buy' },
    // No location — but the ad text says Строг Центар.
    { eb: 502, id: 502, address: 'Ѓуро Стругар', price: 95000, sqm: 76, service: 'buy', details: 'Се продава стан во Строг Центар.' },
    // No area anywhere: city-wide only, never in a named area.
    { eb: 503, id: 503, address: 'Непозната 1', price: 60000, sqm: 50, service: 'buy' },
  ];
  assert.equal(feedArea(rows[1]), 'Центар');
  assert.equal(feedArea(rows[2]), undefined);
  assert.deepEqual(rowsInArea(rows, 'Центар').map(p => p.eb), [501, 502]);

  const { handler, sessions, sent } = makeHandler(rows);
  const chatId = 'area-less-band';
  sessions.set(freshSession('test', chatId));
  await handler.handle('test', chatId, 'KAKVI SE CENITE ZA STANOVI VO CENTAR?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /цените варираат од 1\.250 до 1\.500 евра за м²/u, `both Центaр rows, no 1.200: ${answer}`);
});
