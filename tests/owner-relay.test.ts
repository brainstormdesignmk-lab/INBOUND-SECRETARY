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
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { mkTimePhrase } from '../src/data/properties';
import { detectOwnerVerdict, detectWorkdaysQuestion, detectVisitTime, isOwnerAvailabilityOnly } from '../src/llm/deterministic';
import { buildOwnerAskAgain, buildOwnerAvailabilityAck } from '../src/llm/prompts';
import { matchesPoolContract, FIXED_SEEDS } from '../src/data/responseBank';
import { hasClockHint } from '../src/visits/time';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 78, id: 78, location: 'Центар', price: 36000, service: 'buy', sqm: 74, size: '74 м²', address: 'Партизерска 10', lat: 41.996, lon: 21.428, geo_source: 'stored' } as Property,
  { eb: 47, id: 47, location: 'Центар', price: 40000, service: 'buy', sqm: 70, size: '70 м²', address: 'Партизерска 10', lat: 41.996, lon: 21.428, geo_source: 'stored' } as Property,
];

async function makeHandler() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels, landmarks: undefined,
  });
  const send = async (m: string) => { await handler.handle('test', 'relay', m); return sessions.get('relay')!; };
  return { handler, sessions, sent, send };
}

// Reusable setup: interest → fee → agree → contact → proposed time → owner_checking
async function reachOwnerChecking(send: (m: string) => Promise<any>): Promise<void> {
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA'); // confirm owner contact
  await send('DA, SE SOGLASUVAM'); // fee agree
  await send('ZORAN 078/914 196'); // contact
  const s = await send('UTRE POPLADNE POSLE 6'); // proposed time → owner_checking
  assert.equal(s.state, 'owner_checking', `setup failed: ${s.state}`);
}

test('mkTimePhrase: English day canonizations render Macedonian in client-facing relays', () => {
  assert.equal(mkTimePhrase('Friday 18:00'), 'Петок 18:00');
  assert.equal(mkTimePhrase('friday 18:00'), 'Петок 18:00');
  assert.equal(mkTimePhrase('saturday posle 5'), 'Сабота posle 5');
  assert.equal(mkTimePhrase('Петок во 18:00'), 'Петок во 18:00'); // untouched
  assert.equal(mkTimePhrase('VO NEDELA RABOTITE ?'), 'VO NEDELA RABOTITE ?'); // mixed-script untouched
});

test('whole-day counter: owner offers a day with any hour → relay carries the day, asks the client for the clock', async () => {
  const { handler, sessions, sent, send } = await makeHandler();
  await reachOwnerChecking(send);

  // THE 20:24 FIELD TEXT: refusal + day proposal with NO clock.
  const verdict = detectOwnerVerdict('NE MOZAM VO 6 VO PETOK . CEL DEN SUM ZAUZET. KE MORA VO SABOTA . BILO KOE VREME', 'Утре попладне после 6');
  assert.ok(verdict, 'owner text must parse');
  assert.equal(verdict.status, 'counter');
  assert.match(verdict.ownerTime ?? '', /сабот/i, `the day proposal must survive: ${JSON.stringify(verdict)}`);
  assert.equal(verdict.canAcceptWholeDay, true, 'day-only counter must flag canAcceptWholeDay');

  // The verdict lands in the pipeline → the relay carries the day + clock ask
  handler.ownerAnswer('relay', 78, verdict);
  await new Promise(r => setTimeout(r, 50));
  const s = sessions.get('relay')!;
  assert.equal(s.state, 'visit_scheduling', `relay must return to visit_scheduling, got ${s.state}`);
  const relay = sent[sent.length - 1];
  assert.match(relay, /сабот/iu, `relay must carry the owner's day: ${relay}`);
  // The whole-day invariant: the relay ASKS the client to complete the term
  // — it ends with a question carrying the hour/time ask (every bank variant
  // is spec-bound to `?` + a time word; enumeration keeps lagging new draws).
  assert.ok(relay.trim().endsWith('?'), `relay must ask the client to precise the clock: ${relay}`);
  assert.match(relay, /час|време|термин|кога|колку/u, `relay must ask for the hour: ${relay}`);
  assert.ok(!/не може во тој термин(?!.*сабот)/iu.test(relay), `never the dropped-day refusal: ${relay}`);
});

// ── The [00:11] field rule: the OWNER holds the calendar ────────────────────
// The transcript: the client proposed Tuesday 17:00, the owner answered «НЕ
// МОЖАМ ВО ВТОРНИК. ЦЕЛ ДЕН СУМ ЗАУЗЕТ» (a bare counter, no alternative), and
// Lina told the CLIENT «Проверив со сопственикот, но тој е зафатен во Вторник…
// Кој друг термин би Ви одговарал?» — asking the person who cannot know when
// the flat can be shown, while the owner was never asked for a term of his own.
// Both sides matter equally: the owner is asked for HIS day and hour, and that
// term is transported to the client.
test('[00:11] bare owner counter: the OWNER is asked for his term, the client is never re-asked', async () => {
  const { handler, sessions, sent, send } = await makeHandler();
  const asks: string[] = [];
  handler.onOwnerAsk = (_c, _eb, q) => asks.push(q);
  await reachOwnerChecking(send);
  assert.equal(asks.length, 1, `the first availability ask expected: ${JSON.stringify(asks)}`);

  handler.ownerAnswer('relay', 78, detectOwnerVerdict('НЕ МОЖАМ ВО ВТОРНИК. ЦЕЛ ДЕН СУМ ЗАУЗЕТ', 'Утре попладне после 6')!);
  await new Promise(r => setTimeout(r, 50));
  const s = sessions.get('relay')!;
  // The term is still unsettled, so the check stays open for his answer…
  assert.equal(s.state, 'owner_checking', `the owner check must stay armed: ${s.state}`);
  // …which is HIS to give: the ask names the client's term and asks the owner.
  const ownerAsk = asks[asks.length - 1] ?? '';
  assert.match(ownerAsk, /Кој ден и час Ви одговараат/iu, `the owner must be asked for his term: ${ownerAsk}`);
  assert.match(ownerAsk, /не Ви одговара/iu, `and told which term it is about: ${ownerAsk}`);
  // The client hears the honest holding line — never a request to produce
  // another time, and never a fabricated owner proposal.
  const hold = sent[sent.length - 1] ?? '';
  assert.match(hold, /Сопственикот не е слободен во/iu, `the client hears why: ${hold}`);
  assert.match(hold, /Ќе го прашам/iu, `and who is being asked: ${hold}`);
  assert.ok(!/[?]/.test(hold), `no question back to the client: ${hold}`);
  assert.ok(!/термин би Ви одговарал/iu.test(hold), `never the old re-ask: ${hold}`);

  // The owner's own term arrives → the SAME counter relay transports it.
  handler.ownerAnswer('relay', 78, detectOwnerVerdict('среда во 11', s.slots.visitTime ?? '')!);
  await new Promise(r => setTimeout(r, 50));
  const relay = sent[sent.length - 1] ?? '';
  assert.match(relay, /Има друг предлог: Среда, \d{2}\.\d{2}\.\d{4} во 11:00/u,
    `the owner's term reaches the client: ${relay}`);
  assert.equal(sessions.get('relay')!.state, 'time_confirm');
});

