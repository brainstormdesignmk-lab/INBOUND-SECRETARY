import { test } from 'node:test';
import assert from 'node:assert';
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
import { parseVisitDateTime, formatVisitDate, hasClockHint } from '../src/visits/time';
import { normalizeOwnerTime } from '../src/llm/prompts';
import { LandmarkService, sanitizeLandmarkAnswer } from '../src/geo/landmarks';
import { VisitScheduler } from '../src/visits/scheduler';
import { LandmarkStore } from '../src/geo/landmarks';
import { detectOwnerVerdict, detectOwnerAddressReply } from '../src/llm/deterministic';

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

// A fixed "now" for everything time-dependent in this file.
const NOW = new Date(2026, 7, 16, 10, 0, 0); // Sunday 2026-08-16 10:00

// --- parseVisitDateTime ------------------------------------------------------
test('parseVisitDateTime: resolves Macedonian day names, relatives and clocks', () => {
  const p = (t: string) => parseVisitDateTime(t, NOW)!;

  assert.deepEqual(p('утре во 17:30'), new Date(2026, 7, 17, 17, 30));
  assert.deepEqual(p('УТРЕ ПОПЛАДНЕ'), new Date(2026, 7, 17, 16, 0));
  assert.deepEqual(p('утре на пладне'), new Date(2026, 7, 17, 12, 0));
  assert.deepEqual(p('задутре'), new Date(2026, 7, 18, 12, 0)); // date alone -> midday
  // Sunday 16.08 -> next Friday is 21.08
  assert.deepEqual(p('петок во 11'), new Date(2026, 7, 21, 11, 0));
  assert.deepEqual(p('сабота попладне'), new Date(2026, 7, 22, 16, 0));
  assert.deepEqual(p('petok vo 17:30'), new Date(2026, 7, 21, 17, 30)); // latin
  // bare clock: today if still ahead, else tomorrow
  assert.deepEqual(p('17:30'), new Date(2026, 7, 16, 17, 30));
  assert.deepEqual(p('во 19:00'), new Date(2026, 7, 16, 19, 0));
  // explicit date
  assert.deepEqual(p('11.06.2026 во 10:00'), new Date(2026, 5, 11, 10, 0));
  // day name for today, already past -> next week
  assert.deepEqual(p('недела во 09:00'), new Date(2026, 7, 23, 9, 0)); // 16.08 is Sunday
});

test('parseVisitDateTime: day + trailing bare hour + day typos — the [12:42] transcript', () => {
  const p = (t: string) => parseVisitDateTime(t, NOW)!;
  // "PONEDELIK 6" — the n→k day typo + trailing bare hour = Понеделник 18:00
  // (1–7 shift PM: viewings happen in the afternoon).
  assert.deepEqual(p('PONEDELIK 6'), new Date(2026, 7, 17, 18, 0));
  assert.deepEqual(p('DA\nPONEDELIK 6'), new Date(2026, 7, 17, 18, 0));
  assert.deepEqual(p('понеделк 6'), new Date(2026, 7, 17, 18, 0));
  assert.deepEqual(p('ponedenik 6'), new Date(2026, 7, 17, 18, 0));
  assert.deepEqual(p('sabota 6'), new Date(2026, 7, 22, 18, 0));
  // 8–11 stay morning: "petok 9" = 09:00, "петок 19" = 19:00
  assert.deepEqual(p('petok 9'), new Date(2026, 7, 21, 9, 0));
  assert.deepEqual(p('петок 19'), new Date(2026, 7, 21, 19, 0));
  // money tails are NOT hours ("11.06" hits the pre-existing HH:MM-shaped
  // arm — a dotted pair next to a day is a date, parsed date-first)
  assert.equal(hasClockHint('sabota 350 evra'), false);
  assert.equal(parseVisitDateTime('petok 11.06', NOW)!.getDate(), 11, 'the dotted pair stays a DATE');
  // hasClockHint sees the trailing-hour form (the split-intake never re-asks)
  assert.equal(hasClockHint('PONEDELIK 6'), true);
  assert.equal(hasClockHint('DA\nPONEDELIK 6'), true);
  // canonical owner-ask display: day typo fixed + resolved date
  assert.equal(normalizeOwnerTime('PONEDELIK 6', NOW), 'Понеделник, 17.08.2026 во 18:00');
});

