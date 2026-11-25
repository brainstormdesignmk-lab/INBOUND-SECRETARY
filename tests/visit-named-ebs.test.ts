// TWO FLATS ASKED FOR, TWO FLATS SERVED (the [06:33] field capture).
//
//   [06:33] BI GI POSETIL 57 I 59 AKO SE SLOBODNI
//   [06:33] ЛИНА: Посетата е за становите со Евидентни броеви 57, 42 и 59
//                 (Центар). … За 3 недвижности тоа е вкупно 900 денари. Дали
//                 се согласувате со овој услов за да можам да го
//                 исконтактирам сопственикот?
//
// Two defects in one turn:
//   • THE VISIT SET WAS EVERY CARD ON THE TABLE. 57 and 59 are from different
//     pairs, so the partner of one of them (42) was swept in by the
//     `currentBatch + presentedIds` build: the client asked for two flats and
//     was quoted a fee for three he never named.
//   • ONE OWNER FOR SEVERAL FLATS. The closing ask of the disclosure says «да
//     го исконтактирам сопственикот» — singular — while the turn is about a
//     list of flats and a list of sums.
//
// The contract these tests pin:
//   • the flats a plural visit is ABOUT are the ones the CLIENT named, in his
//     own order — the same set the chain routes and the fee counts;
//   • a number is a flat only when it is ON SCREEN and carries no unit (евра,
//     м², спални, a clock) — «до 200 000 евра» names nothing to visit;
//   • with no numbers named the wish is about the whole batch, capped at four
//     (the old behaviour, which the [04:10] capture depends on);
//   • 2+ properties pluralise the owner reference in the served disclosure.

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
import { namedVisitEbs } from '../src/llm/deterministic';
import { extendFeeAskForCount, pluralizeOwnerRefs } from '../src/llm/prompts';
import { RESPONSE_BANK } from '../src/data/responses';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('probe: LLM disabled'); }
}

// The three flats on screen: EB 57 and EB 59 (the two he wants, each from a
// different pair) plus EB 42 — the partner that used to ride along.
const ROWS: Property[] = [
  { eb: 57, id: 57, location: 'Центар', address: 'ул. 57', price: 300, bedrooms: 2, sqm: 60, size: '60 м²', service: 'rent', lat: 41.9960, lon: 21.4200, geo_source: 'stored', details: '' },
  { eb: 42, id: 42, location: 'Центар', address: 'ул. 42', price: 320, bedrooms: 3, sqm: 78, size: '78 м²', service: 'rent', lat: 41.9962, lon: 21.4202, geo_source: 'stored', details: '' },
  { eb: 59, id: 59, location: 'Центар', address: 'ул. 59', price: 290, bedrooms: 2, sqm: 58, size: '58 м²', service: 'rent', lat: 41.9964, lon: 21.4204, geo_source: 'stored', details: '' },
] as Property[];

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
  const properties = new FakeProps(ROWS);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
  });
  const chatId = 'visit-57-59';
  const say = async (m: string): Promise<string> => {
    sent.length = 0;
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  // The state before the capture: the three flats presented, the fee not told.
  const seed = () => {
    const s = freshSession('test', chatId);
    s.state = 'presentation';
    s.slots.service = 'rent';
    s.slots.currentBatch = [57, 42, 59];
    s.slots.presentedIds = [57, 42, 59];
    s.slots.location = 'Центар';
    sessions.set(s);
    return s;
  };
  return { handler, sessions, chatId, say, seed };
}

// ── 1. THE EXTRACTOR ───────────────────────────────────────────────────────

test('[06:33] the flats a visit names are the numbers ON SCREEN, in his order', () => {
  const onScreen = [57, 42, 59];
  assert.deepEqual(namedVisitEbs('BI GI POSETIL 57 I 59 AKO SE SLOBODNI', onScreen), [57, 59],
    'the capture sentence names two flats, not the partner of either');
  assert.deepEqual(namedVisitEbs('SAKAM DA GI VIDAM 59 I 57', onScreen), [59, 57],
    'his order is the order');
  // A NUMBER THAT IS NOT A CARD NAMES NOTHING TO VISIT: a phone, a year, a
  // price. The screen is the whitelist, so no unit language is needed here.
  assert.deepEqual(namedVisitEbs('BI GI POSETIL 57 I 59', [57, 59]), [57, 59]);
  assert.deepEqual(namedVisitEbs('DAJ MI 84 I 77', onScreen), [],
    'numbers matching no presented card are not flats');
  // A FIGURE WITH A UNIT IS A QUANTITY, even when it equals a card number.
  assert.deepEqual(namedVisitEbs('DO 57 000 EVRA I 59 M2', onScreen), [],
    'a price and a size are not Евидентни броеви');
  assert.deepEqual(namedVisitEbs('57 Спални и 59 000 евра', onScreen), []);
  assert.deepEqual(namedVisitEbs('57 I 59 VO 15:00', onScreen), [57, 59],
    'the hour beside them is not an EB');
  // One name is one flat; a repeat is still one flat.
  assert.deepEqual(namedVisitEbs('GI POSETIL 57 I 57', onScreen), [57]);
});

// ── 2. THE SERVED TURN ─────────────────────────────────────────────────────

