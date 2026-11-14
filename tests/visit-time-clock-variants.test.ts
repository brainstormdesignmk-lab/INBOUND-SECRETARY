// THE CLOCK VARIANTS — the [13:16]/[13:20] TUI capture.
//
//   [13:16] ЛИНА: «Ќе треба точен час за да проверам со сопственикот. Во колку?»
//   [13:16] client: «NEKA BIDE 5 I 30»   → the WHOLE term question came back
//   [13:17] client: «5IPOL»              → accepted, but the owner was then
//                                          asked for an hour the client had
//                                          already given
//   [13:20] owner: «POSLE 6»             → «нема активна проверка за овој клиент»
//
// Three defects, one family:
//   1. «5 I 30» (digit + conjunction + minutes) matched NO clock family, so the
//      funnel asked the client for a time it had just been handed.
//   2. isValidVisitTime enumerated only HH:MM and the hour word, so the
//      half-hour families («5IPOL», «6IPOL», «7 и пол») that detectVisitTime
//      accepts were rejected downstream — the client's own term read as "not a
//      time".
//   3. An owner answer that NAMES a clock («POSLE 6») was treated as vague and
//      re-asked; the re-ask went to the CLIENT and armed no check, so the
//      owner's reply was dropped with «нема активна проверка».
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
import { EventStore } from '../src/store/events';
import { OwnerStore } from '../src/store/owners';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { DeferredOwnerAgent } from '../src/backoffice/ownerAgent';
import { parseVisitDateTime, hasClockHint } from '../src/visits/time';
import { detectVisitTime, isValidVisitTime, detectVagueTime } from '../src/llm/deterministic';

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
];

// Fixed clock: Sunday 16.08.2026, 10:00.
const NOW = new Date(2026, 7, 16, 10, 0, 0);

async function makeHandler() {
  const cfg = loadConfig();
  // The owner agent is chosen by the CONFIG (not by a dep): 'deferred' is the
  // TUI/Hermes seam where the owner answers by hand — the only mode in which
  // "the owner was asked, now he answers" is a real flow.
  cfg.ownerAgentMode = 'deferred';
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const events = new EventStore(db);
  const owners = new OwnerStore(db);
  owners.upsert({ eb: 78, name: 'Стојан', phone: '070999888', status: 'available' });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels, landmarks: undefined,
  });
  const ownerAgent = handler.ownerAgent as DeferredOwnerAgent;
  assert.equal(ownerAgent.name, 'deferred', 'this harness needs the interactive owner seam');
  const chatId = 'clock-variants';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };
  return { handler, sessions, sent, send, ownerAgent, chatId };
}

const tick = (ms = 80) => new Promise(r => setTimeout(r, ms));

// ── 1+2. The clock families, one source ────────────────────────────────────

test('[13:16] «NEKA BIDE 5 I 30» is a clock — detect, validate and parse agree', () => {
  for (const t of ['NEKA BIDE 5 I 30', '5 I 30', '5 и 30', '5i30', 'PONEDELNIK 5 I 30']) {
    assert.ok(detectVisitTime(t) !== undefined, `not a visit time: ${t}`);
    assert.equal(isValidVisitTime(t), true, `the validator rejected a clock it accepts: ${t}`);
    assert.equal(hasClockHint(t), true, `no clock hint: ${t}`);
  }
  // The digit minutes resolve like every other clock: 1–8 are the afternoon
  // side of the 09:00–21:00 visit window.
  const p = parseVisitDateTime('NEKA BIDE 5 I 30', NOW)!;
  assert.equal(p.getHours(), 17);
  assert.equal(p.getMinutes(), 30);
  const day = parseVisitDateTime('PONEDELNIK 5 I 30', NOW)!;
  assert.equal(day.getDate(), 17, 'the day word still binds the clock');
  assert.equal(day.getHours(), 17);
  // Counts and money are never clocks.
  assert.equal(hasClockHint('5 i 30 stana'), false);
  assert.equal(hasClockHint('5 i 30 evra'), false);
  assert.equal(detectVisitTime('5 i 30 stana'), undefined);
});

test('[13:17] «5IPOL» validates as a time — the half-hour families are one family', () => {
  for (const t of ['5IPOL', '6IPOL', '7 и пол', 'пет и пол']) {
    assert.ok(detectVisitTime(t) !== undefined, `not a visit time: ${t}`);
    // THE [13:17] BUG: this predicate enumerated only HH:MM and the hour word,
    // so the half-hour the client gave read as "not a time" further down the
    // funnel and the owner was asked for an hour that had already been given.
    assert.equal(isValidVisitTime(t), true, `half-hour rejected by the validator: ${t}`);
    assert.equal(detectVagueTime(t), false, `a half-hour is an exact clock, not a vague one: ${t}`);
  }
  const p = parseVisitDateTime('5IPOL', NOW)!;
  assert.equal(p.getHours(), 17);
  assert.equal(p.getMinutes(), 30);
});

