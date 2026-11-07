// THE [09:41]–[09:51] BATCH — five serve defects over ONE two-card batch.
//
//   [09:43] pair served: EB 91 (its ad says «Маџар Маало») + EB 74 («Дебар Маало»)
//   [09:44] KOJ OD NIV E VO MADJAR MAALO?      → the SAME PAIR again (twice)
//   [09:47] KOLKU DOAGJA PO KVADRAT CENATA NA 91 ?   → correct (2.507 €/м²)
//   [09:48] NA KOLKAVO RASTOJANIE E OD ZELEZNICKA STANICA ? → BOTH distances
//   [09:51] KOLKU VI E PROVIZIJATA ?           → the pair AGAIN, no fee answer
//
// Each is pinned here through the real handler:
//   1. a WHICH-OF-THE-BATCH place question is answered per row, from the row's
//      OWN words — never re-served as the batch it asked about
//   2. a SINGULAR distance ask answers the flat under discussion alone; the
//      PLURAL form keeps the per-row comparison
//   3. a commission ask in property_locate serves the provision protocol of the
//      session's own service, not the cards
//   4. the waiver ack states what Lina does («Ви ги покажувам најголемите
//      прво»), never an imperative dropped into a statement
//
// The owner channel of the same burst («TOA E DENES TAKA ?», «DALI PRASUVATE
// ZA DENES ?») is pinned in tests/owner-relay.test.ts — the TUI seam that owns
// the owner; here the serve side only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession, ChatSession } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property, detectWhichOfBatchPlace, adArea } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { distanceAskIsPlural, detectProvisionAsk } from '../src/llm/deterministic';
import { waiverAck } from '../src/llm/prompts';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

/** The two rows the [09:43] pair was served from — both filed under Центар,
 *  which is exactly why the feed's naselba cannot answer the question: only
 *  the ads' own words separate Маџар Маало from Дебар Маало. */
const EB_91: Property = {
  eb: 91, id: 91, uuid: 'cap-91',
  address: 'МАЏАР МААЛО 12', location: 'Центар', details: 'Трисобен стан во Маџар Маало, две спални',
  service: 'buy', price: 178000, sqm: 71, size: '71 м²', bedrooms: 3,
  lat: 42.0037, lon: 21.4378, geo_source: 'stored',
} as Property;
const EB_74: Property = {
  eb: 74, id: 74, uuid: 'cap-74',
  address: 'ДЕБАР МААЛО 5', location: 'Центар', details: 'Трисобен стан во Дебар Маало, две спални',
  service: 'buy', price: 190000, sqm: 72, size: '72 м²', bedrooms: 3,
  lat: 42.0015, lon: 21.4285, geo_source: 'stored',
} as Property;
const ROWS = [EB_91, EB_74];

class FakeProps extends PropertyService {
  constructor() { super('http://feed-not-used'); }
  async getAll(): Promise<Property[]> { return ROWS; }
  async getByEb(eb: number): Promise<Property | undefined> { return ROWS.find(p => p.eb === eb); }
  async getById(id: number): Promise<Property | undefined> { return ROWS.find(p => p.id === id); }
  get healthy(): boolean { return true; }
}

const cfg = loadConfig();
let offlineMap: OfflineMapStore | undefined;
function map(): OfflineMapStore {
  if (!offlineMap) offlineMap = new OfflineMapStore(cfg.skopjePoisDb);
  return offlineMap;
}

async function makeHarness() {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const llm = new FailingLlm();
  const properties = new FakeProps();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier: new Classifier(llm, cfg, properties),
    responder: new Responder(llm, cfg), properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { offlineMap: map() }),
  } as any);
  const send = async (m: string): Promise<{ reply: string; s: ChatSession }> => {
    const n = sent.length;
    await handler.handle('test', 'cap', m);
    return { reply: sent.slice(n).join('\n'), s: sessions.get('cap')! };
  };
  // THE STATE THE BATCH WAS SERVED IN: the pair is on the table (both cards
  // presented) and the client's last two words are in the history.
  const seed = (patch: Partial<ChatSession['slots']> = {}): ChatSession => {
    const s = freshSession('test', 'cap');
    s.state = 'property_locate';
    s.slots = { service: 'buy', bedrooms: 2, budget: '180000', location: 'Центар',
      currentBatch: [91, 74], presentedIds: [91, 74], ...patch };
    s.history = [
      { role: 'user', text: 'ZNAM SAMO DEKA IMASE DVE SPALNI I CENA OKOLU 180 000' },
      { role: 'assistant', text: 'Евидентен број 91 — трисобен стан, во Центар, 71 м², 178.000 евра.\n'
        + 'Евидентен број 74 — трисобен стан, во Центар, 72 м², 190.000 евра.' },
    ];
    sessions.set(s);
    return s;
  };
  return { send, seed, sessions, sent };
}

// ── 1. WHICH OF THE OFFERED FLATS IS AT THAT PLACE ──────────────────────────

test('detectWhichOfBatchPlace: the [09:44] line and its spellings fire', () => {
  for (const t of ['KOJ OD NIV E VO MADJAR MAALO?', 'koja od ovie e vo debar maalo',
    'КОЈ ОД НИВ Е ВО МАЏАР МААЛО?', 'koe od tie e vo madjar maalo']) {
    assert.ok(detectWhichOfBatchPlace(t), `must fire: ${t}`);
  }
});