test('parseVisitDateTime: unresolvable phrases return undefined (degrade gracefully)', () => {
  assert.equal(parseVisitDateTime('по договор', NOW), undefined);
  assert.equal(parseVisitDateTime('викенд', NOW), undefined);
  assert.equal(parseVisitDateTime('', NOW), undefined);
});

test('formatVisitDate: Macedonian weekday + date + time', () => {
  assert.equal(formatVisitDate(new Date(2026, 7, 21, 17, 30)), 'Петок, 21.08.2026 во 17:30');
});

// --- landmark resolver (offline layers) --------------------------------------
test('LandmarkService: cached landmark is deterministic (same property → same answer)', async () => {
  const db = new Db(':memory:');
  const svc = new LandmarkService(db);
  // A cache row (written by the import hook or cron drain) is served on every
  // resolve — same property → same landmark; unknown ones are never fabricated.
  const store = new LandmarkStore(db);
  store.put(53, { landmark: 'Паркот Авионче', type: 'park', source: 'offline' }, 'osm_poi');
  const a = await svc.resolve({ id: 53, eb: 53, address: 'Бисер', location: 'Аеродром', geo_source: 'osm_building' });
  const b = await svc.resolve({ id: 53, eb: 53, address: 'Бисер', location: 'Аеродром', geo_source: 'osm_building' });
  assert.ok(a.landmark && a.landmark === b.landmark, 'same property -> same landmark');
  assert.equal(a.landmark, 'Паркот Авионче');
  // Unknown property/location -> honest none (the removed table used to guess
  // per-neighborhood; the new chain never fabricates).
  const none = await svc.resolve({ eb: 9999, address: 'Непознато', location: 'Непозната Насе' });
  assert.equal(none.source, 'none');
  assert.equal(none.landmark, '');
  db.close();
});

test('LandmarkService: DB-only chain — no feed/offline map → honest none, nothing cached or fired', async () => {
  const db = new Db(':memory:');
  const svc = new LandmarkService(db);

  // No feed landmarks, no offline map, no cache row -> the runtime chain has
  // nothing left to fabricate a landmark from (table + OSM/Google layers were
  // removed) -> honest 'none'. The caller serves the "населба" fallback.
  const none = await svc.resolve({ eb: 1, address: 'X', location: 'Непознато Место' });
  assert.equal(none.source, 'none');
  assert.equal(none.landmark, '');
  db.close();
});

test('LandmarkService: a street name is NEVER served as a landmark (address privacy)', async () => {
  const db = new Db(':memory:');
  const svc = new LandmarkService(db);
  // Regression: "Булеварот Партизански Одреди" was once offered as a Кисела
  // Вода landmark. The street guard now lives in publicPlace(), applied to
  // EVERY layer — a feed entry that is a street is rejected, never served.
  const street = await svc.resolve({
    eb: 53, location: 'Кисела Вода',
    landmarks: [{ landmark: 'Булеварот Партизански Одреди', type: 'road', distance_m: 100 }],
  });
  assert.equal(street.source, 'none', 'street feed landmark must be rejected');
  assert.equal(street.landmark, '');
  // A real public place passes the same guard and is served.
  const place = await svc.resolve({
    eb: 54, location: 'Кисела Вода',
    landmarks: [{ landmark: 'Градскиот парк', type: 'park', distance_m: 200 }],
  });
  assert.equal(place.source, 'feed');
  assert.equal(place.landmark, 'Градскиот парк');
  db.close();
});

