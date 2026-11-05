import { test } from 'node:test';
import assert from 'node:assert';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { AddressChangeStore } from '../src/store/addressChanges';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { EventStore } from '../src/store/events';
import { OwnerStore } from '../src/store/owners';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { parseVisitDateTime, formatVisitDate, hasClockHint, outsideVisitWindow } from '../src/visits/time';
import { normalizeOwnerTime } from '../src/llm/prompts';
import { LandmarkService, sanitizeLandmarkAnswer } from '../src/geo/landmarks';
import { VisitScheduler } from '../src/visits/scheduler';
import { LandmarkStore } from '../src/geo/landmarks';
import { detectOwnerVerdict, detectOwnerAddressReply, hasDayWord, detectVagueTime } from '../src/llm/deterministic';
import { matchesPoolContract } from '../src/data/responseBank';

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

test('the VISIT WINDOW decides AM/PM: a bare 1–8 is PM, and 09:00–21:00 is the whole day', () => {
  const p = (t: string) => parseVisitDateTime(t, NOW);
  // THE OWNER'S RULE ([17:45]): no visit before 09:00 or after 21:00, so the
  // hour frame a bare number can mean is 9…20 — 1–8 are the afternoon/evening
  // side of it.
  assert.deepEqual(p('во 8'), new Date(2026, 7, 16, 20, 0), '«во 8» is 20:00');
  assert.deepEqual(p('7:30'), new Date(2026, 7, 16, 19, 30), '«7:30» is 19:30, never 07:30');
  assert.deepEqual(p('6IPOL'), new Date(2026, 7, 16, 18, 30), '«6IPOL» is 18:30');
  assert.deepEqual(p('петок 4'), new Date(2026, 7, 21, 16, 0), '«петок 4» is 16:00');
  assert.deepEqual(p('POKASNO 7:30'), new Date(2026, 7, 16, 19, 30), 'a bare clock after «покасно»');
  // 9–12 are morning/midday as said; 13–20 are already 24-hour.
  assert.deepEqual(p('петок во 9'), new Date(2026, 7, 21, 9, 0));
  assert.deepEqual(p('петок во 12'), new Date(2026, 7, 21, 12, 0));
  assert.deepEqual(p('петок во 20'), new Date(2026, 7, 21, 20, 0));
  // OUTSIDE THE WINDOW IS NOT A VISIT — the caller asks for another term.
  assert.equal(p('во 8 наутро'), undefined, 'no visit at 08:00');
  assert.equal(p('петок во 22:00'), undefined, 'no visit after 21:00');
  assert.deepEqual(p('петок во 21:00'), new Date(2026, 7, 21, 21, 0));
  // A MORNING WORD keeps the hour literal.
  assert.deepEqual(p('петок наутро во 9'), new Date(2026, 7, 21, 9, 0));
  // The OWNER'S counter is checked against the same window before it is
  // relayed (a visit the window forbids is never offered to the client).
  assert.equal(outsideVisitWindow('петок во 22:00', NOW), true);
  assert.equal(outsideVisitWindow('петок наутро во 8', NOW), true);
  assert.equal(outsideVisitWindow('петок во 16:00', NOW), false);
  assert.equal(outsideVisitWindow('петок', NOW), false, 'no clock → the vague-time lane, not this');
});

test('parseVisitDateTime: spoken half-hour "pet i pol" = 17:30, day-aware — the [22:50] transcript', () => {
  const p = (t: string) => parseVisitDateTime(t, NOW)!;
  // "PA NEKA BIDE PET I POL" (the client refining "VO VTORNIK POSLE 5"): the
  // classifier once read only a bare 5:30 and dropped the day — the owner was
  // asked about НЕДЕЛА 05:30 instead of ВТОРНИК 17:30. The spoken half-hour is
  // an afternoon viewing (PM shift), and the stored day is kept.
  assert.deepEqual(p('PA NEKA BIDE PET I POL'), new Date(2026, 7, 16, 17, 30)); // no day -> today (still ahead)
  assert.deepEqual(p('VTORNIK PET I POL'), new Date(2026, 7, 18, 17, 30));
  assert.deepEqual(p('пет и пол'), new Date(2026, 7, 16, 17, 30));
  // the day survives even when the vague original phrase is merged ahead of it
  assert.deepEqual(p('MOZAM VO VTORNIK POSLE 5 PA NEKA BIDE PET I POL'), new Date(2026, 7, 18, 17, 30));
  // the day-adjacent BARE clock form (the classifier's "5:30") also lands PM
  assert.deepEqual(p('вторник 5:30'), new Date(2026, 7, 18, 17, 30));
  assert.equal(hasClockHint('pet i pol'), true);
  assert.equal(normalizeOwnerTime('VTORNIK PET I POL', NOW), 'Вторник, 18.08.2026 во 17:30');
  // the bedroom fraction ("edna i pol spalni") is NOT a clock
  assert.equal(parseVisitDateTime('edna i pol spalni', NOW), undefined);
});

