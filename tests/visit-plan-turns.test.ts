// THE DAY-BEFORE PLAN TURN (the owner's 2026-11-11 brief).
//
// A confirmed chain gets three touches: the plan at confirmation (handler), the
// SAME plan the day before, and the exact-location turn on the day. This file
// pins the day-before one: the CLIENT receives the whole route ONCE (EB + hour
// only), each OWNER receives his own line with the address and the map, and the
// operator log records what went where.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { Db } from '../src/store/db';
import { EventStore } from '../src/store/events';
import { OwnerStore } from '../src/store/owners';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { VisitScheduler } from '../src/visits/scheduler';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id || r.eb === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

const ROWS = [42, 59].map(eb => ({
  eb, id: eb, address: `Улица ${eb}`, location: 'Центар', price: 80000, service: 'buy',
  bedrooms: 2, sqm: 58, size: '58 м²', lat: 41.995 + eb / 10000, lon: 21.431 + eb / 10000,
  geo_source: 'google_cached', details: '',
} as Property));

function makeScheduler(nowRef: { t: Date }) {
  const dbPath = path.join(os.tmpdir(), `plan-map-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeMap(dbPath, [], []);
  const offlineMap = new OfflineMapStore(dbPath);
  const db = new Db(':memory:');
  const owners = new OwnerStore(db);
  owners.upsert({ eb: 42, name: 'Петре', phone: '070111222', status: 'available' });
  owners.upsert({ eb: 59, name: 'Ана', phone: '070333444', status: 'available' });
  const clientMsgs: string[] = [];
  const ownerMsgs: Array<{ eb: number; text: string }> = [];
  const operatorLogs: string[] = [];
  const sched = new VisitScheduler({
    db, events: new EventStore(db), owners, properties: new FakeProps(ROWS),
    offlineMap,
    notifyClient: async (_c, text) => { clientMsgs.push(text); },
    notifyOwner: async (_c, eb, text) => { ownerMsgs.push({ eb, text }); },
    notifyOperator: async text => { operatorLogs.push(text); },
    now: () => nowRef.t,
  });
  return { db, sched, clientMsgs, ownerMsgs, operatorLogs };
}

test('the 10:00 day-before reminder fires from the clock, not from a forced turn', async () => {
  // forceTurn proves the COPY; this proves the SCHEDULE: the turn sits at 10:00
  // the day before the visit and the ordinary tick (no operator) must send the
  // route then — and only once.
  const nowRef = { t: new Date(2026, 10, 10, 9, 0, 0) }; // Tue 10.11, 09:00
  const h = makeScheduler(nowRef);
  const appts = new AppointmentStore(h.db);
  const ids = [42, 59].map(eb => appts.insert({
    chatId: 'chain', clientName: 'Марко', clientPhone: '070999888', propertyId: eb,
    service: 'Купување', viewingFee: '500 MKD', time: '', agentPhone: '076247467',
  }));
  for (const id of ids) appts.markFinalized(id, '');
  await h.sched.arrange({
    appointmentId: ids[0]!, chatId: 'chain', eb: 42, time: 'Петок, 13.11.2026 во 16:00',
    agentPhone: '076247467', clientName: 'Марко', clientPhone: '070999888',
    owner: { name: 'Петре', phone: '070111222' }, chainSize: 2,
  });
  await h.sched.arrange({
    appointmentId: ids[1]!, chatId: 'chain', eb: 59, time: 'Петок, 13.11.2026 во 17:00',
    agentPhone: '076247467', clientName: 'Марко', clientPhone: '070999888',
    owner: { name: 'Ана', phone: '070333444' }, chainSize: 2,
  });
  await h.sched.confirmAddress(ids[0]!);
  await h.sched.confirmAddress(ids[1]!);

  // The day before at 09:59 nothing is due yet.
  nowRef.t = new Date(2026, 10, 12, 9, 59, 0);
  h.clientMsgs.length = 0;
  h.ownerMsgs.length = 0;
  await h.sched.tick();
  assert.equal(h.clientMsgs.length, 0, `nothing before 10:00: ${JSON.stringify(h.clientMsgs)}`);

  // 10:00 the day before: the client's whole route, once; each owner his line.
  nowRef.t = new Date(2026, 10, 12, 10, 0, 5);
  await h.sched.tick();
  assert.equal(h.clientMsgs.length, 1, `the route reaches the client once: ${JSON.stringify(h.clientMsgs)}`);
  const plan = h.clientMsgs[0]!;
  assert.match(plan, /NEDVIZNOST 42/u, plan);
  assert.match(plan, /NEDVIZNOST 59/u, plan);
  assert.doesNotMatch(plan, /Улица 42|Улица 59/u, `no street a day early: ${plan}`);
  assert.equal(h.ownerMsgs.length, 2, JSON.stringify(h.ownerMsgs));
  assert.ok(h.ownerMsgs.every(m => /Улица/u.test(m.text)), JSON.stringify(h.ownerMsgs));
  assert.ok(h.operatorLogs.some(l => /PLAN DAY-BEFORE/u.test(l)), h.operatorLogs.join(' | '));

  // A later tick does not repeat it.
  nowRef.t = new Date(2026, 10, 12, 10, 5, 0);
  await h.sched.tick();
  assert.equal(h.clientMsgs.length, 1, `the plan is sent once: ${JSON.stringify(h.clientMsgs)}`);
});

test('the day-before plan: the client hears the route ONCE, each owner his own stop', async () => {
  const nowRef = { t: new Date(2026, 10, 10, 9, 0, 0) }; // Tue 10.11
  const h = makeScheduler(nowRef);
  const appts = new AppointmentStore(h.db);
  const id1 = appts.insert({
    chatId: 'chain', clientName: 'Марко', clientPhone: '070999888', propertyId: 42,
    service: 'Купување', viewingFee: '500 MKD', time: '', agentPhone: '076247467',
  });
  const id2 = appts.insert({
    chatId: 'chain', clientName: 'Марко', clientPhone: '070999888', propertyId: 59,
    service: 'Купување', viewingFee: '500 MKD', time: '', agentPhone: '076247467',
  });
  appts.markFinalized(id1, '');
  appts.markFinalized(id2, '');

  const day = { y: 2026, m: 10, d: 13 }; // Fri 13.11
  await h.sched.arrange({
    appointmentId: id1, chatId: 'chain', eb: 42, time: `Петок, 13.11.2026 во 16:00`,
    agentPhone: '076247467', clientName: 'Марко', clientPhone: '070999888',
    owner: { name: 'Петре', phone: '070111222' },
    chainSize: 2, // the handler's solved route (two stops that day)
  });
  await h.sched.arrange({
    appointmentId: id2, chatId: 'chain', eb: 59, time: `Петок, 13.11.2026 во 17:00`,
    agentPhone: '076247467', clientName: 'Марко', clientPhone: '070999888',
    owner: { name: 'Ана', phone: '070333444' },
    chainSize: 2,
  });

  // Both stops are scheduled a day-before turn.
  const turns = h.db.db.prepare(`SELECT appointment_id as id FROM visit_turns WHERE turn = 'plan_day_before'`)
    .all() as Array<{ id: number }>;
  assert.equal(turns.length, 2, `one day-before turn per stop: ${JSON.stringify(turns)}`);

  // The owners confirm the addresses (the disclosure gate), then the plan fires.
  await h.sched.confirmAddress(id1);
  await h.sched.confirmAddress(id2);
  // The owner's Turn 0 already carries the plan line with address + map.
  assert.ok(h.ownerMsgs.some(m => /PLANIRANA POSETA NA NEDVIZNOST 42/u.test(m.text) && /google\.com\/maps|maps/u.test(m.text)),
    JSON.stringify(h.ownerMsgs));

  h.clientMsgs.length = 0;
  h.ownerMsgs.length = 0;
  assert.equal(await h.sched.forceTurn(id1, 'plan_day_before'), true);
  assert.equal(await h.sched.forceTurn(id2, 'plan_day_before'), true);

  // The client gets the route once: both EBs and both hours in one message.
  assert.equal(h.clientMsgs.length, 1, `one client plan message, got ${JSON.stringify(h.clientMsgs)}`);
  const plan = h.clientMsgs[0]!;
  assert.match(plan, /PLANIRANA POSETA NA NEDVIZNOST 42/u, plan);
  assert.match(plan, /PLANIRANA POSETA NA NEDVIZNOST 59/u, plan);
  assert.match(plan, /16:00/u, plan);
  assert.match(plan, /17:00/u, plan);
  // The client's copy carries NO street (his Turn 3 owns the disclosure).
  assert.doesNotMatch(plan, /Улица 42|Улица 59/u, `no address to the client: ${plan}`);
  // Each owner hears about HIS stop, with the address and the map.
  assert.equal(h.ownerMsgs.length, 2, JSON.stringify(h.ownerMsgs));
  assert.ok(h.ownerMsgs.some(m => m.eb === 42 && /NEDVIZNOST 42/u.test(m.text) && /Улица 42/u.test(m.text)));
  assert.ok(h.ownerMsgs.some(m => m.eb === 59 && /NEDVIZNOST 59/u.test(m.text) && /Улица 59/u.test(m.text)));
  // The operator log names the turn.
  assert.ok(h.operatorLogs.some(l => /PLAN DAY-BEFORE/u.test(l)), h.operatorLogs.join(' | '));
});
