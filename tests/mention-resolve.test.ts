// THE MENTION RESOLVER — the 12:33 transcript, made permanent.
//
// "KOJA MU E LOKACIJATA NA STANOT KAJ DIMITAR MILADINOV ?" must bind the
// property the client NAMED (EB 69, whose own add says "преку У. Димитар
// Миладинов"), never the last item of the presented pair. Every property
// ever mentioned in the chat is a candidate — by EB, price ("овој од 99000"),
// type ("гарсоњерата"), or descriptor landmark ("кај Црногорска амбасада" —
// matched through the offline MAP, because the client's Cyrillic name and the
// map's English row ("Embassy of Montenegro") never share a word). Several
// equal matches → ONE clarify naming the options; never a silent guess.

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
import { extractMentionSignals, describeCandidate } from '../src/llm/mentionResolve';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

function tmpMapDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'mention-')), 'map.db');
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

// The 12:33 chat: two Центар properties, ~700 m apart.
//   EB 69 — стан 51 м², 99.000 €, add: "до УЈП, преку У. Димитар Миладинов"
//   EB 63 — гарсоњера 28 м², 36.000 €, сутерен, кај Црногорската амбасада
const EB69 = 69, EB63 = 63, EB71 = 71, EB72 = 72;
const C69 = { lat: 41.98810, lon: 21.47580 };
const C63 = { lat: 41.99300, lon: 21.46800 };

const ROWS_1233: Property[] = [
  {
    eb: EB69, id: EB69, location: 'Центар', address: 'Ул. Димитар Миладинов 12',
    price: 99000, bedrooms: 2, sqm: 51, service: 'buy',
    lat: C69.lat, lon: C69.lon, geo_source: 'osm_building',
    details: 'Стан со една спална соба на одлична локација, до УЈП, преку У. Димитар Миладинов. Здрава Југословенска Градба. Реновиран во 2013.',
    landmarks: [{ landmark: 'УЈП', distance_m: 120 }],
  },
  {
    eb: EB63, id: EB63, location: 'Центар', address: 'Ул. Мите Богоевски 3',
    price: 36000, bedrooms: 1, sqm: 28, service: 'buy',
    lat: C63.lat, lon: C63.lon, geo_source: 'osm_building',
    details: 'Гарсоњера во сутерен, комплетно реновирана.',
  },
];

// The map POIs: the client says "Црногорска амбасада", Google stores
// "Embassy of Montenegro" — the map is the name bridge.
const POIS_1233 = [
  { name: 'Embassy of Montenegro', type: 'embassy', lat: 41.98815, lon: 21.47585, source: 'google' },
  { name: 'Ул. Димитар Миладинов', type: 'road', lat: 41.98830, lon: 21.47600, source: 'osm' },
  { name: 'ТЦ Бисер', type: 'mall', lat: 41.99310, lon: 21.46790, source: 'google' },
];
const ADDRESSES_1233 = [
  { street: 'Ул. Димитар Миладинов', housenumber: '12', lat: C69.lat, lon: C69.lon },
  { street: 'Ул. Мите Богоевски', housenumber: '3', lat: C63.lat, lon: C63.lon },
];

function makeHandler(mapPois: typeof POIS_1233, rows: Property[]) {
  const mapPath = tmpMapDb();
  writeMap(mapPath, mapPois, ADDRESSES_1233);
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
  return { handler, sessions, sent, offlineMap, channels };
}

const chat = 'mention-client';

function seed(session: { slots: { presentedIds?: number[] } }, ids: number[]): void {
  session.slots.presentedIds = ids;
}

test('12:33: "станот кај Димитар Миладинов" binds EB 69; follow-up stays; "гарсоњерата" rebinds EB 63', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler(POIS_1233, ROWS_1233);
  const s = freshSession('test', chat);
  seed(s, [EB69, EB63]);
  sessions.set(s);

  // 1 — the descriptor names EB 69 (its own public add carries the street).
  await handler.handle('test', chat, 'KOJA MU E LOKACIJATA NA STANOT KAJ DIMITAR MILADINOV ?');
  const a1 = sent[sent.length - 1];
  assert.ok(a1, 'the where-is question must be answered');
  assert.ok(!a1.includes('тачната адреса'), `not the privacy protocol — the client asked WHERE: ${a1}`);
  assert.ok(!a1.includes('Бисер'), `must NOT serve the other property's landmark: ${a1}`);
  assert.ok(
    a1.includes('во близина на') && (a1.includes('Embassy of Montenegro') || a1.includes('Димитар Миладинов')),
    `answer is EB 69's landmark: ${a1}`);

  // 2 — the push binds the SAME property again (not "the last one in the
  // order she gave" — the presented pair lists EB 63 second).
  await handler.handle('test', chat, 'MORAS DA MI KAZES KADE E');
  const a2 = sent[sent.length - 1];
  assert.ok(!a2.includes('Бисер'), `follow-up stays on the bound property (EB 69): ${a2}`);
  assert.ok(
    a2.includes('во близина на') && (a2.includes('Embassy of Montenegro') || a2.includes('Димитар Миладинов')),
    `follow-up re-serves EB 69's landmark: ${a2}`);

  // 3 — "гарсоњерата" can only mean EB 63 → ITS landmark.
  await handler.handle('test', chat, 'kade e garsonjerata ?');
  const a3 = sent[sent.length - 1];
  assert.ok(a3.includes('Бисер'), `the garsonjera answer serves EB 63's landmark: ${a3}`);
  assert.ok(!a3.includes('Embassy of Montenegro'), `and not EB 69's: ${a3}`);

  offlineMap.close();
});

