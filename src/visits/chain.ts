// THE VISIT CHAIN — several flats, one afternoon, linked hour by hour.
//
// The owner's 2026-11-11 brief: a client who wants to see several flats is
// arranged as ONE non-stop chain (16:00 → 17:00 → 18:00 …), in whatever order
// the owners can actually do, with the client's own start hour kept when at all
// possible and adjusted (earlier or later) when he is open to it.
//
// This module is the solver: pure arithmetic over who can do which hours. It
// knows nothing about messages, owners or sessions — the handler collects the
// constraints and asks it for a plan, then the owners are re-confirmed at the
// hours the plan assigns (a window is not a slot).
//
// Rules encoded here:
//   • hourly, contiguous slots — a gap is a defect, not a preference;
//   • the client's target hour wins; a shift is only searched when he is
//     flexible, and never more than ±3 hours;
//   • the visit window 09:00–21:00 is absolute;
//   • when not every flat can be linked, the chain is still built for as many
//     as possible and the dropped flats are named — never a silent omission.

import { VISIT_FIRST_HOUR, VISIT_LAST_HOUR } from './time';

/** ONE STOP of a chain as the session carries it: the owner's answer and the
 *  hour he was asked about, so a counter can be re-solved and re-confirmed. */
export interface VisitPlanStop {
  eb: number;
  askedHour?: number;
  /** How many times THIS owner was asked about this route (the brief caps a
   *  re-ask at three — after that the stop is dropped and named, never
   *  ping-ponged forever). */
  asks?: number;
  /** The solved route's hour for this stop while it is being re-confirmed —
   *  a window is not a slot, so the owner is asked for the hour he ended up at
   *  (absent on the first ask, which follows the client's own order). */
  pendingHour?: number;
  /** Hours the owner can do that day (his answer). Absent while unasked. */
  hours?: number[];
  status: 'pending' | 'asked' | 'ok' | 'counter' | 'dropped';
}

export interface VisitPlanState {
  /** Epoch ms at 00:00 of the visit day. */
  dayMs: number;
  /** The client's hour (24h) — the start he asked for. */
  targetHour: number;
  /** The client's raw term, for renders (never re-parsed against a later clock). */
  term: string;
  stops: VisitPlanStop[];
  /** May the start move ±3 hours? (his own yes). */
  flexible?: boolean;
  /** The solved route, filled when the chain is ready for the client. */
  assignments?: Array<{ eb: number; hour: number }>;
  /** Flats that could not be linked (reported to the client, never hidden). */
  dropped?: number[];
}

export interface ChainStop {
  eb: number;
  /** Hours (0–23) the owner can do that day. Absent = the whole window. */
  hours?: number[];
}

export interface ChainPlan {
  /** The hour the chain starts (0–23). */
  startHour: number;
  /** Hour the client asked for. */
  targetHour: number;
  /** startHour − targetHour (0 when his hour was kept). */
  shiftedBy: number;
  /** The booked stops, in visit order. */
  stops: Array<{ eb: number; hour: number }>;
  /** Flats that could not be linked, in the client's order. */
  dropped: number[];
}

export interface SolveInput {
  targetHour: number;
  stops: ChainStop[];
  /** Busy hour starts (0–23) on that day — the agency's own calendar. */
  busy?: number[];
  /** May the client's start hour move? */
  flexible?: boolean;
  /** The widest shift searched, in hours (default 3 — the owner's rule). */
  maxShiftHours?: number;
}

/** Every ordering of `items`, identity first (the client's own order). */
function* permutations<T>(items: T[]): Generator<T[]> {
  const n = items.length;
  const idx = items.map((_, i) => i);
  // Identity first: the client's order is the preference.
  yield idx.map(i => items[i]!);
  if (n < 2) return;
  const c = new Array<number>(n).fill(0);
  let i = 0;
  while (i < n) {
    if (c[i]! < i) {
      const k = i % 2 === 0 ? 0 : c[i]!;
      [idx[k], idx[i]] = [idx[i]!, idx[k]!];
      yield idx.map(j => items[j]!);
      c[i]!++;
      i = 0;
    } else {
      c[i] = 0;
      i++;
    }
  }
}

function allows(stop: ChainStop, hour: number): boolean {
  if (!stop.hours || stop.hours.length === 0) return true;
  return stop.hours.includes(hour);
}

/**
 * Try to lay the given stops contiguously from `startHour`.
 * Returns the stops in the order that fits, or undefined.
 */
function fitContiguous(stops: ChainStop[], startHour: number, busy: Set<number>): Array<{ eb: number; hour: number }> | undefined {
  if (startHour < VISIT_FIRST_HOUR) return undefined;
  if (startHour + stops.length - 1 > VISIT_LAST_HOUR) return undefined;
  for (const order of permutations(stops)) {
    let ok = true;
    const placed: Array<{ eb: number; hour: number }> = [];
    for (let i = 0; i < order.length; i++) {
      const hour = startHour + i;
      if (busy.has(hour) || !allows(order[i]!, hour)) { ok = false; break; }
      placed.push({ eb: order[i]!.eb, hour });
    }
    if (ok) return placed;
  }
  return undefined;
}

/**
 * The chain plan: the client's hour first, then ±1..maxShift when he is
 * flexible; every flat placed, or — when that is impossible — as many as fit,
 * with the rest reported as dropped.
 */
export function solveChain(input: SolveInput): ChainPlan | undefined {
  const busy = new Set(input.busy ?? []);
  const maxShift = input.flexible ? Math.max(0, input.maxShiftHours ?? 3) : 0;
  const starts: number[] = [input.targetHour];
  for (let d = 1; d <= maxShift; d++) {
    // LATER before EARLIER at equal distance: a late client keeps his evening.
    starts.push(input.targetHour + d, input.targetHour - d);
  }
  for (const start of starts) {
    const placed = fitContiguous(input.stops, start, busy);
    if (placed) {
      return {
        startHour: start,
        targetHour: input.targetHour,
        shiftedBy: start - input.targetHour,
        stops: placed,
        dropped: [],
      };
    }
  }
  // NOT EVERY FLAT CAN BE LINKED: build the chain for as many as possible,
  // dropping the last stop first (the client's own priority order). Never a
  // silent omission — `dropped` names what is left out.
  if (input.stops.length >= 2) {
    for (let drop = input.stops.length - 1; drop >= 0; drop--) {
      const kept = input.stops.filter((_, i) => i !== drop);
      for (const start of starts) {
        const placed = fitContiguous(kept, start, busy);
        if (placed) {
          return {
            startHour: start,
            targetHour: input.targetHour,
            shiftedBy: start - input.targetHour,
            stops: placed,
            dropped: [input.stops[drop]!.eb],
          };
        }
      }
    }
  }
  return undefined;
}
