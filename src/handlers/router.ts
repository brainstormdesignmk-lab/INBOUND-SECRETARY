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
  detectProvisionAsk, detectProvisionWho, detectEscalation, detectDocumentsAsk, detectMortgageAsk,
  detectNeighborhoodAsk, detectSchedulingFlex, detectComparison, detectFeatureAsk,
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

// --- simple deterministic dispatch table -------------------------------------
//
// The 15 terminal detector branches in inbound.ts (OFFTOPIC, DEFER, NEGOTIATE,
// etc.) all share one shape:
//   detectX(text) && stateGate(state) → bankKey || fallback
//
// This table encodes them as DATA so a new detector is one array entry —
// no if/else editing, no ordering accident.
//
// IMPORTANCE: order matters — first match wins.  The order mirrors the
// current if/else chain in inbound.ts exactly.

export interface SimpleDetector {
  intent: string;
  bankKey: string;
  fallback: string;
  detect: (text: string) => boolean;
  /** If omitted, fires in every state. */
  allowedStates?: string[];
}

export const SIMPLE_DETECTORS: SimpleDetector[] = [
  {
    intent: 'OFFTOPIC',
    bankKey: 'offtopic.redirect',
    fallback: 'Одете на темата, ве молам — како можам да Ви помогнам со имотите?',
    detect: detectOfftopic,
    allowedStates: undefined, // every state except owner_checking/pending — handled by stateGate below
  },
  {
    intent: 'DEFER',
    bankKey: 'followup.defer',
    fallback: 'Се разбира. Кога ќе се јавите, ќе бидам тука за Вас.',
    detect: detectDefer,
    allowedStates: ['closing', 'presentation', 'property_query', 'property_locate'],
  },
  {
    intent: 'NEGOTIATE',
    bankKey: 'price.negotiate',
    fallback: 'Цената е фиксна, но ако сакате можам да го контактам сопственикот за да видам дали има простор за преговарање.',
    detect: detectNegotiate,
    allowedStates: ['closing', 'presentation', 'property_query', 'contact_collection'],
  },
  {
    intent: 'PROVISION_WHO',
    bankKey: 'provision.who',  // resolved to .buy / .rent in handler
    fallback: 'Трошоците за адвокат и нотар се по договор. Вообичаена пракса е 50/50.',
    detect: detectProvisionWho,
    allowedStates: ['closing', 'presentation', 'property_query', 'discovery', 'intent', 'idle', 'contact_collection'],
  },
  {
    intent: 'PROVISION_ASK',
    bankKey: 'provision.ask',
    fallback: 'Агенциската провизија изнесува 500 денари (10 евра) и се плаќа при организација на посетата.',
    detect: detectProvisionAsk,
    allowedStates: ['closing', 'presentation', 'property_query', 'discovery', 'intent', 'idle', 'contact_collection'],
  },
  {
    intent: 'ESCALATION',
    bankKey: 'escalation.polite',
    fallback: 'Ќе Ве контактира менаџер за дополнителни информации.',
    detect: detectEscalation,
    allowedStates: undefined,
  },
  {
    intent: 'DOCUMENTS_ASK',
    bankKey: 'documents.info',
    fallback: 'За документите ќе добиете информации при посетата на имотот.',
    detect: detectDocumentsAsk,
    allowedStates: ['closing', 'presentation', 'property_query', 'discovery', 'intent', 'idle', 'contact_collection'],
  },
  {
    intent: 'MORTGAGE_ASK',
    bankKey: 'mortgage.info',
    fallback: 'Можам да Ви помогнам со информации за финансирање. Кажете ми кој банкарски производ Ве интересира.',
    detect: detectMortgageAsk,
    allowedStates: ['closing', 'presentation', 'property_query', 'discovery', 'intent', 'idle', 'contact_collection'],
  },
  {
    intent: 'NEIGHBORHOOD_ASK',
    bankKey: 'neighborhood.general',
    fallback: 'Имаме понуди во повеќе населби. Во која област Ве интересира?',
    detect: detectNeighborhoodAsk,
    allowedStates: ['idle', 'intent', 'discovery'],
  },
  {
    intent: 'COMPARISON',
    bankKey: 'comparison.help',
    fallback: 'Можам да ги споредам имотите за Вас. Кои карактеристики Ви се најважни?',
    detect: detectComparison,
    allowedStates: ['presentation', 'property_query'],
  },
  {
    intent: 'FEATURE_ASK',
    bankKey: 'feature.after.show',
    fallback: 'Ќе Ви ги кажам сите детали за имотот. Што конкретно Ве интересира?',
    detect: detectFeatureAsk,
    allowedStates: ['property_query', 'presentation', 'closing'],
  },
  {
    intent: 'SCHEDULING_FLEX',
    bankKey: 'scheduling.flex',
    fallback: 'Разбрано. Кажете ми кога Ви одговара и ќе се обидеме да го прилагодиме терминот.',
    detect: detectSchedulingFlex,
    allowedStates: ['visit_scheduling', 'owner_checking', 'time_confirm'],
  },
];

/**
 * Try the simple deterministic detectors in order.
 * Returns { intent, bankKey, fallback } for the first match, or undefined.
 *
 * NOTE: OFFTOPIC has a special state gate (NOT owner_checking/pending)
 * that differs from the normal "allowedStates includes" check — handled
 * explicitly below.
 */
export function dispatchSimple(
  text: string,
  state: string,
): { intent: string; bankKey: string; fallback: string } | undefined {
  for (const d of SIMPLE_DETECTORS) {
    try {
      if (!d.detect(text)) continue;

      // OFFTOPIC special gate: fires everywhere EXCEPT owner_checking/pending
      if (d.intent === 'OFFTOPIC') {
        if (['owner_checking', 'pending'].includes(state)) continue;
        return d;
      }

      // Standard gate: allowedStates must include current state
      if (d.allowedStates && !d.allowedStates.includes(state)) continue;

      return d;
    } catch { /* detector must never crash the dispatch */ }
  }
  return undefined;
}
