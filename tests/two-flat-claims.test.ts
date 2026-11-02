// THE 11:38–11:43 BATCH — a conversation about TWO flats.
//
//   [11:38] NA KOJ SPRAT E 94 ? A NA KOJ 90 ?
//   [11:38] ЛИНА: Се наоѓа на 8 кат.                        (only one flat)
//   [11:39] KOJ E PODOBAR STAN OD OVIE DVA ?
//   [11:39] ЛИНА: <both cards, word for word again> + clientela close
//   [11:43] KOJA MU E TOCNATA LOKACIJA ?
//   [11:43] ЛИНА: Тоа се наоѓа во близина на Студентски дом Пелагонија.
//
// Three rules, one conversation:
//   1. when MORE THAN ONE flat is on the table, a where-is line names the
//      Евидентен број it is about — «Тоа» cannot be attributed to any of them;
//   2. a single countable fact asked about TWO named flats is answered for
//      BOTH, in the order the client asked;
//   3. a judgment ask about flats the chat has ALREADY served carries the
//      answer alone — the cards are not replayed.

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

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

/** The two Кисела Вода flats of the capture (real feed facts). */
const ROWS: Property[] = [
  {
    eb: 94, id: 94, location: 'Кисела Вода', address: 'Тоне Томшиќ 25',
    price: 92000, bedrooms: 2, sqm: 56, service: 'buy', floor: 8,
    lat: 41.9813, lon: 21.4382, geo_source: 'osm_building',
    features: ['лифт', 'парно', 'тераса', 'јавен паркинг', 'наместен'],
    landmarks: [{
      landmark: 'Студентски дом Пелагонија', type: 'dormitory', distance_m: 63,
      maps_url: 'https://maps.google.com/?q=41.98074,21.43835',
    }],
    details: 'Кај економското училиште. Стан на осми спрат со парно и лифт.',
  } as Property,
  {
    eb: 90, id: 90, location: 'Кисела Вода', address: 'Локов 5',
    price: 75000, bedrooms: 2, sqm: 54, service: 'buy', floor: 1,
    lat: 41.9744, lon: 21.4403, geo_source: 'google_cached',
    features: ['парно', 'јавен паркинг', 'наместен'],
    landmarks: [{
      landmark: 'Internat Dimitar Vlahov', type: 'Boarding school', distance_m: 156,
      maps_url: 'https://maps.google.com/?q=41.97514,21.44193',
    }],
    details: 'Стар стан со одличен распоред на први спрат. Градско парно.',
  } as Property,
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  async getAllEbs(): Promise<Set<number>> { return new Set(this.rows.map(r => r.eb)); }
  get healthy(): boolean { return true; }
}

function makeHandler(): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const mapPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'two-flats-')), 'map.db');
  writeMap(mapPath, [], []);
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
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(mapPath) }),
  });
  return { handler, sessions, sent };
}

function seedBoth(sessions: SessionStore, chatId: string) {
  const s = freshSession('test', chatId);
  s.slots.currentBatch = [94, 90];
  s.slots.presentedIds = [94, 90];
  s.slots.describedEbs = [94, 90];
  s.slots.propertyId = 94;
  s.slots.service = 'buy';
  sessions.set(s);
  return s;
}

