// THE [07:06] CAPTURE — the client asked about the flat he was looking at and
// said what he wanted next; Lina answered about a DIFFERENT flat and dropped
// the visit.
//
//   [07:06] КЛИЕНТ: ИМАВТЕ ЕДНА ГАРСОЊЕРА КАЈ ЦРНОГОРСКА АМБАДА
//   [07:06] КЛИЕНТ: ДАЛИ УШТЕ СЕ ПРОДАВА ТОА ?
//   [07:06] ЛИНА: Евидентен број 63 · гарсоњера, 28 м² · 36.000 евра · Центар
//                  «Би требало да е сеуште достапна. …ќе ја потврдиме точната цена?»
//   [07:06] КЛИЕНТ: ПРОВЕРИ ДАЛИ ЈА ИМА УШТЕ , И АКО Е ДОСТАПНА БИ САКАЛ ДА ЈА ПОСЕТАМ
//   [07:06] ЛИНА: Евидентен број 47 · двособен стан, 59 м² · 150.500 евра · Центар
//                  «Би требало да е сеуште достапен. …моменталната достапност и цената?»
//
// Three defects, all in the availability lane:
//   1. THE LAST SHOWN IS THE LAST PRESENTED (AGENTS §4b). The client was looking
//      at the single EB 63 card; the branch took its target from
//      `currentBatch`'s tail, i.e. the ring's FEED order, and named EB 47 — a
//      flat from a different place. `presentedIds` is appended as each card goes
//      out, so its tail is the flat on his screen.
//   2. CHECK-THEN-ARRANGE (the [04:28] family). «…И АКО Е ДОСТАПНА БИ САКАЛ ДА
//      ЈА ПОСЕТАМ» carries the check AND the arrange half, but the proceed
//      grammar knew only «па ќе се договориме» / «ќе закажиме» — a wish phrased
//      as «би сакал» read as neither. The branch answered the availability ack
//      alone (whose own tail asks «Дали сакате да го исконтактирам
//      сопственикот?» — the very consent he had just given) and the visit never
//      started: no fee, no contact.
//   3. THE NEGATED ARRANGE. «не би ја посетил» — the contracted refusal carries
//      TWO clitics and the negation guard allowed one, so a refusal could be
//      read as the arrange half. Fixed for detectVisitRequest too.
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
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';
import {
  detectAvailabilityAsk, detectProceedAfterCheck, detectArrangeClause,
  detectVisitRequest,
} from '../src/llm/deterministic';
import { AVAILABILITY_CLAIM } from './helpers/availability-contract';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// The flat he is looking at: the [07:06] карта verbatim.
const GARSONJERA_63: Property = {
  eb: 63, id: 63, location: 'Центар', price: 36000, service: 'buy', sqm: 28, size: '28 м²',
  studio: true, lat: 41.9952, lon: 21.4179,
  details: 'Гарсоњера во Центар, греење на струја.',
} as Property;
// The flat the old precedence answered with: the tail of the FEED order.
const DVOSOBEN_47: Property = {
  eb: 47, id: 47, location: 'Центар', price: 150500, service: 'buy', sqm: 59, size: '59 м²',
  bedrooms: 2, lat: 41.9985, lon: 21.4231,
  details: 'Двособен стан во Центар.',
} as Property;
const DVOSOBEN_54: Property = {
  eb: 54, id: 54, location: 'Карпош III', price: 69500, service: 'buy', sqm: 35, size: '35 м²',
  bedrooms: 2, lat: 42.0041, lon: 21.4040,
  details: 'Двособен стан во Карпош III.',
} as Property;

const ROWS = [GARSONJERA_63, DVOSOBEN_47, DVOSOBEN_54];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(p => p.id === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(p => p.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string) {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId: id, sent };
}

/** The [07:06] state verbatim: EB 63 was the only card that went out, while the
 *  ring's batch still holds its FEED order (54, 47) — the tail is EB 47. */
function stateSeen63(id: string, sessions: SessionStore) {
  const s = freshSession('test', id);
  s.state = 'closing';
  s.slots.service = 'buy';
  s.slots.propertyId = 63;
  s.slots.interestedPropertyId = 63;
  s.slots.currentBatch = [54, 47];
  s.slots.presentedIds = [54, 47, 63];
  sessions.set(s);
}

const FIELD_TURN = 'ПРОВЕРИ ДАЛИ ЈА ИМА УШТЕ , И АКО Е ДОСТАПНА БИ САКАЛ ДА ЈА ПОСЕТАМ';

// ── 1. the detectors ────────────────────────────────────────────────────────

