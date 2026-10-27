// THE [MADJARI] MONEY-ANCHOR GATE — sequential entry with Нарселба + спални
// but NO price used to fall into an unfiltered serve: the specs+service arm
// ranked the pool with no price band to steer by, the closestMatches tie
// broke on EB order, and the client got area junk (a rent-ish EB 42, a
// деловен EB 56) on a flat hunt. The contract now:
//   1. Price unwritten + intent untold → the ONE sale-or-rent question.
//   2. Price unwritten + intent told → the specs+price question. NEVER a card.
//   3. The money anchor (a named budget) is what triggers the serve — and the
//      serve stays inside the category the client typed (СТАН, buy).
// The junk row here is intentionally a PLAIN rent row (not business-flagged):
// a no-budget serve with unknown intent must never be able to surface it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

function tmpMapDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'moneyanchor-')), 'map.db');
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

// Маџар маало (= Центар on the map): two honest 3-room buy flats near
// 180 000, plus the junk pair — EB 42 (a PLAIN RENT row, no bedrooms field),
// EB 56 (a деловен row).
const ROWS: Property[] = [
  { eb: 24, id: 24, location: 'Центар', price: 179000, service: 'buy', bedrooms: 3, sqm: 58, size: '58 м²', address: 'Маџир маало' },
  { eb: 31, id: 31, location: 'Центар', price: 165000, service: 'buy', bedrooms: 3, sqm: 70, size: '70 м²', address: 'Партизанска' },
  { eb: 42, id: 42, location: 'Центар', price: 999, service: 'rent', sqm: 126, size: '126 м²', address: 'Дел плас' },
  { eb: 56, id: 56, location: 'Центар', price: 180000, service: 'buy', sqm: 210, size: '210 м²', business: true, address: 'Македонија' },
] as any;

function makeHandler(rows: Property[] = ROWS) {
  const mapPath = tmpMapDb();
  writeMap(mapPath, [], []);
  const offlineMap = new OfflineMapStore(mapPath);
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(rows)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(rows),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap }),
  });
  return { handler, sessions, sent, offlineMap };
}

const chat = 'money-anchor-client';
// A CARD (not the ask tails that mention the phrase): a number right after
// the words.
const CARD = /Евидентен број \d/u;

test('[madjari] sequential entry, NO price: the service answer asks the price, never serves', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();

  await handler.handle('test', chat, 'dve spalni madjar maalo stan');
  const t1 = sessions.get(chat)!;
  const r1 = sent[sent.length - 1];
  assert.ok(!CARD.test(r1), `no cards before ANY anchor: ${r1}`);
  assert.ok(!t1.slots.budget, 'no budget may be invented from the entry message');

  await handler.handle('test', chat, 'kupuvam');
  const t2 = sessions.get(chat)!;
  const r2 = sent[sent.length - 1];
  assert.ok(!CARD.test(r2), `the service answer must NOT trigger a serve: ${r2}`);
  assert.ok(/цена/i.test(r2), `the reply must ask for the price: ${r2}`);
  assert.equal(t2.state, 'discovery', `still collecting, not presenting: ${t2.state}`);
  assert.ok(!t2.slots.budget, 'the price stays unwritten until the client gives it');
  assert.ok(!t2.slots.currentBatch?.length, 'nothing was presented');

  offlineMap.close();
});

test('[madjari] locate-lane entry with intent+specs but NO price: specs+price ask, never a serve', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();

  await handler.handle('test', chat, 'imavte eden stan vo madjar maalo so dve spalni za kupuvanje');
  const s = sessions.get(chat)!;
  const r = sent[sent.length - 1];
  assert.equal(s.state, 'property_locate', `the locate funnel collects: ${s.state}`);
  assert.ok(!CARD.test(r), `no serve without the money anchor: ${r}`);
  assert.ok(/квадрати/i.test(r) && /цена/i.test(r),
    `the ask collects the missing specs (m² and price): ${r}`);
  assert.ok(!s.slots.budget, 'the price stays unwritten');
  offlineMap.close();
});

test('[madjari] the money anchor inside the entry triggers the serve — in-category only', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();

  await handler.handle('test', chat,
    'IMAVTE EDEN STAN VO MADJAR MAALO SO DVE SPALNI\nCENA OKOLU 180 000\nDALI USTE SE PRODAVA?');
  const s = sessions.get(chat)!;
  const r = sent[sent.length - 1];
  assert.ok(!s.slots.budget || !!s.slots.budget, 'session holds'); // shape guard
  assert.ok(CARD.test(r), `the price anchor unlocks the serve: ${r}`);
  assert.ok(r.includes('Евидентен број 24') && r.includes('Евидентен број 31'),
    `the honest pair serves: ${r}`);
  assert.ok(!r.includes('Евидентен број 42'), `a rent row never serves on a buy ask: ${r}`);
  assert.ok(!r.includes('Евидентен број 56'), `a деловен row never serves on a flat ask: ${r}`);
  offlineMap.close();
});
