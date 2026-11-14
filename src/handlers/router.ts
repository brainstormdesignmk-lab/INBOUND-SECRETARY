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
import { currentTurnAudit } from './turn';
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
  isFeeTraffic, detectNearCenter, extractPoiWishCandidates, looksLikeScreenEcho,
  detectOwnClaimChallenge, detectSubjectPerM2Ask, detectAvailabilityAsk,
  detectFeeNag, detectFeeComplaint, detectFeeSurprise, detectAreaHaveAsk, extractSlots,
  detectFeeAmountAsk, detectFeeRules, detectFeeFirstTime, detectFeeChargePushback,
  detectFeeTotalCost, detectAgreement, detectVisitRequest, detectCheaperSearch,
  detectVisitTimingQuestion, detectProceedAfterCheck, detectPriceFreshness,
  detectPriceAsk, detectRemark, detectSqmRate, detectProvisionResistance, detectBye,
  detectPriceChangeComplaint, detectRentTermsAsk, detectTotalCostAsk, extractRentMath,
  detectMoreOptions, detectSmallerPerM2Ask, detectBudget, fsmRequired,
  detectLocation, hasMarketTypePlural, isMarketRentWordAsk, detectMarketLevelFollowUp,
  detectExitCheck, detectSoftRefusal, detectWaitingAck, detectAgentAttendanceAsk,
  detectContactRequest, detectEyeCatch, detectPositiveEval, detectDescribeAsk,
  extractPriceExtremeQuery,
} from '../llm/deterministic';
import { detectInfoFacets } from '../llm/infoAnswer';
import { detectGlossaryAsk } from '../llm/glossary';
import { detectRecommendAsk, detectValueAsk } from '../llm/recommend';
import { arbitrateMoney, isFeeAmountClaim } from '../llm/moneyArbitration';
import { inferPropertyId } from '../llm/classify';
import { resolvePropertyFocus } from './focus';
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

/** The executor's fee-leg state lists, copied verbatim — a mirror row that
 *  invents its own gate predicts a lane the executor never runs. */
// moneyArbitration.ts:100 (the money-script states: every fee lane lives here).
const FEE_MONEY_STATES = ['closing', 'property_query', 'presentation', 'discovery',
  'intent', 'idle', 'property_locate', 'contact_collection'];
// moneyArbitration.ts:231 — the nag claim stands in the fee states (with the
// fee context) and in property_locate (without it: a bare «НЕ ЗНАМ» there is an
// answer to the identify question, not fee resistance).
const FEE_NAG_STATES = ['closing', 'presentation', 'property_locate'];

/** The executor's own `propertyOnTable` formula (inbound.ts 7030) — the money
 *  arbiter's evidence target. One copy, so the mirror's rows and the arbiter's
 *  evidence boundary can never disagree about what "on the table" means. */
function moneyPropertyOnTable(sl: RouteSlots): boolean {
  return !!(sl.propertyId || sl.interestedPropertyId || sl.lastPrice || sl.presentedIds?.length);
}

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
/** A BARE PRICE REFERENCE about the flat in play («околу 130000 беше») — no
 *  question, no noun, just the amount. The [12:26] turn was answered by the
 *  remembered-property flow while the mirror predicted FALLTHROUGH, so the
 *  drift log blamed the lane that was right. Narrow on purpose: a price word or
 *  a currency, and a property already on the table. */
function isBarePriceReference(t: string, sl: RouteSlots): boolean {
  if (/\?/.test(t)) return false;
  if (!/\b\d{4,7}\b/u.test(t) || EB_NAMED_RE.test(t)) return false;
  // The executor\'s locate entry is decided by the ABSENCE of everything else
  // (no EB, no question, no service), not by a slot — so the mirror\'s gate is
  // the same shape: a bare amount is a reference, and the flat it refers to is
  // looked up, with the turn record or the price itself as the memory.
  const onTable = (sl.presentedIds?.length ?? 0) + (sl.currentBatch?.length ?? 0) > 0
    || sl.propertyId != null || sl.interestedPropertyId != null
    || sl.mirrorLastTargetEb != null;
  const recalledLastTurn = !!sl.mirrorPriorUserText
    && (detectSeenListingRecall(sl.mirrorPriorUserText) || detectPropertyDescription(sl.mirrorPriorUserText));
  return onTable || recalledLastTurn || !sl.service;
}

