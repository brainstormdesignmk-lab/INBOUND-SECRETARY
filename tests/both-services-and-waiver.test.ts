// «I DVETE» AND «НЕ МИ ИГРА ТОА УЛОГА» — the two answers the funnel refused
// (the operator's [13:05]/[13:23]/[13:29] field capture, 2026-11-12)
//
//   [13:22] ЛИНА: дали за Вас е подобро купување или изнајмување?
//   [13:23] I DVETE
//   [13:23] ЛИНА: Би сакала да знам дали станот Ви е потребен за купување или
//                  за изнајмување?          ← the SAME question, twice
//   [13:29] ЗА ДУЌАН СЕ РАБОТИ
//   [13:29] ЛИНА: Дали барате деловен простор за закуп или би сакале да купите?
//
//   [13:05] ЛИНА: Колку спални соби би сакале да има Вашиот иден стан?
//   [13:05] НЕ МИ ИГРА ТОА УЛОГА
//   [13:06] ЛИНА: Колку спални соби би сакале да има недвижноста?   ← same again
//
// All three messages left the chain as FALLTHROUGH. «I DVETE» is the shortest
// possible answer to a two-option question and the market list knew only the
// sentence forms; «не ми игра (тоа) улога» is the size waiver in an idiom that
// shares no word with the «не ми е битно» family.
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
import { detectBareBothAnswer, detectBothServices, detectSizeWaived } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const ROWS: Property[] = [
  { eb: 91, id: 91, location: 'Центар', address: 'Ул. А 1', price: 90000, service: 'buy', bedrooms: 2, sqm: 55, details: 'Двособен стан.' },
  { eb: 92, id: 92, location: 'Центар', address: 'Ул. Б 2', price: 450, service: 'rent', bedrooms: 2, sqm: 55, details: 'Двособен стан.' },
  { eb: 93, id: 93, location: 'Центар', address: 'Ул. В 3', price: 70000, service: 'buy', business: true, sqm: 40, details: 'Деловен простор.' },
  { eb: 94, id: 94, location: 'Центар', address: 'Ул. Г 4', price: 500, service: 'rent', business: true, sqm: 40, details: 'Деловен простор.' },
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

test('detector: «I DVETE» is the bare answer to the market question, not a card remark', () => {
  for (const text of ['I DVETE', 'ДВЕТЕ', 'да, и двете', 'I DVETE MOZE', 'i ednoto i drugoto', 'И ДВЕТЕ.']) {
    assert.equal(detectBareBothAnswer(text), true, `«${text}» answers «both»`);
  }
  for (const text of [
    'ОВИЕ ДВЕТЕ НЕ СЕ ЛОШИ',
    'ДВЕТЕ СТАНА СЕ ДОБРИ',
    'САКАМ ДА ГИ ВИДАМ ДВАТА',
    'I DVETE SE DOBRI',
  ]) {
    assert.equal(detectBareBothAnswer(text), false, `«${text}» is about the cards, not the market`);
  }
});

test('detector: «NE MI IGRA TOA ULOGA» waives the size, in both scripts', () => {
  for (const text of [
    'НЕ МИ ИГРА ТОА УЛОГА',
    'не ми игра улога',
    'NE MI IGRA TOA ULOGA',
    'ne mi igra uloga',
    'тоа не ми игра улога',
    'улогата не ми игра',
    'NE MI IGRAAT ULOGA',
  ]) {
    assert.equal(detectSizeWaived(text), true, `«${text}» releases the size`);
  }
  assert.equal(detectSizeWaived('НЕ МИ СЕ ДОПАЃА СТАНОТ'), false, 'a property complaint is not a waiver');
  assert.equal(detectSizeWaived('КОЛКУ СПАЛНИ СОБИ'), false, 'the question itself is not a waiver');
});

test('e2e [13:23]→[13:29]: «I DVETE» + «ЗА ДУЌАН СЕ РАБОТИ» never re-asks the market', async () => {
  const { handler, sessions, sent, db } = makeHandler();
  const chatId = 'both-1323';
  await handler.handle('test', chatId, 'ZDRAVO');
  await handler.handle('test', chatId, 'I DVETE');
  let s = sessions.get(chatId)!;
  assert.equal(s.slots.service, undefined, 'both markets: no single service may be pinned');
  assert.ok(!/купување или|закуп или|изнајмување\s*\?/u.test(sent[sent.length - 1]),
    `«I DVETE» already answered the market question: ${sent[sent.length - 1]}`);

  await handler.handle('test', chatId, 'ЗА ДУЌАН СЕ РАБОТИ');
  s = sessions.get(chatId)!;
  const reply = sent[sent.length - 1];
  assert.equal(s.slots.business, true, 'the type he named is a slot');
  assert.equal(s.slots.dualService, true, 'both markets stay declared: the dual search is armed');
  assert.equal(s.slots.bothServices, undefined, 'the pre-type flag is consumed');
  assert.ok(!/за\s+куп(ување|ување)|закуп или|за изнајмување или|купување или (за\s+)?изнајмување/iu.test(reply),
    `the market was already declared — never ask it again: ${reply}`);
  db.close();
});

test('e2e [13:05]: «НЕ МИ ИГРА ТОА УЛОГА» waives the bedrooms ask', async () => {
  const { handler, sessions, sent, db } = makeHandler();
  const chatId = 'waiver-1305';
  await handler.handle('test', chatId, 'БАРАМ СТАН ЗА КУПУВАЊЕ');
  let s = sessions.get(chatId)!;
  // Answer the area question if it comes, so the funnel reaches the size ask.
  if (!s.slots.location && s.slots.anywhere !== true) {
    await handler.handle('test', chatId, 'БИЛО КАДЕ');
    s = sessions.get(chatId)!;
  }
  const before = sent[sent.length - 1];
  await handler.handle('test', chatId, 'НЕ МИ ИГРА ТОА УЛОГА');
  s = sessions.get(chatId)!;
  const after = sent[sent.length - 1];
  assert.equal(s.slots.sizeWaived, true, `the idiom must release the size: ${after}`);
  const asksBedrooms = (t: string | undefined) => /колку (спални|соби)/iu.test(t ?? '');
  if (asksBedrooms(before)) {
    assert.ok(!asksBedrooms(after), `the same question must not be asked twice: ${after}`);
  }
  db.close();
});