test('workdays question never reaches the owner — answered from the bank, then scheduling continues', async () => {
  const { handler, sessions, sent, send } = await makeHandler();
  await reachOwnerChecking(send);

  assert.equal(detectWorkdaysQuestion('VO NEDELA RABOTITE ?'), true, 'the 20:26 field text must fire');
  assert.equal(detectVisitTime('VO NEDELA RABOTITE ?'), undefined, 'and must never be captured as a slot');

  const s = await send('VO NEDELA RABOTITE ?');
  assert.equal(s.state, 'owner_checking', 'the pending owner check must stay alive');
  const reply = sent[sent.length - 1];
  assert.match(reply, /понеделник|петок/u, `agency hours must be answered: ${reply}`);
  assert.match(reply, /сабота и недела|неработн|не работиме|затворен|не е можно|не работи/u, `closed days must be stated: ${reply}`);
  // The owner ask must NOT echo the hours question as a proposed term
  // (the previous owner ask carried the visit time, not this question).
  assert.ok(!sent.some(t => /сака посета: VO NEDELA/u.test(t)), `hours question must never be forwarded to the owner`);
});

test('workdays question still fires without a question mark ("rabotite vo nedela")', () => {
  assert.equal(detectWorkdaysQuestion('rabotite vo nedela'), true);
  assert.equal(detectWorkdaysQuestion('dali rabotite vo sabota'), true);
  assert.equal(detectVisitTime('rabotite vo nedela'), undefined);
});

test('workdays detector never eats slot proposals or acceptances', () => {
  assert.equal(detectWorkdaysQuestion('VO PETOK BI MOZELA POSLE 5'), false, 'slot proposal with clock-context must stay a slot');
  assert.equal(detectWorkdaysQuestion('VO SABOTA VO 10 E SUPER'), false, 'acceptance of a proposed term stays a slot');
  assert.equal(detectWorkdaysQuestion('rabotite od 9 do 17'), false, 'carries a clock → not a days question');
});

test('whole-day sweep round 2: obligation anchor, whenever idioms, inflected day forms', () => {
  // ke-mora obligation inside the refusal clause — the scope rule must not
  // discard the offered day
  const km = detectOwnerVerdict('Nemozam togas ke mora vo nedela, sloboden sum bilokoga', 'Утре во 18:00');
  assert.equal(km?.status, 'counter');
  assert.equal(km?.canAcceptWholeDay, true);
  assert.match(km?.ownerTime ?? '', /недел/i);
  // Latin disagreement + whenever idiom
  const lat = detectOwnerVerdict('ne mi odgovara toj den, vikendov moze koga bilo', 'Утре во 18:00');
  assert.equal(lat?.canAcceptWholeDay, true);
  assert.match(lat?.ownerTime ?? '', /викенд/i);
  // Range idiom must not let the day-part steal the carrier ("Среда вечер" was fabricated)
  const range = detectOwnerVerdict('Зафатен сум тогаш, во среда сум слободен од сабајле до вечер.', 'Утре во 18:00');
  assert.equal(range?.canAcceptWholeDay, true);
  assert.ok(!/вечер/.test(range?.ownerTime ?? ''), `range endpoint must not become the term: ${range?.ownerTime}`);
  // "ne e mozno" + sloboden must NEVER ok on the refused time
  const okTrap = detectOwnerVerdict('ne e mozno togas. vo petk cel den sum sloboden bilo koe vreme.', 'Утре во 18:00');
  assert.equal(okTrap?.status, 'counter');
  assert.equal(okTrap?.canAcceptWholeDay, true);
});

test('open-start clock: «SLOBODEN SUM OD 6» is a fixed 18:00, never an open day', async () => {
  // THE [00:31] CAPTURE: the owner refused, then offered Wednesday «from 6».
  // «од» was not a clock prefix for the OWNER parser (visits/time.CLOCK_RE has
  // always accepted it), so the message read as a bare day + a refusal and
  // the whole-day branch told the client «Среда — било кое време му одговара»,
  // dropping the hour the owner had named.
  const v = detectOwnerVerdict('NEMA DA MOZAM . SLOBODEN SUM OD 6 VO SREDA AKO ODGOVARA', 'Понеделник во 17:00');
  assert.ok(v, 'owner text must parse');
  assert.equal(v.status, 'counter');
  assert.equal(v.canAcceptWholeDay, undefined, `a named hour is a FIXED counter: ${JSON.stringify(v)}`);
  assert.match(v.ownerTime ?? '', /сред/iu, `the owner's day survives: ${JSON.stringify(v)}`);
  assert.match(v.ownerTime ?? '', /18:00/, `the VISIT WINDOW resolves «од 6» to 18:00: ${JSON.stringify(v)}`);

  // e2e: the client's relay carries the day AND the 24h clock, never the
  // open-day wording.
  const { handler, sessions, sent, send } = await makeHandler();
  await reachOwnerChecking(send);
  handler.ownerAnswer('relay', 78, v);
  await new Promise(r => setTimeout(r, 50));
  const s = sessions.get('relay')!;
  assert.equal(s.state, 'time_confirm', `a fixed counter goes to acceptance, got ${s.state}`);
  const relay = sent[sent.length - 1];
  assert.match(relay, /18:00/, `the relay must keep the owner's hour: ${relay}`);
  assert.match(relay, /сред/iu, `the relay must carry the owner's day: ${relay}`);
  assert.ok(!/било кое време/iu.test(relay), `never the open-day wording: ${relay}`);
});

test('fixed counters and refusals never gain the whole-day flag', () => {
  // No anytime idiom, no refusal: a bare positive day is a FIXED counter
  const fixed = detectOwnerVerdict('vo petok mozam', 'Утре во 18:00');
  assert.equal(fixed?.status, 'counter');
  assert.equal(fixed?.canAcceptWholeDay, undefined);
  // Refused day without an alternative: bare counter, no day at all
  const bare = detectOwnerVerdict('ne mozam utre vo 4', 'Утре во 4');
  assert.equal(bare?.status, 'counter');
  assert.equal(bare?.ownerTime, undefined);
  // Clock counter stays fixed
  const clock = detectOwnerVerdict('ne, samo vo petok vo 11', 'Утре во 18:00');
  assert.equal(clock?.canAcceptWholeDay, undefined);
  assert.match(clock?.ownerTime ?? '', /Петок во 11/);
});

