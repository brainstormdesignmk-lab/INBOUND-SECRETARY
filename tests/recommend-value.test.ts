// 「Which of these two is the better deal?」 — a choice question with a price
// yardstick. The client wants the price-per-m² arithmetic; the close alone
// („секоја недвижнина е различна, видете во живо“) answers a question he did
// not ask, and picking a favourite is not Lina's call.
//
// The contract pinned here:
//   • €/m² is computed from the feed's own price and sqm — never guessed;
//   • rows without both numbers are DROPPED, not ranked on one of them;
//   • the answer names which is cheaper PER SQUARE METRE (a fact) and still
//     hands the decision to the client (the visit close follows);
//   • fewer than two comparable rows → the plain recommendation close, never a
//     ranking of one number against nothing.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectValueAsk, buildValueRanking, valueRows } from '../src/llm/recommend';
import { Property } from '../src/data/properties';
import { InboundHandler } from '../src/handlers/inbound';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { SessionStore, freshSession } from '../src/fsm/session';
import { PropertyService } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { LandmarkService } from '../src/geo/landmarks';
import { Db } from '../src/store/db';
import { loadConfig } from '../src/config';
import { setLearnedBank } from '../src/data/responseBank';

setLearnedBank({
  variants: () => [], addVariant: () => false, addExample: () => false,
  metric: () => {}, retrieve: () => undefined,
} as any);

test('value-ask detector: the price-per-m² yardstick, both scripts', () => {
  assert.equal(detectValueAsk('koja e podobra vrednost ?'), true);
  assert.equal(detectValueAsk('shto e isplatlivo?'), true);
  assert.equal(detectValueAsk('koj e poevtin po kvadrat?'), true);
  assert.equal(detectValueAsk('koja e cenata za m2?'), true);
  assert.equal(detectValueAsk('која е подобра вредност?'), true);
  assert.equal(detectValueAsk('што се исплати повеќе?'), true);
  assert.equal(detectValueAsk('which is best value?'), true);
  // Not a value ask: a plain price question, a location question, a plain choice.
  assert.equal(detectValueAsk('kolku chini stanot 89?'), false);
  assert.equal(detectValueAsk('kade e kafeto?'), false);
  assert.equal(detectValueAsk('koja opcija bi mi ja preporacale ?'), false);
});

const row = (eb: number, price: number, sqm: number): Property =>
  ({ eb, id: eb, address: '', location: 'Центар', price, sqm, service: 'buy' } as Property);

test('buildValueRanking: cheapest per m² first, both figures shown', () => {
  const out = buildValueRanking([row(95, 204000, 74), row(84, 117000, 48)]);
  assert.ok(out, 'two comparable rows must produce a ranking');
  assert.match(out, /Гледано по цена за квадрат/);
  // 117000/48 = 2438, 204000/74 = 2757 → 84 first, with its own label.
  assert.match(out, /Евидентен број 84 — 2\.438 евра за квадрат \(стан, 48 м² за 117\.000 евра\) — најниска цена за квадрат/);
  assert.match(out, /Евидентен број 95 — 2\.757 евра за квадрат \(стан, 74 м² за 204\.000 евра\)/);
  assert.match(out, /Најмалку по квадрат излегува Евидентен број 84/);
  assert.match(out, /319 евра разлика по квадрат/);
  // The arithmetic is offered as one part of the picture — never a verdict.
  assert.match(out, /само еден дел од сликата/);
});

// ── EVERY CATEGORY, NOT JUST FLATS ──────────────────────────────────────────
// The feed carries houses, business spaces and land plots beside the flats,
// and a client compares ANY two listings he was shown. Two type gaps are
// pinned here:
//   (1) the surface often exists only as the `size` STRING („600 м²“) while
//       the numeric column is empty — reading `p.sqm` alone silently dropped
//       every house/plot/local whose area lived in the text;
//   (2) the words that close the ranking must match the rows — „спратот“ is
//       meaningless for a plot, and a mixed pair must not be described with
//       one category's vocabulary.
const land = (eb: number, price: number, size: string): Property =>
  ({ eb, id: eb, address: '', location: 'Центар', price, size, service: 'buy', plac: true } as Property);
const house = (eb: number, price: number, size: string): Property =>
  ({ eb, id: eb, address: '', location: 'Влае', price, size, service: 'buy', house: true } as Property);
const shop = (eb: number, price: number, size: string): Property =>
  ({ eb, id: eb, address: '', location: 'Центар', price, size, service: 'buy', business: true } as Property);

test('buildValueRanking: houses, business spaces and land plots are ranked too', () => {
  const out = buildValueRanking([house(78, 185000, '82 м²'), land(50, 60000, '600 м²'), shop(57, 90000, '45 м²')]);
  assert.ok(out, 'all three categories carry a price and an area, so all three rank');
  // 60.000/600 = 100 €/m² → the plot leads, read from the size STRING.
  assert.match(out!, /\(плац, 600 м² за 60\.000 евра\) — најниска цена за квадрат/);
  assert.match(out!, /\(деловен простор, 45 м² за 90\.000 евра\)/);
  assert.match(out!, /\(куќа, 82 м² за 185\.000 евра\)/);
  assert.match(out!, /Најмалку по квадрат излегува Евидентен број 50/);
  // Mixed categories: the shared facts only — no category's own vocabulary.
  assert.match(out!, /состојбата и локацијата не се гледаат во бројки/);
  assert.doesNotMatch(out!, /спратот/);
});

