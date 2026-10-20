// TOP-OF-FUNNEL GENERATE + STORE — the closed loop's missing half (2026-10-21).
//
// Recall alone only pays off if the store fills, and the store only filled when
// escalate() was reached — i.e. when no broad lane answered. A misroute looks
// like a success, so nothing was learned. The contract pinned here:
//
//   deterministicClassify gives up + the gates allow it
//   → ONE constrained Gemini answer
//   → validated (no facts, clean) → served NOW and stored in bank_dynamic
//   → the SAME phrasing next time is served from the store, no LLM.
//
// And the exclusions that keep the funnel deterministic: money/availability/
// contact traffic, protocol states, fillers and greetings never generate.

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
import { BankStore } from '../src/store/bank';
import { shouldTryDynamic, inProtocolState } from '../src/llm/dynamicFallback';

class ThrowingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('LLM must not be called'); }
}
class ScriptedLlm implements LlmClient {
  constructor(private reply: string) {}
  async complete(): Promise<string> { return this.reply; }
}
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
}

const CLEAN = 'Секогаш почнуваме со преглед на документацијата на недвижноста. Дали сакате да организираме посета за да ги видите документите во оригинал?';
// A genuinely uncovered question (the [00:33] capture fell through from the
// deterministic classifier) that no funnel state owns.
const ASK = 'kade ima reptil tamu ?';

function handlerWith(dbFile: string, llm: LlmClient) {
  const cfg = loadConfig();
  const db = new Db(dbFile);
  const sessions = new SessionStore(db);
  const props = new FakeProps([
    { eb: 76, id: 76, location: 'Центар', price: 185000, service: 'buy', size: '80 м²' } as Property,
  ]);
  const channels = new ChannelRegistry();
  const sent: Array<{ text: string; source?: string }> = [];
  channels.register({ name: 'test', send: async (_c, text, source) => { sent.push({ text, source }); } });
  const mapPath = path.join(path.dirname(dbFile), 'map.db');
  if (!fs.existsSync(mapPath)) writeMap(mapPath, [], []);
  const offlineMap = new OfflineMapStore(mapPath);
  const bank = new BankStore(db);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(llm, cfg, props),
    responder: new Responder(llm, cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db), meta: new MetaStore(db),
    channels, landmarks: new LandmarkService(db, { osm: false, offlineMap }), bank,
  });
  return { handler, sessions, bank, sent, offlineMap };
}

test('gate: a real uncovered question generates; money/protocol/fillers do not', () => {
  const s = freshSession('test', 'gate');
  s.state = 'idle';
  assert.equal(shouldTryDynamic(s, ASK), true);
  // fsmRequired messages own their own path even when they end in "?" — the
  // FSM's required slot question is the answer, not generated prose.
  assert.equal(shouldTryDynamic(s, 'i sto drugo?'), false);
  // Fillers / greetings are not questions.
  assert.equal(shouldTryDynamic(s, 'MOZE'), false);
  assert.equal(shouldTryDynamic(s, 'ZDRAVO'), false);
  assert.equal(shouldTryDynamic(s, 'TWO'), false);
  // Frozen / data-driven traffic keeps its own lane.
  assert.equal(shouldTryDynamic(s, 'kolku e provizijata?'), false);
  assert.equal(shouldTryDynamic(s, 'dali e sloboden?'), false);
  assert.equal(shouldTryDynamic(s, 'kolku e cenata?'), false);
  assert.equal(shouldTryDynamic(s, 'daj mi go telefonot na sopstvenikot?'), false);
  // The protocol sub-funnel never generates prose.
  const feeState = freshSession('test', 'gate2');
  feeState.state = 'closing';
  assert.equal(inProtocolState(feeState), true);
  assert.equal(shouldTryDynamic(feeState, 'kade ima reptil tamu ?'), false);
});

test('top-of-funnel: one constrained answer is served AND stored; the same ask is free next time', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dyn-top-'));
  const dbFile = path.join(dir, 'lina.db');
  const first = handlerWith(dbFile, new ScriptedLlm(CLEAN));
  try {
    const s = freshSession('test', 'dyn-1');
    s.state = 'idle';
    first.sessions.set(s);
    await first.handler.handle('test', 'dyn-1', ASK);
    assert.equal(first.sent.at(-1)?.text, CLEAN, 'the generated answer must serve');
    assert.equal(first.sent.at(-1)?.source, 'dynamic');
    assert.equal(first.bank.dynamicGroups().length, 1, 'and be stored immediately');
  } finally {
    first.offlineMap.close();
  }

  // Fresh process over the SAME store, with an LLM that throws: the answer
  // must come from bank_dynamic, not from Gemini.
  const second = handlerWith(dbFile, new ThrowingLlm());
  try {
    const s = freshSession('test', 'dyn-1');
    s.state = 'idle';
    second.sessions.set(s);
    await second.handler.handle('test', 'dyn-1', ASK);
    assert.equal(second.sent.at(-1)?.text, CLEAN, 'the stored answer must serve');
    assert.equal(second.sent.at(-1)?.source, 'dynamic-recall');
  } finally {
    second.offlineMap.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dirty generation stores nothing and does not serve', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dyn-top-'));
  const dbFile = path.join(dir, 'lina.db');
  const { handler, sessions, bank, sent, offlineMap } = handlerWith(dbFile, new ScriptedLlm('Станот чини 143.000 евра и е слободен веднаш.'));
  try {
    const s = freshSession('test', 'dyn-2');
    s.state = 'idle';
    sessions.set(s);
    await handler.handle('test', 'dyn-2', ASK);
    assert.notEqual(sent.at(-1)?.text, 'Станот чини 143.000 евра и е слободен веднаш.');
    assert.equal(bank.dynamicGroups().length, 0, 'a fact-carrying answer must never be stored');
  } finally {
    offlineMap.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
