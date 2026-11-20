// THE NEGOTIATOR (src/visits/negotiate.ts) — the owner's two worked examples,
// as a conversation with the questions that actually go out.
//
//   client 17 · owner 1 can only 18 · owner 2 free
//     → ask owner 2 for 17 (his hour fills the client's own slot)
//
//   client 17 · owner 1 can only 18 · owner 2 said 16
//     → do NOT settle for a 16/18 route with a pause: ask owner 2 for 19,
//       because 18/19 connects them, and only then offer the route.
//
// Also pinned: parallel first round, never the same hour twice, the per-owner
// budget, and the day that cannot hold everyone (deferred, not dropped).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, planAsks, type NegotiateView, type NegotiateStop } from '../src/visits/negotiate';

const stop = (eb: number, extra: Partial<NegotiateStop> = {}): NegotiateStop => ({ eb, ...extra });

test('[example 1] a free owner is asked the CLIENT’s hour, not the spare one', () => {
  const view: NegotiateView = { targetHour: 17, stops: [stop(82), stop(84)] };
  // Both owners are unknown, so BOTH are asked in one parallel round, and the
  // plan is contiguous from his hour: 17 for the first, 18 for the second.
  const asks = planAsks(view);
  assert.deepEqual(asks, [
    { eb: 82, hour: 17, reason: 'first' },
    { eb: 84, hour: 18, reason: 'first' },
  ]);

  // Owner 1 cannot do 17 and offers 18 — the free owner takes 17.
  const next = planAsks({
    targetHour: 17,
    stops: [stop(82, { can: [18], askedHours: [17], asks: 1 }), stop(84, { askedHours: [18], asks: 1 })],
  });
  assert.deepEqual(next, [{ eb: 84, hour: 17, reason: 'first' }],
    `owner 2 is asked for the client’s hour: ${JSON.stringify(next)}`);

  // Both agree → nothing left to ask, the route is offered.
  const done = decide({
    targetHour: 17,
    stops: [stop(82, { can: [18], askedHours: [17, 18], asks: 2 }), stop(84, { can: [17], askedHours: [18, 17], asks: 2 })],
  });
  assert.equal(done.kind, 'offer');
  if (done.kind !== 'offer') return;
  assert.deepEqual(done.plan.stops, [{ eb: 84, hour: 17 }, { eb: 82, hour: 18 }]);
  assert.equal(done.plan.totalGap, 0);
});

test('[example 2] a 16 answer is not a 16/18 route: ask him for 19', () => {
  // Owner 1 can only do 18; owner 2 refused 17 and offered 16. The known hours
  // make 16 + 18 (a pause), but the ONE question that removes the pause is 19.
  const view: NegotiateView = {
    targetHour: 17,
    stops: [
      stop(82, { can: [18], askedHours: [17, 18], asks: 2 }),
      stop(84, { can: [16], askedHours: [17], asks: 1 }),
    ],
  };
  const asks = planAsks(view);
  assert.deepEqual(asks, [{ eb: 84, hour: 19, reason: 'connect' }],
    `the pause is not accepted before asking the connecting hour: ${JSON.stringify(asks)}`);

  // He says yes to 19 → the route is 18/19, non-stop, stated as a later start.
  const done = decide({
    targetHour: 17,
    stops: [
      stop(82, { can: [18], askedHours: [17, 18], asks: 2 }),
      stop(84, { can: [16, 19], askedHours: [17, 19], asks: 2 }),
    ],
  });
  assert.equal(done.kind, 'offer');
  if (done.kind !== 'offer') return;
  assert.deepEqual(done.plan.stops, [{ eb: 82, hour: 18 }, { eb: 84, hour: 19 }]);
  assert.equal(done.plan.totalGap, 0, 'the pause is gone');
  assert.equal(done.plan.shiftedBy, 1);
});

test('[budget] an hour already put to an owner is never asked twice', () => {
  const view: NegotiateView = {
    targetHour: 17,
    maxGap: 0,
    stops: [stop(82, { can: [18], askedHours: [17, 18, 19], asks: 3 }), stop(84, { can: [20], askedHours: [19, 20], asks: 2 })],
  };
  const asks = planAsks(view);
  for (const a of asks) {
    assert.ok(!(view.stops.find(s => s.eb === a.eb)?.askedHours ?? []).includes(a.hour),
      `never the same hour twice: ${JSON.stringify(asks)}`);
  }
});

test('[budget] an owner who spent his questions leaves the route', () => {
  const view: NegotiateView = {
    targetHour: 17,
    stops: [stop(82, { can: [11], askedHours: [17, 18, 19], asks: 3 }), stop(84, { can: [17] })],
  };
  const view2 = { ...view, stops: [view.stops[0]!, view.stops[1]!] };
  // EB 82 is out of useful hours and has no questions left → the route is EB 84
  // alone; nothing more is asked about him.
  const asks = planAsks(view2);
  assert.ok(asks.every(a => a.eb !== 82), JSON.stringify(asks));
  const done = decide(view2);
  assert.equal(done.kind, 'offer');
  if (done.kind !== 'offer') return;
  assert.deepEqual(done.plan.stops, [{ eb: 84, hour: 17 }]);
  assert.deepEqual(done.plan.deferred, [82], 'deferred, never forgotten');
});

test('[give-up] nobody can be asked and nobody can be placed', () => {
  const done = decide({
    targetHour: 17,
    stops: [stop(82, { can: [], askedHours: [17, 18, 19], asks: 3 })],
  });
  assert.equal(done.kind, 'give-up');
});

test('[gaps] a pause is offered only when no question can remove it', () => {
  // Every hour is already answered: 17 and 20 are two hours apart, and there is
  // nothing left to ask → the gapped route is the offer.
  const done = decide({
    targetHour: 17,
    stops: [
      stop(82, { can: [17], askedHours: [17], asks: 1 }),
      stop(84, { can: [20], askedHours: [20], asks: 1 }),
    ],
    maxAsks: 1,
  });
  assert.equal(done.kind, 'offer');
  if (done.kind !== 'offer') return;
  assert.equal(done.plan.totalGap, 2, `${JSON.stringify(done.plan)}`);
});