test('mkTimePhrase canonicalizes owner day misspellings in both scripts', () => {
  assert.equal(mkTimePhrase('Средота'), 'Среда');
  assert.equal(mkTimePhrase('Сабота'), 'Сабота');
  assert.equal(mkTimePhrase('sabta'), 'Сабота');
  assert.equal(mkTimePhrase('sredta vo 6'), 'Среда vo 6');
  assert.equal(mkTimePhrase('Петк'), 'Петок');
  assert.equal(mkTimePhrase('Црногорска амбасада'), 'Црногорска амбасада'); // non-day text untouched
  assert.equal(mkTimePhrase('Friday 18:00'), 'Петок 18:00'); // English-day path intact
});

// ── The [00:23] capture: the owner refused Thursday and proposed "PETOK 18/?"
// (bare hour, no preposition, trailing "/?" typo). The old parser read the
// refused day as a whole-day offer ("за Четврток му одговара било кој час"). ──
test('[00:23] "NE MOZAM VO CETVRTOK . ZAFATEN SUM CEL DEN . PETOK 18/?" is Friday 18:00', () => {
  for (const text of [
    'NE MOZAM VO CETVRTOK . ZAFATEN SUM CEL DEN . PETOK 18/?',
    'NE MOZAM VO CETVRTOK . ZAFATEN SUM CEL DEN . PETOK 18',
  ]) {
    const v = detectOwnerVerdict(text, 'Четврток, 22.10.2026 во 17:30')!;
    assert.equal(v.status, 'counter', text);
    assert.equal(v.canAcceptWholeDay, undefined, `the refused Thursday must not become a whole-day offer: ${JSON.stringify(v)}`);
    assert.equal(mkTimePhrase(v.ownerTime ?? ''), 'Петок во 18:00', text);
  }
  // A real date ("petok 18.10") is not a clock.
  const date = detectOwnerVerdict('ne mozam cetvrtok, petok 18.10', 'Четврток, 22.10.2026 во 17:30')!;
  assert.ok(!/18:00/.test(date.ownerTime ?? ''), `date must not read as a clock: ${JSON.stringify(date)}`);
});

test('counter relay names the refused term AND the owner proposal', async () => {
  const { handler, sessions, sent, send } = await makeHandler();
  await reachOwnerChecking(send);
  handler.ownerAnswer('relay', 78, { status: 'counter', ownerTime: 'Петок во 18:00' });
  await new Promise(r => setTimeout(r, 50));
  assert.equal(sessions.get('relay')!.state, 'time_confirm');
  const relay = sent[sent.length - 1];
  // The counter term is normalizedOwnerTime-canonical (the [19:29] capture —
  // "vo 7ipol ?" must reach the client as 24h "19:30", not the lossy
  // mkTimePhrase bare clock): day + next-occurrence date + 24h clock.
  assert.match(relay, /^Сопственикот не е во можност за посета во .+\. Има друг предлог: Петок, \d{2}\.\d{2}\.\d{4} во 18:00\. Дали би Ви одговарал тој термин\?$/u, relay);
});

test('second owner turn: a changed client term sends the one-line proposal, not the first-time intro', async () => {
  const { handler, sessions, send } = await makeHandler();
  const asks: string[] = [];
  handler.onOwnerAsk = (_c, _eb, q) => asks.push(q);
  await reachOwnerChecking(send);
  assert.equal(asks.length, 1, `first owner ask expected: ${JSON.stringify(asks)}`);
  assert.match(asks[0], /Дали .*сè уште достап/u, `first ask is the full availability intro: ${asks[0]}`);

  // Client proposes a DIFFERENT term while the owner check is in flight.
  const s = await send('VO SABOTA VO 12:00');
  assert.equal(s.state, 'owner_checking');
  assert.equal(asks.length, 2, `a second owner ask must go out: ${JSON.stringify(asks)}`);
  assert.match(asks[1], /^Клиентот не е во можност за посета во .+\..*Има друг предлог: .*Сабота.*12:00.*Дали би Ви одговарал тој термин\?$/u, asks[1]);
  assert.ok(!/Дали е сè уште достапна|Ве контактирам во врска/u.test(asks[1]), `the first-time intro must not repeat: ${asks[1]}`);
});

test('fixed counter with clock still relays a precise term (regression guard)', async () => {
  const { handler, sessions, sent, send } = await makeHandler();
  await reachOwnerChecking(send);
  const verdict = detectOwnerVerdict('ne, samo vo petok vo 11', 'Утре попладне после 6')!;
  assert.equal(verdict.status, 'counter');
  assert.equal(verdict.canAcceptWholeDay, undefined);
  handler.ownerAnswer('relay', 78, verdict);
  await new Promise(r => setTimeout(r, 50));
  const s = sessions.get('relay')!;
  assert.equal(s.state, 'time_confirm');
  assert.match(sent[sent.length - 1], /Петок, \d{2}\.\d{2}\.\d{4} во 11:00/u);
});

test('fixed-clock family: exclusive openers, reversed clocks, lone day-parts — the clock never drops', () => {
  for (const t of ['samo vo petok vo 11', 'SAMO VO PETOK VO 11', 'samo petok vo 11 mozam',
    'mozam samo vo petok vo 11', 'edino vo petok vo 11', 'samo vo 11 vo petok',
    'vo 11:30 vo sreda', 'samo utre vo 11:30', 'samo sreda posle 5',
    'vo 11:30 samo', 'samo popladne mozam', 'pred 12 nemozam, samo posle 6',
    'iskljucivo petok vo 11', 'lie vo petok vo 11']) {
    const v = detectOwnerVerdict(t, 'утре во 18:00');
    assert.ok(v && v.status === 'counter' && !v.canAcceptWholeDay && v.ownerTime,
      `fixed-clock counter required: ${t} → ${JSON.stringify(v)}`);
  }
});

test('"samo popladne mozam" — a word-internal "ne" never fabricates a refusal', () => {
  // OWNER_CANT_RE/OWNER_DISAGREE_RE matched the "ne" INSIDE "popladne" —
  // the offered window was read as a refusal and dropped entirely.
  const v = detectOwnerVerdict('samo popladne mozam', 'утре во 18:00')!;
  assert.equal(v.status, 'counter');
  assert.match(v.ownerTime!, /попладне/iu);
});

test('the reversed clock "samo vo 11 vo petok" relays the full term, not the bare day', () => {
  const v = detectOwnerVerdict('samo vo 11 vo petok', 'утре во 18:00')!;
  assert.match(v.ownerTime!, /Петок во 11/u);
});

