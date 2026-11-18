/**
 * THE CHOKE OWNS THE LADDER (the [09:14] V16K11 audit).
 *
 * Every batch serve crosses `serveBatch`. Lanes that carve their OWN pool — the
 * cheaper pivot, the pricier one, another area, a discovered category — served
 * rows that the armed ladder queue still held, so the next carve served them a
 * SECOND time: the client saw the same pair twice and the rotation lost its
 * place. The `MORE_STOCK` lane had the same shape (see its executor) and is the
 * case that exposed it.
 *
 * This file pins the structural invariant, independent of which lane breaks it:
 *   • a served row leaves the ladder queue in the same turn it is served;
 *   • `presentedIds` never carries a duplicate (two lanes carving the same row,
 *     or a lane that carved through `loadProps` and served again);
 *   • so a client who keeps asking for stock never sees a flat twice.
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
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// Six two-bedroom flats in Центар. The pool is ranked by price-closest to the
// cap, so the FIRST pair is the dear end (200k / 210k) while the two CHEAPEST
// (50k / 51k) are the pair the cheaper pivot serves — and the two that sat in
// the ladder queue. That overlap is what used to come back twice.
const ROWS: Property[] = [
  { eb: 11, id: 11, location: 'Центар', price: 100000, service: 'buy', bedrooms: 2, sqm: 50, size: '50 м²', details: 'Двособен стан.' },
  { eb: 12, id: 12, location: 'Центар', price: 101000, service: 'buy', bedrooms: 2, sqm: 51, size: '51 м²', details: 'Двособен стан.' },
  { eb: 13, id: 13, location: 'Центар', price: 50000, service: 'buy', bedrooms: 2, sqm: 44, size: '44 м²', details: 'Двособен стан.' },
  { eb: 14, id: 14, location: 'Центар', price: 51000, service: 'buy', bedrooms: 2, sqm: 45, size: '45 м²', details: 'Двособен стан.' },
  { eb: 15, id: 15, location: 'Центар', price: 200000, service: 'buy', bedrooms: 2, sqm: 70, size: '70 м²', details: 'Двособен стан.' },
  { eb: 16, id: 16, location: 'Центар', price: 210000, service: 'buy', bedrooms: 2, sqm: 72, size: '72 м²', details: 'Двособен стан.' },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://feed-not-used'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(p => p.eb === eb); }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(p => p.id === id); }
  async locations(): Promise<string[]> { return [...new Set(this.rows.map(r => r.location ?? '').filter(Boolean))]; }
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
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent.at(-1) ?? '';
  };
  handlers.set(id, handler);
  return { say, sessions, chatId: id };
}

const ebsIn = (text: string): number[] =>
  [...new Set((text.match(/Евидентен број (\d+)/gu) ?? []).map(m => Number(m.replace(/\D/g, ''))))];

test('the choke retires a served batch from the ladder, whoever carved it', async () => {
  const { say, sessions, chatId } = makeHandler('choke-retire');
  await say('CENTAR');
  await say('STAN MI TREBA');
  await say('DO 220000 ZA KUPUVANJE');
  await say('DVOSOBEN');
  await say('DAJ MI POKAZI');

  const s = sessions.get(chatId)!;
  const queueBefore = [...(s.slots.ladderQueue ?? [])];
  assert.ok(queueBefore.length > 0, 'the ladder is armed with the rest of the pool');

  // A LANE WITH ITS OWN POOL — exactly the shape every pivot uses: it slices a
  // batch straight out of the feed and hands it to the choke, without touching
  // the ladder. Two of those rows are still queued for a later turn.
  const ownPool = ROWS.filter(p => queueBefore.includes(p.id)).slice(0, 2);
  assert.equal(ownPool.length, 2, 'two queued rows are carved by the lane');
  await (handlerOf(sessions, chatId) as unknown as {
    serveBatch: (s: unknown, b: Property[], i: string, e: string, k: string) => Promise<true>;
  }).serveBatch(s, ownPool, 'Еве ги следните опции:', 'CHEAPER_SEARCH', 'price.shy');

  const after = sessions.get(chatId)!;
  for (const p of ownPool) {
    assert.ok(!(after.slots.ladderQueue ?? []).includes(p.id),
      `EB ${p.id} was served and must leave the ladder: ${JSON.stringify(after.slots.ladderQueue)}`);
  }
  const presented = after.slots.presentedIds ?? [];
  assert.equal(new Set(presented).size, presented.length,
    `presentedIds carries no duplicate: ${JSON.stringify(presented)}`);
});

/** The handler behind a chat — the choke test drives `serveBatch` directly. */
const handlers = new Map<string, InboundHandler>();
function handlerOf(_sessions: SessionStore, chatId: string): InboundHandler {
  const h = handlers.get(chatId);
  assert.ok(h, 'the handler is registered by makeHandler');
  return h;
}

