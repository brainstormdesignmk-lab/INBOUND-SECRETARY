// THE MULTI-PROPERTY VISIT ENTRY (the owner's 2026-11-24 brief, the [18:07]
// TUI capture):
//
//   [18:03] NA KOLKAVO RASTOJANIE SE 88 I 82 OD KAPITOL ?      (two-flat thread)
//   [18:07] ЛИНА: Кој термин би Ви одговарал за посета?         ← asked a TERM
//                  Да се обидам да договорам со сопствениците…
//   [18:07] ZADUTRE POPLADNE
//   [18:07] ЛИНА: Ќе го проверам со сопственикот, но прво — точно во колку часот?
//   [18:08] OD 5
//   [18:08] ЛИНА: Супер, денот е забележан. … во колку часот точно?
//   [18:08] 5
//   [18:08] ЛИНА: Забележав 17:00. Кој ден Ви одговара за посетата?  ← DAY LOST
//
// Three defects, all pinned here:
//   1. she asked for a TERM before telling him that several flats are a ROUTE
//      of one-hour visits — so he could not know that his afternoon fits only
//      some of them, nor choose which to leave for another day;
//   2. «од 5» (a start, after he had named the afternoon) was read as vague,
//      and the hour was asked a third time;
//   3. a repeated bare hour REPLACED the whole term, wiping the day he had
//      already named («Забележав 17:00. Кој ден…»).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { OwnerStore } from '../src/store/owners';
import { EventStore } from '../src/store/events';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { DeferredOwnerAgent } from '../src/backoffice/ownerAgent';
import { detectVisitDayChoice } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const ROWS: Property[] = [88, 82, 77].map((eb, i) => ({
  eb, id: eb, address: `Ул. Тест ${i + 1}`, location: 'Аеродром',
  price: 100000 + eb * 100, sqm: 55, service: 'buy', bedrooms: 2,
  lat: 41.99 + i * 0.001, lon: 21.45 + i * 0.001,
} as Property));

class FakeProps extends PropertyService {
  constructor() { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return ROWS; }
  async getAllEbs(): Promise<Set<number>> { return new Set(ROWS.map(r => r.eb)); }
  async getByEb(eb: number): Promise<Property | undefined> { return ROWS.find(r => r.eb === eb); }
  async locations(): Promise<string[]> { return ['Аеродром']; }
  get healthy(): boolean { return true; }
}

function makeHandler(chatId: string, ebs: number[] = [88, 82, 77]) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const sent: string[] = [];
  const asks: string[] = [];
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const props = new FakeProps();
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false }),
    ownerAgent: new DeferredOwnerAgent(new OwnerStore(db), new EventStore(db), 600_000, 60_000),
  });
  handler.onOwnerAsk = (_c: string, eb: number, q: string) => { asks.push(`[${eb}] ${q}`); };
  const session = freshSession('test', chatId);
  session.state = 'visit_scheduling';
  session.slots.service = 'buy';
  session.slots.visitWanted = true;
  session.slots.visitEbs = ebs;
  session.slots.presentedIds = ebs;
  session.slots.currentBatch = ebs;
  session.slots.clientName = 'Дафина';
  session.slots.clientPhone = '076 723 456';
  sessions.set(session);
  const say = async (m: string) => {
    sent.length = 0;
    asks.length = 0;
    await handler.handle('test', chatId, m);
    return { reply: sent[sent.length - 1] ?? '', asks: [...asks], slots: sessions.get(chatId)!.slots };
  };
  return { say, sessions, chatId, db };
}

/** The date «задутре» resolves to, in the protocol's own rendering. */
const dayAfterTomorrow = (): string => {
  const d = new Date();
  d.setDate(d.getDate() + 2);
  return `${String(d.getDate()).padStart(2, '0')}.${String(d.getMonth() + 1).padStart(2, '0')}.${d.getFullYear()}`;
};

test('the entry question: one day or several, with the hour-per-visit rule', async () => {
  const { say, db } = makeHandler('day-choice');
  const { reply } = await say('SAKAM DA GI VIDAM TROTE');
  assert.match(reply, /ист ден/u, `the one-day option is named: ${reply}`);
  assert.match(reply, /различни денови/u, `the several-days option is named: ${reply}`);
  assert.match(reply, /еден час/u, `the hour-per-visit rule is stated: ${reply}`);
  assert.match(reply, /\?/u, `it is a question: ${reply}`);
  // It must NOT ask for a term yet — that was the capture's first defect.
  assert.ok(!/Кој термин би Ви одговарал/u.test(reply), `no term before the shape: ${reply}`);
  db.close();
});

