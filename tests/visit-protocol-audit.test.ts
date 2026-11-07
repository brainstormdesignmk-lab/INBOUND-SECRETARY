// THE VISIT-PROTOCOL AUDIT (the seven defects found in the 2026-11 review).
// One test per defect, all driving the real seams (VisitScheduler / the
// InboundHandler owner lane) rather than private helpers — the routing order
// matters as much as the regex, and the duplicate-arranged bug lived in the
// ORDER of two sends, not in either message.
//
// The seven:
//   1. the client was told twice that the visit is arranged (inline Turn 1 at
//      booking + a second «ДОГОВОРЕНА ПОСЕТА» after the owner confirmed the
//      address, in a different format);
//   2. the messages.ts header claimed the street appears only in Turn 3 while
//      Turn 1 (and Turn 2) carried it;
//   3. the address reminder was not a loop, and releasing it unblocked Turns
//      2/3 on an address NOBODY confirmed;
//   4. an owner with no phone produced a silent protocol (a console.error);
//   5. a half-answered / unanswered owner check parked the client forever with
//      no operator escalation and no client re-ping;
//   6. the visiting agent was a phone number in copy — never a recipient;
//   7. the operator log mixed «ARRANGED VISIT» with «… 2 TURN» / «3 TURN …».

import { test } from 'node:test';
import assert from 'node:assert';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession } from '../src/fsm/session';
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
import { VisitScheduler } from '../src/visits/scheduler';
import { LandmarkService } from '../src/geo/landmarks';
import { buildAddressConfirm } from '../src/visits/messages';
import { DeferredOwnerAgent } from '../src/backoffice/ownerAgent';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 53, id: 53, location: 'Аеродром', address: 'Бисер', price: 55000, service: 'buy', bedrooms: 2 },
  { eb: 78, id: 78, location: 'Капиштец', price: 185000, service: 'buy', bedrooms: 3, size: '82 м²', address: 'Народен Фронт' },
];

const NOW = new Date(2026, 7, 16, 10, 0, 0); // Sunday 2026-08-16 10:00

interface Harness {
  db: Db;
  sched: VisitScheduler;
  apptId: number;
  clientMsgs: string[];
  ownerMsgs: string[];
  operatorLogs: string[];
  setClock: (d: Date) => void;
  turns: () => Array<{ turn: string; status: string; bumps: number; escalated: number; owner_status: string }>;
}

function makeScheduler(opts: { ownerNotifyFails?: boolean; agent?: boolean } = {}): Harness {
  const db = new Db(':memory:');
  const events = new EventStore(db);
  const owners = new OwnerStore(db);
  owners.upsert({ eb: 53, name: 'Петре', phone: '070111222', status: 'available' });
  const clientMsgs: string[] = [];
  const ownerMsgs: string[] = [];
  const operatorLogs: string[] = [];
  const agentMsgs: string[] = [];
  let clock = NOW;
  const sched = new VisitScheduler({
    db, events, owners, properties: new FakeProps(ROWS),
    notifyClient: async (chatId, text) => { clientMsgs.push(`[${chatId}] ${text}`); },
    notifyOwner: async (_chatId, eb, text) => {
      if (opts.ownerNotifyFails) throw new Error(`no owner phone for EB ${eb}`);
      ownerMsgs.push(`[EB ${eb}] ${text}`);
    },
    notifyOperator: async text => { operatorLogs.push(text); },
    notifyAgent: opts.agent
      ? async (phone, text) => { agentMsgs.push(`${phone}:${text}`); return true; }
      : undefined,
    now: () => clock,
  });
  const appts = new AppointmentStore(db);
  const apptId = appts.insert({
    chatId: 'c1', clientName: 'Марко', clientPhone: '070333444', propertyId: 53,
    service: 'Купување', viewingFee: '500 MKD', time: 'утре попладне', agentPhone: '076247467',
  });
  appts.markFinalized(apptId, 'утре попладне');
  return {
    db, sched, apptId, clientMsgs, ownerMsgs, operatorLogs,
    setClock: d => { clock = d; },
    turns: () => db.db.prepare(
      `SELECT turn, status, bumps, escalated, owner_status FROM visit_turns WHERE appointment_id = ? ORDER BY turn`
    ).all(apptId) as any,
  };
}

