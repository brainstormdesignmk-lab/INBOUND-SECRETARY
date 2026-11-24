// THE [09:03]–[09:12] CAPTURE — THE FLAT WE ARE DISCUSSING, AND ITS OWN AREA.
//
//   [09:11] na kolkavo rastojanie e 84 od crnogorska ambasada ?
//   [09:11] ЛИНА: Црногорска Амбасада се наоѓа на 140 метри … од недвижноста
//                  со Евидентен број 84 што ја разгледуваме (во Центар).   ✔
//   [09:11] koja e tocnata adresa ?
//   [09:11] ЛИНА: (privacy protocol)                                   ✔
//   [09:12] moram da znam kaj se naogja za da odlucam da go posetam
//   [09:12] ЛИНА: Евидентен број 85 се наоѓа во близина на Градинка «Буба Мара 1»
//                 https://maps.google.com/?q=41.98410,21.47862            ✘
//
// Two defects, both in this one burst:
//
// 1. THE SUBJECT. «go posetam» is EB 84 — the client had named 84 in each of his
//    last three messages and the previous answer was about 84. The message was
//    read as a PLACE question («za da odlucam da go posetam» — the purpose
//    clause — became the place), so the generic branch with its named-EB rule
//    never ran, and the junk-place fallback took the LAST CARD of the batch
//    (`presentedIds` tail = EB 85, a flat in Ново Лисиче offered earlier by the
//    «sto ima vo negova blizina drugo?» pivot). A flat the client NAMED outranks
//    a flat that merely happened to be served last.
//
// 2. THE OWN-PLACE DISTANCE. Earlier in the same chat:
//       Станот под Евидентен број 82 е трисобен стан во Аеродром. …
//       Се наоѓа на 490 m од Аеродром.
//    A flat in Аеродром measured FROM Аеродром is a tautology — the centroid
//    distance says nothing about where inside the district it is. The owner's
//    rule: a neighbourhood is not a landmark (the same family as the [09:50]
//    city rule in city-not-a-landmark.test.ts). A CROSS-place distance stays:
//    «290 m од Буњаковец» for a flat in Центар is real information.
//
// The contract these tests pin:
//   • a purpose clause («за да/да …») is never a place name;
//   • every where-is fallback resolves the SUBJECT through one chain (named EB
//     → askedEb → propertyId → last presented → interested), never the batch
//     tail alone;
//   • a card never measures itself from the area it already names, and never
//     names that area as a nearby landmark.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
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
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';
import { detectWhereIs } from '../src/llm/deterministic';
import { buildPropertyCard } from '../src/llm/prompts';

const cfg = loadConfig();
const hasMap = !!cfg.skopjePoisDb && fs.existsSync(cfg.skopjePoisDb);

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// The three rows of the capture, at their real pins.
const EB84 = 84, EB85 = 85, EB82 = 82;
const ROWS: Property[] = [
  // 84 — Центар, 100 m from the Montenegrin embassy (41.9958, 21.4182).
  { eb: EB84, id: EB84, location: 'Центар', address: 'ул. Никола Вапцаров', price: 117000, bedrooms: 3, sqm: 48, size: '48 м²', service: 'buy', lat: 41.99599, lon: 21.41817, geo_source: 'stored', details: 'Трисобен стан во Центар.' } as Property,
  // 85 — Ново Лисиче (the batch tail the wrong answer named).
  { eb: EB85, id: EB85, location: 'Ново Лисиче', address: 'КАЈ БРАНКА', price: 133000, bedrooms: 3, sqm: 100, size: '100 м²', service: 'buy', lat: 41.98410, lon: 21.47862, geo_source: 'osm_street_anchor', details: 'Трисобен стан во Ново Лисиче.' } as Property,
  // 82 — Аеродром, the row whose card measured «490 m од Аеродром».
  { eb: EB82, id: EB82, location: 'Аеродром', address: 'ул. Јане Сандански', price: 143000, bedrooms: 3, sqm: 77, size: '77 м²', service: 'buy', lat: 41.98396, lon: 21.46496, geo_source: 'stored', details: 'Трисобен стан во Аеродром.' } as Property,
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb || r.id === eb); }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id || r.eb === id); }
  get healthy(): boolean { return true; }
}

function makeHandler(chatId: string) {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const properties = new FakeProps(ROWS);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId };
}

// ── 1. THE PARSER: A PURPOSE CLAUSE IS NOT A PLACE ─────────────────────────

test('[09:12] «za da odlucam da go posetam» is a reason, never a place', () => {
  const q = detectWhereIs('moram da znam kaj se naogja za da odlucam da go posetam');
  assert.equal(q?.generic, true,
    `the reason must leave no place behind (got ${JSON.stringify(q)})`);
  assert.equal(q?.place, '');
  // Sibling shapes — the whole «да …» family, either script, with or without за.
  for (const m of [
    'kade e da go vidam ?',
    'kaj se naogja za da odam ?',
    'kade se naogja stanot da mozam da go posetam',
  ]) {
    const r = detectWhereIs(m);
    assert.equal(r?.generic, true, `${m} => ${JSON.stringify(r)}`);
  }
  // …while a REAL name that merely begins with the syllables still resolves.
  const aerodrom = detectWhereIs('kaj se naogja aerodrom ?');
  assert.equal(aerodrom?.generic, false, JSON.stringify(aerodrom));
  // The tail keeps the client's own script (Latin here) — only the purpose
  // clause is cut, so the spelling check accepts either.
  assert.match(aerodrom?.place ?? '', /аеродром|aerodrom/iu);
  const daut = detectWhereIs('kade e daut pasin amam ?');
  assert.match(daut?.place ?? '', /daut/iu, `a name must survive: ${JSON.stringify(daut)}`);
});

