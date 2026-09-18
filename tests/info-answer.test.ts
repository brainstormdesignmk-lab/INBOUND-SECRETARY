// THE INFO-ANSWER FAMILY (scope C) — the public-add becomes quotable.
//
// "kolku e garsonjerata?" must answer about THE GARSONJERA THE CHAT NAMED
// (EB 63, 36.000 €) — never about the last-shown property. Every ask family
// binds through the mention resolver and answers from the feed's public-add
// data: price, m², rooms, floor, features. A facet with no stored data gets
// the honest owner-relay line — never a fabricated feature. A criterion
// ("stan od 80 m2", "do 500 evra") and an opinion ("цените се превисоки")
// never become info answers.

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
import { detectInfoFacets, buildInfoAnswer, INFO_NO_DATA_LINE } from '../src/llm/infoAnswer';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

function tmpMapDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'info-')), 'map.db');
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

// The 12:33 chat, one family over: EB 69 (стан 51 м², 99.000 €) and EB 63
// (гарсоњера 28 м², 36.000 €, сутерен, греење на струја).
const EB69 = 69, EB63 = 63;
const ROWS_INFO: Property[] = [
  {
    eb: EB69, id: EB69, location: 'Центар', address: 'Ул. Димитар Миладинов 12',
    price: 99000, bedrooms: 2, sqm: 51, service: 'buy',
    lat: 41.98810, lon: 21.47580, geo_source: 'osm_building',
    details: 'Стан со една спална соба на одлична локација, до УЈП, преку У. Димитар Миладинов. Здрава Југословенска Градба. Реновиран во 2013.',
  },
  {
    eb: EB63, id: EB63, location: 'Центар', address: 'Ул. Мите Богоевски 3',
    price: 36000, bedrooms: 1, sqm: 28, service: 'buy',
    lat: 41.99300, lon: 21.46800, geo_source: 'osm_building',
    features: ['греење на струја'],
    details: 'Гарсоњера во сутерен, комплетно реновирана.',
  },
];

const MAP_POIS = [
  { name: 'УЈП', type: 'government', lat: 41.98820, lon: 21.47590, source: 'google' },
];
const MAP_ADDRESSES = [
  { street: 'Ул. Димитар Миладинов', housenumber: '12', lat: 41.98810, lon: 21.47580 },
  { street: 'Ул. Мите Богоевски', housenumber: '3', lat: 41.99300, lon: 21.46800 },
];

function makeHandler() {
  const mapPath = tmpMapDb();
  writeMap(mapPath, MAP_POIS, MAP_ADDRESSES);
  const offlineMap = new OfflineMapStore(mapPath);
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS_INFO)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(ROWS_INFO),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap }),
  });
  return { handler, sessions, sent, offlineMap };
}

function seed(sessions: SessionStore, chatId: string, ids: number[]) {
  const s = freshSession('test', chatId);
  s.slots.presentedIds = ids;
  sessions.set(s);
}

// ── Pure units: facets ───────────────────────────────────────────────────────

test('facets: price/sqm/rooms/floor/features, both scripts', () => {
  assert.equal(detectInfoFacets('kolku e garsonjerata ?')?.price, true);
  assert.equal(detectInfoFacets('која е цената на 69 ?')?.price, true);
  assert.equal(detectInfoFacets('a 63 kolku kvadrati ?')?.sqm, true);
  assert.equal(detectInfoFacets('колку е голем станот?')?.sqm, true);
  assert.equal(detectInfoFacets('kaj 69 kolku spalni ima ?')?.rooms, true);
  assert.equal(detectInfoFacets('na koj kat e ?')?.floor, true);
  assert.equal(detectInfoFacets('сутерен ли е ?')?.floor, true);
  assert.deepEqual(detectInfoFacets('dali 76 ima lift ?')?.features, ['лифт']);
  assert.deepEqual(detectInfoFacets('ima li parking ?')?.features, ['паркинг']);
});

