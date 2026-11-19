/**
 * THE «ДА» THAT ANSWERS OUR OWN OFFER — the [05:58] V16K11 capture.
 *
 *   [05:58] ЛИНА: … Евидентен број 54 чини 69.500 евра, односно 1.986 евра за м²
 *                 (35 м²). Дали сакате да го споредам со останатите понуди во
 *                 истата населба?
 *   [05:59] DA MOZE
 *   [05:59] ЛИНА: Одлично. Ве молам споделете ги Вашето име и презиме и
 *                 телефонскиот број…
 *
 * The client accepted a COMPARISON and was handed to contact collection — no
 * comparison, no fee ever mentioned. Two defects meet here, and both are pinned:
 *
 *   1. The offer had no owner. Nothing in the pipeline could serve «спореди го
 *      со останатите понуди во истата населба», so the promise was decoration.
 *   2. The bare «да» was read by the DRAINED-POOL escape (every card presented →
 *      any agreement = "hand him to the owner"), which is why the answer came
 *      with «Одлично.» and a name/phone request on a chat where the visit fee had
 *      never been told.
 *
 * The contract: an offer is a promise recorded on the session (`pendingOffer`),
 * it lives for exactly ONE reply, and the yes it was waiting for serves the thing
 * it offered. Every figure in the comparison is the feed's own (price ÷ м²).
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

// The capture's own subject (54: 35 м², 69.500 €, 1.986 €/м²) plus the same
// category's other rows in Центар. Their rates are chosen so the subject is the
// DEAREST — the verdict sentence has a fact to state, not an assumption.
const ROW = (eb: number, sqm: number, price: number, location = 'Центар'): Property => ({
  eb, id: eb, location, price, bedrooms: 2, sqm, size: `${sqm} м²`, service: 'buy',
  lat: 41.9985, lon: 21.4318,
});
const ROWS: Property[] = [
  ROW(54, 35, 69500),
  ROW(61, 40, 62000),
  ROW(62, 44, 78000),
  ROW(64, 38, 71000),
  // Another area's flat at the cheapest rate of all — it must never appear in a
  // «во истата населба» comparison.
  ROW(71, 60, 60000, 'Карпош'),
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string, rows: Property[] = ROWS) {
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
  const chatId = id;
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId };
}

/** Drive to the capture's exact turn: 54 described with its rate, then the offer. */
async function reachRateOffer(say: (m: string) => Promise<string>): Promise<string> {
  await say('SAKAM DA KUPAM DVOSOBEN STAN DO 80000 EVRA');
  await say('CENTAR');
  await say('DA'); // the second pair of the batch (61 + 54)
  return say('KOLKU BI MU DOSLA CENATA PO KVADRAT?');
}

test('[05:58] the rate answer OFFERS the comparison and the offer is recorded', async () => {
  const { say, sessions, chatId } = makeHandler('rate-offer');
  const reply = await reachRateOffer(say);
  assert.match(reply, /Евидентен број 54/u, `the flat on the table is the subject: ${reply}`);
  assert.match(reply, /евра за м²/u, `the rate is served: ${reply}`);
  assert.match(reply, /споредам/u, `the offer closes the turn: ${reply}`);
  assert.deepEqual(sessions.get(chatId)!.slots.pendingOffer, { kind: 'compare', eb: 54 },
    'the promise is on the session, so the next turn can keep it');
});

test('[05:59] «DA MOZE» serves the COMPARISON, never the contact ask', async () => {
  const { say, sessions, chatId } = makeHandler('rate-compare');
  await reachRateOffer(say);
  const reply = await say('DA MOZE');

  // The comparison itself: the subject's rate beside the same category's other
  // rows in the SAME area, each with the feed's own price and м².
  assert.match(reply, /Споредба/u, `the promised comparison is served: ${reply}`);
  assert.match(reply, /Евидентен број 54[^\n]*1\.986 евра за м²/u,
    `the subject keeps its own rate: ${reply}`);
  assert.match(reply, /Евидентен број 61[^\n]*1\.550 евра за м²/u,
    `a peer from the same area is compared on its own figures: ${reply}`);
  assert.doesNotMatch(reply, /Евидентен број 71/u,
    `another area never enters a «во истата населба» comparison: ${reply}`);

  // The defect: the contact ask answered a comparison request.
  assert.doesNotMatch(reply, /телефонск|име и презиме/iu,
    `a comparison is not a name-and-phone request: ${reply}`);
  const slots = sessions.get(chatId)!.slots;
  assert.equal(slots.viewingFeeAgreed, undefined,
    'no fee was ever disclosed, so nothing could have been agreed');
  assert.equal(slots.pendingOffer, undefined, 'the promise is spent by the reply that kept it');
  assert.notEqual(sessions.get(chatId)!.state, 'contact_collection',
    'contact collection is the fee funnel\'s step, not a comparison\'s');
});

test('the promise lives ONE reply: an unrelated turn expires it', async () => {
  const { say, sessions, chatId } = makeHandler('rate-expire');
  await reachRateOffer(say);
  await say('KAKO E VREMETO VO SKOPJE DENESKA'); // not an agreement — the offer lapses
  assert.equal(sessions.get(chatId)!.slots.pendingOffer, undefined,
    'an offer must not wait in the session for a «да» two turns later');
});

test('with nothing to compare against, the answer says so instead of inventing a market', async () => {
  // The subject alone in its area: the honest line, and still no contact ask.
  const { say } = makeHandler('rate-empty', [ROW(54, 35, 69500), ROW(71, 60, 60000, 'Карпош')]);
  await say('SAKAM DA KUPAM DVOSOBEN STAN DO 80000 EVRA');
  await say('CENTAR');
  await say('DA');
  const offered = await say('KOLKU BI MU DOSLA CENATA PO KVADRAT?');
  assert.match(offered, /споредам/u, `the offer is still made: ${offered}`);
  const reply = await say('DA MOZE');
  assert.match(reply, /немам други понуди/u, `the absence is named, not filled: ${reply}`);
  assert.doesNotMatch(reply, /телефонск|име и презиме/iu, `never the contact ask: ${reply}`);
  assert.match(reply, /\?/u, `the turn still asks ONE way forward: ${reply}`);
});