// ── The [14:22] transcript: the owner ask carried the client's RAW shorthand
// ("VO PONEDELNIK MOZAM 6 SAAT"). The owner must read the TRANSLATED term —
// resolved to the concrete date and rewritten canonically. ──
test('normalizeOwnerTime: raw client shorthand becomes the canonical dated term', async () => {
  const { normalizeOwnerTime } = await import('../src/llm/prompts');
  // Pinned clock: 2026-09-25 is a Friday → the next понеделник is 28.09.2026.
  const now = new Date(2026, 8, 25, 14, 0, 0);
  // "6 saat" = 18:00 (the hour-word parser must read 18:00, not 06:00).
  const a = normalizeOwnerTime('VO PONEDELNIK MOZAM 6 SAAT', now);
  assert.match(a, /Понеделник, 28\.09\.2026 во 18:00/u, `hour-word must resolve to 18:00: ${a}`);
  // A phrase that already carries a proper clock keeps it.
  const b = normalizeOwnerTime('vo ponedelnik vo 18:00', now);
  assert.match(b, /Понеделник, 28\.09\.2026 во 18:00/u, b);
  // A day with NO clock keeps the date but no fabricated hour.
  const c = normalizeOwnerTime('vo petok', now);
  assert.match(c, /Петок, \d{2}\.\d{2}\.\d{4}$/u, `day-only must not fabricate a clock: ${c}`);
  // An unresolvable phrase keeps the display-caps fallback (mkTimePhrase
  // capitalizes; it never transliterates the client's own words).
  const d = normalizeOwnerTime('po dogovor', now);
  assert.match(d, /^[Pp]o dogovor$/u, d);
});

test('the owner ask relays the NORMALIZED term, never the raw client shorthand', async () => {
  const { handler, sent, send } = await makeHandler();
  await reachOwnerChecking(send);
  // Proposed term captured in slots by the previous send (reachOwnerChecking).
  // Fire the normalization unit-asserts inline: the ask builder wraps
  // normalizeOwnerTime, so a shorthand slot can never reach the owner verbatim.
  const { normalizeOwnerTime } = await import('../src/llm/prompts');
  const out = normalizeOwnerTime('VO PONEDELNIK MOZAM 6 SAAT');
  assert.ok(!/SAAT|MOZAM/u.test(out), `raw shorthand must not survive: ${out}`);
  assert.match(out, /Понеделник/u, out);
});

// ── The [01:06] phase-2 capture: after the owner's whole-day counter
// ("PONEDELNIK BILO KOE VREME"), the client completes the clock ("MOZAM VO
// 5"). The whole-day relay used to leave the client's own REJECTED term in
// slots.visitTime — a clock-carrying store vetoes the day-first merge, so
// the completion landed as a day-less clock and the owner was re-asked for
// TODAY ("Петок, 23.10.2026 во 17:00"). The whole-day branch must seed the
// slot with the OWNER'S day so the completion merges day-first. ──
test('whole-day counter seeds the slot with the owner day — the completing clock merges day-first', async () => {
  const { handler, sessions, send } = await makeHandler();
  const asks: string[] = [];
  handler.onOwnerAsk = (_c, _eb, q) => asks.push(q);
  await reachOwnerChecking(send);
  assert.equal(asks.length, 1);

  const verdict = detectOwnerVerdict('NE MOZAM VO 6 VO PETOK . PONEDELNIK BILO KOE VREME MI ODGOVARA', 'Утре попладне после 6');
  assert.equal(verdict?.status, 'counter');
  assert.equal(verdict?.canAcceptWholeDay, true);
  handler.ownerAnswer('relay', 78, verdict!);
  await new Promise(r => setTimeout(r, 50));
  const s = sessions.get('relay')!;
  assert.equal(s.state, 'visit_scheduling', `whole-day relay must return to visit_scheduling: ${s.state}`);
  assert.match(s.slots.visitTime ?? '', /^Понеделник$/iu, `slot must be seeded with the owner MONO day only: ${JSON.stringify(s.slots.visitTime)}`);
  assert.ok(!hasClockHint(s.slots.visitTime ?? ''), `the seed must be clock-free or the merge dies: ${s.slots.visitTime}`);

  const s2 = await send('MOZAM VO 5');
  assert.equal(s2.state, 'owner_checking', `the completion re-asks the owner: ${s2.state}`);
  assert.equal(asks.length, 2, `the follow-up ask must go out: ${JSON.stringify(asks)}`);
  // Acceptance contract (the [01:07] corrected semantics): the client completed
  // the owner's OWN whole-day counter — the ask reads acceptance, and the
  // owner's day survives into the completed DATED term.
  assert.match(asks[1], /Предлог за посета: Понеделник, \d{2}\.\d{2}\.\d{4} во 17:00\. Дали го потврдувате тој термин\?$/u, `the owner day must survive into the follow-up ask: ${asks[1]}`);
  assert.ok(!/Има друг предлог: Петок|Има друг предлог: Сабота|Има друг предлог: [^.]*во 05:00/u.test(asks[1]), `never today or a bare literal 05:00: ${asks[1]}`);
});

// ── APPLIANCE-GRADE REPLAY of the saved TUI chat (([00:49]→[01:07], EB 47):
// the funnel is driven WITH the owner relay wired, so the merged intake is
// asserted where it actually lands — the FSM's owner-ask text — and every
// owner-facing line is checked against the transcript contract. The clock is
// pinned to Friday 23.10.2026 00:57 for the whole test, so понеделник always
// resolves to 26.10.2026 no matter when the suite runs. ──
function pinClock(at: Date): () => void {
  const RealDate = Date;
  class PinnedDate extends RealDate {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    constructor(...args: any[]) { super(...(args.length ? args : [at.getTime()])); }
    static now(): number { return at.getTime(); }
  }
  (globalThis as any).Date = PinnedDate;
  return () => { (globalThis as any).Date = RealDate; };
}

