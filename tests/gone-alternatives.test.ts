// THE SOLD-PROPERTY CONTRACT (the [12:08] capture):
//   „За жал, недвижноста со евидентен број 94 е продаден. Веднаш ќе проверам
//    што друго имаме…"
// Two failures: the predicate agreed with „број“ instead of „недвижност“, and
// the reply was a STATEMENT — the funnel died on a sold property with no cue
// for the client. The contract now:
//   1. „недвижноста … е ПРОДАДЕНА“ (feminine, whatever shape the owner's note
//      arrived in — never a doubled copula from a full-sentence note);
//   2. the notice ends with the OFFER: „Дали би сакале да Ви понудам нешто
//      друго со слични карактеристики?";
//   3. an agreement serves the next PAIR on the gone property's own profile —
//      rooms, area, a price band around its price — and the normal ladder
//      carries the remaining pairs until the client chooses or changes criteria.
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
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

const ROWS: Property[] = [
  { eb: 94, id: 94, location: 'Кисела Вода', address: 'Тоне Томшиќ 25', price: 92000,
    service: 'buy', bedrooms: 2, sqm: 56, details: 'Двособен стан.' },
  // Same area, same room count, inside the ±15 % band of 92.000.
  { eb: 101, id: 101, location: 'Кисела Вода', address: 'Ул. А 1', price: 95000,
    service: 'buy', bedrooms: 2, sqm: 58, details: 'Двособен стан.' },
  { eb: 102, id: 102, location: 'Кисела Вода', address: 'Ул. Б 2', price: 88000,
    service: 'buy', bedrooms: 2, sqm: 54, details: 'Двособен стан.' },
  // Wrong room count / wrong area / out of band — never in the first pair.
  { eb: 103, id: 103, location: 'Кисела Вода', address: 'Ул. В 3', price: 99000,
    service: 'buy', bedrooms: 3, sqm: 70, details: 'Трисобен стан.' },
  { eb: 104, id: 104, location: 'Центар', address: 'Ул. Г 4', price: 93000,
    service: 'buy', bedrooms: 2, sqm: 57, details: 'Двособен стан.' },
  { eb: 105, id: 105, location: 'Кисела Вода', address: 'Ул. Д 5', price: 200000,
    service: 'buy', bedrooms: 2, sqm: 90, details: 'Двособен стан.' },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler() {
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(llm, cfg, properties),
    responder: new Responder(llm, cfg),
    properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent, db };
}

/** A session sitting at the owner verdict for EB 94, then the GONE relay.
 *  The owner-bound messages are captured so the sale congratulation is tested
 *  as a separate channel from the client reply. */
async function goGone(note: string) {
  const { handler, sessions, sent, db } = makeHandler();
  const ownerMessages: string[] = [];
  handler.onOwnerMessage = (_chatId, _eb, text) => { ownerMessages.push(text); };
  const chatId = 'gone-client';
  const s = freshSession('test', chatId);
  s.state = 'owner_checking';
  s.slots.propertyId = 94;
  s.slots.interestedPropertyId = 94;
  s.slots.service = 'buy';
  sessions.set(s);
  await (handler as any).applyOwnerVerdict(chatId, 94, { status: 'gone', note });
  return { handler, sessions, sent, db, chatId, ownerMessages };
}

test('sold notice: feminine agreement + the offer question (owner note "продаден")', async () => {
  const { sessions, sent, chatId, db } = await goGone('продаден');
  const reply = sent[sent.length - 1];
  assert.ok(/е\s+продадена/u.test(reply), `must agree with „недвижност“: ${reply}`);
  assert.ok(!/е\s+продаден\b/u.test(reply), `never the masculine form: ${reply}`);
  assert.ok(!/е\s+недвижноста/u.test(reply), `never a doubled copula: ${reply}`);
  assert.ok(/Дали би сакале да Ви понудам нешто друго со слични карактеристики\?/u.test(reply),
    `the notice must ASK: ${reply}`);
  assert.equal(sessions.get(chatId)!.slots.goneAlternativesEb, 94, 'the offer is armed for the next turn');
  db.close();
});

test('a SALE congratulates the OWNER, on the owner channel — before the client relay', async () => {
  const { ownerMessages, sent, db } = await goGone('продаден');
  assert.deepEqual(ownerMessages, ['Ви честитам на продажбата. Се најдобро.'],
    `the owner must hear the good news: ${JSON.stringify(ownerMessages)}`);
  // The client never sees the congratulation — it is the owner's message.
  assert.ok(!sent.some(t => /честитам/u.test(t)), `client replies: ${JSON.stringify(sent)}`);
  db.close();
});