test('same-day answer: the term question follows, once', async () => {
  const { say, db } = makeHandler('day-same');
  await say('SAKAM DA GI VIDAM TROTE');
  const same = await say('VO IST DEN');
  assert.equal(same.slots.visitDayChoice, 'same');
  assert.match(same.reply, /Кој термин би Ви одговарал|термин/u, `the term is asked: ${same.reply}`);
  assert.ok(!/различни денови/u.test(same.reply), `the choice is not asked twice: ${same.reply}`);
  db.close();
});

test('split answer: which flats first, and the term for them', async () => {
  const { say, db } = makeHandler('day-split');
  await say('SAKAM DA GI VIDAM TROTE');
  const split = await say('RAZLICNI DENOVI');
  assert.equal(split.slots.visitDayChoice, 'split');
  assert.match(split.reply, /прво/u, `the first group is asked for: ${split.reply}`);
  assert.match(split.reply, /друг ден/u, `the rest are promised their own day: ${split.reply}`);

  // He names the first group AND a term: the route starts on THOSE flats, the
  // third one is left for another day (never described as an info ask).
  const route = await say('PRVO 88 I 82, ZADUTRE OD 5');
  assert.equal(route.asks.length, 2, `only the named group is asked: ${route.asks.join(' | ')}`);
  assert.ok(route.asks[0]!.startsWith('[88]'), `the first flat he named leads: ${route.asks[0]}`);
  assert.ok(!route.asks.some(a => a.startsWith('[77]')), `the third flat is NOT asked today: ${route.asks.join(' | ')}`);
  assert.match(route.reply, /17:00/u, `the route starts at the hour he named: ${route.reply}`);
  assert.match(route.reply, /18:00/u, `and the second visit is the next hour: ${route.reply}`);
  assert.ok(!/19:00/u.test(route.reply), `nothing beyond the group he chose: ${route.reply}`);
  assert.ok(!/Еве ги и двата/u.test(route.reply), `never the identity lane: ${route.reply}`);
  db.close();
});

test('the day he named survives the hour: «ZADUTRE POPLADNE» → «OD 5»', async () => {
  const { say, db } = makeHandler('day-keep');
  await say('SAKAM DA GI VIDAM TROTE');
  await say('VO IST DEN');
  const day = await say('ZADUTRE POPLADNE');
  // CASE-INSENSITIVE ON PURPOSE (the [05:58]/variant rotation): the bank has
  // this ask both mid-sentence («…но прво — точно во колку часот?») and as its
  // own sentence («Во колку часот точно?»), and this test used to fail about
  // one run in three when the capital-В variant was served — a copy rotation,
  // never a state bug (AGENTS.md §5: pin the class, not the wording).
  assert.ok(/во колку|точниот час|точно во/iu.test(day.reply), `the clock is asked: ${day.reply}`);
  // A start hour after a named afternoon is an ANSWER, not a vague window (the
  // capture asked «точно во колку часот?» a second time here).
  const start = await say('OD 5');
  assert.equal(start.asks.length, 3, `the route goes out at once: ${start.asks.join(' | ')}`);
  assert.match(start.slots.visitTime ?? '', /17:00|од 5|OD 5/iu, `the hour is kept on file: ${start.slots.visitTime}`);
  assert.match(start.reply, new RegExp(dayAfterTomorrow().replace(/\./g, '\\.'), 'u'),
    `the day he named is the day arranged: ${start.reply}`);
  assert.ok(!/Забележав 17:00\. Кој ден/u.test(start.reply), `the day is never re-asked: ${start.reply}`);
  db.close();
});

test('detectVisitDayChoice: the answer family, in both scripts', () => {
  for (const t of ['VO IST DEN', 'vo eden den', 'SITE ZAEDNO', 'сите заедно', 'ист ден']) {
    assert.equal(detectVisitDayChoice(t), 'same', `same-day: ${t}`);
  }
  for (const t of ['RAZLICNI DENOVI', 'razlicni denovi', 'PODELI', 'одделно', 'друг ден', 'DVA DENA']) {
    assert.equal(detectVisitDayChoice(t), 'split', `split: ${t}`);
  }
  // A day or an hour is NOT this answer.
  for (const t of ['ZADUTRE POPLADNE', 'VO 5', 'PETOK', '88 I 82']) {
    assert.equal(detectVisitDayChoice(t), undefined, `not a choice: ${t}`);
  }
});