test('[00:49→01:07] EB 47 transcript replay: the wrong-day owner asks are impossible end-to-end', async () => {
  const unpin = pinClock(new Date(2026, 9, 23, 0, 57, 0));
  try {
    const { handler, sessions, sent, send } = await makeHandler();
    const asks: string[] = [];
    handler.onOwnerAsk = (_c, _e, q) => asks.push(q);

    // [00:49] the masculine EB-number frame: the availability ack must agree
    // with стан/деловен masculine, never the feminine bank pool (bug 1).
    await send('EVIDENTEN BROJ 47 DALI USTE E NA PRODAZBA?');
    const ack = sent[sent.length - 1];
    assert.ok(/достапен|продаден| евиденти|внесен/u.test(ack), `masculine ack required: ${ack}`);
    assert.ok(!/достапна|слободна|активна/u.test(ack), `feminine agreement must not leak: ${ack}`);
    await send('DA');
    await send('DA, SE SOGLASUVAM');
    await send('MARKO 070111222');

    // [00:52] day-only proposal → the exact-clock re-ask; [00:57] the
    // completing clock merges DAY-FIRST (bug 2, phase 1).
    const s1 = await send('VO PONEDENIK MOZAM POPLADNE');
    assert.equal(s1.state, 'visit_scheduling', `day-only proposal waits for the clock: ${s1.state}`);
    const s2 = await send('OKOLU 6');
    assert.equal(s2.state, 'owner_checking', `merged intake must reach the owner check: ${s2.state}`);
    assert.equal(s2.slots.visitTime, 'VO PONEDENIK MOZAM POPLADNE OKOLU 6', 'day-first merge order in the slot');
    assert.equal(asks.length, 1, `the owner must be asked exactly once: ${JSON.stringify(asks)}`);
    const MTERM = 'Понеделник, 26.10.2026 во 18:00';
    assert.ok(asks[0].includes(`Клиентот сака посета: ${MTERM}.`), `the owner must read the merged DATED term: ${asks[0]}`);
    assert.ok(asks[0].includes('Вашиот стан'), `typed ask for a стан: ${asks[0]}`);
    assert.ok(!/06:00|23\.10\.2026/u.test(asks[0]), `never today or the literal 06:00: ${asks[0]}`);

    // [01:04] the owner counters with the whole day (no clock) → the client
    // relay names the refused term and the OWNER'S day, and the slot is
    // re-seeded to that day-only token so the completion merges day-first.
    const v = detectOwnerVerdict('NE MOZAM TOGAS . PONEDELNIK BILO KOE VREME MI ODGOVARA', MTERM);
    assert.equal(v?.status, 'counter');
    assert.equal(v?.canAcceptWholeDay, true);
    handler.ownerAnswer('relay', 47, v!);
    await new Promise(r => setTimeout(r, 50));
    const s3 = sessions.get('relay')!;
    assert.equal(s3.state, 'visit_scheduling', `whole-day relay hands the clock back to the client: ${s3.state}`);
    assert.equal(s3.slots.visitTime, 'Понеделник', `slot must be the owner day only: ${JSON.stringify(s3.slots.visitTime)}`);
    assert.ok(!/VO 6|18:00/.test(s3.slots.visitTime ?? ''), `the rejected clock must not ride along: ${s3.slots.visitTime}`);
    assert.equal(
      sent[sent.length - 1],
      `Сопственикот не е во можност за посета во ${MTERM}. Има друг предлог: Понеделник, 26.10.2026 — било кое време му одговара. Во колку часот би сакале да дојдете?`,
    );

    // [01:06] the client completes the clock on the owner's day — the follow-up
    // owner ask must carry BOTH terms on Понеделник (bug 2, phase 2).
    const s4 = await send('MOZAM VO 5');
    assert.equal(s4.state, 'owner_checking', `the completion re-asks the owner: ${s4.state}`);
    assert.equal(s4.slots.visitTime, 'Понеделник MOZAM VO 5', 'day-first completion in the slot');
    assert.equal(asks.length, 2, `the follow-up owner ask must go out: ${JSON.stringify(asks)}`);
    // [01:07] contract, corrected: the client COMPLETED THE OWNER'S WHOLE-DAY
    // counter — an acceptance, never a refusal. The old wording asserted
    // «Клиентот не е во можност…» for a term the OWNER proposed; coordination
    // fact error (the [01:07] capture in data/tui.db, event 105).
    assert.equal(
      asks[1],
      `Клиентот го прифати Вашиот предлог: Понеделник — било кое време. Предлог за посета: Понеделник, 26.10.2026 во 17:00. Дали го потврдувате тој термин?`,
      `exact transcript contract: ${asks[1]}`,
    );

    // The owner accepts the completing term — the booking is Monday 17:00, the
    // NEVER the resurrected 18:00 from the rejected term.
    handler.ownerAnswer('relay', 47, { status: 'ok', ownerTime: MTERM.replace('18:00', '17:00') });
    await new Promise(r => setTimeout(r, 50));
    const s5 = sessions.get('relay')!;
    assert.equal(s5.state, 'pending', `acceptance confirms the visit: ${s5.state}`);
    const okRelay = sent[sent.length - 1];
    assert.ok(okRelay.includes('Понеделник, 26.10.2026 во 17:00'), `the confirmation must name the completing term: ${okRelay}`);
    assert.ok(!/Петок, 23\.10\.2026 во 05:00|во 06:00/u.test(okRelay + asks.join(' ')),
      `the transcript's wrong-day lines must be impossible: ${okRelay}`);
  } finally { unpin(); }
});

