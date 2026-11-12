// «ШТО УШТЕ ИМАТЕ ?» IS A REQUEST FOR STOCK, NOT A BOOKING
// (the operator's [12:41]/[13:08] field capture, 2026-11-12)
//
//   [12:41] ЛИНА: …Што мислите за понудените опции, дали некоја од нив Ви
//                  одговара за да организирам посета?
//   [12:41] НЕ СЕ ЛОШИ АМА САКАМ ДА ВИДАМ УШТЕ АКО ИМАТЕ
//   [12:41] ЛИНА: Посетата е за станот со Евидентен број 84 … 500 денари …
//   [13:08] ШТО УШТЕ ИМАТЕ ?
//   [13:08] ЛИНА: Евидентен број 50 · куќа … Дали би сакале да го исконтактирам
//                  сопственикот …?
//
// Both messages fell through the whole deterministic chain (the route log says
// FALLTHROUGH), so the responder answered with the protocol of the flats
// already on the table: a client asking for MORE STOCK was pushed into a
// booking, and the second turn repeated a property he had already seen.
//
// The contract this file pins:
//   1. a more-stock ask after a served pair serves the NEXT pair of the SAME
//      search, never a property already in presentedIds;
//   2. it never carries the visit fee / availability protocol;
//   3. a drained pool gets the honest exhausted line and the pivot;
//   4. the detector stays narrow — «дали е уште достапна» is a stock question
//      about one flat, never a more-ask.
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
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { detectMoreStockRequest } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// Five two-bedroom flats in Центар. The funnel serves two, so a more-ask has
// to hand over the third and fourth — and never one of the first two again.
const ROWS: Property[] = [
  { eb: 81, id: 81, location: 'Центар', address: 'Ул. А 1', price: 100000, service: 'buy', bedrooms: 2, sqm: 52, details: 'Двособен стан.' },
  { eb: 82, id: 82, location: 'Центар', address: 'Ул. Б 2', price: 105000, service: 'buy', bedrooms: 2, sqm: 55, details: 'Двособен стан.' },
  { eb: 83, id: 83, location: 'Центар', address: 'Ул. В 3', price: 110000, service: 'buy', bedrooms: 2, sqm: 58, details: 'Двособен стан.' },
  { eb: 84, id: 84, location: 'Центар', address: 'Ул. Г 4', price: 115000, service: 'buy', bedrooms: 2, sqm: 60, details: 'Двособен стан.' },
  { eb: 85, id: 85, location: 'Центар', address: 'Ул. Д 5', price: 120000, service: 'buy', bedrooms: 2, sqm: 62, details: 'Двособен стан.' },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://feed-not-used'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(p => p.eb === eb); }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(p => p.id === id); }
  async locations(): Promise<string[]> { return [...new Set(this.rows.map(r => r.location ?? '').filter(Boolean))]; }
  get healthy(): boolean { return true; }
}

function makeHandler(): { handler: InboundHandler; sessions: SessionStore; sent: string[]; db: Db } {
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
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent, db };
}

test('detector: the more-stock shapes fire, the stock question does not', () => {
  for (const text of [
    'НЕ СЕ ЛОШИ АМА САКАМ ДА ВИДАМ УШТЕ АКО ИМАТЕ',
    'ШТО УШТЕ ИМАТЕ ?',
    'ИМАТЕ ЛИ УШТЕ ?',
    'УШТЕ ИМАТЕ ?',
    'ДАЈ УШТЕ ОПЦИИ',
    'САКАМ ДА ВИДАМ УШТЕ',
    'УШТЕ ПОНУДИ ИМАТЕ ЛИ',
    'DAJ USTE PONUDI',
    'IMATE LI USTE',
  ]) {
    assert.equal(detectMoreStockRequest(text), true, `«${text}» asks for more stock`);
  }
  for (const text of [
    'ДАЛИ Е УШТЕ ДОСТАПНА ?',
    'ДАЛИ СЕ УШТЕ СЛОБОДНИ ?',
    // THE SAME VERB, THE OTHER QUESTION: an object stands between the ask and
    // the verb — «го имате», «дали ја има» — so this is about ONE flat and the
    // availability lane owns it (the [07:06]/[04:14] captures).
    'DALI GO IMATE USTE ?',
    'ПРОВЕРИ ДАЛИ ЈА ИМА УШТЕ , И АКО Е ДОСТАПНА БИ САКАЛ ДА ЈА ПОСЕТАМ',
    'УШТЕ КОЛКУ ВРЕМЕ Е ДО ВИДУВАЊЕТО ?',
    'НЕ СЕ ЛОШИ',
    'КОЈА Е ЦЕНАТА НА 84 ?',
  ]) {
    assert.equal(detectMoreStockRequest(text), false, `«${text}» is not a more-stock ask`);
  }
});