test('facets: criteria and opinions are NOT info asks', () => {
  assert.equal(detectInfoFacets('stan od 80 m2'), undefined);
  assert.equal(detectInfoFacets('do 500 evra'), undefined);
  assert.equal(detectInfoFacets('so parking i lift'), undefined);
  // "колку саати работите" is a different question entirely
  assert.equal(detectInfoFacets('kolku saati rabotite ?')?.price, undefined);
  // size/rooms колку-phrases never double-fire as price
  const sqm = detectInfoFacets('колку е голем станот?');
  assert.equal(sqm?.price, undefined);
  assert.equal(sqm?.sqm, true);
});

// ── Pure units: builders ─────────────────────────────────────────────────────

const P63: Property = ROWS_INFO[1];

test('builders: price answer names EB, type and the feed price', () => {
  const a = buildInfoAnswer(P63, { price: true });
  assert.ok(a?.includes('63'), a);
  assert.ok(a?.includes('36.000') || a?.includes('36,000'), a);
  assert.ok(a?.includes('Гарсоњерата'), a);
});

test('builders: multi-facet compound ask answers all facets in one reply', () => {
  const a = buildInfoAnswer(P63, { sqm: true, rooms: true, floor: true });
  assert.ok(a?.includes('28 м²'), a);
  assert.ok(a?.includes('една спална'), a);
  assert.ok(a?.includes('сутерен'), a);
});

test('builders: known feature answered, unknown feature gets the honest no-data line', () => {
  const yes = buildInfoAnswer(P63, { features: ['греење'] });
  assert.ok(yes?.includes('греење на струја'), yes);
  const no = buildInfoAnswer(P63, { features: ['клима'] });
  assert.equal(no, INFO_NO_DATA_LINE);
});

test('builders: no data at all for the asked facets → undefined (falls through)', () => {
  const bare: Property = { eb: 99, id: 99, address: 'X', location: 'Центар', service: 'buy' };
  assert.equal(buildInfoAnswer(bare, { price: true }), undefined);
  assert.equal(buildInfoAnswer(bare, { floor: true }), undefined);
});

// ── E2E: the 12:33 chat, one family over ────────────────────────────────────

test('E2E: "kolku e garsonjerata?" binds EB 63 and answers 36.000, not shown[last]', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  seed(sessions, 'info-c', [EB69, EB63]);

  await handler.handle('test', 'info-c', 'kolku e garsonjerata ?');
  const a = sent[sent.length - 1];
  assert.ok(a?.includes('63'), `must answer about EB 63: ${a}`);
  assert.ok(a?.includes('36.000') || a?.includes('36,000'), `must quote EB 63's price: ${a}`);
  assert.ok(!a?.includes('99.000') && !a?.includes('99,000'), `must NOT quote EB 69's price: ${a}`);

  offlineMap.close();
});

test('E2E: "kaj 69 kolku kvadrati" binds by EB; bare "kolku e" keeps legacy binding', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  seed(sessions, 'info-d', [EB69, EB63]);

  await handler.handle('test', 'info-d', 'kaj 69 kolku kvadrati ?');
  const a = sent[sent.length - 1];
  assert.ok(a?.includes('51 м²'), `EB 69's size: ${a}`);

  // No binding signal → the current/last-shown chain answers (unchanged behavior).
  await handler.handle('test', 'info-d', 'kolku e ?');
  const b = sent[sent.length - 1];
  assert.ok(b?.includes('евра'), `bare kolku still answers a price: ${b}`);

  offlineMap.close();
});

test('E2E: feature ask about unstored data falls through honestly (no fabricated features)', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  seed(sessions, 'info-f', [EB69, EB63]);

  // EB 69 has no feature data in the harness rows → the no-data line.
  await handler.handle('test', 'info-f', 'dali 69 ima klima ?');
  const a = sent[sent.length - 1];
  assert.ok(
    a?.includes('ќе го прашам сопственикот') || a?.includes('не е наведено'),
    `honest no-data line: ${a}`);

  offlineMap.close();
});
