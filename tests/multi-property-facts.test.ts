// THE PAIR ANSWERS EVERY PROPERTY-FACT ASK (the [09:08]–[09:27] field burst).
//
// Two flats were on screen (EB 70 with a lift and a stored year, EB 84 free
// parking in the yard and no lift), and every question about the PAIR was
// answered about one flat — or about nothing:
//
//   [09:08] «како е решено паркирањето кај ови два стана?»
//           → «Кажете ми точно на која недвижност мислите…» (the mention
//             layer asked back: «ови два» was not a pair referent)
//   [09:08] «за двата»
//           → a place-ring line about Дувет, a place nobody asked about
//   [09:21] «дали имаат лифтови?»   → «Има лифт.»
//   [09:22] «кој има лифт?»         → «Има лифт.»   (not even a referent)
//   [09:27] «од која година се?»    → the visit-fee consent script
//
// Three causes, each pinned here through the REAL pipeline with the brain
// forced down (FailingLlm): the short demonstrative «ови два» was missing from
// the pair grammar; a PLURAL ask (plural verb / which-word / plural copula)
// never made the pair the referent; and the plural year question matched no
// year facet at all. The contract: each flat gets its own clause, in the order
// it was served, and a facet the feed cannot answer for one of them never
// hides the other.

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
import { detectInfoFacets } from '../src/llm/infoAnswer';
import { detectPairReferent, detectPluralPropertyAsk } from '../src/llm/deterministic';
import { ebNumbersInText } from '../src/llm/ebNumber';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('probe: LLM disabled'); }
}

