import { test } from 'node:test';
import assert from 'node:assert';
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
import {
  lastReplyWasNearby,
  detectWhyFollowUp,
  mentionsMore,
  hasProximityAnchor,
} from '../src/llm/deterministic';
import { FeedLandmark } from '../src/data/properties';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// ── THE DUAL-PAIR SERVE REPLAY (apartment-typed funnel, LLM down) ───────────
// «baram stan vo centar» + «za kirija do 1000 evra» + «za kupuvanje do
// 2000000» arms dualService. The live replay showed BOTH bugs:
//   1. TYPING LEAK — the pair's RENT card was a деловен простор (EB 42,
//      126 м², «Се изнајмува деловен простор») under a «Станот под Евидентен
//      број» rubric: type-less candidates() keeps business rows, and the
//      house=false filter only drops houses.
//   2. NEARBY SWALLOW — the card serve embeds «во близина на …» (the feed
//      landmark line), so «nesum zadovolen , daj gi drugite» and «ushte drugi
//      opcii molam» both landed in the NEARBY_THREAD rotation and the
//      presentation ladder NEVER advanced (presentedIds frozen at the first
//      pair, landmarkIndex climbing on every ask).
// The synthetic ledger reproduces the shape: apartment-typed central rows,
// a per-service budget pair, and feed landmarks on the cards.
const LM_101 = 'Училиште Гоце Делчев';
const LM_201 = 'Трговски центар Капиштец';
const ROWS: Property[] = [
  // RENT leg (≤ 1000): closest-to-budget leads (900 first, then 500).
  { eb: 101, id: 101, location: 'Центар', price: 900, service: 'rent', bedrooms: 2, size: '50 м²',
    landmarks: [{ landmark: LM_101, distance_m: 120, type: 'school' } as FeedLandmark] },
  { eb: 102, id: 102, location: 'Центар', price: 500, service: 'rent', bedrooms: 2, size: '46 м²' },
  // THE TRAP — a business row riding an apartment-typed funnel (the EB 42
  // leak from the replay): it is rent ≤ 1000, so it LEGALLY fits the rent
  // leg's own money filter — only a TYPE filter can keep it from presenting.
  { eb: 42, id: 42, location: 'Центар', price: 999, service: 'rent', size: '126 м²', business: true },
  // BUY leg (≤ 2 000 000): cheapest-in-contract first two fit rows.
  { eb: 201, id: 201, location: 'Центар', price: 190000, service: 'buy', bedrooms: 2, size: '72 м²',
    landmarks: [{ landmark: LM_201, distance_m: 150, type: 'mall' } as FeedLandmark] },
  { eb: 202, id: 202, location: 'Центар', price: 204000, service: 'buy', bedrooms: 2, size: '74 м²' },
];

function makeHandler(): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new (class extends PropertyService {
    constructor() { super('http://fake-feed'); }
    async getAll(): Promise<Property[]> { return ROWS; }
    get healthy(): boolean { return true; }
  })();
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent };
}

const ebsIn = (text: string): number[] =>
  [...text.matchAll(/Евидентен број\s+(\d+)/g)].map(m => parseInt(m[1], 10));

test('[dual pair] apartment-typed funnel serves RENT+BUY apartment pairs; the business row never presents', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chat = 'dual-pair-typed';
  for (const m of ['baram stan vo centar', 'za kirija do 1000 evra',
    'za kupuvanje do 2000000', 'nebitni se spalnite']) {
    await handler.handle('test', chat, m);
  }
  const s = sessions.get(chat)!;
  assert.equal(s.state, 'presentation');
  assert.equal(s.slots.dualService, true);
  assert.equal(s.slots.house, false, 'the funnel is APARTMENT-typed (explicit стан)');
  const serve = sent[3];
  // THE PAIR CONTRACT: one RENT card + one BUY card, rent first — and each
  // leg leads with the row PRICE-CLOSEST to its own budget cap (rent: 900
  // before 500; buy: 204.000 before 190.000) like the [12:33] replay showed.
  assert.deepEqual(ebsIn(serve), [101, 202], `first batch must be the rent+buy apartment pair: ${serve}`);
  // THE TYPING GUARD: the trap row (EB 42) must not present in ANY batch.
  assert.ok(!serve.includes('126'), `no business card on an apartment funnel: ${serve}`);
  // The card does embed the «во близина на …» landmark line — this is the
  // swallow shape (assert the shape here, the advance in the next test).
  assert.ok(serve.includes(`во близина на ${LM_101}`), `pair serve must name the feed landmark: ${serve}`);
  // NEARBY GATE: a card serve is never a nearby-thread anchor.
  assert.equal(lastReplyWasNearby(serve), false, `card serve must not anchor the nearby thread: ${serve}`);
  assert.deepEqual(s.slots.presentedIds, [101, 202]);
});