// ── The [01:07] #244 shape verbatim: «MOZAM VO 5 \ NAKOE MESTO BI SE CEKALE ?»
// rides BOTH an acceptance (the completed term) and the meeting-spot question.
// The owner ask reads acceptance; the client is answered with the
// location-reveal protocol (the spot is named on the visit day). ──
test('[01:07] acceptance + riding spot ask: reveal protocol to the client, acceptance to the owner', async () => {
  const { detectMeetingSpotAsk } = await import('../src/llm/deterministic');
  // Detector: the capture text, its family — and the parking/size senses excluded.
  assert.equal(detectMeetingSpotAsk('MOZAM VO 5\nNAKOE MESTO BI SE CEKALE ?'), true, 'capture text');
  assert.equal(detectMeetingSpotAsk('кое место ќе се чекаме'), true, 'cyrillic');
  assert.equal(detectMeetingSpotAsk('kade ke se cekame'), true, 'kade cekam');
  assert.equal(detectMeetingSpotAsk('dali ima mesto za parkiranje'), false, 'parking veto');
  assert.equal(detectMeetingSpotAsk('vo sreda vo 15:00'), false, 'a plain time is not a spot ask');

  const { handler, sessions, sent } = await makeHandler();
  const asks: string[] = [];
  handler.onOwnerAsk = (_c, _e, q) => asks.push(q);
  const send = async (m: string) => { await handler.handle('test', 'relay2', m); return sessions.get('relay2')!; };
  await reachOwnerChecking(send);

  // Owner counters with the whole day → open counter seeded on Понеделник.
  handler.ownerAnswer('relay2', 78, { status: 'counter', ownerTime: 'Понеделник', canAcceptWholeDay: true });
  await new Promise(r => setTimeout(r, 50));
  const before = asks.length;

  // The VERBATIM #244 message: acceptance + the spot question in one line.
  const s = await send('MOZAM VO 5\nNAKOE MESTO BI SE CEKALE ?');
  assert.equal(s.state, 'owner_checking');
  // Client-facing: the ACK carries the reveal-protocol answer — never silence.
  const reply = sent[sent.length - 1];
  assert.ok(reply.includes('Во ред, ќе Ве известам штом потврдам'), reply);
  // The reveal protocol is a VARIANT FAMILY (address.exact): the truthful-time
  // phrases alternate between "два часа пред", "денот на посетата", "денот на
  // закажаното гледање", "на самиот ден" and "непосредно пред" — any of them
  // proves the question was answered by the protocol (never silence, never an
  // invented spot).
  // Cyrillic-safe boundaries (ASCII \b never binds a Cyrillic letter, so the
  // old \bден/\bна/\bнепосредно forms could only match the single Latin-
  // adjacent variant — a random pickVariant roll then failed the test).
  assert.match(reply, / два часа пред |(?<![A-Za-z\u0400-\u04FF])ден(?:о)?(?:т)?\s*на\s*(?:посет|закажаното\s*гледање)|(?<![A-Za-z\u0400-\u04FF])на\s*самиот\s*ден|(?<![A-Za-z\u0400-\u04FF])непосредно\s*пред/u, `the spot question must be answered by the reveal protocol: ${reply}`);
  assert.ok(!/улица|број \d+\/\d/u.test(reply), `never an invented spot: ${reply}`);
  // Owner-facing: acceptance semantics, the owner reads his own day completed.
  assert.equal(asks.length, before + 1, `the acceptance ask must go out: ${JSON.stringify(asks)}`);
  const ask = asks[asks.length - 1];
  assert.match(ask, /прифати Вашиот предлог/u, `acceptance wording required: ${ask}`);
  assert.ok(!/не е во можност/u.test(ask), `never a fabricated refusal: ${ask}`);
  assert.match(ask, /Понеделник, \d{2}\.\d{2}\.\d{4} во 17:00/u, `the completed term carries the owner's day: ${ask}`);
});

// The guard: a client who COUNTERS the whole day with a DIFFERENT day keeps the
// refusal wording — an acceptance only when the completed term stays on the
// owner's seed day.
test('[01:07] guard: different-day completion after a whole-day counter is still a counter', async () => {
  const { handler, sessions } = await makeHandler();
  const asks: string[] = [];
  handler.onOwnerAsk = (_c, _e, q) => asks.push(q);
  const send = async (m: string) => { await handler.handle('test', 'relay3', m); return sessions.get('relay3')!; };
  await reachOwnerChecking(send);
  handler.ownerAnswer('relay3', 78, { status: 'counter', ownerTime: 'Понеделник', canAcceptWholeDay: true });
  await new Promise(r => setTimeout(r, 50));
  const before = asks.length;
  const s = await send('Dobrovo, VO SREDA VO 15:30');
  assert.equal(s.state, 'owner_checking', `the different-day answer still re-asks the owner: ${s.state}`);
  assert.equal(asks.length, before + 1, `a follow-up ask must go out: ${JSON.stringify(asks)}`);
  const ask = asks[asks.length - 1];
  assert.match(ask, /не е во можност за посета во .*\. Има друг предлог: .*Среда.*15:30\./u, `refusal wording for a counter of the counter: ${ask}`);
  assert.ok(!/прифати/u.test(ask), `the acceptance wording must not fire off-own-day: ${ask}`);
});

// THE OWNER IS A HUMAN TOO (the [09:57]/[10:02] burst).
//
// The owner had never met this agent, so before giving a term he checked the
// request: «TOA E DENES TAKA ?» and, after the re-ask, «DALI PRASUVATE ZA
// DENES ?». Both were parsed as counter-proposals («Денес»), the first was
// relayed to the client as «Сопственикот не е во можност за посета во Петок,
// 06.11.2026 во 17:00. Има друг предлог: Петок, 06.11.2026» — a refusal and a
// fictitious alternative the owner never gave — and the second was answered
// with «нема активна проверка за овој клиент».
test('[09:57] an owner QUESTION is answered to the owner and never relayed', async () => {
  const { handler, sessions, sent, send } = await makeHandler();
  await reachOwnerChecking(send);
  const s0 = sessions.get('relay')!;
  assert.equal(s0.state, 'owner_checking');
  const before = sent.length;

  // A bare day-word inside a QUESTION is not a counter-proposal.
  assert.equal(detectOwnerVerdict('TOA E DENES TAKA ?', s0.slots.visitTime ?? ''), undefined,
    'a question must never parse as a counter');
  assert.equal(detectOwnerVerdict('DALI PRASUVATE ZA DENES ?', s0.slots.visitTime ?? ''), undefined);
  // …while a real proposal still does, question mark and all.
  const proposal = detectOwnerVerdict('MOZE VO SABOTA ?', s0.slots.visitTime ?? '');
  assert.equal(proposal?.status, 'counter', `an offered day is still a counter: ${JSON.stringify(proposal)}`);

  for (const q of ['TOA E DENES TAKA ?', 'DALI PRASUVATE ZA DENES ?', 'DALI E SLOBODNA ?']) {
    const answer = handler.ownerQuestionReply('relay', q);
    assert.ok(answer, `the owner's question must be answered: ${q}`);
    assert.match(answer, /\?$/u, `and answered WITH a question back: ${answer}`);
    // It must speak the TERM actually asked for, not echo his day-word.
    assert.match(answer, /посета во /u, `the term must be named: ${answer}`);
    assert.match(answer, /Евидентен број 78/u, `the flat must be named: ${answer}`);
    assert.equal(sessions.get('relay')!.state, 'owner_checking', 'the pending check stays alive');
  }
  // A «is that today?» is answered by FACT: the asked term is tomorrow, so the
  // answer is a «no» that restates the real term (never «Да, за денес»).
  const today = handler.ownerQuestionReply('relay', 'TOA E DENES TAKA ?')!;
  assert.match(today, /Не, не е за денес/u, today);
  // THE CLIENT HEARS NOTHING until the owner gives a term or declines.
  assert.equal(sent.length, before, `no relay during owner questions: ${JSON.stringify(sent.slice(before))}`);

  // A PROPOSAL is never swallowed by the question lane.
  assert.equal(handler.ownerQuestionReply('relay', 'MOZE VO SABOTA ?'), undefined,
    'a proposing question belongs to the verdict seam');

  // The pending check is still the one the owner answers.
  handler.ownerAnswer('relay', 78, { status: 'ok', ownerTime: 'Сабота, 07.11.2026 во 18:00' });
  await new Promise(r => setTimeout(r, 50));
  assert.ok(sent.length > before, 'the real verdict still reaches the client');
});

