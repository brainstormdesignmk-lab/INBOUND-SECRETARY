// THE ROUTE SOLVER (src/visits/chain.ts) — the owner's two worked examples plus
// the edges, as pure arithmetic (no sessions, no copy).
//
// The owner's brief of 2026-11-19:
//   • example 1 — client wants 17, owner 1 wants 18 → the other flat fills 17;
//   • example 2 — owner 2 cannot do 17 but can do 16 → the route is NOT
//     straight away a 16/18 with a pause; CONNECTING beats pausing, so 18/19
//     is the route (asking him for 19 is the negotiator's job);
//   • a pause of 1 hour is preferred, 2 tolerated, never more;
//   • an earlier start that chain-links is a legitimate route (offered to the
//     client, never applied silently);
//   • nobody is dropped — the flats that cannot share the day come back as
//     `deferred`, each for its own term.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveChain } from '../src/visits/chain';

test('[example 1] the client’s hour is filled by the other owner', () => {
  const plan = solveChain({
    targetHour: 17,
    stops: [{ eb: 82, hours: [18] }, { eb: 84 }],
  });
  assert.ok(plan);
  assert.equal(plan.shiftedBy, 0, 'the client’s hour is kept');
  assert.deepEqual(plan.stops, [{ eb: 84, hour: 17 }, { eb: 82, hour: 18 }]);
  assert.equal(plan.totalGap, 0, 'non-stop');
  assert.deepEqual(plan.deferred, []);
});

test('[example 2] connecting beats pausing: 18/19 wins over 16/18', () => {
  // Owner 1 can only do 18; owner 2 offered 16 (the client wants 17).
  const plan = solveChain({
    targetHour: 17,
    stops: [{ eb: 82, hours: [18] }, { eb: 84, hours: [16, 19] }],
  });
  assert.ok(plan);
  assert.deepEqual(plan.stops, [{ eb: 82, hour: 18 }, { eb: 84, hour: 19 }]);
  assert.equal(plan.totalGap, 0, 'no pause in the winning route');
  assert.equal(plan.shiftedBy, 1, 'the start moved one hour later — and it is stated');
});

test('[gap] a 1 hour pause is a route when nothing connects', () => {
  const plan = solveChain({
    targetHour: 17,
    stops: [{ eb: 82, hours: [17] }, { eb: 84, hours: [19] }],
  });
  assert.ok(plan);
  assert.deepEqual(plan.stops, [{ eb: 82, hour: 17 }, { eb: 84, hour: 19 }]);
  assert.equal(plan.totalGap, 1, 'one free hour between them');
});

test('[gap] two hours are tolerated, three are not (2 is the cap)', () => {
  const two = solveChain({ targetHour: 17, stops: [{ eb: 82, hours: [17] }, { eb: 84, hours: [20] }] });
  assert.ok(two, 'a 2 hour pause is allowed');
  assert.equal(two.totalGap, 2);
  const three = solveChain({ targetHour: 17, stops: [{ eb: 82, hours: [17] }, { eb: 84, hours: [21] }] });
  assert.ok(three, 'the flat that cannot join is DEFERRED, not dropped');
  assert.deepEqual(three.stops, [{ eb: 82, hour: 17 }]);
  assert.deepEqual(three.deferred, [84]);
  // …and maxGap 0 restores the non-stop rule for callers that want it.
  assert.equal(solveChain({ targetHour: 17, maxGap: 0, stops: [{ eb: 82, hours: [17] }, { eb: 84, hours: [19] }] })?.totalGap, 0);
});

test('[gap] a 1 hour pause wins over a 2 hour one at equal stops and shift', () => {
  const plan = solveChain({
    targetHour: 17,
    stops: [{ eb: 82, hours: [17, 18] }, { eb: 84, hours: [19, 20] }],
  });
  assert.ok(plan);
  assert.equal(plan.totalGap, 1, `prefers the smaller pause: ${JSON.stringify(plan)}`);
  assert.deepEqual(plan.stops.map(s => s.hour), [17, 19]);
});

test('[earlier] an earlier start that chain-links is a real route', () => {
  // No opening at or after the client's hour, but 15/16 links perfectly.
  const plan = solveChain({
    targetHour: 17,
    stops: [{ eb: 82, hours: [15] }, { eb: 84, hours: [16] }],
  });
  assert.ok(plan, 'the route is found, not refused');
  assert.deepEqual(plan.stops, [{ eb: 82, hour: 15 }, { eb: 84, hour: 16 }]);
  assert.equal(plan.shiftedBy, -2, 'earlier by two hours, stated to the client');
});

test('[order] at equal cost the client’s own order is kept', () => {
  const plan = solveChain({ targetHour: 17, stops: [{ eb: 82 }, { eb: 84 }] });
  assert.ok(plan);
  assert.deepEqual(plan.stops, [{ eb: 82, hour: 17 }, { eb: 84, hour: 18 }]);
});

test('[deferred] nobody is dropped: the flats that fit are placed, the rest deferred', () => {
  const plan = solveChain({
    targetHour: 17,
    stops: [{ eb: 82, hours: [17] }, { eb: 84, hours: [17] }],
  });
  assert.ok(plan);
  assert.equal(plan.stops.length, 1);
  assert.deepEqual(plan.deferred, [84], 'the later flat keeps its own negotiation');
});

test('[busy] the agency’s own calendar blocks an hour', () => {
  const plan = solveChain({ targetHour: 17, busy: [18], stops: [{ eb: 82 }, { eb: 84 }] });
  assert.ok(plan);
  assert.notDeepEqual(plan.stops.map(s => s.hour), [17, 18]);
  assert.equal(plan.totalGap, 1, 'the route skips the taken hour');
});

test('[none] an empty hour list is a NO, not an unknown', () => {
  assert.equal(solveChain({ targetHour: 17, stops: [{ eb: 82, hours: [] }] }), undefined);
  const pair = solveChain({ targetHour: 17, stops: [{ eb: 82, hours: [] }, { eb: 84 }] });
  assert.ok(pair);
  assert.deepEqual(pair.stops.map(s => s.eb), [84]);
  assert.deepEqual(pair.deferred, [82]);
});

test('[window] nothing is ever placed outside 09:00–21:00', () => {
  const plan = solveChain({ targetHour: 20, stops: [{ eb: 82, hours: [20, 21] }, { eb: 84, hours: [21] }] });
  assert.ok(plan);
  // The last legal hour pair is 20:00 → 21:00: the route closes at the window.
  assert.deepEqual(plan.stops, [{ eb: 82, hour: 20 }, { eb: 84, hour: 21 }]);
  for (const s of plan.stops) {
    assert.ok(s.hour >= 9 && s.hour <= 21, `inside the visit window: ${JSON.stringify(plan.stops)}`);
  }
  // An hour the window forbids is not a slot: EB 88 offered only 22:00.
  const late = solveChain({ targetHour: 20, stops: [{ eb: 82 }, { eb: 84 }, { eb: 88, hours: [22] }] });
  assert.ok(late);
  assert.deepEqual(late.stops.map(s => s.eb).sort((a, b) => a - b), [82, 84]);
  assert.deepEqual(late.deferred, [88], '22:00 is never a visit');
  const early = solveChain({ targetHour: 10, stops: [{ eb: 82, hours: [8] }, { eb: 84 }] });
  assert.ok(early);
  assert.deepEqual(early.deferred, [82], '08:00 is never a visit');
});
