// THE OWNER'S DAY SURVIVES HIS NEXT SENTENCE — the [10:24] TUI capture.
//
//   [10:23] client: «CETVRTOK 6»            → owner asked about Четврток, 05.11.2026 во 18:00
//   [10:24] owner:  a DAY only              → Lina re-asks HIM for the exact hour
//   [10:24] owner:  «OKOLU 5 MOZAM»         → client told «Има друг предлог:
//                                             Вторник, 03.11.2026 во 17:00»
//
// Two facts made that wrong:
//   1. «Вторник, 03.11.2026» is TODAY — `normalizeOwnerTime` dated a term with
//      no day to now, so the client was offered a weekday and a date the owner
//      never named instead of the day he HAD just named (Петок).
//   2. the RAW «Околу 5» was stored in slots.ownerTime / ownerCounterTime, i.e.
//      as the term the client can accept and as the term the next owner ping
//      calls "refused" — the [17:45] class, now permanent.
//
// The rule: the day on the table is donated in ONE place (the owner's own last
// named day first, then the day of the term he is answering); a clock with no
// day and no anchor is NEVER relayed — the owner is asked for the day.
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
import { OwnerStore } from '../src/store/owners';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { DeferredOwnerAgent } from '../src/backoffice/ownerAgent';
import { detectOwnerVerdict } from '../src/llm/deterministic';
import { normalizeOwnerTime, mergeOwnerTerm } from '../src/llm/prompts';
import { namesADay, hasClockHint } from '../src/visits/time';

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

// THE CAPTURE CLOCK: Tuesday, 03.11.2026, 10:23 — "today" is exactly the day the
// old normalizer invented, so a regression is a STRING match, not a guess.
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

const tick = (ms = 90) => new Promise(r => setTimeout(r, ms));

async function makeHandler() {
  const cfg = loadConfig();
  cfg.ownerAgentMode = 'deferred'; // the TUI/Hermes seam: the owner answers by hand
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  new OwnerStore(db).upsert({ eb: 78, name: 'Стојан', phone: '070999888', status: 'available' });
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
  });
  const chatId = 'day-carry';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };
  return { handler, sessions, sent, send, chatId, db };
}

/** interest → owner contact → fee → contact → the client's term (owner_checking). */
async function reachOwnerChecking(send: (m: string) => Promise<any>, chatId: string, sessions: SessionStore) {
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA');
  await send('DA, SE SOGLASUVAM');
  await send('ZORAN 078/914 196');
  await send('CETVRTOK 6');
  await tick();
  assert.equal(sessions.get(chatId)!.state, 'owner_checking', 'the client term must reach the owner check');
  assert.equal(sessions.get(chatId)!.slots.ownerAskTime, 'Четврток, 05.11.2026 во 18:00');
}

test('[10:24] «PETOK» then «OKOLU 5 MOZAM» relays Петок 17:00 — never today', async () => {
  const unpin = pinClock(new Date(2026, 10, 3, 10, 23, 0));
  try {
    const { handler, sessions, sent, send, chatId } = await makeHandler();
    const asks: string[] = [];
    handler.onOwnerAsk = (_c, _eb, q) => asks.push(q);
    await reachOwnerChecking(send, chatId, sessions);
    assert.equal(asks.length, 1, `the first owner ask must go out: ${JSON.stringify(asks)}`);
    const before = sent.length;

    // [10:24] the owner names a DAY only — the exact hour goes back to HIM, and
    // the client hears nothing (the [13:20] rule).
    const dayOnly = detectOwnerVerdict('PETOK', 'Четврток, 05.11.2026 во 18:00')!;
    assert.equal(dayOnly.status, 'counter');
    assert.equal(hasClockHint(dayOnly.ownerTime ?? ''), false, `day-only verdict: ${JSON.stringify(dayOnly)}`);
    assert.equal(handler.ownerAnswer(chatId, 78, dayOnly), true, 'the pending check must accept the verdict');
    await tick();
    assert.equal(sent.length, before, `a clockless counter must not reach the client: ${JSON.stringify(sent.slice(before))}`);
    assert.match(asks[asks.length - 1], /колку|часот/, `the hour ask goes to the OWNER: ${asks[asks.length - 1]}`);
    assert.equal(sessions.get(chatId)!.slots.ownerClockDay, 'Петок', 'his own day must be remembered');

    // [10:24] his clock arrives in the NEXT sentence, carrying no day at all.
    const clockOnly = detectOwnerVerdict('OKOLU 5 MOZAM', 'Четврток, 05.11.2026 во 18:00')!;
    assert.equal(clockOnly.status, 'counter');
    assert.equal(clockOnly.ownerTime, 'Околу 5', 'the parser hands over a day-less clock');
    assert.equal(handler.ownerAnswer(chatId, 78, clockOnly), true);
    await tick();

    const relay = sent[sent.length - 1];
    assert.equal(relay,
      'Сопственикот не е во можност за посета во Четврток, 05.11.2026 во 18:00. Има друг предлог: Петок, 06.11.2026 во 17:00. Дали би Ви одговарал тој термин?');
    // THE DEFECT SHAPE: the day-less clock used to be dated to TODAY.
    assert.ok(!/Вторник, 03\.11\.2026/.test(relay), `today must never be invented: ${relay}`);

    const s = sessions.get(chatId)!;
    assert.equal(s.state, 'time_confirm');
    assert.equal(s.slots.ownerTime, 'Петок Околу 5', 'the STORED term must carry his day');
    assert.equal(s.slots.ownerCounterTime, 'Петок Околу 5',
      'the next owner ping must name a day-carrying refused term');
    assert.equal(namesADay(s.slots.ownerCounterTime!), true);
    assert.equal(s.slots.ownerClockDay, undefined, 'the seed is consumed by the fixed counter');
  } finally { unpin(); }
});

