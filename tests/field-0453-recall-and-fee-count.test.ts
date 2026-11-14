// THE [04:51]–[05:13] FIELD CAPTURE — two defects in one chat window.
//
//   [04:51] client: «IMAVTE EDNA KUKJA VO SKOPJE SEVER , OKOLU 130000 EVRA BESE»
//   [04:52] client: «DALI USTE SE PRODAVA TOA ?»
//   [04:52] ЛИНА: «Во моментов немам куќа за продажба во близина на Скопје
//           Север околу 130.000 евра. Дали да погледнам во друг дел од градот…»
//   [04:52] client: «A 44 ?»
//   [04:52] ЛИНА: «Куќата под Евидентен број 44 е во Скопје Север…»
//
// (1) THE ROW WAS THERE and she read it out one turn later by its number. The
//     recall lane's area predicate read `p.location` ALONE, so a row whose
//     naselba column says one thing while its AD names the district never
//     matched — the search said «немам» about a flat that is in the feed. The
//     lane now uses the data layer's `inArea` (ad text, then naselba, then the
//     area derived from the row's own words).
//
//   [05:13] client: «KOLKU TREBA DA PLATAM ZA 3 KUKJI DA VIDAM ?»
//   [05:13] ЛИНА: «Моментално во системот нема куќи до 130.000 евра во Центар…»
//
// (2) THREE VISITS IS 3 × 500 = 1.500 денари. Neither the count detector nor
//     the per-property detector knew the house noun or the count-with-no-figure
//     shape, so a fee question was answered with a property search. Both are
//     fixed at the detector, and the serve is the existing multiplication
//     (`buildFeePerProperty`) — the total is stated, never guessed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InboundHandler } from '../src/handlers/inbound';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { SessionStore } from '../src/fsm/session';
import { PropertyService, Property, inArea, locMatches } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { LandmarkService } from '../src/geo/landmarks';
import { Db } from '../src/store/db';
import { EnrichmentStore } from '../src/store/enrichment';
import { loadConfig } from '../src/config';
import { detectFeePerPropertyAsk, feeArithmeticCount, detectSeenListingRecall } from '../src/llm/deterministic';
import { buildFeePerProperty } from '../src/llm/prompts';

class FailingLlm { async complete(): Promise<string> { throw new Error('429 quota exhausted'); } }

/** The feed row as the appliance has it: the naselba column files it under one
 *  place while the AD names the district — exactly the shape EB 44 had. */
// THE REAL FEED ROW (checked against the live feed): the naselba column says
// «Скопје Север» while the ADDRESS is «ВИЗБЕГОВО» — the micro-area lives in the
// address, not in the location column.
const HOUSE: Property = {
  eb: 44, id: 44, location: 'Скопје Север', price: 130000, service: 'buy',
  house: true, bedrooms: 3, size: '150 м²', address: 'ВИЗБЕГОВО',
  details: 'Се продава куќа во Визбегово, со површина од 150м2.',
};

/** A row the feed files under the MICRO-AREA, with the district only in its ad
 *  text — the second half of the same defect. */
const MICRO: Property = {
  eb: 45, id: 45, location: 'Визбегово', price: 130000, service: 'buy',
  house: true, bedrooms: 3, size: '150 м²', address: 'Визбегово',
  details: 'Куќа во Скопје Север, 150 м².',
};

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

function makeHandler(rows: Property[] = [HOUSE]): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(rows);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions,
    classifier: new Classifier(llm, cfg, properties), responder: new Responder(llm, cfg), properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels, enrichment: new EnrichmentStore(db),
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent };
}

// ── (1) THE RECALL SEES THE AD'S OWN WORDS ──────────────────────────────────

test('a house filed under a micro-area is found when the client names the district', () => {
  // The predicate the lane now uses: the ad text first, then the naselba column.
  assert.equal(inArea(HOUSE, 'Скопје Север'), true,
    'the ad says the district: the recall must see it');
  // …and it is still not a wildcard: another district does not match.
  assert.equal(inArea(HOUSE, 'Центар'), false);
});

