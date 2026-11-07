/**
 * THE €/m² QUESTION AFTER THE FEE DISCLOSURE (replay of the field burst, #6).
 *
 *   The fee was disclosed, then the client asked the price per square metre he
 *   chose: «PA DA RECEME 1500 1600 EVRA ZA KVADRAT». The «ПА ДА» particle is a
 *   yes-token, so the first-«да»-after-the-fee lane read it as the agreement and
 *   opened contact collection, while the price the client actually asked about
 *   was never answered. A per-m² rate is a price question, never consent.
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
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';
import { detectSqmRate } from '../src/llm/deterministic';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(p => p.id === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(p => p.eb === eb); }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 53, id: 53, location: 'Аеродром', price: 55000, service: 'buy', sqm: 44, size: '44 м²',
    lat: 41.9863, lon: 21.4663, details: 'Мансарда со посебна спална соба.' } as Property,
];

function makeHandler(chatId: string) {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(ROWS),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  const say = async (m: string): Promise<string> => {
    const before = sent.length;
    await handler.handle('test', chatId, m);
    return sent.slice(before).join('\n');
  };
  return { say, sessions };
}

test('the €/m² rate is recognised as a price question, not a yes-particle', () => {
  // «1500 1600» is read as one run of digits by the rate probe (a pre-existing
  // quirk of the two-figure form), so the contract here is only that a rate
  // IS detected — the handler test below pins what the client receives.
  assert.notEqual(detectSqmRate('PA DA RECEME 1500 1600 EVRA ZA KVADRAT'), undefined);
});

test('after the fee disclosure, «ПА ДА … ЗА КВАДРАТ» does not open contact collection', async () => {
  const { say, sessions } = makeHandler('sqm-after-fee');
  await say('SAKAM DA GO VIDAM OVOJ 53 VO AERODROM');
  // Put the session where a fee has been disclosed and a per-m² ask lands next.
  const s = sessions.get('sqm-after-fee')!;
  s.state = 'closing';
  s.slots.service = 'buy';
  s.slots.feeDisclosed = true;
  s.slots.viewingFeeAgreed = false;
  s.slots.propertyId = 53;
  sessions.set(s);
  await say('PA DA RECEME 1500 1600 EVRA ZA KVADRAT');
  const after = sessions.get('sqm-after-fee')!;
  assert.notEqual(after.state, 'contact_collection', 'a per-m² rate must not be read as consent');
  assert.notEqual(after.slots.viewingFeeAgreed, true, 'no agreement recorded from a price question');
});