const arrangeVisit = (h: Harness) => h.sched.arrange({
  appointmentId: h.apptId, chatId: 'c1', eb: 53, time: 'утре попладне',
  agentPhone: '076247467', clientName: 'Марко', clientPhone: '070333444',
  owner: { name: 'Петре', phone: '070111222' },
});

// ── 1 + 2 ────────────────────────────────────────────────────────────────────
test('audit #1/#2: the scheduler never sends a second «ДОГОВОРЕНА ПОСЕТА», and the street is Turn 3 only', async () => {
  const h = makeScheduler();
  await arrangeVisit(h);
  // Turn 0 is the owner's; the client got nothing (Turn 1 is the handler's).
  assert.equal(h.ownerMsgs.length, 1, h.ownerMsgs.join('\n'));
  assert.ok(h.ownerMsgs[0].includes('Ми треба потврда'), h.ownerMsgs[0]);
  assert.equal(h.clientMsgs.length, 0, h.clientMsgs.join('\n'));

  await h.sched.confirmAddress(h.apptId);
  // The owner's confirmation is ACKED — and the client gets NOTHING new.
  assert.equal(h.ownerMsgs.length, 2, h.ownerMsgs.join('\n'));
  assert.ok(/Ви благодарам/u.test(h.ownerMsgs[1]), h.ownerMsgs[1]);
  assert.ok(!h.ownerMsgs[1].includes('ДОГОВОРЕНА ПОСЕТА'), h.ownerMsgs[1]);
  assert.equal(h.clientMsgs.length, 0, `a second arranged message was sent: ${h.clientMsgs.join(' | ')}`);

  // Turn 2 = morning confirmation: agent + term, NO street.
  h.setClock(new Date(2026, 7, 17, 10, 0));
  await h.sched.tick();
  const morning = h.clientMsgs.find(m => m.includes('АГЕНТ ЗА КОНТАКТ'));
  assert.ok(morning, h.clientMsgs.join(' | '));
  assert.ok(!morning!.includes('Бисер'), `Turn 2 leaked the street: ${morning}`);
  assert.ok(!morning!.includes('Адреса'), `Turn 2 leaked the street: ${morning}`);

  // Turn 3 = the ONE disclosure.
  h.setClock(new Date(2026, 7, 17, 14, 0));
  await h.sched.tick();
  const location = h.clientMsgs.find(m => m.includes('ЛОКАЦИЈА'));
  assert.ok(location, h.clientMsgs.join(' | '));
  assert.ok(location!.includes('Адреса: Бисер'), location);
  assert.ok(location!.includes('google.com/maps'), location);
  h.db.close();
});

