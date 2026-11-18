/**
 * THE [09:04]–[09:08] V16K11 CHAT — TWO LANDMARKS, TWO ROOM CATEGORIES.
 *
 *   [09:04] ZDRAVO
 *   [09:05] SAKAM DA KUPAM STANCE KAJ BUNJAKOVEC ILI KAPITOL MOL — STO IMATE VO PONUDA
 *   [09:07] EDNA SPALNA DO 150000 ILI DVE SPALNI DO 180000
 *   [09:07] ЛИНА: EB 84 + EB 77 — BOTH «до Буњаковец»
 *   [09:08] DRUGO NESTO → EB 66 — again Буњаковец
 *
 * The client named TWO landmarks and TWO room categories with a cap each. The
 * serve answered with one landmark and mixed categories, and the second place
 * he named never got a single card.
 *
 * THE ORDER THE OWNER PINNED (this file is its contract):
 *   turn 1 — one-bedroom @ landmark 1, one-bedroom @ landmark 2
 *   turn 2 — two-bedroom @ landmark 1, two-bedroom @ landmark 2
 *   turn 3 — one-bedroom @ landmark 1, one-bedroom @ landmark 2  … loop
 *   until every row at both landmarks is shown;
 * a landmark with nothing left in the turn's category serves the OTHER
 * category instead, and the cell that ran dry is SAID, once, above the cards.
 *
 * The feed's `bedrooms` field is ROOMS (2 = двособен = one bedroom, 3 =
 * трисобен = two bedrooms) — the axis `categoryBudgets` is keyed on, so the
 * assertions use the client's own words: «една спална» = 2 rooms.
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
import { extractPoiListCandidates } from '../src/llm/deterministic';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// The map's own pins for the two places the client named (the production POI
// DB in tests too — the ordering is a real distance ladder, not a stub).
const BUNJAKOVEC = { lat: 41.9974581, lon: 21.4186442 };
const KAPITOL = { lat: 41.9858966, lon: 21.4666295 };
const off = (b: { lat: number; lon: number }, dn: number, de: number) => ({ lat: b.lat + dn, lon: b.lon + de });
const row = (eb: number, at: { lat: number; lon: number }, rooms: number, price: number, sqm: number): Property =>
  ({ eb, id: eb, location: 'Центар', price, bedrooms: rooms, sqm, size: `${sqm} м²`, service: 'buy', ...at } as Property);

// 2 rooms = one bedroom, 3 rooms = two bedrooms, each under the cap the client
// gave for THAT category (150.000 / 180.000).
const ROWS: Property[] = [
  row(101, off(BUNJAKOVEC, 0.0005, 0.0005), 2, 140000, 50),
  row(102, off(BUNJAKOVEC, 0.0010, 0.0006), 2, 145000, 52),
  row(201, off(KAPITOL, 0.0006, 0.0004), 2, 148000, 55),
  row(301, off(BUNJAKOVEC, 0.0011, 0.0004), 3, 175000, 70),
  row(401, off(KAPITOL, 0.0008, 0.0005), 3, 178000, 72),
  row(402, off(KAPITOL, 0.0012, 0.0007), 3, 170000, 68),
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id); }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string) {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const props = new FakeProps(ROWS);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId: id, rows: ROWS };
}

const ebsIn = (text: string): number[] => (text.match(/Евидентен број (\d+)/gu) ?? [])
  .map(m => Number(m.replace(/\D/g, '')));

const ASK = 'SAKAM DA KUPAM STANCE KAJ BUNJAKOVEC ILI KAPITOL MOL STO IMATE VO PONUDA';
const CAPS = 'EDNA SPALNA DO 150000 ILI DVE SPALNI DO 180000';

// ── THE READER: BOTH LANDMARKS FROM ONE MESSAGE ──────────────────────────────

test('[09:05] both landmarks survive the trailing question — the live phrasing included', () => {
  // THE FIELD STRING: the second name used to keep «STO IMATE VO PONUDA» on its
  // tail, fail the ≤4-word veto, and drop out of the list entirely.
  for (const t of [
    'SAKAM DA KUPAM STANCE KAJ BUNJAKOVEC ILI KAPITOL MOL STO IMATE VO PONUDA',
    'STANCE KAJ BUNJAKOVEC ILI KAPITOL MOL',
    'STAN KAJ BUNJAKOVEC I KAPITOL MOL',
    'сакам стан кај Буњаковец или Капитол Мол што имате во понуда',
  ]) {
    const found = extractPoiListCandidates(t);
    assert.equal(found.length, 2, `two places: ${t} → ${JSON.stringify(found)}`);
  }
  // A single place keeps its single reading (no invented second).
  assert.equal(extractPoiListCandidates('STAN KAJ BUNJAKOVEC').length, 1);
});

// ── THE SERVE ORDER ─────────────────────────────────────────────────────────

test('[09:07] turn 1 is ONE BEDROOM at BOTH landmarks — never two cards from one place', async () => {
  const { say, sessions, chatId } = makeHandler('two-lm-t1');
  await say(ASK);
  const s0 = sessions.get(chatId)!;
  assert.deepEqual((s0.slots.poiPlaces ?? []).map(p => p.name),
    ['Буњаковец', 'Трговски центар Капитол'],
    'both places the client named anchor the search');

  const first = await say(CAPS);
  const s = sessions.get(chatId)!;
  assert.deepEqual(s.slots.categoryBudgets, { '2': '150000', '3': '180000' },
    'each category keeps its own cap');
  const ebs = ebsIn(first);
  assert.equal(ebs.length, 2, `a pair is served: ${first}`);
  const roomsOf = (ids: number[]) => ids.map(id => ROWS.find(r => r.eb === id)!.bedrooms);
  assert.deepEqual(roomsOf(ebs).sort(), [2, 2],
    `turn 1 is the ONE-BEDROOM category on both cards: ${JSON.stringify(ebs)}`);
  // One card per landmark — the anchor is what the card states.
  const anchors = ebs.map(id => s.slots.pairAnchorOf?.[String(id)]?.name);
  assert.deepEqual([...anchors].sort(), ['Буњаковец', 'Трговски центар Капитол'],
    `one card per landmark: ${JSON.stringify(anchors)}`);
  // Each card sits inside ITS OWN cap (the one-bedroom one, 150.000).
  for (const id of ebs) {
    const p = ROWS.find(r => r.eb === id)!;
    assert.ok((p.price as number) <= 150000, `EB ${id} is under the one-bedroom cap`);
  }
});

test('[09:07] turn 2 is TWO BEDROOMS at both landmarks, and the drained cell is SAID', async () => {
  const { say } = makeHandler('two-lm-t2');
  await say(ASK);
  await say(CAPS);

  const second = await say('POKAZI MI STO USTE IMATE');
  const ebs = ebsIn(second);
  assert.equal(ebs.length, 2, `a pair is served: ${second}`);
  const roomsOf = (ids: number[]) => ids.map(id => ROWS.find(r => r.eb === id)!.bedrooms);
  assert.deepEqual(roomsOf(ebs).sort(), [3, 3],
    `turn 2 is the TWO-BEDROOM category on both cards: ${JSON.stringify(ebs)}`);
  for (const id of ebs) {
    const p = ROWS.find(r => r.eb === id)!;
    assert.ok((p.price as number) <= 180000, `EB ${id} is under the two-bedroom cap`);
  }
  // The one-bedroom stock at Капитол is gone (EB 201 was its only row) — the
  // card that took that slot is a two-bedroom, and the turn SAYS so.
  assert.match(second, /Трговски центар Капитол/u,
    `the drained landmark is named: ${second}`);
  assert.match(second, /двособни/u,
    `the drained category is named in the client's own word: ${second}`);
});

test('[09:08] the rotation loops — turn 3 comes back to ONE BEDROOM, substituting where it ran dry', async () => {
  const { say } = makeHandler('two-lm-t3');
  await say(ASK);
  await say(CAPS);
  await say('POKAZI MI STO USTE IMATE');   // turn 2: two bedrooms at both

  const third = await say('POKAZI MI STO USTE IMATE');
  const ebs = ebsIn(third);
  assert.equal(ebs.length, 2, `a pair is served: ${third}`);
  assert.ok(ebs.includes(102),
    `the remaining ONE-BEDROOM flat (EB 102, Буњаковец) leads turn 3: ${JSON.stringify(ebs)}`);
  // Капитол has no second one-bedroom: that slot is served from the OTHER
  // requested category (the owner's substitution rule), never left empty and
  // never filled from the first landmark.
  const rows = ebs.map(id => ROWS.find(r => r.eb === id)!);
  assert.deepEqual(rows.map(p => p.bedrooms).sort(), [2, 3],
    `one card of each category once a cell is empty: ${JSON.stringify(ebs)}`);
  assert.match(third, /Трговски центар Капитол/u,
    `and the substitution is stated: ${third}`);
});

test('[09:08] every row at both landmarks is eventually shown, and only then is the search drained', async () => {
  const { say, sessions, chatId } = makeHandler('two-lm-all');
  await say(ASK);
  await say(CAPS);
  const seen = new Set<number>(sessions.get(chatId)!.slots.currentBatch ?? []);
  for (let i = 0; i < 3; i++) {
    const reply = await say('POKAZI MI STO USTE IMATE');
    for (const id of ebsIn(reply)) seen.add(id);
    if (ebsIn(reply).length === 0) break;
  }
  assert.deepEqual([...seen].sort(), [101, 102, 201, 301, 401, 402],
    `all six rows at both landmarks reach the client: ${JSON.stringify([...seen])}`);

  // DRAINED: the line names BOTH landmarks — a two-place search never claims
  // that one of them was the whole story.
  const drained = await say('POKAZI MI STO USTE IMATE');
  assert.match(drained, /Буњаковец/u, `the first landmark is named: ${drained}`);
  assert.match(drained, /Капитол/u, `and the second one too: ${drained}`);
});

test('[09:07] a landmark with no one-bedroom row at all serves two-bedrooms there and says it', async () => {
  // Капитол keeps ONLY two-bedroom rows; the client's first turn asks for
  // one-bedroom — the owner's rule is to serve the other category at THAT place
  // and say why, never to leave the place out of the pair.
  const rows = ROWS.filter(r => r.eb !== 201);          // no one-bedroom at Капитол
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const props = new FakeProps(rows);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  await handler.handle('test', 'two-lm-empty', ASK);
  await handler.handle('test', 'two-lm-empty', CAPS);
  const reply = sent.at(-1) ?? '';
  const ebs = ebsIn(reply);
  const kap = ebs.map(id => rows.find(r => r.eb === id)!).filter(p => p.bedrooms === 3);
  assert.ok(kap.length >= 1, `a card at Капитол rides the very first pair: ${reply}`);
  assert.match(reply, /Трговски центар Капитол/u, `the place is named: ${reply}`);
  assert.match(reply, /во моментов нема двособни/u,
    `the missing one-bedroom stock at that landmark is stated: ${reply}`);
  assert.match(reply, /150\.000/u,
    `with the cap the client gave for that category: ${reply}`);
});
