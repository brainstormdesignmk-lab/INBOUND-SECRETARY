/**
 * THE [09:48] V16K11 COMPOSITE ASK — price per м² AND distance, in one turn.
 *
 *   [09:48] «kolku doagjaat po kvadrat stanovive i na kolkavo rastojanie se od
 *            beverli?»
 *   [09:49] ЛИНА: Растојанието до Беверли Хилс: • 78 — на 80 метри • 84 — на
 *            180 метри  … and nothing about the rate. The client had to ask
 *            «kolku bi mu dosla cenata po m2 na 84?» FOUR MINUTES LATER to get
 *            the one number he asked for first.
 *
 * The distance lane owns the turn (the place is named), so the rate half has to
 * be served BY IT — the info/price lane never gets a turn to answer.
 *
 * Contract: when the burst asks the €/м², every flat the distance answer names
 * also carries its own price ÷ м² — computed from the row's own price and area,
 * never estimated, and skipped when a row has no usable м².
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

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

/** The two live flats, with the pins that make the distance measurable:
 *  EB 84 (117.000 €, 48 м² → 2.438 €/м²) and EB 78 (185.000 €, 82 м² →
 *  2.256 €/м²), both in Центар, ~450 m from Беверли Хилс in the shipped map. */
const EB84: Property = {
  eb: 84, id: 84, uuid: 'eb84-rate', address: 'РОЗА ЛУКСЕМБУРГ', location: 'Центар',
  lat: 41.9951, lon: 21.4180, geo_source: 'google_cached',
  service: 'buy', price: 117000, bedrooms: 3, sqm: 48, size: '48 м²',
} as Property;
const EB78: Property = {
  eb: 78, id: 78, uuid: 'eb78-rate', address: 'НИКОЛА КАРЕВ 8', location: 'Центар',
  lat: 41.9931, lon: 21.4157, geo_source: 'google_cached',
  service: 'buy', price: 185000, bedrooms: 3, sqm: 82, size: '82 м²',
} as Property;

class Props extends PropertyService {
  constructor(private rows: Property[]) { super('http://feed-not-used'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(p => p.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const sent: string[] = [];
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const props = new Props([EB84, EB78]);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  return { handler, sent, chat: 'rate-and-distance' };
}

async function reachTwoCards(handler: InboundHandler, chat: string): Promise<void> {
  await handler.handle('test', chat, 'zdravo');
  await handler.handle('test', chat, 'sakam da kupam trosoben stan do 300000 vo centar');
}

test('rate + distance in one ask answers BOTH, for every flat named', async () => {
  const { handler, sent, chat } = makeHandler();
  await reachTwoCards(handler, chat);

  await handler.handle('test', chat,
    'kolku doagjaat po kvadrat stanovive i na kolkavo rastojanie se od beverli hils?');
  const answer = sent.at(-1)!;

  // THE DISTANCE HALF — one measured line per flat (metres OR kilometres,
  // whichever the measured number honestly reads as).
  const distances = answer.match(/• Евидентен број \d+ — на /gu) ?? [];
  assert.ok(distances.length >= 2,
    `every flat on the table gets its own distance: ${answer}`);

  // THE RATE HALF — computed from each row's own price ÷ м².
  assert.match(answer, /евра за м²/iu, `the rate is stated: ${answer}`);
  assert.match(answer, /2\.438/u,
    `EB 84: 117.000 ÷ 48 м² = 2.438 €/м²: ${answer}`);
  assert.match(answer, /2\.256/u,
    `EB 78: 185.000 ÷ 82 м² = 2.256 €/м²: ${answer}`);
});

test('a distance ask with no rate word stays a pure distance answer', async () => {
  const { handler, sent, chat } = makeHandler();
  await reachTwoCards(handler, chat);
  await handler.handle('test', chat, 'na kolkavo rastojanie se od beverli hils?');
  const answer = sent.at(-1)!;
  assert.match(answer, /на \d+ метри/u, `the distance is still answered: ${answer}`);
  assert.doesNotMatch(answer, /евра за м²/iu,
    `no unasked rate appears: ${answer}`);
});