test('the owner\'s bare hour after «MOZAM» is a counter — «NAKAJ 4» is 16:00, not 04:00', () => {
  // The [17:45] capture: «PETOK NEMA DA MOZAM VO 6 IPOL . MOZAM PORANO ,
  // NAKAJ 4». The proposal clause has no preposition and no colon, so the
  // counter was dropped and the client was asked for another term without
  // ever hearing the owner's offer.
  const v = detectOwnerVerdict('PETOK NEMA DA MOZAM VO 6 IPOL . MOZAM PORANO , NAKAJ 4', 'Петок во 18:30');
  assert.equal(v?.status, 'counter', JSON.stringify(v));
  assert.equal(normalizeOwnerTime(v?.ownerTime ?? '', NOW), 'Петок, 21.08.2026 во 16:00');
  // The same offer written with «do»/«до» instead of the typo.
  const v2 = detectOwnerVerdict('petok ne mozam vo 18:30, mozam porano do 4', 'Петок во 18:30');
  assert.equal(normalizeOwnerTime(v2?.ownerTime ?? '', NOW), 'Петок, 21.08.2026 во 16:00');
  // Money is never a clock: the bare number must not be a price.
  const v3 = detectOwnerVerdict('ne mozam vo 18:30. mozam 400 evra', 'Петок во 18:30');
  assert.equal(v3?.ownerTime, undefined, JSON.stringify(v3));
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

test('sanitizeLandmarkAnswer: the echoed list annotation (type, distance) never reaches the feed', () => {
  // The exact 2026-10-10 EB 94 row: the model echoed the prompt line back, the
  // answer arrived truncated, and the client got a landmark that was half
  // annotation. Balanced and dangling forms must both clean up.
  assert.equal(
    sanitizeLandmarkAnswer('AgroTehnA - Head Office (Shopping mall, 257м', 'Тоне Томшиќ 25'),
    'AgroTehnA - Head Office',
    'the real corrupted feed value must be repaired');
  assert.equal(
    sanitizeLandmarkAnswer('AgroTehnA - Head Office (Shopping mall, 257м)', 'Тоне Томшиќ 25'),
    'AgroTehnA - Head Office');
  assert.equal(sanitizeLandmarkAnswer('Рептил (Supermarket, 21 m)', 'Тоне Томшиќ'), 'Рептил');
  assert.equal(sanitizeLandmarkAnswer('Кафе бар Ван Гог (cafe, 120м)', 'Партизанска'), 'Кафе бар Ван Гог');
  assert.equal(sanitizeLandmarkAnswer('Сити Мол 340м', 'Партизанска'), 'Сити Мол');
  // A quote that OPENS inside the name is content, not decoration: stripping it
  // while removing the trailing „“ would serve a half-quoted name (the live
  // 2026-10-10 feed row „Приватна градинка „Little Me“ did exactly that).
  assert.equal(
    sanitizeLandmarkAnswer('Приватна градинка „Little Me“', 'Кузман Јосифовски Питу'),
    'Приватна градинка „Little Me“');
  assert.equal(sanitizeLandmarkAnswer('„Кафе Мак“', 'Партизанска'), 'Кафе Мак');
  // A parenthetical that is NOT our annotation is part of the name — keep it.
  assert.equal(
    sanitizeLandmarkAnswer('ГТЦ (Градски трговски центар) Скопје', 'Партизанска'),
    'ГТЦ (Градски трговски центар) Скопје',
    'only the numeric (type, distance) annotation is stripped');
  // The street guard still applies AFTER the annotation is stripped.
  assert.equal(sanitizeLandmarkAnswer('Тоне Томшиќ (Supermarket, 21м', 'Тоне Томшиќ'), undefined);
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
  // [22:31] contract: a bare day+period re-asks for the exact hour — the owner
  // never receives an undresolve afternoon.
  const sVague = await send('UTRE POPLADNE');
  assert.equal(sVague.state, 'visit_scheduling');
  // the vague.time pool rotates variants — "точно во колку часот" / "точниот час. Во колку?"
  assert.ok(/точн|колку/iu.test(sent[sent.length - 1] ?? ''), `the exact-clock ask fires: ${sent[sent.length - 1]?.slice(0, 90)}`);
  let s = await send('OKOLU 16');
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
  // Canonical counter display (the [19:29] capture): the relay normalizes
  // the owner's raw counter to day + date + 24h clock — "Среда во 6" becomes
  // "Среда, <next-occurrence date> во 18:00". The raw form still stays in
  // slots.ownerTime, which is what the acceptance step below matches.
  assert.ok(/Среда, \d{2}\.\d{2}\.\d{4} во 18:00/u.test(sent.join(' | ')), `client relay must carry the counter, got: ${sent.join(' | ')}`);

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

  // 6b) …AND THE CORRECTION IS NOW QUEUED FOR THE APP. Storing it on the
  //     appointment only ever fixed turns 2+3 of THIS visit: the public listing
  //     kept the feed's street (EB 78 is "Народен Фронт" in the fixture) forever.
  //     The same 5-minute Hermes pass that carries prices now carries this.
  const addrQueue = new AddressChangeStore(db).listPending();
  assert.equal(addrQueue.length, 1, `the owner correction must be queued for the app: ${JSON.stringify(addrQueue)}`);
  assert.equal(addrQueue[0].eb, 78);
  assert.equal(addrQueue[0].oldAddress, 'Народен Фронт', 'the queue must carry what the app currently has');
  assert.equal(addrQueue[0].newAddress, 'Vasil Stefanovski 16');
  assert.ok(operatorLogs.some(l => l.includes('queued for Hermes to publish')), operatorLogs.join(' | '));

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

// --- the [01:17]/[01:20] capture: the owner ping-pong survives the TTL -------
// Lina relayed the owner's counter and asked for a NEW term at 01:17 — 2h46m
// after the client's last inbound — and his "cetvrtok togas?" 3 minutes later
// hit the 60-minute TTL measured from that stale inbound: the resume bridge
// swallowed a legitimate answer to the pending ask ("Се враќаме на вашиот
// избор" — totally out of context). HER outbound ask re-arms the exchange,
// and the day-only answer must RE-ASK the exact hour, continuing the
// ping-pong — never the bridge.
test('[01:17]/[01:20] the client answering Lina\'s relay is parsed, never the resume bridge', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions,
    classifier: new Classifier(llm, cfg, props),
    responder: new Responder(llm, cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  const chatId = 'ttl-pingpong';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA');
  await send('DA, SE SOGLASUVAM');
  await send('MARKO 078/914 196');
  let s = await send('UTRE VO 4');
  assert.equal(s.state, 'owner_checking');

  // [01:17] The owner refuses the term; Lina relays and asks for a NEW one.
  handler.ownerAnswer(chatId, 78, detectOwnerVerdict('nema da mozam vo sreda', 'Утре во 4')!);
  await new Promise(r => setTimeout(r, 50));
  s = sessions.get(chatId)!;
  const funnelStates = ['visit_scheduling', 'owner_checking', 'time_confirm'];
  assert.ok(funnelStates.includes(s.state), `the relay re-arms the funnel: ${s.state}`);
  // The refusal relay is a ROTATING pool: the contract in responseBank.ts
  // (POOL_CONTRACTS) pins the ask-for-another-term meaning, whatever variant
  // is served this run.
  assert.equal(matchesPoolContract('owner.relay:counter.bare', sent[sent.length - 1]),
    true, `Lina asks the client for a new term: ${sent[sent.length - 1]?.slice(0, 90)}`);
  // The refused term is DISPLAYED in Macedonian AND in canonical form: the
  // client typed "UTRE VO 4" Latin, and the relay used to echo it as a bare
  // phrase. Since the [18:52] contract ONE renderer (renderVisitTerm) renders
  // every term shown to a person, so the client reads the resolved date and
  // clock — «Петок, 06.11.2026 во 16:00» — never «Utре во 4» or «во 6».
  // (Expectation fixed, not the product: the old raw-phrase echo is exactly
  // the shorthand the [18:52] capture complained about.)
  assert.ok(/\d{2}\.\d{2}\.\d{4} во \d{2}:\d{2}/u.test(sent[sent.length - 1] ?? ''),
    `the refused term is rendered with its date and clock: ${sent[sent.length - 1]}`);
  assert.ok(!/UTRE/iu.test(sent[sent.length - 1] ?? ''),
    `no raw Latin in the client-facing relay: ${sent[sent.length - 1]}`);
  assert.ok(!/во 4\b/u.test(sent[sent.length - 1] ?? ''),
    `never a naked hour where 16:00 belongs: ${sent[sent.length - 1]}`);

  // The client had been silent for 2h46m ([22:31] → [01:17]); only the RELAY
  // is fresh. Age the inbound clock to reproduce the 01:20 wall.
  s.lastInboundAt = Date.now() - 166 * 60_000;
  sessions.set(s);

  // [01:20] "cetvrtok togas?" — a day-only counter-proposal, 3 min after the
  // relay. THE FIX: no bridge — the day-only split intake asks for the hour.
  s = await send('cetvrtok togas?');
  assert.equal(matchesPoolContract('vague.time', sent[sent.length - 1]), true,
    `the exact-clock ask continues the ping-pong, never the bridge: ${sent[sent.length - 1]?.slice(0, 120)}`);
  assert.ok(!/Се враќаме|вашиот избор/iu.test(sent[sent.length - 1] ?? ''),
    `no resume bridge on an answer to Lina's ask: ${sent[sent.length - 1]?.slice(0, 120)}`);
  assert.ok(funnelStates.includes(s.state), `still in the visit funnel: ${s.state}`);
  assert.ok(hasDayWord(s.slots.visitTime ?? ''), `the day is armed for the follow-up: ${s.slots.visitTime}`);

  // The hour completes the pair and the owner ask fires with ЧЕТВРТОК.
  const ownerAsks: string[] = [];
  handler.onOwnerAsk = (_c: string, _eb: number, q: string) => { ownerAsks.push(q); };
  await send('OKOLU 16');
  assert.equal(sessions.get(chatId)!.state, 'owner_checking', `the completed term goes to the owner: ${sessions.get(chatId)!.state}`);
  assert.ok(ownerAsks.some(q => /четврток/iu.test(q) && /16/i.test(q)),
    `the owner is asked for ЧЕТВРТОК with the hour, never the refused Среда: ${ownerAsks.join(' | ')}`);
  db.close();
});

// --- the [00:49]/[00:57] capture: day-first split intake ---------------------
// Friday 23.10 00:49: the client asks "ЕВИДЕНТЕН БРОЈ 47 ДАЛИ УШТЕ Е НА
// ПРОДАЖБА?" (masculine frame), and at 00:57 proposes "ВО ПОНЕДЕЛНИК МОЖАМ
// ПОПЛАДНЕ" then "ОКОЛУ 6". Three defects: the no-L day typo (PONEDENIK)
// read day-less so every merge gate treated the stored Monday as day-less;
// "попладне околу 6" shifted PM only for "после"; and the merged phrase was
// re-asked for the clock it had just completed. Owner got "Петок, 23.10.2026
// во 06:00" — must be Понеделник, 26.10.2026 во 18:00.
const NOW_OCT = new Date(2026, 9, 23, 0, 49, 0); // Friday 2026-10-23 00:49

test('[00:57] parse: „понеделник попладне околу 6“ = Понеделник 18:00 (PM shift not only за „после“)', () => {
  const p = (t: string) => parseVisitDateTime(t, NOW_OCT)!;
  assert.deepEqual(p('VO PONEDENIK MOZAM POPLADNE OKOLU 6'), new Date(2026, 9, 26, 18, 0));
  assert.deepEqual(p('понеделник попладне околу 6'), new Date(2026, 9, 26, 18, 0));
  // The day-less lone clock follows the afternoon-viewing convention too —
  // bare „OKOLU 6“ must never read a literal 06:00.
  assert.deepEqual(p('OKOLU 6'), new Date(2026, 9, 23, 18, 0));
  // Minutes keep their MINUTES, the hour follows the visit window: «6:30» is
  // 18:30 (a visit is never made at 06:30 — the window starts at 09:00).
  assert.deepEqual(p('понеделник попладне во 6:30'), new Date(2026, 9, 26, 18, 30));
  // Morning context stays morning.
  assert.deepEqual(p('понеделник утрово во 9'), new Date(2026, 9, 26, 9, 0));
});

test('[00:57] hasDayWord: the no-L „PONEDENIK“ typo is a day word', () => {
  assert.equal(hasDayWord('VO PONEDENIK MOZAM POPLADNE'), true);
  assert.equal(hasDayWord('ponedenik'), true);
  // The whole typo corpus (mkTimePhrase's MK_DAY_FIX), not just понедelnik:
  // a misspelled day must read as day-anchored EVERYWHERE a gate calls
  // hasDayWord — the merge classifiers and the owner-day seed.
  for (const t of ['PONEDELOK VO 3', 'VTORIK VO 4', 'SRETA VO 5',
    'во средта', 'ЦЕТВРТОК', 'NA PETK', 'SUBOTA VO 2', 'nedella']) {
    assert.equal(hasDayWord(t), true, `typo day word required: ${t}`);
  }
});

test('[00:57] detectVagueTime: day + clock is concrete; „после N“ stays vague', () => {
  assert.equal(detectVagueTime('VO PONEDENIK MOZAM POPLADNE OKOLU 6'), false);
  assert.equal(detectVagueTime('ПОНЕДЕЛНИК ВО 19'), false);
  // Day only → the exact-clock ask still fires; relative wording stays vague.
  assert.equal(detectVagueTime('VO PONEDENIK MOZAM POPLADNE'), true);
  assert.equal(detectVagueTime('sabota posle 5'), true);
});

test('[22:31] detectVagueTime: bare day + period has NO clock — the exact-clock ask fires', () => {
  // The [22:31] capture: “sreda popladne” reached the owner as “Среда,
  // 28.10.2026” with no hour — an afternoon is not a term, Lina must ask.
  assert.equal(detectVagueTime('sreda popladne'), true);
  assert.equal(detectVagueTime('SREDA POPLADNE'), true);
  // …a period WITH an hour anchor (“после 6”, “около 6”, a clock) is a term.
  assert.equal(detectVagueTime('utre popladne posle 6'), false);
  assert.equal(detectVagueTime('sreda popladne okolu 6'), false);
});

test('[23:48] detectVagueTime: an OPEN-ENDED window is not a term — the exact hour is re-asked', () => {
  // «SLOBODNA SUM OD 5 SAAT PA NATAKA» was resolved to 17:00 and relayed to the
  // owner as «Понеделник, 02.11.2026 во 17:00» — a time the client never gave.
  // A window START is availability, not an appointment.
  for (const t of [
    'SLOBODNA SUM OD 5 SAAT PA NATAKA',
    'slobodna sum od 5 saat pa nataka',
    'OD 17:00 PA NATAKA',
    'od 5 pa natamu',
    'слободна сум од 5 саат понатака',
    'OD 5 NAVAKA',
  ]) assert.equal(detectVagueTime(t), true, `a window must re-ask the hour: ${t}`);
  // A CLOSED term keeps its lane — no new re-ask on concrete clock/day pairs.
  assert.equal(detectVagueTime('PONEDELNIK VO 17:00'), false);
  assert.equal(detectVagueTime('od 17:00 do 19:00'), false);
  assert.equal(detectVagueTime('VO PONEDENIK MOZAM POPLADNE OKOLU 6'), false);
});

test('[23:48] e2e: the open window never reaches the owner — the exact-hour ask fires first', async () => {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const cfg = loadConfig();
  const props = new FakeProps(ROWS);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const ownerMsgs: string[] = [];
  const sched = new VisitScheduler({
    db, events: new EventStore(db), owners: new OwnerStore(db), properties: props,
    notifyClient: async () => {},
    notifyOwner: async (_chatId, eb, text) => { ownerMsgs.push(`[EB ${eb}] ${text}`); },
    notifyOperator: async () => {},
    now: () => NOW,
  });
  const handler = new InboundHandler({ cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg), properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }), visits: sched,
  });
  const chatId = 'window-2348';
  const s = freshSession('test', chatId);
  s.state = 'visit_scheduling';
  s.slots.propertyId = 78;
  s.slots.interestedPropertyId = 78;
  s.slots.service = 'buy';
  s.slots.viewingFeeAgreed = true;
  s.slots.visitTime = 'Понеделник';
  sessions.set(s);

  await handler.handle('test', chatId, 'SLOBODNA SUM OD 5 SAAT PA NATAKA');
  const after = sessions.get(chatId)!;
  assert.equal(ownerMsgs.length, 0, `the owner was pinged with a term the client never gave: ${ownerMsgs.join(' | ')}`);
  assert.equal(after.state, 'visit_scheduling', `the exact-hour ask must fire first, got ${after.state} (reply: ${sent[sent.length - 1]})`);
  assert.ok(/\?/.test(sent[sent.length - 1] ?? ''), `the turn asks for the exact hour: ${sent[sent.length - 1]}`);
  db.close();
});

test('[00:57] normalizeOwnerTime: the merged pair reaches the owner canonically', () => {
  assert.equal(normalizeOwnerTime('VO PONEDENIK MOZAM POPLADNE OKOLU 6', NOW_OCT), 'Понеделник, 26.10.2026 во 18:00');
});

test('[00:49]/[00:57] e2e: EB ask keeps masculine gender, day-first intake merges onto Monday 18:00', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const rows: Property[] = [
    { eb: 47, id: 47, location: 'Кисела Вода', address: 'Тест', price: 65000, service: 'buy', bedrooms: 2 },
  ];
  const props = new FakeProps(rows);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, props);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const events = new EventStore(db);
  const owners = new OwnerStore(db);
  owners.upsert({ eb: 47, name: 'Стојан', phone: '070999888', status: 'available' });
  const sched = new VisitScheduler({
    db, events, owners, properties: props,
    notifyClient: async () => {},
    notifyOwner: async () => {},
    notifyOperator: async () => {},
    now: () => NOW_OCT,
  });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
    visits: sched,
  });
  const chatId = 'eb47-oct';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // 1) The EB availability ask serves the MASCULINE line — the bank pool is
  //    written for „недвижноста“ (feminine) and may not cover an ask by number.
  await send('EVIDENTEN BROJ 47 DALI USTE E NA PRODAZBA?');
  const ack = sent[sent.length - 1] ?? '';
  assert.ok(/достапен(?!\p{L})/iu.test(ack), `masculine ack expected, got: ${ack}`);
  assert.ok(!/достапна(?!\p{L})/iu.test(ack), ack);

  // 2) The fee gate → contact → scheduling, then the DAY first.
  await send('DA');
  await send('DA, SE SOGLASUVAM');
  await send('MARKO 070111222');
  const s1 = await send('VO PONEDENIK MOZAM POPLADNE');
  assert.equal(s1.state, 'visit_scheduling', 'day-only intake must ask the exact clock, never start the owner ping-pong');
  assert.equal(s1.slots.visitTime, 'VO PONEDENIK MOZAM POPLADNE');

  // 3) The follow-up clock completes the SAME Monday — never today 06:00.
  const s2 = await send('OKOLU 6');
  assert.equal(s2.state, 'owner_checking', `merged intake must reach the owner check, got ${s2.state} (reply: ${sent[sent.length - 1]})`);
  assert.equal(s2.slots.visitTime, 'VO PONEDENIK MOZAM POPLADNE OKOLU 6');
  db.close();
});