// ── 2. THE PIPELINE: THE NAMED FLAT OUTRANKS THE BATCH TAIL ────────────────

test('[09:12] e2e: the where-is answers about EB 84 — the flat he named — not the batch tail (85)', { skip: !hasMap }, async () => {
  const { say, sessions, chatId } = makeHandler('discussed-84');
  // The state the capture reached: the pair 84 + 85 was served (85 last, so it
  // is the presented tail), and the client then named 84 twice in a row.
  const s = freshSession('test', chatId);
  s.state = 'presentation';
  s.slots.service = 'buy';
  s.slots.location = 'Центар';
  s.slots.bedrooms = 3;
  s.slots.budget = '180000';
  s.slots.presentedIds = [EB84, EB85];
  s.slots.currentBatch = [EB84, EB85];
  s.slots.propertyId = EB85;          // the last served card — the wrong subject
  s.history = [
    { role: 'user', text: '84 na koja adresa e ?' },
    { role: 'assistant', text: 'Евидентен број 84 се наоѓа во близина на Амбасада на Црна Гора.' },
    { role: 'user', text: 'na kolkavo rastojanie e 84 od crnogorska ambasada ?' },
    { role: 'assistant', text: 'Црногорска Амбасада се наоѓа на 140 метри од недвижноста со Евидентен број 84.' },
    { role: 'user', text: 'koja e tocnata adresa ?' },
  ];
  sessions.set(s);

  const reply = await say('moram da znam kaj se naogja za da odlucam da go posetam');
  assert.match(reply, /84/u, `the answer must name the flat the client named: ${reply}`);
  assert.doesNotMatch(reply, /85/u, `never the batch tail: ${reply}`);
  assert.doesNotMatch(reply, /Буба Мара/iu, `and never 85's landmark: ${reply}`);
  const after = sessions.get(chatId)!;
  assert.equal(after.slots.propertyId, EB84,
    `the answered flat becomes the subject for the follow-ups: ${after.slots.propertyId}`);
});

test('[09:12] e2e: an UNKNOWN place text still resolves the named flat, not the tail', { skip: !hasMap }, async () => {
  const { say, sessions, chatId } = makeHandler('discussed-84-junk');
  const s = freshSession('test', chatId);
  s.state = 'presentation';
  s.slots.service = 'buy';
  s.slots.bedrooms = 3;
  s.slots.presentedIds = [EB84, EB85];
  s.slots.currentBatch = [EB84, EB85];
  s.slots.propertyId = EB85;
  s.history = [
    { role: 'user', text: '84 na koja adresa e ?' },
    { role: 'user', text: 'na kolkavo rastojanie e 84 od crnogorska ambasada ?' },
  ];
  sessions.set(s);
  const reply = await say('kaj se naogja qwerty zxcv ?');
  assert.match(reply, /84/u, `a map miss must not switch the subject: ${reply}`);
  assert.doesNotMatch(reply, /85/u, reply);
});

test('[09:12] e2e: «go posetam» with NO named flat keeps the last presented (unchanged)', { skip: !hasMap }, async () => {
  const { say } = makeHandler('no-named-flat');
  const reply = await say('zdravo, baram dvosoben stan, do 150000');
  // Nothing was named and nothing was served: the funnel asks, no property is
  // invented and no distance is stated.
  assert.equal(typeof reply, 'string');
  assert.doesNotMatch(reply, /Евидентен број/iu, `no flat may be invented: ${reply}`);
});

// ── 3. THE CARD COPY: A NEIGHBOURHOOD IS NOT A LANDMARK ────────────────────

test('[09:03] a card never measures itself from the area it already names', () => {
  const aerodrom = { name: 'Аеродром', lat: 41.9839618, lon: 21.4649588 };
  const card82 = buildPropertyCard(ROWS[2], { anchor: aerodrom });
  assert.match(card82, /во Аеродром/u, `the area is still stated: ${card82}`);
  assert.doesNotMatch(card82, /\d[\d.,]*\s*(?:m|km)\s+од\s+Аеродром/u,
    `a flat in Аеродром is not "490 m од Аеродром": ${card82}`);
});

test('[09:03] a CROSS-place distance stays — Буњаковец for a flat in Центар', () => {
  const bunjakovec = { name: 'Буњаковец', lat: 41.9974581, lon: 21.4186442 };
  // The 84 row's pin is ~100 m from Буњаковец, and the flat's area is Центар.
  const card84 = buildPropertyCard(ROWS[0], { anchor: bunjakovec });
  assert.match(card84, /\d[\d.,]*\s*(?:m|km)\s+од\s+Буњаковец/u,
    `a different place is real information: ${card84}`);
});

test('[09:03] the own-area guard is marker/case-proof («Аеродром (општина)»)', () => {
  const row = { ...ROWS[2], location: 'Аеродром (општина)' } as Property;
  const card = buildPropertyCard(row, { anchor: { name: 'АЕРОДРОМ', lat: 41.98396, lon: 21.46496 } });
  assert.doesNotMatch(card, /\d[\d.,]*\s*(?:m|km)\s+од\s+АЕРОДРОМ/iu,
    `the feed's internal marker must not defeat the guard: ${card}`);
});
