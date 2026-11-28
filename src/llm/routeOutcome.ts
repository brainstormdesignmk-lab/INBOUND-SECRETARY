// WHAT HAPPENED AFTER A VERDICT — the label source for the route table.
//
// The classifier's own verdict is NOT a valid label (grading a router against
// the thing it replaces is circular, and 31 % of verdicts are STAY, i.e. no
// label at all). The honest signals are the CLIENT's next move and the
// operator's corrections:
//
//   corrected  a bank correction whose question is this row's text, filed
//              inside the window — the answer was wrong and a human said so.
//   clean      no further turn from this chat inside the window: the answer
//              landed and the conversation paused. The only outcome that can
//              teach a route, and even then only for the surfaced event.
//   repeat     the client sent another message that the SAME event answered
//              again — the question was not understood the first time (the
//              [23:47]/[23:48] class: «во кој дел од градот?» → «NEBITNO
//              KADE» read as a location, asked back).
//   moved      the FSM state changed: the turn advanced the funnel.
//   followup   a different event inside the window — neither a repeat nor a
//              move; carries no teaching signal.
//
// PURE: no I/O, no clock reads (the window is passed in). The linker owns the
// queries; this owns the decision, so the rules can be pinned without a DB.

export type RouteOutcome = 'clean' | 'corrected' | 'repeat' | 'moved' | 'followup' | 'unknown';

/** The prediction this outcome describes. */
export interface OutcomeVerdict {
  event: string;
  state: string;
  /** Epoch ms the verdict was recorded. */
  createdAt: number;
}

/** The chat's NEXT verdict row, when one arrived inside the window. */
export interface OutcomeNext {
  event: string;
  state: string;
  createdAt: number;
}

/** How long after a turn a follow-up still counts as a reaction to it. Ten
 *  minutes is the field cadence (a client who pauses longer and comes back is
 *  asking something new, not reacting). */
export const OUTCOME_WINDOW_MS = 10 * 60_000;

export function classifyOutcome(
  verdict: OutcomeVerdict,
  next: OutcomeNext | undefined,
  corrected: boolean,
  windowMs: number = OUTCOME_WINDOW_MS,
): RouteOutcome {
  if (!verdict || typeof verdict.createdAt !== 'number') return 'unknown';
  // A human correction outranks everything: it is the only signal that knows
  // the answer was wrong rather than merely unacknowledged.
  if (corrected) return 'corrected';
  if (!next) return 'clean';
  const gap = next.createdAt - verdict.createdAt;
  if (!Number.isFinite(gap) || gap < 0) return 'unknown';
  if (gap > windowMs) return 'clean'; // the conversation paused — the answer landed
  if (next.event === verdict.event) return 'repeat';
  if (next.state !== verdict.state) return 'moved';
  return 'followup';
}

/** May this outcome teach a route? Only a clean turn — and the caller still
 *  requires reviewer/detector confirmation before the row is ACTIVE (Phase 3
 *  promotion). */
export function isTeachable(outcome: RouteOutcome): boolean {
  return outcome === 'clean';
}
