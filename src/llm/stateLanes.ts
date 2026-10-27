// STATE LANES (R2, docs/routing-audit-2026-10-23.md).
//
// intent resolution and SERVE-WORTHINESS are different questions. Every
// mis-route of the last month whose DETECTORS were right collapsed here:
// the lane matched, but the lane's serve did not belong to the state
// ("SKAPO E TOA. ZA SEKOJ STAN PO 300DEN" → fee objection → property card;
// "more?" after a landmark → batch serve; predloži → not-found line again).
// Until now those were each patched with an ad-hoc negation guard at the
// serving site.
//
// This module makes serve-allowance DATA: a lane must look up its serve
// grade (batch, card, ladder, ...) and the STATE decides which grades may
// serve. The resolver FAILS OPEN (a lane not in any deny list serves as
// it does today) so a missing row can never freeze the funnel — the deny
// rows are the ones from real mis-serves, the same calibration rule the
// route corpus follows ("every production misroute becomes a row first").
// The R1 migration (see docs/routing-audit-2026-10-23.md) grows this map
// to a full allow-list as lanes move into ROUTING_ORDER.

/** How a lane is allowed to TALK. Named by the family that fired. */
export type Lane = string;

/** The modality of the reply — what the serve actually DOES. */
export type ServeGrade =
  | 'property-batch'   // serveBatch / multi-card presentation
  | 'property-card'    // one property's card
  | 'not-found'        // the EB-not-found line
  | 'owner-relay'      // negotiate/owner-check relay
  | 'fee-ladder'       // fee nag / why / complain ladder
  | 'info'             // informational answer (legal, workdays, essays)
  | 'funnel-ask';      // discovery / filter questions

/**
 * States numeric property SERVES must never come from: pre-intake,
 * queue/handshake and terminal states. Calibration: no batch is correct
 * while the funnel has not presented anything, while an owner handshake
 * or a queued/escalated turn is pending, or after termination.
 */
export const PROPERTY_SERVE_DENY_STATES: readonly string[] = [
  'idle', 'intent', 'discovery',
  'queued', 'escalated', 'terminated',
  'owner_checking', 'pending', 'visit_scheduling', 'time_confirm',
];

/** Grade → states it must be denied in. Fail-open router (below). */
const GRADE_DENIES: Record<ServeGrade, readonly string[] | undefined> = {
  'property-batch': PROPERTY_SERVE_DENY_STATES,
  'property-card': PROPERTY_SERVE_DENY_STATES,
  // The not-found line is an ANSWER to an EB ask; the visit/owner/queue
  // states have no EB ask in flight (the predloži repeat bug family).
  'not-found': ['queued', 'escalated', 'terminated', 'owner_checking', 'pending', 'visit_scheduling', 'time_confirm'],
  'owner-relay': ['idle', 'intent', 'discovery', 'property_locate'],
  'fee-ladder': undefined, // the fee ladder is state-gated at call sites already
  'info': undefined,
  'funnel-ask': undefined,
};

/** The one generic acknowledgement used when a serve is denied. The turn
 *  still gets a reply (silence is never the answer) but the lane's
 *  full text — a card, a batch, a relay — never fires. */
export const GENERIC_ACK_KEY = 'serve.wrongstate';
export const GENERIC_ACK_FALLBACK =
  'Прислушувам детално во текот на разговорот — бидете слободни да продолжите.';

/** True when a lane's serve grade may NOT run in this state. The default
 *  is DENY=NONE: only explicitly denied (lane)/state pairs fail closed,
 *  exactly like an audit finding — never minutes of guesswork. */
export function laneServeDenied(lane: Lane, state: string, grade: ServeGrade): boolean {
  const states = GRADE_DENIES[grade];
  if (!states) return false;
  // An unmatched specific deny row v. state — the router is data-driven.
  void lane; // lane-specific rows land with the R1 moves; grade is what is calibrated today
  return states.includes(state);
}
