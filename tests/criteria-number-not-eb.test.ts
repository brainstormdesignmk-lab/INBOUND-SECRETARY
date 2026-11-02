/**
 * A CRITERION NUMBER IS NOT AN ЕВИДЕНТЕН БРОЈ (the [09:24] Дебар Маало capture).
 *
 *   ZDRAVO SAKAM DA KUPAM STANCE VO DEBAR MAALO . NAD 50 M2
 *   EDNA ILI DVE SPALNI MOZE . DO 120000 ZA DVOSOBEN , DO 150000 ZA TROSOBEN
 *
 * Two things went wrong on that flow, both ending in the same wrong turn: Lina
 * asked for the client's name and phone instead of searching.
 *
 *  1. «NAD 50 M2» — a SIZE floor — was collected as a mentioned EB (the feed
 *     happens to hold EB 50, a rental house across town). The mention bind
 *     stamped propertyId 50 in discovery, so the funnel believed a flat was on
 *     the table.
 *  2. The completed search found nothing in the area, and the answer carried
 *     «MOZE» — which the exhausted-options escape read as consent to register
 *     the criteria. Nothing had been shown yet, so there was nothing to escape
 *     from: the honest reply is the other-areas question.
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
import { EnrichmentStore } from '../src/store/enrichment';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { collectMentionedEbs } from '../src/llm/recommend';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// The area holds one flat, and it is nowhere near the stated caps — the search
// comes back empty on a FIRST turn, exactly like the real 09:26 capture.
const ROWS: Property[] = [
  { eb: 95, id: 95, location: 'Дебар Маало', price: 204000, bedrooms: 3, sqm: 74, size: '74 м²', service: 'buy', lat: 42.0006, lon: 21.4157 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string, rows: Property[]) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(rows)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(rows),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId: id };
}

test('a size or money number is never a mentioned EB; a bare one still is', () => {
  const valid = new Set([50, 55, 74]);
  assert.deepEqual(collectMentionedEbs(['NAD 50 M2'], valid), [],
    '«над 50 м²» is a size floor, not ЕВ 50');
  assert.deepEqual(collectMentionedEbs(['SAKAM STAN SO 70 M2 I DO 120000 EVRA'], valid), [],
    'a size or a budget cap never names a listing');
  assert.deepEqual(collectMentionedEbs(['KUKJATA 55 IMA DVORCE?'], valid), [55],
    'a bare number the client typed as a reference still binds');
});

test('an empty FIRST search asks about other parts, never for name and phone', async () => {
  const { say, sessions, chatId } = makeHandler('debar-first-empty', ROWS);
  await say('ZDRAVO SAKAM DA KUPAM STANCE VO DEBAR MAALO . NAD 50 M2');
  const reply = await say('EDNA ILI DVE SPALNI MOZE . DO 120000 ZA DVOSOBEN , DO 150000 ZA TROSOBEN');

  const s = sessions.get(chatId)!;
  assert.equal(s.slots.propertyId, undefined,
    'the size floor 50 must not bind ЕВ 50 as the property on the table');
  assert.notEqual(s.state, 'contact_collection',
    `«MOZE» on an empty first search is not exhausted-options consent: ${reply}`);
  // WHOLE WORDS: «прошириме» ends in «име» and is not a name ask.
  assert.doesNotMatch(reply, /(?<![\p{L}])(?:име(?:\s+и\s+презиме)?|телефон)(?![\p{L}])/iu,
    `no contact ask before anything was shown: ${reply}`);
  assert.match(reply, /Дебар Маало/);
  // The widen is a QUESTION about other areas — whichever bank variant answers.
  // «Дебар Маало» is also a MAP place, so the empty search is anchored on the
  // quarter and the anchored-empty copy says «некоја друга сооодветна
  // локација»; the area-locked copy says «друга локација», and its own pool
  // also carries «некоја друга населба» (singular) and «други делови од
  // градот». Same question, same promise (and the reply still names Дебар
  // Маало, asserted above) — the expectation is the contract, not one wording
  // of it. The singular «населба» arm was missing: the pool's fourth variant
  // answered correctly and the assertion alone called it a failure.
  assert.match(reply, /(друга\s+(?:соодветна\s+)?(?:локациј|населб)|други (?:населби|локации|делови)|друг дел од градот|блиски локации|пошироко)/iu,
    `the widen is a QUESTION about other areas: ${reply}`);
});