// ── 3 ────────────────────────────────────────────────────────────────────────
test('audit #3: the Turn-0 bump LOOPS, and Turns 2/3 stay blocked on an address nobody confirmed', async () => {
  const h = makeScheduler();
  await arrangeVisit(h);

  // +2h: reminder 1 — the turn stays PENDING (a reminder is not a confirmation).
  h.setClock(new Date(2026, 7, 16, 12, 0));
  await h.sched.tick();
  assert.equal(h.ownerMsgs.length, 2, h.ownerMsgs.join('\n'));
  assert.ok(h.ownerMsgs[1].includes('потврда'), h.ownerMsgs[1]);
  let t = h.turns().find(x => x.turn === 'address_confirm')!;
  assert.equal(t.status, 'pending', JSON.stringify(t));
  assert.equal(t.bumps, 1, JSON.stringify(t));

  // +4h: reminder 2 loops.
  h.setClock(new Date(2026, 7, 16, 14, 0));
  await h.sched.tick();
  assert.equal(h.ownerMsgs.length, 3, h.ownerMsgs.join('\n'));
  t = h.turns().find(x => x.turn === 'address_confirm')!;
  assert.equal(t.bumps, 2, JSON.stringify(t));

  // The cap: 4 reminders, then the operator is told and the pings stop.
  for (const hour of [16, 18]) {
    h.setClock(new Date(2026, 7, 16, hour, 0));
    await h.sched.tick();
  }
  t = h.turns().find(x => x.turn === 'address_confirm')!;
  assert.equal(t.bumps, 4, JSON.stringify(t));
  // The cap stops the PINGS, not the answer: the row stays `pending` on
  // purpose — a `skipped` row would refuse the owner's late confirmation and
  // (before the gate fix) release Turns 2/3 on an unconfirmed address.
  assert.equal(t.status, 'pending', JSON.stringify(t));
  assert.ok(h.operatorLogs.some(l => l.includes('ADDRESS STILL UNCONFIRMED')), h.operatorLogs.join('\n'));
  const ownerPingsAfterCap = h.ownerMsgs.length;
  assert.equal(ownerPingsAfterCap, 5, h.ownerMsgs.join('\n')); // Turn 0 + 4 reminders

  // VISIT DAY: the morning confirm is DUE — and must NOT fire on an address
  // nobody confirmed (this is the defect that let the client into the street).
  h.setClock(new Date(2026, 7, 17, 10, 0));
  await h.sched.tick();
  assert.equal(h.clientMsgs.filter(m => m.includes('АГЕНТ ЗА КОНТАКТ')).length, 0,
    `Turn 2 fired on an UNCONFIRMED address: ${h.clientMsgs.join(' | ')}`);
  h.setClock(new Date(2026, 7, 17, 14, 0));
  await h.sched.tick();
  assert.equal(h.clientMsgs.filter(m => m.includes('ЛОКАЦИЈА')).length, 0,
    `Turn 3 fired on an UNCONFIRMED address: ${h.clientMsgs.join(' | ')}`);

  // The owner finally confirms: the blocked turns are released.
  await h.sched.confirmAddress(h.apptId);
  h.setClock(new Date(2026, 7, 17, 14, 5));
  await h.sched.tick();
  assert.equal(h.clientMsgs.filter(m => m.includes('ЛОКАЦИЈА')).length, 1, h.clientMsgs.join(' | '));
  h.db.close();
});

test('audit #3 (sibling): forceTurn cannot bypass the disclosure gate', async () => {
  const h = makeScheduler();
  await arrangeVisit(h);
  assert.equal(await h.sched.forceTurn(h.apptId, 'confirm'), false);
  assert.ok(h.operatorLogs.some(l => l.includes('NOT FORCED')), h.operatorLogs.join('\n'));
  h.db.close();
});

// ── 4 ────────────────────────────────────────────────────────────────────────
test('audit #4: an unreachable owner is an OPERATOR escalation, not a swallowed error', async () => {
  const h = makeScheduler({ ownerNotifyFails: true });
  await arrangeVisit(h);
  assert.ok(h.operatorLogs.some(l => l.includes('OWNER NOT REACHABLE')), h.operatorLogs.join('\n'));
  // …and the protocol does not pretend: the failure is on the turn row.
  const t = h.turns().find(x => x.turn === 'address_confirm')!;
  assert.equal(t.owner_status, 'failed', JSON.stringify(t));
  assert.equal(t.status, 'pending', 'the address is still owed');
  // The escalation happens ONCE, not on every tick.
  h.setClock(new Date(2026, 7, 16, 12, 0));
  await h.sched.tick();
  assert.equal(h.operatorLogs.filter(l => l.includes('OWNER NOT REACHABLE')).length, 1, h.operatorLogs.join('\n'));
  h.db.close();
});

test('audit #4 (sibling): a failed delivery does not swallow the LATER «still unconfirmed» warning', async () => {
  // Two different causes on ONE turn used to share a single escalation flag,
  // so the unreachable-owner warning at arrange() silenced the reminder-cap
  // warning that tells the operator the CLIENT never got Turn 2/3.
  const h = makeScheduler({ ownerNotifyFails: true });
  await arrangeVisit(h);
  for (const hour of [12, 14, 16, 18]) {
    h.setClock(new Date(2026, 7, 16, hour, 0));
    await h.sched.tick();
  }
  const log = h.operatorLogs.join('\n');
  assert.ok(log.includes('OWNER NOT REACHABLE'), log);
  assert.ok(log.includes('ADDRESS STILL UNCONFIRMED'), log);
  h.db.close();
});

