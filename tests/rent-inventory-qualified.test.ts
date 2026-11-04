/**
 * THE [01:36] CAPTURE — the RENT sibling of [01:48].
 *
 *   [01:36] ZDRAVO . MI TREBA STANCE POD KIRIJA OKOU BUNJAKOVEC
 *   [01:36] STO IMATE POVOLNO VO TOJ REON ?
 *   [01:36] ЛИНА: Секоја населба си ги има своите специфични придобивки. За да
 *           Ви помогнам… што Ви е поважно: блиску до центарот, тивка
 *           атмосфера или пристапна цена?
 *
 * The sale case ([01:48]) was fixed by `detectInventoryAsk`; this shape slipped
 * through it because the client put a QUALIFIER («POVOLNO») between the
 * have-verb and the place — «STO IMATE во тој реон» matched, «STO IMATE
 * POVOLNO во тој реон» did not. The area-advice lane then owned the turn on the
 * word «реон» and answered a RENT search with a philosophy paragraph.
 *
 * The contract: the inventory ask is inventory in any wording (qualifier or
 * not), the area-advice paragraph never answers it, and the funnel's own
 * questions — спални and the MONTHLY rent — are what the client hears.
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
import { dispatchSimple } from '../src/handlers/router';
import { detectNeighborhoodAsk, detectSeeOffers, detectInventoryAsk } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// The live map's Bunjakovec area (Центар). Rows are RENT — the capture's market.
const ROWS: Property[] = [
  { eb: 911, id: 911, location: 'Центар', address: 'Ул. Никола Вапцаров 8', price: 450, service: 'rent', bedrooms: 2, sqm: 62, size: '62 м²', lat: 41.9963, lon: 21.4377 },
  { eb: 912, id: 912, location: 'Центар', address: 'Ул. Никола Вапцаров 21', price: 380, service: 'rent', bedrooms: 1, sqm: 40, size: '40 м²', lat: 41.9969, lon: 21.4381 },
  // A BUY row: it must never appear in a rent answer.
  { eb: 913, id: 913, location: 'Центар', address: 'Ул. Буњаковец 4', price: 95000, service: 'buy', bedrooms: 2, sqm: 58, size: '58 м²', lat: 41.9962, lon: 21.4375 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(ROWS),
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

const AREA_ADVICE = /Различни населби|Сите локации имаат сопствени|Секој дел од градот|што Ви е поважно|тивка атмосфера|специфични придобивки|посебен шарм/iu;

test('[01:36] the inventory ask carries a QUALIFIER — and is never area advice', () => {
  const asks = [
    'STO IMATE POVOLNO VO TOJ REON ?',
    'што имате поволно во тој реон?',
    'STO IMATE EVTINO VO TOJ REON ?',
    'STO IMATE DOSTAPNO VO TOJ DEL NA GRADOT ?',
    'STO IMATE POVOLNO VO CENTAR ?',
    'STO IMATE POVOLNO ?',
    // the qualifier-free family from [01:48] stays green
    'STO IMATE VO TOJ REON ?',
  ];
  for (const t of asks) {
    assert.equal(detectInventoryAsk(t), true, `inventory ask not recognised: ${t}`);
    assert.equal(detectSeeOffers(t), true, `the show-me lane must own it: ${t}`);
    assert.equal(detectNeighborhoodAsk(t), false, `area advice claimed an inventory ask: ${t}`);
    for (const st of ['idle', 'intent', 'discovery']) {
      assert.equal(dispatchSimple(t, st), undefined, `an advice lane answered it in ${st}: ${t}`);
    }
  }
  // Genuine area advice keeps its lane.
  assert.equal(detectNeighborhoodAsk('DALI E DOBRA NASELBATA AERODROM ZA ZIVEEЊE ?'), true);
  assert.equal(detectInventoryAsk('DALI E DOBRA NASELBATA AERODROM ZA ZIVEEЊE ?'), false);
});

test('e2e [01:36]: a RENT search near a place asks its own questions — never the neighbourhood essay', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return; // no live map on this machine — offlineMap.test.ts pins the DB
  const { say, sessions, chatId } = makeHandler('capture-0136');

  // TURN 1 — rent + a named place, no specs.
  const ask = await say('ZDRAVO . MI TREBA STANCE POD KIRIJA OKOU BUNJAKOVEC');
  const s1 = sessions.get(chatId)!;
  assert.equal(s1.slots.service, 'rent', `the market is rent: ${ask}`);
  assert.ok(s1.slots.poiAnchor, `the place the client named was dropped: ${ask}`);
  assert.match(s1.slots.poiAnchor!, /буњак/iu, `wrong anchor: ${s1.slots.poiAnchor}`);
  assert.doesNotMatch(ask, AREA_ADVICE, `a rent search is never area advice: ${ask}`);
  assert.match(ask, /спалн/iu, `the funnel asks the rooms: ${ask}`);
  assert.match(ask, /кирија|износ|цена/iu, `and the MONTHLY rent: ${ask}`);

  // TURN 2 — the qualified inventory ask. The MARKET is on file and the TYPE is
  // not, so the order the owner fixed ([17:43]: market → type → criteria → the
  // pair) owes the TYPE — never a pair that presumes a flat.
  const reply = await say('STO IMATE POVOLNO VO TOJ REON ?');
  const s2 = sessions.get(chatId)!;
  assert.doesNotMatch(reply, AREA_ADVICE, `the area paragraph answered an inventory ask: ${reply}`);
  assert.equal(s2.slots.service, 'rent', 'the market survives the inventory turn');
  assert.ok(s2.slots.poiAnchor, 'the anchor survives the inventory turn');
  assert.doesNotMatch(reply, /Евидентен број/u,
    `no card is served before the criteria are known: ${reply}`);
  // The category is ALREADY on file — turn 1 said «STANCE» (a plural the flat
  // detector did not know, so the slot stayed empty and this turn asked the TYPE
  // again, per «the type is still owed»). With the plural recognised, the one
  // question owed is the flat's own criteria — asked, not a pair served.
  assert.match(reply, /спалн/iu, `the flat's rooms question: ${reply}`);
  assert.match(reply, /кирија|износ|цена/iu, `and the MONTHLY rent: ${reply}`);

  // TURN 3 — the category, then ITS OWN criteria (спални + месечна кирија).
  const typeAsk = await say('STAN MI TREBA');
  assert.match(typeAsk, /спалн/iu, `the flat's rooms question: ${typeAsk}`);
  assert.match(typeAsk, /кирија|износ|цена/iu, `and the MONTHLY rent: ${typeAsk}`);

  // TURN 4 — with the criteria on file the rent rows near the place serve.
  const served = await say('DVOSOBEN DO 500');
  const s4 = sessions.get(chatId)!;
  assert.equal(s4.state, 'presentation', `the criteria present the pair: ${served}`);
  assert.match(served, /Евидентен број 91[12]/u, `a rent row must serve: ${served}`);
  assert.ok(!/Евидентен број 913/u.test(served), `a BUY row in a rent answer: ${served}`);
  assert.match(served, /(?:м|метри|km) од/iu, `the distance to the named place is stated: ${served}`);
});
