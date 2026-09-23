/**
 * 22:10 regression — the correction/reduction family fell into the FEE pitch.
 *
 * "DALI E VOZMOZNA KOREKCIJA NA CENATA ?" hit the price-freshness disclaimer
 * (its "korekcija na cenata" vocabulary), and "BI SAKAL DA SE NAMALI MALKU ."
 * missed every negotiate grammar (no amount offered) and dropped into the
 * closing fee disclosure. Both messages are price NEGOTIATION — the banked
 * fixed-prices policy answer (price.negotiate) is the only correct serve:
 * "Вредноста на недвижностите ја одредуваат сопствениците и цените се
 * генерално фиксни. Агенцијата е медијатор…"
 *
 * Pins three layers:
 *   1. the reduction/correction grammar (amount-optional) + its guards
 *   2. freshness keeps "is it still that price" — the negotiate veto only
 *      claims the correction/reduction class
 *   3. e2e: the 22:10 transcript serves price.negotiate, NEVER a fee ask
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
import { detectNegotiate, detectPriceFreshness } from '../src/llm/deterministic';
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
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'corr-')), 'map.db');
}

test('reduction/correction grammar: the 22:10 family fires negotiate (amount-optional)', () => {
  for (const t of ['BI SAKAL DA SE NAMALI MALKU .', 'bi sakal da se namali malku',
    'cenata da se namali', 'da se namali malku', 'da se spusti cenata',
    'DA SE SPLUSTI CENATA MALKU', 'spusti go cenata malku', 'namali ja cenata',
    'dali e vozmozna korekcija na cenata?', 'korekcija na cenata mozna?',
    'koregiraj go cenata', 'korigiraj ja cenata', 'moze li malku pomalu?',
    'dali ima popust?']) {
    assert.equal(detectNegotiate(t), true, `must negotiate: ${t}`);
  }
});

test('guards: room preferences, subjects, budget caps and small talk never negotiate', () => {
  for (const t of ['pomalku sobi imate?', 'pomalku spalni bi bilo dobro',
    'po malku kvadrati?', 'namali go volumenot', 'se namali brojot na klienti',
    'namalena potrosna na struja', 'kako si deneska?', 'dali ima parkinq?',
    'do 300 evra', 'baram do 150']) {
    assert.equal(detectNegotiate(t), false, `must NOT negotiate: ${t}`);
  }
});

test('freshness boundary: still-that-price stays freshness, correction class goes negotiate', () => {
  // Freshness fast-path keeps its class (the veto only claims corrections)
  assert.equal(detectPriceFreshness('dali mu e uste taa cena?'), true);
  assert.equal(detectPriceFreshness('cenata ista li e?'), true);
  // …but the correction/reduction family overrides freshness
  assert.equal(detectPriceFreshness('dali e vozmozna korekcija na cenata?'), true,
    'korekcija vocabulary is shared — the veto in the freshness gate handles it');
  assert.equal(detectNegotiate('dali e vozmozna korekcija na cenata?'), true);
});

test('bank: price.negotiate leads with the fixed-prices policy wording', () => {
  const first = RESPONSE_BANK['price.negotiate'][0];
  assert.ok(/фиксн|сопствениц|медијатор/iu.test(first),
    `policy wording must lead the pool: ${first}`);
});

test('22:10 e2e: korekcija + namali serve the fixed-prices policy, NEVER the fee pitch (LLM down)', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps([
    { eb: 71, id: 71, location: 'Центар', price: 130000, service: 'sale', size: '80 м²' } as Property,
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
  const chatId = 'correction-test';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // Transcript pre-state: price quoted (freshness line served), closing
  await send('ZA EB 71');
  await send('DALI E VOZMOZNA KOREKCIJA NA CENATA ?');
  const reply1 = sent[sent.length - 1];
  assert.ok(/сопственик|медијатор|фиксн/iu.test(reply1),
    `korekcija must serve the fixed-prices policy: ${reply1}`);
  assert.ok(!/симболичен надомест|разгледувањето имот е со/iu.test(reply1),
    `no fee pitch for a correction ask: ${reply1}`);

  const s = await send('BI SAKAL DA SE NAMALI MALKU .');
  const reply2 = sent[sent.length - 1];
  assert.ok(/сопственик|медијатор|фиксн/iu.test(reply2),
    `reduction ask must serve the fixed-prices policy: ${reply2}`);
  assert.ok(!/симболичен надомест|разгледувањето имот е со/iu.test(reply2),
    `fee pitch must never follow a reduction ask: ${reply2}`);
  assert.ok(['closing', 'property_query', 'presentation'].includes(s.state),
    `state stays commercial: ${s.state}`);
});
