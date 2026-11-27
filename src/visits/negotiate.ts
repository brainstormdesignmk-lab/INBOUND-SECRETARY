// THE ROUTE NEGOTIATOR — WHICH owner is asked WHICH hour next.
//
// The solver (chain.ts) arranges the hours the owners have allowed. This module
// decides the QUESTION that gets the route there, which is the part that
// "balances the ping-pong" between several owners:
//
//   client wants 17 · owner 1 can only do 18 · owner 2 can only do 16
//   → solving the known hours gives 16 + 18 with a one-hour pause, but asking
//     owner 2 for 19 turns that into 18 + 19 with no pause. `planAsks` finds
//     that question and returns it instead of settling for the pause.
//
// THE ORDER OF QUESTIONS:
//   1. an owner who was never asked is asked the hour the CURRENT best plan
//      gives him (unknown hours are free, so the plan is contiguous from the
//      client's hour — this is how the client's own hour finds its owner);
//   2. otherwise ONE more question that strictly improves the plan under the
//      solver's own objective (more stops, less shift, smaller pause);
//   3. otherwise there is nothing left to ask — the caller offers the route.
//
// ANTI-LOOP is structural: an hour that was already put to an owner is never
// asked again, every question spends that owner's budget, and a stop whose
// budget is gone leaves the route (`out`) to be negotiated separately.
//
// Pure on purpose: no sessions, no copy, no owner channel.

import { comparePlans, solveChain, type ChainPlan } from './chain';
import { VISIT_FIRST_HOUR, VISIT_LAST_HOUR } from './time';

export interface NegotiateStop {
  eb: number;
  /** The hours the owner ANSWERED with. `undefined` = never asked yet. */
  can?: number[];
  /** Every hour already put to him — never asked twice. */
  askedHours?: number[];
  /** The hours he gave on an EARLIER day (a deferred flat's own answer). The
   *  first question follows them: asking a man who already said «only 09:00»
   *  whether he can do 14:00 spends a question on a refusal we were told. */
  prefer?: number[];
  /** How many questions this owner has had (the per-owner budget). */
  asks?: number;
  /** Out of this route (sold/gone/budget spent) — never asked again. */
  out?: boolean;
}

export interface NegotiateView {
  targetHour: number;
  stops: NegotiateStop[];
  /** Hours already booked in the agency's calendar. */
  busy?: number[];
  maxGap?: number;
  maxShiftHours?: number;
  /** Questions per owner before he leaves the route (default 3). */
  maxAsks?: number;
}

export interface NegotiateAsk {
  eb: number;
  hour: number;
  /** `first` = he was never asked; `connect` = the one question that closes a
   *  pause or brings a deferred flat back into the route. */
  reason: 'first' | 'connect';
}

export type NegotiateDecision =
  | { kind: 'ask'; asks: NegotiateAsk[] }
  | { kind: 'offer'; plan: ChainPlan }
  | { kind: 'give-up' };

const WINDOW: number[] = Array.from({ length: VISIT_LAST_HOUR - VISIT_FIRST_HOUR + 1 }, (_, i) => VISIT_FIRST_HOUR + i);

function solve(view: NegotiateView, override?: { eb: number; add: number[] }): ChainPlan | undefined {
  const stops = view.stops
    .filter(s => !s.out)
    .map(s => ({
      eb: s.eb,
      hours: override && override.eb === s.eb ? [...(s.can ?? []), ...override.add] : s.can,
    }));
  if (stops.length === 0) return undefined;
  return solveChain({
    targetHour: view.targetHour,
    stops,
    busy: view.busy,
    maxGap: view.maxGap ?? 2,
    maxShiftHours: view.maxShiftHours ?? 3,
  });
}

/**
 * Every question that must go out before the route can be offered.
 *
 * All the owners who were never asked are asked AT ONCE (their plan hours are
 * independent), which is what makes a first round parallel. Once everyone has
 * answered, at most ONE further question is returned — the single one that
 * improves the plan; asking two speculative hours at once would spend an
 * owner's budget on a guess the other answer might make unnecessary.
 */
/** The view with the owners who may no longer be asked removed: an owner whose
 *  budget is spent and who never gave an hour cannot be part of a route —
 *  offering it would promise a visit nobody agreed to. */
function effective(view: NegotiateView): NegotiateView {
  const budget = view.maxAsks ?? 3;
  return {
    ...view,
    stops: view.stops.filter(s => !s.out && !(s.can === undefined && (s.asks ?? 0) >= budget)),
  };
}

