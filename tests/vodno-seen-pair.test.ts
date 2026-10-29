/**
 * THE 02:17–02:20 CAPTURE — a Водно hunt that answered with a Центар flat, then
 * re-served the pair after the client picked one, then described BOTH when he
 * asked about one.
 *
 *   [02:17] SAKAM DA KUPAM STAN NA VODNO
 *   [02:17] VIE IMAVTE EDEN STAN TAMU , NE ZNAM KOJ BROJ BESE
 *   [02:18] OKOLU 100 000 ILJADI BESE , SO DVE SPALNI
 *   [02:18] ЛИНА: EB 51 (Водно, 71 м², 99.000) + EB 95 (Центар, 74 м², 204.000)
 *   [02:19] MISLAM DEKA BESE TOJ 71 KVADRATA STO E   ← the same two again
 *   [02:20] STO MOZES DA MI KAZES ZA 51 ?             ← details for BOTH
 *
 * The contract these pin:
 *   1. A seen-property pair is measured against the AREA he named — one Водно
 *      match is ONE card, never padded with another neighbourhood's flat.
 *   2. A client who points at one of the cards by its own fact («тој 71
 *      квадрата») has ANSWERED the "is this the one you saw?" question: she
 *      confirms which flat it is and moves on, she never re-lists the pair.
 *   3. A question about ONE number on the table is answered with ONE card.
 *   4. «100 000 илјади» is 100.000, not 100.000.000 — an inflated budget makes
 *      the price ranking prefer a flat costing twice what he said he paid.
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
import { detectBudget } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

/** The two flats of the capture, at their real coordinates. */
const ROWS: Property[] = [
  { eb: 51, id: 51, location: 'Водно', price: 99000, bedrooms: 3, sqm: 71, size: '71 м²', service: 'buy', lat: 41.9761, lon: 21.4003 },
  { eb: 95, id: 95, location: 'Центар', price: 204000, bedrooms: 3, sqm: 74, size: '74 м²', service: 'buy', lat: 42.0009, lon: 21.4310 },
];

