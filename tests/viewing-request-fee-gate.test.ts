// THE [10:00] CAPTURE — «ЌЕ МОЖЕ ДА ГО ВИДАМ ВО ЖИВО ?» IS THE VISIT, NOT A PLACE.
//
//   [10:00] НА КОЈА УЛИЦА Е ?
//   [10:00] ЛИНА: Тоа се наоѓа во близина на Економски институт - Скопје. …maps…
//   [10:00] ЌЕ МОЖЕ ДА ГО ВИДАМ ВО ЖИВО ?
//   [10:00] ЛИНА: Не, тоа е на 1,0 километри од Министерство за животна средина
//                  и просторно планирање, а недвижноста е во Кисела Вода.   ← the bug
//
// The client asked to SEE the flat. The message ends with «?», so the POI-confirm
// lane claimed it, extracted the candidate «ЖИВО», and the map's typo pass bound
// «животна средина» — a distance to a ministry nobody named, and the interest he
// showed never reached the visit protocol.
//
// The contract these tests pin:
//   • a viewing request is the VISIT lane: the fee is disclosed and its
//     agreement asked (the fee-before-contact order), never a landmark distance;
//   • the same for the bare «може ли да го видам» sibling;
//   • a real place confirm («да не е во Карпош?») keeps its answer.

import { test } from 'node:test';
import assert from 'node:assert/strict';
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
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';
import { isPoiConfirmQuestion } from '../src/llm/deterministic';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const ROWS: Property[] = [{
  eb: 38, id: 38, location: 'Кисела Вода', address: 'Рампа', price: 101750,
  bedrooms: 3, sqm: 57, size: '57 м²', service: 'buy',
  lat: 41.98865, lon: 21.43722, geo_source: 'stored', details: 'Кај Рампа, на први кат.',
} as Property];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id || r.eb === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler() {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const properties = new FakeProps(ROWS);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  const chatId = 'viewer';
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  const seed = () => {
    const s = freshSession('test', chatId);
    s.state = 'property_locate';
    s.slots.propertyId = 38;
    s.slots.interestedPropertyId = 38;
    s.slots.presentedIds = [38];
    s.slots.currentBatch = [38];
    s.slots.service = 'buy';
    sessions.set(s);
  };
  return { say, sessions, chatId, seed };
}

const FEE_COPY = /надомест|посетата е|500|10 евра/iu;
/** The capture's own failure shape: a distance to a place nobody named. */
const LANDMARK_DISTANCE = /километри од|метри од|во близина на/iu;

test('[10:00] the viewing request is never a POI confirm', () => {
  // The captured sentence must not be claimed by the place-confirm lane…
  assert.equal(isPoiConfirmQuestion('ЌЕ МОЖЕ ДА ГО ВИДАМ ВО ЖИВО ?'), false,
    '«во живо» is how a client asks for a viewing');
  assert.equal(isPoiConfirmQuestion('МОЖЕ ЛИ ДА ГО ВИДАМ ?'), false);
  // …while a real place confirm keeps its lane.
  assert.equal(isPoiConfirmQuestion('DA NE E VO KARPOS ?'), true);
  assert.equal(isPoiConfirmQuestion('ДА НЕ Е ВО ЦЕНТАР ?'), true);
});

test('[10:00] e2e: the fee is disclosed and its agreement asked', async () => {
  const { say, sessions, chatId, seed } = makeHandler();
  seed();
  const reply = await say('ЌЕ МОЖЕ ДА ГО ВИДАМ ВО ЖИВО ?');
  const s = sessions.get(chatId)!;
  assert.match(reply, FEE_COPY, `the visit fee must be disclosed: ${reply}`);
  assert.match(reply, /\?/u, `its agreement must be asked: ${reply}`);
  assert.doesNotMatch(reply, /животна средина/iu, `the ministry is not in this conversation: ${reply}`);
  assert.doesNotMatch(reply, LANDMARK_DISTANCE, `no landmark distance for a viewing request: ${reply}`);
  assert.ok(s.slots.feeDisclosed === true || (s.slots.feeRejections ?? 0) === 0,
    'the fee gate opened');
  assert.notEqual(s.state, 'property_locate', `the turn left the locate lane: ${s.state}`);
});

test('[10:00] e2e: the bare «може ли да го видам» sibling rides the same gate', async () => {
  const { say, sessions, chatId, seed } = makeHandler();
  seed();
  const reply = await say('МОЖЕ ЛИ ДА ГО ВИДАМ ?');
  assert.match(reply, FEE_COPY, `the same fee gate: ${reply}`);
  assert.doesNotMatch(reply, LANDMARK_DISTANCE, reply);
  assert.notEqual(sessions.get(chatId)!.state, 'property_locate');
});
