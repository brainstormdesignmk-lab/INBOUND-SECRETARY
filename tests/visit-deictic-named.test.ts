// «DOGOVORI MI DA GI POSETAM 82 I 77» … «AJDE DOGOVORI MI ZA OVIE DVA»
// (the [11:18] V16K11 field capture).
//
//   [11:18] КЛИЕНТ: DOGOVORI MI DA GI POSETAM 82 I 77
//   [11:18] ЛИНА:  … fee.ask.buy (the visit command opens the fee gate)
//   [11:1x] КЛИЕНТ: DA SE SOGLASUVAM
//   [11:1x] КЛИЕНТ: FILIMENA / 078957689
//   [11:1x] КЛИЕНТ: CETVRTOK … POPLADNE … NEKA BIDE 5
//   [11:1x] ЛИНА: Tenth-checking the owners of EB 84, 82, 77 AND 53.
//
// Two flats were named; FOUR owners were pinged. The naming rode a turn whose
// answer is the fee disclosure, then contact collection — three turns later
// the client says only «овие два», `namedVisitEbs` finds no number, and the
// set fell back to `currentBatch + presentedIds` = every card ever presented.
// Nothing ever closed, because a two-flat visit had become a four-stop route.
//
// The contract these tests pin:
//   • a named set is REMEMBERED (`slots.visitEbs`) across the fee and contact
//     turns, and a deictic plural («овие два») resolves to it;
//   • with nothing named and nothing remembered the visit is the cards ON THE
//     TABLE, never every card ever presented;
//   • «сите што ми ги покажа» still means every card — that is the one phrase
//     that says so;
//   • the route's stops and owner asks are exactly the named flats.

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
import { parseVisitDateTime } from '../src/visits/time';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('probe: LLM disabled'); }
}

