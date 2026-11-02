// THE ELLIPTICAL YEAR ASK — the [11:41] capture.
//
//   [11:41] OD KOJA GODINA E 90 ?
//   [11:41] ЛИНА [без LLM]: Станот под Евидентен број 90 е двосебен стан во
//           Кисела Вода. Се наоѓа во близина на Internat Dimitar Vlahov…
//           (the whole CARD again)
//
// The feed holds `godina_na_gradba = 1970` for that exact flat. The year
// patterns required a BUILDING noun («од која година е ЗГРАДАТА»), and the
// client had replaced it with an Евидентен број — so the message carried no
// facet at all, the INFO block was skipped and the describe lane answered a
// one-word question with the card. The contract: the year, or the honest
// owner-relay line — never the card, never an invented year.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { detectInfoFacets } from '../src/llm/infoAnswer';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

const ROWS: Property[] = [
  {
    eb: 90, id: 90, location: 'Кисела Вода', address: 'Локов 5',
    price: 75000, bedrooms: 2, sqm: 54, service: 'buy', floor: 1, yearBuilt: 1970,
    lat: 41.9744, lon: 21.4403, geo_source: 'google_cached',
    details: 'Стар стан во Кисела Вода со одличен распоред на прв спрат, градско парно.',
  } as Property,
  {
    eb: 63, id: 63, location: 'Центар', address: 'Ул. Мите Богоевски 3',
    price: 36000, bedrooms: 1, sqm: 28, service: 'buy', floor: -1,
    lat: 41.9930, lon: 21.4680, geo_source: 'osm_building',
    details: 'Гарсоњера во сутерен, комплетно реновирана.',
  } as Property,
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const mapPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'year-')), 'map.db');
  writeMap(mapPath, [], []);
  const offlineMap = new OfflineMapStore(mapPath);
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const props = new FakeProps(ROWS);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap }),
  });
  return { handler, sessions, sent };
}

function seed(sessions: SessionStore, chatId: string, ids: number[]): void {
  const s = freshSession('test', chatId);
  s.slots.presentedIds = ids;
  s.slots.propertyId = ids[ids.length - 1];
  sessions.set(s);
}

test('[11:41] “od koja godina e 90 ?” answers the YEAR, never the card', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'capture-1141';
  seed(sessions, chatId, [90]);
  await handler.handle('test', chatId, 'OD KOJA GODINA E 90 ?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /1970/u, `the stored construction year: ${answer}`);
  assert.ok(!/двособен|Евидентен број|Цената е|м²|Кисела Вода/u.test(answer),
    `never the property card: ${answer}`);
});

test('[11:41] a flat with no stored year gets the honest owner-relay line', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'capture-1141-miss';
  seed(sessions, chatId, [63]);
  await handler.handle('test', chatId, 'OD KOJA GODINA E 63 ?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /немам податок во базата од која година/iu,
    `the honest missing-fact line: ${answer}`);
  assert.ok(!/1970|1968|1969/u.test(answer), `never an invented year: ${answer}`);
  assert.ok(!/двособен|Цената е|м²/u.test(answer), `never the property card: ${answer}`);
});

test('[11:41] the elliptical arm reads the ask and nothing else', () => {
  for (const t of ['OD KOJA GODINA E 90 ?', 'ОД КОЈА ГОДИНА Е?', 'od koja godina e zgradata ?',
    'ОД КОЈА ГОДИНА Е ИЗГРАДЕНА?', 'KOJA GODINA E IZGRADENA ?']) {
    assert.equal(detectInfoFacets(t)?.yearBuilt, true, t);
  }
  // A different object after the same frame is NOT a year ask.
  assert.equal(detectInfoFacets('od koja godina e cenata ?')?.yearBuilt, undefined);
  assert.equal(detectInfoFacets('od koja godina e ponudata ?')?.yearBuilt, undefined);
});