test('buildValueRanking: the tail sentence speaks the rows\' own category', () => {
  const plots = buildValueRanking([land(50, 60000, '600 м²'), land(51, 90000, '700 м²')]);
  assert.match(plots!, /пристапот, формата и локацијата на плацот не се гледаат во бројки/);
  const houses = buildValueRanking([house(78, 185000, '82 м²'), house(79, 210000, '95 м²')]);
  assert.match(houses!, /состојбата, дворот и локацијата не се гледаат во бројки/);
  const flats = buildValueRanking([row(84, 117000, 48), row(95, 204000, 74)]);
  assert.match(flats!, /состојбата, спратот и локацијата не се гледаат во бројки/);
});

test('buildValueRanking: a plot without an area is not ranked on a guessed size', () => {
  const noArea = { eb: 52, id: 52, address: '', location: 'Центар', price: 60000, service: 'buy', plac: true } as Property;
  assert.equal(valueRows([noArea, row(84, 117000, 48)]).length, 1, 'the area-less plot drops out');
  assert.equal(buildValueRanking([noArea, noArea]), undefined, 'two area-less rows are not a comparison');
});

test('buildValueRanking: rows missing a price or a size are dropped, not ranked', () => {
  assert.equal(buildValueRanking([row(84, 117000, 48)]), undefined, 'one row is not a comparison');
  assert.equal(buildValueRanking([]), undefined);
  const partial = [row(84, 117000, 48), { eb: 90, id: 90, address: '', location: 'Центар', price: 99000 } as Property];
  assert.equal(valueRows(partial).length, 1, 'a row without sqm cannot be ranked on €/m²');
  assert.equal(buildValueRanking(partial), undefined);
});

class FailingLlm { async complete(): Promise<string> { throw new Error('429 quota exhausted'); } }
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [row(84, 117000, 48), row(95, 204000, 74)];

function makeHandler(rows: Property[] = ROWS): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(rows);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({ cfg, db, sessions,
    classifier: new Classifier(llm, cfg, properties), responder: new Responder(llm, cfg),
    properties, appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels, landmarks: new LandmarkService(db, { osm: false }) });
  return { handler, sessions, sent };
}

const FEE_RE = /(надомест|денар|символичн|провизи|10 евра)/iu;

test('closing state: „koja e podobra vrednost?“ ranks the two flats on the table', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'value-closing';
  const s = freshSession('test', chatId);
  s.state = 'closing';
  s.slots = { service: 'buy', presentedIds: [84, 95] };
  s.history = [{ role: 'user', text: 'SE MISLAM MEGJU OVIE DVE' }];
  sessions.set(s);

  await handler.handle('test', chatId, 'koja e podobra vrednost, shto e isplatlivo ?');
  const reply = sent.at(-1) ?? '';

  assert.ok(!FEE_RE.test(reply), `fee wording reached a value question: ${reply}`);
  assert.match(reply, /евра за квадрат/, `the yardstick must be served: ${reply}`);
  assert.match(reply, /Евидентен број 84 — 2\.438 евра за квадрат/);
  assert.match(reply, /Евидентен број 95 — 2\.757 евра за квадрат/);
  assert.match(reply, /Најмалку по квадрат излегува Евидентен број 84/);
  // The choice is still the client's — the visit close follows the ranking.
  assert.match(reply, /посет|осети|види лично/);
  assert.equal(sessions.get(chatId)!.state, 'closing');
});

// END-TO-END, NON-FLAT ROWS: nothing upstream of the ranking filters by type —
// a house beside a plot is a legitimate pair to compare, and both the card path
// and the close already know their category nouns.
test('closing state: a house and a plot are compared on €/m² like any pair', async () => {
  const { handler, sessions, sent } = makeHandler([house(78, 185000, '82 м²'), land(50, 60000, '600 м²')]);
  const chatId = 'value-types';
  const s = freshSession('test', chatId);
  s.state = 'closing';
  s.slots = { service: 'buy', presentedIds: [78, 50] };
  s.history = [{ role: 'user', text: 'GOLEDAV KUKJA 78 I PLAC 50' }];
  sessions.set(s);

  await handler.handle('test', chatId, 'koja e podobra vrednost megu dvete ?');
  const reply = sent.at(-1) ?? '';

  assert.match(reply, /\(плац, 600 м² за 60\.000 евра\) — најниска цена за квадрат/, `the plot must rank first: ${reply}`);
  assert.match(reply, /\(куќа, 82 м² за 185\.000 евра\)/, `the house must be ranked beside it: ${reply}`);
  assert.match(reply, /Најмалку по квадрат излегува Евидентен број 50/, reply);
  assert.doesNotMatch(reply, /спратот/, 'a house+plot pair has no shared floor fact');
  assert.ok(!FEE_RE.test(reply), `fee wording reached a value question: ${reply}`);
  assert.match(reply, /посет|осети|види лично/);
});

test('one comparable flat: no ranking, the plain close stands', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'value-single';
  const s = freshSession('test', chatId);
  s.state = 'closing';
  s.slots = { service: 'buy', propertyId: 84, presentedIds: [84] };
  sessions.set(s);

  await handler.handle('test', chatId, 'shto e isplatlivo ?');
  const reply = sent.at(-1) ?? '';

  assert.doesNotMatch(reply, /евра за квадрат/, `one flat cannot be ranked: ${reply}`);
  assert.match(reply, /посет|осети|види лично/);
  assert.ok(!FEE_RE.test(reply), `fee wording: ${reply}`);
});