test('no owner-named day → the clock completes the day he is ANSWERING, not today', async () => {
  const unpin = pinClock(new Date(2026, 10, 3, 10, 23, 0));
  try {
    const { handler, sessions, sent, send, chatId } = await makeHandler();
    handler.onOwnerAsk = () => {};
    await reachOwnerChecking(send, chatId, sessions);

    // The owner answers the FIRST ask with a bare clock («around 5»).
    const v = detectOwnerVerdict('OKOLU 5 MOZAM', 'Четврток, 05.11.2026 во 18:00')!;
    assert.equal(handler.ownerAnswer(chatId, 78, v), true);
    await tick();

    const relay = sent[sent.length - 1];
    assert.match(relay, /Има друг предлог: Четврток, 05\.11\.2026 во 17:00\./u,
      `the term on the table donates its day: ${relay}`);
    assert.ok(!/Вторник, 03\.11\.2026/.test(relay), `never today: ${relay}`);
    assert.equal(sessions.get(chatId)!.slots.ownerTime, 'Четврток Околу 5',
      'the clock completes the day he was answering, in its raw shape');
  } finally { unpin(); }
});

test('NOBODY named a day → the clock keeps its next occurrence (it must still reach the client)', async () => {
  const unpin = pinClock(new Date(2026, 10, 3, 10, 23, 0));
  try {
    const { handler, sessions, sent, send, chatId } = await makeHandler();
    const asks: string[] = [];
    handler.onOwnerAsk = (_c, _eb, q) => asks.push(q);
    await reachOwnerChecking(send, chatId, sessions);

    // Strip every day from the table (a clock-only client term, fresh chat).
    const s0 = sessions.get(chatId)!;
    s0.slots.visitTime = 'околу 5';
    s0.slots.ownerAskTime = undefined;
    s0.slots.ownerClockDay = undefined;
    sessions.set(s0);
    const askCount = asks.length;

    assert.equal(handler.ownerAnswer(chatId, 78, { status: 'counter', ownerTime: 'Околу 6' }), true);
    await tick();

    // THE [13:16/13:20] CONTRACT: the owner's hour reaches the client, and a
    // day that NOBODY named resolves to the clock's next occurrence — it is the
    // only case where today may appear, because it contradicts nothing.
    assert.equal(asks.length, askCount, `no second owner question: ${JSON.stringify(asks.slice(askCount))}`);
    const relay = sent[sent.length - 1] ?? '';
    assert.match(relay, /Има друг предлог: Вторник, 03\.11\.2026 во 18:00\./u, relay);
    assert.ok(relay.trim().endsWith('?'), `the client is asked to accept it: ${relay}`);
    assert.equal(sessions.get(chatId)!.state, 'time_confirm');
  } finally { unpin(); }
});

test('normalizeOwnerTime never dates an undated term; mergeOwnerTerm donates the most specific day', () => {
  const NOW = new Date(2026, 10, 3, 10, 25, 0); // Tuesday
  const bare = normalizeOwnerTime('Околу 5', NOW);
  assert.ok(!/Вторник|\d{2}\.\d{2}\.\d{4}/u.test(bare), `no invented weekday/date: ${bare}`);
  assert.match(bare, /5/u);
  const part = normalizeOwnerTime('попладне', NOW);
  assert.ok(!/\d{2}\.\d{2}\.\d{4}/u.test(part), `a day-part is not a date either: ${part}`);
  // A DATED term still resolves to the concrete date (unchanged behaviour).
  assert.equal(normalizeOwnerTime('Петок во 17:00', NOW), 'Петок, 06.11.2026 во 17:00');

  assert.equal(mergeOwnerTerm('Околу 5', ['Петок', 'Четврток, 05.11.2026 во 18:00']), 'Петок Околу 5');
  assert.equal(mergeOwnerTerm('Околу 5', [undefined, 'Четврток, 05.11.2026 во 18:00']), 'Четврток Околу 5');
  assert.equal(mergeOwnerTerm('Петок во 18:00', ['Среда']), 'Петок во 18:00', 'a dated term is never re-anchored');
  assert.equal(mergeOwnerTerm('Околу 5', []), 'Околу 5', 'nothing to donate — the caller must ask');

  assert.equal(namesADay('околу 5'), false);
  assert.equal(namesADay('5 I 30'), false);
  assert.equal(namesADay('18:00'), false);
  assert.equal(namesADay('18.10'), true);       // a date, not a clock (first part > 12)
  assert.equal(namesADay('05.11.2026'), true);
  assert.equal(namesADay('утре во 5'), true);   // a relative day is still a day
  assert.equal(namesADay('PETOK'), true);
});