test('[06:33] e2e: «BI GI POSETIL 57 I 59» quotes TWO flats and a fee for two', async () => {
  const h = makeHandler();
  h.seed();
  const reply = await h.say('BI GI POSETIL 57 I 59 AKO SE SLOBODNI');
  const s = h.sessions.get(h.chatId)!;
  assert.equal(s.state, 'closing', `the fee protocol is open: ${reply}`);
  assert.equal(s.slots.visitWanted, true, 'the plural wish is banked');
  // THE SUBJECT LINE IS HIS OWN SET.
  assert.match(reply, /57 |57\.|57,/u, `EB 57 is named: ${reply}`);
  assert.match(reply, /59/u, `EB 59 is named: ${reply}`);
  assert.doesNotMatch(reply, /(?:^|\D)42(?:\D|$)/u,
    `the partner of a PAIR he did not name must never be swept in: ${reply}`);
  assert.match(reply, /Евидентни броеви 57 и 59|Евидентни броеви 57, 59|Евидентни броеви 59 и 57/u,
    `the two he named are the visit: ${reply}`);
  // THE ARITHMETIC COUNTS THE SAME TWO (rent: 300 each).
  assert.match(reply, /За двете недвижности тоа е вкупно 600 денари/u, reply);
  assert.doesNotMatch(reply, /900 денари|3 недвижности|три недвижности/u,
    `no fee for a third flat: ${reply}`);
});

test('[06:33] e2e: the whole batch is the visit only when HE names no numbers', async () => {
  // The [04:10] contract, unchanged: «SAKAM DA GI VIDAM DVATA» is about the
  // cards on the table, so all three are named and counted.
  const h = makeHandler();
  h.seed();
  const reply = await h.say('SAKAM DA GI VIDAM DVATA');
  assert.match(reply, /57/u, reply);
  assert.match(reply, /42/u, reply);
  assert.match(reply, /59/u, reply);
  assert.match(reply, /За 3 недвижности тоа е вкупно 900 денари/u, reply);
});

test('[06:33] e2e: ONE named flat is a one-flat visit, and it is HIS flat', async () => {
  const h = makeHandler();
  h.seed();
  // A stale plural wish must not turn a single named flat into the batch.
  const s0 = h.sessions.get(h.chatId)!;
  s0.slots.visitWanted = true;
  h.sessions.set(s0);
  const reply = await h.say('BI GI POSETIL 59 AKO E SLOBODEN');
  assert.match(reply, /Евидентен број 59/u, `the subject is EB 59: ${reply}`);
  assert.doesNotMatch(reply, /становите со Евидентни броеви/u,
    `a single visit is not a multi-flat disclosure: ${reply}`);
  assert.doesNotMatch(reply, /57|42/u, `no other flat rides along: ${reply}`);
});

// ── 3. THE OWNER COPY ──────────────────────────────────────────────────────

test('[06:33] several flats means several OWNERS in the closing question', () => {
  assert.equal(
    pluralizeOwnerRefs('Дали се согласувате со овој услов за да можам да го исконтактирам сопственикот?'),
    'Дали се согласувате со овој услов за да можам да ги исконтактирам сопствениците?',
  );
  assert.equal(
    pluralizeOwnerRefs('Дали се согласувате со ова за да можам да се слушам со сопственикот?'),
    'Дали се согласувате со ова за да можам да се слушам со сопствениците?',
  );
  assert.equal(
    pluralizeOwnerRefs('Пред да заѕвонам кај сопственикот, да Ве запознаам со политиката.'),
    'Пред да заѕвонам кај сопствениците, да Ве запознаам со политиката.',
  );
  assert.equal(
    pluralizeOwnerRefs('Пред да го ставам сопственикот во тек, обврска ми е да Ве известам.'),
    'Пред да ги ставам сопствениците во тек, обврска ми е да Ве известам.',
  ); 
  // A single property keeps the singular — the perfected copy is untouched.
  const single = 'Дали се согласувате со овој услов за да можам да го исконтактирам сопственикот?';
  assert.equal(extendFeeAskForCount(single, 'rent', 1), single);
});

test('[06:33] EVERY rent disclosure variant pluralises, and still closes with a question', () => {
  const pool: string[] = (RESPONSE_BANK['fee.ask.rent'] ?? []) as string[];
  assert.ok(pool.length >= 2, 'the rent disclosure pool is the thing being swept');
  for (const variant of pool) {
    const two = extendFeeAskForCount(variant, 'rent', 2);
    assert.doesNotMatch(two, /сопственикот/ui, `no singular owner for two flats: ${two}`);
    assert.match(two, /За двете недвижности тоа е вкупно 600 денари\./u, two);
    assert.ok(two.trimEnd().endsWith('?'), `the agreement ask still closes it: ${two}`);
    // The disclosure itself is kept verbatim — only the owner count changed.
    assert.equal(two.length > variant.length, true, two);
  }
  // The buy pool never mentions an owner; the arithmetic alone is added.
  for (const variant of (RESPONSE_BANK['fee.ask.buy'] ?? []) as string[]) {
    const two = extendFeeAskForCount(variant, 'buy', 2);
    assert.match(two, /вкупно 1\.000 денари/u, two);
    assert.ok(two.trimEnd().endsWith('?'), two);
  }
});
