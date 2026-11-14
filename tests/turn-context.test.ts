// THE TURN RECORD (proposal Phase 2).
//
// Two rules, both of them structural rather than cosmetic:
//
//   1. PER-TURN VALUES BELONG TO THE TURN, NOT TO THE HANDLER. `lastUserText`,
//      `detGaveUp` and `feeServiceHint` were instance fields, and the TUI runs
//      ONE `InboundHandler` for EVERY chat (src/tui/app.ts) — the per-chat queue
//      only serializes turns INSIDE one chat, so two clients mid-turn at the
//      same time shared those three values. A lane that answered flow A could
//      read flow B's message. This test drives exactly that interleaving
//      through the real `handle()` path.
//
//   2. THE AUDIT HOLDS WHAT WAS SENT. Until now the served lane lived only in
//      console lines and every lane kept its own idea of the reply (the
//      proposal's claim G). The record is appended by `sendRaw` — the one
//      function that hands bytes to the transport — so it cannot disagree with
//      the client, and it rides the session so the NEXT turn can explain the
//      answer it is being asked about.

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

const ROWS: Property[] = [
  {
    eb: 44, id: 44, location: 'Скопје Север', address: 'Скопје Север',
    price: 130000, bedrooms: 4, sqm: 150, service: 'buy', house: true,
    lat: 42.0345, lon: 21.4149, geo_source: 'osm_street_anchor',
    features: ['парно'], details: 'Куќа со двор.',
  } as Property,
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  async getAllEbs(): Promise<Set<number>> { return new Set(this.rows.map(r => r.eb)); }
  get healthy(): boolean { return true; }
}

function makeHandler(sendHook?: (chatId: string, text: string) => Promise<void>): {
  handler: InboundHandler; sessions: SessionStore; sent: Map<string, string[]>;
} {
  const mapPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'turn-ctx-')), 'map.db');
  writeMap(mapPath, [], []);
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent = new Map<string, string[]>();
  channels.register({
    name: 'test',
    send: async (chatId, text) => {
      const list = sent.get(chatId) ?? [];
      list.push(text);
      sent.set(chatId, list);
      if (sendHook) await sendHook(chatId, text);
    },
  });
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

test('per-turn values do not cross between two chats mid-turn on ONE handler', async () => {
  const A_TEXT = 'ZDRAVO, BARAM STAN VO CENTAR DO 90000';
  const B_TEXT = 'DALI IMA KUKJA VO SKOPJE SEVER ?';
  let observedInA: { text: string; detGaveUp: boolean; service: string | undefined } | undefined;

  let hookFired = false;
  const { handler } = makeHandler(async (chatId) => {
    // A's reply is being delivered while A's turn is still in flight (sendRaw is
    // awaited inside the turn). Run B's WHOLE turn from here — this is the
    // interleaving the single-handler TUI produces every day — then read the
    // per-turn values A's turn is still holding.
    if (chatId !== 'chat-A' || hookFired) return;
    hookFired = true;
    await handler.handle('test', 'chat-B', B_TEXT);
    const h = handler as unknown as {
      lastUserText: string; detGaveUp: boolean; feeServiceHint: string | undefined;
    };
    observedInA = { text: h.lastUserText, detGaveUp: h.detGaveUp, service: h.feeServiceHint };
  });

  await handler.handle('test', 'chat-A', A_TEXT);
  assert.ok(hookFired, 'the interleaving must actually run');
  assert.ok(observedInA, 'A\'s turn must still be readable after B finished');
  assert.equal(observedInA!.text, A_TEXT,
    'A\'s turn keeps A\'s raw message — never the other client\'s');
});

test('the audit record holds the exact text the client received', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'chat-audit';
  const s = freshSession('test', chatId);
  s.slots.currentBatch = [44];
  s.slots.presentedIds = [44];
  s.slots.propertyId = 44;
  s.slots.service = 'buy';
  sessions.set(s);

  await handler.handle('test', chatId, 'KOJA MU E TOCNATA LOKACIJA ?');
  const delivered = sent.get(chatId) ?? [];
  assert.ok(delivered.length > 0, 'the turn must answer');

  const lastTurn = sessions.get(chatId)!.lastTurn;
  assert.ok(lastTurn, 'every turn leaves a record on the session');
  assert.equal(lastTurn!.text, 'KOJA MU E TOCNATA LOKACIJA ?', 'the raw inbound text');
  assert.deepEqual(lastTurn!.replies, delivered,
    'the record IS what was sent — no lane keeps its own belief about the reply');
  assert.ok(lastTurn!.lanes.length > 0, `the serving lane is recorded: ${lastTurn!.lanes.join(',')}`);
  assert.equal(typeof lastTurn!.stateBefore, 'string');
  assert.equal(typeof lastTurn!.stateAfter, 'string');
  assert.ok(lastTurn!.source, 'how the reply was chosen is recorded');
});

test('the next turn carries the previous record (so it can be explained)', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'chat-audit-chain';
  const s = freshSession('test', chatId);
  s.slots.currentBatch = [44];
  s.slots.presentedIds = [44];
  s.slots.propertyId = 44;
  s.slots.service = 'buy';
  sessions.set(s);
  await handler.handle('test', chatId, 'KOJA MU E TOCNATA LOKACIJA ?');
  const firstReply = (sent.get(chatId) ?? [])[0];

  await handler.handle('test', chatId, 'DALI E SLOBODNA ?');
  const lastTurn = sessions.get(chatId)!.lastTurn;
  assert.ok(lastTurn?.previous, 'the second turn keeps the first one');
  assert.equal(lastTurn!.previous!.text, 'KOJA MU E TOCNATA LOKACIJA ?');
  assert.deepEqual(lastTurn!.previous!.replies, [firstReply],
    'the previous answer is available verbatim — the explanation lane\'s only honest input');
});