// ── 5 ────────────────────────────────────────────────────────────────────────
test('audit #5: an unanswered owner check fires the timeout hook once and the check stays resolvable', async () => {
  const db = new Db(':memory:');
  const owners = new OwnerStore(db);
  owners.upsert({ eb: 53, name: 'Петре', phone: '070111222', status: 'available' });
  const events = new EventStore(db);
  const timeouts: Array<{ eb: number; proposedTime: string }> = [];
  const agent = new DeferredOwnerAgent(owners, events, 15, 5, info => { timeouts.push(info); });
  const verdict = agent.check('c1', 53, 'Утре во 16:00');
  await new Promise(r => setTimeout(r, 60));
  assert.equal(timeouts.length, 1, JSON.stringify(timeouts));
  assert.equal(timeouts[0].eb, 53);
  assert.ok(timeouts[0].proposedTime.includes('16:00'), JSON.stringify(timeouts[0]));
  // A LATE answer still lands: the timeout must not clear the poll (that is
  // what parked the client forever).
  agent.answer('c1', 53, { status: 'ok' });
  const v = await verdict;
  assert.equal(v.status, 'ok');
  assert.equal(timeouts.length, 1, 'a resolved check must not escalate again');
  db.close();
});

// ── 6 ────────────────────────────────────────────────────────────────────────
test('audit #6: the visiting agent gets the dossier — directly, or via the operator when he has no channel', async () => {
  const direct = makeScheduler({ agent: true });
  await arrangeVisit(direct);
  await direct.sched.confirmAddress(direct.apptId);
  const briefs = direct.operatorLogs.filter(l => l.includes('[ЗА АГЕНТ'));
  // The dep exists: no operator fallback was needed for the agent itself.
  assert.equal(briefs.length, 0, briefs.join('\n'));
  direct.db.close();

  const viaOperator = makeScheduler();
  await arrangeVisit(viaOperator);
  await viaOperator.sched.confirmAddress(viaOperator.apptId);
  const fallback = viaOperator.operatorLogs.find(l => l.includes('[ЗА АГЕНТ 076247467]'));
  assert.ok(fallback, viaOperator.operatorLogs.join('\n'));
  assert.ok(fallback!.includes('Марко (070333444)'), fallback);
  assert.ok(fallback!.includes('АДРЕСА: Бисер'), fallback);
  assert.ok(fallback!.includes('google.com/maps'), fallback);
  viaOperator.db.close();
});

// ── 7 ────────────────────────────────────────────────────────────────────────
test('audit #7: ONE log vocabulary (TURN 0..3) and the dossier the operator needs', async () => {
  const h = makeScheduler();
  await arrangeVisit(h);
  await h.sched.confirmAddress(h.apptId);
  h.setClock(new Date(2026, 7, 17, 10, 0));
  await h.sched.tick();
  const log = h.operatorLogs.join('\n');
  for (const label of ['TURN 0 ADDRESS CONFIRM', 'TURN 1 ARRANGED', 'TURN 2 MORNING CONFIRM']) {
    assert.ok(log.includes(label), `missing «${label}»:\n${log}`);
  }
  // The old mixed vocabulary is gone.
  for (const stale of ['ARRANGED VISIT', 'VISIT CONFIRMATION 2 TURN', '3 TURN LOCATION SENT']) {
    assert.ok(!log.includes(stale), `stale label «${stale}»:\n${log}`);
  }
  // The morning line carries the term and the agent.
  const turn2 = h.operatorLogs.find(l => l.includes('TURN 2 MORNING CONFIRM'))!;
  assert.ok(/КОГА: \d{2}\.\d{2}\.\d{4} во \d{2}:\d{2}/u.test(turn2), turn2);
  assert.ok(turn2.includes('АГЕНТ: 076247467'), turn2);
  // …and the client phone stays in the shape the TUI routes on.
  assert.ok(/CLIENT: Марко \(070333444\)/u.test(turn2), turn2);
  h.db.close();
});

