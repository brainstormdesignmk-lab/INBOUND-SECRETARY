// THE [10:18] TRANSCRIPT — mid fee-persuasion the client disputed the fee:
// "10 EVRA NE E BAS SIMBOLICNA CENA . 1 EVRO E SIMBOLICNA CENA ?" — echoing
// Lina's own "симболична сума" wording. The trailing "cena ?" made
// detectPriceAsk claim it, the INFO block answered with the PROPERTY price
// ("Станот со Евидентен број 82 … чини 143.000 евра") and the fee
// conversation was abandoned mid-persuasion.
//
// Fix: FEE_AMOUNT_COUNTER_RE (fee object + dismissal of the symbolic
// framing, Lina's own vocabulary echoed back) OR-ed into
// detectFeeComplaint, and fee-complaint exclusions on every price-shaped
// swallowing path (price-freshness, fast price ask, INFO block). The
// complaint lands in the FSM fee-complaint branch → fee.why rationale +
// re-ask: the persuasion CONTINUES, no refusal rung burned, never a
// property-price quote.

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
import { detectBudget, detectFeeComplaint, detectPriceAsk } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429'); }
}

function tmpMapDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'feecounter-')), 'map.db');
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
}

test('detectFeeComplaint: the 10:18 counter-offer family, echoed fee vocabulary', () => {
  const line = '10 EVRA NE E BAS SIMBOLICNA CENA . 1 EVRO E SIMBOLICNA CENA ?';
  assert.equal(detectFeeComplaint(line), true);
  // The collision that caused the bug: the same line ALSO reads as a price ask
  assert.equal(detectPriceAsk(line), true);
  // Variations
  assert.equal(detectFeeComplaint('nadomestot ne e simbolichen'), true);
  assert.equal(detectFeeComplaint('posetata ne e bas simbolichna'), true);
  assert.equal(detectFeeComplaint('500 denari skapo e ?'), true);
  // A plain property-price ask is NOT a fee complaint
  assert.equal(detectFeeComplaint('kolku e cenata ?'), false);
});

test('CROSS pin: the 10:18 line co-fires detectBudget with a truthy amount — routing guard layer', () => {
  const line = '10 EVRA NE E BAS SIMBOLICNA CENA . 1 EVRO E SIMBOLICNA CENA ?';
  // detectBudget extracts the "10" as a (bogus) budget amount — truthy. This
  // co-fire is a FEATURE: the budget guard (!detectBudget) on the fast price
  // path keeps the line out of the budget path, while detectFeeComplaint
  // (checked FIRST in routing) keeps it out of the price paths entirely.
  const amt = detectBudget(line);
  assert.ok(amt, 'budget must co-fire truthy on the fee-amount fragment');
  assert.equal(detectFeeComplaint(line), true, 'fee complaint must still win the routing race');
});

test('10:18 e2e: fee counter-offer → fee.why persuasion continues, NEVER the property price (LLM down)', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps([
    { eb: 82, id: 82, location: 'Аеродром', price: 143000, service: 'buy', size: '95 м²' } as Property,
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
  const chatId = 'fee-counter-test';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // Card → interest → да → fee disclosed
  await send('ZA EB 82');
  await send('mi se svigja 82');
  await send('da');
  const fee = sent[sent.length - 1];
  assert.ok(/надомест|500 денари/i.test(fee), `fee must be disclosed first: ${fee}`);

  const rejectsBefore = sessions.get(chatId)!.slots.feeRejections ?? 0;
  // The exact 10:18 line
  const s = await send('10 EVRA NE E BAS SIMBOLICNA CENA . 1 EVRO E SIMBOLICNA CENA ?');
  const reply = sent[sent.length - 1];

  // The fee conversation CONTINUES — rationale + re-ask, not the property price
  assert.ok(!/143\.000/.test(reply), `must NOT quote the property price: ${reply}`);
  assert.ok(!/Евидентен број 82 чини/i.test(reply), `must NOT be the flat price quote: ${reply}`);
  assert.ok(/(?:надомест|симболичн|посета|фи)/iu.test(reply), `must stay on the fee protocol: ${reply}`);
  assert.ok(/\?/.test(reply), `must re-ask so the funnel keeps moving: ${reply}`);
  // No refusal rung burned — the complaint is answered, not counted
  assert.equal(s.slots.feeRejections ?? 0, rejectsBefore, 'complaint must not burn a refusal rung');
  assert.equal(s.state, 'closing', 'funnel stays in the fee talk');

  offlineMap.close();
});
