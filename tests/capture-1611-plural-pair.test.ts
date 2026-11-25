// THE [16:11] CAPTURE — A PAIR NAMED INSIDE THE AVAILABILITY ASK, ANSWERED
// AND ARRANGED IN THE SINGULAR:
//
//   [16:11] САКАМ ДА КУПАМ ТРОСОБЕН СТАН. ДАЛИ 84 И 82 СЕ УШТЕ НА ПРОДАЖБА ?
//   [16:11] ЛИНА: Според податокот од агенцијата, СТАНОТ е достапен веднаш.
//                 Дали да го контактирам СОПСТВЕНИКОТ …
//   [16:12] КОГА БИ МОЖЕЛО ДА СЕ ПОГЛЕДНАТ ?
//   [16:13] ЛИНА: Посетата е за СТАНОТ со Евидентен број 84 (Центар).
//                 … 500 денари … Дали се согласувате?
//
// Both flats were named in one sentence; flat 82 was never answered, and the
// arrangement that followed was booked for 84 alone — one owner, one visit,
// one fee. The contracts pinned here:
//
//   1. an availability ask that NAMES several flats answers EVERY one of them,
//      from its own column, with the per-property arithmetic — never one ack
//      and never an absence claim;
//   2. the pair is then ON THE TABLE (the follow-ups refer to it in the plural);
//   3. «кога би можело да се погледнат?» — a REFLEXIVE plural viewing wish with
//      no «ги» clitic — names BOTH flats and BOTH owners;
//   4. the agreement and the contact turn stay plural, and the term ask asks
//      for a term that fits several owners.
//
// Sibling shapes (the same family, different wording) are pinned beside the
// capture so a future edit cannot fix one spelling only; the singular forms are
// pinned too, because over-pluralising a one-flat visit is the mirror defect.

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
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { detectAvailabilityPlural, detectPluralViewingWish } from '../src/llm/deterministic';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('probe: LLM disabled'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id || r.eb === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

// The capture's two трисобен flats, both buy, both „Веднаш“, both Центар.
const EB84: Property = {
  eb: 84, id: 84, location: 'Центар', address: 'Центар 4', price: 95000,
  bedrooms: 3, sqm: 74, size: '74 м²', service: 'buy', dostapnoOd: 'Веднаш',
  lat: 41.9950, lon: 21.4310, geo_source: 'google_cached', details: '',
} as Property;
const EB82: Property = {
  eb: 82, id: 82, location: 'Центар', address: 'Центар 2', price: 90000,
  bedrooms: 3, sqm: 70, size: '70 м²', service: 'buy', dostapnoOd: 'Веднаш',
  lat: 41.9948, lon: 21.4305, geo_source: 'google_cached', details: '',
} as Property;

function makeHandler(rows: Property[] = [EB84, EB82]) {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const properties = new FakeProps(rows);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  const chatId = 'client-1611';
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  const seed = () => {
    const s = freshSession('test', chatId);
    s.state = 'idle';
    sessions.set(s);
    return s;
  };
  return { handler, sessions, sent, chatId, say, seed };
}

const NAMED_PAIR = 'САКАМ ДА КУПАМ ТРОСОБЕН СТАН. ДАЛИ 84 И 82 СЕ УШТЕ НА ПРОДАЖБА ?';

test('[16:11] an availability ask that names two flats answers BOTH, per property', async () => {
  const h = makeHandler();
  h.seed();
  const answer = await h.say(NAMED_PAIR);
  assert.doesNotMatch(answer, /нема станови|нема недвижности/iu, answer);
  assert.match(answer, /84/u, `the first named flat is answered: ${answer}`);
  assert.match(answer, /82/u, `the second named flat is answered: ${answer}`);
  // The two flats get their OWN identity lines (one per property, not one ack).
  assert.equal((answer.match(/Евидентен број/gu) ?? []).length >= 2, true,
    `each flat answers from its own column: ${answer}`);
  // The money is PER PROPERTY — the contract is the arithmetic (2 × 500), not a wording.
  assert.match(answer, /1\.000|1000/u, `the per-property fee is stated: ${answer}`);
  const s = h.sessions.get(h.chatId)!;
  const table = [...(s.slots.presentedIds ?? []), ...(s.slots.currentBatch ?? [])];
  assert.ok(table.includes(84) && table.includes(82),
    `both named flats are on the table afterwards: ${JSON.stringify(s.slots)}`);
  assert.equal(s.slots.service, 'buy', 'the named rows supply the market');
});

test('[16:12] the reflexive plural wish names BOTH flats and BOTH owners', async () => {
  const h = makeHandler();
  h.seed();
  await h.say(NAMED_PAIR);
  const answer = await h.say('КОГА БИ МОЖЕЛО ДА СЕ ПОГЛЕДНАТ ?');
  assert.match(answer, /становите/u, `the visit is for the flats (plural): ${answer}`);
  assert.doesNotMatch(answer, /за станот со/iu, `never a one-flat subject: ${answer}`);
  assert.match(answer, /84/u, `the first flat is named: ${answer}`);
  assert.match(answer, /82/u, `the second flat is named: ${answer}`);
  assert.match(answer, /сопствениц(?:ите|и)/iu, `one owner per flat — plural: ${answer}`);
  assert.doesNotMatch(answer, /сопственикот/iu, `never one owner for two visits: ${answer}`);
});

test('[16:13] the agreement and the contact turn stay plural', async () => {
  const h = makeHandler();
  h.seed();
  await h.say(NAMED_PAIR);
  await h.say('КОГА БИ МОЖЕЛО ДА СЕ ПОГЛЕДНАТ ?');
  const answer = await h.say('ДА, ВО РЕД Е.');
  assert.equal(h.sessions.get(h.chatId)!.state, 'contact_collection');
  assert.match(answer, /становите со Евидентни броеви 84 и 82/u,
    `the pair is the subject of the booking: ${answer}`);
  assert.match(answer, /сопствениц(?:ите|и)/iu, `one owner per flat: ${answer}`);
  assert.doesNotMatch(answer, /сопственикот|му се јавам/iu,
    `never one owner (and never the dative «му») for two visits: ${answer}`);
});

test('[16:13] the term ask asks for a term that fits several owners', async () => {
  const h = makeHandler();
  h.seed();
  await h.say(NAMED_PAIR);
  await h.say('КОГА БИ МОЖЕЛО ДА СЕ ПОГЛЕДНАТ ?');
  await h.say('ДА, ВО РЕД Е.');
  const answer = await h.say('Марко Марковски, 070123456');
  assert.equal(h.sessions.get(h.chatId)!.state, 'visit_scheduling');
  // EXPECTATION UPDATED (the owner's 2026-11-24 brief): several flats are a
  // ROUTE of one-hour visits, so the client is first asked whether they all
  // happen on one day or on different days — he must know the shape of the day
  // before he can name a term that fits it. The plural-owner contract then
  // moves to the term ask that follows his answer.
  assert.match(answer, /ист ден/u, `the day shape is asked: ${answer}`);
  assert.match(answer, /различни денови/u, `both options are offered: ${answer}`);
  assert.match(answer, /еден час/u, `the hour-per-visit rule is stated: ${answer}`);
  const term = await h.say('VO IST DEN');
  assert.match(term, /термин/u, `the term is asked for: ${term}`);
  assert.match(term, /сопствениц(?:ите|и)/iu, `the term is for both owners: ${term}`);
  assert.doesNotMatch(term, /сопственикот/iu, `never one owner for two visits: ${term}`);
});

test('the same family, other spellings: the pair is always plural', async () => {
  for (const ask of [
    'дали 84 и 82 се уште на продажба ?',
    'ДАЛИ 84, 82 СЕ СЛОБОДНИ ?',
    'Дали EB 84 и EB 82 се достапни?',
    'сакам да купам стан. дали евидентен број 84 и евидентен број 82 се уште на продажба?',
  ]) {
    const h = makeHandler();
    h.seed();
    const answer = await h.say(ask);
    assert.match(answer, /82/u, `«${ask}» must answer flat 82 too: ${answer}`);
    assert.match(answer, /1\.000|1000/u, `«${ask}» must state the per-property fee: ${answer}`);
  }
});

test('the singular forms stay singular (the mirror defect)', async () => {
  // A price, an area and a room count are criteria, never a pair of flats.
  assert.equal(detectAvailabilityPlural('Дали е достапен станот за 82.000 евра?'), false);
  assert.equal(detectAvailabilityPlural('Дали имате трисобен стан од 74 м2 и 2 спални?'), false);
  // …and the singular viewing verb is one flat, not two.
  assert.equal(detectPluralViewingWish('КОГА БИ МОЖЕЛО ДА СЕ ПОГЛЕДНЕ ?'), false);
  assert.equal(detectPluralViewingWish('КОГА МОЖЕ ДА СЕ ГЛЕДА СТАНОТ ?'), false);
  // The plural wish is read in the shapes a client actually types.
  assert.equal(detectPluralViewingWish('КОГА БИ МОЖЕЛО ДА СЕ ПОГЛЕДНАТ ?'), true);
  assert.equal(detectPluralViewingWish('КОГА БИ МОЖЕЛЕ ДА СЕ ВИДАТ ?'), true);
  assert.equal(detectPluralViewingWish('koga bi mozele da se poglednat ?'), true);
  // An object that is not a property keeps the sentence out of the visit lane.
  assert.equal(detectPluralViewingWish('КОГА МОЖЕ ДА СЕ ПОГЛЕДНАТ ЦЕНИТЕ ?'), false);

  // ONE flat on the table keeps the one-flat protocol. The timing question is
  // answered with the visit-confirm ask (the owner-contact plan, amount-free and
  // EB-free by design — the bank instruction forbids naming a property there),
  // so the contract is the NUMBER of owners, not a subject line: the singular
  // «сопственикот» must survive, and no plural may leak in.
  const h = makeHandler([EB84]);
  h.seed();
  await h.say('САКАМ ДА КУПАМ ТРОСОБЕН СТАН. ДАЛИ 84 СЕ УШТЕ НА ПРОДАЖБА ?');
  const answer = await h.say('КОГА БИ МОЖЕЛО ДА СЕ ПОГЛЕДНЕ ?');
  assert.match(answer, /сопственикот/u, answer);
  assert.doesNotMatch(answer, /сопствениците|становите со Евидентни/u,
    `one flat has one owner and no plural subject: ${answer}`);
});