/** Both in Водно — the which-one table (a pair must still be served there). */
const TWO_VODNO: Property[] = [
  ROWS[0],
  { eb: 61, id: 61, location: 'Водно', price: 118000, bedrooms: 3, sqm: 74, size: '74 м²', service: 'buy', lat: 41.9755, lon: 21.4012 },
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

test('«100 000 илјади» is 100.000 — the suffix is emphasis, not a second step', () => {
  assert.equal(detectBudget('OKOLU 100 000 ILJADI BESE , SO DVE SPALNI'), '100000');
  assert.equal(detectBudget('OKOLU 115 ILJADI EVRA'), '115000', 'a bare number still multiplies');
  assert.equal(detectBudget('do 120k'), '120000');
});

test('a Водно seen-property serve is ONE Водно card — no Центар padding', async () => {
  const { say, sessions, chatId } = makeHandler('vodno-one');
  await say('ZDRAVO');
  await say('SAKAM DA KUPAM STAN NA VODNO');
  await say('VIE IMAVTE EDEN STAN TAMU , NE ZNAM KOJ BROJ BESE');
  const reply = await say('OKOLU 100 000 ILJADI BESE , SO DVE SPALNI');

  assert.deepEqual(sessions.get(chatId)!.slots.currentBatch, [51],
    'one in-area match is one card, never a second card from Центар');
  assert.match(reply, /Евидентен број 51/);
  assert.doesNotMatch(reply, /Евидентен број 95/, 'the Центар flat is a different search');
  assert.doesNotMatch(reply, /Центар/);
  assert.match(reply, /Дали ова е станот што го видовте\?/,
    'a single card asks the singular question — never «првиот/вториот»');
});

test('the client picks by «71 квадрата»: she confirms WHICH flat, never re-lists', async () => {
  const { say, sessions, chatId } = makeHandler('vodno-pick');
  await say('ZDRAVO');
  await say('SAKAM DA KUPAM STAN NA VODNO');
  await say('VIE IMAVTE EDEN STAN TAMU , NE ZNAM KOJ BROJ BESE');
  await say('OKOLU 100 000 ILJADI BESE , SO DVE SPALNI');

  const reply = await say('MISLAM DEKA BESE TOJ 71 KVADRATA STO E');
  const s = sessions.get(chatId)!;
  assert.match(reply, /Да, точно\./, 'his identification is acknowledged');
  assert.match(reply, /Евидентен број 51 — трисобен стан, во Водно, 71 м², 99\.000 евра\./,
    'she says which flat he just pointed at, in its own numbers');
  assert.doesNotMatch(reply, /Дали ова е станот што го видовте\?/,
    'the question he just answered is not asked again');
  assert.match(reply, /посета/, 'and the hunt moves on');
  assert.equal(s.slots.interestedPropertyId, 51, 'the pick is armed on EB 51');
});

test('a pair inside the area still serves, and «71 квадрата» resolves one of them', async () => {
  const { say, sessions, chatId } = makeHandler('vodno-pair', TWO_VODNO);
  await say('ZDRAVO');
  await say('SAKAM DA KUPAM STAN NA VODNO');
  await say('VIE IMAVTE EDEN STAN TAMU , NE ZNAM KOJ BROJ BESE');
  const pair = await say('OKOLU 100 000 ILJADI BESE , SO DVE SPALNI');
  assert.deepEqual(sessions.get(chatId)!.slots.currentBatch, [51, 61],
    'two in-area matches are still the pair');
  assert.match(pair, /Евидентен број 51/);
  assert.match(pair, /Евидентен број 61/);

  const pick = await say('MISLAM DEKA BESE TOJ 71 KVADRATA STO E');
  assert.match(pick, /Да, точно\. Евидентен број 51/);
  assert.doesNotMatch(pick, /Евидентен број 61/, 'the other card is not repeated');
  assert.equal(sessions.get(chatId)!.slots.interestedPropertyId, 51);
});

test('two cards with the same 71 м²: she asks WHICH one, over those two only', async () => {
  const twins: Property[] = [
    ROWS[0],
    { eb: 63, id: 63, location: 'Водно', price: 105000, bedrooms: 3, sqm: 71, size: '71 м²', service: 'buy', lat: 41.9758, lon: 21.4009 },
  ];
  const { say, sessions, chatId } = makeHandler('vodno-twins', twins);
  await say('ZDRAVO');
  await say('SAKAM DA KUPAM STAN NA VODNO');
  await say('VIE IMAVTE EDEN STAN TAMU , NE ZNAM KOJ BROJ BESE');
  await say('OKOLU 100 000 ILJADI BESE , SO DVE SPALNI');

  const reply = await say('MISLAM DEKA BESE TOJ 71 KVADRATA STO E');
  const s = sessions.get(chatId)!;
  assert.doesNotMatch(reply, /Да, точно\./, 'two carriers are never guessed between');
  assert.match(reply, /Евидентен број 51/);
  assert.match(reply, /Евидентен број 63/);
  assert.match(reply, /првиот|вториот/u, 'and she asks which of the two');
  assert.equal(s.state, 'property_locate', 'the question is still open');
  assert.equal(s.slots.interestedPropertyId, undefined, 'no property is armed on a tie');
  assert.deepEqual(s.slots.currentBatch, [51, 63], 'the batch shrinks to the carriers');
});

test('«што можеш да ми кажеш за 51?» describes ONE flat, not the table', async () => {
  const { say, sessions, chatId } = makeHandler('vodno-describe', TWO_VODNO);
  await say('ZDRAVO');
  await say('SAKAM DA KUPAM STAN NA VODNO');
  await say('VIE IMAVTE EDEN STAN TAMU , NE ZNAM KOJ BROJ BESE');
  await say('OKOLU 100 000 ILJADI BESE , SO DVE SPALNI');

  const answer = await say('STO MOZES DA MI KAZES ZA 51 ?');
  assert.match(answer, /Еве ги деталите што ги имам за него:/, 'singular intro');
  assert.match(answer, /Евидентен број 51/);
  assert.doesNotMatch(answer, /Евидентен број 61/, 'the un-named card is not described');
  assert.equal(sessions.get(chatId)!.slots.propertyId, 51, 'the named number becomes the anchor');
});