// THE DAY-LOSS AUDIT over data/tui.db, then pinned here: the captures hold
// day-less stored terms (appointments.time 'Во 17:00', visit_confirmed payload
// 'Во 17:00', ownerTime 'Во 17:00'). Those rows predate the day-merge, but the
// ACCEPTANCE seam still had no guard of its own: confirmVisit took the slot as
// it found it, so a day-less term produced a confirmation, an agent assignment
// and an appointment that no human could date. The merge must run at that seam
// too — the day on the table (the client's own proposal) is the anchor.
test('a day-less stored term is DATED at the acceptance seam (confirmation, events, appointment)', async () => {
  const unpin = pinClock(new Date(2026, 10, 3, 10, 23, 0));
  try {
    const { handler, sessions, sent, send, chatId, db } = await makeHandler();
    handler.onOwnerAsk = () => {};
    await reachOwnerChecking(send, chatId, sessions);

    // The legacy row shape: a time_confirm session whose owner slot was written
    // before the day-merge («Во 17:00» — no day anywhere in it). The client's
    // own proposal still names Четврток.
    const s0 = sessions.get(chatId)!;
    s0.state = 'time_confirm';
    s0.slots.ownerTime = 'Во 17:00';
    s0.slots.ownerCounterTime = 'Во 17:00';
    sessions.set(s0);
    const before = sent.length;

    await send('DA');
    const s = sessions.get(chatId)!;
    assert.equal(s.state, 'pending', `the acceptance books the visit: ${s.state}`);

    // 1. THE CLIENT CONFIRMATION names the day (it used to read «во 17:00» bare).
    const confirmation = sent.slice(before).join(' | ');
    assert.match(confirmation, /Четврток, 05\.11\.2026 во 17:00/u, confirmation);

    // 2. THE APPOINTMENT carries the term in its OWN shape ([20:31] verbatim
    //    contract) but WITH a day — the audit's day-less 'Во 17:00' rows were
    //    the defect, not the verbatim shape.
    const appt = db.db.prepare(`SELECT time FROM appointments WHERE chat_id = ?`)
      .get(chatId) as { time: string } | undefined;
    assert.ok(appt, 'the appointment must exist');
    assert.match(appt!.time, /Четврток/u, `appointment time: ${appt!.time}`);
    assert.equal(namesADay(appt!.time), true, 'the stored visit time names its day');

    // 3. BOTH owner-facing events carry the dated term (the agent assignment and
    //    the visit confirmation used to relay the raw slot).
    for (const type of ['agent_assigned', 'visit_confirmed']) {
      const row = db.db.prepare(`SELECT payload FROM events WHERE chat_id = ? AND type = ? ORDER BY id DESC`)
        .get(chatId, type) as { payload: string } | undefined;
      assert.ok(row, `${type} must be emitted`);
      const payload = JSON.parse(row!.payload) as { time?: string };
      assert.match(payload.time ?? '', /Четврток, 05\.11\.2026/u, `${type}: ${row!.payload}`);
    }
  } finally { unpin(); }
});

// THE SAME HOLE IN THE LLM PATH: the time_confirm task prompt told the brain to
// relay `slots.ownerTime` verbatim, so a session stored before the day-merge
// asked the client to accept «Во 17:00» — a term with no day — even though the
// term being answered named Четврток. The prompt now donates the day at read
// time (the slot itself is never rewritten).
test('the time_confirm task prompt dates a legacy day-less slot', async () => {
  const { stateTask } = await import('../src/llm/prompts');
  const legacy = stateTask('time_confirm', {
    ownerTime: 'Во 17:00',
    visitTime: 'Четврток, 05.11.2026 во 18:00',
  } as any);
  assert.match(legacy, /Четврток Во 17:00/u, legacy);
  // A term that already names its day passes through untouched.
  const dated = stateTask('time_confirm', {
    ownerTime: 'Петок, 06.11.2026 во 17:00',
    visitTime: 'Четврток, 05.11.2026 во 18:00',
  } as any);
  assert.match(dated, /Петок, 06\.11\.2026 во 17:00/u, dated);
});
