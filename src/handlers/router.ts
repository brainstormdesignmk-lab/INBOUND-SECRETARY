// Intent router — makes the if/else chain in inbound.ts AUDITABLE.
//
// The handler is an order-dependent guard chain: correctness depends on
// WHICH check runs FIRST (the "kade mu e lokacijata" bug was exactly an
// ordering bug: EXACT_ADDRESS captured what WHERE_IS should have). This
// module encodes that order as DATA so it can be:
//   1. tested  — tests/router.test.ts asserts the critical precedences
//   2. logged  — every message logs msg → intent → handler (see routeLog)
//
// The chain in inbound.ts remains the executor; this module mirrors its
// pure-text precedences so any future detector insertion that breaks an
// ordering constraint fails a test instead of shipping silently.

import { classifyOffensive } from '../antiabuse/offensive';
import {
  detectExactAddressAsk, detectWhereIs, detectOwnerContact,
  isKadeTocno, detectPropertyDescription, detectService, detectBothServices,
  detectVisitCancellation, detectOfftopic, detectDefer, detectNegotiate,
  detectProvisionAsk, detectEscalation, detectDocumentsAsk, detectMortgageAsk,
  detectNeighborhoodAsk, detectSchedulingFlex,
} from '../llm/deterministic';

export interface RouteRule {
  intent: string;
  /** Human-readable precedence note — WHY it sits at this position. */
  note: string;
  /** Pure-text guard mirroring the inbound.ts condition for this branch. */
  fires: (text: string, state: string) => boolean;
}

// ORDER IS SEMANTIC — do not reorder without reading the notes.
export const ROUTING_ORDER: RouteRule[] = [
  { intent: 'OFFENSIVE', note: 'zero-output policy wins over everything',
    fires: t => classifyOffensive(t).isOffensive },
  { intent: 'EXACT_ADDRESS', note: 'explicit address demand WITHOUT каде → privacy protocol. Must sit before WHERE_IS only via the !whereIs guard — каде-prefixed questions fall through',
    fires: (t) => detectExactAddressAsk(t) && !isKadeTocno(t) && !detectWhereIs(t) },
  { intent: 'OWNER_CONTACT', note: 'client leaves name/phone — captured before any other reply',
    fires: t => detectOwnerContact(t) },
  { intent: 'WHERE_IS', note: 'any каде-question → landmark rotation. Beats EXACT_ADDRESS by the guard above and beats description routing below',
    fires: t => !!detectWhereIs(t) },
  { intent: 'PROPERTY_DESCRIPTION', note: '"гарсоњерата кај амбасадата" — remembered-property flow before FSM discovery swallows it',
    fires: (t) => detectPropertyDescription(t) && !detectService(t) && !detectBothServices(t) },
  { intent: 'VISIT_CANCEL', note: 'cancellation only meaningful in visit states',
    fires: (t, s) => detectVisitCancellation(t) &&
      ['visit_scheduling', 'owner_checking', 'time_confirm'].includes(s) },
  // State-gated informational intents (the tail of the chain):
  { intent: 'OFFTOPIC', note: 'small talk redirect — not while owner handshake pending',
    fires: (t, s) => detectOfftopic(t) && !['owner_checking', 'pending'].includes(s) },
  { intent: 'DEFER', note: '"ќе размислам" — closing/presentation/property states',
    fires: (t, s) => detectDefer(t) &&
      ['closing', 'presentation', 'property_query', 'property_locate'].includes(s) },
  { intent: 'NEGOTIATE', note: 'price pushback — commercial states only',
    fires: (t, s) => detectNegotiate(t) &&
      ['closing', 'presentation', 'property_query'].includes(s) },
  { intent: 'PROVISION_ASK', note: 'fee question — broad state gate',
    fires: (t, s) => detectProvisionAsk(t) &&
      ['closing', 'presentation', 'property_query', 'discovery', 'intent', 'idle'].includes(s) },
  { intent: 'ESCALATION', note: 'manager request — no state gate, always honored',
    fires: t => detectEscalation(t) },
  { intent: 'DOCUMENTS_ASK', note: 'documents info — broad gate',
    fires: (t, s) => detectDocumentsAsk(t) &&
      ['closing', 'presentation', 'property_query', 'discovery', 'intent', 'idle'].includes(s) },
  { intent: 'MORTGAGE_ASK', note: 'financing info — broad gate',
    fires: (t, s) => detectMortgageAsk(t) &&
      ['closing', 'presentation', 'property_query', 'discovery', 'intent', 'idle'].includes(s) },
  { intent: 'NEIGHBORHOOD_ASK', note: 'area advice — early-funnel states',
    fires: (t, s) => detectNeighborhoodAsk(t) && ['idle', 'intent', 'discovery'].includes(s) },
  { intent: 'SCHEDULING_FLEX', note: 'time-window preference — visit states only',
    fires: (t, s) => detectSchedulingFlex(t) &&
      ['visit_scheduling', 'owner_checking', 'time_confirm'].includes(s) },
];

/** Which intent WOULD fire for this text in this state — first match in
 *  ROUTING_ORDER, or FALLTHROUGH (LLM/classifier territory). */
export function resolveIntent(text: string, state: string): string {
  for (const r of ROUTING_ORDER) {
    try { if (r.fires(text, state)) return r.intent; } catch { /* never let the mirror crash callers */ }
  }
  return 'FALLTHROUGH';
}

// --- decision log -----------------------------------------------------------
// Ring buffer + loud console line. The TUI redirects console to data/tui.log,
// so `[route]` lines land there; /status-style tooling can read ROUTE_LOG.

export interface RouteEntry { at: number; chatId: string; text: string; intent: string }
const ROUTE_LOG: RouteEntry[] = [];
const ROUTE_LOG_MAX = 500;

export function routeLog(chatId: string, text: string, intent: string, kind: 'actual' | 'predict' = 'actual'): void {
  const entry: RouteEntry = { at: Date.now(), chatId, text: text.slice(0, 80), intent };
  ROUTE_LOG.push(entry);
  if (ROUTE_LOG.length > ROUTE_LOG_MAX) ROUTE_LOG.shift();
  const tag = kind === 'predict' ? '[route?]' : '[route]';
  console.log(`${tag} ${chatId} → ${intent} :: "${entry.text}"`);
}

export function recentRoutes(n = 50): RouteEntry[] {
  return ROUTE_LOG.slice(-n);
}