test('[21:56] "CETVRTOK POPLADNE MOZAM POSLE 6" is a TERM, never a cancellation — and a cancel touches only the property in play', async () => {
  // The [21:56] capture: Lina asked for a term, the client OFFERED one (Thursday
  // after 6), and the reply was «Откажана посета по желба на клиент за Евидентен
  // број 47» — a different property's leftover visit cancelled on a proposal.
  // Two causes, and they compound: the unbounded «не мозам» arm matched INSIDE
  // «попладне мозам» (normalizeMc folds «mozam» to «мозам», so «…дне мозам» read
  // as a negation), and the branch then cancelled whatever finalized appointment
  // the chat had — the leftover EB 47, not the EB 62 house being discussed.
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const appointments = new AppointmentStore(db);
  const events = new EventStore(db);
  const owners = new OwnerStore(db);
  const cfg = loadConfig();
  const props = new FakeProps(ROWS);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const ownerMsgs: string[] = [];
  const sched = new VisitScheduler({
    db, events, owners, properties: props,
    notifyClient: async (chatId, text) => { sent.push(`[${chatId}] ${text}`); },
    notifyOwner: async (_chatId, eb, text) => { ownerMsgs.push(`[EB ${eb}] ${text}`); },
    notifyOperator: async () => {},
    now: () => NOW,
  });
  const handler = new InboundHandler({ cfg, db, sessions, classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg), properties: props,
    appointments, escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }), visits: sched,
  });

  const chatId = 'visit-2156';
  // A leftover finalized visit for ANOTHER property (the 47 of the capture)…
  const staleId = appointments.insert({ chatId, clientName: 'X', clientPhone: '070111222', propertyId: 47, service: 'rent', viewingFee: '300', time: 'сабота во 12:00', agentPhone: null });
  appointments.markFinalized(staleId, 'сабота во 12:00');
  // …and the arranged visit for the property in play.
  const liveId = appointments.insert({ chatId, clientName: 'X', clientPhone: '070111222', propertyId: 78, service: 'buy', viewingFee: '500', time: 'четврток во 18:00', agentPhone: null });
  appointments.markFinalized(liveId, 'четврток во 18:00');

  const s = freshSession('test', chatId);
  s.state = 'visit_scheduling';
  s.slots.propertyId = 78;
  s.slots.interestedPropertyId = 78;
  s.slots.service = 'buy';
  s.slots.viewingFeeAgreed = true;
  sessions.set(s);

  await handler.handle('test', chatId, 'CETVRTOK POPLADNE MOZAM POSLE 6');
  const afterProposal = sessions.get(chatId)!;
  assert.notEqual(afterProposal.state, 'terminated', 'a term proposal must not end the session');
  assert.ok(!sent.some(m => /Откажана посета/.test(m)), `no cancellation on a proposal: ${sent.join(' | ')}`);
  assert.equal(appointments.listByChat(chatId).filter(a => a.status === 'finalized').length, 2,
    'both arranged visits survive the proposal');

  // A COUNTER-OFFER («не можам четврток, ајде попладне после 6») carries a
  // negation AND a proposed term — it is a reschedule, so no cancellation.
  await handler.handle('test', chatId, 'NE MOZAM VO CETVRTOK, MOZAM POPLADNE POSLE 6');
  assert.ok(!sent.some(m => /Откажана посета/.test(m)), `no cancellation on a counter-offer: ${sent.join(' | ')}`);
  assert.equal(appointments.listByChat(chatId).filter(a => a.status === 'finalized').length, 2,
    'both arranged visits survive the counter-offer');

  // A GENUINE cancel now touches only the property in play (EB 78), never the
  // leftover EB 47.
  const beforeCancel = sent.length;
  await handler.handle('test', chatId, 'NE MOZAM, OTKAZETE JA POSETATA');
  assert.ok(ownerMsgs.some(m => m.includes('EB 78')), `the owner hears about the property in play: ${ownerMsgs.join(' | ')}`);
  assert.ok(!ownerMsgs.some(m => m.includes('EB 47')), `never another property's visit: ${ownerMsgs.join(' | ')}`);
  assert.ok(sent.some(m => /Откажана посета/.test(m)), `the client hears the cancellation: ${sent.join(' | ')}`);
  // A terminated turn sends EXACTLY ONE message: falling through behind the
  // cancellation put a second, EB-less «Откажана посета по желба на клиент.»
  // and then a term offer on a chat that was already closed.
  assert.equal(sent.slice(beforeCancel).length, 1,
    `one message on the cancelling turn: ${sent.slice(beforeCancel).join(' | ')}`);
  db.close();
});