// THE AVAILABILITY HALF IS NOT THE TERM HALF (the [23:41] capture).
// «DOSTAPNA E DA» answers only «дали е достапна…»; read as a full «ok» it
// booked the client into «Договорена посета … Вторник 10.11.2026 во 17:30»
// and fired the Turn-0 address confirmation — for a term the owner never
// agreed to. THE CHAT WITH THE OWNER IS NOT FINISHED UNTIL A TIME AND DATE
// ARE DEFINED, so the partial answer is answered (ack + term question) and
// nothing reaches the client.
test('[23:41] an availability answer is answered, never taken for the term', async () => {
  const { handler, sessions, sent, send } = await makeHandler();
  await reachOwnerChecking(send);
  const s0 = sessions.get('relay')!;
  const proposed = s0.slots.visitTime ?? '';
  assert.ok(proposed, 'setup must leave a proposed term on the table');
  const before = sent.length;

  // The field text — and every masculine/feminine spelling of it.
  for (const avail of ['DOSTAPNA E DA', 'DA DOSTAPNA E', 'DOSTAPEN E', 'DA, SLOBODNA E', 'STANOT E SLOBODEN']) {
    assert.equal(isOwnerAvailabilityOnly(avail), true, `availability-only: ${avail}`);
    assert.equal(detectOwnerVerdict(avail, proposed), undefined,
      `availability must never resolve the owner check: ${avail}`);
  }
  // A message that ALSO answers the term is a verdict, not an availability report.
  for (const full of ['DA', 'OK', 'MOZE', 'DA, SE SOGLASUVAM', 'DOSTAPNA E, SE SOGLASUVAM']) {
    assert.equal(detectOwnerVerdict(full, proposed)?.status, 'ok', `term consent still closes: ${full}`);
  }

  // The owner's channel: availability ack + ONLY the term question.
  // The ack is a POOL, so the assertions are CONTRACT-level (a wording pin
  // would fail on the next variant the picker serves). A term IS on the table
  // here (the setup proposed one), so the term pool answers.
  const answer = handler.ownerQuestionReply('relay', 'DOSTAPNA E DA');
  assert.ok(answer, 'the owner must be answered');
  assert.equal(matchesPoolContract('owner.availability.ack.term', answer), true, `the ack contract: ${answer}`);
  assert.doesNotMatch(answer!, /(?<!\p{L})(?:достапен|слободен)(?!\p{L})/iu, `never the masculine form: ${answer}`);
  assert.match(answer!, /Евидентен број 78/u, `the flat is named: ${answer}`);
  assert.ok(answer!.trim().endsWith('?'), `and it ends on the ask: ${answer}`);

  // THE DEAL IS NOT CLOSED: no client message, no agent, still owner_checking.
  assert.equal(sent.length, before, `the client hears nothing: ${JSON.stringify(sent.slice(before))}`);
  const s1 = sessions.get('relay')!;
  assert.equal(s1.state, 'owner_checking', `the check stays open, got ${s1.state}`);
  assert.equal(s1.slots.agentPhone, undefined, 'no agent is assigned before the term is defined');

  // …and the term answer still closes it in one step (the funnel is not stuck).
  handler.ownerAnswer('relay', 78, { status: 'ok', ownerTime: proposed });
  await new Promise(r => setTimeout(r, 50));
  assert.ok(sent.length > before, 'the confirmed term reaches the client');
  assert.match(sent[sent.length - 1], /Договорена посета/u, sent[sent.length - 1]);
  assert.equal(sessions.get('relay')!.slots.agentPhone !== undefined, true, 'the agent is assigned at the close');

  // THE ACK COPY ITSELF: bank-served from TWO pools, so the assertions are
  // CONTRACT-level (the repo rule: never "the sentence I saw last week" — the
  // variants rotate). Each pool's contract lives in responseBank.ts and pins
  // the one meaning a variant may never lose: availability confirmed, the term
  // still the open question, the reply ending on the ask.
  const noTerm = buildOwnerAvailabilityAck(54);
  assert.equal(matchesPoolContract('owner.availability.ack.noterm', noTerm), true, noTerm);
  assert.match(noTerm, /недвижноста \(Евидентен број 54\)/u, `the flat is named: ${noTerm}`);
  assert.ok(noTerm.trim().endsWith('?'), `and it ends on the ask: ${noTerm}`);
  // …the feminine subject holds in EVERY variant ({prop} aside): «достапен»
  // reading as «недвижноста е достапен» is the [23:40] class of defect.
  for (const v of FIXED_SEEDS['owner.availability.ack.noterm']) {
    assert.doesNotMatch(v, /(?<!\p{L})(?:достапен|слободен)(?!\p{L})/iu, `masculine predicate: ${v}`);
  }
  // A TERM ON THE TABLE → the term pool, with the RENDERED term as data.
  const withTerm = buildOwnerAvailabilityAck(54, 'вторник 5 ипол');
  assert.equal(matchesPoolContract('owner.availability.ack.term', withTerm), true, withTerm);
  assert.match(withTerm, /Вторник/u, `the term is rendered, not echoed: ${withTerm}`);
  assert.ok(withTerm.trim().endsWith('?'), withTerm);
  for (const v of FIXED_SEEDS['owner.availability.ack.term']) {
    assert.doesNotMatch(v, /(?<!\p{L})(?:достапен|слободен)(?!\p{L})/iu, `masculine predicate: ${v}`);
  }
});

// CONSENT MUST NAME ITS OBJECT (the [23:41] rule at the VERDICT level). A bare
// `ok` used to be read as "agrees to the term" and the handler then adopted the
// CLIENT's proposal on its own — the exact ambiguity that made a lenient parser
// book a visit the owner never agreed to. Rules: a bare `ok` is the
// AVAILABILITY lane (confirm, keep asking, book nothing); the operator shortcut
// `/owner <eb> ok` stamps the term it means, so it still closes in one step.
test('[23:41] a bare ok is availability only; the /owner ok shortcut names the term', async () => {
  const { handler, sessions, sent, send } = await makeHandler();
  await reachOwnerChecking(send);
  assert.ok(sessions.get('relay')!.slots.visitTime, 'setup leaves a proposed term');
  const before = sent.length;

  // (1) A producer that names no term — the ambiguous shape.
  handler.ownerAnswer('relay', 78, { status: 'ok' });
  await new Promise(r => setTimeout(r, 60));
  assert.equal(sessions.get('relay')!.state, 'owner_checking', 'no booking without a term');
  assert.equal(sent.length, before, `the client hears nothing: ${JSON.stringify(sent.slice(before))}`);

  // (2) The operator shortcut means "yes to the term you asked him about".
  const agent = handler.ownerAgent as unknown as {
    simulate?: (c: string, e: number, a: 'ok') => boolean;
  };
  assert.equal(agent.simulate?.('relay', 78, 'ok'), true, 'the shortcut still applies');
  await new Promise(r => setTimeout(r, 60));
  assert.equal(sessions.get('relay')!.state, 'pending', 'the stamped term closes the deal');
  assert.ok(sent.length > before, 'the confirmed term reaches the client');
  assert.match(sent[sent.length - 1], /Договорена посета/u, sent[sent.length - 1]);
});