// The lane-level serve needs the OFFLINE MAP (the recall resolves the place it
// names), which a bare harness does not carry — the field replay with the real
// map is what covers the words. What is pinned here is the exact predicate the
// lane was getting wrong, both sides of it:
test('the recall area test reads the ad, not only the naselba column', () => {
  // THE OLD PREDICATE — `locMatches(String(p.location), area)` — is the defect:
  // «Скопје Север» versus a row filed under «Визбегово» is a miss, so the
  // recall answered «немам» about a house that IS in the feed.
  assert.equal(locMatches('Скопје Север', String(MICRO.location)), false,
    'the naselba column alone cannot see the district — the bug');
  // THE PREDICATE THE LANE USES NOW — the ad's own words first.
  assert.equal(inArea(MICRO, 'Скопје Север'), true,
    'the ad says the district: the recall must see it');
  // …and it is still not a wildcard.
  assert.equal(inArea(MICRO, 'Центар'), false);
  assert.equal(inArea(HOUSE, 'Скопје Север'), true, 'the naselba column also counts');
});

test('the live two-line recall is answered with the house, not «немам»', async () => {
  // THE EXACT [06:19] TURN: the TUI delivered both lines as ONE message.
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'field-recall-0619';
  await handler.handle('test', chatId, 'ZDRAVO');
  const mark = sent.length;
  await handler.handle('test', chatId,
    'IMAVTE EDNA KUKJA VO SKOPJE SEVER ZA 130000\nDALI SE PRODAVA SEUSTE ?');
  const reply = sent.slice(mark).join('\n');
  assert.ok(reply, 'the turn must answer');
  assert.doesNotMatch(reply, /немам/iu,
    `a house whose naselba IS «Скопје Север» must not be denied: ${reply}`);
  assert.equal(sessions.get(chatId)!.slots.location, 'Скопје Север');
});

// ── (2) THREE VISITS: THE FEE ARITHMETIC OWNS THE TURN ──────────────────────

test('three houses to view is a fee question with a count', () => {
  const text = 'KOLKU TREBA DA PLATAM ZA 3 KUKJI DA VIDAM ?';
  assert.equal(feeArithmeticCount(text), 3, '3 куќи is the count the fee multiplies');
  assert.equal(detectFeePerPropertyAsk(text), true, 'pay verb + count + viewing anchor');
  // The serve states the total for the BUY fee (500 ден/visit): 3 × 500.
  const buy = buildFeePerProperty('buy', 3);
  assert.match(buy, /1\.500/, `the total is the product: ${buy}`);
  assert.match(buy, /3 недвижности/u, `the count is named: ${buy}`);
  // A priced search is NOT this lane.
  assert.equal(detectFeePerPropertyAsk('KOLKU E CENATA ZA 3 STANA ?'), false,
    'a price ask about three flats keeps its lane');
});

test('the fee question is answered with the money, never with a search', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'field-fee-0513';
  await handler.handle('test', chatId, 'ZDRAVO');
  const s = sessions.get(chatId)!;
  s.state = 'property_query';
  s.slots.service = 'buy';
  sessions.set(s);

  const mark = sent.length;
  await handler.handle('test', chatId, 'KOLKU TREBA DA PLATAM ZA 3 KUKJI DA VIDAM ?');
  const reply = sent.slice(mark).join('\n');
  assert.match(reply, /1\.500/, `3 × 500 must be computed: ${reply}`);
  assert.doesNotMatch(reply, /немам|нема\b|критериум/iu,
    `a fee question must never be answered with a stock line: ${reply}`);
  const after = sessions.get(chatId)!;
  assert.equal(after.slots.feeRejections, undefined, 'arithmetic is not resistance: no rung burns');
  assert.equal(after.slots.feeDisclosed, true, 'the fee has been told, so a «да» is consent');
});