test('LandmarkService: a cached osm_poi landmark is served (no TTL — freshness from cron)', async () => {
  const db = new Db(':memory:');
  const store = new LandmarkStore(db);
  const svc = new LandmarkService(db, { osm: false });
  // Cache a landmark with osm_poi tier — once cached, it stays until cron refreshes
  store.put(999, { landmark: 'Непостоечко место', type: 'culture', source: 'offline' }, 'osm_poi');
  const cached = await svc.resolve({ id: 999, eb: 12, address: 'X', location: 'Центар', geo_source: 'stored' });
  // With the new tier system, osm_poi is served (center trusted by default in resolve)
  assert.equal(cached.landmark, 'Непостоечко место');
  assert.equal(cached.source, 'offline');
});

test('sanitizeLandmarkAnswer: cleans names and REJECTS the street (address privacy)', () => {
  // clean answers pass through
  assert.equal(sanitizeLandmarkAnswer('Кафе бар Ван Гог', 'Булевар Партизански'), 'Кафе бар Ван Гог');
  assert.equal(sanitizeLandmarkAnswer('1. Општина Центар', 'Партизанска'), 'Општина Центар');
  assert.equal(sanitizeLandmarkAnswer('„Градскиот трговски центар“', 'Бисер'), 'Градскиот трговски центар');
  // multi-line LLM spill -> first line only
  assert.equal(sanitizeLandmarkAnswer('City Mall\nОва е најблиското место', 'Партизанска'), 'City Mall');
  // THE STREET MUST NEVER LEAK — reject answers containing it (case/space-insensitive)
  assert.equal(sanitizeLandmarkAnswer('во близина на Бисер', 'Бисер'), undefined);
  assert.equal(sanitizeLandmarkAnswer('Партизанска бр. 5', 'Партизанска'), undefined);
  // junk / empty
  assert.equal(sanitizeLandmarkAnswer('   ', 'Бисер'), undefined);
  assert.equal(sanitizeLandmarkAnswer('!!!', 'Бисер'), undefined);
});

test('LandmarkService: a cached higher-tier row is served (upgrade-only cache holds)', async () => {
  const db = new Db(':memory:');
  const svc = new LandmarkService(db);
  // First resolve with nothing available -> honest none (no table layer anymore).
  const coarse = await svc.resolve({ eb: 63, address: 'Македонија', location: 'Центар (населба)' });
  assert.equal(coarse.source, 'none');
  // A cache row written for property.id (by the cron drain or import hook) is
  // served on the next resolve — the tier gate (extract ≥ osm_poi) allows it.
  const store = new LandmarkStore(db);
  store.put(998, { landmark: 'Кафе бар Ван Гог', type: 'poi', source: 'offline' }, 'extract');
  const upgraded = await svc.resolve({ id: 998, eb: 63, address: 'Македонија', location: 'Центар (населба)' });
  assert.equal(upgraded.source, 'offline');
  assert.equal(upgraded.landmark, 'Кафе бар Ван Гог');
  db.close();
});

