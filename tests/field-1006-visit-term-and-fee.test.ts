// THE [10:0x] CLIENT BATCH — the visit term must be a TERM, and the fee must
// be quotable per visit.
//
//   [10:06] NE MOZAM VO VTORNIK          → a REFUSAL, not a proposal
//   [10:06] CEL DEN SUM NA RABOTA        → «I am at work all day», a busy REASON
//   ЛИНА → OWNER: «Клиентот не е во можност … Има друг предлог: Цел ден сум на
//           работа. Дали би Ви одговарал тој термин?»
//
// Two defects met: «RABOTA» is edit-distance 1 from «SABOTA», so the busy reason
// read as a Saturday proposal; and the owner relay accepted ANY sentence as the
// client's counter. The owner's standing rule, now the contract:
//
//   A VISIT TERM IS A DAY **AND** A TIME. If either is missing, Lina asks the
//   CLIENT for the missing half — she never hands something undefined to the
//   owner or the client.
//
// The same seam owns the sibling from the [09:58] capture: «MOZAM VO PONEDELNIK»
// after «КОГА МОЖЕ ДА СЕ ПОСЕТИ?» must complete the term (ask the HOUR on that
// day), never fall out of the lane into a landmark search.
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
import { detectVisitTime, detectVisitTime as dv } from '../src/llm/deterministic';
import { isCompleteVisitTerm, missingTermPiece } from '../src/visits/time';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import path from 'path';
import os from 'os';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 66, id: 66, location: 'Центар', price: 137000, service: 'buy', sqm: 79, size: '79 м²',
    address: 'Партизански одреди 12', bedrooms: 3, lat: 41.9955, lon: 21.4310, geo_source: 'stored' } as Property,
  { eb: 95, id: 95, location: 'Центар', price: 204000, service: 'buy', sqm: 74, size: '74 м²',
    address: 'Македонија 8', bedrooms: 3, lat: 41.9960, lon: 21.4320, geo_source: 'stored' } as Property,
];

function makeHandler(chat: string) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  const ownerAsks: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(llm, cfg, properties),
    responder: new Responder(llm, cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: undefined,
  } as never);
  handler.onOwnerAsk = (_c: string, _eb: number, q: string) => { ownerAsks.push(q); };
  const send = async (m: string) => { await handler.handle('test', chat, m); return sessions.get(chat)!; };
  return { handler, sessions, sent, ownerAsks, send };
}

/** Drive a chat to the point where the client's term goes to the owner. */
async function reachTermAsk(send: (m: string) => Promise<unknown>, ownerAsks: string[]) {
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 66');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA');
  await send('DA, SE SOGLASUVAM');
  await send('ZORAN 078/914 196');
  const before = ownerAsks.length;
  await send('MOZAM DA DOJDAM');
  return ownerAsks.length > before;
}

test('[10:06] «CEL DEN SUM NA RABOTA» is a busy REASON, never a visit term', () => {
  // The false friend: RABOTA is one letter from SABOTA.
  assert.equal(detectVisitTime('CEL DEN SUM NA RABOTA'), undefined);
  assert.equal(dv('NA RABOTA SUM CEL DEN'), undefined);
  assert.equal(dv('rabotam cel den'), undefined);
  // …and the real Saturday still parses, in both scripts, typos included.
  assert.ok(detectVisitTime('SABOTA VO 12'));
  assert.ok(detectVisitTime('сабота во 12'));
  assert.ok(detectVisitTime('sabta vo 12'), 'the typo SABTA is still a day');
});

test('[10:06] a REFUSAL is not the client’s own proposal', () => {
  assert.equal(detectVisitTime('NE MOZAM VO VTORNIK'), undefined);
  assert.equal(detectVisitTime('NE MI ODGOVARA PETOK VO 5'), undefined);
  // THE [04:05] SIBLING still works: a refusal + a proposal names the proposal.
  assert.ok(detectVisitTime('NE MI ODGOVARA PETOK VOOPSTO. DA OSTAVIME ZA PONEDNIK VO 6 MOZE?'));
});

test('a term needs BOTH a day and a clock — the gap is named', () => {
  assert.equal(isCompleteVisitTerm('VTORNIK VO 18'), true);
  assert.equal(isCompleteVisitTerm('утре во 5'), true);
  assert.equal(isCompleteVisitTerm('MOZAM VO PONEDELNIK'), false);
  assert.equal(missingTermPiece('MOZAM VO PONEDELNIK'), 'time');
  assert.equal(isCompleteVisitTerm('VO 18'), false);
  assert.equal(missingTermPiece('VO 18'), 'day');
  assert.equal(missingTermPiece('CEL DEN SUM NA RABOTA'), 'both');
});