test('[07:06] the check-then-arrange grammar reads the conditional visit, in both scripts', () => {
  assert.equal(detectAvailabilityAsk(FIELD_TURN), true, 'the CHECK half is an availability ask');
  assert.equal(detectProceedAfterCheck(FIELD_TURN), true);
  assert.equal(detectProceedAfterCheck('PROVERI DALI JA IMA USTE, I AKO E DOSTAPNA BI SAKAL DA JA POSETAM'), true);
  // …and the plain check stays a plain question: asking is never consenting.
  for (const text of [
    'ДАЛИ Е СЕУШТЕ ДОСТАПЕН?', 'DALI E USTE DOSTAPEN ?',
    'ПРОВЕРИ ДАЛИ ЈА ИМА УШТЕ', 'Дали уште се продава?',
    'ПРОВЕРИ ДАЛИ Е ДОСТАПНА И ДАЈ МИ ГО БРОЈОТ',
  ]) assert.equal(detectProceedAfterCheck(text), false, `a check alone is not consent: ${text}`);
  // The [04:28] shapes keep working.
  assert.equal(detectProceedAfterCheck('AJDE PROVERI DALI SE PRODAVA USTE PA KE SE DOGOVORIME'), true);
});

test('[07:06] a NEGATED visit is never the arrange half — two clitics or one', () => {
  for (const text of [
    'НЕ БИ ЈА ПОСЕТИЛ', 'ne bi ja posetil', 'НЕ ГО ПОСЕТАМ', 'НЕ САКАМ ДА ЈА ВИДАМ', 'не посетам',
  ]) {
    assert.equal(detectArrangeClause(text), false, `a refusal is not an arrange: ${text}`);
    assert.equal(detectProceedAfterCheck(`ПРОВЕРИ ДАЛИ Е ДОСТАПНА, ${text}`), false, text);
    // …and the sibling it shares the guard with, so the two can never drift.
    assert.equal(detectVisitRequest(text), false, text);
  }
  // A «не» that OPENS the sentence is not a negation of the wish after it.
  assert.equal(detectArrangeClause('не, би сакал да го посетам'), true);
});

// ── 2. the answer, through the real handler ─────────────────────────────────

test('[07:06] the availability answer names the LAST PRESENTED flat, never the batch tail', async () => {
  const { say, sessions, chatId } = makeHandler('avail-last-presented');
  stateSeen63(chatId, sessions);
  const answer = await say(FIELD_TURN);
  // Bank ack variants rotate — the CONTRACT is an availability statement, never
  // one wording (the same rule capture-2226's ack assertion follows).
  assert.ok(AVAILABILITY_CLAIM.test(answer), `the availability ack is owed: ${answer}`);
  assert.doesNotMatch(answer, /Евидентен број 47/u, `EB 47 is the batch tail, not his flat: ${answer}`);
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.interestedPropertyId, 63, `EB 63 is the flat on his screen: ${s.slots.interestedPropertyId}`);
  assert.equal(s.slots.propertyId, 63, 'the discussion anchor does not move to another flat');
});

test('[07:06] «…И АКО Е ДОСТАПНА БИ САКАЛ ДА ЈА ПОСЕТАМ» starts the visit, fee included', async () => {
  const { say, sessions, chatId } = makeHandler('avail-then-visit');
  stateSeen63(chatId, sessions);
  const answer = await say(FIELD_TURN);
  // The fee is the sanctioned figure for a BUY visit (500 ден) — the copy
  // contract, not one bank wording (the euro aside rotates with the variant).
  assert.match(answer, /500\s*денари/u, `the visit fee is disclosed on the same turn: ${answer}`);
  // The bank rotates the wording, so the contract is the sanctioned figure + a
  // closing question (AGENTS §2), never one sentence I happened to see.
  assert.ok(/\?\s*$/u.test(answer.trimEnd()), `the fee is asked, not just stated: ${answer}`);
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.feeDisclosed, true, 'the disclosure is remembered so the next «да» is the agreement');
  assert.equal(s.slots.viewingFeeAgreed, undefined, 'a request is not the agreement');
  assert.equal(s.state, 'closing');
  // The consent question he already answered must not be asked again.
  assert.doesNotMatch(answer, /Дали сакате да го исконтактирам/iu,
    `the «shall I contact the owner?» re-ask is the defect: ${answer}`);
});

test('[07:06] a plain availability question still discloses NOTHING', async () => {
  const { say, sessions, chatId } = makeHandler('avail-plain');
  stateSeen63(chatId, sessions);
  const answer = await say('ДАЛИ Е СЕУШТЕ ДОСТАПЕН ?');
  assert.ok(AVAILABILITY_CLAIM.test(answer), `the ack is served: ${answer}`);
  assert.match(answer, /сопственик/iu, `the owner question stays for a plain ask: ${answer}`);
  assert.doesNotMatch(answer, /500\s*денари/u, `no fee before consent: ${answer}`);
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.feeDisclosed, undefined, 'nothing was disclosed, nothing can be agreed');
});