export function planAsks(view: NegotiateView): NegotiateAsk[] {
  const budget = view.maxAsks ?? 3;
  const scope = effective(view);
  const live = scope.stops;
  const remaining = (s: NegotiateStop): boolean => (s.asks ?? 0) < budget;
  const plan = solve(scope);
  if (!plan) {
    // Nothing can be placed with what is known: the only honest move is the
    // first unasked owner (an unknown hour is free), else give up.
    const unknown = live.find(s => s.can === undefined && remaining(s));
    return unknown ? [{ eb: unknown.eb, hour: scope.targetHour, reason: 'first' }] : [];
  }
  // THE CLIENT'S ORDER OPENS THE ROUTE (the [09:00] V16K11 capture): he chose
  // «ПОНЕДЕЛНИК 6» for a pair, and the owner of the FIRST flat was asked about
  // 19:00 while 18:00 went to the second — «the ask should be based on his
  // choice first». The plan's own placement is kept (it is what makes the round
  // contiguous and what every later question is judged against), and only the
  // ONE correction this rule needs is applied: if the plan handed HIS hour to a
  // later stop while the first stop in his order got another one, the two hours
  // are swapped. A preferred hour (a deferred flat's earlier answer) is his own
  // fact about himself and never moves.
  const firstRound: NegotiateAsk[] = [];
  for (const placed of plan.stops) {
    const stop = live.find(s => s.eb === placed.eb);
    if (!stop || stop.can !== undefined) continue;
    if (!remaining(stop)) continue;
    // HIS OWN EARLIER ANSWER LEADS (a deferred flat's second day): the hours he
    // gave on the missed day are the question to ask now — the plan's hour is
    // only the fallback, because an unknown hour is free and the plan cannot
    // know his real one. Both are still questions, never a placement.
    const prefer = (stop.prefer ?? []).find(h => h >= VISIT_FIRST_HOUR && h <= VISIT_LAST_HOUR
      && !(scope.busy ?? []).includes(h));
    const hour = prefer ?? placed.hour;
    if ((stop.askedHours ?? []).includes(hour)) continue;
    firstRound.push({ eb: stop.eb, hour, reason: 'first' });
  }
  const lead = firstRound.find(a => {
    const stop = live.find(s => s.eb === a.eb);
    return !!stop && (stop.prefer ?? []).length === 0;
  });
  if (lead && lead.hour !== scope.targetHour
    && !(scope.busy ?? []).includes(scope.targetHour)) {
    const holder = firstRound.find(a => a.eb !== lead.eb && a.hour === scope.targetHour);
    // Only a swap is safe: the holder must be movable to the hour the lead held
    // (nobody asked it, nobody is busy in it). Otherwise the lead keeps what the
    // plan gave it — a fabricated slot for the second flat is worse than the
    // order it was asked in.
    const holderStop = holder ? live.find(s => s.eb === holder.eb) : undefined;
    // NO HOLDER MEANS NOBODY TOOK HIS HOUR: a stop that moved away on its own
    // `prefer` left the anchor free, and inventing it for the next flat would
    // fabricate a slot (the [prefer] contract: only a swap is a correction).
    const movable = !!holder && (
      !(holderStop?.prefer ?? []).length
      && !(scope.busy ?? []).includes(lead.hour)
      && !(holderStop?.askedHours ?? []).includes(lead.hour));
    if (movable) {
      const wasLead = lead.hour;
      lead.hour = scope.targetHour;
      if (holder) holder.hour = wasLead;
    }
  }
  if (firstRound.length > 0) return firstRound;

  // THE LOOKAHEAD — one honest question, judged by the solver's own objective.
  let best: { ask: NegotiateAsk; plan: ChainPlan } | undefined;
  for (const stop of live) {
    if (!remaining(stop)) continue;
    for (const hour of WINDOW) {
      if ((scope.busy ?? []).includes(hour)) continue;
      if ((stop.can ?? []).includes(hour)) continue; // he already said this hour
      if ((stop.askedHours ?? []).includes(hour)) continue; // …and we already asked
      const next = solve(scope, { eb: stop.eb, add: [hour] });
      if (!next || !comparePlans(next, plan)) continue;
      if (!best || comparePlans(next, best.plan)) {
        best = { ask: { eb: stop.eb, hour, reason: 'connect' }, plan: next };
      }
    }
  }
  return best ? [best.ask] : [];
}

/** THE DECISION: ask (one or more owners), offer the route, or give up. */
export function decide(view: NegotiateView): NegotiateDecision {
  const asks = planAsks(view);
  if (asks.length > 0) return { kind: 'ask', asks };
  const plan = solve(effective(view));
  if (!plan || plan.stops.length === 0) return { kind: 'give-up' };
  return { kind: 'offer', plan };
}
