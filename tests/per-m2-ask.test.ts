/**
 * THE RATE IS ARITHMETIC (the [10:00] Кисела Вода capture).
 *
 *   … две понуди: ЕВ 94 (92.000 €, 56 м²) и ЕВ 37 (117.500 €, 90 м²)
 *   PRVIOT MI ODGOVARA POVEKJE , POBLISKU MI E . KOLKU DOAGJA KVADRAT
 *
 * Two misses on one turn:
 *   1. «KOLKU DOAGJA KVADRAT» names no «цена» and no preposition, so the
 *      per-м² facet never fired and the LLM answered «цена по квадрат немам
 *      забележано» — about a flat whose price and м² are both in the feed.
 *      The rate is price ÷ м²: 92.000 / 56 = 1.643 €/м².
 *   2. «PRVIOT» was not read as a pick, so the legacy chain would have
 *      answered for the LAST card shown (ЕВ 37, 1.306 €/м²) — the wrong flat.
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
import { detectInfoFacets } from '../src/llm/infoAnswer';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const ROWS: Property[] = [
  { eb: 94, id: 94, location: 'Кисела Вода', price: 92000, bedrooms: 2, sqm: 56, size: '56 м²', service: 'buy', lat: 41.9985, lon: 21.4415 },
  { eb: 37, id: 37, location: 'Кисела Вода', price: 117500, bedrooms: 3, sqm: 90, size: '90 м²', service: 'buy', lat: 41.9971, lon: 21.4432 },
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

test('«kolku doagja kvadrat» asks the RATE; a verbless «kolku kvadrati» asks the SIZE', () => {
  assert.equal(detectInfoFacets('KOLKU DOAGJA KVADRAT')?.pricePerSqm, true);
  assert.equal(detectInfoFacets('KOLKU DOAGJA KVADRATOT?')?.pricePerSqm, true);
  assert.equal(detectInfoFacets('KOLKU E CENA PO M2 ZA 37')?.pricePerSqm, true);
  assert.equal(detectInfoFacets('KOLKU KVADRATI IMA STANOT 94')?.sqm, true,
    'a size question is never a rate');
  assert.equal(detectInfoFacets('KOLKU KVADRATI IMA STANOT 94')?.pricePerSqm, undefined);
});

test('the rate is computed for the card the client picked — «PRVIOT» is the first one', async () => {
  const { say, sessions, chatId } = makeHandler('per-m2-first-pick', ROWS);
  await say('ZDRAVO SAKAM DA KUPAM STAN VO KISELA VODA');
  await say('SPALNI BILO KOLKU , BUDJETOT MI E 180000');
  const batch = sessions.get(chatId)!.slots.currentBatch ?? [];
  assert.deepEqual(batch, [94, 37], 'both cards are on the table, 94 first');

  const reply = await say('PRVIOT MI ODGOVARA POVEKJE , POBLISKU MI E . KOLKU DOAGJA KVADRAT');

  assert.match(reply, /94/, `the FIRST card is the one being priced: ${reply}`);
  assert.match(reply, /1\.643/, `92.000 / 56 = 1.643 €/м²: ${reply}`);
  assert.match(reply, /56 м²/, `the arithmetic stays checkable: ${reply}`);
  assert.doesNotMatch(reply, /немам податок|ќе го прашам сопственикот/i,
    `price and м² are in the feed — nothing to relay: ${reply}`);
  assert.doesNotMatch(reply, /1\.306/, `that is ЕВ 37's rate, not the picked flat's: ${reply}`);
  assert.equal(sessions.get(chatId)!.slots.interestedPropertyId, 94,
    'the pick is remembered on the flat he named');
});