test('[10:06] the owner is never handed a busy reason as «друг предлог»', async () => {
  const { sent, ownerAsks, send, sessions } = makeHandler('term-1006');
  await reachTermAsk(send, ownerAsks);
  const afterFirst = ownerAsks.length;
  // The client refuses the owner's term, then explains WHY he cannot come.
  await send('NE MOZAM VO VTORNIK');
  await send('CEL DEN SUM NA RABOTA');
  const ownerText = ownerAsks.slice(afterFirst).join('\n');
  assert.ok(!/на работа|rabota|RABOTA/iu.test(ownerText),
    `the owner must never read the busy reason as a term: ${ownerText}`);
  // …and every owner line is a COMPLETE term (a day and a clock).
  for (const line of ownerAsks.slice(afterFirst)) {
    const m = line.match(/(?:Предлог|Клиентот сака посета):\s*(.+?)\.\s/iu);
    if (m) assert.equal(isCompleteVisitTerm(m[1]), true, `incomplete term relayed: ${line}`);
  }
  const session = sessions.get('term-1006')!;
  assert.equal(session.state, 'visit_scheduling',
    'no check is opened for a reason — the client is asked for a real term');
  const last = sent[sent.length - 1] ?? '';
  assert.match(last, /(?:ден|часот|термин)/iu, `the client is asked for the missing half: ${last}`);
});

