// LEARNED RECALL — the closed loop's fast lane (2026-10-21).
//
// Before this, a stored `bank_dynamic` answer was only reachable inside
// escalate(): after every deterministic lane. A phrasing the detectors missed
// therefore still paid for the LLM classifier (and often got a generic lane's
// answer instead of the stored one). The contract pinned here:
//
//   deterministicClassify gives up + an EXACT/word-bounded stored answer exists
//   in the SAME FSM state  →  serve it, no classifier call, no Gemini.
//
// And the negative half: a different state must not serve it (a `closing`
// answer cannot appear in `idle`), and a non-matching phrasing must fall
// through unchanged.

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

class ThrowingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('LLM must not be called for a recalled answer'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
}

function harness() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps([
    { eb: 76, id: 76, location: 'Центар', price: 185000, service: 'buy', size: '80 м²' } as Property,
  ]);
  const llm = new ThrowingLlm();
  const channels = new ChannelRegistry();
  const sent: Array<{ text: string; source?: string }> = [];
  channels.register({ name: 'test', send: async (_c, text, source) => { sent.push({ text, source }); } });
  const mapPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'learned-recall-')), 'map.db');
  writeMap(mapPath, [], []);
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

const ANSWER = 'Плацот е во близина на неколку продавници и училиште. Дали сакате да го разгледаме во живо?';
const ASK = 'kade ima reptil tamu ?';

test('learned recall: an exact stored answer serves at the top of the funnel, no LLM', async () => {
  const { handler, sessions, bank, sent, offlineMap } = harness();
  try {
    assert.equal(bank.addDynamic('dynamic:closing:reptil', 'closing', ASK, ANSWER), true);
    const s = freshSession('test', 'recall-1');
    s.state = 'closing';
    sessions.set(s);

    // ThrowingLlm would make the turn fail loudly if the classifier or the
    // escalation LLM were touched — the stored answer must bypass both.
    await handler.handle('test', 'recall-1', ASK);
    assert.equal(sent.at(-1)?.text, ANSWER, 'the stored answer must be the reply');
    assert.equal(sent.at(-1)?.source, 'dynamic-recall');
  } finally {
    offlineMap.close();
  }
});

test('learned recall: a different FSM state does not serve the stored answer', async () => {
  const { handler, sessions, bank, sent, offlineMap } = harness();
  try {
    assert.equal(bank.addDynamic('dynamic:closing:reptil', 'closing', ASK, ANSWER), true);
    const s = freshSession('test', 'recall-2');
    s.state = 'idle';
    sessions.set(s);
    await handler.handle('test', 'recall-2', ASK);
    assert.notEqual(sent.at(-1)?.text, ANSWER, 'closing answer must not leak into idle');
  } finally {
    offlineMap.close();
  }
});

test('learned recall: a non-matching phrasing is untouched (no hijack)', async () => {
  const { handler, sessions, bank, sent, offlineMap } = harness();
  try {
    assert.equal(bank.addDynamic('dynamic:closing:reptil', 'closing', ASK, ANSWER), true);
    const s = freshSession('test', 'recall-3');
    s.state = 'closing';
    sessions.set(s);
    await handler.handle('test', 'recall-3', 'kolku e visok plafonot?');
    assert.notEqual(sent.at(-1)?.text, ANSWER);
  } finally {
    offlineMap.close();
  }
});
