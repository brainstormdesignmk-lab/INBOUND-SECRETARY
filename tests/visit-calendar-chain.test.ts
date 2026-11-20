// THE VISIT DAY — hourly slots, taken hours, and the chain solver.
//
// The owner's 2026-11-11 brief: visits last at most 30 minutes and the rest of
// the hour is travel, so the agent's day is hourly slots; a client asking for an
// hour that is already booked is told so and offered the nearest free hours
// before/after; and several flats are linked into ONE non-stop chain (16:00 →
// 17:00 → …) in whatever order the owners can do, with the client's own start
// kept when possible.
//
// UPDATED for the owner's 2026-11-19 answers: a shift is searched both ways
// ALWAYS (and disclosed — his hour is still preferred, the objective's second
// key), a pause of up to two hours is a legal route when nothing connects
// (one hour preferred), and flats outside the day's route are DEFERRED to their
// own term instead of `dropped`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  dayStartOf, slotStartOf, isSlotTaken, freeHours, freeHoursNear,
  formatFreeHours, buildSlotTakenLine, SLOT_MINUTES,
} from '../src/visits/calendar';
import { solveChain, type ChainStop } from '../src/visits/chain';

const DAY = new Date(2026, 10, 13); // Friday 13.11.2026
const dayStart = dayStartOf(DAY);
const at = (h: number): number => new Date(2026, 10, 13, h).getTime();

test('a visit is a 60-minute slot (30 min visit + travel)', () => {
  assert.equal(SLOT_MINUTES, 60);
  assert.equal(slotStartOf(new Date(2026, 10, 13, 17, 25)), at(17));
  assert.equal(dayStart, new Date(2026, 10, 13).getTime());
});

test('busy hours are taken; the free list is the rest of the visit window', () => {
  const cal = { dayStart, busy: [at(16), at(17)] };
  assert.equal(isSlotTaken(new Date(2026, 10, 13, 16, 0), cal), true);
  assert.equal(isSlotTaken(new Date(2026, 10, 13, 18, 0), cal), false);
  const free = freeHours(cal);
  assert.ok(!free.includes(16) && !free.includes(17), JSON.stringify(free));
  assert.ok(free.includes(9) && free.includes(21), JSON.stringify(free));
});

test('a taken hour offers the nearest free hours BEFORE and AFTER', () => {
  const cal = { dayStart, busy: [at(16)] };
  const near = freeHoursNear(new Date(2026, 10, 13, 16, 0), cal, 2);
  assert.deepEqual(near, [15, 17], `nearest first: ${JSON.stringify(near)}`);
  assert.equal(formatFreeHours([15, 17]), '15:00 и 17:00');
  const line = buildSlotTakenLine(16, [15, 17]);
  assert.match(line, /16:00/u, line);
  assert.match(line, /зафатен/u, line);
  assert.match(line, /15:00/u, line);
  assert.match(line, /17:00/u, line);
  assert.match(line, /\?$/u, `it asks which one suits him: ${line}`);
  // A fully booked day asks about another day instead of inventing a slot.
  const full = { dayStart, busy: Array.from({ length: 13 }, (_, i) => at(9 + i)) };
  assert.match(buildSlotTakenLine(16, []), /друг ден/u);
});

test('a chain is laid out contiguously from the client’s hour, in his order', () => {
  const stops: ChainStop[] = [{ eb: 42 }, { eb: 59 }];
  const plan = solveChain({ targetHour: 16, stops, busy: [] })!;
  assert.ok(plan, 'a plan exists');
  assert.equal(plan.startHour, 16);
  assert.equal(plan.shiftedBy, 0);
  assert.deepEqual(plan.stops, [{ eb: 42, hour: 16 }, { eb: 59, hour: 17 }]);
  assert.deepEqual(plan.deferred, []);
});

test('the order is free: an owner who can only do 16:00 goes first', () => {
  // 42 can only do 17:00, 59 only 16:00 → the chain flips and the client keeps 16:00.
  const stops: ChainStop[] = [{ eb: 42, hours: [17] }, { eb: 59, hours: [16] }];
  const plan = solveChain({ targetHour: 16, stops, busy: [] })!;
  assert.deepEqual(plan.stops, [{ eb: 59, hour: 16 }, { eb: 42, hour: 17 }]);
  assert.equal(plan.shiftedBy, 0, 'the client start is untouched');
});

