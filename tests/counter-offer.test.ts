/**
 * 08:20 regression — "dali moze za 150 e" (price counter-offer) fell through
 * every detector into the closing fee disclosure. The client was pushing back
 * on the PROPERTY price and got the viewing-fee protocol instead.
 *
 * Pins three layers:
 *   1. detectNegotiate counter-offer grammar (+ its guards: fee-sized consent,
 *      freshness, budget/criteria never negotiate)
 *   2. the symmetric guard — a property-sized offer never reads as consent
 *   3. e2e: the reply is the owner-fixes-price / agency-mediates answer
 *      (price.negotiate), NEVER fee.ask.rent
 */
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
import { detectNegotiate, detectAgreement } from '../src/llm/deterministic';
import { RESPONSE_BANK } from '../src/data/responses';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
}

function tmpMapDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ctr-')), 'map.db');
}

test('counter-offer grammar: 08:20 headline + idiom variants fire negotiate', () => {
  for (const t of ['dali moze za 150 e', 'moze za 150?', 'moze li na 150 evra', 'dali moze na 130000',
    'ke platam 140000', 'bi platil 25000 denari', 'Дадам 450 евра и да завршиме работа',
    '350 евра можам да дадам', '110000 moze?', 'nudam 120000 evra']) {
    assert.equal(detectNegotiate(t), true, `must negotiate: ${t}`);
  }
});

test('10:54 regression: infinitive bridge + all-I-have idiom fire negotiate, never consent', () => {
  for (const t of ['DALI KE MOZE DA GO KUPAM ZA 150000', 'ke moze da go kupam za 150000',
    'dali ke moze za 150000', 'TOLKU IMAM', 'tolku ke dadam', 'poveke nemam']) {
    assert.equal(detectNegotiate(t), true, `must negotiate: ${t}`);
  }
  // The poison that sent 10:54 into the fee flow: the да-chain must not read
  // as consent while the client is making an offer.
  assert.equal(detectAgreement('DALI KE MOZE DA GO KUPAM ZA 150000'), false,
    'a counter-offer must never be agreement');
});

test('counter-offer guards: consent/freshness/budget/criteria never negotiate', () => {
  for (const t of ['ok ke platam 500 denari', 'vo red, ke platam',      // fee consent
    'dali mu e uste taa cena?',                                          // freshness fast-path
    'baram do 150 evra', 'stan do 150 e',                                // budget search
    'moze za 2 spalni?', 'dali ima edna spalna']) {                      // criteria
    assert.equal(detectNegotiate(t), false, `must NOT negotiate: ${t}`);
  }
  // consent keeps working (the symmetric guard only mutes property-sized offers)
  assert.equal(detectAgreement('da'), true);
  assert.equal(detectAgreement('ok ke platam 500 denari'), true);
  assert.equal(detectAgreement('se slozuvam'), true, '"se slozuvam" is bare agreement');
});

test('bank: price.negotiate carries the owner-fixes-price policy line', () => {
  const first = RESPONSE_BANK['price.negotiate'][0];
  assert.ok(/сопствениц|медијатор/.test(first), `policy wording must lead the pool: ${first}`);
});

test('08:20 e2e: counter-offer after fee disclosure → owner-fixes-price answer, NEVER fee.ask.rent (LLM down)', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps([
    { eb: 76, id: 76, location: 'Центар', price: 200, service: 'rent', size: '74 м²' } as Property,
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
  const chatId = 'counter-offer-test';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // Card → interest → да → fee disclosed (same pre-state as the transcript flow)
  await send('ZA EB 76');
  await send('mi se svigja 76');
  await send('da');
  const fee = sent[sent.length - 1];
  assert.ok(/надомест|денари/i.test(fee), `fee must be disclosed first: ${fee}`);

  // The exact 08:20 line
  const s = await send('dali moze za 150 e');
  const reply = sent[sent.length - 1];

  // Owner-fixes-price / agency-mediates — NEVER another fee ask, NEVER silence
  assert.ok(/сопственик|медијатор|цена/i.test(reply), `negotiate answer required: ${reply}`);
  assert.ok(!/симболичен надомест|разгледувањето имот е со/i.test(reply), `fee disclosure must not repeat: ${reply}`);
  assert.ok(s.state === 'closing' || s.state === 'property_query' || s.state === 'presentation', `state stays commercial: ${s.state}`);
});