test('12:33 price pick: "ovoij stan od 99000" binds EB 69 without an EB number', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler(POIS_1233, ROWS_1233);
  const s = freshSession('test', chat);
  seed(s, [EB69, EB63]);
  sessions.set(s);

  await handler.handle('test', chat, 'kade mu e lokacijata na ovoj stan od 99000 ?');
  const a = sent[sent.length - 1];
  assert.ok(
    a.includes('во близина на') && (a.includes('Embassy of Montenegro') || a.includes('Димитар Миладинов')),
    `price 99000 → EB 69's landmark: ${a}`);
  assert.ok(!a.includes('Бисер'), `never the other pair member: ${a}`);

  offlineMap.close();
});

test('12:33 map bridge: "кај Црногорска амбасада" binds EB 63 through the English map row', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler(POIS_1233, ROWS_1233);
  const s = freshSession('test', chat);
  seed(s, [EB69, EB63]);
  sessions.set(s);

  await handler.handle('test', chat, 'KADE SE NAOGJA OVOJ KAJ CRNOGORSKA AMBASADA ?');
  const a = sent[sent.length - 1];
  assert.ok(a.includes('Бисер'), `the embassy descriptor binds EB 63 (map distance): ${a}`);
  assert.ok(!a.includes('тачната адреса'), `answered, not deflected: ${a}`);

  offlineMap.close();
});

test('ambiguous mention asks back ONCE naming the options — never a silent guess', async () => {
  // Two Центар stands, both within 600 m of Рамстор Мол: "кај Рамстор"
  // cannot decide between them → Lina asks back with the labels.
  const ramstor = { lat: 41.98800, lon: 21.47700 };
  const rows: Property[] = [
    { eb: EB71, id: EB71, location: 'Центар', address: 'Ул. А 1', price: 70000, bedrooms: 2, service: 'buy',
      lat: ramstor.lat + 0.0001, lon: ramstor.lon, geo_source: 'osm_building',
      landmarks: [{ landmark: 'Рамстор Мол', distance_m: 12 }] },
    { eb: EB72, id: EB72, location: 'Центар', address: 'Ул. Б 2', price: 82000, bedrooms: 2, service: 'buy',
      lat: ramstor.lat + 0.0003, lon: ramstor.lon + 0.0001, geo_source: 'osm_building',
      landmarks: [{ landmark: 'Рамстор Мол', distance_m: 40 }] },
  ];
  const pois = [
    { name: 'Рамстор Мол', type: 'mall', lat: ramstor.lat, lon: ramstor.lon, source: 'google' },
  ];
  const { handler, sessions, sent, offlineMap } = makeHandler(pois, rows);
  const s = freshSession('test', chat);
  seed(s, [EB71, EB72]);
  sessions.set(s);

  await handler.handle('test', chat, 'kade mu e lokacijata na ovoj stan kaj ramstor mol ?');
  const a = sent[sent.length - 1];
  assert.ok(a.includes('Кажете ми точно'), `ambiguous → clarify question: ${a}`);
  assert.ok(a.includes('станот'), `options are labeled by type+area+anchor: ${a}`);
  assert.ok(!a.includes('во близина на'), `no property served on ambiguity: ${a}`);

  offlineMap.close();
});

// ── Pure units ──────────────────────────────────────────────────────────────

test('signals: price (од/currency), type, sqm, suteren — both scripts via the normalizer', () => {
  const s1 = extractMentionSignals('ovoij stan od 99000 evra');
  assert.equal(s1.price, 99000);
  const s2 = extractMentionSignals('garsonjerata so suteren 28 m2');
  assert.equal(s2.garsonjera, true);
  assert.equal(s2.suteren, true);
  assert.equal(s2.sqm, 28);
  const s3 = extractMentionSignals('станот од 36.000 евра');
  assert.equal(s3.price, 36000);
  const s4 = extractMentionSignals('dali e dostapen'); // no property signal at all
  assert.equal(s4.price, undefined);
  assert.equal(s4.garsonjera, undefined);
  assert.equal(s4.descriptor, undefined);
  // "до + NUMBER" is the BUDGET sense ("до 250 евра" = up to 250), never a
  // landmark descriptor — Latin "do" transliterates to "до", so a digit-led
  // fragment must never become a descriptor (the bind-48-for-76 bug).
  const s5 = extractMentionSignals('do 250 evra');
  assert.equal(s5.descriptor, undefined);
  const s6 = extractMentionSignals('до 250 евра');
  assert.equal(s6.descriptor, undefined);
  // …while a genuine landmark descriptor still extracts (normalized form —
  // matching is done against normalized candidate text, so case is gone).
  assert.equal(extractMentionSignals('кај Димитар Миладинов').descriptor, 'димитар миладинов');
});

test('labels: "гарсоњерата во Центар кај Рамстор Мол" / "деловниот простор во Аеродром"', () => {
  assert.equal(
    describeCandidate({ eb: 63, bedrooms: 1, location: 'Центар', landmarks: [{ landmark: 'Рамстор Мол' }] }),
    'гарсоњерата во Центар кај Рамстор Мол');
  assert.equal(
    describeCandidate({ eb: 90, business: true, location: 'Аеродром' }),
    'деловниот простор во Аеродром');
  assert.equal(
    describeCandidate({ eb: 91, house: true, location: 'Карпош' }),
    'куќата во Карпош');
});