test('a busy hour breaks contiguity: the chain keeps the hour and pauses', () => {
  const stops: ChainStop[] = [{ eb: 42 }, { eb: 59 }];
  // 17:00 is already booked by another client → 16:00+17:00 impossible. The
  // route keeps the CLIENT's hour (the objective's second key) and takes the
  // one-hour pause instead of moving him earlier; the gap is stated to him.
  const busyPlan = solveChain({ targetHour: 16, stops, busy: [17] })!;
  assert.equal(busyPlan.startHour, 16, 'the client hour is kept for the first stop');
  assert.deepEqual(busyPlan.stops, [{ eb: 42, hour: 16 }, { eb: 59, hour: 18 }]);
  assert.equal(busyPlan.totalGap, 1, 'one free hour between them');
  assert.deepEqual(busyPlan.deferred, []);
  // `flexible` is no longer a permission bit: the search is always both ways,
  // and keeping his hour still beats shifting (same plan either way).
  const flex = solveChain({ targetHour: 16, stops, busy: [17], flexible: true })!;
  assert.equal(flex.startHour, 16);
  assert.deepEqual(flex.stops, busyPlan.stops);
});

test('a clash is never a doubled slot, and the loser keeps its own term', () => {
  const stops: ChainStop[] = [{ eb: 42 }, { eb: 59 }];
  const plan = solveChain({ targetHour: 16, stops, busy: [17] })!;
  assert.equal(plan.shiftedBy, 0, 'his hour is preferred over a shift');
  // 42 only at 18:00 and 59 only at 18:00 → both can't share one hour. One is
  // still arranged and the other is DEFERRED — never a doubled slot, never an
  // abandoned flat.
  const clash = solveChain({ targetHour: 18, stops: [{ eb: 42, hours: [18] }, { eb: 59, hours: [18] }], busy: [] })!;
  assert.equal(clash.stops.length, 1, JSON.stringify(clash));
  assert.deepEqual(clash.stops.map(s => s.hour), [18]);
  assert.deepEqual(clash.deferred, [59], JSON.stringify(clash));
});

test('four flats, one chain: the booked hour costs a pause, not a flat', () => {
  const stops: ChainStop[] = [{ eb: 11 }, { eb: 22 }, { eb: 33 }, { eb: 44 }];
  // 19:00 is booked. Every subset size is tried first, so all four are placed:
  // 16, 17, 18 … then 20 (a one-hour pause) — the client keeps his 16:00 and
  // nobody is deferred.
  const plan = solveChain({ targetHour: 16, stops, busy: [19] })!;
  assert.equal(plan.stops.length, 4, JSON.stringify(plan));
  assert.deepEqual(plan.stops.map(s => s.hour), [16, 17, 18, 20]);
  assert.equal(plan.totalGap, 1, JSON.stringify(plan));
  assert.deepEqual(plan.deferred, []);
  assert.deepEqual(solveChain({ targetHour: 16, stops, busy: [19], flexible: true })!.stops, plan.stops);
});

test('the visit window is absolute (never before 09:00 or after 21:00)', () => {
  const stops: ChainStop[] = [{ eb: 42 }, { eb: 59 }];
  // A client hour outside the window is not a visit at all — not a seed to
  // shift from.
  assert.equal(solveChain({ targetHour: 8, stops, busy: [] }), undefined);
  // 21:00 is the last start, so a two-flat route moves to 20:00–21:00 (one
  // hour earlier, stated); 22:00 is never used.
  const late = solveChain({ targetHour: 21, stops, busy: [] })!;
  assert.deepEqual(late.stops.map(s => s.hour), [20, 21]);
  assert.equal(late.shiftedBy, -1);
  assert.deepEqual(late.deferred, []);
  const single = solveChain({ targetHour: 21, stops: [{ eb: 42 }], busy: [] })!;
  assert.deepEqual(single.stops, [{ eb: 42, hour: 21 }]);
});
