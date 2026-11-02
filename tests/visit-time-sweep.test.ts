// THE CLOCK-FAMILY SWEEP — every spoken shape a client actually types, walked
// through the ONE family in visits/time.ts (hasClockHint → detectVisitTime →
// isValidVisitTime → parseVisitDateTime → detectVagueTime).
//
// The [13:16] capture ("NEKA BIDE 5 I 30") proved the failure class: a shape
// that one gate accepted and another rejected reads as \"the client gave no
// time\", and the funnel re-asks a question it has just been answered. So the
// sweep asserts the WHOLE family agrees per phrase, in both scripts:
//
//   • an exact clock → parses to that hour, is a visit time, is NOT vague;
//   • a RANGE ("од 5 до 7", "5-7", "меѓу 5 и 7") → names clocks but is not a
//     term: no single datetime, and the exact-hour ask owns the turn (never
//     the \"pick a time inside 09:00–21:00\" answer, which would accuse the
//     client of an impossible proposal).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseVisitDateTime, hasClockHint, outsideVisitWindow } from '../src/visits/time';
import { detectVisitTime, isValidVisitTime, detectVagueTime } from '../src/llm/deterministic';

// Sunday 16.08.2026, 10:00 — the same pinned clock the rest of the time suite
// uses, so 1–8 resolve as PM (the visit window) and days are deterministic.
const NOW = new Date(2026, 7, 16, 10, 0, 0);

// [phrase, expected hour, expected minutes]
const CLOCKS: Array<[string, number, number]> = [
  // digit minutes, with and without the preposition / day
  ['во 5 и 15', 17, 15],
  ['5 i 15', 17, 15],
  ['5 И 15', 17, 15],
  ['пет и 15', 17, 15],
  ['PONEDELNIK 5 I 15', 17, 15],
  ['5 и 45', 17, 45],
  ['5 и 30', 17, 30],
  // quarter past, words in both scripts
  ['пет и четврт', 17, 15],
  ['pet i cetvrt', 17, 15],
  ['пет и петнаесет', 17, 15],
  ['PET I CETVRT', 17, 15],
  // quarter to
  ['без четврт пет', 16, 45],
  ['bez cetvrt pet', 16, 45],
  ['без 15 пет', 16, 45],
  // half past, every spelling
  ['5 и пол', 17, 30],
  ['пет и пол', 17, 30],
  ['pet i pol', 17, 30],
  ['5IPOL', 17, 30],
  ['6 и пол', 18, 30],
  // half TO (Macedonian "пол 6" = 5:30, the mirror of "6 и пол")
  ['пол 6', 17, 30],
  ['pol 6', 17, 30],
  // 9–12 stay as said; a morning word keeps the hour literal
  ['во 9 и 15', 9, 15],
  ['петок наутро во 9 и 15', 9, 15],
  // the plain clock forms the family already had — they must keep working
  ['17:45', 17, 45],
  ['во 17:45', 17, 45],
];

// CLOSED ranges: a concrete term that STARTS at its first clock (the pinned
// [23:48] contract — only an OPEN window is vague). [phrase, start hour]
const RANGES: Array<[string, number]> = [
  ['од 5 до 7', 17],
  ['od 5 do 7', 17],
  ['OD 5 DO 7', 17],
  ['5-7', 17],
  ['5:00 - 7:00', 17],
  ['од 17:00 до 19:00', 17],
  ['меѓу 5 и 7', 17],
  ['pomegju 5 i 7', 17],
  ['од 9 до 11', 9],
];

// OPEN windows: availability, not an appointment.
const OPEN_WINDOWS = [
  'OD 5 PA NATAKA',
  'od 17:00 pa nataka',
  'слободна сум од 5 саат понатака',
  'od 5 navaka',
];

test('every exact clock shape agrees across the whole family, in both scripts', () => {
  for (const [phrase, hour, minute] of CLOCKS) {
    const d = parseVisitDateTime(phrase, NOW);
    assert.ok(d, `not parsed as a clock: ${phrase}`);
    assert.equal(d!.getHours(), hour, `hour: ${phrase}`);
    assert.equal(d!.getMinutes(), minute, `minutes: ${phrase}`);
    assert.equal(hasClockHint(phrase), true, `no clock hint: ${phrase}`);
    assert.equal(isValidVisitTime(phrase), true, `validator rejected a clock: ${phrase}`);
    assert.ok(detectVisitTime(phrase) !== undefined, `detector missed a clock: ${phrase}`);
    assert.equal(detectVagueTime(phrase), false, `an exact clock must not read as vague: ${phrase}`);
    assert.equal(outsideVisitWindow(phrase, NOW), false, `an in-window clock is never "outside": ${phrase}`);
  }
});

test('a CLOSED range is a term that starts at its first clock; only an OPEN window is vague', () => {
  for (const [phrase, startHour] of RANGES) {
    const d = parseVisitDateTime(phrase, NOW);
    assert.ok(d, `the closed range must resolve: ${phrase}`);
    assert.equal(d!.getHours(), startHour, `a closed range starts at its first clock: ${phrase}`);
    assert.equal(detectVagueTime(phrase), false, `a closed range is a term, not vague: ${phrase}`);
    assert.equal(outsideVisitWindow(phrase, NOW), false, `an in-window range is never "outside": ${phrase}`);
    assert.ok(detectVisitTime(phrase) !== undefined, `the range is not recognised at all: ${phrase}`);
    assert.equal(hasClockHint(phrase), true, `the range names clocks: ${phrase}`);
    assert.equal(isValidVisitTime(phrase), true, `the range is a valid time intention: ${phrase}`);
  }
  // …while an open window stays availability (the [23:48] rule).
  for (const phrase of OPEN_WINDOWS) {
    assert.equal(detectVagueTime(phrase), true, `an open window must re-ask the hour: ${phrase}`);
  }
});

test('counts and money never become clocks — the unit veto holds for every family', () => {
  for (const phrase of ['5 и 15 стана', '5 и 30 evra', 'пет и четврт спални',
    'bez cetvrt pet sobi', 'pol 6 stan', '5 до 7 stana']) {
    assert.equal(parseVisitDateTime(phrase, NOW), undefined, `a count is not a clock: ${phrase}`);
    assert.equal(hasClockHint(phrase), false, `no clock hint for a count: ${phrase}`);
  }
});
