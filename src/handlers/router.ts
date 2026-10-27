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
import { recordRouteDrift } from '../store/routeDrift';
import {
  detectExactAddressAsk, detectWhereIs, detectSurroundingsAsk, detectOwnerContact,
  isKadeTocno, detectPropertyDescription, detectService, detectBothServices,
  detectVisitCancellation, detectOfftopic, detectDefer, detectNegotiate,
  detectProvisionAsk, detectProvisionWho, detectEscalation, detectDocumentsAsk, detectMortgageAsk,
  detectNeighborhoodAsk, detectSchedulingFlex, detectComparison, detectFeatureAsk,
  detectDrugAlternative, detectInvestmentOpinion, detectWorkdaysQuestion,
  detectFeeWhy, isDistanceQuestion, detectMarketPriceAsk, detectMarketMemoryAsk,
  detectBusinessBudgetAsk,
  detectPriceEval,
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
  { intent: 'WORKDAYS_QUESTION', note: 'agency-hours question ("VO NEDELA RABOTITE?") — answered from the bank, never forwarded to the owner as a proposed term; must beat the visit-time capture (the day token inside it used to reach the owner)',
    fires: t => detectWorkdaysQuestion(t) },
  { intent: 'PRICE_EVAL_CHEAP', note: 'a POSITIVE price remark about the flat on the table ("MNOGU EFTINA CENA E TOA") — valence, not money talk. The fee is never called cheap, so this lane must beat the fee ladder; gated to states where a price is on the table and to non-questions, so it cannot steal a price ask or a search',
    fires: (t, s) => detectPriceEval(t) === 'cheap' && !/\?/.test(t)
      && ['property_query', 'presentation', 'closing'].includes(s) },
  { intent: 'BUSINESS_BUDGET_ASK', note: 'a commercial price question in the intake states ("kolku cini deloven prostor?", "koja e cenata za lokal?") gets the BUSINESS budget question from discovery.ask.budget.business — Lina has no number to quote, and the residential lanes would ask about спални/станот. State-gated: once a flat is on the table its price and the fee protocol own the money talk',
    fires: (t, s) => detectBusinessBudgetAsk(t) && ['idle', 'intent', 'discovery'].includes(s) },
  { intent: 'EXACT_ADDRESS', note: 'explicit address demand WITHOUT каде enters the deterministic privacy ladder. Must sit before WHERE_IS only via the !whereIs guard — каде-prefixed questions fall through',
    fires: (t) => detectExactAddressAsk(t) && !isKadeTocno(t) && !detectWhereIs(t) },
  { intent: 'OWNER_CONTACT', note: 'client leaves name/phone — captured before any other reply',
    fires: t => detectOwnerContact(t) },
  { intent: 'WHERE_IS', note: 'any каде-question → landmark rotation. Beats EXACT_ADDRESS by the guard above and beats description routing below',
    fires: t => !!detectWhereIs(t) },
  { intent: 'DISTANCE', note: '"KOLKU IMA OD STANOT DO BUNJAKOVEC TRGOVSKI?" ([22:25]) — how far the discussed property is from a place the client names. Sits after WHERE_IS (каде owns those), and BEFORE every funnel branch: the classifier read „STANOT“ as PROPERTY_ID_REQUESTED and answered a distance question with the property card',
    fires: t => isDistanceQuestion(t) },
  { intent: 'MARKET_MEMORY', note: '„ИМАШЕчЕ ЕДНА КУчА ПРЕД НЕКОЕ ВРЕМЕ КАЈ ВАС… ОКОЛУ 400 ЕВРА КИРИЈА” ([02:00]) — a recall of an OLD agency listing. Sits BEFORE MARKET_PRICE: the rent noun + the ask shape make the market mirror claim the row, while the market arm does not capture it (landmark ≠ feed area, singular noun, rent-only guard) — the turn then fell to the discovery funnel. The archive ack owns it: the old offer is not in the feed, so no figure is quoted as live, and the recollected type/segment/amount land in slots for the follow-up search',
    fires: t => detectMarketMemoryAsk(t) },
  { intent: 'MARKET_PRICE', note: '"KAKO SE DVIZAT CENIVE ZA STANOVI VO AERODROM?" ([16:57]) — the €/m² range for a CATEGORY in an AREA, answered from the feed\'s own rows. Sits after WHERE_IS/DISTANCE (which own their questions) and before every property-price branch, which would otherwise quote the single flat on the table',
    fires: t => detectMarketPriceAsk(t) },
  { intent: 'SURROUNDINGS', note: 'which-side / relative-to-the-named-places ask ("od stranata na trgovskiot ili odkaj pazarceto") — a LOCATION question the classifier settled with the closing fee pitch ([01:29] capture). Sits after WHERE_IS, which owns the каде questions, and before every funnel branch',
    fires: t => !!detectSurroundingsAsk(t) },
  { intent: 'PROPERTY_DESCRIPTION', note: '"гарсоњерата кај амбасадата" — remembered-property flow before FSM discovery swallows it',
    fires: (t) => detectPropertyDescription(t) && !detectService(t) && !detectBothServices(t) && !detectDrugAlternative(t) && !detectInvestmentOpinion(t) },
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
  // R1: the fee WHY lane joined the mirror (from SIMPLE_DISPATCH). It owns the
  // bare WHY claim BEFORE provision.ask reads the same charge-money wording (the
  // [09:0x] V16K11 transcript —nikon ne zema pari za poseta belongs to the fee
  // REASONS, never the rules-of-work script).
  { intent: 'FEE_WHY', note: 'bare why-claim about the charge — must beat provision.ask',
    fires: (t) => detectFeeWhy(t) && !detectProvisionAsk(t) },
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
  // R1: COMPARISON/FEATURE_ASK join the mirror from SIMPLE_DISPATCH (same
  // detectors, same allowedStates). COMPARISON precedes FEATURE_ASK — the
  // SIMPLE_DISPATCH order rule — because a “which one is better” wording can
  // also carry a feature token (a parking/floor word) and must keep its diff lane.
  { intent: 'COMPARISON', note: 'which one is better — same-class diff (from SIMPLE_DISPATCH)',
    fires: (t, s) => detectComparison(t) && ['presentation', 'property_query'].includes(s) },
  { intent: 'FEATURE_ASK', note: 'per-property feature (parking, floor…) (from SIMPLE_DISPATCH)',
    fires: (t, s) => detectFeatureAsk(t) && ['property_query', 'presentation', 'closing'].includes(s) },
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

// SHADOW ROUTER — the mirror predicts, the handler serves, and the two are
// compared per turn. A divergence is a mirror gap (the audited precedence list
// drifted from the real chain) or a lane that served without a predict entry;
// either way it must be visible without serving anything new.
const PENDING_PREDICT = new Map<string, { intent: string; at: number }>();
const DRIFT_WINDOW_MS = 60_000;

export function routeLog(chatId: string, text: string, intent: string, kind: 'actual' | 'predict' = 'actual'): void {
  const entry: RouteEntry = { at: Date.now(), chatId, text: text.slice(0, 80), intent };
  ROUTE_LOG.push(entry);
  if (ROUTE_LOG.length > ROUTE_LOG_MAX) ROUTE_LOG.shift();
  const tag = kind === 'predict' ? '[route?]' : '[route]';
  console.log(`${tag} ${chatId} → ${intent} :: "${entry.text}"`);
  if (kind === 'predict') {
    PENDING_PREDICT.set(chatId, { intent, at: entry.at });
    return;
  }
  const predicted = PENDING_PREDICT.get(chatId);
  PENDING_PREDICT.delete(chatId);
  if (predicted && entry.at - predicted.at <= DRIFT_WINDOW_MS && predicted.intent !== intent) {
    console.log(`[route-drift] ${chatId} predicted=${predicted.intent} actual=${intent} :: "${entry.text}"`);
    // R3: console-only findings died with the process; every drift pair is
    // persisted (day-rotated JSONL, loss-allowed, hourly-deduped) so
    // route:health --emit-corpus can turn production misroutes into permanent
    // corpus rows instead of transcribed-capture folklore.
    recordRouteDrift({ at: entry.at, chatId, text: entry.text, predicted: predicted.intent, actual: intent });
  }
}

export function recentRoutes(n = 50): RouteEntry[] {
  return ROUTE_LOG.slice(-n);
}

// --- lane calibration registry (R1 coverage, docs/routing-audit-2026-10-23.md) ---
// inbound.ts logs a lane tag at every gate (`routeLog(chatId, text, 'TAG')`).
// The registry is the CALIBRATION SURFACE: every lane tag the executor logs
// must have a row here — mirrored (the ROUTING_ORDER intent that mirrors its
// precedence, and the mirror rows above carry its detector) or pending
// (explicitly un-captured; won't stay silent). tests/route-coverage.test.ts
// extracts the tags the executor actually logs and hard-fails any tag that is
// neither mirrored nor pending, so a new lane can never land unlabeled.
export interface LaneEntry {
  /** The ROUTING_ORDER intent that mirrors this lane, or null while pending. */
  intent: string | null;
  note: string;
}
const M = (intent: string, note: string): LaneEntry => ({ intent, note });
const P = (note: string): LaneEntry => ({ intent: null, note: `pending migration: ${note}` });

/** The R1 calibration surface: ONE row per lane tag the executor logs.
 *  Coverage test: tests/route-coverage.test.ts fails on a logged-but-unlisted
 *  tag (a silent lane) or a mirrored intent name that ROUTING_ORDER lacks. */
export const ROUTE_LANES: Record<string, LaneEntry> = {
  // --- already mirrored by a ROUTING_ORDER row ---
  OFFENSIVE: M('OFFENSIVE', 'zero-output policy beats everything (logged for drift)'),
  WORKDAYS_QUESTION: M('WORKDAYS_QUESTION', 'agency hours, never an owner term'),
  BUSINESS_BUDGET_ASK: M('BUSINESS_BUDGET_ASK', 'state-gated money/lane in intake states'),
  EXACT_ADDRESS: M('EXACT_ADDRESS', 'privacy ladder, !kade-guarded above WHERE_IS'),
  OWNER_CONTACT: M('OWNER_CONTACT', 'name/phone capture first'),
  WHERE_IS: M('WHERE_IS', 'каде owns those questions'),
  DISTANCE: M('DISTANCE', 'how far the discussed flat is from X'),
  MARKET_MEMORY: M('MARKET_MEMORY', 'a recollected OLD agency listing (имаше/беше … кај вас + noun + amount) — honest archive ack, beats MARKET_PRICE'),
  MARKET_PRICE: M('MARKET_PRICE', 'category+area fare range, beats PRICE_ASK'),
  SURROUNDINGS: M('SURROUNDINGS', 'which-side / relative-to-named-place'),
  PROPERTY_DESCRIPTION: M('PROPERTY_DESCRIPTION', 'remembered-property flow'),
  DESCRIBE_TABLE: P('“опиши ми ги?” — the flats she just offered, answered from the bank rows'),
  PICK_DESCRIBED: P('a pick among the flats she just described → the availability answer'),
  LOCATE_CONTINUE: P('bare «не» while choosing among described flats — the hunt continues'),
  LOCATE_WIDEN: P('«да» to the other-neighbourhoods question — the area lock is released'),
  LOCATE_REJECT_PLACE: P('«не е таа» after the only flat at a NAMED place — the place lock holds, other areas only after the ask'),
  CONTACT_AFTER_FEE: P('the fee question answered with a name + phone — consent and the visit-time ask'),
  'NEGOTIATE:fast': M('NEGOTIATE', 'commercial-state price pushback'),
  PRICE_EVAL_CHEAP: M('PRICE_EVAL_CHEAP', 'positive price remark beats the fee ladder'),
  'PROVISION_PUSH:fast': M('PROVISION_ASK', 'fee pushback resolves through the provision lane'),
  PROVISION_WHO: P('who pays the provision split'),
  'FEE_WHY:fast': M('FEE_WHY', 'the bare WHY claim (must beat provision.ask)'),
  SCHEDULING_FLEX: M('SCHEDULING_FLEX', 'time-window preference in visit states'),
  // --- mirrored by dispatchSimple (SIMPLE_DETECTORS), rows added in R1 ---
  COMPARISON: M('COMPARISON', 'client wants a same-class diff'),
  FEATURE_ASK: M('FEATURE_ASK', 'per-property feature (parking, floor…)'),
  FEE_WHY: M('FEE_WHY', 'the bare WHY claim (before provision.ask)'),
  OFFTOPIC: M('OFFTOPIC', 'small-talk redirect (not while owner handshake pending)'),
  PROVISION_ASK: M('PROVISION_ASK', 'plain tag from the dispatchSimple sites'),
  NEGOTIATE: M('NEGOTIATE', 'plain tag from the dispatchSimple sites'),
  DEFER: M('DEFER', '“ќе размислам” in the late-funnel states'),
  ESCALATION: M('ESCALATION', 'manager request, always honored'),
  DOCUMENTS_ASK: M('DOCUMENTS_ASK', 'documents info'),
  MORTGAGE_ASK: M('MORTGAGE_ASK', 'financing info'),
  NEIGHBORHOOD_ASK: M('NEIGHBORHOOD_ASK', 'area advice in early states'),
  // --- pending migration (explicit, not silent) ---
  ADDRESS_WHY: P('privacy ladder — why the exact address stays private'),
  FEE_RULES: P('agency fee rules ask (the rules-of-work script)'),
  'FEE_COMPLAINT': P('fee resistance served inside the ladder'),
  'AGENT_ATTENDANCE_ASK': P('does the agent attend the viewing — bank lane'),
  BYE: P('goodbye / close chat'),
  'ENTHUSIASM:fast': P('positive eye-catch reaction'),
  'EXIT_CHECK': P('“да завршиме?” check-in'),
  'EXIT_CHECK_REPEAT': P('exit check repeated'),
  'FEE_AMOUNT_ASK:fast': P('exact fee amount asked'),
  'FEE_COMPLAINT:fast': P('fee resistance in the ladder'),
  'FEEDDOWN:fast': P('feed-down transparency lane'),
  'FEE_FIRST_TIME:fast': P('first-time fee question'),
  'FEE_PUSH:fast': P('fee charge pushback'),
  'FEE_SURPRISE:fast': P('fee surprise reaction'),
  'GHOST:fast': P('unknown EB one-off serve'),
  GLOSSARY: P('glossary term ask'),
  INFO_ASK: P('property info multi-facet ask'),
  INFO_ASK_YEAR: P('year of construction ask'),
  'INVESTMENT_OPINION:fast': P('investment-advice ask'),
  LANDMARK_LADDER: P('location-nag ladder rung'),
  LOCATION_NAG: P('location question refused again'),
  MONEY_CLARIFY: P('money-without-target clarification'),
  NEARBY_ASK: P('what is near the building'),
  NEARBY_THREAD: P('what-else-is-near (rotation → protocol → lifecycle)'),
  'OWNER_HOLD:fast': P('owner unreachable continuation'),
  POI_CONFIRM: P('POI confirm question (landmark near?)'),
  'PRICE_ASK:fast': P('direct price ask on the shown flat'),
  PRICE_AVG_NASELBA: P('average price in the named naselba'),
  'PRICE_EVAL_EXPENSIVE': P('negative price remark about the flat on the table'),
  'PRICE_EVAL_EXPENSIVE_UNWIRED': P('expensive verdict while no lane is wired'),
  'PRICE_EXTREME': P('extreme price search (“do 1000 evra kuca”)'),
  'PRICE_EXTREME_MORE': P('extreme-price continuation'),
  'PRICE_FRESHNESS:fast': P('is this price fresh? ask'),
  PROXY_CONTACT: P('contact via proxy (third person)'),
  RECOMMEND_ASK: P('“koj bi mi go preporacale?”'),
  'REMARK:bank': P('bank-backed generic remark'),
  'REMARK:fast': P('generic remark (deterministic)'),
  'RENT_MATH:fast': P('total cost math (kirija × term)'),
  SOFT_REFUSAL: P('soft refusal (“nedokazani parevsy…”)'),
  WAITING: P('agent is reaching out, waiting ack'),
  WHERE_LANDMARK: P('каде + named landmark place'),
  'WHICH_PROPERTY:fast': P('which EB are you talking about'),
  'VISIT_CANCEL:WHICH': P('a cancel that names no arranged visit — asks which Евидентен број instead of guessing'),
};

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
    fallback: 'Одете на темата, ве молам — како можам да Ви помогнам со недвижностите?',
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
    // ORDER (the [09:0x] V16K11 transcript): "nikoj ne zema pari za poseta" is
    // BOTH fee-why (charge-claim family) AND provision-shaped
    // (CHARGE_MONEY_RE) — the WHY lane must own it or the client gets the
    // rules-of-work script instead of the fee's REASONS. detectFeeWhy first;
    // mirrored in inbound.ts (dispatchSimple is pre-classifier there).
    intent: 'FEE_WHY',
    bankKey: 'fee.why',
    fallback: 'Надоместот за посета е филтер на агенцијата со кој ги препознаваме вистинските клиенти. Дали се согласувате со овој услов?',
    detect: t => detectFeeWhy(t) && !detectProvisionAsk(t),
    allowedStates: ['closing', 'presentation', 'property_query', 'discovery', 'intent', 'idle'],
  },
  {
    intent: 'PROVISION_ASK',
    bankKey: 'provision.ask',
    fallback: 'Условите зависат дали барате купување или изнајмување. Купувачот не плаќа провизија (0%), единствен трошок е 500 денари за посета; за изнајмување надоместот е 300 денари, а провизијата 50% од киријата. Дали Ве интересира купување или изнајмување?',
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
    fallback: 'За документите ќе добиете информации при посетата на недвижноста.',
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
    fallback: 'Можам да ги споредам недвижностите за Вас. Кои карактеристики Ви се најважни?',
    detect: detectComparison,
    allowedStates: ['presentation', 'property_query'],
  },
  {
    intent: 'FEATURE_ASK',
    bankKey: 'feature.after.show',
    fallback: 'Ќе Ви ги кажам сите детали за недвижноста. Што конкретно Ве интересира?',
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
  {
    intent: 'WORKDAYS_QUESTION',
    bankKey: 'workdays.question',
    fallback: 'Агенцијата работи од понеделник до петок, од 09:00 до 17:00 часот. Посетите се организираат во работните денови; сабота и недела не работиме.',
    detect: detectWorkdaysQuestion,
    allowedStates: undefined, // every state — an hours question is always an hours question
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
