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
// Rules encoded here (the owner's answers of 2026-11-19 included):
//   • hourly slots; CONTIGUOUS wins, but a pause of up to `maxGap` hours is a
//     legal route — 1 hour preferred, 2 tolerated — and the client is the one
//     asked to accept it (the solver only proposes it);
//   • the client's target hour wins; a shift is searched ALWAYS (±3 hours) and
//     is always disclosed — an earlier start that chain-links is offered to
//     him to accept or refuse, never applied silently;
//   • the visit window 09:00–21:00 is absolute;
//   • NOBODY IS DROPPED: when not every flat can share the day, the route is
//     built for the flats that fit and the rest come back as `deferred` — each
//     keeps its own negotiation for another day/hour;
//   • one lexicographic objective decides everything (see `scoreOf`), so the
//     old hand-written drop loop cannot disagree with the placement search.

import { VISIT_FIRST_HOUR, VISIT_LAST_HOUR } from './time';

/** ONE STOP of a chain as the session carries it: the owner's answer and the
 *  hour he was asked about, so a counter can be re-solved and re-confirmed. */
export interface VisitPlanStop {
  eb: number;
  askedHour?: number;
  /** How many times THIS owner was asked about this route (the brief caps a
   *  re-ask at three — after that the stop leaves the route and gets its own
   *  term, never an endless ping-pong). */
  asks?: number;
  /** EVERY hour this owner has been asked about on THIS day — an hour already
   *  put to him is never asked again (the negotiator's anti-loop). */
  askedHours?: number[];
  /** The solved route's hour for this stop while it is being re-confirmed —
   *  a window is not a slot, so the owner is asked for the hour he ended up at
   *  (absent on the first ask, which follows the client's own order). */
  pendingHour?: number;
  /** WHEN this stop's current question went out. The route is asked in
   *  PARALLEL, so one silent owner must not hold the client hostage forever
   *  (the [04:41]–[05:21] capture: the first owner answered in three minutes,
   *  the second never did, and the client heard nothing for forty). The handler
   *  drops a stop whose window has passed and finishes the route with the
   *  answers it has. */
  askedAt?: number;
  /** Hours the owner can do that day (his answer). Absent while unasked. */
  hours?: number[];
  /** THE HOURS HE GAVE ON AN EARLIER DAY (never an answer for THIS day): a
   *  flat deferred once was already asked, and the hour he named then is the
   *  only honest first question now. It aims the ask — it never places him
   *  without an answer, so the route is still negotiated, not assumed. */
  prefer?: number[];
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
  /** Flats this day's route cannot hold. They are NOT abandoned: each keeps
   *  its own negotiation for another day/hour and is named to the client. */
  deferred?: number[];
  /** Stops whose owner never answered within the check window. They are NOT
   *  refusals and must not be reported as one — the client hears that the
   *  owner did not reply, and the flat stays owed. */
  unanswered?: number[];
  /** LEGACY name for a flat that is genuinely unavailable (sold, gone, refused
   *  the route). Kept so old persisted sessions still load. */
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
  /** Hours of pause between consecutive stops (sum of `gap`). 0 = non-stop. */
  totalGap: number;
  /** Flats that could not share this day, in the client's order. They are NOT
   *  abandoned: each is negotiated as its own visit on another day/hour. */
  deferred: number[];
  /** How far the visit ORDER strayed from the client's own (the last tie-break
   *  of the objective, exposed so the negotiator compares plans the SAME way). */
  inversions: number;
}