test('detectWhichOfBatchPlace: a search and a nearest-ask are never batch comparisons', () => {
  for (const t of [
    'KOJ STAN E VO CENTAR?',            // a search, no batch reference
    'KOJ E NAJBLISKU DO KATOLICKA?',    // the nearest lane owns it
    'KOJ OD NIV E PODOSTAPEN?',         // a batch comparison, but not by PLACE
    'DALI E VO MADJAR MAALO?',          // no which-word: the where-is lane owns it
  ]) {
    assert.equal(detectWhichOfBatchPlace(t), undefined, `must not fire: ${t}`);
  }
});

test('adArea: the area a card NAMES IN ITS OWN AD — never a landmark', () => {
  // The phrase extractor folds case (the address is typed in CAPITALS), so the
  // assertion folds too: the DISPLAY form is the caller's `cap()` — pinned by
  // the e2e below, which is the shape the client reads.
  assert.equal(adArea(EB_91)?.toLowerCase(), 'маџар маало');
  assert.equal(adArea(EB_74)?.toLowerCase(), 'дебар маало');
  assert.equal(adArea({ eb: 1, id: 1 } as Property), undefined);
  assert.equal(adArea({ eb: 2, id: 2, details: 'Стан во близина на Католичка црква' } as Property),
    undefined, 'a landmark phrase is not an area');
});

test('which-of-batch place: the flat that IS there is named, the other is said where it stands', async () => {
  const { send, seed } = await makeHarness();
  seed();
  const { reply, s } = await send('KOJ OD NIV E VO MADJAR MAALO?');
  assert.match(reply, /91/u, `the in-place flat must be named: ${reply}`);
  assert.match(reply, /Маџар Маало/u, `the place must be spoken in its card form: ${reply}`);
  assert.match(reply, /74/u, `the other flat must be accounted for: ${reply}`);
  assert.match(reply, /Дебар Маало/u, `…by ITS OWN area, never re-served: ${reply}`);
  // The old failure shape: the pair served verbatim as if it answered.
  assert.ok(!/Дали некој од овие е тој што го видовте/u.test(reply),
    `the batch must never be re-served as the answer: ${reply}`);
  assert.equal(s.slots.propertyId, 91, 'the in-place flat owns the conversation from here');
});

test('which-of-batch place: a batch with NO row in the place says so, with every row\'s real area', async () => {
  const { send, seed } = await makeHarness();
  seed();
  const { reply } = await send('KOJ OD NIV E VO KAPISTEC?');
  assert.match(reply, /Ниту една/u, `an honest absence: ${reply}`);
  assert.match(reply, /Маџар Маало/u, `each row's own area is stated: ${reply}`);
  assert.match(reply, /Дебар Маало/u, `each row's own area is stated: ${reply}`);
});

// ── 2. ONE FLAT ASKED, ONE FLAT ANSWERED ────────────────────────────────────

test('distanceAskIsPlural: «E» is the single flat, «SE» is the comparison', () => {
  assert.equal(distanceAskIsPlural('NA KOLKAVO RASTOJANIE E OD ZELEZNICKA STANICA ?'), false);
  assert.equal(distanceAskIsPlural('NA KOLKAVO RASTOJANIE SE OD ZELEZNICKA STANICA ?'), true);
  assert.equal(distanceAskIsPlural('KOLKU SE OD ZELEZNICKA STANICA?'), true);
});

test('singular distance ask answers the discussed flat alone (the [09:48] capture)', async () => {
  const { send, seed } = await makeHarness();
  seed({ propertyId: 91 }); // the «which» answer above pinned 91
  const { reply } = await send('NA KOLKAVO RASTOJANIE E OD ZELEZNICKA STANICA ?');
  assert.match(reply, /91/u, `the discussed flat must be answered: ${reply}`);
  assert.ok(!/74/u.test(reply), `the other flat of the batch must stay out: ${reply}`);
  assert.match(reply, /километри|метри/u, `a measured distance: ${reply}`);
});

test('plural distance ask keeps the per-row comparison', async () => {
  const { send, seed } = await makeHarness();
  seed({ propertyId: 91 });
  const { reply } = await send('NA KOLKAVO RASTOJANIE SE OD ZELEZNICKA STANICA ?');
  assert.match(reply, /91/u, `row 91: ${reply}`);
  assert.match(reply, /74/u, `row 74: ${reply}`);
});

// ── 3. A COMMISSION ASK IS THE PROVISION PROTOCOL, NOT THE CARDS ────────────

test('«KOLKU VI E PROVIZIJATA ?» in property_locate serves the buy provision rules', async () => {
  const { send, seed } = await makeHarness();
  seed();
  assert.ok(detectProvisionAsk('KOLKU VI E PROVIZIJATA ?'), 'the detector must fire');
  const { reply, s } = await send('KOLKU VI E PROVIZIJATA ?');
  assert.match(reply, /0\s*%/u, `the buy commission must be stated: ${reply}`);
  assert.match(reply, /500\s*денари|10\s*евра/u, `the visit fee must be stated: ${reply}`);
  assert.ok(!/Дали некој од овие е тој што го видовте/u.test(reply),
    `the batch must never be re-served for a fee question: ${reply}`);
  assert.equal(s.state, 'property_locate', 'a fee question keeps the locate state');
});

// ── 4. THE WAIVER ACK IS A STATEMENT, NOT AN IMPERATIVE ────────────────────

test('waiverAck: «Ви ги покажувам најголемите прво» — the [10:05] grammar fix', () => {
  const line = waiverAck('300');
  assert.match(line, /Ви ги покажувам најголемите прво/u, line);
  assert.ok(!/покажувај\b/u.test(line), `never the imperative dropped into a statement: ${line}`);
  assert.match(line, /300/u, `the client's REAL budget is named: ${line}`);
});