export const ROUTING_ORDER: RouteRule[] = [
  // A TERMINAL ECHO IS NOT A CLIENT — the intake guard in processMessage runs
  // before the session is even read, so it precedes even the offensive check
  // (frame bytes must not spend a strike on the client either). Mirrored so the
  // calibration registry sees the lane instead of a silent early return.
  { intent: 'ECHO_IGNORED', note: 'our own painted frame delivered as input ([02:04] capture: «[02:50] ЛИНА [без LLM]: … │») — dropped with no reply and no state change, before the zero-output policy',
    fires: t => looksLikeScreenEcho(t) },
  { intent: 'OFFENSIVE', note: 'zero-output policy wins over everything',
    fires: t => classifyOffensive(t).isOffensive },
  // AGENT ATTENDANCE (inbound.ts 4518) — an informational question, handled
  // BEFORE the broad visit detector so «ТИ ЌЕ ДОЈДЕШ СО МЕНЕ?» is never read as
  // a request to schedule (the [22:08] capture heard «300 денари» instead of a
  // yes). SLOT-AWARE: the bare «со мене?» is a viewing question only with a
  // flat on the table — the executor's own `attendanceContext`.
  { intent: 'AGENT_ATTENDANCE_ASK', note: 'does the agent attend the viewing — answered from the bank before any visit/fee lane can claim it',
    fires: (t, s, sl) => detectAgentAttendanceAsk(t, {
      propertyContext: !!(sl.propertyId || sl.interestedPropertyId
        || (sl.presentedIds?.length ?? 0) > 0) }) },
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
  // THE OWNERS-MAY-REPRICE DISCLAIMER (inbound.ts 7012): a clean-price
  // correction was just relayed (priceChangePending) and the client pushes back
  // on the price. It is served BEFORE the cheaper-alternatives lanes — the
  // client asks "why is it different", not "show me something cheaper" — so
  // it also precedes the two valence rows below, exactly as it does in 7012.
  { intent: 'PRICE_CHANGE_DISCLAIMER', note: '«KAKO BE SEGA POSKAPA CENATA?» after a relayed clean-price correction — the owners-may-reprice line, verbatim. SLOT-AWARE: the executor gates it on slots.priceChangePending (a correction really was relayed) and refuses fee traffic (a fee objection is never a price question)',
    fires: (t, s, sl) => !!sl.priceChangePending && !isFeeTraffic(t)
      && detectPriceChangeComplaint(t) },
  { intent: 'PRICE_EVAL_CHEAP', note: 'a POSITIVE price remark about the flat on the table ("MNOGU EFTINA CENA E TOA") — valence, not money talk. The fee is never called cheap, so this lane must beat the fee ladder; gated to states where a price is on the table and to non-questions, so it cannot steal a price ask or a search',
    fires: (t, s) => detectPriceEval(t) === 'cheap' && !/\?/.test(t)
      && ['property_query', 'presentation', 'closing'].includes(s) },
  // THE WIRED NEGATIVE PRICE EVALUATION (inbound.ts 7079, the leg right after
  // the cheap one): a NEGATIVE valence whose object is the explicit price noun,
  // on a property on the table, non-negotiative, nothing else claiming. The
  // mirror must not re-derive that evidence boundary — it calls the arbiter
  // itself (`arbitrateMoney`, the executor's own decision at 7029) so the row
  // can never be looser than the serve. The bank's serve-time vetoes
  // (neverServes) stay out of the prediction: they are a wording decision, not
  // a precedence one.
  { intent: 'PRICE_EVAL_EXPENSIVE', note: '«SKAPA E CENATA» / «PREVISOKA CENA» about the flat on the table — acknowledge, owner-set price, invite the live viewing. Predicted through the money arbiter itself (lane === \'expensive\'), never a private gate: the evidence boundary (explicit PRICE NOUN + property on the table + property_query/presentation + non-question + no other claim) is the arbiter\'s to decide',
    fires: (t, s, sl) => detectPriceEval(t) === 'expensive'
      && arbitrateMoney(t, {
        state: s,
        propertyOnTable: moneyPropertyOnTable(sl),
        feeAgreed: !!sl.viewingFeeAgreed,
        feeTold: !!sl.feeDisclosed || (sl.feeRejections ?? 0) > 0,
        feeBlocked: false, provisionBlocked: false,
      }).lane === 'expensive' },
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
  { intent: 'SUBJECT_PER_M2', note: 'the €/m² of the FLAT on the table («колку му држи цената по квадрат?») — price ÷ m². Sits before MARKET_PRICE (the executor\'s arm at 5572 precedes the band at 5894) AND mirrors its certainty gate: with no bound subject and no area anchor the executor asks which flat instead of serving a band, so the mirror must not call that a market turn',
    fires: (t, s, sl) => detectSubjectPerM2Ask(t) && inferPropertyId(t) === undefined
      && (resolvePropertyFocus(t, sl).certainty === 'bound' || !(sl.location || sl.poiAnchor)) },
  // …AND THE ARM'S OWN INNER GATE (inbound.ts 5691). Replaying «KOLKU MU E
  // KIRIJA ?» through the real handler showed the arm standing down there — an
  // anchored flat plus a rent-only wording is a question ABOUT THAT FLAT, not
  // about the market — and the INFO block serving the flat\'s own rent. The
  // mirror called that a market turn, so the row was looser than the serve.
  { intent: 'MARKET_PRICE', note: '"KAKO SE DVIZAT CENIVE ZA STANOVI VO AERODROM?" ([16:57]) — the €/m² range for a CATEGORY in an AREA, answered from the feed\'s own rows. Sits after WHERE_IS/DISTANCE (which own their questions) and before every property-price branch, which would otherwise quote the single flat on the table. Mirrors the arm\'s own three conditions: no both-services ask, no named Евидентен број, and a scope IN THE MESSAGE (an area/city/numbered sub-area), a plural category („станови“), or no anchored flat to speak for',
    fires: (t, s, sl) => {
      const asked = detectMarketPriceAsk(t)
        || (detectMarketLevelFollowUp(t) && !!(sl.poiAnchor || sl.location));
      if (!asked) return false;
      if (detectBothServices(t) || inferPropertyId(t) !== undefined) return false;
      const cityAsk = /(?<![\p{L}\p{N}])(?:скопје|skopje|скопју|skopju)(?![\p{L}\p{N}])/iu.test(t);
      // The mirror has no feed, so the area pool is the detector's own known
      // Skopje neighbourhoods (`detectLocation` always includes them: Latin
      // transliteration included). A place only the FEED knows («Маџар Маало»)
      // is a KNOWN LIMIT of this row — the executor's `placesNamedIn` reads the
      // feed, the mirror cannot.
      const areaInMessage = cityAsk || detectLocation(t, []) !== undefined;
      const anchoredEb = sl.propertyId ?? sl.interestedPropertyId;
      return areaInMessage || hasMarketTypePlural(t)
        || (anchoredEb === undefined && !isMarketRentWordAsk(t));
    } },
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
  // ── THE FOUR LANES THE CORPUS CAUGHT WITHOUT A MIRROR ROW (proposal Phase 4)
  // Replaying tests/corpus/turns.jsonl through the real pipeline printed the
  // drift log for five of nine turns: the executor served AVAILABILITY_TABLE,
  // OWN_CLAIM_EXPLAIN, SUBJECT_PER_M2 and FEE_PUSH while the mirror predicted
  // FALLTHROUGH / MARKET_PRICE / PROPERTY_DESCRIPTION. A serving path with no
  // row is a GAP, and a wrong row is a DRIFT — both make `route:health` blame
  // the lane that was right, and both hide the next real misroute. Each row
  // below mirrors the executor's OWN condition and its own position (inbound.ts
  // line order at 2026-11-13): own-claim 5409, per-m² 5572, fee 7282,
  // availability 9698.
  { intent: 'OWN_CLAIM_EXPLAIN', note: 'a challenge about our OWN earlier answer («зошто ми кажа дека е стара понуда?», [12:31]–[12:35]) — answered from the turn record. Sits before PROPERTY_DESCRIPTION, exactly as the executor\'s block (5409) precedes the remembered-property flow (8821)',
    fires: t => detectOwnClaimChallenge(t) },
  { intent: 'FEE_AMOUNT_ASK', note: 'what the VISIT costs («KOLKU E ZA POSETA?», «5 EVRA ZA POSETA?») — the fee disclosure, never the flat\'s rent or the owner-price policy. Mirrors the arbiter\'s feeAmount claim through the SAME predicate (`isFeeAmountClaim`, which carries the amount-first statement sibling the provision ask used to own): the executor serves it FIRST in the money region (inbound.ts 7111), so it must sit before PROVISION_ASK here — without the row «KOLKU E ZA POSETA?» was predicted PROVISION_ASK (the commission question) while the fee disclosure was on screen',
    fires: (t, s) => isFeeAmountClaim(t) && FEE_MONEY_STATES.includes(s) },
  { intent: 'FEE_PUSH', note: 'fee charge pushback — the nag ladder, incl. the rhetorical «KAJ SE VIDELO PARI ZA OTVARANJE STAN» ([22:03]). Sits after SURROUNDINGS and before the where-is/description rows, because a fee nag is NEVER a place question (§2: the location lanes stand down on fee traffic) — without this row the challenge was predicted PROPERTY_DESCRIPTION. The options-ask veto is the executor\'s own: a choice about the flats on the table keeps the recommendation lane, never the ladder. NO WHY-WORD VETO: the executor\'s nag claim (inbound.ts 7285) runs BEFORE the fee.why legs (10118+), so «NIKOJ NE ZEMA PARI ZA POSETA?» / «PARI ZA POSETA ZEMATE ? ZOSTO?» / «MNOGU NEKAKO 500DEN ZA POSETA» climb rung 1 — the R1 row predicted FEE_WHY for them and reported a drift the ladder never caused',
    fires: (t, s, sl) => detectFeeNag(t, { feeContext: s === 'closing' || s === 'presentation' })
      && FEE_NAG_STATES.includes(s)
      && !sl.viewingFeeAgreed
      && !(detectRecommendAsk(t) || (detectValueAsk(t) && ((sl.presentedIds?.length ?? 0) > 0 || sl.propertyId != null))) },
  // ── THE RENT-TERMS REROUTE (inbound.ts 7303, right after the nag ladder) ───
  // «KOI VI SE USLOVITE ZA IZNAJMUVANJE ?» — the CONDITIONS OF RENTING
  // (commission tier, first rent + deposit, one-year minimum), answered from
  // provision.ask.rent. Before this lane the turn fell into the fee disclosure
  // and heard «300 денари» — the VISIT fee — twice, a different charge
  // altogether. It sits after the fee ladder (a fee RESISTANCE is never a terms
  // question; the detector vetoes itself on why/complaint/resistance traffic)
  // and before the agreement lane, exactly as the executor orders them.
  { intent: 'RENT_TERMS', note: 'the conditions of renting — provision.ask.rent, never the viewing fee (the [20:40] capture: the client asked what renting costs up front and was told the visit fee twice)',
    fires: t => detectRentTermsAsk(t) },
  // ── THE MONEY-FAMILY MIRROR (Phase 4, slice 2) ────────────────────────────
  // The executor\'s fee legs are ONE region with a fixed order (inbound.ts
  // 7397–10180), and each leg logs a different tag for the same words: a
  // disclosed fee turns «DOBRO, SE SOGLASUVAM SO USLOVITE» into consent, «PRV
  // PAT SLUSAM» into the rule, «OVA E NESTO NOVO» into the rationale. Replaying
  // the canonical money texts through the real handler (probe: `.bench/
  // money-mirror.ts`) showed four of them predicted FALLTHROUGH or FEE_WHY while
  // the executor served the finer lane — a mirror that hides which fee leg ran.
  // Every row below carries the executor\'s own gate and its own position.
  { intent: 'FEE_AGREED_FIRST', note: 'the FIRST «да» after a served fee disclosure (inbound.ts 7397): feeDisclosed + no agreed fee + agreement/visit-request wording + the same veto list (cheaper search, timing, a location question, a why/complaint/pushback, commission resistance, a which-flat recall, a price re-check, a per-m² rate). It opens contact collection, so nothing may steal it',
    fires: (t, s, sl) => !!sl.feeDisclosed && !sl.viewingFeeAgreed
      && ['closing', 'presentation', 'property_query', 'property_locate'].includes(s)
      && (detectAgreement(t) || detectVisitRequest(t))
      && !detectCheaperSearch(t) && !detectVisitTimingQuestion(t)
      && !detectSurroundingsAsk(t) && !detectWhereIs(t)
      && !detectExactAddressAsk(t) && !isDistanceQuestion(t)
      && (!detectAvailabilityAsk(t) || detectProceedAfterCheck(t))
      && !detectFeeWhy(t) && !detectFeeComplaint(t) && !detectFeeChargePushback(t)
      && !detectProvisionResistance(t) && !detectFeePaymentAgreement(t)
      && !detectArrangementRecall(t)
      && !detectPriceFreshness(t) && !detectPriceAsk(t) && !detectRemark(t)
      && detectSqmRate(t) === undefined },
  // PRICE FRESHNESS (inbound.ts 7550) — «A DALI MU E USTE TAA CENA?». The
  // executor\'s own gate, copied field for field: a property ON THE TABLE, the
  // veto list (remark, budget, fee complaint, fee agreement, negotiation,
  // service search, a challenge about our own words), and a resolvable EB with
  // a price to quote. No state gate — the client may ask in closing, in
  // contact collection or the next day. Sits after the agreement lane (7397),
  // as the executor orders them: a «да» with a freshness rider is consent.
  { intent: 'PRICE_FRESHNESS', note: 'is the quoted price still current — last known price + the owners-reprice disclaimer + the owner-contact ask, never a bare amount (08:50 protocol). SLOT-AWARE: a brand-new search with nothing on the table has no price that can be «still» current, so the lane stands down and the plain price ask keeps the turn',
    fires: (t, s, sl) => detectPriceFreshness(t)
      && !!(sl.propertyId || sl.interestedPropertyId || sl.presentedIds?.length)
      && !detectRemark(t) && !detectBudget(t)
      && !detectFeeComplaint(t) && !detectFeePaymentAgreement(t)
      && !detectNegotiate(t) && !detectService(t) && !detectBothServices(t)
      && !detectOwnClaimChallenge(t) },
  // KNOWN LIMIT: the executor then looks the EB up in the FEED and serves only
  // when it finds a price. The mirror cannot read the feed, so a property on
  // the table with no stored figure is still predicted here — the feed decides
  // whether a row is price-less, and only then does the plain price ask keep
  // the turn.
  // THE PRICE-NEGOTIATION FAST LANE (inbound.ts 7665) — moved here from the
  // tail: the executor serves it BEFORE the INFO block (7837), so a
  // «DALI E VOZMOZNA KORENCIJA NA CENATA ?» with a flat on the table is a
  // negotiation, never an info ask. Its vetoes are the executor\'s own:
  // fee traffic and a fee agreement keep their money lanes (the [19:40]
  // capture answered a VISIT-fee question with the owner-price policy), and an
  // info-by-EB ask keeps the describe lane (the [00:15] «DAJ MI INFO ZA 91»
  // capture).
  { intent: 'NEGOTIATE', note: 'price pushback — commercial states only, on a property that is on the table, never on fee traffic',
    fires: (t, s, sl) => detectNegotiate(t)
      && ['closing', 'presentation', 'property_query'].includes(s)
      && !detectFeeComplaint(t) && !detectFeePaymentAgreement(t)
      && !isFeeTraffic(t)
      && !(inferPropertyId(t) !== undefined
        && /(?:инфо|информации|informacii|(?:^|[^\p{L}])info(?![\p{L}]))/iu.test(t))
      && !!(sl.propertyId || sl.interestedPropertyId || sl.presentedIds?.length) },
  // GLOSSARY (inbound.ts 7699) — «sto znaci toa suteren ?»: the client asks
  // what a TERM means, not what this flat's ceiling is. Served before the info
  // block (which would answer the definition with the property's floor line —
  // the [08:52] transcript), hence the row sits between NEGOTIATE and INFO_ASK.
  { intent: 'GLOSSARY', note: 'a term-definition ask — the vocabulary answer, never a facet re-render',
    fires: t => detectGlossaryAsk(t) !== undefined },
  // ── THE INFO-ASK BLOCK (inbound.ts 7837–8130) ──────────────────────────────
  // The block that answers FACTS about a flat already on the table («kolku e
  // garsonjerata?», «a 63 kolku kvadrati», «dali 76 ima lift?») from the feed\'s
  // public-add data. It is the lane that actually quotes the price of the flat
  // on the table (the price FACET of buildInfoAnswer), which is why the plain
  // price ask below almost never fires with a property on the table — the
  // executor reaches INFO_ASK first. Its gate is the block\'s own: a facet,
  // the veto list (a fee complaint echoing «cena?», a more-options ask, fee
  // traffic, the commission ask, the smaller-by-rate search, the cash-at-
  // signing total) and a binding signal (a slot, a described pair, an EB in the
  // text, or the year/renovation facet that every property can answer).
  // KNOWN LIMIT: the executor also accepts `lastQuotedEb` (the price-quote
  // shape of HER OWN last line) and the elliptical floor follow-up («POSLEDEN ?»
  // after she named a floor) — both live in the chat history, which the mirror
  // does not read, so the mirror asks for a slot or a number instead.
  // ── YEAR/RENOVATION WITH NOTHING BOUND (Phase 4, describe family) ─────────
  // The executor answers a year/renovation ask about a BOUND flat under
  // INFO_ASK, but with NO flat it cannot look the fact up and serves the
  // property-agnostic miss line under its OWN tag (inbound.ts 8040–8049). The
  // mirror had no row for that tag, so a cold «од која година е зградата?»
  // predicted INFO_ASK and the registry recorded a GAP on a correct serve.
  // Position: INSIDE the info block and before it — the executor's miss branch
  // runs after the same facet parse, with the same vetoes.
  // KNOWN LIMIT: the executor's `infoProp` also comes from the FEED (a slot may
  // name a row the feed no longer has); the mirror cannot read the feed, so a
  // stale slot is still predicted INFO_ASK here.
  { intent: 'INFO_ASK_YEAR', note: 'year-of-construction / renovation ask with NO flat bound — the property-agnostic missing-fact line (inbound.ts 8040–8049), never the LLM',
    fires: (t, s, sl) => {
      const facets = detectInfoFacets(t);
      if (!facets || !(facets.yearBuilt || facets.renovation)) return false;
      return !(sl.propertyId || sl.interestedPropertyId
        || (sl.presentedIds?.length ?? 0) > 0 || (sl.describedEbs?.length ?? 0) > 0
        || inferPropertyId(t) !== undefined);
    } },
  // ── THE DESCRIBE FAMILY (Phase 4): the card order, not a search ───────────
  // «ОПИШИ ГИ ?» describes the flats ALREADY on the table (inbound.ts 9414:
  // `onTableEbs` from describedEbs → currentBatch → the anchored flat) and only
  // when the text asks for a description — a facet question keeps INFO_ASK, an
  // availability word keeps the ack. Feed lookups decide whether a CARD can be
  // built, which the mirror cannot see; the slot set is what decides the lane.
  { intent: 'DESCRIBE_TABLE', note: '“опиши ги?” — the flats she just offered, answered from the bank rows (inbound.ts 9414). Requires a described batch on the table AND a describe ask; an info-by-number ask belongs to INFO_ASK',
    fires: (t, s, sl) => detectDescribeAsk(t)
      && ((sl.describedEbs?.length ?? 0) > 0 || (sl.currentBatch?.length ?? 0) > 0
        || (sl.presentedIds?.length ?? 0) > 0
        || sl.interestedPropertyId != null || sl.propertyId != null) },
  // «ВО КОЈА НАСЕЛБА СЕ НАЈЕВТИНИ СТАНОВИТЕ» compares NEIGHBOURHOODS, never rows
  // (inbound.ts 6146): cheapest mode + the word «населба» in the ask + buy + no
  // area named (naming an area is a row listing). KNOWN LIMIT: the lane also
  // needs per-м² rows in the feed; the mirror cannot rank a feed it cannot read.
  // THE PRICE-EXTREME FAMILY: one detector owns the whole block (inbound.ts
  // 6007 `extractPriceExtremeQuery`), which serves cheapest/dearest listings,
  // total-price asks and the «за колку најмалку» shapes. Its ONE data condition
  // is that the feed has rankable rows — so the mirror owns the TEXT half and
  // documents the rest (a feed with no м² figure serves the plain listing under
  // the same tag, which is why the row still matches).
  { intent: 'PRICE_EXTREME', note: 'an EXTREME price ask (“do 1000 evra kuca”, “koj ti e toj stan po … po m2”) — the cheapest/dearest listing under the client\'s own criteria, never the plain price ask (inbound.ts 6007). KNOWN LIMIT: the rankable pool comes from the feed',
    fires: t => extractPriceExtremeQuery(t) !== undefined },
  // «KOJ BI MI GO PREPORACALE ?» — a JUDGMENT over the flats the chat has
  // discussed (inbound.ts 10432), never a card re-serve. KNOWN LIMIT: the
  // executor also admits the turn when a doubt phrase («ne znam…») forces the
  // FSM path but the doubt is about the table (`choiceAboutTable`, which needs
  // the mention binder); the mirror cannot read that, so such a turn is
  // predicted one row lower.
  { intent: 'RECOMMEND_ASK', note: '“koj bi mi go preporacale?” — the pick among the flats already discussed, with the reason, never the same cards again',
    fires: (t, s) => detectRecommendAsk(t)
      && ['idle', 'intent', 'discovery', 'property_query', 'presentation', 'closing'].includes(s) },
  { intent: 'INFO_ASK', note: 'a fact ask about the flat on the table — one answer per facet from the feed\'s own data, never the LLM (scope C)',
    fires: (t, s, sl) => {
      const facets = detectInfoFacets(t);
      if (!facets) return false;
      if (detectFeeComplaint(t) || detectMoreOptions(t) || isFeeTraffic(t)
        || detectProvisionAsk(t) || detectProvisionWho(t)
        || detectSmallerPerM2Ask(t) || detectTotalCostAsk(t)) return false;
      return !!(sl.propertyId || sl.interestedPropertyId
        || (sl.presentedIds?.length ?? 0) > 0 || (sl.describedEbs?.length ?? 0) > 0
        || inferPropertyId(t) !== undefined
        || facets.yearBuilt || facets.renovation);
    } },
  { intent: 'FEE_FIRST_TIME', note: '«OVA PRV PAT SLUSAM» ([00:28]) — the client never met the fee before, so the answer is the FACT (fee.rule.hold), not another rationale. The executor tests it BEFORE the why leg, so the row must precede FEE_WHY',
    fires: (t, s) => detectFeeFirstTime(t)
      && ['closing', 'property_query', 'presentation', 'discovery', 'intent', 'idle'].includes(s) },
  { intent: 'FEE_SURPRISE', note: '«OVA E NESTO NOVO» / «AUUU» at the disclosure — closing-only in the executor, and it serves the fee.why rationale WITHOUT a rung (§2: surprise is not resistance). Mirrors that gate instead of widening it: «imate nesto novo vo karpos?» is a property ask',
    fires: (t, s) => detectFeeSurprise(t) && s === 'closing' },
  { intent: 'FEE_RULES', note: '«KAKVI SE PRAVILATA NA AGENCIJATA?» — the rules-of-work script. The executor\'s intercept tries rules before why and total-cost, so a rules question is never re-explained as «why»',
    fires: (t, s) => detectFeeRules(t) && FEE_MONEY_STATES.includes(s) },
  { intent: 'FEE_COMPLAINT', note: 'the fee arithmetic complaint leg (`detectFeeTotalCost` — «ako gledam 10 stana toa se 5000 od moj djeb»): the client multiplies the fee, which the executor answers with the rationale (never the search, never a rung). The executor evaluates it after rules/why, hence the two vetoes',
    fires: (t, s) => !detectFeeRules(t) && !detectFeeWhy(t) && detectFeeTotalCost(t)
      && FEE_MONEY_STATES.includes(s) },
  // THE EXIT FINAL-CHECK (inbound.ts 9951): one last-chance question before a
  // farewell, ONCE per session (slots.exitCheckServed). A second exit-shaped
  // turn logs EXIT_CHECK_REPEAT and lets the farewell lanes below own it —
  // which is why only the first is a mirror row.
  { intent: 'EXIT_CHECK', note: '«se predomisliv / ke si piseme drugoat» — the exit.criteria.check ask before the farewell, once per session',
    fires: (t, s, sl) => detectExitCheck(t) && sl.exitCheckServed !== true },
  { intent: 'BYE', note: 'a goodbye («NE FALA, CAO») — dispatchSimple owns it after the fee interceptors, so it sits with them: a closed chat must never be read as fee resistance',
    fires: (t, s) => detectBye(t)
      && !['owner_checking', 'pending', 'queued'].includes(s) },
  // A SOFT DECLINE (inbound.ts 9989, right after the farewell lane): «ne sakam»
  // / «не фала» closes gracefully — no re-offer, no rung (§2: a goodbye is not
  // fee resistance). Below BYE, as the executor orders them.
  { intent: 'SOFT_REFUSAL', note: 'a bare soft decline — graceful close, criteria kept, never a fee rung',
    fires: t => detectSoftRefusal(t) },
  { intent: 'AVAILABILITY_TABLE', note: '«GARSONJERATA ZA 200E DALI E DOSTAPNA?» / «дали се продааа уште?» ([12:31]) — the ack + owner question for ONE flat already on the table. Mirrors the executor\'s vetoes (fee traffic, a named EB, a room count, a plural type noun, an inventory ask, an area-have ask, an agreed fee) and its position AFTER the description flow',
    fires: (t, s, sl) => (sl.presentedIds?.length ?? 0) + (sl.currentBatch?.length ?? 0) > 0
      && detectAvailabilityAsk(t)
      && !detectFeeWhy(t) && !detectFeeNag(t) && !detectFeeComplaint(t)
      && !detectFeeSurprise(t) && !detectProvisionAsk(t) && !detectProvisionWho(t)
      && inferPropertyId(t) === undefined
      && extractSlots(t).bedrooms === undefined
      && !/(?<![\p{L}])(?:stanovi|станови|kuki|куќи|garsonjeri|гарсоњери|placa|плацеви|lokali|локали|prostori|простори)(?![\p{L}])/iu.test(t)
      && !detectInventoryAsk(t) && !detectAreaHaveAsk(t)
      && !sl.viewingFeeAgreed },
  // PROXY CONTACT (inbound.ts 8342, after the info block) — the client asks the
  // AGENCY to reach the owner and report back. In `closing` the FSM fee
  // protocol must claim these first (fee-before-contact is the judged-correct
  // order), which is exactly the executor's `state !== 'closing'` gate.
  { intent: 'PROXY_CONTACT', note: 'contact via the agency («STAPI VO KONTAKT I INFORMIRAJ ME») — never in closing, where the fee protocol owns the contact',
    fires: (t, s) => detectContactRequest(t) && s !== 'closing' },
  // WAITING (inbound.ts 10262) — the client is waiting for the details Lina
  // promised. The detector vetoes every concurrent topic, and the executor
  // keeps the visit states with the owner-pending lines, so the mirror copies
  // both gates rather than widening them.
  { intent: 'WAITING', note: '«CEKAM USTE» — the patience line, statelessly, before any remark/LLM fast path',
    fires: (t, s, sl) => detectWaitingAck(t)
      && !['visit_scheduling', 'owner_checking', 'time_confirm', 'pending', 'queued',
        'escalated', 'terminated'].includes(s)
      && !!(sl.propertyId || sl.interestedPropertyId || sl.presentedIds?.length) },
  // THE RENT-MATH LANE (inbound.ts 10024–10060) — «kolku e vkupno so
  // provizija i depozit?»: the arithmetic on the rent of the flat on the
  // table (commission tier + deposit + first rent). It reads the SAME two
  // entry paths the executor has: the pure-text shape (`extractRentMath`,
  // exported by deterministic.ts and reused here rather than re-derived) and
  // the anchored total-cost ask, which needs a RENT flat to compute from —
  // hence the slot gate. The anchor\'s own service/price check lives in the
  // feed, so the mirror\'s share is the segment + a property to read.
  { intent: 'RENT_MATH', note: 'the total due at signing on a rental (first rent + deposit + commission) — arithmetic, never the viewing fee',
    fires: (t, s, sl) => extractRentMath(t) !== undefined
      || (detectTotalCostAsk(t) && sl.service === 'rent'
        && (inferPropertyId(t) !== undefined || sl.interestedPropertyId != null
          || sl.propertyId != null || (sl.currentBatch?.length ?? 0) > 0
          || (sl.presentedIds?.length ?? 0) > 0)) },
  { intent: 'PROPERTY_DESCRIPTION', note: '"гарсоњерата кај амбасадата" — remembered-property flow before FSM discovery swallows it',
    // …and NEVER on fee traffic: «KAJ SE VIDELO PARI ZA OTVARANJE STAN» reads as
    // a place phrase and was predicted here while the fee ladder served it.
    // The executor's fee arm vetoes itself out of every location lane (§2);
    // the mirror has to say the same or it reports a drift it invented.
    // …but never for a STOCK-AT-A-PLACE ask («DALI IMATE NESTO INTERESNO KAJ
    // ZEBRA ?»): that is a present-tense show-me ask, the see-offers sell owns
    // it, and reading it as a remember-which-flat turn is the [01:45] defect
    // (two clients, one question, two answers). Same exclusion as the executor.
    fires: (t, s, sl) => (detectPropertyDescription(t) || isBarePriceReference(t, sl))
      && !detectInventoryAsk(t)
      && !isFeeTraffic(t) && !detectOwnClaimChallenge(t)
      && !detectService(t) && !detectBothServices(t) && !detectDrugAlternative(t) && !detectInvestmentOpinion(t) },
  { intent: 'VISIT_CANCEL', note: 'cancellation only meaningful in visit states',
    fires: (t, s) => detectVisitCancellation(t) &&
      ['visit_scheduling', 'owner_checking', 'time_confirm'].includes(s) },
  { intent: 'VISIT_RECALL', note: '«ZA KOJ STAN TI KAZAV DA DOGOVORIS PREESKA ?» ([01:2x]) — which flat the ARRANGEMENT was for. A flat noun plus an arranging verb made the classifier read it as a visit ORDER and the fee-agreement lane opened contact collection; the lane answers from the appointment itself. No state gate: the client may ask in closing, in contact collection or next day',
    fires: t => detectArrangementRecall(t) },
  // State-gated informational intents (the tail of the chain):
  // THE PLAIN PRICE ASK (inbound.ts 10396, inside the `!fsmRequired` fast
  // block): «KOLKU E CENATA?» with nothing on the table — bind the mention if
  // there is one, quote the named flat, else ask for the Евидентен број. Its
  // gate is the executor\'s whole veto list (a budget statement, the
  // commission ask, a drug alternative, a fee complaint, a cheaper search, fee
  // traffic) because `detectPriceAsk` matches on the currency word alone.
  { intent: 'PRICE_ASK', note: 'direct price ask — the flat named or the one on the table, else the Евидентен број question (never a fee disclosure)',
    fires: t => !fsmRequired(t) && detectPriceAsk(t) && !detectBudget(t)
      && !detectProvisionAsk(t) && !detectProvisionWho(t) && !detectDrugAlternative(t)
      && !detectFeeComplaint(t) && !detectCheaperSearch(t) && !isFeeTraffic(t) },
  { intent: 'OFFTOPIC', note: 'small talk redirect — not while owner handshake pending',
    fires: (t, s) => detectOfftopic(t) && !['owner_checking', 'pending'].includes(s) },
  { intent: 'DEFER', note: '"ќе размислам" — closing/presentation/property states',
    fires: (t, s) => detectDefer(t) &&
      ['closing', 'presentation', 'property_query', 'property_locate'].includes(s) },
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
  { intent: 'PROVISION_WHO', note: 'who pays the commission / the notary-inspector costs («KOJ JA PLAKJA PROVIZIJATA?», «KOJ GO PLAKJA DANOKOT?») — dispatchSimple\'s provision.who, which the executor reaches AFTER the commission ladder, so it sits below it and ABOVE the plain commission ask (the who-pays wording satisfies both detectors)',
    fires: (t, s) => detectProvisionWho(t)
      && ['closing', 'presentation', 'property_query', 'property_locate', 'discovery', 'intent', 'idle', 'contact_collection'].includes(s) },
  { intent: 'PROVISION_ASK', note: 'COMMISSION traffic — the ask («KOLKU E PROVIZIJATA?») AND the resistance («NE SAKAM PROVIZIJA» / «ПРОВИЗИЈАТА НЕ ЈА ПРИФАЌАМ», the arbiter\'s provision claim + the executor\'s ladder at inbound.ts 7212, which logs PROVISION_PUSH:fast and normalises here). Resistance is predicted as the same family because that is the tag family; it never burns a visit-fee rung (§2 isolation) and must sit BELOW PROVISION_WHO (the who-pays wording satisfies both detectors and the who lane serves it). EVERY client-side state (the [09:51] capture: «KOLKU VI E PROVIZIJATA ?» in property_locate was skipped by the old gate and the card pair was re-served). The mirror must carry the executor\'s own list: a narrower gate here predicts FALLTHROUGH for a turn the lane really serves',
    fires: (t, s) => (detectProvisionAsk(t)
        // A refusal is not an ask, but it IS this family (its own counter):
        // the executor\'s commission ladder claims it before every other lane.
        || (detectProvisionResistance(t) && FEE_MONEY_STATES.includes(s)))
      && ['closing', 'presentation', 'property_query', 'discovery', 'intent', 'idle',
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
  // AN EYE-CATCH REACTION is a SIMPLE_DISPATCH lane, served late in the turn:
  // it holds only when nothing else claimed the text, so its row sits LAST but
  // one — any question in the same sentence owns the turn.
  { intent: 'ENTHUSIASM', note: 'praise of a flat on the table («ODLICNA LOKACIJA IMA», «ova mi fati oko») — enthusiasm + a visit offer, NEVER the fee (inbound.ts 10196). The executor\'s gate is `detectPositiveEval` + a bound flat + `state !== closing || ownerContactPending`; its long veto list is already covered HERE BY ORDER — every fee/visit/price/where lane above claims first, which is exactly why the executor lists them',
    fires: (t, s, sl) => detectPositiveEval(t)
      && !!(sl.propertyId || sl.interestedPropertyId || (sl.presentedIds?.length ?? 0) > 0)
      && (s !== 'closing' || !!sl.ownerContactPending)
      && !detectWhereIs(t) && !detectExactAddressAsk(t) && !detectAvailabilityAsk(t)
      && !detectPriceAsk(t) && !detectService(t) && !detectBothServices(t)
      && !detectBudget(t) && !detectAgreement(t) },
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
  // THE TURN RECORD (proposal Phase 2): until now the served lane existed only
  // as a console line (`[route]`), so "which lane answered this turn?" was
  // answerable only by grepping a log. The audit object lives in the turn's
  // async-local context (src/handlers/turn.ts), which is why 117 call sites did
  // not have to learn a new signature.
  const audit = currentTurnAudit();
  if (audit && (!audit.chatId || audit.chatId === chatId)) {
    if (kind === 'predict') audit.predicted = intent;
    else if (audit.lanes.length < 8) audit.lanes.push(intent);
  }
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
  // A ROUTE_UNKNOWN TAG IS A PRE-SERVE GUESS, NOT A LANE: the classifier logs
  // it BEFORE the deterministic block runs, and the real lane follows. Comparing
  // it to the prediction recorded a gap for turns that were served correctly
  // (the price family: predicted=INFO_ASK, actual=ROUTE_UNKNOWN:unknown
  // .property-price.ask on every good serve), which is exactly the noise the
  // taxonomy above was written to stop — an operator who sees gaps on correct
  // turns stops reading them, and the real backlog hides in the noise.
  if (intent.startsWith('ROUTE_UNKNOWN')) return;
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
  ECHO_IGNORED: M('ECHO_IGNORED', 'a painted frame delivered as input — dropped at intake, before the session is read (the [02:04] capture: the funnel answered her own sentence with the fee)'),
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
  DESCRIBE_TABLE: M('DESCRIBE_TABLE', '“опиши ги?” — the flats she just offered, answered from the bank rows (inbound.ts 9414)'),
  MORE_STOCK: P('a stock ask after a pair was served («сакам да видам уште», «што уште имате ?») — the NEXT unshown pair from the same search, or the honest drained line; never the availability table, never the booking protocol, never a repeat of a flat already served ([12:41] capture)'),
  AVAILABILITY_TABLE: M('AVAILABILITY_TABLE', 'an availability ask that points at ONE flat already on the table by its type/price («GARSONJERATA ZA 200E DALI E DOSTAPNA?») — the ack + the owner question for THAT flat, never a fresh criteria grill ([22:27] capture)'),
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
  PROVISION_WHO: M('PROVISION_WHO', 'who pays the provision split'),
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
  FEE_RULES: M('FEE_RULES', 'agency fee rules ask (the rules-of-work script)'),
  'FEE_COMPLAINT': M('FEE_COMPLAINT', 'the fee-arithmetic complaint leg (detectFeeTotalCost)'),
  'AGENT_ATTENDANCE_ASK': M('AGENT_ATTENDANCE_ASK', 'does the agent attend the viewing — bank lane, before any visit/fee lane'),
  BYE: M('BYE', 'goodbye / close chat'),
  'ENTHUSIASM:fast': M('ENTHUSIASM', 'positive eye-catch reaction — a SIMPLE_DISPATCH lane, so it serves only when nothing else claimed the text'),
  'EXIT_CHECK': M('EXIT_CHECK', 'the once-per-session exit.criteria.check ask before a farewell'),
  // NOT A LANE: the second exit-shaped turn logs and FALLS THROUGH to the
  // farewell lanes (inbound.ts 9967), so its mirror is BYE / SOFT_REFUSAL — the
  // lane that actually answers.
  'EXIT_CHECK_REPEAT': P('the repeat of an exit-shaped turn — logs and continues into the farewell lanes, so it has no mirror row of its own'),
  'FEE_AMOUNT_ASK:fast': M('FEE_AMOUNT_ASK', 'exact fee amount asked (the arbiter feeAmount claim)'),
  'FEE_COMPLAINT:fast': M('FEE_COMPLAINT', 'fee resistance in the ladder'),
  'FEEDDOWN:fast': P('feed-down transparency lane'),
  'FEE_FIRST_TIME:fast': M('FEE_FIRST_TIME', 'first-time fee question'),
  'FEE_PUSH:fast': M('FEE_PUSH', 'fee charge pushback (the nag ladder; the mirror row arrived in Phase 4)'),
  'FEE_SURPRISE:fast': M('FEE_SURPRISE', 'fee surprise reaction'),
  'GHOST:fast': P('unknown EB one-off serve'),
  GLOSSARY: M('GLOSSARY', 'a term-definition ask — answered from the vocabulary, never re-rendered as a property facet'),
  INFO_ASK: M('INFO_ASK', 'a fact ask about the flat on the table — the price facet is why the plain price ask rarely fires with a property on the table'),
  INFO_ASK_YEAR: M('INFO_ASK_YEAR', 'year of construction ask with nothing bound — the property-agnostic miss line; a bound flat keeps INFO_ASK (inbound.ts 8040–8049)'),
  'INVESTMENT_OPINION:fast': P('investment-advice ask'),
  LANDMARK_LADDER: P('location-nag ladder rung'),
  LOCATION_NAG: P('location question refused again'),
  TOLD_YOU_RECALL: M('TOLD_YOU_RECALL', '«па ти кажав каде» — the notebook read back (places/area on file, then only the missing criterion)'),
  MONEY_CLARIFY: P('money-without-target clarification'),
  NEARBY_ASK: M('NEARBY_ASK', 'what is near the building — the interceptor runs before every funnel branch'),
  NEARBY_THREAD: P('what-else-is-near (rotation → protocol → lifecycle)'),
  'OWNER_HOLD:fast': P('owner unreachable continuation'),
  POI_CONFIRM: P('a place-confirm question about the bound flat («da ne e vo karpos ?») — the executor answers it only when the MAP resolves the named place (inbound.ts 6861: a landmark hit or a named area). The map is data, not text: a mirror row would have to guess, and the probe showed exactly that — «DA NE E VO SKOPJANKA ?» is a POI-confirm by wording while the executor served nothing. Labelled backlog, not a guessed row'),
  PLACE_PIVOT: P('same search at a different named place (“a neshto kaj X?”)'),
  PLACE_RING_ASK: M('PLACE_RING_ASK', 'the 1 km place ring: nothing inside the ring — the place, the measured distance and the one binary widen question (predicted on the refinement pass, from the pool\'s own poiTooFarAsk verdict)'),
  PLACE_RING_ROW: P('the identity of the flat the place ring measured (“koj e toj stan na 1,4 km?”)'),
  'PRICE_ASK:fast': M('PRICE_ASK', 'the plain price ask in the !fsmRequired fast block — the flat named or the one on the table, else the Евидентен број question'),
  PRICE_AVG_NASELBA: P('average €/m² per neighbourhood (“во која населба се најевтини становите”) — the aggregate branch (inbound.ts 6146) needs per-м² rows in the FEED and falls through to PRICE_EXTREME when it has none. A row would predict the aggregate for every cheapest+населба ask, including the ones the executor answers with the plain listing — a false drift, which is worse than a labelled gap. The text half is mirrored by PRICE_EXTREME, which is what serves when the data is thin'),
  'PRICE_EVAL_EXPENSIVE': M('PRICE_EVAL_EXPENSIVE', 'negative price remark about the flat on the table — the arbiter\'s own `expensive` lane'),
  // NOT A LANE: it logs and FALLS THROUGH (inbound.ts 7072) — a data-collector
  // record of every negative evaluation that the evidence boundary did NOT
  // wire to a serve. The mirror predicts the lane that really answers the turn,
  // so giving this tag its own row would predict a serve that never happens.
  'PRICE_EVAL_EXPENSIVE_UNWIRED': P('a NEGATIVE price evaluation the evidence boundary does not wire — logs and continues (no serve, no state change), so it has no mirror row of its own'),
  'PRICE_EXTREME': P('extreme price search (“do 1000 evra kuca”)'),
  'PRICE_EXTREME_MORE': P('extreme-price continuation'),
  'PRICE_FRESHNESS:fast': M('PRICE_FRESHNESS', 'is this price fresh? — last known price + the owners-reprice disclaimer + the owner-contact ask'),
  // PENDING MIGRATION — the Phase 2/5 lanes (turn record + answer-vs-funnel):
  // each logs itself today and gets its mirror row with the router work.
  OWN_CLAIM_EXPLAIN: M('OWN_CLAIM_EXPLAIN', 'a challenge about our own earlier answer — explained from the turn record, never a fee/price script'),
  SUBJECT_PER_M2: M('SUBJECT_PER_M2', 'the €/m² of the flat on the table (price ÷ м²), never the neighbourhood band'),

  PROXY_CONTACT: M('PROXY_CONTACT', 'contact via the agency, never in closing (where the fee protocol owns the contact)'),
  RECOMMEND_ASK: M('RECOMMEND_ASK', '“koj bi mi go preporacale?” — a judgment over the discussed flats, never the same cards again (inbound.ts 10432)'),
  RENT_TERMS: M('RENT_TERMS', 'the conditions of renting (commission tiers, first rent + deposit, one-year minimum) — provision.ask.rent, never the viewing fee'),
  FEE_AGREED_FIRST: M('FEE_AGREED_FIRST', 'the first «да» after the fee disclosure — agreement opens contact collection'),
  'REMARK:bank': P('bank-backed generic remark'),
  'REMARK:fast': P('generic remark (deterministic)'),
  'RENT_MATH:fast': M('RENT_MATH', 'total due at signing on a rental (first rent + deposit + commission) — arithmetic, never the viewing fee'),
  SOFT_REFUSAL: M('SOFT_REFUSAL', 'a bare soft decline — graceful close, never a fee rung'),
  WAITING: M('WAITING', 'the client is waiting for the details she promised — patience line, not remark/LLM traffic'),
  // THE DYNAMIC-SUFFIX FAMILY (`VISIT_CANCEL:<state>`, the executor's own tag):
  // routeLog resolves a tag through the registry, and a suffix the registry does
  // not know made every correct cancellation a GAP — the same alias bug
  // `WAITING:fast` was. The row names the intent; the tag keeps its state.
  VISIT_CANCEL: M('VISIT_CANCEL', 'a cancellation in a visit state (the tag carries the state: VISIT_CANCEL:visit_scheduling …)'),
  AVAILABILITY_PROCEED: M('AVAILABILITY_TABLE', 'an availability ask that ARRANGES the owner check («prasaj dali e dostapen i dogovori mi poseta») — same lane, the arranging half (inbound.ts 9732)'),
  // The smaller-by-rate lane has a detector but no ROUTING_ORDER row yet, so its
  // GOLEM variants cannot be mirrored without inventing one: pending, and the
  // test that every mirrored intent exists in the order stays honest.
  GOLEM_SMALLER: P('the smaller-by-rate search for a GOLEM (a large flat) — same lane as SMALLER_PER_M2, which has no mirror row yet (inbound.ts 16533)'),
  GOLEM_SMALLER_EMPTY: P('the smaller-by-rate search for a GOLEM with nothing smaller in the feed — the honest empty line (inbound.ts 16561)'),
  // NOT A CLIENT LANE: the executor logs the session→chain readiness marker with
  // a three-argument routeLog (`routeLog(chatId, 'chain', 'CHAIN_READY')`,
  // inbound.ts 2498) and serves nothing under it. It is registered so the audit
  // can tell "not a lane" from "a lane nobody mirrored".
  // TWO SERVING LANES WITH NO ROW YET — labelled, not guessed. Both are
  // decision-shaped and need the upstream choice/arithmetic parse to mirror
  // honestly; the audit shows them as PENDING (visible backlog) instead of
  // UNLISTED (a silent lane), which is the difference that matters.
  PROPERTY_CHOICE: P('the pick among flats that were PRESENTED («go sakam toj», a named card) — the fee is disclosed first, and in closing the fee lanes own the turn (inbound.ts 6994)'),
  FEE_PER_PROPERTY: P('the per-visit fee arithmetic («ZA SEKOJ STAN STO KE SE POSETI PO 500 ?») — the confirmation, then the ladder if a rung has already burned (inbound.ts 7209)'),
  CHAIN_READY: P('a session/chains readiness MARKER logged by routeLog(chatId, \'chain\', …) at inbound.ts 2498 — it answers nothing, so a mirror row would predict an answer that never happens'),
  'WAITING:fast': M('WAITING', 'the same lane on the fast path (the executor logs the suffix — an unregistered alias would read as a route gap)'),
  AREA_OF_PLACE: P('„во која населба е X“ — the place\'s own map quarter'),
  AREA_HAVE_SEARCH: P('„а во која населба има?“ — the area-availability ask: the criteria are released and the pair is served, with the neighbourhoods that hold it named ([19:46] capture)'),
  WHERE_LANDMARK: P('каде + a NAMED place — served only on a MAP HIT (inbound.ts 5049: `landmarks.findPlace`). The text part is mirrorable, the hit is not: a row would predict the lane for every unresolved name and report a drift the map caused. Labelled backlog until the mirror may consult the map'),
  'WHICH_PROPERTY:fast': P('which EB are you talking about'),
  'VISIT_CANCEL:WHICH': P('a cancel that names no arranged visit — asks which Евидентен број instead of guessing'),
  VISIT_RECALL: M('VISIT_RECALL', 'which flat the arrangement was for — answered from the appointment, never contact collection'),
  SEEN_RECALL_HELP: M('SEEN_RECALL_HELP', 'the listing he saw but cannot name — found from the held category + place, closed with the seen-property question'),
  BUSINESS_PLACE_SERVE: M('BUSINESS_PLACE_SERVE', 'business spaces at the named places by rate+distance (or an honest «нема» plus alternatives)'),
  DISTANCE_MATRIX: P('several places × every flat on the table («kolku e daleku od X i od Y ?») — one measured line per place and flat, nearest first; every named place is measured, never only the first'),
  AVAILABILITY_PLURAL: P('an availability ask over SEVERAL flats («se slobodni ?», «dvata ?») — the ack for the set plus the owner-confirm question, with the fee quoted per property'),
  BARE_EB_FOLLOWUP: P('a bare Евидентен број follow-up («А 42?») after cards were shown — the answer about THAT flat only, never a fresh search'),
  SLOT_TAKEN: P('a proposed visit hour already taken in the day calendar — the free hours of that day are named before any owner is asked'),
  PRICE_CHANGE_DISCLAIMER: M('PRICE_CHANGE_DISCLAIMER', 'a complaint about a price that moved mid-exchange (owner corrected the clean price) — the owners-may-reprice line, verbatim'),
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
    fallback: 'Работното време е од понеделник до петок, од 09:00 до 17:00 часот, а посетите ги организираме до 21:00 часот. Сабота и недела не работиме.',
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
