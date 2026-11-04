/**
 * THE [10:16] CAPTURE — the qualifier can sit BEFORE the have-verb, and the
 * answer to the market question is never interest in the card on the table.
 *
 * The transcript:
 *
 *   [10:16] ZDRAVO , STO INTERESNO IMATE OKOLU BEVERLI HILS ?
 *   [10:16] ЛИНА [dynamic]: Здраво! Имаме одлични опции во регионот околу
 *           Беверли Хилс. За да можам да ви издвојам соодветни понуди, дали Ве
 *           интересира купување или изнајмување на недвижност?
 *   [10:17] ZA KUPUVANJE SUM ZAINTERESIRAN
 *   [10:17] ЛИНА: 1. Колкав број на спални соби барате во Вашиот нов стан?
 *                 2. Која е максималната цена…?
 *
 * Two defects, both in the same conversation:
 *
 *   1. THE ASK WAS NOT AN INVENTORY ASK. Every arm of the have-ask family
 *      demands the verb IMMEDIATELY after «што», so «што ИНТЕРЕСНО имате» bound
 *      the place (the nearby lane) but not the ask: `inventoryPending` stayed
 *      empty and the place template was never derived from the answer.
 *   2. THE FUNNEL ASSUMED A FLAT. With no type and no market on file it asked
 *      for bedrooms and a price «во Вашиот нов стан» — a category the client
 *      never named. The market question was owed first, then the TYPE
 *      (стан / куќа / деловен простор / плац), and only then that category's
 *      own criteria.
 *
 * Plus the sibling the fix exposes: once the browse has served a card, the
 * market answer («ZA KUPUVANJE SUM ZAINTERESIRAN» — «заинтересиран» IS in the
 * interest vocabulary) must not be read as property.liked on that card.
 */
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
import { EnrichmentStore } from '../src/store/enrichment';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { detectInventoryAsk, extractInventoryPlace } from '../src/llm/deterministic';
import { generateDynamic } from '../src/llm/dynamicFallback';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

/** The one row near the map's Беверли Хилс pin (30 m), for the serve case. */
const NEAR_ROW: Property = {
  eb: 931, id: 931, location: 'Центар', address: 'Ул. Беверли Хилс 3', price: 120000,
  service: 'buy', bedrooms: 2, sqm: 65, size: '65 м²', lat: 41.9938, lon: 21.4166,
};

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

const ASK = 'ZDRAVO , STO INTERESNO IMATE OKOLU BEVERLI HILS ?';
const MARKET_ANSWER = 'ZA KUPUVANJE SUM ZAINTERESIRAN';

function makeHandler(id: string, rows: Property[]) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const props = new FakeProps(rows);
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
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId: id };
}

// Copy assertions are CONTRACT-level: the market question names the two
// markets, the type question names the categories, the criteria question asks
// for a size and a price. Bank variants rotate, so no single wording is pinned.
const MARKET_ASK = /(?:купув|изнајм|закуп|кириј)/iu;
const TYPE_ASK = /(?:стан|куќа|деловен простор|плац)/iu;
const SIZE_ASK = /спални/iu;
const DRAINED = /исцрпивме|ги погледнавме сите|веќе ги погледнавме/iu;

test('the qualifier before the verb is the same have-ask family', () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return; // no live map on this machine — offlineMap.test.ts pins the DB

  for (const msg of [
    ASK,
    'STO INTERESNO IMTE KAJ BEVERLI HILS ?',
    'STO INTERESNO IMATE VO BEVERLI HILS ?',
    'DALI IMATE NESTO INTERESNO OKOLU BEVERLI HILS ?',
    'ИМАТЕ ЛИ НЕШТО ИНТЕРЕСНО КАЈ БЕВЕРЛИ ХИЛС ?',
  ]) {
    assert.equal(detectInventoryAsk(msg), true, `the ask must be an inventory ask: ${msg}`);
    assert.ok(extractInventoryPlace(msg), `the place it names must be read: ${msg}`);
  }
  // The neutral ask keeps its own reading — the qualifier is what makes the
  // difference, not the preposition.
  assert.equal(detectInventoryAsk('STO IMATE VO BUNJAKOVEC ?'), true);
});

