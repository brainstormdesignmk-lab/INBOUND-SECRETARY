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
import { detectWhichOfBatchPlace } from '../data/properties';
import { recordRouteDrift } from '../store/routeDrift';
import {
  detectExactAddressAsk, detectWhereIs, detectSurroundingsAsk, detectOwnerContact,
  isKadeTocno, detectPropertyDescription, detectService, detectBothServices,
  detectVisitCancellation, detectOfftopic, detectDefer, detectNegotiate,
  detectProvisionAsk, detectProvisionWho, detectEscalation, detectDocumentsAsk, detectMortgageAsk,
  detectNeighborhoodAsk, detectSchedulingFlex, detectComparison, detectFeatureAsk,
  detectDrugAlternative, detectInvestmentOpinion, detectWorkdaysQuestion,
  detectFeeWhy, isDistanceQuestion, detectNearestOfShown, detectCloseRemarkToBatch,
  detectMarketPriceAsk, detectMarketMemoryAsk,
  detectBusinessBudgetAsk,
  detectPriceEval, adviceLaneAdmits,
  detectNearbyAsk, detectSeenListingRecall, detectInventoryAsk,
  detectFeePaymentAgreement, detectArrangementRecall, detectToldYouNag,
  detectNumberUnknownRecall, detectSimilarAsk, detectBusiness, EB_NAMED_RE,
  isFeeTraffic, detectNearCenter, extractPoiWishCandidates,
} from '../llm/deterministic';
import type { ChatSession } from '../fsm/session';

/** The session memory a rule may consult. Slots are the ONLY state a lane reads
 *  beyond the FSM state, so the mirror sees them too (see RouteRule.fires). */
export type RouteSlots = ChatSession['slots'];
const NO_SLOTS = {} as RouteSlots;

/** The two lanes below are the ones whose executor gates read the CLIENT'S
 *  MEMORY (does this chat hold a business space? a category? a place?), and a
 *  mirror that cannot see that memory predicts the wrong lane for a turn whose
 *  text is identical in every other respect. The lists are the executor's own;
 *  keep them in one place so a new state lands in both. */
const RECALL_STATES_OFF = ['pending', 'queued', 'owner_checking', 'time_confirm',
  'visit_scheduling', 'contact_collection', 'property_locate'];

/** Does the chat hold a CATEGORY it can search by? (The executor's catKnown.) */
function hasCategory(slots: RouteSlots): boolean {
  return slots.house === true || slots.plac === true || slots.business === true
    || slots.bedrooms !== undefined || slots.garsonjera === true;
}

export interface RouteRule {
  intent: string;
  /** Human-readable precedence note — WHY it sits at this position. */
  note: string;
  /** Guard mirroring the inbound.ts condition for this branch. `slots` is the
   *  live session memory (empty when a caller only has text + state); a rule
   *  that ignores it deliberately stays pure-text. */
  fires: (text: string, state: string, slots: RouteSlots) => boolean;
}