export interface SolveInput {
  targetHour: number;
  stops: ChainStop[];
  /** Busy hour starts (0–23) on that day — the agency's own calendar. */
  busy?: number[];
  /** Kept for the caller's vocabulary. A shift is ALWAYS searched and stated;
   *  this only marks a client who said he is open to any hour, which the
   *  objective already prefers. It never enables or forbids a shift. */
  flexible?: boolean;
  /** The widest shift searched, in hours (default 3 — the owner's rule). */
  maxShiftHours?: number;
  /** The longest PAUSE allowed between two visits, in hours (0 = non-stop).
   *  Default 2 (the owner tolerates two, prefers one — the objective prefers
   *  the smaller pause). Never more than 2. */
  maxGap?: number;
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

/** A stop's hours: `undefined` = NOT ASKED YET (any hour may work); an EMPTY
 *  list = asked and nothing fits. The old reader treated both as "any", so an
 *  owner who answered "no hour" was still placed. */
function allows(stop: ChainStop, hour: number): boolean {
  if (stop.hours === undefined) return true;
  return stop.hours.includes(hour);
}

interface Placement {
  stops: Array<{ eb: number; hour: number }>;
  startHour: number;
  shift: number;
  totalGap: number;
  inversions: number;
  deferred: number[];
}

/** Order distance from the client's own order — the last tie-break, so an
 *  equally good route keeps his priority list. */
function inversions(order: ChainStop[], reference: ChainStop[]): number {
  const rank = new Map(reference.map((s, i) => [s.eb, i]));
  let n = 0;
  for (let i = 0; i < order.length; i++) {
    for (let j = i + 1; j < order.length; j++) {
      if ((rank.get(order[i]!.eb) ?? 0) > (rank.get(order[j]!.eb) ?? 0)) n++;
    }
  }
  return n;
}

/** One subset in one order: the best hours, or undefined. */
function placeOrder(order: ChainStop[], targetHour: number, maxShift: number, maxGap: number, busy: Set<number>): { stops: Array<{ eb: number; hour: number }>; startHour: number; totalGap: number } | undefined {
  let best: { stops: Array<{ eb: number; hour: number }>; startHour: number; totalGap: number } | undefined;
  const better = (a: { startHour: number; totalGap: number }, b: { startHour: number; totalGap: number }): boolean => {
    const da = Math.abs(a.startHour - targetHour);
    const db = Math.abs(b.startHour - targetHour);
    if (da !== db) return da < db;
    // LATER before EARLIER at equal distance: a late client keeps his evening.
    if ((a.startHour - targetHour) !== (b.startHour - targetHour)) return (a.startHour - targetHour) > (b.startHour - targetHour);
    return a.totalGap < b.totalGap; // 1 h pause beats a 2 h pause
  };
  const walk = (i: number, hour: number, placed: Array<{ eb: number; hour: number }>, gap: number): void => {
    if (i === order.length) {
      const cand = { stops: placed.slice(), startHour: placed[0]!.hour, totalGap: gap };
      if (!best || better(cand, best)) best = cand;
      return;
    }
    // The first stop may start anywhere in the tolerated shift window; every
    // later stop is i..i+maxGap after the previous one (a pause is a free hour
    // nobody visits in, and the calendar guard below keeps it genuinely free).
    const from = i === 0 ? Math.max(VISIT_FIRST_HOUR, targetHour - maxShift) : hour + 1;
    const to = i === 0 ? Math.min(VISIT_LAST_HOUR, targetHour + maxShift) : hour + 1 + maxGap;
    for (let h = from; h <= to && h <= VISIT_LAST_HOUR; h++) {
      if (busy.has(h) || !allows(order[i]!, h)) continue;
      placed.push({ eb: order[i]!.eb, hour: h });
      walk(i + 1, h, placed, i === 0 ? 0 : gap + (h - hour - 1));
      placed.pop();
    }
  };
  walk(0, 0, [], 0);
  return best;
}

/**
 * The route: as many flats as the day can hold, in an order whose hours their
 * owners allow, with the smallest honest shift and the smallest pause.
 *
 * ONE lexicographic objective (no second hand-written loop):
 *   1. stops placed               — most
 *   2. |start − target|           — least, and at equal distance the LATER
 *   3. total pause                — least (1 h before 2 h)
 *   4. the client's order         — fewest inversions
 * Flats outside the winning subset come back as `deferred`, never dropped.
 */
export function solveChain(input: SolveInput): ChainPlan | undefined {
  const busy = new Set(input.busy ?? []);
  const maxGap = Math.max(0, Math.min(2, input.maxGap ?? 2));
  const n = input.stops.length;
  // THE SHIFT CAP BOUNDS A CHAIN'S START, NOT A VISIT: with one flat there is
  // nothing to connect, so its own hour (however far from the client's anchor)
  // is a legitimate slot to OFFER him. Applying the cap to a single stop turned
  // «the owner can only do 09:00» into «the owners cannot be joined one after
  // another» — a sentence about joining for a visit that has no partner, and a
  // flat that could have been arranged was deferred instead.
  const maxShift = n === 1
    ? VISIT_LAST_HOUR - VISIT_FIRST_HOUR
    : Math.max(0, input.maxShiftHours ?? 3);
  if (n === 0) return undefined;
  // The client's own hour must BE a visit (the parser refuses an outside clock,
  // so this only guards a direct caller — a route is never seeded at 08:00).
  if (input.targetHour < VISIT_FIRST_HOUR || input.targetHour > VISIT_LAST_HOUR) return undefined;
  const full = (1 << n) - 1;
  // Sizes are the primary key, so the FIRST size that yields a placement wins;
  // masks ascend inside a size, which defers the LAST flats first on a tie.
  for (let size = n; size >= 1; size--) {
    let best: { plan: ChainPlan; placement: Placement } | undefined;
    for (let mask = 0; mask <= full; mask++) {
      if (countBits(mask) !== size) continue;
      const kept = input.stops.filter((_, i) => mask & (1 << i));
      const deferred = input.stops.filter((_, i) => !(mask & (1 << i))).map(s => s.eb);
      for (const order of permutations(kept)) {
        const placed = placeOrder(order, input.targetHour, maxShift, maxGap, busy);
        if (!placed) continue;
        const shift = placed.startHour - input.targetHour;
        const placement: Placement = {
          stops: placed.stops,
          startHour: placed.startHour,
          shift,
          totalGap: placed.totalGap,
          inversions: inversions(order, input.stops),
          deferred,
        };
        if (!best || beats(placement, best.placement)) best = { plan: toPlan(input, placement), placement };
      }
    }
    if (best) return best.plan;
  }
  return undefined;
}

function countBits(mask: number): number {
  let n = 0;
  for (let m = mask; m; m >>= 1) n += m & 1;
  return n;
}

/** The objective, compared lexicographically (true when `a` wins). */
function beats(a: Placement, b: Placement): boolean {
  if (a.stops.length !== b.stops.length) return a.stops.length > b.stops.length;
  if (Math.abs(a.shift) !== Math.abs(b.shift)) return Math.abs(a.shift) < Math.abs(b.shift);
  if (a.shift !== b.shift) return a.shift > b.shift; // later preferred at equal distance
  if (a.totalGap !== b.totalGap) return a.totalGap < b.totalGap;
  return a.inversions < b.inversions;
}

function toPlan(input: SolveInput, p: Placement): ChainPlan {
  return {
    startHour: p.startHour,
    targetHour: input.targetHour,
    shiftedBy: p.shift,
    stops: p.stops,
    totalGap: p.totalGap,
    deferred: p.deferred,
    inversions: p.inversions,
  };
}

/** Does plan `a` beat plan `b` under THE objective? Exported so the negotiator
 *  (which plan is worth one more owner question) never invents a second
 *  scoring rule that can disagree with the solver. */
export function comparePlans(a: ChainPlan, b: ChainPlan): boolean {
  if (a.stops.length !== b.stops.length) return a.stops.length > b.stops.length;
  if (Math.abs(a.shiftedBy) !== Math.abs(b.shiftedBy)) return Math.abs(a.shiftedBy) < Math.abs(b.shiftedBy);
  if (a.shiftedBy !== b.shiftedBy) return a.shiftedBy > b.shiftedBy;
  if (a.totalGap !== b.totalGap) return a.totalGap < b.totalGap;
  return a.inversions < b.inversions;
}