// ── the handler's Turn-0 lane (the production owner seam) ────────────────────
function makeHandlerWithPendingTurn0() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps(ROWS);
  const events = new EventStore(db);
  const owners = new OwnerStore(db);
  owners.upsert({ eb: 53, name: 'Петре', phone: '070111222', status: 'available' });
  const clientMsgs: string[] = [];
  const ownerMsgs: string[] = [];
  const operatorLogs: string[] = [];
  const sched = new VisitScheduler({
    db, events, owners, properties: props,
    notifyClient: async (_c, t) => { clientMsgs.push(t); },
    notifyOwner: async (_c, _eb, t) => { ownerMsgs.push(t); },
    notifyOperator: async t => { operatorLogs.push(t); },
    now: () => NOW,
  });
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async () => {} });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
    visits: sched,
  });
  const appts = new AppointmentStore(db);
  const apptId = appts.insert({
    chatId: 'addr-chat', clientName: 'Марко', clientPhone: '070333444', propertyId: 53,
    service: 'Купување', viewingFee: '500 MKD', time: 'утре попладне', agentPhone: '076247467',
  });
  appts.markFinalized(apptId, 'утре попладне');
  const s = freshSession('test', 'addr-chat');
  s.slots.propertyId = 53;
  s.slots.interestedPropertyId = 53;
  sessions.set(s);
  return { db, handler, sched, apptId, clientMsgs, ownerMsgs, operatorLogs };
}

test('the owner\'s Turn-0 answer reaches confirmAddress — a plain «да» confirms, a street corrects', async () => {
  const h = makeHandlerWithPendingTurn0();
  await h.sched.arrange({
    appointmentId: h.apptId, chatId: 'addr-chat', eb: 53, time: 'утре попладне',
    agentPhone: '076247467', clientName: 'Марко', clientPhone: '070333444',
    owner: { name: 'Петре', phone: '070111222' },
  });
  assert.equal(h.sched.pendingAddressConfirm('addr-chat'), h.apptId);

  // A bare agreement is an ANSWER ABOUT THE ADDRESS, not a verdict on a term
  // that was already agreed — the verdict lane used to consume it as `ok`.
  const r = await h.handler.ownerMessage('addr-chat', 'да, точна е');
  assert.equal(r.effect, 'address_confirmed', JSON.stringify(r));
  assert.equal(h.sched.pendingAddressConfirm('addr-chat'), null);
  assert.ok(h.ownerMsgs.some(m => /Ви благодарам — адресата/u.test(m)), h.ownerMsgs.join('\n'));
  // One arranged message was never re-sent to the client by this lane.
  assert.equal(h.clientMsgs.length, 0, h.clientMsgs.join('\n'));
  h.db.close();
});

test('a Turn-0 correction lands on the appointment and is queued, never dropped', async () => {
  const h = makeHandlerWithPendingTurn0();
  await h.sched.arrange({
    appointmentId: h.apptId, chatId: 'addr-chat', eb: 53, time: 'утре попладне',
    agentPhone: '076247467', clientName: 'Марко', clientPhone: '070333444',
    owner: { name: 'Петре', phone: '070111222' },
  });
  const r = await h.handler.ownerMessage('addr-chat', 'не, ulicata e Vasil Stefanovski 16');
  assert.equal(r.effect, 'address_confirmed', JSON.stringify(r));
  const row = h.db.db.prepare(`SELECT corrected_address FROM appointments WHERE id = ?`)
    .get(h.apptId) as { corrected_address: string };
  assert.ok(/Vasil\s+Stefanovski\s+16/i.test(row.corrected_address), JSON.stringify(row));
  h.db.close();
});

// The Turn-0 ask itself must name the street — it is the owner's own property,
// and he cannot confirm an address he was never shown.
test('the owner\'s Turn-0 ask carries the written address + map (his own property)', () => {
  const text = buildAddressConfirm(53, new Date(2026, 7, 17, 16, 0), 'Бисер', 'https://maps.example/x');
  assert.ok(text.includes('Адреса: Бисер'), text);
  assert.ok(text.includes('maps.example'), text);
  assert.ok(/Дали адресата е точна\?/u.test(text), text);
});
