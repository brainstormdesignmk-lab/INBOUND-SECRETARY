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
import { parseVisitDateTime, formatVisitDate } from '../src/visits/time';
import { tableLandmark, tableNeighborhood, NEIGHBORHOOD_LANDMARKS } from '../src/geo/landmarkTable';
import { LandmarkService, sanitizeLandmarkAnswer } from '../src/geo/landmarks';
import { VisitScheduler } from '../src/visits/scheduler';
import { LandmarkStore, landmarkCacheKey } from '../src/geo/landmarks';
import { detectOwnerVerdict } from '../src/llm/deterministic';

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

test('parseVisitDateTime: unresolvable phrases return undefined (degrade gracefully)', () => {
  assert.equal(parseVisitDateTime('по договор', NOW), undefined);
  assert.equal(parseVisitDateTime('викенд', NOW), undefined);
  assert.equal(parseVisitDateTime('', NOW), undefined);
});

test('formatVisitDate: Macedonian weekday + date + time', () => {
  assert.equal(formatVisitDate(new Date(2026, 7, 21, 17, 30)), 'Петок, 21.08.2026 во 17:30');
});

// --- landmark resolver (offline layers) --------------------------------------
test('landmark table: deterministic per-neighborhood landmarks', () => {
  const a = tableLandmark(53, 'Аеродром')!;
  const b = tableLandmark(53, 'Аеродром')!;
  assert.ok(a && b && a.landmark === b.landmark, 'same EB -> same landmark');
  assert.ok(['Трговскиот центар „Веро Центар“', 'Паркот Аеродром', 'Автобуската станица на Аеродром'].includes(a.landmark));
  assert.equal(tableLandmark(53, 'Непозната Насе') , undefined);
  assert.equal(tableNeighborhood('Карпош III'), 'карпош');
  assert.equal(tableNeighborhood('Кисела Вода'), 'кисела вода');
});

test('LandmarkService: table hit, cache, and the Hermes seam (no network)', async () => {
  const db = new Db(':memory:');
  const hermes: Array<{ address?: string; location?: string }> = [];
  const svc = new LandmarkService(db, { osm: false, onHermesRequest: o => hermes.push(o) });

  // Карпош III is in the table -> instant, cached, no live layer.
  const l = await svc.resolve({ eb: 54, address: 'Партизанска', location: 'Карпош III' });
  assert.equal(l.source, 'table');
  assert.ok(l.landmark.length > 0);
  const again = await svc.resolve({ eb: 54, address: 'Партизанска', location: 'Карпош III' });
  assert.equal(again.landmark, l.landmark);
  assert.equal(hermes.length, 0);

  // Unknown neighborhood, no google key, osm off -> the Hermes contract fires.
  const none = await svc.resolve({ eb: 1, address: 'X', location: 'Непознато Место' });
  assert.equal(none.source, 'none');
  assert.equal(hermes.length, 1);
  db.close();
});

test('landmark table: NO entry may ever be a street name (address privacy)', () => {
  // Regression: "Булеварот Партизански Одреди" was seeded as a Кисела Вода
  // landmark — the exact street must never be offered as the approximate
  // location. Every entry in every neighborhood is a PUBLIC PLACE.
  const streetRe = /(?<![А-Яа-яA-Za-z])(?:улиц(?:а|и|ата|ите)|булевар(?:от|и)?|бул\.?|ул\.?|пат(?:от|и)?|street|boulevard)(?![А-Яа-яA-Za-z])/i;
  for (const [nb, opts] of Object.entries(NEIGHBORHOOD_LANDMARKS)) {
    for (const o of opts) {
      assert.ok(!streetRe.test(o.landmark), `${nb} -> "${o.landmark}" is a street!`);
    }
  }
  // Кисела Вода now offers real public places (park / school), never a булевар.
  const kv = NEIGHBORHOOD_LANDMARKS['кисела вода'].map(o => o.landmark);
  assert.ok(!kv.some(l => /булевар|Партизански/.test(l)), JSON.stringify(kv));
  assert.ok(kv.some(l => /Парк|ОУ|Стадион|Клинички/.test(l)), JSON.stringify(kv));
  const centar = NEIGHBORHOOD_LANDMARKS['центар'].map(o => o.landmark);
  assert.ok(centar.includes('Плоштад „Македонија“'), JSON.stringify(centar));
  assert.ok(centar.includes('Универзална сала'), JSON.stringify(centar));
});