test('[21:57] an ANCHORLESS cancel with two arranged visits ASKS which one — it never cancels the newest', async () => {
  // The worst outcome of the [21:57] capture is cancelling a property nobody
  // mentioned. With two arranged visits and nothing anchoring either one, the
  // only honest move is the question — guessing the newest is what put a wrong
  // Евидентен број in front of an owner.
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const appointments = new AppointmentStore(db);
  const events = new EventStore(db);
  const owners = new OwnerStore(db);
  const cfg = loadConfig();
  const props = new FakeProps(ROWS);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const ownerMsgs: string[] = [];
  const sched = new VisitScheduler({
    db, events, owners, properties: props,
    notifyClient: async (chatId, text) => { sent.push(`[${chatId}] ${text}`); },
    notifyOwner: async (_chatId, eb, text) => { ownerMsgs.push(`[EB ${eb}] ${text}`); },
    notifyOperator: async () => {},
    now: () => NOW,
  });
  const handler = new InboundHandler({ cfg, db, sessions, classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg), properties: props,
    appointments, escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }), visits: sched,
  });

  const chatId = 'visit-2157-ambiguous';
  for (const [eb, time] of [[47, 'сабота во 12:00'], [62, 'петок во 17:00']] as [number, string][]) {
    const id = appointments.insert({ chatId, clientName: 'X', clientPhone: '070111222', propertyId: eb, service: 'buy', viewingFee: '500', time, agentPhone: null });
    appointments.markFinalized(id, time);
  }

  const s = freshSession('test', chatId);
  s.state = 'visit_scheduling';
  s.slots.service = 'buy';
  s.slots.viewingFeeAgreed = true;
  sessions.set(s);

  await handler.handle('test', chatId, 'NE MOZAM, OTKAZETE JA POSETATA');
  assert.equal(appointments.listByChat(chatId).filter(a => a.status === 'finalized').length, 2,
    'no arranged visit is cancelled while the target is unknown');
  assert.equal(ownerMsgs.length, 0, `the owner hears nothing yet: ${ownerMsgs.join(' | ')}`);
  assert.notEqual(sessions.get(chatId)!.state, 'terminated', 'the chat is not ended on a question');
  const ask = sent.find(m => /За која посета/.test(m)) ?? '';
  assert.ok(ask, `the client is asked which visit: ${sent.join(' | ')}`);
  assert.ok(ask.includes('47') && ask.includes('62'), `the ask names both Евидентен број: ${ask}`);

  // The answer anchors one of them, and THAT one — and only that one — cancels.
  await handler.handle('test', chatId, 'OTKAZETE JA POSETATA ZA 62');
  assert.ok(ownerMsgs.some(m => m.includes('EB 62')), `only the named visit is cancelled: ${ownerMsgs.join(' | ')}`);
  assert.ok(!ownerMsgs.some(m => m.includes('EB 47')), `the other visit stands: ${ownerMsgs.join(' | ')}`);
  assert.equal(appointments.listByChat(chatId).filter(a => a.status === 'finalized').length, 2,
    'cancelVisit is a notification, not a row edit');
  db.close();
});