// --- VisitScheduler turns ----------------------------------------------------
test('visit protocol: arranged -> morning confirm (10:00 for afternoon) -> location 2h before', async () => {
  const db = new Db(':memory:');
  const events = new EventStore(db);
  const owners = new OwnerStore(db);
  owners.upsert({ eb: 53, name: 'Петре', phone: '070111222', status: 'available' });
  const props = new FakeProps(ROWS);

  const clientMsgs: string[] = [];
  const ownerMsgs: string[] = [];
  const operatorLogs: string[] = [];
  let clock = NOW;
  const sched = new VisitScheduler({
    db, events, owners, properties: props,
    notifyClient: async (chatId, text) => { clientMsgs.push(`[${chatId}] ${text}`); },
    notifyOwner: async (_chatId, eb, text) => { ownerMsgs.push(`[EB ${eb}] ${text}`); },
    notifyOperator: async text => { operatorLogs.push(text); },
    now: () => clock,
  });

  // The appointment exists and is finalized (as confirmVisit does); the visit
  // protocol schedules its timed turns against this row.
  const appts = new AppointmentStore(db);
  const apptId = appts.insert({
    chatId: 'c1', clientName: 'Марко', clientPhone: '070333444', propertyId: 53,
    service: 'Купување', viewingFee: '500 MKD', time: 'утре попладне', agentPhone: '076247467',
  });
  appts.markFinalized(apptId, 'утре попладне');

  // arrange: visit tomorrow (Mon 17.08) afternoon -> 16:00.
  await sched.arrange({
    appointmentId: apptId, chatId: 'c1', eb: 53, time: 'утре попладне',
    agentPhone: '076247467', clientName: 'Марко', clientPhone: '070333444',
    owner: { name: 'Петре', phone: '070111222' },
  });

  // Turn 0: address confirmation sent to OWNER ONLY (with written address + maps link)
  assert.equal(ownerMsgs.length, 1);
  assert.ok(ownerMsgs[0].includes('Ми треба потврда'), ownerMsgs[0]); // address confirm
  assert.ok(ownerMsgs[0].includes('google.com/maps'), ownerMsgs[0]); // maps link
  assert.equal(clientMsgs.length, 0); // client gets NOTHING until owner confirms

  // Owner confirms the address -> Turn 1 fires to BOTH
  await sched.confirmAddress(apptId);
  assert.equal(ownerMsgs.length, 2);
  assert.ok(ownerMsgs[1].includes('ДОГОВОРЕНА ПОСЕТА НА ЕВИДЕНТЕН БРОЈ 53'), ownerMsgs[1]);
  assert.ok(ownerMsgs[1].includes('17.08.2026'), ownerMsgs[1]);
  assert.equal(clientMsgs.length, 1);
  assert.ok(clientMsgs[0].includes('ДОГОВОРЕНА ПОСЕТА НА ЕВИДЕНТЕН БРОЈ 53'), clientMsgs[0]);
  assert.ok(operatorLogs.some(l => l.includes('ARRANGED VISIT')), operatorLogs.join('\n'));
  assert.ok(operatorLogs.some(l => l.includes('Петре (070111222)')), operatorLogs.join('\n'));

  // Turns 2+3 scheduled: confirm 10:00 (afternoon visit), location 14:00.
  const turns = db.db.prepare(`SELECT turn, scheduled_at, status FROM visit_turns WHERE appointment_id = ? ORDER BY turn`).all(apptId) as any[];
  assert.ok(turns.length >= 2); // at least confirm + location
  const confirm = turns.find(t => t.turn === 'confirm')!;
  const location = turns.find(t => t.turn === 'location')!;
  assert.equal(confirm.scheduled_at, new Date(2026, 7, 17, 10, 0).getTime());
  assert.equal(location.scheduled_at, new Date(2026, 7, 17, 14, 0).getTime()); // 16:00 - 2h

  // tick before the times -> nothing fires.
  clock = new Date(2026, 7, 17, 9, 0);
  await sched.tick();
  assert.equal(ownerMsgs.length, 2);
  assert.equal(clientMsgs.length, 1);

  // 10:00 -> morning confirmation + client followup + operator turn 2.
  clock = new Date(2026, 7, 17, 10, 0);
  await sched.tick();
  assert.equal(ownerMsgs.length, 3);
  assert.ok(ownerMsgs[2].includes('АГЕНТ ЗА КОНТАКТ 076247467'), ownerMsgs[2]);
  assert.ok(clientMsgs[1].includes('АГЕНТ ЗА КОНТАКТ 076247467'), clientMsgs[1]);
  assert.ok(clientMsgs[2].includes('2 часа пред посетата'), clientMsgs[2]); // followup
  assert.ok(operatorLogs.some(l => l.includes('VISIT CONFIRMATION 2 TURN')), operatorLogs.join('\n'));

  // Idempotent: another tick at 10:00 sends nothing new.
  await sched.tick();
  assert.equal(ownerMsgs.length, 3);
  assert.equal(clientMsgs.length, 3);

  // 14:00 -> the EXACT location + maps link + operator turn 3.
  clock = new Date(2026, 7, 17, 14, 0);
  await sched.tick();
  assert.equal(ownerMsgs.length, 4);
  assert.ok(ownerMsgs[3].includes('ЛОКАЦИЈА ЗА ЕВИДЕНТЕН БРОЈ 53'), ownerMsgs[3]);
  assert.ok(ownerMsgs[3].includes('google.com/maps'), ownerMsgs[3]);
  // ownerMsgs[3] is the location message (Turn 3)
  const locMsg = ownerMsgs[3];
  assert.ok(locMsg.includes('google.com/maps'), locMsg);
  assert.ok(locMsg.includes('Адреса: Бисер'), locMsg); // written address included
  assert.ok(clientMsgs[3].includes('ЛОКАЦИЈА'), clientMsgs[3]);
  assert.ok(operatorLogs.some(l => l.includes('3 TURN LOCATION SENT')), operatorLogs.join('\n'));
  db.close();
});