test('LandmarkService: a cached table landmark that left the TABLE is re-resolved (never stale)', async () => {
  const db = new Db(':memory:');
  const store = new LandmarkStore(db);
  const svc = new LandmarkService(db, { osm: false });
  const key = landmarkCacheKey({ eb: 12, address: 'X', location: 'Центар' });

  // Simulate a row cached with a landmark that is NOT in the current table.
  store.put(key, { landmark: 'Непостоечко место', type: 'culture', source: 'table' });
  const fresh = await svc.resolve({ eb: 12, address: 'X', location: 'Центар' });
  assert.notEqual(fresh.landmark, 'Непостоечко место', fresh.landmark);
  assert.ok(['Градскиот трговски центар (ГТЦ)', 'Градската болница', 'Хотел „Парк“',
    'Македонската опера и балет', 'Плоштад „Македонија“', 'Универзална сала'].includes(fresh.landmark), fresh.landmark);
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

test('LandmarkService: a Hermes-sourced row upgrades the coarse table row', async () => {
  const db = new Db(':memory:');
  const svc = new LandmarkService(db, { osm: false });
  // first resolve -> coarse table fallback (offline layers all fail)
  const coarse = await svc.resolve({ eb: 63, address: 'Македонија', location: 'Центар (населба)' });
  assert.equal(coarse.source, 'table');
  // Hermes writes its precise answer over the same key
  const store = new LandmarkStore(db);
  store.put(landmarkCacheKey({ address: 'Македонија', location: 'Центар (населба)' }), {
    landmark: 'Кафе бар Ван Гог', type: 'llm', source: 'hermes',
  });
  const upgraded = await svc.resolve({ eb: 63, address: 'Македонија', location: 'Центар (населба)' });
  assert.equal(upgraded.source, 'hermes');
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

  // Turn 1: both parties + operator log, exactly once.
  assert.equal(ownerMsgs.length, 1);
  assert.ok(ownerMsgs[0].includes('ДОГОВОРЕНА ПОСЕТА НА ЕВИДЕНТЕН БРОЈ 53'), ownerMsgs[0]);
  assert.ok(ownerMsgs[0].includes('17.08.2026'), ownerMsgs[0]);
  assert.equal(clientMsgs.length, 1);
  assert.ok(clientMsgs[0].includes('ДОГОВОРЕНА ПОСЕТА НА ЕВИДЕНТЕН БРОЈ 53'), clientMsgs[0]);
  assert.ok(operatorLogs[0].includes('ARRANGED VISIT'), operatorLogs[0]);
  assert.ok(operatorLogs[0].includes('Петре (070111222)'), operatorLogs[0]);
  assert.ok(operatorLogs[0].includes('Марко (070333444)'), operatorLogs[0]);

  // Turns 2+3 scheduled: confirm 10:00 (afternoon visit), location 14:00.
  const turns = db.db.prepare(`SELECT turn, scheduled_at, status FROM visit_turns WHERE appointment_id = ? ORDER BY turn`).all(apptId) as any[];
  assert.equal(turns.length, 2);
  const confirm = turns.find(t => t.turn === 'confirm')!;
  const location = turns.find(t => t.turn === 'location')!;
  assert.equal(confirm.scheduled_at, new Date(2026, 7, 17, 10, 0).getTime());
  assert.equal(location.scheduled_at, new Date(2026, 7, 17, 14, 0).getTime()); // 16:00 - 2h

  // tick before the times -> nothing fires.
  clock = new Date(2026, 7, 17, 9, 0);
  await sched.tick();
  assert.equal(ownerMsgs.length, 1);
  assert.equal(clientMsgs.length, 1);

  // 10:00 -> morning confirmation + client followup + operator turn 2.
  clock = new Date(2026, 7, 17, 10, 0);
  await sched.tick();
  assert.equal(ownerMsgs.length, 2);
  assert.ok(ownerMsgs[1].includes('АГЕНТ ЗА КОНТАКТ 076247467'), ownerMsgs[1]);
  assert.ok(clientMsgs[1].includes('АГЕНТ ЗА КОНТАКТ 076247467'), clientMsgs[1]);
  assert.ok(clientMsgs[2].includes('2 часа пред посетата'), clientMsgs[2]); // followup
  assert.ok(operatorLogs[1].includes('VISIT CONFIRMATION 2 TURN'), operatorLogs[1]);

  // Idempotent: another tick at 10:00 sends nothing new.
  await sched.tick();
  assert.equal(ownerMsgs.length, 2);
  assert.equal(clientMsgs.length, 3);

  // 14:00 -> the EXACT location + maps link + operator turn 3.
  clock = new Date(2026, 7, 17, 14, 0);
  await sched.tick();
  assert.equal(ownerMsgs.length, 3);
  assert.ok(ownerMsgs[2].includes('ЛОКАЦИЈА ЗА ЕВИДЕНТЕН БРОЈ 53'), ownerMsgs[2]);
  // the REAL address goes out as a GOOGLE MAPS link (the only link a customer
  // ever gets) — the query carries the address, never an openstreetmap URL
  assert.ok(ownerMsgs[2].includes('google.com/maps'), ownerMsgs[2]);
  assert.ok(!ownerMsgs[2].includes('openstreetmap'), ownerMsgs[2]);
  const locLink = ownerMsgs[2].split('\n').pop()!;
  assert.ok(locLink.startsWith('https://www.google.com/maps/search/'), locLink);
  assert.ok(decodeURIComponent(locLink).includes('Бисер'), locLink); // the real street
  assert.ok(clientMsgs[3].includes('ЛОКАЦИЈА'), clientMsgs[3]);
  assert.ok(operatorLogs[2].includes('3 TURN LOCATION SENT'), operatorLogs[2]);
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
  await send('DA, SE SOGLASUVAM');
  await send('MARKO 078/914 196');
  let s = await send('UTRE POPLADNE');
  assert.equal(s.state, 'owner_checking');

  handler.ownerAnswer(chatId, 53, detectOwnerVerdict('da, moze', s.slots.visitTime ?? '')!);
  await new Promise(r => setTimeout(r, 50));
  s = sessions.get(chatId)!;
  assert.equal(s.state, 'pending'); // visit confirmed

  // The client got the confirmation AND the arranged-protocol message; the
  // owner got ДОГОВОРЕНА ПОСЕТА; the operator got the ARRANGED log.
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