// ORDER IS SEMANTIC — do not reorder without reading the notes.
export const ROUTING_ORDER: RouteRule[] = [
  { intent: 'OFFENSIVE', note: 'zero-output policy wins over everything',
    fires: t => classifyOffensive(t).isOffensive },
  { intent: 'WORKDAYS_QUESTION', note: 'agency-hours question ("VO NEDELA RABOTITE?") — answered from the bank, never forwarded to the owner as a proposed term; must beat the visit-time capture (the day token inside it used to reach the owner)',
    fires: t => detectWorkdaysQuestion(t) },
  // The [20:51]–[21:05] batch added two executors the mirror did not know, and
  // the shadow router said so out loud: the Аеродром ask was predicted
  // SURROUNDINGS while the executor served BUSINESS_PLACE_SERVE — a drift pair
  // that blames the lane which was right (the same defect R3 fixed for
  // NEARBY_ASK/SEEN_LISTING_RECALL). Their position is the executor's own: the
  // serves sit at inbound.ts ~5.5k, ABOVE the cheap-price lane (~6.1k) and the
  // surroundings block — so the value remark inside a number-forget («… ЗНАМ
  // ДЕКА ИМАШЕ ДОБРА ЦЕНА») is predicted SEEN_RECALL_HELP here, exactly as it
  // is served, instead of PRICE_EVAL_CHEAP.
  { intent: 'SEEN_RECALL_HELP', note: '«НЕ И ГО ПАМТАМ БРОЈОТ, АМА ЗНАМ ДЕКА ИМАШЕ ДОБРА ЦЕНА» ([20:51]) — the client cannot name the listing he saw, so the turn FINDS it from what the chat already holds (the category and the place he named) and closes on the seen-property question, never a visit offer. SLOT-AWARE: the executor also needs a category slot AND a place anchor (poiAnchor or the area), so the mirror reads the same memory — with nothing to go on the lane stands down and property_locate keeps the turn, exactly as it serves',
    fires: (t, s, sl) => detectNumberUnknownRecall(t) && !EB_NAMED_RE.test(t)
      && !isFeeTraffic(t) && !sl.ownerContactPending
      && !RECALL_STATES_OFF.includes(s)
      && hasCategory(sl) && !!(sl.poiAnchor || sl.location) },
  { intent: 'BUSINESS_PLACE_SERVE', note: 'business traffic near the places the client names ([20:59] pair, [21:05] «НАКАЈ АЕРОДРОМ ИМАШ НЕШТО СЛИЧНО ?») — the €/м² pair by distance, or an honest «нема» there plus rated alternatives. Two text shapes: a similarity ask («нешто слично/налик»), which is a SEARCH pivot the surroundings lane used to answer with a CENTRE landmark, and a business noun with a proximity place. SLOT-AWARE: the executor owns this lane only when the session ALREADY holds a business space (or says so in this turn), so the mirror reads the same slots — a residential similarity ask is no longer predicted here',
    fires: (t, s, sl) => !EB_NAMED_RE.test(t) && !isFeeTraffic(t) && !sl.ownerContactPending
      && !['pending', 'queued', 'owner_checking', 'time_confirm', 'visit_scheduling',
        'contact_collection'].includes(s)
      && (sl.business === true || detectBusiness(t))
      && (extractPoiWishCandidates(t, { withCriteria: true }).length > 0
        || (detectSimilarAsk(t) && !!sl.poiAnchor)) },
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
  { intent: 'NEAREST_OF_SHOWN', note: '«KOJ E NAJBLISKU DO KAFICOT?» ([22:03]) — which of the flats ALREADY OFFERED is nearest to the place the client names. Sits after WHERE_IS/DISTANCE (which own their questions) and before the funnel branches: the location-nag lane answered it with the last flat\'s nearby landmark, because «најблиску» contains «блиску»',
    fires: t => detectNearestOfShown(t) },
  { intent: 'NEAREST_OF_BATCH', note: '«OVA BESE BLISKU» ([20:17]) — a DEICTIC closeness remark about the batch just listed. No interrogative and no place of its own, so it sits AFTER NEAREST_OF_SHOWN (which owns the explicit «koj e najblisku do …» ranking) and BEFORE the funnel: the classifier read it as a description of an unknown listing and asked which neighbourhood/price it was',
    fires: t => detectCloseRemarkToBatch(t) },
  { intent: 'TOLD_YOU_RECALL', note: '«ПА ТИ КАЖАВ КАДЕ» ([23:48]) — the client says he already gave the criteria, so the turn reads the notebook back (places + area) and asks only what is missing. The executor runs it in the funnel states, after OWNER_CONTACT/PROXY_CONTACT (a contact capture inside the complaint keeps its lane) and before the where-is/location-nag branches, which is exactly where this row sits; the executor also requires NO property on the table (a shown flat makes «ти кажав» a where-is/visit topic) — a fact the mirror cannot see, so the state gate is the mirror\'s share',
    // …BUT A BOOKING RECALL IS NOT THE NOTEBOOK: «ЗА КОЈ СТАН ТИ КАЖАВ ДА
    // ДОГОВОРИШ ПРЕЕСКА?» carries «ти кажав» and reads as the told-you nag, while
    // the executor serves VISIT_RECALL (6516) long before the funnel lane (7518).
    // The mirror has to refuse it here, or it predicts a lane that never runs.
    fires: (t, s) => detectToldYouNag(t) && !detectArrangementRecall(t)
      && ['idle', 'discovery'].includes(s) },
  { intent: 'WHICH_OF_BATCH_PLACE', note: '«KOJ OD NIV E VO MADJAR MAALO?» ([09:44]) — which of the flats ALREADY OFFERED stands in the place the client names. A comparison between the rows on the table, so it sits after NEAREST_OF_SHOWN/NEAREST_OF_BATCH (the rankings it must not steal) and before MARKET_MEMORY and every search branch: the recall path read the place as a NEW search and re-served the same pair it was asked about',
    fires: t => !!detectWhichOfBatchPlace(t) },
  { intent: 'MARKET_MEMORY', note: '„ИМАШЕчЕ ЕДНА КУчА ПРЕД НЕКОЕ ВРЕМЕ КАЈ ВАС… ОКОЛУ 400 ЕВРА КИРИЈА” ([02:00]) — a recall of an OLD agency listing. Sits BEFORE MARKET_PRICE: the rent noun + the ask shape make the market mirror claim the row, while the market arm does not capture it (landmark ≠ feed area, singular noun, rent-only guard) — the turn then fell to the discovery funnel. The archive ack owns it: the old offer is not in the feed, so no figure is quoted as live, and the recollected type/segment/amount land in slots for the follow-up search',
    fires: t => detectMarketMemoryAsk(t) },
  { intent: 'MARKET_PRICE', note: '"KAKO SE DVIZAT CENIVE ZA STANOVI VO AERODROM?" ([16:57]) — the €/m² range for a CATEGORY in an AREA, answered from the feed\'s own rows. Sits after WHERE_IS/DISTANCE (which own their questions) and before every property-price branch, which would otherwise quote the single flat on the table',
    fires: t => detectMarketPriceAsk(t) },
  // R3 — the two rows the mirror was MISSING, found by replaying the production
  // route-drift corpus through resolveIntent: the executor already served both
  // (`inbound.ts` NEARBY_ASK interceptor, SEEN_LISTING_RECALL block), while the
  // mirror predicted advice lanes instead — «STO IMA VO BLIZINA NA
  // GARSONJERATA KAJ CRNOGORSKA AMBASADA?» was predicted PROPERTY_DESCRIPTION
  // (production: NEARBY_ASK) and «IMAVTE EDNA KUKJA NAKAJ AERODROM …» was
  // predicted SURROUNDINGS (production: SEEN_LISTING_RECALL). A missing row is
  // not cosmetic: the drift log then blames the lane that was right.
  { intent: 'NEARBY_ASK', note: 'what else is around the discussed/named building («sto ima vo blizina na …?») — the executor intercepts it before every funnel branch, so it must beat PROPERTY_DESCRIPTION here too',
    fires: t => detectNearbyAsk(t) },
  { intent: 'SEEN_LISTING_RECALL', note: 'a RECALLED listing («imavte edna kukja nakaj … okolu 130 000 bese») — past-tense had + determiner + property noun; the archive ack owns it, never the criteria funnel or a surroundings read',
    fires: t => detectSeenListingRecall(t) },
  { intent: 'SURROUNDINGS', note: 'which-side / relative-to-the-named-places ask ("od stranata na trgovskiot ili odkaj pazarceto") — a LOCATION question the classifier settled with the closing fee pitch ([01:29] capture). Sits after WHERE_IS, which owns the каде questions, and before every funnel branch. THE EXECUTOR\'S OWN VETO: a near-centre refinement («poblisku do centar ili do aerodrom?») and a SIMILARITY ask («имаш нешто слично?») are searches, not side questions, so the block refuses both — the mirror must refuse them too, or it predicts this lane for a turn the executor never runs here (the [21:05] residential similarity ask was predicted SURROUNDINGS while the pool decided the turn)',
    fires: t => !detectNearCenter(t) && !detectSimilarAsk(t) && !!detectSurroundingsAsk(t) },
  { intent: 'PROPERTY_DESCRIPTION', note: '"гарсоњерата кај амбасадата" — remembered-property flow before FSM discovery swallows it',
    // …but never for a STOCK-AT-A-PLACE ask («DALI IMATE NESTO INTERESNO KAJ
    // ZEBRA ?»): that is a present-tense show-me ask, the see-offers sell owns
    // it, and reading it as a remember-which-flat turn is the [01:45] defect
    // (two clients, one question, two answers). Same exclusion as the executor.
    fires: (t) => detectPropertyDescription(t) && !detectInventoryAsk(t)
      && !detectService(t) && !detectBothServices(t) && !detectDrugAlternative(t) && !detectInvestmentOpinion(t) },
  { intent: 'VISIT_CANCEL', note: 'cancellation only meaningful in visit states',
    fires: (t, s) => detectVisitCancellation(t) &&
      ['visit_scheduling', 'owner_checking', 'time_confirm'].includes(s) },
  { intent: 'VISIT_RECALL', note: '«ZA KOJ STAN TI KAZAV DA DOGOVORIS PREESKA ?» ([01:2x]) — which flat the ARRANGEMENT was for. A flat noun plus an arranging verb made the classifier read it as a visit ORDER and the fee-agreement lane opened contact collection; the lane answers from the appointment itself. No state gate: the client may ask in closing, in contact collection or next day',
    fires: t => detectArrangementRecall(t) },
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
  // A YES IS NEVER A WHY (the [19:34] capture): «STOM TAKA RABOTITE DOGOVORI
  // TOA E TOA» agrees to the fee and must be predicted as consent traffic, not
  // as an explanation request — the executor's why legs stand down on
  // detectFeePaymentAgreement, and the mirror has to say the same.
  { intent: 'FEE_WHY', note: 'bare why-claim about the charge — never fee consent (must beat provision.ask)',
    fires: (t) => detectFeeWhy(t) && !detectProvisionAsk(t) && !detectFeePaymentAgreement(t) },
  { intent: 'PROVISION_ASK', note: 'fee question — EVERY client-side state (the [09:51] capture: «KOLKU VI E PROVIZIJATA ?» in property_locate was skipped by the old gate and the card pair was re-served). The mirror must carry the executor\'s own list: a narrower gate here predicts FALLTHROUGH for a turn the lane really serves',
    fires: (t, s) => detectProvisionAsk(t) &&
      ['closing', 'presentation', 'property_query', 'discovery', 'intent', 'idle',
        'contact_collection', 'property_locate', 'visit_scheduling', 'owner_checking',
        'time_confirm', 'pending'].includes(s) },
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
  // THE POOL-DECIDED LANE, AND WHY IT IS PREDICTED TWICE. Nothing in the text or
  // the state says «there is no stock inside the 1 km ring» — the FEED decides
  // that when the turn loads its pool, and the ring ask is served in the SAME
  // turn. So the mirror predicts at entry as usual, and inbound.ts refines the
  // prediction once the pool has spoken (`refinePrediction`, right after
  // loadProps): by then slots.poiTooFarAsk carries the fact, and this row — last
  // in the order, because only a turn that reached the pool can match it —
  // predicts the lane the executor is about to log. Without it every residential
  // similarity ask logged a false drift pair against SURROUNDINGS.
  { intent: 'PLACE_RING_ASK', note: '«НАКАЈ АЕРОДРОМ ИМАШ НЕШТО СЛИЧНО?» with nothing inside 1 km ([21:05]) — the place, the MEASURED distance and the ONE binary widen question, no cards. Predicted on the refinement pass from slots.poiTooFarAsk (the pool\'s own verdict), never from the text: the same sentence with stock in the ring is a different turn',
    fires: (t, s, sl) => sl.poiTooFarAsk === true
      && ['presentation', 'closing'].includes(s)
      && !detectNumberUnknownRecall(t) },
];