test('e2e [12:41]: «сакам да видам уште» serves the NEXT pair, never the booking protocol', async () => {
  const { handler, sessions, sent, db } = makeHandler();
  const chatId = 'more-1241';
  await handler.handle('test', chatId, 'БАРАМ ДВОСОБЕН СТАН ВО ЦЕНТАР ЗА КУПУВАЊЕ ДО 200 000 ЕВРА');
  let s = sessions.get(chatId)!;
  // The funnel may still be asking before the pair; answer what it asks and
  // stop as soon as a pair is on the table.
  for (const answer of ['ДО 200 000 ЕВРА', 'СЕ ЕДНО КОЛКУ СОБИ']) {
    if ((s.slots.currentBatch?.length ?? 0) >= 2) break;
    await handler.handle('test', chatId, answer);
    s = sessions.get(chatId)!;
  }
  const first = (s.slots.currentBatch ?? []).slice();
  assert.equal(first.length, 2, `a pair must be on the table: ${JSON.stringify(first)}`);

  await handler.handle('test', chatId, 'НЕ СЕ ЛОШИ АМА САКАМ ДА ВИДАМ УШТЕ АКО ИМАТЕ');
  s = sessions.get(chatId)!;
  const reply = sent[sent.length - 1];

  assert.equal(s.slots.currentBatch?.length, 2, `the more-ask must serve a pair: ${reply}`);
  for (const id of s.slots.currentBatch ?? []) {
    assert.ok(!first.includes(id), `EB ${id} was already served: ${reply}`);
  }
  assert.ok(!/500 денари|Евидентен број 84|Посетата е за/u.test(reply),
    `a stock ask must never open the booking protocol: ${reply}`);
  db.close();
});

test('e2e [13:08]: a drained pool says so — never a repeat, never the availability table', async () => {
  const { handler, sessions, sent, db } = makeHandler();
  const chatId = 'more-1308';
  await handler.handle('test', chatId, 'БАРАМ ДВОСОБЕН СТАН ВО ЦЕНТАР ЗА КУПУВАЊЕ ДО 200 000 ЕВРА');
  let s = sessions.get(chatId)!;
  for (const answer of ['ДО 200 000 ЕВРА', 'СЕ ЕДНО КОЛКУ СОБИ']) {
    if ((s.slots.currentBatch?.length ?? 0) >= 2) break;
    await handler.handle('test', chatId, answer);
    s = sessions.get(chatId)!;
  }

  // Drain: every row is two-bedroom, so three more-asks cover all five.
  for (let i = 0; i < 3; i++) await handler.handle('test', chatId, 'ШТО УШТЕ ИМАТЕ ?');
  s = sessions.get(chatId)!;
  const presented = new Set(s.slots.presentedIds ?? []);
  assert.equal(presented.size, ROWS.length, `every row is shown once: ${JSON.stringify([...presented])}`);
  assert.equal(new Set(s.slots.presentedIds ?? []).size, (s.slots.presentedIds ?? []).length,
    'no property is ever served twice');

  // One more: the honest exhausted line, and a pivot.
  await handler.handle('test', chatId, 'ШТО УШТЕ ИМАТЕ ?');
  const last = sent[sent.length - 1];
  assert.ok(/исцрпив|искористив|прегледав|немам|немаме|сите/u.test(last),
    `the drained pool must be admitted: ${last}`);
  assert.ok(/\?/u.test(last), `the exhausted line still asks a pivot question: ${last}`);
  // THE AVAILABILITY PROTOCOL, NOT THE WORD «достапни»: the exhausted bank
  // legitimately says «ги прегледавме сите ДОСТАПНИ/слободни понуди» — that is
  // the admission, and the first wording of this assertion failed a correct
  // bank variant for it. What must never appear is the availability QUESTION
  // («дали е/се уште достапна?») or the owner-check promise that opens it.
  assert.ok(!/(?:дали|dali)\s+(?:е|se|sme|sme)\s+(?:уште|uste)?\s*(?:достапн|слободн)|уште\s+(?:е\s+)?достапн|ќе\s+проверам\s+кај\s+сопственик|ке\s+proveram\s+kaj/iu.test(last),
    `never the availability protocol on a more-ask: ${last}`);
  db.close();
});