test('[dual pair] the ladder ADVANCES after a card serve: «ushte drugi opcii molam» serves batch 2, never the nearby rotation', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chat = 'dual-pair-advance';
  for (const m of ['baram stan vo centar', 'za kirija do 1000 evra',
    'za kupuvanje do 2000000', 'nebitni se spalnite']) {
    await handler.handle('test', chat, m);
  }
  // THE SWALLOW REPLAY: a bare follow-up after the pair serve must walk the
  // OPTIONS ladder. Pre-fix it routed NEARBY_THREAD («Тоа се наоѓа во близина
  // на …») and presentedIds froze at [101, 201] — the client saw nothing new.
  await handler.handle('test', chat, 'ushte drugi opcii molam');
  const serve2 = sent[4];
  assert.ok(!/Тоа се наоѓа во близина/i.test(serve2),
    `a follow-up after a card serve must never land in the nearby rotation: ${serve2}`);
  assert.deepEqual(ebsIn(serve2), [102, 201], `batch 2 must be the NEXT rent+buy pair: ${serve2}`);
  const s = sessions.get(chat)!;
  assert.deepEqual(s.slots.presentedIds, [101, 202, 102, 201], 'the options ladder must advance');
  // No nearby rotation side effects on the thread state.
  assert.equal(s.slots.landmarkIndex, undefined, 'the nearby rotation must not advance on an options ask');
  // No criteria re-ask after the size waiver.
  assert.ok(!serve2.includes('Колку спални'), serve2);
});

test('[nearby gate] detector pins: card serves (both rubric families) never anchor; landmark/protocol/shutdown replies still do', () => {
  // The two card rubrics the serves use (probe-exact):
  const batchCard =
    'Се согласувам, големината не Ве врзува.\n\n'
    + 'Станот под Евидентен број 42 е трисобен стан во Центар. Се наоѓа во близина на Студентски дом Кузман Јосифовски - Питу.'
    + ' Има 126 м² станбена површина. Цената е 1.000 евра месечно.';
  const businessCard =
    'Деловниот простор под Евидентен број 57 е во Центар. Се наоѓа во близина на Министерство за правда.'
    + ' Цената е 1.000 евра месечно.';
  assert.equal(lastReplyWasNearby(batchCard), false, batchCard);
  assert.equal(lastReplyWasNearby(businessCard), false, businessCard);
  // The nearby lanes stay anchored (regression of the 20:56/21:00 family):
  const landmark =
    'Тоа се наоѓа во близина на Shopping Center Capitol Mall.\n'
    + 'https://maps.google.com/?cid=6060322835712121595';
  const protocol =
    'Точните податоци за локацијата ќе Ви ги доставам непосредно пред посетата, бидејќи тоа е официјално правило на Агенцијата.';
  const shutdown =
    'Мислам дека Ви е јасен реонот во кој се наоѓа недвижнината. Точната адреса ќе ја дознаете на ден на посетата.';
  assert.equal(lastReplyWasNearby(landmark), true);
  assert.equal(lastReplyWasNearby(protocol), true);
  assert.equal(lastReplyWasNearby(shutdown), true);
  // The visit-location message stays excluded (21:00 family).
  assert.equal(lastReplyWasNearby('ЛОКАЦИЈА ЗА ЕВИДЕНТЕН БРОЈ 76; 08.09.2026; 15:00'), false);
  // The POI-confirmation lane keeps its «со Евидентен број» form anchored —
  // the card marker ("под") is the discriminator, NOT the EB mention.
  const poiConfirm = 'Точно, станот со Евидентен број 89 се наоѓа во близина на МВР.';
  assert.equal(lastReplyWasNearby(poiConfirm), true, poiConfirm);
  // The bare more-ask qualifies for the nearby thread against a LANDMARK
  // reply and for the OPTIONS thread against a card serve (the same ask).
  const moreAsk = 'ushte drugi opcii molam';
  assert.equal(mentionsMore(moreAsk), true);
  assert.equal(hasProximityAnchor(moreAsk), false);
});

test('[nearby gate] the address.why lane does not fire after a card serve (bare ZOSTO keeps its own lanes)', () => {
  const cardServe =
    'Станот под Евидентен број 101 е двособен стан во Центар. Се наоѓа во близина на Училиште Гоце Делчев.'
    + ' Цената е 900 евра месечно.';
  // The gate in the handler is: detectWhyFollowUp(text)
  // && lastReplyWasNearby(last assistant text) — the card serve fails the
  // second arm, so «ZOSTO?» after a pair serve goes to the classifier's own
  // lanes, never the agency-rules reply.
  assert.equal(detectWhyFollowUp('ZOSTO?'), true);
  assert.equal(detectWhyFollowUp('ZOSTO?') && lastReplyWasNearby(cardServe), false, cardServe);
});