/** Which intent WOULD fire for this text in this state (and, when the caller
 *  has it, with this session memory) — first match in ROUTING_ORDER, or
 *  FALLTHROUGH (LLM/classifier territory). Pass the live `session.slots`
 *  wherever they exist: the lanes gated on the client's memory can only be
 *  predicted when the mirror can see what that memory holds. */
export function resolveIntent(text: string, state: string, slots: RouteSlots = NO_SLOTS): string {
  for (const r of ROUTING_ORDER) {
    try { if (r.fires(text, state, slots)) return r.intent; } catch { /* never let the mirror crash callers */ }
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
  if (!predicted || entry.at - predicted.at > DRIFT_WINDOW_MS) return;
  // ── THE TAXONOMY OF A DIVERGENCE ─────────────────────────────────────────
  // Only a turn BOTH sides claim for a MIRRORED lane is a drift (a wrong
  // prediction). Two other shapes were being reported as drift, and each one
  // trained the operator to ignore the line:
  //
  //  • THE CLASSIFIER'S OWN ROUTE (`ROUTE_UNKNOWN:…`) served after the mirror
  //    said FALLTHROUGH — that is not a divergence, that IS the contract:
  //    FALLTHROUGH means "the classifier decides this turn".
  //  • A LANE WITH NO MIRROR ROW YET (pending migration) — the mirror cannot be
  //    wrong about a lane it has no row for, so this is a GAP: the backlog entry
  //    that says which lane still needs a mirror row. Same persistence, new
  //    label, so `route:health --emit-corpus` can keep mining the drifts.
  //
  // The tag is normalised through the registry first: the executor logs both
  // `FEE_WHY` and `FEE_WHY:fast`, and a mirrored row names the intent they
  // share.
  const actualMirror = ROUTE_LANES[intent]?.intent ?? null;
  if (intent.startsWith('ROUTE_UNKNOWN') && predicted.intent === 'FALLTHROUGH') return;
  if (actualMirror !== null && predicted.intent === actualMirror) return;
  if (actualMirror === null) {
    console.log(`[route-gap] ${chatId} predicted=${predicted.intent} actual=${intent} :: "${entry.text}"`);
    recordRouteDrift({ at: entry.at, chatId, text: entry.text, predicted: predicted.intent, actual: intent, kind: 'gap' });
    return;
  }
  console.log(`[route-drift] ${chatId} predicted=${predicted.intent} actual=${intent} :: "${entry.text}"`);
  // R3: console-only findings died with the process; every drift pair is
  // persisted (day-rotated JSONL, loss-allowed, hourly-deduped) so
  // route:health --emit-corpus can turn production misroutes into permanent
  // corpus rows instead of transcribed-capture folklore.
  recordRouteDrift({ at: entry.at, chatId, text: entry.text, predicted: predicted.intent, actual: intent, kind: 'drift' });
}

export function recentRoutes(n = 50): RouteEntry[] {
  return ROUTE_LOG.slice(-n);
}

/** RE-PREDICT ONCE THE POOL HAS SPOKEN. A handful of lanes are decided by DATA
 *  the text and the session cannot reveal before the turn loads its pool (the
 *  1 km ring ask is the model: the feed decides that nothing is close). The
 *  executor calls this right after loadProps — the prediction is still made by
 *  ROUTING_ORDER over text + state + slots, it is simply made with the slots
 *  the load has filled in. It replaces (never appends to) the entry prediction
 *  for this chat, because the later pass is strictly better informed. */
export function refinePrediction(chatId: string, text: string, state: string, slots: RouteSlots): string {
  const intent = resolveIntent(text, state, slots);
  const pending = PENDING_PREDICT.get(chatId);
  PENDING_PREDICT.set(chatId, { intent, at: pending?.at ?? Date.now() });
  return intent;
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
  DISTANCE_BATCH: P('the same ask with SEVERAL flats on the table — one measured line per flat, nearest first (the [11:28] capture: two cards were served and only one flat’s number came back)'),
  INFO_ASK_FLOORS: P('one floor question naming TWO flats («na koj sprat e 94 ? a na koj 90 ?») — one clause per Евидентен број (the [11:38] capture: only the bound flat was answered)'),
  INFO_ASK_PAIR_IDENTITY: P('SEVERAL flats named in one ask («za stan so evidenten broj 82 i 75») — every named Евидентен број gets its own card, never only the first (the [10:58] capture: 82 described and 75 dropped)'),
  INFO_ASK_PAIR: P('a facet ask over the TWO flats on the table («sporedba na cena po kvadrat za dvata stana», «na koj sprat e 94 ? a na koj 90 ?») — one answer per flat; the pair-on-table referent («dvata») makes the batch without re-naming the EBs'),
  WHICH_OF_BATCH_PLACE: M('WHICH_OF_BATCH_PLACE', 'which of the offered flats stands in the place the client names — answered per row, from each row\'s own words'),
  NEAREST_OF_SHOWN: M('NEAREST_OF_SHOWN', 'which of the offered flats is nearest to X'),
  NEAREST_OF_BATCH: M('NEAREST_OF_BATCH', '«ova bese blisku» — the one nearest of the batch, with its measured distance'),
  MARKET_MEMORY: M('MARKET_MEMORY', 'a recollected OLD agency listing (имаше/беше … кај вас + noun + amount) — honest archive ack, beats MARKET_PRICE'),
  MARKET_PRICE: M('MARKET_PRICE', 'category+area fare range, beats PRICE_ASK'),
  SURROUNDINGS: M('SURROUNDINGS', 'which-side / relative-to-named-place'),
  PROPERTY_DESCRIPTION: M('PROPERTY_DESCRIPTION', 'remembered-property flow'),
  SEEN_LISTING_RECALL: M('SEEN_LISTING_RECALL', 'a recalled listing («имавте една куќа накај Скопје Север, околу 130 000 беше») served from the bank by category+area+price in helpful mode — never the criteria ask ([18:41] capture)'),
  DESCRIBE_TABLE: P('“опиши ми ги?” — the flats she just offered, answered from the bank rows'),
  AVAILABILITY_TABLE: P('an availability ask that points at ONE flat already on the table by its type/price («GARSONJERATA ZA 200E DALI E DOSTAPNA?») — the ack + the owner question for THAT flat, never a fresh criteria grill ([22:27] capture)'),
  CONTACT_MECHANICS: P('the competence challenge «KAKO KE GO KONTAKTIRAS AKO NE ZNAES KOJ BROJ E?» — the number she holds + the mechanism, never the DEFER line ([22:28] capture)'),
  STOCK_CONTRADICTION: P('the client quotes a card she served against a «нема» she said («PA KAKO NEMA … KOGA OVOJ E EDEN OD NIV?») — admission + the row\'s own facts + the next step, never a location line ([02:12] capture)'),
  PICK_DESCRIBED: P('a pick among the flats she just described → the availability answer'),
  LOCATE_CONTINUE: P('bare «не» while choosing among described flats — the hunt continues'),
  LOCATE_WIDEN: P('«да» to the other-neighbourhoods question — the area lock is released'),
  LOCATE_REJECT_PLACE: P('«не е таа» after the only flat at a NAMED place — the place lock holds, other areas only after the ask'),
  CONTACT_AFTER_FEE: P('the fee question answered with a name + phone — consent and the visit-time ask'),
  AGENCY_IDENTITY: P('«КОЈА АГЕНЦИЈА СТЕ ВИЕ?» mid ping-pong (client OR owner): the agency is named and the interrupted question repeated — never the pending-traffic line ([19:36] capture)'),
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
  TOLD_YOU_RECALL: M('TOLD_YOU_RECALL', '«па ти кажав каде» — the notebook read back (places/area on file, then only the missing criterion)'),
  MONEY_CLARIFY: P('money-without-target clarification'),
  NEARBY_ASK: M('NEARBY_ASK', 'what is near the building — the interceptor runs before every funnel branch'),
  NEARBY_THREAD: P('what-else-is-near (rotation → protocol → lifecycle)'),
  'OWNER_HOLD:fast': P('owner unreachable continuation'),
  POI_CONFIRM: P('POI confirm question (landmark near?)'),
  PLACE_PIVOT: P('same search at a different named place (“a neshto kaj X?”)'),
  PLACE_RING_ASK: M('PLACE_RING_ASK', 'the 1 km place ring: nothing inside the ring — the place, the measured distance and the one binary widen question (predicted on the refinement pass, from the pool\'s own poiTooFarAsk verdict)'),
  PLACE_RING_ROW: P('the identity of the flat the place ring measured (“koj e toj stan na 1,4 km?”)'),
  'PRICE_ASK:fast': P('direct price ask on the shown flat'),
  PRICE_AVG_NASELBA: P('average price in the named naselba'),
  'PRICE_EVAL_EXPENSIVE': P('negative price remark about the flat on the table'),
  'PRICE_EVAL_EXPENSIVE_UNWIRED': P('expensive verdict while no lane is wired'),
  'PRICE_EXTREME': P('extreme price search (“do 1000 evra kuca”)'),
  'PRICE_EXTREME_MORE': P('extreme-price continuation'),
  'PRICE_FRESHNESS:fast': P('is this price fresh? ask'),
  PROXY_CONTACT: P('contact via proxy (third person)'),
  RECOMMEND_ASK: P('“koj bi mi go preporacale?”'),
  RENT_TERMS: P('the conditions of renting (commission tiers, first rent + deposit, one-year minimum) — provision.ask.rent, never the viewing fee'),
  FEE_AGREED_FIRST: P('the first «да» after the fee disclosure — agreement opens contact collection'),
  'REMARK:bank': P('bank-backed generic remark'),
  'REMARK:fast': P('generic remark (deterministic)'),
  'RENT_MATH:fast': P('total cost math (kirija × term)'),
  SOFT_REFUSAL: P('soft refusal (“nedokazani parevsy…”)'),
  WAITING: P('agent is reaching out, waiting ack'),
  AREA_OF_PLACE: P('„во која населба е X“ — the place\'s own map quarter'),
  AREA_HAVE_SEARCH: P('„а во која населба има?“ — the area-availability ask: the criteria are released and the pair is served, with the neighbourhoods that hold it named ([19:46] capture)'),
  WHERE_LANDMARK: P('каде + named landmark place'),
  'WHICH_PROPERTY:fast': P('which EB are you talking about'),
  'VISIT_CANCEL:WHICH': P('a cancel that names no arranged visit — asks which Евидентен број instead of guessing'),
  VISIT_RECALL: M('VISIT_RECALL', 'which flat the arrangement was for — answered from the appointment, never contact collection'),
  SEEN_RECALL_HELP: M('SEEN_RECALL_HELP', 'the listing he saw but cannot name — found from the held category + place, closed with the seen-property question'),
  BUSINESS_PLACE_SERVE: M('BUSINESS_PLACE_SERVE', 'business spaces at the named places by rate+distance (or an honest «нема» plus alternatives)'),
};

// --- simple deterministic dispatch table -------------------------------------
//
// The 15 terminal detector branches in inbound.ts (OFFTOPIC, DEFER, NEGOTIATE,
// etc.) all share one shape:
//   detectX(text) && stateGate(state) → bankKey || fallback
//
// This table encodes them as DATA so a new detector is one array entry —
// no if/else editing, no ordering accident. "One array entry" is complete: the
// advice-lane gate (see dispatchSimple) is inherited by every entry, so a new
// lane needs no search-turn veto of its own.
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
    // PROPERTY_LOCATE TOO (the [05:17] capture): «КОЛКУ ВИ Е ПРОВИЗИЈАТА?» then
    // «АДВОКАТ НОТАР ?» arrived while the client was reading the property card —
    // a money question does not wait for the closer, and the state gate is what
    // dropped it into the info lane («Се наоѓа во приземје»).
    allowedStates: ['closing', 'presentation', 'property_query', 'property_locate', 'discovery', 'intent', 'idle', 'contact_collection'],
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
    detect: t => detectFeeWhy(t) && !detectProvisionAsk(t) && !detectFeePaymentAgreement(t),
    allowedStates: ['closing', 'presentation', 'property_query', 'discovery', 'intent', 'idle'],
  },
  {
    intent: 'PROVISION_ASK',
    bankKey: 'provision.ask',
    fallback: 'Условите зависат дали барате купување или изнајмување. Купувачот не плаќа провизија (0%), единствен трошок е 500 денари за посета; за изнајмување надоместот е 300 денари, а провизијата 50% од киријата. Дали Ве интересира купување или изнајмување?',
    detect: detectProvisionAsk,
    // THE COMMISSION IS NOT A FUNNEL POSITION (the [09:51] capture): the client
    // was in property_locate (holding the pair EB 91/74) and asked «KOLKU VI E
    // PROVIZIJATA ?» — the state gate skipped this lane, the pair was re-served
    // and the money question went unanswered. A commission question is
    // informational and legitimate in EVERY client-side state, the visit ones
    // included (that is exactly when the money starts to matter).
    allowedStates: ['closing', 'presentation', 'property_query', 'discovery', 'intent', 'idle',
      'contact_collection', 'property_locate', 'visit_scheduling', 'owner_checking', 'time_confirm', 'pending'],
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
 * THE ADVICE-LANE GATE IS APPLIED HERE, not only inside the detectors that
 * happen to have one: `adviceLaneAdmits` is the single policy table
 * (ADVICE_GATES in llm/deterministic), and it DENIES BY DEFAULT. A lane added
 * to this array tomorrow therefore cannot answer a search turn even if its own
 * detector knows nothing about searches — the row, or an explicit `exempt`
 * decision, is what lets it serve. tests/advice-lanes-search-answers.test.ts
 * proves the inheritance with a fake lane and pins a row for every real one.
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

      // THE SHARED GATE — before the lane can serve anything.
      if (!adviceLaneAdmits(d.intent, text)) continue;

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
