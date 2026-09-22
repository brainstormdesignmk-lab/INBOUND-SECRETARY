// THE [09:41] TRANSCRIPT — the client complained "MNOGU SE POSKAPEA STANOVIVE"
// (prices got much more expensive) and Lina answered with the BUYER-FEE pitch:
// "ослободени од агенциска провизија (0%)… симболични 500 денари… Дали се
// согласувате…?" — a funnel-jump the LLM would misread as visit interest.
// The agency already HAS the right answer: the investment.opinion bank
// ("моменталните цени… агенцијата не ги формира сумите…"). It was never used
// because detectInvestmentOpinion required a цена/cena NOUN near the
// sentiment — this complaint carries it on the VERB (поскапеа), matched
// nothing, and the closing fallback fee-asked.
//
// Fix: INVESTMENT_VERB_RE (поскап/poskap stem, letter-guarded) OR-ed into
// detectInvestmentOpinion, so the complaint reaches the existing fast leg
// (inbound.ts ~1251) and the FSM leg (~2277) and serves the bank wording.
//
// NOTE on wording: the operator's sketch ("TOA SE MOMENTALNITE CENI...") is
// NOT a separate key — it IS investment.opinion. This test pins the routing,
// not new prose.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { detectInvestmentOpinion } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

function tmpMapDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'investverb-')), 'map.db');
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
}

test('detectInvestmentOpinion: verb-carried complaint family (09:41)', () => {
  // The exact transcript line
  assert.equal(detectInvestmentOpinion('MNOGU SE POSKAPEA STANOVIVE'), true);
  assert.equal(detectInvestmentOpinion('mnogu se poskapea stanovive'), true);
  assert.equal(detectInvestmentOpinion('становите се поскапеа'), true);
  assert.equal(detectInvestmentOpinion('цените поскапеа'), true);
  assert.equal(detectInvestmentOpinion('поевтини се станите'), false); // price went DOWN — not the complaint family
  assert.equal(detectInvestmentOpinion('ubarav si'), false); // unrelated
});

test('09:41 e2e: verb complaint in closing → investment.opinion, NEVER the fee (LLM down)', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps([
    { eb: 82, id: 82, location: 'Центар', price: 143000, service: 'buy', size: '95 м²' } as Property,
  ]);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, props);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const mapPath = tmpMapDb();
  writeMap(mapPath, [], []);
  const offlineMap = new OfflineMapStore(mapPath);
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap }) });
  const chatId = 'invest-verb-test';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // Walk the funnel to closing (fee talk active), then drop the complaint
  await send('SAKAM STAN');
  await send('VO CENTAR');
  await send('DO 150000');
  const s1 = await send('MNOGU SE POSKAPEA STANOVIVE');

  const reply = sent[sent.length - 1];
  // The right bank: market-opinion empathy + owners-set-prices (or the
  // agency-as-mediator wording — "мост" — of some variants), steering back.
  assert.ok(/моменталните цени|сопствениц|посредниц|мост/i.test(reply), `must serve investment.opinion wording: ${reply}`);
  // NOT the fee pitch (the 0%/500 денари agreement question)
  assert.ok(!/ослободени од агенциска провизија/i.test(reply), `must NOT fee-ask: ${reply}`);
  assert.ok(!/Дали се согласувате со ова/i.test(reply), `must NOT ask fee agreement: ${reply}`);
  assert.ok((s1.slots.feeRejections ?? 0) === 0, 'no fee-agreement state churn');

  offlineMap.close();
});