test('[11:43] with two flats on the table the where-is line names the Евидентен број', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'capture-1143';
  const s = seedBoth(sessions, chatId);
  s.slots.nearbyLandmarks = ['Студентски дом Пелагонија'];
  s.slots.nearbyLandmarkCoords = [{ lat: 41.98074, lon: 21.43835 }];
  s.slots.nearbyLandmarkEb = 94;
  s.slots.landmarkIndex = 0;
  sessions.set(s);

  await handler.handle('test', chatId, 'KOJA MU E TOCNATA LOKACIJA ?');
  const answer = sent[sent.length - 1] ?? '';
  // THE CONTRACT: the line names the flat actually under discussion — whatever
  // the binding chose — so the client can attribute it. It never says «Тоа»
  // while two flats are on the table.
  const bound = sessions.get(chatId)?.slots.propertyId;
  assert.ok(bound === 94 || bound === 90, `a flat of the batch is bound: ${bound}`);
  assert.match(answer, new RegExp(`^Евидентен број ${bound} се наоѓа`, 'u'),
    `the bound flat (${bound}) is named, not «Тоа»: ${answer}`);
  assert.ok(!/^Тоа се наоѓа/u.test(answer), `never the unattributable «Тоа»: ${answer}`);
  // The landmark is that flat's OWN, and the privacy contract holds.
  assert.match(answer, bound === 94 ? /Пелагонија/u : /Internat Dimitar Vlahov/u,
    `the bound flat's own landmark: ${answer}`);
  assert.match(answer, /близина/u, `a nearby landmark: ${answer}`);
  assert.ok(!/Тоне Томшиќ|ТОМШИЌ|Локов/u.test(answer), `the street never appears: ${answer}`);
});

test('[11:43] a single flat keeps the natural wording (nothing to disambiguate)', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'capture-1143-one';
  const s = freshSession('test', chatId);
  s.slots.currentBatch = [94];
  s.slots.presentedIds = [94];
  s.slots.propertyId = 94;
  s.slots.nearbyLandmarks = ['Студентски дом Пелагонија'];
  s.slots.nearbyLandmarkCoords = [{ lat: 41.98074, lon: 21.43835 }];
  s.slots.nearbyLandmarkEb = 94;
  sessions.set(s);
  await handler.handle('test', chatId, 'KOJA MU E TOCNATA LOKACIJA ?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /^Тоа се наоѓа/u, `one flat needs no number: ${answer}`);
});

test('[11:38] one floor question about TWO named flats answers for BOTH', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'capture-1138';
  seedBoth(sessions, chatId);
  await handler.handle('test', chatId, 'NA KOJ SPRAT E 94 ? A NA KOJ 90 ?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /Евидентен број 94 се наоѓа на 8 кат/u, `the first flat: ${answer}`);
  assert.match(answer, /а Евидентен број 90 на 1 кат/u, `the second flat: ${answer}`);
  // The single-flat answer that started this bug is gone.
  assert.ok(!/^Се наоѓа на \d+ кат\.$/u.test(answer.trim()), `never only one flat: ${answer}`);
});

test('[11:39] a judgment ask about flats ALREADY served does not replay the cards', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'capture-1139';
  const s = seedBoth(sessions, chatId);
  // The client named both numbers a turn earlier — that history is what the
  // recommendation lane reads to know WHICH two flats the judgment is about.
  s.history.push({ role: 'user', text: 'KOLKU E STANOT 94 ?' });
  s.history.push({ role: 'assistant', text: 'Станот под Евидентен број 94 …' });
  s.history.push({ role: 'user', text: 'A 90 ?' });
  s.history.push({ role: 'assistant', text: 'Станот под Евидентен број 90 …' });
  sessions.set(s);

  await handler.handle('test', chatId, 'KOJ E PODOBAR STAN OD OVIE DVA ?');
  const answer = sent[sent.length - 1] ?? '';
  assert.ok(answer, 'the judgment question must be answered');
  // THE POINT: the answer is the judgment/closer, not the two cards again.
  assert.ok(!/Станот под Евидентен број/u.test(answer), `no card replay: ${answer}`);
  assert.ok(!/Цената е/u.test(answer), `no price restated: ${answer}`);
  assert.ok(!/м²/u.test(answer), `no sizes restated: ${answer}`);
  // …and it still moves the funnel: the close offers to SEE the flats. The
  // bank ROTATES its recommend.close variants («посета», «да ги погледнете во
  // живо», «да ја посетите», «ќе договорам…»), so the assertion is the
  // CONTRACT — a visit offer — never one wording. Pinning the bare «посета»
  // reddened on the variant that says «посетите» (the copy-assertion rule in
  // AGENTS.md §5: a rotating bank makes a phrase-pin a false failure).
  assert.match(answer, /посет|погледн|во живо|договорам/iu, `the visit offer: ${answer}`);
});
