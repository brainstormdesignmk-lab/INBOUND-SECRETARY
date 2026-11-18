/**
 * THE LIVE RENTAL OPENING — «ZDRAVO, BARAM STAN POD KIRIJA DO 250 EVRA VO
 * AERODROM» carries the deal (rent), the ceiling (250 €) and the area
 * (Аеродром) in one sentence, and the only criterion it does NOT carry is the
 * room count.
 *
 * The funnel contract, pinned here through the real handler:
 *   • all three criteria land in the slots on that one turn;
 *   • the single question is the room count — never the budget or the area the
 *     client just gave, and never the buy/rent choice;
 *   • once the rooms arrive the serve is a RENT row from Аеродром under the
 *     ceiling, and no purchase row is ever mixed into it.
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

const ROWS: Property[] = [
  // The answer: rent, Аеродром, 240 €, two rooms.
  { eb: 701, id: 701, location: 'Аеродром', address: 'Ул. Јане Сандански 4', price: 240,
    bedrooms: 2, sqm: 62, size: '62 м²', service: 'rent' },
  { eb: 702, id: 702, location: 'Аеродром', address: 'Ул. Ново Лисиче 12', price: 230,
    bedrooms: 1, sqm: 45, size: '45 м²', service: 'rent' },
  // Over the ceiling, same area: never served.
  { eb: 704, id: 704, location: 'Аеродром', address: 'Ул. Скупи 33', price: 400,
    bedrooms: 2, sqm: 70, size: '70 м²', service: 'rent' },
  // In budget, wrong area and a PURCHASE row: never served.
  { eb: 705, id: 705, location: 'Карпош', address: 'Ул. Партизански 90', price: 250,
    bedrooms: 2, sqm: 60, size: '60 м²', service: 'rent' },
  { eb: 706, id: 706, location: 'Аеродром', address: 'Ул. Јане Сандански 8', price: 95000,
    bedrooms: 2, sqm: 58, size: '58 м²', service: 'buy' },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

function makeHandler() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const props = new FakeProps(ROWS);
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
  return { handler, sessions, sent, chat: 'live-rent-open' };
}

test('the deal, the ceiling and the area land in one turn', async () => {
  const { handler, sessions, sent, chat } = makeHandler();
  await handler.handle('test', chat, 'ZDRAVO, BARAM STAN POD KIRIJA DO 250 EVRA VO AERODROM');
  const s = sessions.get(chat)!;
  assert.equal(s.slots.service, 'rent', '«pod kirija» is the rent service');
  assert.equal(s.slots.budget, '250', '«do 250 evra» is the ceiling');
  assert.equal(s.slots.location, 'Аеродром', 'the area named in the sentence is the location');

  const asked = sent.at(-1)!;
  assert.match(asked, /спалн|sobi|соби/iu, `the missing criterion is the room count: ${asked}`);
  assert.doesNotMatch(asked, /куп|kup|iznajm|изнајм/iu,
    `the deal is already stated — never ask again: ${asked}`);
  assert.doesNotMatch(asked, /колку (?:е )?(?:цена|пари)|ценовен|budget/iu,
    `the ceiling is already stated — never ask again: ${asked}`);
});

test('the serve stays in rent, in the area, under the ceiling', async () => {
  const { handler, sessions, sent, chat } = makeHandler();
  await handler.handle('test', chat, 'ZDRAVO, BARAM STAN POD KIRIJA DO 250 EVRA VO AERODROM');
  await handler.handle('test', chat, 'dvosoben');
  const s = sessions.get(chat)!;
  assert.equal(s.state, 'presentation');
  const ids = s.slots.presentedIds ?? [];
  assert.ok(ids.includes(701), `the rent flat in Аеродром under the ceiling is served: ${ids}`);
  assert.ok(!ids.includes(704), 'a rent row over the ceiling is never served');
  assert.ok(!ids.includes(705), 'a rent row outside the area is never served');
  assert.ok(!ids.includes(706), 'a PURCHASE row never appears in a rent batch');
  assert.match(sent.at(-1)!, /240 евра|240 evra/iu, `the rent figure is stated: ${sent.at(-1)}`);
});