// The mkTimePhrase owner-corpus typo sweep (MK_DAY_FIX) made the same forms
// first-class DAY WORDS everywhere a day is read — DAY_WORDS (parse),
// DAY_TRAILING_HOUR_RE (trailing-hour arm) and DAY_WORD_RE (hasDayWord). A
// misspelled day read as day-less is exactly the [01:06] bug class: every
// merge gate then treats the stored day as day-less and the new clock
// replaces it with TODAY. NOW_OCT is Friday 23.10.2026 — the next occurrence
// of each weekday is the same calendar week (Mon 26.10 … Sat 31.10).
test('day typo corpus: misspelled weekdays parse and merge like their spelled-day', () => {
  const daydow = (t: string) => parseVisitDateTime(t, NOW_OCT)!.getDay();
  assert.equal(daydow('PONEDELOK VO 3'), 1, 'ponedelnik');
  assert.equal(daydow('VO VTORIK VO 4'), 2, 'vtornik');
  assert.equal(daydow('SRETA VO 5'), 3, 'sreda');
  assert.equal(daydow('во средта по 5'), 3, 'sreda (Cyrillic)');
  assert.equal(daydow('ЦЕТВРТОК ВО 6'), 4, 'четврток');
  assert.equal(daydow('NA PETK'), 5, 'petok');
  assert.equal(daydow('SUBOTA VO 2'), 6, 'sabota');
  // The trailing-hour arm reads the typo'd day + bare digit as the clock
  // (the [12:42] arm on a typo): 1–7 shifts to PM.
  assert.equal(parseVisitDateTime('PONEDELOK 6', NOW_OCT)!.getDay(), 1);
  assert.equal(parseVisitDateTime('SUBOTA 3', NOW_OCT)!.getDay(), 6);
});