test('[10:01] the remembered price is a characteristic — a 99.000 flat is not «the one he described»', async () => {
  const dbPath = path.join(os.tmpdir(), `price-band-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeMap(dbPath, [
    { name: 'Црногорска Амбасада', type: 'embassy', lat: 41.9959869, lon: 21.418169, source: 'osm' },
  ], []);
  const map = new OfflineMapStore(dbPath);
  const rows: Property[] = [
    { eb: 63, id: 63, location: 'Центар', price: 36000, service: 'buy', studio: true, sqm: 28, size: '28 м²',
      address: 'Црногорска Амбасада', lat: 41.9960, lon: 21.4182, geo_source: 'stored' } as Property,
    { eb: 51, id: 51, location: 'Водно', price: 99000, service: 'buy', bedrooms: 3, sqm: 71, size: '71 м²',
      address: 'Водно', lat: 41.9800, lon: 21.4000, geo_source: 'stored' } as Property,
  ];
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(rows);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, google: false, offlineMap: map }),
  } as never);
  // The capture's own content: «small, about 30.000, it said near the
  // Montenegrin embassy» — cold, exactly like the [18:41] landmark pin.
  await handler.handle('test', 'band-1001', 'IMAVTE EDNA GARSONJERA KAJ CRNOGORSKA AMBASADA OKOLU 30 000 BESE');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /63/u, `the гapсоњера at the remembered money is served: ${answer}`);
  assert.ok(!/99\.000|Евидентен број 51|Водно/u.test(answer),
    `a 99.000 flat is NOT "what he described" for «околу 30 000»: ${answer}`);
  map.close();
});

test('[10:03] «KOLKU BI PLATIL ZA DA VIDAM DVA STANA?» gets the TOTAL — 500 each, 1.000', async () => {
  const { sent, send, sessions } = makeHandler('fee-1003');
  // An agreed fee must not silence the arithmetic: the total was never stated.
  await reachTermAsk(send, []);
  await send('DA, SE SOGLASUVAM');
  const rungsBefore = sessions.get('fee-1003')!.slots.feeRejections ?? 0;
  await send('KOLKU BI PLATIL ZA DA VIDAM DVA STANA NA PRIMER ?');
  const last = sent[sent.length - 1] ?? '';
  const session = sessions.get('fee-1003')!;
  assert.match(last, /1\.000|1000/u, `the total for two is given: ${last}`);
  assert.match(last, /500/u, `the per-visit figure is named: ${last}`);
  assert.equal(session.slots.feeRejections ?? 0, rungsBefore,
    'arithmetic is not resistance — no rung burns');
  assert.ok(!/правило на Агенцијата|ценовник на Агенцијата/iu.test(last),
    `never the agency-rules copy for a how-much question: ${last}`);
  assert.equal(session.slots.service, 'buy', 'the declared market is quoted alone');
});

test('[10:03] the count question burns no rung even mid-ladder', async () => {
  const { sent, send, sessions } = makeHandler('fee-1003b');
  await reachTermAsk(send, []);
  const before = sessions.get('fee-1003b')!.slots.feeRejections ?? 0;
  await send('KOLKU BI PLATIL ZA DA VIDAM DVA STANA NA PRIMER ?');
  const session = sessions.get('fee-1003b')!;
  assert.ok((session.slots.feeRejections ?? 0) <= before,
    'a how-much-for-two question never climbs the ladder');
  assert.match(sent[sent.length - 1] ?? '', /1\.000|1000/u,
    `the total is the answer: ${sent[sent.length - 1]}`);
});

test('[09:58] «MOZAM VO PONEDELNIK» completes the term — it is not a search', async () => {
  const { sent, ownerAsks, send } = makeHandler('term-0958');
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 66');
  await send('KOGA MOZE DA SE POSETI ?');
  const before = ownerAsks.length;
  await send('MOZAM VO PONEDELNIK');
  const last = sent[sent.length - 1] ?? '';
  // THE [09:58] NONSENSE: a day answer was answered with a landmark search
  // («…во близина на СЈО… Еве ги најблиските недвижности»).
  assert.ok(!/СЈО|најблиските недвижности|баравте/iu.test(last),
    `a day is a term, never a landmark search: ${last}`);
  assert.equal(ownerAsks.length, before, 'a day without a clock never reaches the owner');
  assert.match(last, /\?/u, `the turn asks something: ${last}`);
});

test('[10:06] a DAY-ONLY answer mid-check asks the clock — never the owner', async () => {
  const { sent, ownerAsks, send, sessions } = makeHandler('term-day-only');
  await reachTermAsk(send, ownerAsks);
  await send('VTORNIK VO 18');
  const before = ownerAsks.length;
  await send('MOZAM VO PONEDELNIK');
  const last = sent[sent.length - 1] ?? '';
  assert.equal(ownerAsks.length, before, `the owner is not asked about a bare day: ${last}`);
  assert.match(last, /час/iu, `the missing CLOCK is the question: ${last}`);
  assert.equal(sessions.get('term-day-only')!.state, 'visit_scheduling');
});

// ── DEFECT 4 (the [10:06] protocol, owner-dictated) ─────────────────────────
// «VI CESTITAM NA IZBOROT … FEE VISIT EXPLANATION» — when the client COMMITS
// («го избрав станот 63», «се одлучив за станот», «тој е мојот избор») the turn
// is the congratulation AND the visit-fee explanation, together. Before the
// fix the words matched no detector at all: the choice fell through the funnel
// and was answered with a criteria question, so the client who had just
// decided was asked what bedrooms he wants.
test('[10:06] the client\'s CHOICE earns the congratulation and the visit-fee explanation', async () => {
  for (const [chat, words] of [
    ['choice-latin', 'GO IZBRAV STANOT SO EB 66'],
    ['choice-decided', 'SE ODLUCIV ZA STANOT 66'],
    ['choice-noun', 'TOJ E MOJOT IZBOR'],
  ] as const) {
    const { sent, send, sessions } = makeHandler(chat);
    await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 66');
    await send(words);
    const last = sent[sent.length - 1] ?? '';
    // The protocol opens with the congratulation…
    assert.match(last, /честит/iu, `the choice is congratulated: ${last}`);
    // …then explains the visit fee (buy: 500 ден / 10 €, 0% commission).
    assert.match(last, /500\s*денари|10\s*евра/iu, `the visit fee is explained: ${last}`);
    assert.match(last, /0\s*%|провизи/iu, `the 0% commission rides the explanation: ${last}`);
    assert.match(last, /\?/u, `the turn ends asking for consent: ${last}`);
    assert.doesNotMatch(last, /спални соби|квадрати|која населба/iu,
      `never a criteria question over the chosen flat: ${last}`);
    // The decision anchors the funnel and burns no fee rung.
    const s = sessions.get(chat)!;
    assert.equal(s.state, 'closing', `the choice opens the closing funnel: ${s.state}`);
    assert.equal(s.slots.interestedPropertyId, 66, 'the chosen flat is the subject');
    assert.ok((s.slots.feeRejections ?? 0) === 0, 'a disclosure is never resistance');
    assert.notEqual(s.slots.viewingFeeAgreed, true,
      'the disclosure turn is never consent (AGENTS §2)');
  }
});

test('[10:06] a NEGATED or undecided choice is never congratulated', async () => {
  const { sent, send, sessions } = makeHandler('choice-negated');
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 66');
  for (const words of [
    'NE IZBRAV NISTO USHTE',      // negated
    'USTE NE SUM ODLUCIL',        // undecided (a different form, no signal)
    'DALI DA GO ZEMAM ?',         // a question about choosing
    'KAKO DA JA IZBERAM',         // asking for advice
  ]) {
    await send(words);
    const last = sent[sent.length - 1] ?? '';
    assert.doesNotMatch(last, /честит/iu,
      `an undecided client is not congratulated (${words}): ${last}`);
    assert.notEqual(sessions.get('choice-negated')!.slots.viewingFeeAgreed, true);
  }
});