// THE OWNER PANE ROTATES (the reason the ack is a POOL and not one string).
// The owner is ONE human who re-reads this pane at every viewing: serving him
// the same sentence each time reads as a script. The ack is picked against the
// OWNER pane's lines — never the client's history — so four availability
// answers in a row use four different variants.
test('[23:41] the owner hears a different availability ack each time', async () => {
  const { handler, send } = await makeHandler();
  await reachOwnerChecking(send);
  const seen: string[] = [];
  for (let i = 0; i < 4; i++) {
    const ack = handler.ownerQuestionReply('relay', 'DOSTAPNA E DA');
    assert.ok(ack, `the owner is answered every time (#${i})`);
    seen.push(ack!);
  }
  assert.equal(new Set(seen).size, seen.length,
    `the same ack repeated inside one pane: ${JSON.stringify(seen)}`);
  for (const a of seen) {
    assert.equal(matchesPoolContract('owner.availability.ack.term', a), true, a);
    assert.match(a, /Евидентен број 78/u, a);
  }
});

// THE NEGATED AVAILABILITY IS A REFUSAL (the same family, swept): the agreement
// predicate matches the bare word inside «NE E DOSTAPNA», so the visit used to
// be LOCKED on a refusal — the deal closed on the exact opposite answer.
test('[09:57 sibling] a negated availability never agrees and never locks a visit', async () => {
  const { handler, sessions, sent, send } = await makeHandler();
  await reachOwnerChecking(send);
  const proposed = sessions.get('relay')!.slots.visitTime ?? '';
  const before = sent.length;

  for (const no of ['NE E DOSTAPNA', 'ne e dostapna', 'NE E SLOBODNA']) {
    const v = detectOwnerVerdict(no, proposed);
    assert.ok(v, `the refusal must parse: ${no}`);
    assert.notEqual(v!.status, 'ok', `a refusal is never «ok»: ${no} → ${JSON.stringify(v)}`);
    assert.equal(v!.ownerTime, undefined, `no term is accepted from a refusal: ${no}`);
  }

  handler.ownerAnswer('relay', 78, detectOwnerVerdict('NE E DOSTAPNA', proposed)!);
  await new Promise(r => setTimeout(r, 50));
  const s = sessions.get('relay')!;
  assert.notEqual(s.state, 'pending', `a refusal must not close the deal, got ${s.state}`);
  assert.equal(s.slots.agentPhone, undefined, 'no agent is assigned on a refusal');
  // EXPECTATION UPDATED (the [00:11] rule): a bare refusal no longer re-asks
  // the CLIENT — the OWNER is asked for a term of his own and the client hears
  // the holding line (no question). The invariant that matters here is intact:
  // nothing is booked and no term is accepted from a refusal.
  assert.match(sent[sent.length - 1], /Ќе го прашам/iu,
    `the client hears that the owner is being asked: ${sent[sent.length - 1]}`);
  assert.ok(!/термин би Ви одговарал/iu.test(sent[sent.length - 1] ?? ''),
    `never the old client-side re-ask: ${sent[sent.length - 1]}`);
  assert.ok(!/Договорена посета/u.test(sent.slice(before).join('\n')), 'never a booked visit on a refusal');
});

// THE OWNER'S GREETING IS ANSWERED, NOT CALLED «НЕ РАЗБРАВ» (the [23:40]
// capture). A stranger being contacted by an agent opens with «ZDRAVO» — the
// pending-check seam had no arm for a courtesy, so it fell to
// `buildOwnerAskAgain`, which answered «Не разбрав. Евидентен број 54 — дали
// недвижноста е достапен…»: a rebuff for saying hello, and a masculine
// adjective on a feminine noun. Both are pinned here.
test('[23:40] the owner\'s greeting is greeted back and the ask repeated — never «Не разбрав», and the noun agrees', async () => {
  const { handler, sessions, sent, send } = await makeHandler();
  await reachOwnerChecking(send);
  const before = sent.length;

  for (const hello of ['ZDRAVO', 'Zdravo!', 'DOBAR DEN', 'DOBRO VECER', 'Добро вечер', 'POZDRAV']) {
    const answer = handler.ownerQuestionReply('relay', hello);
    assert.ok(answer, `the owner's greeting must be answered: ${hello}`);
    assert.doesNotMatch(answer!, /Не разбрав/u, `never «Не разбрав» for a greeting (${hello}): ${answer}`);
    assert.match(answer!, /Здраво|Добар ден|Добро вечер|Поздрав/u, `it greets him back (${hello}): ${answer}`);
    assert.match(answer!, /посета во /u, `then repeats the ask (${hello}): ${answer}`);
    assert.match(answer!, /Евидентен број 78/u, `naming the flat (${hello}): ${answer}`);
  }
  assert.equal(sessions.get('relay')!.state, 'owner_checking', 'the pending check stays alive');
  assert.equal(sent.length, before, `the client hears nothing: ${JSON.stringify(sent.slice(before))}`);

  // A greeting that PROPOSES is still a verdict, and an unclear message still
  // gets the re-ask (the copy is the same function).
  assert.equal(handler.ownerQuestionReply('relay', 'ZDRAVO, MOZE VO SABOTA ?'), undefined,
    'a greeting that carries a proposal belongs to the verdict seam');
  assert.equal(handler.ownerQuestionReply('relay', 'GFHFGH'), undefined,
    'gibberish is not a greeting — the seam keeps its own fallback');

  // GRAMMAR: the re-ask's subject is «недвижноста» (feminine); the old
  // masculine default produced «недвижноста е достапен».
  const reAsk = buildOwnerAskAgain(54);
  assert.match(reAsk, /недвижноста е достапна/u, `feminine agreement: ${reAsk}`);
  assert.doesNotMatch(reAsk, /недвижноста е достапен(?![а-ш])/u, reAsk);
  // …while a caller that brings its own definite noun keeps its own adjective.
  assert.match(buildOwnerAskAgain(54, { eb: 54, proposedTime: '', propertyTypeDef: 'куќата', dostapen: 'достапна' }), /куќата е достапна/u);
  assert.match(buildOwnerAskAgain(54, { eb: 54, proposedTime: '', propertyTypeDef: 'плацот', dostapen: 'достапен' }), /плацот е достапен/u);
});