test('the TUI owner note "продаден" (the deferred /owner path) also congratulates', async () => {
  const { ownerMessages, db } = await goGone('недвижноста е продадена');
  assert.equal(ownerMessages.length, 1, 'one congratulation per sold verdict');
  db.close();
});

test('a RENTED verdict is not a sale: no congratulation, client hears "издадена"', async () => {
  const { ownerMessages, sent, db } = await goGone('издаден');
  assert.deepEqual(ownerMessages, [], 'never congratulate a rental as a sale');
  const reply = sent[sent.length - 1];
  assert.ok(/е\s+издадена/u.test(reply), reply);
  db.close();
});

test('sold notice: a full-sentence owner note does not double the copula', async () => {
  const { sent, db } = await goGone('недвижноста е продадена');
  const reply = sent[sent.length - 1];
  assert.ok(reply.includes('недвижноста со Евидентен број 94 е продадена.'), reply);
  assert.ok(!/е\s+недвижноста/u.test(reply), reply);
  db.close();
});

test('YES serves a pair on the gone property\'s profile: rooms + area + price band', async () => {
  const { handler, sessions, sent, chatId, db } = await goGone('продаден');
  await handler.handle('test', chatId, 'da');

  const reply = sent[sent.length - 1];
  const s = sessions.get(chatId)!;
  assert.equal(s.state, 'presentation');
  assert.equal(s.slots.goneAlternativesEb, undefined, 'the offer is consumed');
  assert.equal(s.slots.bedrooms, 2, 'rooms follow the gone property');
  assert.equal(s.slots.location, 'Кисела Вода', 'area follows the gone property');
  assert.equal(s.slots.currentBatch?.length, 2, `a PAIR is served: ${JSON.stringify(s.slots.currentBatch)}`);
  assert.ok(s.slots.currentBatch!.every(id => id !== 94), 'the sold row never returns');
  assert.ok(s.slots.currentBatch!.every(id => id !== 104), `another area must not ride in: ${reply}`);
  assert.ok(s.slots.currentBatch!.every(id => id !== 105), `the 200.000 row is out of band: ${reply}`);
  assert.ok(/Секако\. Еве ги сличните недвижности/u.test(reply), reply);
  assert.ok(/Ако не, веднаш ќе Ви покажам уште опции/u.test(reply), reply);
  db.close();
});

test('the ladder continues with the NEXT pair, then offers the widen', async () => {
  const { handler, sessions, sent, chatId, db } = await goGone('продаден');
  await handler.handle('test', chatId, 'da');
  const firstPair = [...(sessions.get(chatId)!.slots.currentBatch ?? [])];
  assert.equal(firstPair.length, 2);

  await handler.handle('test', chatId, 'ne mi se dopagaat, daj drugi');
  const s = sessions.get(chatId)!;
  const secondPair = s.slots.currentBatch ?? [];
  assert.ok(secondPair.length > 0, 'a rejection walks the ladder, never a dead end');
  assert.ok(secondPair.every(id => !firstPair.includes(id)), `fresh rows only: ${JSON.stringify(secondPair)}`);

  // The pool is small: one more rejection reaches the honest exhausted ask.
  await handler.handle('test', chatId, 'ne mi se dopagaat, daj drugi');
  const last = sent[sent.length - 1];
  // Bank-drawn family: the wording varies ("ги исцрпивме" / "ги разгледавме
  // сите понуди" / "друга населба" / "друг дел од градот") — assert the family,
  // not one phrasing.
  assert.ok(/(?:исцрпивме|разгледавме|прегледавме|сите[^.]{0,40}понуди|друга населба|друг дел од градот)/iu.test(last), last);
  db.close();
});

test('"ne" consumes the offer and never serves alternatives', async () => {
  const { handler, sessions, sent, chatId, db } = await goGone('продаден');
  await handler.handle('test', chatId, 'ne, ne mi treba');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.goneAlternativesEb, undefined, 'the offer is one-shot');
  assert.equal(s.slots.currentBatch, undefined, 'no pair was served');
  assert.ok(!/Еве ги сличните недвижности/u.test(sent[sent.length - 1]), 'no alternative cards');
  db.close();
});
