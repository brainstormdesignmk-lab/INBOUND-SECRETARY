// THE ROUTE TIER — the one place a learned route may become a verdict.
//
// Serving rules, all deliberate:
//   • OFF      nothing is read; the remote tier runs as today.
//   • SHADOW   the route is looked up and its agreement recorded, but the
//              remote verdict still serves. Zero client risk while evidence
//              accumulates.
//   • SERVE    an ACTIVE row with a SAFE event serves. Anything else abstains
//              upward — a staged row, a frozen row, a commitment event, a
//              signature that does not match exactly.
//
// NO SIMILARITY. The calibration (runbook §4) measured top-1 at 42.4 % and only
// 75 % accuracy at the best serving threshold, with negation-blind near-matches
// («ne moze» ≈ «moze»). So this module compares normalized identity and the
// context signature EXACTLY, and abstains on everything else.

import { Classified } from './classify';
import { EventType } from '../fsm/machine';
import { ChatSession } from '../fsm/session';
import { buildRouteSig, sigKey } from './routeSig';
import { normalizedKey } from '../store/capture';
import { RouteStore, RouteRow, SAFE_EVENTS } from '../store/routes';

export type RouteMode = 'off' | 'shadow' | 'serve';

export function parseRouteMode(value: string | undefined): RouteMode {
  if (value === 'serve') return 'serve';
  if (value === 'shadow') return 'shadow';
  return 'off';
}

export interface RouteCandidate {
  route: RouteRow;
  norm: string;
  sigKey: string;
}

/** Look up the exact identity. This is the ONLY lookup — no fallback, no
 *  fuzzy match, no "closest" row. */
export function findRoute(
  store: RouteStore,
  session: ChatSession,
  text: string,
): RouteCandidate | undefined {
  const sig = buildRouteSig(session, text);
  const key = sigKey(sig);
  const norm = normalizedKey(text);
  if (!norm) return undefined;
  const route = store.findExact(norm, session.state, key);
  return route ? { route, norm, sigKey: key } : undefined;
}

/** Is this row allowed to decide a turn? */
export function servable(route: RouteRow, mode: RouteMode): boolean {
  if (mode !== 'serve') return false;
  if (route.lifecycle !== 'active') return false;
  return SAFE_EVENTS.has(route.event);
}

/** The verdict a servable route produces, or undefined (abstain upward). */
export function routeVerdict(candidate: RouteCandidate | undefined, mode: RouteMode): Classified | undefined {
  if (!candidate) return undefined;
  if (!servable(candidate.route, mode)) return undefined;
  return {
    event: { type: candidate.route.event as EventType },
    offensive: false,
    offenseLevel: 0,
    tier: 'route',
    latencyMs: 0,
    attempts: 0,
  };
}

/** Shadow bookkeeping: the remote verdict is in — did the route agree?
 *  A shadow MISS is evidence against the row; it never changes a client turn. */
export function noteShadowAgreement(
  store: RouteStore,
  candidate: RouteCandidate | undefined,
  actualEvent: string,
): void {
  if (!candidate) return;
  if (candidate.route.lifecycle === 'retired') return;
  store.recordShadow(candidate.route.id, candidate.route.event === actualEvent);
}

/** The servable set, exported for tests and the review tooling. */
export const SERVABLE_EVENTS: ReadonlySet<string> = SAFE_EVENTS;