// ---- Cancellation corpus ----------------------------------------------------
//
// One table, a fresh harness per case. Whether a phrasing is a cancellation is a
// DETECTION question, and the [21:57] class of bug (a term proposal cancelled as
// a visit) lives in exactly those phrasings clients actually type: Latin,
// Cyrillic and misspelled inflections of «откажи». The verdict is asserted
// through the whole pipeline (did an owner cancellation go out, for which
// Евидентен број) — never on the detector alone.
interface CancelProbeResult {
  cancelled: boolean;
  cancelledEb?: number;
  askedWhich: boolean;
  terminated: boolean;
}

async function cancelProbe(text: string, opts: {
  anchored?: number;
  ebs?: number[];
  /** The state the client is in when the message lands. A TERM STATE
   *  (owner_checking / time_confirm) means the owner's offer is on the table,
   *  so a bare «не можам» is about THAT TERM — see the [09:04] ping-pong. */
  state?: 'visit_scheduling' | 'owner_checking' | 'time_confirm';
  visitTime?: string;
} = {}): Promise<CancelProbeResult> {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const appointments = new AppointmentStore(db);
  const events = new EventStore(db);
  const owners = new OwnerStore(db);
  const cfg = loadConfig();
  const props = new FakeProps(ROWS);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const ownerMsgs: { eb: number; text: string }[] = [];
  const sched = new VisitScheduler({
    db, events, owners, properties: props,
    notifyClient: async (chatId, t) => { sent.push(`[${chatId}] ${t}`); },
    notifyOwner: async (_chatId, eb, t) => { ownerMsgs.push({ eb, text: t }); },
    notifyOperator: async () => {},
    now: () => NOW,
  });
  const handler = new InboundHandler({ cfg, db, sessions, classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg), properties: props,
    appointments, escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }), visits: sched,
  });

  const chatId = 'cancel-corpus';
  for (const eb of opts.ebs ?? [78]) {
    const id = appointments.insert({ chatId, clientName: 'X', clientPhone: '070111222', propertyId: eb, service: 'buy', viewingFee: '500', time: 'четврток во 18:00', agentPhone: null });
    appointments.markFinalized(id, 'четврток во 18:00');
  }
  const s = freshSession('test', chatId);
  s.state = opts.state ?? 'visit_scheduling';
  s.slots.service = 'buy';
  s.slots.viewingFeeAgreed = true;
  if (opts.visitTime) s.slots.visitTime = opts.visitTime;
  if (opts.anchored !== undefined) s.slots.propertyId = opts.anchored;
  sessions.set(s);

  await handler.handle('test', chatId, text);
  const out: CancelProbeResult = {
    cancelled: ownerMsgs.length > 0,
    cancelledEb: ownerMsgs[0]?.eb,
    askedWhich: sent.some(m => /За која посета/.test(m)),
    terminated: sessions.get(chatId)!.state === 'terminated',
  };
  db.close();
  return out;
}