test('a lane that never crosses the choke cannot get its rows served again', async () => {
  const { say, sessions, chatId } = makeHandler('choke-extreme');
  await say('CENTAR');
  await say('STAN MI TREBA');
  await say('DO 220000 ZA KUPUVANJE');
  await say('DVOSOBEN');
  await say('DAJ MI POKAZI');

  const armed = [...(sessions.get(chatId)!.slots.ladderQueue ?? [])];
  assert.ok(armed.length > 0, 'the ladder is armed');

  // THE PRICE-EXTREME LIST is one of the lanes with its OWN pool: it ranks the
  // whole feed, sends `buildPropertyCard` in its own reply and never calls
  // `serveBatch`. It records the rows in the notebook, and the ladder's carve
  // maps its queue through the notebook-excluded pool — so the rows can never
  // come back in a later batch. This test is the guard on that second line of
  // defence (it held before the choke fix, and must keep holding now that the
  // choke is the only lane that retires).
  const extreme = await say('KOJ E NAJEVTINIOT STAN?');
  const shown = ebsIn(extreme);
  assert.ok(shown.length >= 1, `the extreme list serves a card: ${extreme}`);

  const more = await say('POKAZI MI STO USTE IMATE');
  for (const eb of ebsIn(more)) {
    assert.ok(!shown.includes(eb),
      `EB ${eb} was served by the extreme lane and came back: ${JSON.stringify(shown)} then ${JSON.stringify(ebsIn(more))}`);
  }
  const s = sessions.get(chatId)!;
  const presented = s.slots.presentedIds ?? [];
  assert.equal(new Set(presented).size, presented.length,
    `presentedIds carries no duplicate: ${JSON.stringify(presented)}`);
});

test('every card the client receives is a flat he has not been shown on this search', async () => {
  const { say, sessions, chatId } = makeHandler('choke-no-repeat');
  await say('CENTAR');
  await say('STAN MI TREBA');
  await say('DO 220000 ZA KUPUVANJE');
  await say('DVOSOBEN');

  const seen: number[] = [];
  let reply = await say('DAJ MI POKAZI');
  seen.push(...ebsIn(reply));
  for (let i = 0; i < 4; i++) {
    // Alternate the two shapes that used to re-derive a serve: a price pivot
    // (its own pool) and a plain stock ask (the shared ladder).
    reply = await say(i % 2 === 0 ? 'DAJ MI POEVTINO' : 'POKAZI MI STO USTE IMATE');
    for (const eb of ebsIn(reply)) {
      assert.ok(!seen.includes(eb), `EB ${eb} was already served in this search`);
      seen.push(eb);
    }
  }
  const s = sessions.get(chatId)!;
  const presented = s.slots.presentedIds ?? [];
  assert.equal(new Set(presented).size, presented.length,
    `presentedIds carries no duplicate: ${JSON.stringify(presented)}`);
  assert.ok(seen.length >= 4, `the client was shown several distinct flats: ${JSON.stringify(seen)}`);
});