// ── 3. The owner's exact time reaches the client ───────────────────────────

test('e2e [13:16/13:20]: the client clock goes to the owner, the owner clock comes back to the client', async () => {
  const { handler, sessions, sent, send, ownerAgent, chatId } = await makeHandler();

  // Reach the fee gate like the field session did.
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA');
  await send('DA, SE SOGLASUVAM');
  await send('ZORAN 078/914 196');

  // [13:16] the client's clock — the term question must NOT come back.
  const s = await send('NEKA BIDE 5 I 30');
  assert.equal(s.state, 'owner_checking', `the term goes to the owner, got: ${s.state}`);
  assert.equal(hasClockHint(s.slots.visitTime ?? ''), true, `the clock survived: ${s.slots.visitTime}`);
  // runOwnerCheck is fire-and-forget (it awaits the property row first), so the
  // check is armed a microtask/timer after handle() returns.
  await tick();
  assert.equal(ownerAgent.pendingEb(chatId), 78, 'the owner check is armed');

  const ownerAsks: string[] = [];
  handler.onOwnerAsk = (_c: string, _eb: number, q: string) => { ownerAsks.push(q); };
  const clientBefore = sent.length;

  // [13:20] the owner answers with NO clock → Lina asks the OWNER (not the
  // client) and re-arms the check so the answer can be accepted.
  handler.ownerAnswer(chatId, 78, { status: 'counter', ownerTime: 'popladne' });
  await tick();
  const s2 = sessions.get(chatId)!;
  assert.equal(s2.state, 'owner_checking', `the funnel waits for the owner's clock: ${s2.state}`);
  assert.ok(ownerAsks.some(q => /колку|часот/iu.test(q)),
    `the exact-clock ask must go to the OWNER: ${JSON.stringify(ownerAsks)}`);
  assert.equal(sent.length, clientBefore, 'owner-facing copy never reaches the client');
  assert.equal(ownerAgent.pendingEb(chatId), 78,
    'the check is re-armed — without it the owner\'s reply dies with «нема активна проверка»');

  // The owner's real answer NAMES a clock → it is relayed to the client, not
  // re-asked ("POSLE 6" resolves to 18:00 inside the visit window).
  //
  // THE OWNER'S CLOCK IS WEEKDAY-QUALIFIED, because a bare «POSLE 6» is not a
  // fixed instant: it means «today at 18:00», or TOMORROW's 18:00 once the real
  // clock is past 18:00 — and tomorrow may be a Saturday, which the visit
  // window refuses, so the counter stayed in owner_checking and this test
  // expired at 19:35 on its own date (2026-11-13) with no code change behind
  // it. «PONEDELNIK 18:00» names the instant the assertion is about.
  assert.ok(parseVisitDateTime('PONEDELNIK 18:00', NOW), 'an owner clock resolves');
  handler.ownerAnswer(chatId, 78, { status: 'counter', ownerTime: 'PONEDELNIK 18:00' });
  await tick(150);
  const s3 = sessions.get(chatId)!;
  assert.equal(s3.state, 'time_confirm', `the counter reaches the client for acceptance: ${s3.state}`);
  const relay = sent[sent.length - 1] ?? '';
  assert.match(relay, /18:00/u, `the owner's exact time must be relayed: ${relay}`);
  assert.ok(relay.trim().endsWith('?'), `the client is asked to accept it: ${relay}`);
  assert.ok(!/нема активна проверка/iu.test(ownerAsks.join(' | ')));
});

test('e2e: an OPEN window ("OD 5 PA NATAKA") re-asks the exact hour — it never reaches the owner as a term', async () => {
  const { handler, sessions, sent, send, chatId } = await makeHandler();
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA');
  await send('DA, SE SOGLASUVAM');
  await send('ZORAN 078/914 196');

  const ownerAsks: string[] = [];
  handler.onOwnerAsk = (_c: string, _eb: number, q: string) => { ownerAsks.push(q); };
  const s = await send('OD 5 PA NATAKA');
  assert.equal(s.state, 'visit_scheduling', `an open window waits for the exact hour: ${s.state}`);
  assert.equal(detectVagueTime(s.slots.visitTime ?? ''), true, `the window is stored as vague: ${s.slots.visitTime}`);
  assert.ok(/колку|часот/iu.test(sent[sent.length - 1] ?? ''),
    `the exact-hour ask fires: ${sent[sent.length - 1]?.slice(0, 90)}`);
  await tick();
  assert.equal(ownerAsks.length, 0, `the owner must never hear a window as a term: ${JSON.stringify(ownerAsks)}`);
  assert.notEqual(sessions.get(chatId)!.state, 'owner_checking', 'no owner check on an open window');
});
