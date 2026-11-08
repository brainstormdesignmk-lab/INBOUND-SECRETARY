/**
 * THE «STN MI TREBA» / «LEPTOKARIJA ILI CITY MALL» FIELD REPLAY.
 *
 *   ZA KUPUVANJE SUM
 *   STN MI TREBA                  → the bot asked the property type AGAIN
 *   LEPTOKARIJA ILI CITY MALL     → the bot asked the area AGAIN
 *
 * Two root causes, one test each:
 *   1. «stn» is the everyday shorthand for стан. The flat/property-type
 *      recognisers did not know it, so the type stayed unknown.
 *   2. A bare «X ILI Y» list of places (no preposition) was split by no
 *      reader: both landmark readers need a preposition or a single place,
 *      so neither mall was bound as the anchor.
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
import { BankStore } from '../src/store/bank';
import { detectFlat, detectPropertyTypeWord } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const ROWS: Property[] = [
  { eb: 54, id: 54, location: 'Карпош III', address: 'Роберт Кох 3', price: 69500, bedrooms: 2, sqm: 35, size: '35 м²', service: 'buy', lat: 42.0036, lon: 21.3955 },
  { eb: 69, id: 69, location: 'Центар', address: 'Димитар Миладинов', price: 99000, bedrooms: 2, sqm: 51, size: '51 м²', service: 'buy', lat: 42.0005, lon: 21.4121 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

function makeHandler(id = 'stn-list') {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions, bank: new BankStore(db),
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(ROWS),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  return { handler, sessions, sent, chatId: id };
}

test('«STN» is the flat word: the type is recognised, not asked again', () => {
  assert.equal(detectFlat('STN MI TREBA'), true);
  assert.equal(detectPropertyTypeWord('STN MI TREBA'), true);
  assert.equal(detectFlat('STN'), true);
});

test('«stn» as a whole word only: it does not match inside other words', () => {
  // The boundary guard keeps «stn» from matching inside a longer word.
  assert.equal(detectFlat('ZASTN'), false);
  assert.equal(detectFlat('ZASTNUVAM'), false);
});

test('STN MI TREBA after ZA KUPUVANJE SUM moves on to the location question', async () => {
  const { handler, sent, sessions, chatId } = makeHandler();
  await handler.handle('test', chatId, 'ZDRAVO');
  await handler.handle('test', chatId, 'ZA KUPUVANJE SUM');
  await handler.handle('test', chatId, 'STN MI TREBA');
  const answer = sent[sent.length - 1] ?? '';
  assert.doesNotMatch(answer, /кој тип на недвижност/u,
    `the type must not be asked again after «STN»: ${answer}`);
  assert.match(answer, /дел од град|локаци|населб|каде/iu,
    `the next question is the location: ${answer}`);
  assert.equal(sessions.get(chatId)!.slots.flat, true, 'the flat type is stored');
});

test('LEPTOKARIJA ILI CITY MALL binds the first landmark as the anchor', async () => {
  const { handler, sessions, chatId } = makeHandler();
  await handler.handle('test', chatId, 'ZDRAVO');
  await handler.handle('test', chatId, 'ZA KUPUVANJE SUM');
  await handler.handle('test', chatId, 'STN MI TREBA');
  await handler.handle('test', chatId, 'LEPTOKARIJA ILI CITY MALL');
  const s = sessions.get(chatId)!;
  assert.match(String(s.slots.poiAnchor), /лептокарија|leptokarija/iu,
    `the bare list must bind a landmark, got ${s.slots.poiAnchor}`);
});

test('LEPTOKARIJA ILI CITY MALL no longer re-asks the area', async () => {
  const { handler, sent, chatId } = makeHandler();
  await handler.handle('test', chatId, 'ZDRAVO');
  await handler.handle('test', chatId, 'ZA KUPUVANJE SUM');
  await handler.handle('test', chatId, 'STN MI TREBA');
  await handler.handle('test', chatId, 'LEPTOKARIJA ILI CITY MALL');
  const answer = sent[sent.length - 1] ?? '';
  assert.doesNotMatch(answer, /кој дел од град/u,
    `the area question must not repeat after the landmark list: ${answer}`);
});