const EB70: Property = {
  eb: 70, id: 70, location: 'Центар', address: 'Улица 70', price: 139000,
  bedrooms: 3, sqm: 82, size: '82 м²', service: 'buy', floor: 1,
  yearBuilt: 1998, features: ['лифт', 'паркинг место'], details: '',
} as Property;
const EB84: Property = {
  eb: 84, id: 84, location: 'Центар', address: 'Улица 84', price: 117000,
  bedrooms: 3, sqm: 48, size: '48 м²', service: 'buy', floor: 0,
  features: ['слободен паркинг простор'], noFeatures: ['лифт'], details: '',
} as Property;

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id || r.eb === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler() {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const properties = new FakeProps([EB70, EB84]);
  const handler = new InboundHandler({
    cfg: loadConfig(), db, sessions,
    classifier: new Classifier(new FailingLlm(), loadConfig(), properties),
    responder: new Responder(new FailingLlm(), loadConfig()),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
  });
  const chatId = 'pair-facts';
  /** The pair exactly as the presentation left it: both cards on the table,
   *  the last one pinned as the discussion subject. */
  const seed = () => {
    const s = freshSession('test', chatId);
    s.state = 'presentation';
    s.slots.service = 'buy';
    s.slots.currentBatch = [70, 84];
    s.slots.presentedIds = [70, 84];
    s.slots.propertyId = 84;
    s.slots.interestedPropertyId = 84;
    sessions.set(s);
    return s;
  };
  const say = async (m: string): Promise<string> => {
    sent.length = 0;
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  return { handler, sessions, sent, chatId, seed, say };
}

// ── the readers ─────────────────────────────────────────────────────────────

test('the short demonstrative «ови два» names the pair', () => {
  for (const t of [
    'како е решено паркирањето кај ови два стана ?',
    'ови двата стана имаат лифт ?',
    'за ови двете недвижности',
  ]) {
    assert.equal(detectPairReferent(t), true, `a pair referent: ${t}`);
  }
  // …and a singular deictic is still ONE flat, not the pair.
  assert.equal(detectPairReferent('како е решено паркирањето кај овој стан ?'), false);
});

test('a plural ask about flats is read as plural — singular wording is not', () => {
  for (const t of ['дали имаат лифтови ?', 'кој има лифт ?', 'од која година се ?']) {
    assert.equal(detectPluralPropertyAsk(t), true, `plural ask: ${t}`);
  }
  for (const t of [
    'дали има лифт ?', 'од која година е ?', 'овој стан има лифт ?',
    // «која му е цената?» is ONE flat's price — a which-word, but it governs
    // «е», not «има», so it is not a which-of-them question.
    'која му е цената ?',
    // THE REFLEXIVE CLITIC IS NOT A PLURAL MARKER: «се» used to be a bare
    // alternative, so every refusal and agreement read as a pair question (the
    // plural scope re-served the rejected cards). Only a clause-final copula
    // («од која година СЕ?») counts.
    'NE MI SE DOPAGA', 'ne mi se dopagaat, daj drugi', 'NEBITNI SE SPALNITE',
    'se soglasuvam', 'не ми се допаѓа', 'дали се уште достапни ?',
  ]) {
    assert.equal(detectPluralPropertyAsk(t), false, `single ask: ${t}`);
  }
});

test('a list of Евидентен броеви keeps every number, a price stays a price', () => {
  // THE [09:20] BUG: the old `(?<!\\d\\s)` refused every number after the first
  // in «69 63 и 66», so the availability answer silently lost 63.
  assert.deepEqual(ebNumbersInText('становите со евидентни броеви 69 63 и 66'), [69, 63, 66]);
  // A spaced thousands figure is still money, never a listing.
  assert.deepEqual(ebNumbersInText('цената е 110 000 евра'), []);
  assert.deepEqual(ebNumbersInText('1 250 евра за квадрат'), []);
});

test('the plural year question carries the year facet', () => {
  assert.equal(detectInfoFacets('од која година се ?')?.yearBuilt, true);
  assert.equal(detectInfoFacets('од која година е ?')?.yearBuilt, true);
  // A different object after the same frame is still not a year ask.
  assert.equal(detectInfoFacets('од која година се цените ?')?.yearBuilt, undefined);
});

// ── the pipeline ────────────────────────────────────────────────────────────

test('[09:08] «ови два стана» answers parking for BOTH, never a clarify', async () => {
  const h = makeHandler();
  h.seed();
  const answer = await h.say('како е решено паркирањето кај ови два стана ?');
  assert.match(answer, /Евидентен број 70/u, `the first flat is answered: ${answer}`);
  assert.match(answer, /Евидентен број 84/u, `the second flat is answered: ${answer}`);
  assert.match(answer, /паркинг/iu, `the parking fact is served: ${answer}`);
  assert.ok(!/Кажете ми точно/u.test(answer), `no which-property clarify: ${answer}`);
  // The subject slots are untouched: answering the pair is not choosing one.
  const s = h.sessions.get(h.chatId)!;
  assert.equal(s.slots.propertyId, 84);
});

test('[09:21–09:22] a plural lift ask and «кој има лифт?» answer per flat', async () => {
  for (const ask of ['дали имаат лифтови ?', 'кој има лифт ?']) {
    const h = makeHandler();
    h.seed();
    const answer = await h.say(ask);
    assert.match(answer, /Евидентен број 70/u, `EB 70 is answered (${ask}): ${answer}`);
    assert.match(answer, /Евидентен број 84/u, `EB 84 is answered (${ask}): ${answer}`);
    // The stored feature is 70's; 84's feed says «Не» — a known ABSENCE, so it
    // never borrows the other flat's lift nor a generic «Има лифт.» alone.
    assert.equal((answer.match(/лифт/giu) ?? []).length >= 2, true, `both flats speak about the lift: ${answer}`);
    assert.match(answer, /Нема лифт/u, `EB 84's feed says no lift: ${answer}`);
  }
});

test('[09:27] «од која година се?» answers the year, never the fee script', async () => {
  const h = makeHandler();
  h.seed();
  const answer = await h.say('од која година се ?');
  assert.match(answer, /Евидентен број 70/u, `the first flat is answered: ${answer}`);
  assert.match(answer, /1998/u, `the stored year: ${answer}`);
  assert.match(answer, /Евидентен број 84/u, `the second flat is answered: ${answer}`);
  assert.match(answer, /немам податок[^.]*година/iu, `the honest miss for 84: ${answer}`);
  assert.ok(!/согласувате|500 денари|10 евра|провизија/iu.test(answer),
    `never the fee consent script for a year question: ${answer}`);
});
