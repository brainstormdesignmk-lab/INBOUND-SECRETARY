/**
 * THE [09:10]–[09:16] VISIT ATTEMPTS — V16K11, the client asked THREE TIMES.
 *
 *   [09:10] AJDE DOGOVORI MI ZA 66 I ZA 91   → «Сè што имавме околу Градежен
 *                                              Факултет … е веќе прикажано»
 *   [09:12] SAKAM DA GI POSETAM 66 I ZA 91   → a fee rung (correct — he had
 *                                              resisted the fee a turn earlier)
 *   [09:16] MOZE — SAKAM POSETA ZA 66 I ZA 91 → «Вредноста на недвижностите
 *                                              ја одредуваат сопствениците…»
 *
 * Three separate faults, one family — a visit request must never be answered
 * with (a) the stock-exhausted line, (b) a single flat when he named two, or
 * (c) a price-negotiation lecture once the fee is agreed and the contact ask is
 * what the funnel owes.
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
import { detectNegotiate } from '../src/llm/deterministic';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// The live search: one landmark, two room categories with a cap each, exactly
// three flats — every one of them served before the client tried to book.
const FACULTY = { lat: 41.9955, lon: 21.4179 };
const ROWS: Property[] = [
  { eb: 66, id: 66, location: 'Центар', price: 137000, bedrooms: 3, sqm: 79, size: '79 м²', service: 'buy', lat: FACULTY.lat + 0.0033, lon: FACULTY.lon + 0.0001 } as Property,
  { eb: 84, id: 84, location: 'Центар', price: 117000, bedrooms: 3, sqm: 48, size: '48 м²', service: 'buy', lat: FACULTY.lat + 0.0050, lon: FACULTY.lon + 0.0002 } as Property,
  { eb: 91, id: 91, location: 'Центар', price: 178000, bedrooms: 3, sqm: 71, size: '71 м²', service: 'buy', lat: FACULTY.lat - 0.0020, lon: FACULTY.lon + 0.0015 } as Property,
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id); }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string) {
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
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent.at(-1) ?? '';
  };
  return { say, sent, sessions, chatId: id };
}

/** The live funnel up to the point where every card has been served: the
 *  landmark pins the search, the two criteria narrow it, then «што уште имате»
 *  walks the ladder until the pool is honestly empty (the live chat's shape). */
async function drainedSearch(id: string) {
  const h = makeHandler(id);
  await h.say('DA KUPAM SAKAM');
  await h.say('STAN KAJ GRADEZEN FAKULTET');
  await h.say('DO 180.000 EVRA');
  await h.say('TRISOBNI');
  for (let i = 0; i < 4; i++) {
    const reply = await h.say('POKAZI MI STO USTE IMATE');
    if (/немаме друга опција|веќе прикажано|ги исцрпивме|исцрпени/iu.test(reply)) break;
  }
  return h;
}

// ── (a) THE VISIT COMMAND IS NOT A STOCK ASK ────────────────────────────────

test('[09:10] a visit command after a drained search opens the fee protocol — never «сè е веќе прикажано»', async () => {
  const { say, sessions, chatId } = await drainedSearch('visit-after-drain');
  const s0 = sessions.get(chatId)!;
  assert.deepEqual([...(s0.slots.presentedIds ?? [])].sort(), [66, 84, 91],
    `every flat was shown before the visit ask: ${JSON.stringify(s0.slots.presentedIds)}`);

  const reply = await say('AJDE DOGOVORI MI ZA 66 I ZA 91');
  const s = sessions.get(chatId)!;
  // A DRAINED POOL IS NOT AN ANSWER TO «DOGOVORI MI»: the client asked for a
  // VIEWING of two flats he had already seen, and the turn told him there was
  // nothing more in the system.
  assert.doesNotMatch(reply, /веќе прикажано|ги исцрпивме|исцрпени/iu,
    `never the exhausted line for a visit request: ${reply}`);
  assert.match(reply, /500 денари|10 евра/u,
    `the viewing fee is disclosed: ${reply}`);
  assert.ok(reply.trim().endsWith('?'), `and it asks for the agreement: ${reply}`);
  assert.equal(s.state, 'closing', `the fee protocol owns the turn: ${s.state}`);
  assert.ok((s.slots.propertyId ?? s.slots.interestedPropertyId) !== undefined,
    'the flat he named is the subject of the visit');
});

test('[09:10] both flats he named ride the visit — never silently one of them', async () => {
  const { say } = await drainedSearch('visit-two-ebs');
  const reply = await say('AJDE DOGOVORI MI ZA 66 I ZA 91');
  assert.match(reply, /66/u, `the first flat is named: ${reply}`);
  assert.match(reply, /91/u, `and the second one too: ${reply}`);
});

// ── (c) THE AGREED FEE OWES THE CONTACT ASK ─────────────────────────────────

test('[09:16] «MOZE» over an agreed fee gets the contact ask — not a price lecture', async () => {
  const { say, sessions, chatId } = await drainedSearch('visit-agreed');
  await say('ZEMATE PARI ZA POSETI ?');              // the nag (rung 1)
  // THE LADDER OWNS THE MONEY TRAFFIC UNTIL IT FINISHES (§2): the visit order
  // while the client is still resisting climbs a rung — it is not consent — and
  // the rung states the fee again. (This is what the live box did: the second
  // attempt got `fee.rule.hold`, and only the third — «MOZE» — closed.)
  const rung = await say('SAKAM DA GI POSETAM 66 I ZA 91');
  assert.match(rung, /500 денари|10 евра/u, `the rung still states the money: ${rung}`);
  // The disclosure turn CLEARS the flag ("the disclosure turn is never
  // consent", §2) — so the absence is `undefined`, not `false`.
  assert.ok(!sessions.get(chatId)!.slots.viewingFeeAgreed,
    `a visit order under resistance does not jump the ladder: ${rung}`);

  const reply = await say('MOZE — SAKAM POSETA ZA 66 I ZA 91');
  assert.doesNotMatch(reply, /сопственикот.*цена|цената.*сопственикот|Вредноста на недвижностите/iu,
    `no price-negotiation answer to a visit consent: ${reply}`);
  assert.match(reply, /име|телефон/u, `the contact ask is what the funnel owes: ${reply}`);
  assert.equal(sessions.get(chatId)!.state, 'contact_collection');
  assert.equal(sessions.get(chatId)!.slots.viewingFeeAgreed, true,
    'and the consent is recorded once');
});

test('the detector: a visit wish is not a negotiation, money still is', () => {
  // The live string — modal «MOZE» plus «ZA 66» hit the bare-amount arm.
  assert.equal(detectNegotiate('MOZE SAKAM POSETA ZA 66 I ZA 91'), false);
  assert.equal(detectNegotiate('MOZE\nSAKAM POSETA ZA 66 I ZA 91'), false);
  // A visit wish WITH money on it is still a counter-offer.
  assert.equal(detectNegotiate('SAKAM DA GO VIDAM, MOZE POPUST?'), true);
  assert.equal(detectNegotiate('DAJ MI GO ZA 120000'), true);
  // Plain negotiation shapes are untouched.
  assert.equal(detectNegotiate('MOZE ZA 150 EVRA?'), true);
});