// The batch the capture had on screen: 77 + 53 (one per landmark), then the
// «DRUGI» pair 84 + 82. He names 82 and 77 — one flat from each pair.
const ROWS: Property[] = [
  { eb: 77, id: 77, location: 'Центар', address: 'ул. 77', price: 130000, bedrooms: 2, sqm: 45, size: '45 м²', service: 'buy', lat: 41.9970, lon: 21.4190, geo_source: 'stored', details: '' },
  { eb: 53, id: 53, location: 'Аеродром', address: 'ул. 53', price: 55000, bedrooms: 2, sqm: 44, size: '44 м²', service: 'buy', lat: 41.9860, lon: 21.4666, geo_source: 'stored', details: '' },
  { eb: 84, id: 84, location: 'Центар', address: 'ул. 84', price: 117000, bedrooms: 3, sqm: 48, size: '48 м²', service: 'buy', lat: 41.9972, lon: 21.4192, geo_source: 'stored', details: '' },
  { eb: 82, id: 82, location: 'Аеродром', address: 'ул. 82', price: 143000, bedrooms: 3, sqm: 77, size: '77 м²', service: 'buy', lat: 41.9862, lon: 21.4668, geo_source: 'stored', details: '' },
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
  const asks: string[] = [];
  handler.onOwnerAsk = (_c, _eb, q) => asks.push(q);
  const chatId = 'visit-82-77';
  const say = async (m: string): Promise<string> => {
    sent.length = 0;
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  // The state before the capture: the four cards presented, 84 + 82 on the
  // table now, nothing agreed yet.
  const seed = () => {
    const s = freshSession('test', chatId);
    s.state = 'presentation';
    s.slots.service = 'buy';
    s.slots.currentBatch = [84, 82];
    s.slots.presentedIds = [77, 53, 84, 82];
    s.slots.location = 'Центар';
    sessions.set(s);
    return s;
  };
  return { handler, sessions, sent, asks, chatId, say, seed };
}

/** The four turns the capture took between the naming and the term. */
async function toTerm(h: ReturnType<typeof makeHandler>): Promise<string[]> {
  const replies: string[] = [];
  replies.push(await h.say('DA SE SOGLASUVAM'));
  replies.push(await h.say('AJDE DOGOVORI MI ZA OVIE DVA PA KE VIDIME ZA PONATAMU'));
  replies.push(await h.say('FILIMENA\n078957689'));
  replies.push(await h.say('CETVRTOK'));
  replies.push(await h.say('POPLADNE NEKOE VREME'));
  replies.push(await h.say('NEKA BIDE 5'));
  return replies;
}

// ── 1. THE NAMING SURVIVES THE FEE AND CONTACT TURNS ───────────────────────

test('[11:18] the fee turn banks the named flats, and a deictic «овие два» reads them back', async () => {
  const h = makeHandler();
  h.seed();
  const fee = await h.say('DOGOVORI MI DA GI POSETAM 82 I 77');
  assert.match(fee, /Евидентни броеви 82 и 77|Евидентни броеви 77 и 82/u,
    `the disclosure names the two he asked for: ${fee}`);
  const s = h.sessions.get(h.chatId)!;
  assert.deepEqual(s.slots.visitEbs, [82, 77], 'his own order is the visit set');
  assert.equal(s.slots.visitWanted, true, 'the plural wish is banked');
  // The agreement and the contact turns carry no numbers at all — the set
  // must survive them untouched, because that is what the term turn reads.
  await h.say('DA SE SOGLASUVAM');
  await h.say('AJDE DOGOVORI MI ZA OVIE DVA PA KE VIDIME ZA PONATAMU');
  await h.say('FILIMENA\n078957689');
  assert.deepEqual(h.sessions.get(h.chatId)!.slots.visitEbs, [82, 77],
    'the fee and contact turns do not forget which two flats he chose');
});

test('[11:18] e2e: the route asks the owners of 82 and 77 only — never 84 or 53', async () => {
  const h = makeHandler();
  h.seed();
  await h.say('DOGOVORI MI DA GI POSETAM 82 I 77');
  await toTerm(h);
  const s = h.sessions.get(h.chatId)!;
  const plan = s.slots.visitPlan;
  assert.ok(plan, `the term started the route: state=${s.state} asks=${JSON.stringify(h.asks)}`);
  assert.deepEqual(plan.stops.map(st => st.eb), [82, 77],
    'the route is the two flats he named, in his order');
  assert.equal(h.asks.length > 0, true, 'the first owner was asked');
  assert.match(h.asks[0] ?? '', /број 82/u, `the first ask is about EB 82: ${h.asks[0]}`);
  assert.equal(h.asks.some(a => /број 84/u.test(a)), false, `no owner of EB 84 is pinged: ${JSON.stringify(h.asks)}`);
  assert.equal(h.asks.some(a => /број 53/u.test(a)), false, `no owner of EB 53 is pinged: ${JSON.stringify(h.asks)}`);
});

// ── 2. THE SET WITH NOTHING NAMED ──────────────────────────────────────────

test('[11:18] with nothing named the visit is the PAIR on the table, not every card presented', async () => {
  const h = makeHandler();
  h.seed();
  const reply = await h.say('SAKAM DA GI VIDAM DVATA');
  assert.match(reply, /84/u, `the pair on the table is the visit: ${reply}`);
  assert.match(reply, /82/u, reply);
  assert.doesNotMatch(reply, /Евидентни броеви 77|Евидентни броеви 53/u,
    `cards presented earlier are not swept in: ${reply}`);
  const s = h.sessions.get(h.chatId)!;
  assert.equal(s.slots.visitEbs, undefined, 'a deictic plural names nothing new');
  await toTerm(h);
  const plan = h.sessions.get(h.chatId)!.slots.visitPlan!;
  assert.deepEqual(plan.stops.map(st => st.eb), [84, 82], 'the table pair is the route');
});

test('[11:18] «сите што ми ги покажа» still means every card — the one phrase that says so', () => {
  const h = makeHandler();
  const session = h.seed();
  // The build itself (the seam the fee subject line and the route share): the
  // everything-shown phrase is the ONLY plural that widens past the table.
  const ebs = (h.handler as unknown as {
    multiVisitEbs: (s: typeof session, t: string) => number[];
  }).multiVisitEbs(session, 'SAKAM DA GI VIDAM SITE STO MI GI POKAZA');
  assert.deepEqual([...ebs].sort((a, b) => a - b), [53, 77, 82, 84],
    'every presented card is the visit he asked for');
});

// ── 3. A MID-ROUTE NARROWING ───────────────────────────────────────────────

test('[11:18] two ЕВ numbers never eat the clock beside them', () => {
  // «NE, SAMO 82 I 77, CETVRTOK VO 17:00» matched the digit-minutes arm with
  // hour 82, was rejected, and the "a day alone defaults to midday" rule then
  // invented 12:00 — the owners would have been asked for noon.
  const now = new Date(2026, 10, 18, 10, 0);
  const when = parseVisitDateTime('NE, SAMO 82 I 77, CETVRTOK VO 17:00', now);
  assert.ok(when, 'the term parses');
  assert.equal(when!.getHours(), 17, `the clock he said, not a fabricated midday: ${when!.toString()}`);
  assert.equal(when!.getDay(), 4, 'Thursday, as he said');
});

test('[11:18] a mid-route renaming rebuilds the stops to his new list', async () => {
  // The live chat of the capture is already running a four-stop route. The
  // client narrows it in words («NE, SAMO 82 I 77») — the stops must follow
  // him, or the owner of 84 is still being asked for a flat he dropped.
  const h = makeHandler();
  const s = h.seed();
  s.state = 'owner_checking';
  s.slots.viewingFeeAgreed = true;
  s.slots.feeDisclosed = true;
  s.slots.visitWanted = true;
  s.slots.interestedPropertyId = 84;
  // THE DAY IS DERIVED, NOT PINNED (the [11:18] fixture used to say
  // «Thursday 19.11.2026, 17:00» and started failing the first time the suite
  // ran after 17:00 that day): `parseVisitDateTime` rolls a term that is
  // already past to the NEXT week, so `moved` stopped matching the running
  // plan's day and the TERM-CHANGE restart — an unrelated branch — voided the
  // answers this test exists to keep. The route is a fortnight ahead at the
  // same hour, always in the future, and the client's message names that exact
  // date: only the SET changes, which is the rule under test.
  // THE DERIVED DAY MUST BE THE PLAN'S WEEKDAY: the seeded term is CETVRTOK
  // (Thursday), so a plain `now + 14d` names a SATURDAY every time the suite
  // runs in a week where that offset lands off-Thursday — the TERM-CHANGE
  // branch then restarts the visit and the stops are rebuilt from the message
  // instead of narrowed from the route. Anchor to the Thursday at least a week
  // out (always future, always the plan's day).
  const anchor = new Date(Date.now() + 7 * 86400_000);
  const day = new Date(anchor.getFullYear(), anchor.getMonth(), anchor.getDate());
  day.setDate(day.getDate() + ((4 - day.getDay() + 7) % 7)); // 4 = Thursday
  const dd = String(day.getDate()).padStart(2, '0');
  const mm = String(day.getMonth() + 1).padStart(2, '0');
  const yyyy = day.getFullYear();
  const dayTerm = `${dd}.${mm}.${yyyy}`;
  s.slots.visitTime = `${dayTerm} во 17:00`;
  s.slots.ownerAskTime = `${dayTerm} во 17:00`;
  s.slots.visitPlan = {
    dayMs: new Date(day.getFullYear(), day.getMonth(), day.getDate()).getTime(),
    targetHour: 17,
    term: 'CETVRTOK POPLADNE NEKOE VREME NEKA BIDE 5',
    stops: [
      { eb: 84, status: 'counter', asks: 1, askedHour: 17, hours: [18] },
      { eb: 82, status: 'ok', asks: 1, askedHour: 18, hours: [18] },
      { eb: 77, status: 'counter', asks: 1, askedHour: 19, hours: [17] },
      { eb: 53, status: 'asked', asks: 1, askedHour: 20 },
    ],
    flexible: false,
  };
  h.sessions.set(s);
  // Same day, same hour as the running route: only the SET changes.
  await h.say(`NE, SAMO 82 I 77, ${dayTerm} VO 17:00`);
  const plan = h.sessions.get(h.chatId)!.slots.visitPlan!;
  assert.deepEqual(plan.stops.map(st => st.eb), [82, 77],
    'the route is the two he narrowed it to');
  assert.deepEqual(h.sessions.get(h.chatId)!.slots.visitEbs, [82, 77]);
  // The answers already on file for a flat that stays are kept — EB 82's 18:00
  // is not re-asked.
  const kept = plan.stops.find(st => st.eb === 82)!;
  assert.equal(kept.hours?.[0], 18, `EB 82 keeps its owner's hour: ${JSON.stringify(kept)}`);
});

// ── 4. A LATER NAMING IS THE NEW SET ───────────────────────────────────────

test('[11:18] a second naming REPLACES the remembered set', async () => {
  const h = makeHandler();
  h.seed();
  await h.say('DOGOVORI MI DA GI POSETAM 82 I 77');
  const session = h.sessions.get(h.chatId)!;
  assert.deepEqual(session.slots.visitEbs, [82, 77]);
  // Read through the same build the route uses: the newest naming wins.
  const ebs = (h.handler as unknown as {
    multiVisitEbs: (s: typeof session, t: string) => number[];
  }).multiVisitEbs(session, 'NE, SAKAM DA GI POSETAM 84 I 53');
  assert.deepEqual(ebs, [84, 53], 'the client changed his mind');
  assert.deepEqual(session.slots.visitEbs, [84, 53], 'and the memory follows him');
});