test('cancellation corpus: every inflection of «откажи» cancels, every proposed term does not', async () => {
  // Cancellations — the property in play is cancelled, and only it.
  const cancellations = [
    'OTKAZETE JA POSETATA',              // Latin, -ete inflection (the [21:57] answer form)
    'otkazuvam posetata',                // Latin, -uvam inflection
    'ОТКАЖЕТЕ ЈА ПОСЕТАТА ЗА 78',         // Cyrillic, inflected, EB named
    'NE MOZAM DA DOJDAM',                // bare negation
    'SE IZVINUVAM, MORA DA OTKAZAM',     // apology + cancel
    'БОЛЕН СУМ, ОТКАЖИ ЈА ПОСЕТАТА',      // illness + cancel
  ];
  for (const t of cancellations) {
    const r = await cancelProbe(t);
    assert.equal(r.cancelled, true, `«${t}» is a cancellation: ${JSON.stringify(r)}`);
    assert.equal(r.cancelledEb, 78, `«${t}» cancels the property in play`);
    assert.equal(r.terminated, true, `«${t}» ends the chat`);
  }

  // Term proposals and counter-offers — scheduling language, never a cancel.
  const proposals = [
    'CETVRTOK POPLADNE MOZAM POSLE 6',            // the [21:56] proposal itself
    'cetvrtok popladne mozam posle 6',            // lower case
    'утре попладне можам по 6',                    // Cyrillic, «по 6»
    'NE MOZAM VO CETVRTOK, MOZAM POPLADNE POSLE 6', // counter-offer: negation + new term
    'не можам тогаш, задутре во 18:00',            // counter-offer, Cyrillic
    'NE MOZAM, MOZAM PONEDELNIK VO 17',           // counter-offer, Latin typo
  ];
  for (const t of proposals) {
    const r = await cancelProbe(t);
    assert.equal(r.cancelled, false, `«${t}» proposes a term — no cancellation: ${JSON.stringify(r)}`);
    assert.equal(r.terminated, false, `«${t}» keeps the session alive`);
  }

  // The anchored-mismatch and ambiguous cases: never cancel what nobody named.
  const anchoredElsewhere = await cancelProbe('OTKAZETE JA POSETATA', { anchored: 53, ebs: [78] });
  assert.equal(anchoredElsewhere.cancelled, false, 'an anchor with no arranged visit never cancels another property');
  assert.equal(anchoredElsewhere.askedWhich, true, 'the client is asked which visit');

  const twoVisits = await cancelProbe('OTKAZETE JA POSETATA', { ebs: [47, 78] });
  assert.equal(twoVisits.cancelled, false, 'two arranged visits and no anchor: nothing is cancelled');
  assert.equal(twoVisits.askedWhich, true, 'the client is asked which visit');

  // …and the ANSWER to that question wins over the stale slot — otherwise Lina
  // asks «за која посета?» forever (the replay looped exactly there).
  const namedAnswer = await cancelProbe('OTKAZETE JA POSETATA ZA 78', { anchored: 53, ebs: [47, 78] });
  assert.equal(namedAnswer.cancelled, true, 'the Евидентен број in the message is acted on');
  assert.equal(namedAnswer.cancelledEb, 78, 'and it beats the property the chat was discussing');
  assert.equal(namedAnswer.askedWhich, false, 'no further which-visit question');
});

// THE TERM ON THE TABLE OWNS THE «CAN'T» (the [09:04] ping-pong, third turn).
// The owner had just offered a new term and the client answered «NE MOZAM VO TOA
// VREME. MALCE POKASNO AKO MOZE 6». The cancel lane read «не можам» as a
// cancellation of the visit, found the chat's leftover finalized appointments
// for OTHER properties and asked «За која посета се работи?» — inventing visits
// the client never had. In a term state a time rejection is scheduling language
// unless the message carries its OWN cancel token.
test('[09:04] a rejected TERM is not a cancelled visit — no which-visit question', async () => {
  const r = await cancelProbe('NE MOZAM VO TOA VREME. MALCE POKASNO AKO MOZE 6', {
    state: 'owner_checking', visitTime: 'Понеделник, 09.11.2026 во 17:00', ebs: [62, 94, 75, 47],
  });
  assert.equal(r.cancelled, false, 'the visit is alive — only the offered term was refused');
  assert.equal(r.askedWhich, false, `never ask which visit the client has: ${JSON.stringify(r)}`);
  assert.equal(r.terminated, false, 'the session keeps going');

  // …and the OWN cancel token still cancels from the same state.
  const own = await cancelProbe('NE MOZAM, OTKAZETE JA POSETATA', {
    state: 'owner_checking', visitTime: 'Понеделник, 09.11.2026 во 17:00', ebs: [62, 94, 75, 47],
  });
  assert.equal(own.askedWhich, true, 'an explicit cancel with four visits still asks which');
});