test('a stock-at-a-place ask owes the market, then the TYPE, then that type\'s criteria', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return;
  const { say, sessions, chatId } = makeHandler('q-ask', []);

  const first = await say(ASK);
  assert.match(first, MARKET_ASK, `the market question is the first answer: ${first}`);
  assert.doesNotMatch(first, DRAINED, `nothing was shown — no search is exhausted: ${first}`);
  assert.doesNotMatch(first, SIZE_ASK, `no flat was asked for, so no bedrooms question: ${first}`);
  let s = sessions.get(chatId)!;
  assert.equal(s.slots.inventoryPending, true, 'the place ask stays owed after the market answer');
  assert.match(s.slots.poiAnchor ?? '', /беверли/iu, `the place is on file: ${s.slots.poiAnchor}`);

  const second = await say(MARKET_ANSWER);
  assert.match(second, TYPE_ASK, `the TYPE is asked, never assumed: ${second}`);
  // CONTRACT: the type question either says «тип» or enumerates the categories
  // («барате стан, куќа, деловен простор или плац?») — pinning the noun «тип»
  // failed on a rotation of the bank wording.
  assert.ok(/тип/iu.test(second) || TYPE_ASK.test(second),
    `the type question names the categories: ${second}`);
  assert.ok(second.trimEnd().endsWith('?'), `and it is a question: ${second}`);
  assert.doesNotMatch(second, SIZE_ASK, `«колку спални» for a flat nobody named: ${second}`);
  s = sessions.get(chatId)!;
  assert.equal(s.slots.service, 'buy', 'the market the client declared is on file');

  const third = await say('STAN MI TREBA');
  assert.match(third, SIZE_ASK, `the flat's own criteria follow: ${third}`);
  assert.match(third, /цена|буџет|износ/iu, `the flat's price question follows: ${third}`);
});

test('a stock ask draws no card, so the market answer can never read as «this flat»', async () => {
  // The [17:30] owner rule supersedes the card serve this test was written
  // against: a place + «што имате» is a funnel step, so no row is on the table
  // when the client answers the market. That removes the old failure mode at
  // the root — there is no card to misread as «this flat».
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return;
  const { say, sessions, chatId } = makeHandler('q-card', [NEAR_ROW]);

  const first = await say(ASK);
  assert.doesNotMatch(first, /Евидентен број/u, `no card on the stock ask: ${first}`);
  assert.match(first, MARKET_ASK, `the market question is the answer: ${first}`);
  let s = sessions.get(chatId)!;
  // No batch was served, so no service is pinned from one — the market on file
  // (if any) is never the feed's word wearing the client's.
  assert.notEqual(s.slots.serviceInferred, true, 'no inferred market from a card');

  const second = await say(MARKET_ANSWER);
  assert.doesNotMatch(second, /се допадна|се допаѓа|избор|посета/iu,
    `a market answer is not interest in a card: ${second}`);
  assert.match(second, TYPE_ASK, `the funnel asks the TYPE instead: ${second}`);
  s = sessions.get(chatId)!;
  assert.notEqual(s.state, 'closing', 'no visit protocol was opened on an unclaimed card');
  assert.equal(s.slots.interestedPropertyId, undefined, 'no property was claimed');
});

test('the answer to that ask is stored as a {place} template, not only verbatim', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return;
  const ANSWER =
    'Здраво! Имаме одлични опции во регионот околу Беверли Хилс. За да можам да ви издвојам соодветни понуди, дали Ве интересира купување или изнајмување на недвижност?';
  const session = freshSession('test', 'q-template');
  session.slots.poiAnchor = 'Беверли Хилс';

  const stored: Array<{ key: string; msg: string; answer: string; meta?: { template?: string; place?: string } }> = [];
  const llm: LlmClient = { async complete() { return ANSWER; } };
  const result = await generateDynamic(llm, session, ASK, {
    addDynamic: (key, _state, msg, answer, meta) => { stored.push({ key, msg, answer, meta }); return true; },
  });

  assert.ok(result, 'the generated answer is served');
  assert.equal(stored.length, 1, 'the row is stored');
  assert.ok(stored[0]!.meta?.template, 'a place template is derived with the row');
  assert.match(stored[0]!.meta!.template!, /\{place\}/u, 'the template carries the place slot');
  assert.doesNotMatch(stored[0]!.meta!.template!, /беверли|beverli/iu, 'no word of the old place survives');
  assert.match(stored[0]!.meta!.place ?? '', /беверли/iu, 'the anchor it was written for is recorded');
});