test('visit protocol: a vague time still sends turn 1 and tells the operator the rest needs manual handling', async () => {
  const db = new Db(':memory:');
  const events = new EventStore(db);
  const owners = new OwnerStore(db);
  const operatorLogs: string[] = [];
  const sched = new VisitScheduler({
    db, events, owners, properties: new FakeProps(ROWS),
    notifyClient: async () => {}, notifyOwner: async () => {}, notifyOperator: async t => { operatorLogs.push(t); },
    now: () => NOW,
  });
  await sched.arrange({
    appointmentId: 9, chatId: 'c1', eb: 53, time: 'по договор', agentPhone: '',
    clientName: 'Марко', clientPhone: '070333444',
  });
  assert.ok(operatorLogs.some(l => l.includes('по договор') && l.includes('рачна потврда')), operatorLogs.join('\n'));
  const turns = db.db.prepare(`SELECT status FROM visit_turns WHERE appointment_id = 9`).all() as any[];
  assert.ok(turns.length === 2 && turns.every(t => t.status === 'skipped'));
  // forceTurn on a skipped turn is a no-op.
  assert.equal(await sched.forceTurn(9, 'confirm'), false);
  db.close();
});

// --- e2e: the funnel ends in the visit protocol ------------------------------
test('e2e: arranged visit fires ДОГОВОРЕНА ПОСЕТА to owner + client and the operator log', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, props);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });

  const events = new EventStore(db);
  const owners = new OwnerStore(db);
  owners.upsert({ eb: 53, name: 'Петре', phone: '070111222', status: 'available' });
  const clientMsgs: string[] = [];
  const ownerMsgs: string[] = [];
  const operatorLogs: string[] = [];
  const sched = new VisitScheduler({
    db, events, owners, properties: props,
    notifyClient: async (chatId, text) => { clientMsgs.push(`[${chatId}] ${text}`); },
    notifyOwner: async (_chatId, eb, text) => { ownerMsgs.push(`[EB ${eb}] ${text}`); },
    notifyOperator: async t => { operatorLogs.push(t); },
    now: () => NOW,
  });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
    visits: sched,
  });

  const chatId = 'visite2e';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 53');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA'); // confirm owner contact
  await send('DA, SE SOGLASUVAM');
  await send('MARKO 078/914 196');
  let s = await send('UTRE POPLADNE');
  assert.equal(s.state, 'owner_checking');

  handler.ownerAnswer(chatId, 53, detectOwnerVerdict('da, moze', s.slots.visitTime ?? '')!);
  await new Promise(r => setTimeout(r, 50));
  s = sessions.get(chatId)!;
  assert.equal(s.state, 'pending'); // visit confirmed

  // Turn 0: address confirm sent to OWNER (not client yet)
  assert.ok(ownerMsgs.some(m => m.includes('Ми треба потврда')), ownerMsgs.join('\n'));
  assert.ok(ownerMsgs.some(m => m.includes('google.com/maps')), ownerMsgs.join('\n'));
  // Client does NOT have ДОГОВОРЕНА ПОСЕТА yet (waiting for owner address confirm)
  assert.ok(!clientMsgs.some(m => m.includes('ДОГОВОРЕНА ПОСЕТА')), clientMsgs.join('\n'));

  // Owner confirms address -> Turn 1 fires to BOTH
  const apptId2 = new AppointmentStore(db).listByChat(chatId)[0].id;
  await sched.confirmAddress(apptId2);
  assert.ok(clientMsgs.some(m => m.includes('ДОГОВОРЕНА ПОСЕТА НА ЕВИДЕНТЕН БРОЈ 53')), clientMsgs.join('\n'));
  assert.ok(ownerMsgs.some(m => m.includes('ДОГОВОРЕНА ПОСЕТА НА ЕВИДЕНТЕН БРОЈ 53')), ownerMsgs.join('\n'));
  assert.ok(operatorLogs.some(l => l.includes('ARRANGED VISIT')), operatorLogs.join('\n'));
  // turns exist for the timed protocol
  const turns = db.db.prepare(`SELECT turn FROM visit_turns`).all() as any[];
  assert.ok(turns.some(t => t.turn === 'confirm') && turns.some(t => t.turn === 'location'));

  // The client's confirmed time "утре попладне" is stored on the appointment.
  const rows = new AppointmentStore(db).listByChat(chatId);
  assert.equal(rows.length, 1);
  assert.ok(rows[0].time!.includes('UTRE'), JSON.stringify(rows[0]));
  db.close();
});