test('cancel cleanup: the silenced protocol is counted for the operator and never fires after the cancel', async () => {
  // A cancellation has to STOP the visit-day protocol, not just answer the
  // client: the morning confirmation and the exact-location turn are scheduled
  // hours ahead, and the address-confirm bump repeats every 2h. cancelVisit
  // marks them skipped, and the operator log must say how many were dropped —
  // that count is the only record of which messages the client never received.
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
    notifyClient: async (_chatId, text) => { clientMsgs.push(text); },
    notifyOwner: async (_chatId, _eb, text) => { ownerMsgs.push(text); },
    notifyOperator: async text => { operatorLogs.push(text); },
    now: () => clock,
  });
  const appts = new AppointmentStore(db);
  const apptId = appts.insert({
    chatId: 'c-cancel', clientName: 'Марко', clientPhone: '070333444', propertyId: 53,
    service: 'Купување', viewingFee: '500 MKD', time: 'утре попладне', agentPhone: '076247467',
  });
  appts.markFinalized(apptId, 'утре попладне');
  await sched.arrange({
    appointmentId: apptId, chatId: 'c-cancel', eb: 53, time: 'утре попладне',
    agentPhone: '076247467', clientName: 'Марко', clientPhone: '070333444',
    owner: { name: 'Петре', phone: '070111222' },
  });

  const pendingBefore = (db.db.prepare(
    `SELECT COUNT(*) c FROM visit_turns WHERE appointment_id = ? AND status = 'pending'`).get(apptId) as { c: number }).c;
  assert.ok(pendingBefore > 0, 'the protocol scheduled turns to silence');

  // The client cancels on the morning of the visit, before any turn fired.
  clock = new Date(2026, 7, 17, 9, 0);
  await sched.cancelVisit(apptId, 'client');

  const log = operatorLogs.find(l => l.includes('CANCELLED by client')) ?? '';
  assert.ok(log, operatorLogs.join('\n'));
  assert.ok(log.includes(`${pendingBefore} pending turn${pendingBefore === 1 ? '' : 's'} skipped`), log);
  assert.ok(log.includes('ЕБ 53'), log);
  // Both parties hear it, with the Евидентен број.
  assert.ok(clientMsgs.some(m => m.includes('Откажана посета') && m.includes('53')), clientMsgs.join(' | '));
  assert.ok(ownerMsgs.some(m => m.includes('Откажана посета') && m.includes('53')), ownerMsgs.join(' | '));

  // The protocol hours pass: NOTHING may follow the cancellation — no morning
  // confirmation, no location turn, no address-confirm bump. (The arrange-time
  // address confirm and the cancellation itself are already in the arrays, so
  // the comparison starts after them.)
  const clientsBeforeTicks = clientMsgs.length;
  const ownersBeforeTicks = ownerMsgs.length;
  clock = new Date(2026, 7, 17, 10, 0);
  await sched.tick();
  clock = new Date(2026, 7, 17, 14, 0);
  await sched.tick();
  assert.deepEqual(clientMsgs.slice(clientsBeforeTicks), [], 'the client hears nothing more');
  assert.deepEqual(ownerMsgs.slice(ownersBeforeTicks), [], 'the owner hears nothing more');
  const turns = db.db.prepare(`SELECT status FROM visit_turns WHERE appointment_id = ?`).all(apptId) as { status: string }[];
  assert.ok(turns.length > 0 && turns.every(t => t.status === 'skipped'), JSON.stringify(turns));
  db.close();
});

// ── THE [17:43] PING-PONG ───────────────────────────────────────────────────
// Field transcript: the client proposed Friday after 6 → asked for an exact
// hour → «NEKA BIDE 6IPOL» (18:30). The owner refused 18:30 and offered an
// EARLIER term, latest 4: «PETOK NEMA DA MOZAM VO 6 IPOL . MOZAM PORANO ,
// NAKAJ 4». Two things broke:
//   1. the client was told only that 18:30 did not suit and asked for another
//      term — the owner's 16:00 never reached her, so she could not accept it;
//   2. her answer «POKASNO 7:30» reached the owner as 07:30 (a visit at 7 in
//      the morning) and the follow-up named 18:30, a term the owner himself
//      had already refused.
// The window rule (visits/time): a bare 1–8 is PM, and no visit is made before
// 09:00 or after 21:00.
test('[17:43] the owner\'s counter reaches the client, and «POKASNO 7:30» is 19:30 — never 07:30', async () => {
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
  const sched = new VisitScheduler({
    db, events, owners, properties: props,
    notifyClient: async () => {}, notifyOwner: async () => {}, notifyOperator: async () => {},
    now: () => NOW,
  });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
    visits: sched,
  });
  const ownerAsks: string[] = [];
  handler.onOwnerAsk = (_c: string, _eb: number, q: string) => { ownerAsks.push(q); };

  const chatId = 'petok-pingpong';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA');
  await send('DA, SE SOGLASUVAM');
  await send('MARKO 078/914 196');
  let s = await send('MOZAM VO PETOK POSLE 6');
  // «после 6» is a window, not a term — Lina asks for the exact hour first
  // (exactly as in the field transcript).
  assert.equal(s.state, 'visit_scheduling', `the exact-hour ask comes first: ${s.state}`);
  s = await send('NEKA BIDE 6IPOL');
  assert.equal(s.state, 'owner_checking', `the exact hour re-asks the owner: ${s.state}`);
  assert.ok(ownerAsks.some(q => /18:30/u.test(q)), `the owner is asked about 18:30: ${ownerAsks.join(' | ')}`);

  // THE OWNER'S COUNTER: can't do 18:30, can do earlier — latest 4 (=16:00).
  const verdict = detectOwnerVerdict('PETOK NEMA DA MOZAM VO 6 IPOL . MOZAM PORANO , NAKAJ 4', s.slots.visitTime ?? '');
  assert.ok(verdict, 'the owner reply must parse');
  assert.equal(verdict!.status, 'counter', JSON.stringify(verdict));
  assert.equal(normalizeOwnerTime(verdict!.ownerTime ?? '', NOW), 'Петок, 21.08.2026 во 16:00',
    `the owner's «NAKAJ 4» is 16:00, not 04:00: ${JSON.stringify(verdict)}`);

  handler.ownerAnswer(chatId, 78, verdict!);
  await new Promise(r => setTimeout(r, 50));
  s = sessions.get(chatId)!;
  assert.equal(s.state, 'time_confirm', `the client is asked to accept the counter: ${s.state}`);
  const relay = sent[sent.length - 1] ?? '';
  // THE CLIENT MUST HEAR THE OWNER'S TERM — 16:00 — not only the refusal.
  assert.ok(/16:00/u.test(relay), `the client relay carries the owner's 16:00: ${relay}`);

  // THE CLIENT ANSWERS «POKASNO 7:30» — later than 16:00, so 19:30.
  const asksBefore = ownerAsks.length;
  s = await send('POKASNO 7:30');
  assert.equal(s.state, 'owner_checking', `the new term re-asks the owner: ${s.state}`);
  const followup = ownerAsks[asksBefore] ?? ownerAsks[ownerAsks.length - 1] ?? '';
  assert.ok(/19:30/u.test(followup), `the client's «7:30» is 19:30, never 07:30: ${followup}`);
  assert.ok(!/07:30/u.test(followup), `no 07:30 visit asked of the owner: ${followup}`);
  // …and the refused term is the OWNER'S 16:00, not the client's earlier 18:30.
  assert.ok(/16:00/u.test(followup), `the follow-up names the owner's own 16:00: ${followup}`);
  assert.ok(!/18:30/u.test(followup), `never accuses the client of refusing 18:30 again: ${followup}`);
  db.close();
});