// --- e2e regression: the SREDA ping-pong bug + the Turn-0 address seam -------
// Field transcript (18:50): client proposes УТРЕ ВО 4 → owner refuses with
// "NEMOZAM UTRE VO 4, DOGOVORI GO SREDA VO 6" → Lina must counter with СРЕДА ВО 6
// (never the refused term), and after booking, the owner's Turn-0 address
// CORRECTION must be applied — not dropped with "нема активна проверка".
test('e2e regression: refused-time ping-pong counters СРЕДА ВО 6, and the owner address correction lands', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, props);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });

  const events = new EventStore(db);
  const owners = new OwnerStore(db);
  owners.upsert({ eb: 78, name: 'Стојан', phone: '070999888', status: 'available' });
  const clientMsgs: string[] = [];
  const ownerMsgs: string[] = [];
  const operatorLogs: string[] = [];
  let clock = NOW;
  const sched = new VisitScheduler({
    db, events, owners, properties: props,
    notifyClient: async (chatId, text) => { clientMsgs.push(`[${chatId}] ${text}`); },
    notifyOwner: async (_chatId, eb, text) => { ownerMsgs.push(`[EB ${eb}] ${text}`); },
    notifyOperator: async t => { operatorLogs.push(t); },
    now: () => clock,
  });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
    visits: sched,
  });

  const chatId = 'sreda-e2e';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // 1) Funnel to the visit proposal: client wants EB 78, proposes УТРЕ ВО 4.
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA');
  await send('DA, SE SOGLASUVAM');
  await send('MARKO 078/914 196');
  let s = await send('UTRE VO 4');
  assert.equal(s.state, 'owner_checking', `expected owner_checking, got ${s.state}`);

  // 2) THE SREDA BUG: owner refuses the proposed term AND counter-proposes.
  //    The counter must carry СРЕДА ВО 6 — never the refused УТРЕ ВО 4.
  const verdict = detectOwnerVerdict('NEMOZAM UTRE VO 4, DOGOVORI GO SREDA VO 6', 'Утре во 4');
  assert.ok(verdict, 'owner verdict must be detected');
  assert.equal(verdict!.status, 'counter', JSON.stringify(verdict));
  assert.equal(verdict!.ownerTime, 'Среда во 6', JSON.stringify(verdict));
  assert.ok(!/утре\s+во\s+4/i.test(verdict!.ownerTime ?? ''), 'the REFUSED term must never become the counter');

  handler.ownerAnswer(chatId, 78, verdict!);
  await new Promise(r => setTimeout(r, 50));
  s = sessions.get(chatId)!;
  assert.equal(s.state, 'time_confirm', `client must sit in time_confirm, got ${s.state}`);
  assert.ok(sent.some(t => t.includes('Среда во 6')), `client relay must carry the counter, got: ${sent.join(' | ')}`);

  // 3) Client accepts the COUNTER → visit booked at Среда во 6.
  s = await send('SREDA VO 6 E OK');
  assert.equal(s.state, 'pending', `expected pending after accepting the counter, got ${s.state}`);
  const apptRows = new AppointmentStore(db).listByChat(chatId);
  assert.equal(apptRows.length, 1, 'exactly one appointment');
  assert.ok(/среда/i.test(apptRows[0].time ?? ''), `booked time must be the counter Среда во 6, got ${JSON.stringify(apptRows[0])}`);
  assert.ok(!/утре/i.test(apptRows[0].time ?? ''), 'the refused term must not be booked');
  const apptId = apptRows[0].id;

  // 4) Turn 0: address confirmation goes to the OWNER (client still silent).
  assert.ok(ownerMsgs.some(m => m.includes('Ми треба потврда')), ownerMsgs.join(' | '));
  assert.ok(!clientMsgs.some(m => m.includes('ДОГОВОРЕНА ПОСЕТА')), clientMsgs.join(' | '));

  // 5) The OWNER SEAM: the address-confirmation ask is discoverable by chat,
  //    the owner's correction parses deterministically, and confirmAddress
  //    applies it — the old code dropped this reply with "нема активна проверка".
  const pendingAppt = sched.pendingAddressConfirm(chatId);
  assert.equal(pendingAppt, apptId, 'Turn-0 must be discoverable for this chat');
  const addrReply = detectOwnerAddressReply('ne, ulicata e Vasil Stefanovski 16');
  assert.ok(addrReply, 'owner correction must parse');
  assert.equal(addrReply!.status, 'correct', JSON.stringify(addrReply));
  assert.ok(/Vasil\s+Stefanovski\s+16/i.test(addrReply!.address ?? ''), JSON.stringify(addrReply));
  const confirmed = await sched.confirmAddress(apptId, addrReply!.address);
  assert.equal(confirmed, true, 'confirmAddress must resolve the pending Turn-0');

  // 6) After the correction: Turn 1 fires to BOTH, correction logged, and the
  //    corrected address is stored on the appointment.
  assert.ok(clientMsgs.some(m => m.includes('ДОГОВОРЕНА ПОСЕТА НА ЕВИДЕНТЕН БРОЈ 78')), clientMsgs.join(' | '));
  assert.ok(operatorLogs.some(l => l.includes('ADDRESS CORRECTED')), operatorLogs.join(' | '));
  const after = db.db.prepare(`SELECT corrected_address FROM appointments WHERE id = ?`).get(apptId) as { corrected_address: string | null };
  assert.equal(after.corrected_address, 'Vasil Stefanovski 16', JSON.stringify(after));

  // 7) The location turn (visit − 2h) uses the CORRECTED address, not the feed's.
  //    "Среда во 6" books at 18:00 (the [12:42] PM shift: a bare hour after a
  //    day word means the AFTERNOON — viewings never happen at 06:00) →
  //    Wed 19.08 18:00 → location turn at 16:00. (The visitEnded guard
  //    refuses turns after the visit has passed — the clock must land before
  //    18:00.)
  clock = new Date(2026, 7, 19, 16, 0);
  await sched.tick();
  const locMsg = clientMsgs.find(m => m.includes('ЛОКАЦИЈА'));
  assert.ok(locMsg, `location turn must fire, got: ${clientMsgs.join(' | ')}`);
  assert.ok(locMsg!.includes('Vasil Stefanovski 16'), `location must carry the CORRECTED address, got: ${locMsg}`);

  // 8) The seam is one-shot: after resolution nothing is pending.
  assert.equal(sched.pendingAddressConfirm(chatId), null, 'no pending confirm after resolution');
  db.close();
});
