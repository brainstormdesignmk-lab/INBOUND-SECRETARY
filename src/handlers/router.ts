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
import { detectPersonalAsk } from '../llm/personal';
import { isLandmarkAnchored } from '../llm/lexicon';
import { detectWhichOfBatchPlace } from '../data/properties';
import { recordRouteDrift } from '../store/routeDrift';
import { currentTurnAudit } from './turn';
import {
  detectExactAddressAsk, detectWhereIs, detectSurroundingsAsk, detectOwnerContact,
  detectOtherFlatAsk, detectPluralFlatAsk, lastReplyWasNearby,
  isKadeTocno, detectPropertyDescription, detectService, detectBothServices,
  detectVisitCancellation, detectOfftopic, detectDefer, detectNegotiate,
  detectProvisionAsk, detectProvisionWho, detectEscalation, detectDocumentsAsk, detectMortgageAsk,
  detectNeighborhoodAsk, detectSchedulingFlex, detectComparison, detectFeatureAsk,
  detectDrugAlternative, detectInvestmentOpinion, detectWorkdaysQuestion, detectPostBookingAck,
  detectFeeWhy, isDistanceQuestion, detectNearestOfShown, detectCloseRemarkToBatch,
  detectMarketPriceAsk, detectMarketMemoryAsk,
  detectBusinessBudgetAsk,
  detectPriceEval, adviceLaneAdmits,
  detectNearbyAsk, detectSeenListingRecall, detectInventoryAsk, hasWhereWord,
  extractDistancePlaces, detectWhichAreaHas, detectPlaceOfferAsk, recallCarriesFigure,
  isGenuineQuestion,
  detectFeePaymentAgreement, detectArrangementRecall, detectToldYouNag,
  detectNumberUnknownRecall, detectSimilarAsk, detectBusiness, EB_NAMED_RE,
  isFeeTraffic, detectNearCenter, extractPoiWishCandidates, looksLikeScreenEcho,
  detectOwnClaimChallenge, detectSubjectPerM2Ask, detectAvailabilityAsk,
  detectFeeNag, detectFeeComplaint, detectFeeSurprise, detectAreaHaveAsk, extractSlots,
  detectFeeAmountAsk, detectFeeRules, detectFeeFirstTime, detectFeeChargePushback,
  detectVisitDayChoice, detectSetConfirmationAsk, detectComparisonRequest,
  detectFeeTotalCost, detectAgreement, detectVisitRequest, detectCheaperSearch, detectSeeOffers,
  detectVisitTimingQuestion, detectProceedAfterCheck, detectPriceFreshness,
  detectPriceAsk, detectRemark, detectSqmRate, detectProvisionResistance, detectBye,
  detectPriceChangeComplaint, detectRentTermsAsk, detectTotalCostAsk, extractRentMath,
  detectMoreOptions, detectSmallerPerM2Ask, detectBudget, fsmRequired,
  detectLocation, hasMarketTypePlural, isMarketRentWordAsk, detectMarketLevelFollowUp,
  detectExitCheck, detectSoftRefusal, detectWaitingAck, detectAgentAttendanceAsk,
  detectContactRequest, detectEyeCatch, detectPositiveEval, detectDescribeAsk,
  extractPriceExtremeQuery, detectPriceExtremeAsk, isFeeFrame,
  detectWidenIntent, detectExplicitWiden,
  detectMoreStockRequest, detectVisitTime, proposesVisitTerm, detectPomaloAsk,
  detectBudgetUpAsk, detectExplicitCancel,
  detectFeePerPropertyAsk, feeArithmeticCount, namesVisitAnchor,
  detectAgencyIdentityAsk, detectWhichPropertyAsk, detectPropertyChoice,
  detectBareEbFollowup, detectAvailabilityPlural, detectLocationNag,
  detectNegatedAgreement, detectRejection, detectVisitInterest,
  detectStockContradiction, detectStockAbsenceAsk, detectContactMechanicsChallenge, detectOwnerContactHold,
  detectRingNearestAsk, detectIdentifyByFigure,
  isAreaOfPlaceQuestion, extractAreaOfPlaceQuestion,
  isWhereLandmarkQuestion, extractWhereLandmarkPlace,
} from '../llm/deterministic';
import { detectInfoFacets } from '../llm/infoAnswer';
import { detectGlossaryAsk } from '../llm/glossary';
import { detectRecommendAsk, detectValueAsk } from '../llm/recommend';
import { arbitrateMoney, isFeeAmountClaim } from '../llm/moneyArbitration';
import { inferPropertyId } from '../llm/classify';
import { resolvePropertyFocus } from './focus';
import { unrankedStockAsk } from './priceScope';
import { BARE_REFUSAL_ONLY_RE, pickDescribed } from './locate-pick';
import type { ChatSession } from '../fsm/session';

/** The session memory a rule may consult. Slots are the ONLY state a lane reads
 *  beyond the FSM state, so the mirror sees them too (see RouteRule.fires). */
export type RouteSlots = ChatSession['slots'];
const NO_SLOTS = {} as RouteSlots;

/** THE EVIDENCE CHANNEL (Phase 4): the facts a lane's gate needs that are NOT in
 *  (text, state, slots) — a map hit, a feed row's own fields, the number of
 *  rankable per-м² rows. They are computed by the EXECUTOR's probe
 *  (`InboundHandler.probeRouteEvidence`) because the router must stay pure and
 *  testable without a database; every field is optional, so a caller that has
 *  no probe (a unit test, a cold harness) simply predicts one lane lower.
 *
 *  COST RULE: the probe is gated on the lane's own cheap wording test first, so
 *  a turn that cannot reach these lanes performs NO map or feed work. That is
 *  the property a blanket up-front evidence object cannot have. */
export interface RouteEvidence {
  /** POI_CONFIRM: the confirm block would build an answer (map hit that is not
   *  city-level, or a neighbourhood reading of the candidate). */
  poiConfirm?: boolean;
  /** DISTANCE_BATCH: at least TWO flats of the on-table batch measure against
   *  the named place (one `findPlace` hit each). */
  distanceBatch?: boolean;
  /** INFO_ASK_PAIR_IDENTITY: a message naming several Евидентен броеви, with no
   *  facet asked, where both named rows exist in the feed. */
  infoPairIdentity?: boolean;
  /** AVAILABILITY_PLURAL: an availability ask that NAMES the flats (the [16:11]
   *  capture: «ДАЛИ 84 И 82 СЕ УШТЕ НА ПРОДАЖБА ?»), where the set is the
   *  numbers he typed rather than the table — both named rows resolve in the
   *  feed. Without this the mirror could only see a table pair. */
  availabilityPair?: boolean;
  /** PRICE_AVG_NASELBA: the neighbourhood comparison's own gate holds — a
   *  cheapest ask naming «населба», no area named, buy, and a rankable per-м²
   *  pool in the feed. */
  priceAvgNaselba?: boolean;
  /** INFO_ASK_PAIR: a facet ask over the TWO flats on the table, both rows
   *  resolving in the feed (inbound.ts 7972). */
  infoPair?: boolean;
  /** INFO_ASK_FLOORS: the plain-floor pair variant (two rows, floor clause). */
  infoFloors?: boolean;
  /** ADDRESS_WHY: a bare why right after a landmark / privacy-protocol line
   *  (the agency-rules explanation owns it, not the options thread). */
  addressWhy?: boolean;
  /** NEARBY_THREAD: a bare «more?» right after a reply that NAMED a landmark. */
  nearbyThread?: boolean;
  /** PAIR_LOCATION / PAIR_OTHER_LOCATION: the pair (or «the other one») is the
   *  subject of a location turn — two flats on the table, a where-word/address
   *  noun or a landmark line just served. */
  pairAsk?: boolean;
  pairOtherAsk?: boolean;
  pairLocIntent?: boolean;
  /** CONTACT_AFTER_FEE: the fee line was the last thing said and this message
   *  carries a real name + phone for the flat already picked. */
  contactAfterFee?: boolean;
  /** LANDMARK_LADDER: the client cannot picture the anchor (the rotation's own
   *  index and anchors are in the slots; the last line says where they stand). */
  landmarkLadder?: boolean;
  /** GHOST_ANCHOR: the flat the turn would serve can no longer be confirmed in
   *  the feed (the executor's ghost guard). */
  ghostAnchor?: boolean;
  /** FEED_DOWN: the feed itself is unhealthy, so an unconfirmed EB is NOT a
   *  ghost — the honest not-found line names the EB and clears nothing. */
  feedDown?: boolean;
  /** PLACE_PIVOT: a pivot-shaped search («а нешто кај X?») whose place
   *  resolves, whose criteria are already in the slots and which is not the
   *  place the pair was ranked from. The probe carries the executor's whole
   *  gate, so the row is this fact alone. */
  placePivot?: boolean;
  /** SMALLER_PER_M2 / SMALLER_PER_M2_EMPTY: the size-down ladder's own PLAN
   *  for a rate-anchored ask — 'served' when a smaller row exists at or under
   *  the anchor's €/м², 'empty' when the feed has nothing smaller there. The
   *  plan is the executor's, so the two tags can never be guessed apart. */
  perM2Smaller?: 'served' | 'empty';
  /** GOLEM_SMALLER / GOLEM_SMALLER_EMPTY: the same plan for a bare TOO-BIG
   *  complaint (size ranks first, the rate is not a ceiling). */
  golemSmaller?: 'served' | 'empty';
  /** SLOT_TAKEN: the proposed hour is already on the day's books, so the free
   *  hours around it are named before any owner is asked. Needs the calendar. */
  slotTaken?: boolean;
  /** LOCATE_REJECT_PLACE: «не е таа» about the flat the chat bound, and that
   *  flat really stands at the place the chat locked — the hunt stays there. */
  locateRejectPlace?: boolean;
  /** MARKET_PRICE: the message names an AREA the FEED knows (a numbered
   *  sub-area or a feed-only neighbourhood such as «Маџар Маало»). The mirror
   *  has its own list of Skopje names; the feed's list is the executor's, so
   *  the scope test is delegated rather than approximated. */
  marketAreaScope?: boolean;
  /** PICK_DESCRIBED: a DETAIL mention («онаа со дворот») resolves to exactly
   *  ONE of the described rows. The arm needs those rows' own fields, so the
   *  mirror reads the verdict here instead of guessing the lane below. */
  pickByDetail?: number;
  /** RECOMMEND_ASK: the judgment has a CHOICE SET — a flat on the table, or an
   *  Евидентен број named anywhere in the chat that still resolves. Without one
   *  the executor falls through to the funnel, so the row must not claim the
   *  turn (the mention binder lives in the history). */
  recommendChoice?: boolean;
}

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
// inbound.ts VISIT_WINDOW_STATES — the states in which a day/shape answer IS
// the arrangement's traffic (lane 0-e). Copied, not imported: the mirror must
// not depend on the executor's module graph.
const VISIT_LIVE_STATES = ['visit_scheduling', 'owner_checking', 'time_confirm', 'pending', 'queued'];

/** A DEFINITE REFERENCE to the flat in play — «OD STANOT», «OD KUKJATA», «OD
 *  IМОТОТ». Its row lives in the session HISTORY, which the mirror never sees,
 *  so the words themselves are the only anchor evidence a row can read. */
const DISTANCE_FLAT_REF_RE = /(?:stan(?:ot|ov|ovi|ovite|bata|beniot)|kukj(?:ata|ava|ite)|imov(?:ot|ite)|станот|станов|станови|станб|куќ(?:ата|ава|ите)|имотот|имотите)/iu;

/** The executor's own `propertyOnTable` formula (inbound.ts 7030) — the money
 *  arbiter's evidence target. One copy, so the mirror's rows and the arbiter's
 *  evidence boundary can never disagree about what "on the table" means. */
function moneyPropertyOnTable(sl: RouteSlots): boolean {
  return !!(sl.propertyId || sl.interestedPropertyId || sl.lastPrice || sl.presentedIds?.length);
}

/** `classify.ts propertyOnTable` over the SLOT surface (the mirror never holds a
 *  full session): a shown card, a served batch, or an anchored flat. Rows that
 *  stand down on a property on the table read this — the executor reads the
 *  same four fields, so the two sides cannot disagree. */
function tableHasProperty(sl: RouteSlots): boolean {
  return sl.propertyId != null || sl.interestedPropertyId != null
    || (sl.presentedIds?.length ?? 0) > 0 || (sl.currentBatch?.length ?? 0) > 0;
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
  /** `ev` is the resolved EVIDENCE for the turn (see `RouteEvidence`); a row
   *  whose gate needs a map/feed fact reads it here and refuses itself when the
   *  caller supplied none. */
  fires: (text: string, state: string, slots: RouteSlots, ev?: RouteEvidence) => boolean;
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
  // THE PERSONAL LANE (inbound.ts 5022) — the client asking about LINA herself
  // (her name, her age, a compliment, her origin). Closed-class and
  // deterministic, served BEFORE the question gate so the age ask never reaches
  // the classifier and the dynamic generate+store door (which is how «Јас сум
  // дигитален асистент» got banked forever). The executor logs the KIND with the
  // tag (`PERSONAL:name`), so the registry row keys the base lane and
  // `laneForTag` resolves every kind to it. No row here meant the 2026-11-15 day
  // file reported four gaps a day on turns that were served exactly right.
  { intent: 'PERSONAL', note: 'her name / her age / a compliment / her origin — the closed-class persona lane, answered deterministically before any classifier or funnel lane',
    fires: t => detectPersonalAsk(t) !== undefined },
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
  // THE ANSWER TO HER OWN DAY QUESTION (inbound.ts lane 0-e, the [10:25]
  // V16K11 turn) — «ако може во ист ден би било супер» answers the
  // one-day/several question: the choice is stored and the TERM is asked.
  // STATE-GATED on the executor's own live-arrangement list (VISIT_WINDOW_STATES
  // in inbound.ts, copied here like the FEE_* lists above): in discovery the
  // same words name nothing, and the funnel keeps the turn.
  { intent: 'VISIT_DAY_CHOICE', note: 'the day/shape answer inside a live arrangement («во ист ден», «различни денови») — the choice is stored, the TERM is asked, and the day question is never asked twice; «супер» about the plan is never property.liked',
    fires: (t, s) => VISIT_LIVE_STATES.includes(s) && detectVisitDayChoice(t) !== undefined },
  // THE ACKNOWLEDGEMENT AFTER THE BOOKING (inbound.ts 8975) — a bare «tocno» /
  // «vo red» / «blagodaram» in `pending`. State-gated and a closed set of whole
  // messages, so nothing with a request in it can be predicted here; the
  // executor answers it from the booked record instead of letting the brain
  // re-promise an owner check that already happened.
  { intent: 'POST_BOOKING_ACK', note: 'bare acknowledgement once the visit is booked — the booked flat(s) and term are restated deterministically',
    fires: (t, s) => s === 'pending' && detectPostBookingAck(t) },
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
      // A RECALL IS NOT A SEARCH (the 2026-11-15 replay): «imavte eden lokal kaj
      // olimpiko … bese dali uste se prodava?» asks whether the listing he
      // REMEMBERS is still for sale. The executor's business block stands down
      // for that shape (same veto, inbound.ts 7014) so the recall lane owns it;
      // reading it as a pair-serve search reported a drift on every such turn.
      && !detectSeenListingRecall(t)
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
  // ── THE MAP LANES THAT ARE TEXT-ONLY (Phase 4, place family) ──────────────
  // Both were written down as "served only on a map hit" and that stopped being
  // true: each branch now has a MISS arm that answers honestly («тоа место го
  // немам во мојата евиденција» / the place-exists-but-far line), so the MAP
  // decides the WORDING, not whether the lane runs. The gate is the wording test
  // plus the vetoes the executor applies, exactly as written below.
  // ORDER: the executor reaches these at 5010/5049, BEFORE the каде lanes, so the
  // rows must precede WHERE_IS — a где-question about a PLACE she named is not
  // the property's landmark rotation.
  // The map service is constructed by every entry point (the TUI, the API and
  // the funnel tests all build a LandmarkService), so the MISS arm is the only
  // map outcome that can change the wording — not whether this lane runs. A
  // bare harness without the map is a harness fact, not a prediction the
  // appliance ever makes.
  { intent: 'AREA_OF_PLACE', note: '«ВО КОЈА НАСЕЛБА Е TC ЛЕПТОКАРИЈА» — the PLACE\'s own district from the map, never the card\'s landmark ([17:26] capture); a map miss is stated honestly rather than answered with some other location',
    fires: t => isAreaOfPlaceQuestion(t)
      && !detectAreaHaveAsk(t)
      && !detectPriceAsk(t) && !detectBudget(t)
      && !detectService(t) && !detectBothServices(t)
      && extractAreaOfPlaceQuestion(t) !== undefined },
  { intent: 'WHERE_LANDMARK', note: '«КАДЕ ТИ Е ТОА 26 ЈУЛИ TC?» — where a place SHE named is located: the honest distance/direction line from the map, the discussed flat stays anchored ([12:48] push-back)',
    fires: t => isWhereLandmarkQuestion(t)
      && !detectAreaHaveAsk(t)
      && !detectPriceAsk(t) && !detectBudget(t)
      && !detectService(t) && !detectBothServices(t)
      && extractWhereLandmarkPlace(t) !== undefined },
  // THE DEFERRAL IS TO A REAL WHERE-WORD, NOT TO EVERY whereIs HIT (the
  // 2026-11-15 replay): the executor's gate is `detectWhereIs && hasWhereWord`
  // — the where-is EXTENSION also fires on the address family without any каде
  // word («TOCNATA ULICA I BROJ», «KOJA MU E LOKACIJATA NA 89?»), and those
  // must ride the privacy ladder in EXACT_ADDRESS. A bare `!detectWhereIs`
  // here predicted WHERE_IS for five served EXACT_ADDRESS turns a day.
  { intent: 'EXACT_ADDRESS', note: 'explicit address demand WITHOUT a where-word enters the deterministic privacy ladder — same guard as the executor: !isKadeTocno and !(detectWhereIs && hasWhereWord), so каде-prefixed questions fall through',
    fires: (t) => detectExactAddressAsk(t) && !isKadeTocno(t)
      && !(detectWhereIs(t) && hasWhereWord(t)) },
  // THE PAIR'S LOCATION (the [22:51]/[22:52] capture): «на која адреса се
  // становиве?» / «а другиот?» on a batch of TWO — the executor serves one
  // location line per flat. Predicted from the slots alone (the batch IS the
  // pair), so no feed read is needed.
  { intent: 'PAIR_LOCATION', note: 'the whole pair as the subject of a location turn (inbound.ts — EXACT_ADDRESS_PAIR / PAIR_LOCATION). EVIDENCE: the pair wording + a two-flat batch',
    fires: (t, _s, sl, ev) => ev?.pairAsk === true && ev?.pairLocIntent === true },
  { intent: 'PAIR_OTHER_LOCATION', note: '«а другиот?» — the OTHER card of the pair, its own location line (inbound.ts — PAIR_OTHER_LOCATION). EVIDENCE: the definite-other wording + a two-flat batch',
    fires: (t, _s, sl, ev) => ev?.pairOtherAsk === true && ev?.pairLocIntent === true },
  { intent: 'OWNER_CONTACT', note: 'client leaves name/phone — captured before any other reply',
    fires: t => detectOwnerContact(t) },
  // A NEARBY ASK IS NOT A WHERE-IS (the 2026-11-15 replay): the executor's
  // nearby interceptor (inbound.ts 9095) runs BEFORE the where-is lane (9286),
  // and «kazi mi sto ima vo blizina poznato?» carries a where-word without
  // asking where anything is. Without the veto the mirror predicted WHERE_IS
  // for a turn the near-by read served.
  // …AND NO LONGER BEHIND THE QUESTION GATE (the [09:1x] capture): the executor
  // used to skip its nearby interceptor for a GENUINE question, so «a sto drugo
  // ima vo blizina» was served by WHERE_IS — and «sto ima vo negova blizina
  // drugo?» fell past both and into the funnel, which served a flat. The
  // interceptor is now ungated (a location question about the flat on the table
  // is deterministic, like the where-is lane), so a nearby ask ALWAYS keeps its
  // own lane here too. Same rule, both readers.
  { intent: 'WHERE_IS', note: 'any каде-question → landmark rotation. Beats EXACT_ADDRESS by the guard above and beats description routing below; a NEARBY ask keeps its own lane (the executor intercepts it first, ahead of the where-is lane)',
    fires: t => !!detectWhereIs(t) && !detectNearbyAsk(t) },
  { intent: 'DISTANCE_BATCH', note: 'the same ask with SEVERAL flats on the table — one measured line per flat, nearest first (the [11:28] capture: two cards were served and only one flat\'s number came back). EVIDENCE: at least two rows of the batch measure against the named place',
    fires: (t, s, sl, ev) => ev?.distanceBatch === true },
  // THE TARGET MUST BE A PLACE (the 2026-11-15 replay): «kolku e daleku od
  // stanot?» names the FLAT, not a destination — the executor finds no place,
  // no map hit and falls through to the near-by read. Same extractor the
  // executor calls, so the row is the block's own text gate, not a re-derivation.
  { intent: 'DISTANCE', note: '"KOLKU IMA OD STANOT DO BUNJAKOVEC TRGOVSKI?" ([22:25]) — how far the discussed property is from a place the client names (a real destination in the message, `extractDistancePlaces`). Sits after WHERE_IS (каде owns those), and BEFORE every funnel branch: the classifier read „STANOT“ as PROPERTY_ID_REQUESTED and answered a distance question with the property card',
    // THE MEASURED FLAT IS THE GATE (the 2026-11-14 replay: «kolku se
    // razdaleceni od katolicka ?» predicted DISTANCE, served PRICE_ASK). The
    // executor measures FROM `anchorProp` — the flat this message NAMES, else the
    // one on the table, else an EB from the history — and a turn with no anchor
    // at all has nothing to measure, so the block falls through and the price
    // lanes answer. The row carries the SAME anchor list: the flat on the table
    // (visible in the slots), an EB in the message (the executor's own
    // `inferPropertyId` over the words OUTSIDE the place phrase — a place carries
    // numbers of its own: «TЦ 26 Jули»), or a definite reference to the flat in
    // play («STANOT», «KUKJATA»), whose row lives in the history the mirror
    // cannot see. `DISTANCE_FLAT_REF_RE` enumerates the inflections on purpose:
    // the bare stem «стан» also opens «станица» (the station), which is a PLACE.
    fires: (t, _s, sl) => {
      if (!isDistanceQuestion(t)) return false;
      const places = extractDistancePlaces(t);
      if (places.length === 0) return false;
      if (sl.propertyId != null || sl.interestedPropertyId != null
        || (sl.presentedIds?.length ?? 0) > 0) return true;
      const i = t.toLowerCase().indexOf(places[0].toLowerCase());
      const rest = i >= 0 ? `${t.slice(0, i)} ${t.slice(i + places[0].length)}` : t;
      return inferPropertyId(rest) != null || DISTANCE_FLAT_REF_RE.test(t);
    } },
  { intent: 'NEAREST_OF_SHOWN', note: '«KOJ E NAJBLISKU DO KAFICOT?» ([22:03]) — which of the flats ALREADY OFFERED is nearest to the place the client names. Sits after WHERE_IS/DISTANCE (which own their questions) and before the funnel branches: the location-nag lane answered it with the last flat\'s nearby landmark, because «најблиску» contains «блиску»',
    fires: t => detectNearestOfShown(t) },

  { intent: 'NEAREST_OF_BATCH', note: '«OVA BESE BLISKU» ([20:17]) — a DEICTIC closeness remark about the batch just listed. No interrogative and no place of its own, so it sits AFTER NEAREST_OF_SHOWN (which owns the explicit «koj e najblisku do …» ranking) and BEFORE the funnel: the classifier read it as a description of an unknown listing and asked which neighbourhood/price it was',
    fires: t => detectCloseRemarkToBatch(t) },
  { intent: 'TOLD_YOU_RECALL', note: '«ПА ТИ КАЖАВ КАДЕ» ([23:48]) — the client says he already gave the criteria, so the turn reads the notebook back (places + area) and asks only what is missing. The executor runs it in the funnel states, after OWNER_CONTACT/PROXY_CONTACT (a contact capture inside the complaint keeps its lane) and before the where-is/location-nag branches, which is exactly where this row sits; its other two conditions are mirrored too — NO property on the table (a shown flat makes «ти кажав» a where-is/visit topic) and no digit in the message (a figure IS a criterion)',
    // …BUT A BOOKING RECALL IS NOT THE NOTEBOOK: «ЗА КОЈ СТАН ТИ КАЖАВ ДА
    // ДОГОВОРИШ ПРЕЕСКА?» carries «ти кажав» and reads as the told-you nag, while
    // the executor serves VISIT_RECALL (6516) long before the funnel lane (7518).
    // The mirror has to refuse it here, or it predicts a lane that never runs.
    fires: (t, s, sl) => detectToldYouNag(t) && !detectArrangementRecall(t)
      && ['idle', 'discovery'].includes(s)
      // THE EXECUTOR'S OTHER TWO CONDITIONS ARE SLOTS AND TEXT (inbound.ts
      // 9051): a property on the table makes «ти кажав» a where-is/visit topic,
      // and a DIGIT in the message IS a criterion answer (the [23:5x] widen
      // flow), so the funnel keeps that turn. Without them the mirror predicted
      // this lane and the executor served something else.
      && !/\d/u.test(t) && !tableHasProperty(sl) },
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
    fires: (t, s, sl, ev) => {
      const asked = detectMarketPriceAsk(t)
        || (detectMarketLevelFollowUp(t) && !!(sl.poiAnchor || sl.location));
      if (!asked) return false;
      if (detectBothServices(t) || inferPropertyId(t) !== undefined) return false;
      const cityAsk = /(?<![\p{L}\p{N}])(?:скопје|skopje|скопју|skopju)(?![\p{L}\p{N}])/iu.test(t);
      // The mirror's own list of Skopje neighbourhoods (`detectLocation`,
      // Latin transliteration included) covers the common wording; an area only
      // the FEED knows («Маџар Маало», «Карпош III» from a numbered ask) comes
      // from the EVIDENCE channel — the probe asks `areaNamed`, the same feed
      // read the executor makes, so the scope test is one fact with two
      // readers instead of an approximation.
      const areaInMessage = cityAsk || detectLocation(t, []) !== undefined
        || ev?.marketAreaScope === true;
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
  // THE PIVOT OUTRANKS THE NEARBY READ (2026-11-15): «A NESTO OKOLU DAJMOND
  // MOL» carries the nearby grammar («нешто … околу X»), but the executor's
  // pivot block runs BEFORE its nearby interceptor, so the confirm question is
  // what the client actually gets. Reading NEARBY_ASK here predicted a lane the
  // executor never ran — and now that the pivot BRANCH reads the router's answer
  // the misprediction also silenced the correct reply (the anchored batch was
  // served with no confirm). Order is the executor's order.
  { intent: 'PLACE_PIVOT', note: 'a pivot-shaped search («а нешто кај X?») — the criteria stand, ONE question confirms them, and the agreement serves the pair nearest the new place; never a location confirmation about the flat on the table ([18:51] capture). The place lock is the evidence',
    fires: (t, s, sl, ev) => ev?.placePivot === true },
  { intent: 'NEARBY_ASK', note: 'what else is around the discussed/named building («sto ima vo blizina na …?») — the executor intercepts it before every funnel branch, so it must beat PROPERTY_DESCRIPTION here too',
    fires: t => detectNearbyAsk(t) },
  // …AND THE REMEMBERED-PROPERTY BLOCK OUTRANKS IT WHERE THE EXECUTOR SAYS SO
  // (the 2026-11-15 replay): the block at inbound.ts 9516 runs BEFORE the recall
  // serve and keeps a LANDMARK-ANCHORED recall that carries NO figure — «имавте
  // една гарсоњера кај Црногорска амбасада» is answered by the guided place
  // serve (PROPERTY_DESCRIPTION), exactly as the [11:29] cold pin says. The
  // three facts are the same three the executor reads: a description-shaped or
  // place-offer message, a landmark anchor (кај/до/близу) and no figure of its
  // own. A FIGURE-carrying recall («…околу 30 000 евра беше») keeps this lane.
  // A RECALL THAT NAMES ITS OWN PRICE **AND** SIZE IS THE LOCATE FUNNEL'S (the
  // [madjari] money-anchor gate, inbound.ts 9849): with both figures in hand the
  // funnel can rank the pool by room count AND price, and the recall block
  // declines it — «имавте еден стан во Маџар Маало со две спални, цена околу
  // 180 000, дали уште се продава?» was predicted SEEN_LISTING_RECALL while the
  // funnel re-rank (tagged PROPERTY_DESCRIPTION) served it. One fact, read by
  // both rows below.
  { intent: 'SEEN_LISTING_RECALL', note: 'a RECALLED listing («imavte edna kukja nakaj … okolu 130 000 bese») — past-tense had + determiner + property noun; the archive ack owns it, never the criteria funnel or a surroundings read. Stands down for the landmark-anchored, figure-less recall the remembered-property block serves, in the executor\'s own order',
    fires: (t, s, sl) => detectSeenListingRecall(t)
      && !((detectPropertyDescription(t) || detectPlaceOfferAsk(t))
        && isLandmarkAnchored(t) && !recallCarriesFigure(t) && !sl.service)
      && !pricedSizedRecall(t) },
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
  // THE PER-PROPERTY FEE ARITHMETIC (inbound.ts 7400, the [23:44]/[23:45] capture)
  // — «500 DEN PO STAN?» and the visit count «АКО ПОСЕТАМ 3 ?». The registry row
  // sat as P(...) ("pending migration") for weeks, so every correct arithmetic
  // turn re-reported as a route GAP: `predicted=FALLTHROUGH actual=
  // FEE_PER_PROPERTY:fast` is what the field logs are full of. A pending row is
  // a visible backlog entry, not a fix — the lane had a predicate and no
  // precedence story, which is what this row supplies.
  // ORDER: BEFORE FEE_PUSH, exactly as the executor orders them (the arithmetic
  // serve at 7477 precedes the nag leg at 7584). The detector vetoes resistance
  // itself, so a nag cannot be predicted here — except the burst that rides its
  // own arithmetic («…TOA SE 1000 ZA GLEDANJE SAMO»), which the executor serves
  // as FEE_PER_PROPERTY + one rung, and the mirror must say the same.
  { intent: 'FEE_PER_PROPERTY', note: 'the fee\'s own ARITHMETIC — per property («500 DEN PO STAN?», «ZA SEKOJ STAN STO KE SE POSETI PO 500 ?») and the sum for N visits («АКО ПОСЕТАМ 3 ?», «dvata → 1.000»). It sits after FEE_AMOUNT_ASK (the disclosure asks what the fee IS, not what N of them cost) and before FEE_PUSH, mirroring the executor\'s own line order (inbound.ts 7400 → 7584). SLOT-AWARE in the count arm: a count is arithmetic only while the FEE IS ON THE TABLE (disclosed, agreed, a rung burned, or closing/contact) AND the burst names the visit act — «koja e podobra vrednost megu dvete ?» is a value comparison and keeps its lane (§4s-ter)',
    fires: (t, s, sl) => {
      const count = feeArithmeticCount(t);
      // The executor's own `feeOnTable` (inbound.ts 7425): the disclosure memory
      // is cleared by the turn that serves it, so the agreement, a burned rung
      // and the post-decision states count as "on the table" too.
      const feeOnTable = sl.feeDisclosed === true || sl.viewingFeeAgreed === true
        || (sl.feeRejections ?? 0) > 0
        || s === 'closing' || s === 'contact_collection';
      const countAsk = count !== undefined && feeOnTable
        && /\?|(?:^|[^\p{L}])(?:ако|ako)(?![\p{L}])/iu.test(t)
        && namesVisitAnchor(t)
        && !detectFeeNag(t)
        && !detectFeePaymentAgreement(t);
      // A COUNT SURVIVES AN AGREED FEE (the [10:03] capture: the total for two
      // visits was never stated); the plain per-property ask does not — with the
      // fee agreed, a rate question is a term re-ask, not new arithmetic.
      return (detectFeePerPropertyAsk(t) || countAsk)
        && (!sl.viewingFeeAgreed || count !== undefined);
    } },
  // ── THE PENDING BACKLOG, PROMOTED (2026-11-15) ────────────────────────────
  // 33 rows were still `P(...)`, i.e. every correct turn of those lanes logged
  // a GAP. Each row below carries its executor's OWN gate and sits where the
  // executor runs it (inbound.ts line numbers in the note). The lanes that
  // need CONVERSATION EVIDENCE the mirror does not yet receive (the last
  // assistant line for ADDRESS_WHY/NEARBY_THREAD, the day calendar for
  // SLOT_TAKEN, the map for PLACE_PIVOT/PLACE_RING_ROW, the landmark ladder
  // index) stay pending on purpose — a row invented ahead of its evidence
  // would predict a lane the executor never runs, which is a DRIFT, a worse
  // signal than the gap.
  // THE LAST-REPLY / ROTATION LANES, predicted on the EVIDENCE channel: each
  // one's gate is "what did she just say?" — which is a fact the probe reads
  // from the session and the mirror cannot invent. Their executor positions
  // are inbound.ts 8801 (address-why), 8838 (nearby thread) and 5062 (the
  // landmark ladder).
  // THE GHOST GUARD (inbound.ts 10664) sits INSIDE the enthusiasm lane and
  // must be predicted BEFORE it, or a correct not-found turn reads as an
  // ENTHUSIASM drift. The probe supplies the fact (one EB read, gated on the
  // enthusiasm wording), and a broken feed is never a ghost.
  { intent: 'GHOST', note: 'the flat the turn would praise is no longer in the feed (inbound.ts 10664) — the not-found pivot names the EB and clears the anchors. EVIDENCE: `ghostAnchor` with a healthy feed',
    fires: (t, s, sl, ev) => ev?.ghostAnchor === true && ev?.feedDown !== true },
  { intent: 'FEEDDOWN', note: 'the same guard with a BROKEN feed (inbound.ts 10675) — the EB is unconfirmed, not gone: the honest feed-unavailable line, no ghost branding. EVIDENCE: `ghostAnchor` + `feedDown`',
    fires: (t, s, sl, ev) => ev?.ghostAnchor === true && ev?.feedDown === true },
  { intent: 'ADDRESS_WHY', note: 'a bare why after a privacy / landmark line — the agency-rules explanation (inbound.ts 8801). EVIDENCE: `addressWhy` (the bare-why detector AND a nearby-shaped last reply)',
    fires: (t, s, sl, ev) => ev?.addressWhy === true },
  { intent: 'NEARBY_THREAD', note: 'a bare «more?» after a reply that NAMED a landmark — the nearby thread continues into rotation → protocol → shut-down (inbound.ts 8838). EVIDENCE: `nearbyThread`; the branch that depends on the classifier verdict is deliberately unpredicted',
    fires: (t, s, sl, ev) => ev?.nearbyThread === true },
  { intent: 'LANDMARK_LADDER', note: '«kade ima reptil tamu?» / «ne znam toa» after an anchor was named — the NEXT landmark, then the third, then the clear-enough close (inbound.ts 5062). EVIDENCE: `landmarkLadder` (the slots carry the rotation index and the anchors; the last line carries what was said)',
    fires: (t, s, sl, ev) => ev?.landmarkLadder === true },
  { intent: 'CONTACT_AFTER_FEE', note: 'the fee question answered with a NAME + PHONE (inbound.ts 10275) — consent, so the visit protocol starts and the picked flat stays picked. EVIDENCE: `contactAfterFee` (state + the last line + a valid phone and a plausible name)',
    fires: (t, s, sl, ev) => ev?.contactAfterFee === true },
  { intent: 'CONTACT_MECHANICS', note: 'the competence challenge «KAKO KE GO KONTAKTIRAS AKO NE ZNAES KOJ BROJ E?» (inbound.ts 7140) — the EB she holds + the mechanism, never the DEFER line. The fee legs are vetoed exactly as the executor vetoes them (a fee question is not a doubt about the owner contact)',
    fires: t => detectContactMechanicsChallenge(t)
      && !detectFeeWhy(t) && !detectFeeNag(t) && !detectFeeComplaint(t)
      && !detectProvisionAsk(t) && !detectProvisionWho(t) },
  // THE CRITERIA ARE THE EXECUTOR'S GATE (the 2026-11-15 replay): the block at
  // inbound.ts 5490 only serves when the session HOLDS something to search
  // with, and a cold «а во која населба има?» is the neighbourhood-advice lane
  // instead. The mirror read the bare detector, so it predicted this lane for
  // a turn the advice row served.
  { intent: 'AREA_HAVE_SEARCH', note: '«а во која населба има?» (inbound.ts 5490) — the criteria are released and the pair is served with the neighbourhoods that hold it. SLOT-AWARE: the executor needs a criterion in the notebook (service, rooms, budget or a type), so the mirror reads the same memory and a cold ask keeps its own lane. Fee traffic is a money question, not a stock question',
    fires: (t, s, sl) => detectWhichAreaHas(t) && !isFeeTraffic(t)
      && (!!sl.service || sl.bedrooms !== undefined
        || sl.bedroomsMin !== undefined || sl.bedroomsMax !== undefined
        || sl.budget !== undefined || sl.garsonjera === true
        || sl.house === true || sl.plac === true || sl.business === true) },
  { intent: 'DISTANCE_MATRIX', note: 'several places × every flat on the table («kolku e daleku od X i od Y ?», inbound.ts 5470) — one measured line per place and flat. EVIDENCE: the executor only serves when at least TWO flats of the batch actually measure against a named place, which is the probe\'s `distanceBatch` (the mirror cannot reach the map)',
    fires: (t, s, sl, ev) => ev?.distanceBatch === true },
  { intent: 'OWNER_HOLD', note: '«NE GO KONTAKTIRAJ USTE» / «NE SME SE DOGOVORILE» (inbound.ts 10460) — acknowledge and DO NOT proceed, and never on a funnel message (a search entry keeps the funnel). Tagged `OWNER_HOLD:fast` by the executor',
    fires: t => detectOwnerContactHold(t) && !fsmRequired(t) },
  { intent: 'AGENCY_IDENTITY', note: '«КОЈА АГЕНЦИЈА СТЕ ВИЕ?» mid ping-pong (inbound.ts 4820) — the agency is named, then the interrupted question repeated. It runs BEFORE the money region, so it sits above every fee row here',
    fires: t => detectAgencyIdentityAsk(t) },
  { intent: 'STOCK_ABSENCE_ASK', note: 'the client asks WHETHER a type exists at all («stance nema?», «има ли стан во Центар?», inbound.ts 9090) — the stock truth under his own criteria and never the visit fee: the V16K11 turn read it as a pick and quoted a viewing. Fee traffic is a money question, not a stock one',
    fires: (t, s, sl) => detectStockAbsenceAsk(t) && !isFeeTraffic(t)
      && !sl.areaExhausted
      && ['presentation', 'closing', 'discovery', 'property_query'].includes(s) },
  { intent: 'STOCK_CONTRADICTION', note: 'the client quotes a card we served against a «нема» we said («PA KAKO NEMA … KOGA OVOJ E EDEN OD NIV?», inbound.ts 7267) — admission + the row\'s own facts, and without a card the apology plus the ask for the Евидентен број (never the geography reader). It beats every geography lane because it carries an area word',
    fires: t => detectStockContradiction(t) },
  { intent: 'WHICH_PROPERTY', note: '«ZA KOJ STAN STANUVA ZBOR?» — the flat the chat has in hand, named by EB + neighbourhood + price, and with nothing bound the honest «which Евидентен број?» line (bank key property.which.none) (inbound.ts 7449). Gate copied: not while the fee is agreed and never in queued/terminated/escalated (there the account is over, not a pick to identify)',
    fires: (t, s, sl) => !sl.viewingFeeAgreed
      && !['queued', 'terminated', 'escalated'].includes(s)
      && detectWhichPropertyAsk(t) && !detectPropertyChoice(t) },
  { intent: 'PROPERTY_CHOICE', note: 'the pick among flats that were PRESENTED («E OVOJ MOZE», inbound.ts 7184) — the fee is disclosed first, and in CLOSING the fee lanes own the turn. A fee-sized amount disqualifies the choice reading (detectPropertyChoice carries that rule), so the mirrors cannot disagree about a fee question',
    fires: (t, s, sl) => !sl.viewingFeeAgreed
      && !['queued', 'terminated', 'escalated', 'closing'].includes(s)
      && !detectWhichPropertyAsk(t) && detectPropertyChoice(t) },
  { intent: 'MONEY_CLARIFY', note: 'a money word with NO target (inbound.ts 7530) — predicted through the money arbiter itself (lane === \'clarify\'), the same decision the executor reads: object unresolved + protocol states + nothing on the table + no agreed fee. The «не и го памтам бројот, ама … добра цена» recall is vetoed exactly as the executor vetoes it',
    fires: (t, s, sl) => !detectNumberUnknownRecall(t)
      && arbitrateMoney(t, {
        state: s,
        propertyOnTable: moneyPropertyOnTable(sl),
        feeAgreed: !!sl.viewingFeeAgreed,
        feeTold: !!sl.feeDisclosed || (sl.feeRejections ?? 0) > 0,
        feeBlocked: false, provisionBlocked: false,
      }).lane === 'clarify' },
  { intent: 'LOCATION_NAG', note: 'a location question refused again (inbound.ts 8578) — the nag answer, with the executor\'s own vetoes: a FUNNEL entry that names a place is a search, not a nag (no property on the table), and a location confirm / a каде question keep their lanes',
    fires: (t, s, sl) => detectLocationNag(t)
      && !(!moneyPropertyOnTable(sl) && fsmRequired(t))
      && !detectWhereIs(t) },
  { intent: 'BARE_EB_FOLLOWUP', note: 'a bare Евидентен број follow-up («А 42?») about a flat this chat SHOWED (inbound.ts 9750) — the availability ack for THAT row, never a fresh search. Gate copied whole: the EB must be in the shown set, the fee must not be agreed, and fee traffic keeps its own lanes',
    fires: (t, s, sl) => {
      const eb = detectBareEbFollowup(t);
      if (eb === undefined || sl.viewingFeeAgreed || isFeeTraffic(t)) return false;
      return new Set([...(sl.currentBatch ?? []), ...(sl.presentedIds ?? [])]).has(eb);
    } },
  { intent: 'AVAILABILITY_PLURAL', note: 'an availability ask over SEVERAL flats («se slobodni ?», «dvata ?», «дали 84 и 82 се уште на продажба ?» — the set is the table OR the numbers he named, inbound.ts 11172) — the ack for the set plus the owner confirm. The executor\'s veto list is copied (fee legs, a named EB, a bedroom count, an inventory/area ask, an agreed fee): each of those owns its own lane, and a NAMED PAIR stands those three down (its numbers ARE its subject)',
    fires: (t, s, sl, ev) => {
      const ebs = new Set([...(sl.currentBatch ?? []), ...(sl.presentedIds ?? [])]);
      // THE NUMBERS HE TYPED ARE THE SET (the [16:11] capture): the table held
      // neither flat, so only the evidence probe can see the pair — the executor
      // resolves the very same rows before it serves.
      const byNumber = ev?.availabilityPair === true;
      // AN ASK FOR OTHER STOCK IS NOT AN AVAILABILITY ASK (defect #3 of the
      // [05:20] capture): «освен овие … дали имате други?» carries «овие …
      // имате», which this row read as the plural availability question. The
      // stock lane owns that sentence, and this row must not claim it — the
      // executor leg carries the same veto (inbound.ts).
      return (ebs.size >= 2 || byNumber) && !detectMoreStockRequest(t) && detectAvailabilityPlural(t)
        && !detectFeeWhy(t) && !detectFeeNag(t) && !detectFeeComplaint(t)
        && !detectFeeSurprise(t) && !detectProvisionAsk(t) && !detectProvisionWho(t)
        && !isFeeTraffic(t)
        && (byNumber || inferPropertyId(t) === undefined)
        && (byNumber || extractSlots(t).bedrooms === undefined)
        && !detectInventoryAsk(t) && !detectAreaHaveAsk(t)
        && !sl.viewingFeeAgreed;
    } },
  { intent: 'REMARK', note: 'a generic remark (inbound.ts 10699 bank / 10722 deterministic) — acknowledged and moved on, never a fee lane and never a search. One intent for both tags: `REMARK:bank` and `REMARK:fast` are the same lane with different wording sources',
    fires: t => detectRemark(t) },
  { intent: 'INVESTMENT_OPINION', note: 'an investment-advice ask (inbound.ts 11041, the fast leg) — the honest «investment is a judgement, here is what the figures say» answer, never a price promise. The PRICE-EXTREME serve (6455) runs long before this leg, so a «koja e najvisokata cena vo aerodrom?» is the price lane: the mirror must refuse it here or it reports a drift on a correct serve',
    fires: t => detectInvestmentOpinion(t) && !detectPriceExtremeAsk(t) },
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
  // ── A «ДА» THAT HAS ITS OWN REFERENT (the [05:58] capture) ────────────────
  // SHE ASKED A QUESTION, SO THE YES ANSWERS IT. The rate answer («колку му е
  // цената по квадрат?») ended with «Дали сакате да го споредам со останатите
  // понуди во истата населба?»; «DA MOZE» came back and the drained-pool escape
  // read it as visit consent (name + phone, no fee disclosed, no comparison).
  // The promise lives in `slots.pendingOffer` for exactly ONE reply, so the
  // mirror needs nothing but slots + text — and it sits BEFORE the agreement
  // lane because the executor's lane does: a yes with a referent is never a
  // fee agreement.
  { intent: 'RATE_COMPARE', note: 'the «да» that answers OUR OWN comparison offer (inbound.ts 8621): the subject\'s €/m² against the same category in the same area, never contact collection. The promise is `slots.pendingOffer` (one reply); money traffic, a visit request, a place question and a cheaper search keep their own lanes',
    fires: (t, s, sl) => sl.pendingOffer?.kind === 'compare'
      && detectAgreement(t)
      && !detectNegatedAgreement(t) && !detectRejection(t) && !detectSoftRefusal(t)
      && !detectVisitRequest(t) && !detectVisitInterest(t)
      && !isFeeTraffic(t) && !detectFeeNag(t) && !detectProvisionResistance(t)
      && !detectCheaperSearch(t) && !detectWhereIs(t) && !detectExactAddressAsk(t) },
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
  // THE FEED FACT IS ANSWERED IN-LANE: the executor used to serve only when the
  // EB resolved WITH a price, so a row with no stored figure (or one the offer
  // no longer holds) was predicted here and served by some later lane. The
  // branch now owns all three legs — the quote, «немам внесено цена» + owner
  // check, and «веќе не е во понудата» — so the mirror's prediction is true.
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
  // HER OWN LAST LINE IS A SLOT TOO: the executor also accepts `lastQuotedEb`
  // (the price-quote shape of her previous answer) and the elliptical floor
  // follow-up («POSLEDEN ?», a top-floor ask only after a line that named a
  // кат). Both used to live in `history` alone, which the mirror cannot read;
  // `pushHistory` now records them as `slots.lastQuotedEb` /
  // `slots.lastReplyNamedFloor` (fsm/session.ts `rememberAssistantLine`), so
  // the rows below read the SAME memory the executor reads. The facet parse
  // takes the floor context from the slot exactly as the executor does.
  // ── YEAR/RENOVATION WITH NOTHING BOUND (Phase 4, describe family) ─────────
  // The executor answers a year/renovation ask about a BOUND flat under
  // INFO_ASK, but with NO flat it cannot look the fact up and serves the
  // property-agnostic miss line under its OWN tag (inbound.ts 8040–8049). The
  // mirror had no row for that tag, so a cold «од која година е зградата?»
  // predicted INFO_ASK and the registry recorded a GAP on a correct serve.
  // Position: INSIDE the info block and before it — the executor's miss branch
  // runs after the same facet parse, with the same vetoes.
  // A STALE SLOT IS ANSWERED, NOT DROPPED: the executor's `infoProp` comes from
  // the feed, so a slot naming a row the feed no longer has used to fall out of
  // the block entirely — predicted INFO_ASK, served by some later lane. The
  // block now owns that turn with the honest «таа недвижност повеќе не е во
  // понудата» line, which is what makes this row's prediction true.
  { intent: 'INFO_ASK_YEAR', note: 'year-of-construction / renovation ask with NO flat bound — the property-agnostic missing-fact line (inbound.ts 8040–8049), never the LLM',
    fires: (t, s, sl) => {
      const facets = detectInfoFacets(t, { floorOnTable: sl.lastReplyNamedFloor === true });
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
  // ── THE LOCATE FUNNEL (Phase 4, locate family) ────────────────────────────
  // These three read the HUNT'S OWN MEMORY (`describedEbs`) and the executor's
  // text gates IMPORTED FROM ./locate-pick — one copy, so the mirror cannot
  // drift from the funnel. Position: immediately after DESCRIBE_TABLE and in
  // the executor's own order (pick 9489 → widen 9813 → bare refusal 9790); a
  // facet ask over a described flat was claimed by INFO_ASK above.
  { intent: 'PICK_DESCRIBED', note: 'a pick among the flats she just described — by Евидентен број or ordinal, or by one of their DETAILS («онаа со дворот») — answered with the availability answer (inbound.ts 10055). EVIDENCE: a detail mention resolves to exactly one described row',
    fires: (t, s, sl, ev) => {
      if ((sl.describedEbs?.length ?? 0) === 0) return false;
      // A FACET ASK IS THE INFO BLOCK'S WHEN IT CAN BIND A FLAT: the executor
      // reaches that block at 8380, long before the pick at 10055, so
      // «КОЛКУ Е 78 ?» while a described pair is in memory is a fact question,
      // not a pick (it was reported as a PICK_DESCRIBED→INFO_ASK drift). With
      // NOTHING to bind, the info block falls through and the pick owns the
      // turn even when the text carries a feature word.
      const facetAsk = detectInfoFacets(t, { floorOnTable: sl.lastReplyNamedFloor === true });
      const infoBinds = sl.propertyId != null || sl.interestedPropertyId != null
        || (sl.presentedIds?.length ?? 0) > 0 || sl.lastQuotedEb !== undefined
        || inferPropertyId(t) !== undefined;
      if (facetAsk && infoBinds) return false;
      return pickDescribed(t, sl.describedEbs!) !== undefined
        || ev?.pickByDetail !== undefined;
    } },
  { intent: 'LOCATE_WIDEN', note: '«да» to the other-neighbourhoods question — the area lock is released and the same hunt continues (inbound.ts 9813). Requires the whole exhausted-hunt state (describedEbs + areaExhausted), never a plain agreement',
    fires: (t, s, sl) => (sl.describedEbs?.length ?? 0) > 0
      && sl.areaExhausted === true
      && (detectAgreement(t) || detectWidenIntent(t) || detectExplicitWiden(t)) },
  // «ШТО УШТЕ ИМАТЕ ?» / «САКАМ ДА ВИДАМ УШТЕ» — the next UNSHOWN pair, never a
  // re-serve, never the booking protocol (inbound.ts 9524). The gate is ELEVEN
  // vetoes plus a criteria parse, and every one of them is text/slot state, so
  // the row is the executor's own conjunction — which is what let the branch
  // below it flip to `routedLane()`.
  // The «да видам» trap is the reason the visit vetoes are spelled out here: a
  // field message («НЕ СЕ ЛОШИ АМА САКАМ ДА ВИДАМ УШТЕ АКО ИМАТЕ») carries the
  // VISIT verb, and a blanket visit veto sent it to the booking lane.
  // Position: after the describe/locate rows (the executor reaches this block at
  // 9524, after them) and before the availability/bye lanes.
  // ── THE EVIDENCE-ONLY CLUSTER (2026-11-15, the last five pending lanes) ──
  // Each of these needs one fact the router cannot compute — a resolved place,
  // the day calendar, the size-down ladder's own pool — so the PROBE carries
  // the executor's WHOLE gate and the row is that one fact. No text is
  // re-tested here on purpose: a second copy of a conjunction is how the two
  // sides start disagreeing.
  { intent: 'SMALLER_PER_M2', note: 'the €/м²-anchored size-down ask («pomalo so takva cena za kvadrat») — a smaller row at or under the anchor\'s rate, same area first. EVIDENCE: the ladder\'s own plan found a row',
    fires: (t, s, sl, ev) => ev?.perM2Smaller === 'served' },
  { intent: 'SMALLER_PER_M2_EMPTY', note: 'the same ask with nothing smaller at or under the rate — the honest line plus the register step (never the same flat re-rendered)',
    fires: (t, s, sl, ev) => ev?.perM2Smaller === 'empty' },
  { intent: 'GOLEM_SMALLER', note: 'a bare TOO-BIG complaint («golem mi e nekako») — the size-down ladder anchored on SIZE, the closest smaller м² first',
    fires: (t, s, sl, ev) => ev?.golemSmaller === 'served' },
  { intent: 'GOLEM_SMALLER_EMPTY', note: 'the same complaint with nothing smaller in the feed — the honest empty line, never a bigger row'
    , fires: (t, s, sl, ev) => ev?.golemSmaller === 'empty' },
  { intent: 'SLOT_TAKEN', note: 'a proposed visit hour already taken in the day calendar — the free hours of that day are named before any owner is asked. EVIDENCE: the calendar read',
    fires: (t, s, sl, ev) => ev?.slotTaken === true },
  { intent: 'LOCATE_REJECT_PLACE', note: '«не е таа» after the only flat at a NAMED place — the place lock holds and the next options come from THERE; other areas only after the ask ([10:36] capture). EVIDENCE: the rejected row stands at the locked place',
    fires: (t, s, sl, ev) => ev?.locateRejectPlace === true },
  { intent: 'MORE_STOCK', note: 'a stock ask after a pair was served — the NEXT unshown pair from the same search, or the honest drained line; never the availability table, never the booking protocol, never a repeat of a flat already served ([12:41] capture)',
    fires: (t, s, sl) => detectMoreStockRequest(t)
      && (sl.presentedIds?.length ?? 0) > 0
      // AN EITHER-OR BUDGET HAS ITS OWN DRAIN (the [20:08] capture): «еден до
      // 80.000 или два до 140.000» leaves `countBudget` in the notebook, and the
      // drain of that plan states BOTH caps and offers the pricier pair, a
      // neighbouring area and a criteria change (the FSM lane at inbound.ts
      // 12930, which arms `moreChoicePending`). The next-pair serve knows
      // nothing about the two counts, so it re-served pairs until the pool ran
      // out — «DRUGO NESTO IMA , OSVEN OVIE DVA ?» heard «немаме други понуди»
      // instead of the pair he was told exists. (This row used to be shadowed
      // by the loose AREA_HAVE_SEARCH row ahead of it, which is why the defect
      // only surfaced once that row was narrowed to the executor's real gate.)
      && !sl.countBudget
      && !isFeeTraffic(t) && !detectFeeNag(t) && !detectProvisionAsk(t)
      && !detectProvisionWho(t)
      // NO `!sl.ownerContactPending` HERE (defect #3 of the [05:20] capture):
      // every card serve SETS that flag (the copy says the owner confirms
      // availability), so vetoing on it made this lane unreachable in exactly
      // the state it exists for — «OSVEN OVIE STO MI GI POKAZA DALI IMATE
      // DRUGI ?» after a served pair fell to the availability table, which
      // re-answered the same two cards and quoted the fee. A stock ask in the
      // owner-relay phase is still a stock ask; only the AGREED VIEWING FEE
      // ends the browsing part of the funnel, and that veto stays.
      && !sl.viewingFeeAgreed
      && detectVisitTime(t) === undefined && !proposesVisitTerm(t)
      && !detectCheaperSearch(t) && !detectPomaloAsk(t) && !detectBudgetUpAsk(t)
      && !detectAgreement(t) && !detectExplicitCancel(t) && !detectBye(t)
      && inferPropertyId(t) === undefined
      && (() => {
        const es = extractSlots(t);
        return es.bedrooms === undefined && es.bedroomsMin === undefined && es.bedroomsMax === undefined
          && es.sqm === undefined && !es.budget && !es.priceMin && !es.location
          && es.house === undefined && !es.business && !es.plac && !es.garsonjera
          && !es.yard && !es.anywhere && !es.sizeWaived;
      })() },
  // AN IDENTITY QUESTION ABOUT A FIGURE (defect #5 of the [05:20] capture):
  // «KOJ IMA 126 M2 ?» named a surface the served pair carried, and the turn
  // re-searched, reading the number as money. A figure an on-table row carries
  // is an IDENTIFIER, and a figure NO on-table row carries is the SAME question
  // asked of the whole offer — the executor looks it up in the feed and answers
  // with the rows that carry it, or with the honest «нема» line. Both legs are
  // feed reads inside one branch, so the lane owns every turn its text gate
  // admits and THE ROW IS THE TEXT GATE ALONE (plus the fee veto). It used to
  // also require served rows, which made this row a lie: a cold «кој има 300
  // м²?» was predicted here and then served as a fresh area search.
  { intent: 'IDENTIFY_BY_FIGURE', note: 'an identity question about a FIGURE («кој има 126 м² ?», «кое е 1.000 евра ?») — the row carrying it is named out of the served table, or out of the whole offer when the table has none (the honest «нема» line when the offer has none either), and the discussion moves to it; never a fresh search with the number read as money (inbound.ts 10176)',
    fires: t => detectIdentifyByFigure(t) !== undefined && !isFeeTraffic(t) },
  { intent: 'LOCATE_CONTINUE', note: 'a bare «не» while choosing among described flats — the rejection of the offer, never a farewell; the hunt serves the next options (inbound.ts 9790)',
    fires: (t, s, sl) => (sl.describedEbs?.length ?? 0) > 0
      && BARE_REFUSAL_ONLY_RE.test(t.trim()) },
  // «ВО КОЈА НАСЕЛБА СЕ НАЈЕВТИНИ СТАНОВИТЕ» compares NEIGHBOURHOODS, never rows
  // (inbound.ts 6314): cheapest mode + the word «населба» in the ask + buy + no
  // area named (naming an area is a row listing) + a rankable per-м² pool. The
  // pool is a FEED fact, so it rides the evidence channel (`priceAvgNaselba`,
  // whose probe calls the same lifted predicates the block calls) — the row is
  // that fact alone.
  // THE PRICE-EXTREME FAMILY: one detector owns the whole block (inbound.ts
  // 6455 `extractPriceExtremeQuery`), which serves cheapest/dearest listings,
  // total-price asks and the «за колку најмалку» shapes. EVERY leg of the block
  // ends in a serve — including «немам понуди», «без квадратура не можам да ги
  // споредам» and the cheaper/dearer misses — so the text detector is the whole
  // prediction and the feed decides only WHICH sentence comes back, never
  // whether the lane runs.
  { intent: 'PRICE_AVG_NASELBA', note: '«ВО КОЈА НАСЕЛБА СЕ НАЈЕВТИНИ СТАНОВИТЕ» — the cheapest NEIGHBOURHOOD by mean €/м², plus the flat beside that number (inbound.ts 6314). EVIDENCE: the gate is the lifted `naselbaComparisonGate` (naselba word, no area named, buy, rankable per-м² pool)',
    fires: (t, s, sl, ev) => ev?.priceAvgNaselba === true },
  { intent: 'PRICE_EXTREME_MORE', note: '«УШТЕ?» after a price LIST (inbound.ts 6250) — the next three rows of the SAME ranked list, never the discovery ladder. Gate: the queue the list left behind is non-empty and the message carries a more-word',
    fires: (t, s, sl) => (sl.extremeQueue?.length ?? 0) > 0
      && /(?:^|[\s,.:;!?])(?:uste|уште|ushte|poveke|повеќе|povece|повече)(?![\p{L}\p{N}])/iu.test(t) },
  { intent: 'PRICE_EXTREME_MORE_EMPTY', note: '«DRUGI IMAS?» / «УШТЕ?» after a €/м² list that had ALREADY served every row under the rate (inbound.ts 7661) — the honest «тоа се сите … до N евра за м²» plus the offer to raise the ceiling by 200. Gate: the more-word, an EMPTY extreme queue, a €/м² rate on the turn and a buy search — mutually exclusive with PRICE_EXTREME_MORE by the queue length',
    fires: (t, s, sl) => (sl.extremeQueue?.length ?? 0) === 0
      && sl.sqmRate !== undefined && sl.service === 'buy'
      && (/(?:^|[\\s,.:;!?])(?:uste|уште|ushte|poveke|повеќе|povece|повече)(?![\\p{L}\\p{N}])/iu.test(t)
        || (/(?:^|[\\s,.:;!?])(?:drugi|други|drugite|другите)(?![\\p{L}\\p{N}])/iu.test(t) && /\\d/u.test(t))) },
  { intent: 'PLACE_RING_ROW', note: '«STO TI E TOA NA 1.4KM?» / «KOJ E TOJ STAN?» after the 1 km ring line (inbound.ts 12640) — the row the ring measured, named with its facts. Gate: a pending ring ask whose anchor has not moved, a measured row, and the identity wording — all of it in the slots',
    fires: (t, s, sl) => !!sl.poiTooFarAsk
      && (sl.poiTooFarAnchor === undefined || sl.poiTooFarAnchor === sl.poiAnchor)
      && sl.poiNearestId !== undefined && detectRingNearestAsk(t) },
  { intent: 'PRICE_EXTREME', note: 'an EXTREME price ask (“do 1000 evra kuca”, “koj ti e toj stan po … po m2”) — the cheapest/dearest listing under the client\'s own criteria, never the plain price ask (inbound.ts 6455); an empty or surface-less pool gets its own honest line under this same tag',
    fires: (t, s, sl) => detectPriceExtremeAsk(t)
      && inferPropertyId(t) === undefined && !isFeeFrame(t)
      && !unrankedStockAsk(t, sl) },
  // «KOJ BI MI GO PREPORACALE ?» — a JUDGMENT over the flats the chat has
  // discussed (inbound.ts 11181), never a card re-serve. The executor also
  // admits the doubt-that-is-about-the-table (`choiceAboutTable`): a VALUE ask
  // («što e isplatlivo?») with flats on the table forces its answer past the
  // FSM, and that half is pure slot state — so the row reads it too. Whether a
  // CHOICE SET exists at all (a flat on the table, or an EB named earlier in
  // the chat that still resolves) is the mention binder's fact: EVIDENCE
  // `recommendChoice`, so a cold «koj bi mi go preporacale?» is not predicted
  // here while the executor sends that turn to the funnel.
  { intent: 'RECOMMEND_ASK', note: '“koj bi mi go preporacale?” — the pick among the flats already discussed, with the reason, never the same cards again. EVIDENCE: a choice set exists (a flat on the table, or an Евидентен број named earlier that still resolves)',
    fires: (t, s, sl, ev) => (detectRecommendAsk(t)
      || (detectValueAsk(t) && ((sl.presentedIds?.length ?? 0) > 0 || sl.propertyId != null)))
      && ['idle', 'intent', 'discovery', 'property_query', 'presentation', 'closing'].includes(s)
      // Without a probe a unit harness keeps the old prediction; WITH one the
      // probe's answer is the truth (it only runs for these very texts, so a
      // missing flag cannot mean "not computed").
      && (ev === undefined || ev.recommendChoice === true) },
  // ── THE EVIDENCE-GATED LANES (Phase 4, the channel the backlog needed) ────
  // Each row below is the executor's OWN gate, with the one condition the
  // router cannot see delegated to `RouteEvidence`: `o...` rows refuse
  // themselves when the probe is absent, so a unit test never gets a confident
  // wrong answer.
  // POI_CONFIRM precedes INFO_ASK: the executor reaches it at 6792, before the
  // info block, and it owns «да не е во карпош?»/«овај кај кипер ?».
  { intent: 'POI_CONFIRM', note: '«ДА НЕ Е ВО КАРПОШ?» / «ОВОЈ КАЈ КИПЕР, КОЈА АДРЕСА ЈА ИМА?» — the property\'s place confirmed or corrected from the map/neighbourhood, never a landmark invented for a place the client never asked about (inbound.ts 6792). EVIDENCE: the answer must exist (map hit not city-level, or a neighbourhood reading)',
    fires: (t, s, sl, ev) => ev?.poiConfirm === true },
  { intent: 'INFO_ASK_PAIR_IDENTITY', note: 'SEVERAL flats named in one ask, no facet — each named Евидентен број gets its own identity line, never only the first (inbound.ts 7849). EVIDENCE: both named rows exist in the feed',
    fires: (t, s, sl, ev) => ev?.infoPairIdentity === true },
  { intent: 'INFO_ASK_PAIR', note: 'a facet ask over the TWO flats on the table — one answer per flat, in the order the client met them (inbound.ts 7972). EVIDENCE: both rows resolve, and the ask is not the plain-floor variant',
    fires: (t, s, sl, ev) => ev?.infoPair === true },
  { intent: 'INFO_ASK_FLOORS', note: 'one floor question naming TWO flats — one clause per Евидентен број (inbound.ts 8002). EVIDENCE: two rows with a floor clause',
    fires: (t, s, sl, ev) => ev?.infoFloors === true },
  { intent: 'INFO_ASK', note: 'a fact ask about the flat on the table — one answer per facet from the feed\'s own data, never the LLM (scope C); the binding signals include the flat HER LAST LINE quoted a price for (`slots.lastQuotedEb`)',
    fires: (t, s, sl) => {
      const facets = detectInfoFacets(t, { floorOnTable: sl.lastReplyNamedFloor === true });
      if (!facets) return false;
      if (detectFeeComplaint(t) || detectMoreOptions(t) || isFeeTraffic(t)
        || detectProvisionAsk(t) || detectProvisionWho(t)
        || detectSmallerPerM2Ask(t) || detectTotalCostAsk(t)) return false;
      return !!(sl.propertyId || sl.interestedPropertyId
        || (sl.presentedIds?.length ?? 0) > 0 || (sl.describedEbs?.length ?? 0) > 0
        || inferPropertyId(t) !== undefined
        || sl.lastQuotedEb !== undefined
        || facets.yearBuilt || facets.renovation);
    } },
  { intent: 'FEE_FIRST_TIME', note: '«OVA PRV PAT SLUSAM» ([00:28]) — the client never met the fee before, so the answer is the FACT (fee.rule.hold), not another rationale. The executor tests it BEFORE the why leg, so the row must precede FEE_WHY',
    fires: (t, s) => detectFeeFirstTime(t)
      && ['closing', 'property_query', 'presentation', 'discovery', 'intent', 'idle'].includes(s) },
  { intent: 'FEE_SURPRISE', note: '«OVA E NESTO NOVO» / «AUUU» at the disclosure — closing-only in the executor, and it serves the fee.why rationale WITHOUT a rung (§2: surprise is not resistance). Mirrors that gate instead of widening it: «imate nesto novo vo karpos?» is a property ask',
    fires: (t, s) => detectFeeSurprise(t) && s === 'closing' },
  // THE FEE FAST PATH IS FLIPPED (Phase 4, money family): the executor's block
  // at 10534 evaluates exactly these three rows and now READS the answer
  // instead of recomputing its own booleans. That is only sound because the rows
  // are the booleans, so the two divergences the flip exposed are fixed here:
  //  • every row carries `!fsmRequired` (the executor's intercept guard: when
  //    the FSM forces the full path, its own fee.why legs serve — no double-talk)
  //  • FEE_COMPLAINT vetoes on `feeWhyFast`, not on bare `detectFeeWhy`: with a
  //    consent phrase present the executor's why leg stands down, the complaint
  //    takes the turn, and the OLD row (bare `detectFeeWhy`) predicted the
  //    opposite.
  { intent: 'FEE_RULES', note: '«KAKVI SE PRAVILATA NA AGENCIJATA?» — the rules-of-work script. The executor\'s intercept tries rules before why and total-cost, so a rules question is never re-explained as «why»',
    fires: (t, s) => !fsmRequired(t) && detectFeeRules(t) && FEE_MONEY_STATES.includes(s) },
  { intent: 'FEE_COMPLAINT', note: 'the fee arithmetic complaint leg (`detectFeeTotalCost` — «ako gledam 10 stana toa se 5000 od moj djeb»): the client multiplies the fee, which the executor answers with the rationale (never the search, never a rung). The executor evaluates it after rules/why, hence the two vetoes',
    fires: (t, s) => !fsmRequired(t) && !detectFeeRules(t) && detectFeeTotalCost(t)
      && !(detectFeeWhy(t) && !detectFeePaymentAgreement(t))
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
      // The plural MARKET noun is one family (the shared property lexicon): the
      // local list here and `hasMarketTypePlural`'s had already diverged —
      // «плацеви»/«простори» vetoed here and were invisible there.
      && !hasMarketTypePlural(t)
      && !detectInventoryAsk(t) && !detectAreaHaveAsk(t)
      // …AND AN ASK FOR OTHER STOCK STANDS THIS ROW DOWN TOO (defect #3 of the
      // [05:20] capture): the executor leg carries the same veto, so the two
      // sides stay one predicate.
      && !detectMoreStockRequest(t)
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
    // …AND THE PLACE-OFFER READING IS THE SAME BLOCK (the 2026-11-15 replay):
    // «zdravo imavte nesto kaj crnogorska ambasada?» carries no category word,
    // so `detectPropertyDescription` is false while the executor's one-place
    // reading serves it — predicted FALLTHROUGH here. Same predicate both sides.
    // …AND THE PRICE-AND-SIZE RECALL IS THE FUNNEL'S TURN, NOT A SERVICE INTENT
    // (the 2026-11-15 replay): «имавте еден стан во Маџар Маало со две спални,
    // цена околу 180 000, дали уште се продава?» carries «се продава», which
    // `detectService` reads as a deal — so the row fell through while the
    // locate re-rank served it under THIS tag (inbound.ts 13873). The recall
    // block refuses the shape itself (price AND size = the funnel can rank by
    // both, the [madjari] money-anchor gate), so the deal word inside a recall
    // is evidence ABOUT the listing, never a new search's service slot.
    fires: (t, s, sl) => ((detectPropertyDescription(t) || detectPlaceOfferAsk(t)
      || isBarePriceReference(t, sl))
      && !detectService(t) && !detectBothServices(t)
      || pricedSizedRecall(t))
      && !detectInventoryAsk(t)
      && !isFeeTraffic(t) && !detectOwnClaimChallenge(t)
      && !detectDrugAlternative(t) && !detectInvestmentOpinion(t) },
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
  { intent: 'FEE_WHY', note: 'bare why-claim about the charge — never fee consent (must beat provision.ask). The STATE list is the executor\'s: the fast intercept only serves a why in the money states',
    fires: (t, s) => !fsmRequired(t) && detectFeeWhy(t) && !detectProvisionAsk(t)
      && !detectFeePaymentAgreement(t) && FEE_MONEY_STATES.includes(s) },
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
  // A SIDE-BY-SIDE OF THE TABLE IS ANSWERED DETERMINISTICALLY (the [09:15]
  // V16K11 capture): «NAPRAJ MI SPOREDBA SO PONUDENITE PRETHODNO» has rows it
  // can only mean — the flats on screen — so the comparison lane runs before
  // the LLM's diff lane (COMPARISON) and its own row must sit right there, or
  // every such turn reports a route gap. The executor's gates are copied: no
  // named EB, no fee, no search/widen, no visit intent.
  { intent: 'TABLE_COMPARE', note: 'a side-by-side of the flats on the table («направи ми споредба со понудените претходно», inbound.ts 7676) — arithmetic on the shown rows, never a stock search. Fires only over a set (>=2 rows), never for a named EB or fee/search/visit traffic',
    fires: (t, s, sl) => {
      if (!['presentation', 'property_query', 'closing'].includes(s)) return false;
      if (!detectComparisonRequest(t) || inferPropertyId(t) !== undefined) return false;
      if (isFeeTraffic(t) || detectSeeOffers(t) || detectExplicitWiden(t) || detectCheaperSearch(t)) return false;
      if (detectVisitRequest(t) || detectVisitInterest(t)) return false;
      return new Set([...(sl.describedEbs ?? []), ...(sl.currentBatch ?? []), ...(sl.presentedIds ?? [])]).size >= 2;
    } },
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
  // «УШТЕ НЕШТО ИМА ЛИ ИЛИ ТОА Е ТОА ?» — the set on the table confirmed (the
  // [08:54] capture). It is answered BEFORE the ring ask, so its row sits here,
  // just before PLACE_RING_ASK's, and mirrors the executor's gate exactly: the
  // tail marker, something on the table, and no fee/visit traffic.
  { intent: 'SET_CONFIRM', note: '«уште нешто има ли ИЛИ ТОА Е ТОА?» (inbound.ts 15499) — the flats on the table ARE the current matching offer, and the forward step is a visit (never the «we will contact you when a new offer appears» question the owner removed). Gate: the alternative tail, a non-empty table, no fee/visit traffic',
    fires: (t, s, sl) => detectSetConfirmationAsk(t)
      && ['presentation', 'closing', 'property_query'].includes(s)
      && !isFeeTraffic(t) && !detectVisitRequest(t) && !detectVisitInterest(t)
      && new Set([...(sl.currentBatch ?? []), ...(sl.presentedIds ?? [])]).size > 0 },
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
export function resolveIntent(
  text: string, state: string, slots: RouteSlots = NO_SLOTS, evidence?: RouteEvidence,
): string {
  for (const r of ROUTING_ORDER) {
    try { if (r.fires(text, state, slots, evidence)) return r.intent; } catch { /* never let the mirror crash callers */ }
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

// (The mirror's old `nearbyInterceptorSkipped` helper is gone with the gate it
// modelled: the NEARBY read is ungated now, so a near-by ask keeps its own lane
// on every turn — see the WHERE_IS row's note. Do not reintroduce a question
// gate here: it predicted WHERE_IS for turns the executor served as NEARBY.

/** A RECALL THAT NAMES BOTH A REMEMBERED PRICE AND A SIZE. The recall block's
 *  claim gate requires the size to be MISSING whenever a price is present
 *  (inbound.ts 9849, the [madjari] money-anchor gate: with both figures the
 *  locate funnel ranks the pool by room count *and* price), so such a message
 *  falls through to the funnel. Text-only — no map, no feed. */
const pricedSizedRecall = (t: string): boolean => {
  if (!detectSeenListingRecall(t)) return false;
  const s = extractSlots(t);
  return s.budget !== undefined
    && (s.bedrooms !== undefined || s.bedroomsMin !== undefined
      || s.bedroomsMax !== undefined || s.sqm !== undefined);
};

/** RESOLVE A SERVED TAG TO ITS REGISTRY ROW. The executor names the WORDING
 *  SOURCE after a colon on the same lane (`FEE_WHY:fast`, `FEE_SURPRISE:fast`,
 *  `PROPERTY_CHOICE:fast`) and even puts the state there
 *  (`VISIT_CANCEL:visit_scheduling`) — every one of them is the lane the base
 *  tag names, and `ROUTE_LANES` keys one spelling or the other. Without this
 *  resolution the comparison read a suffixed tag as an UNREGISTERED LANE and
 *  logged a gap on a correct turn: the 2026-11-15 day file carried 191 such
 *  rows (`VISIT_CANCEL:visit_scheduling` ×169, `VISIT_CANCEL:owner_checking`
 *  ×12, `PROPERTY_CHOICE:fast` ×10). Both readers — `routeLog` here and
 *  `scripts/route-gap-audit.ts` — call THIS function, so a served tag and the
 *  audit's day file can never disagree about what lane ran. */
/** THE AUDIT'S CLASSIFICATION OF A SERVED TAG, in one place. `routeLog` and the
 *  day-file audit must agree about what a row means:
 *    mirrored — the tag is a lane the mirror can predict;
 *    residual — a `K(...)` MARKER: it logs and falls through, `routeLog` never
 *               writes a drift row for it, so any row in an old day file was
 *               written BEFORE the marker rule and is history, not backlog;
 *    pending  — a `P(...)` row: a real lane with no mirror row yet (backlog);
 *    unlisted — still logged by `src`, missing from the registry (a defect);
 *    history  — no longer logged by `src` at all (renamed or retired). */
export type TagStatus = 'mirrored' | 'residual' | 'pending' | 'unlisted' | 'history';
export function tagStatus(tag: string, stillProducible: boolean): TagStatus {
  const lane = laneForTag(tag);
  if (lane) return lane.marker ? 'residual' : lane.intent ? 'mirrored' : 'pending';
  return stillProducible ? 'unlisted' : 'history';
}

export function laneForTag(tag: string): LaneEntry | undefined {
  // THE REGISTRY KEYS EITHER SPELLING: some lanes are registered by their BASE
  // name (`WHERE_IS`) and some only by the tag the executor logs
  // (`'FEE_PUSH:fast'`, `'OWNER_HOLD:fast'`), so BOTH directions are tried —
  // exact, then the `:fast`/`:bank` wording sources, then the base lane of a
  // `:kind`/`:state` tag and its sources again.
  const lookup = (k: string): LaneEntry | undefined =>
    ROUTE_LANES[k] ?? ROUTE_LANES[`${k}:fast`] ?? ROUTE_LANES[`${k}:bank`];
  const exact = lookup(tag);
  if (exact) return exact;
  const base = tag.replace(/:+[^:]*$/u, '');
  if (base === tag) return undefined;
  return lookup(base);
}

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
  const actualMirror = laneForTag(intent)?.intent ?? null;
  // A COLLISION MARKER IS A DIAGNOSTIC EVENT, NOT A LANE (2026-11-15): the
  // arbiter logs `LANE_COLLISION:nag|feeWhy` when two claims tie, and the lane
  // it then serves is tagged right after it in the same turn. Comparing the
  // MARKER with the prediction reported a gap on every turn that had a
  // collision to report — the [22:26] money case (predicted FEE_PUSH, served
  // FEE_PUSH, gap logged anyway). Same class as the pre-serve guess below: the
  // line names a diagnostic, not an answer.
  if (intent.startsWith('LANE_COLLISION')) return;
  // A MARKER ANSWERS NOTHING (ROUTE_LANES rows registered with K(...)): the
  // readiness flag, the repeat of an exit check, an evaluation the evidence
  // boundary did not wire — none of them is a lane, so comparing one with the
  // prediction can only invent a gap.
  if (ROUTE_LANES[intent]?.marker) return;
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
export function refinePrediction(
  chatId: string, text: string, state: string, slots: RouteSlots, evidence?: RouteEvidence,
): string {
  const intent = resolveIntent(text, state, slots, evidence);
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
  /** NOT A LANE: a log-only marker (a readiness flag, a repeat of an exit
   *  check, an evaluation the evidence boundary did not wire). It is registered
   *  so the audit can tell "not a lane" from "a lane nobody mirrored", and it
   *  is never compared with a prediction — see routeLog. */
  marker?: true;
}
const M = (intent: string, note: string): LaneEntry => ({ intent, note });
const P = (note: string): LaneEntry => ({ intent: null, note: `pending migration: ${note}` });
/** A MARKER, NOT A LANE (see `marker`). Counting markers as backlog inflates
 *  the pending count with tags that can never be mirrored, and comparing them
 *  with a prediction logs a gap on a turn that was served correctly. */
const K = (note: string): LaneEntry => ({ intent: null, marker: true, note: `not a lane: ${note}` });

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
  // THE PAIR'S LOCATION (the [22:51]/[22:52] capture): the plural/other wording
  // names both cards of the batch, so the turn serves one location line per
  // flat instead of one. Logged as its own tag from the address ladder
  // (EXACT_ADDRESS_PAIR) and from the standalone lane (PAIR_LOCATION /
  // PAIR_OTHER_LOCATION); all three map to the same two mirrors.
  EXACT_ADDRESS_PAIR: M('PAIR_LOCATION', 'plural address ask over the whole pair — one location line per flat'),
  PAIR_LOCATION: M('PAIR_LOCATION', 'the whole pair as the subject of a location turn — one location line per flat'),
  PAIR_OTHER_LOCATION: M('PAIR_OTHER_LOCATION', '«а другиот?» — the OTHER card of the pair gets its own location line'),
  EXACT_ADDRESS_OTHER: M('PAIR_OTHER_LOCATION', '«а другиот?» inside an address demand — the other card of the pair'),
  OWNER_CONTACT: M('OWNER_CONTACT', 'name/phone capture first'),
  PERSONAL: M('PERSONAL', 'a question about Lina herself — the tag carries the KIND: PERSONAL:name / :age / :compliment / :origin (inbound.ts 5022)'),
  WHERE_IS: M('WHERE_IS', 'каде owns those questions'),
  DISTANCE: M('DISTANCE', 'how far the discussed flat is from X'),
  DISTANCE_BATCH: M('DISTANCE_BATCH', 'the same ask with SEVERAL flats on the table — one measured line per flat, nearest first (the [11:28] capture: two cards were served and only one flat’s number came back)'),
  INFO_ASK_FLOORS: M('INFO_ASK_FLOORS', 'one floor question naming TWO flats («na koj sprat e 94 ? a na koj 90 ?») — one clause per Евидентен број (the [11:38] capture: only the bound flat was answered)'),
  INFO_ASK_PAIR_IDENTITY: M('INFO_ASK_PAIR_IDENTITY', 'SEVERAL flats named in one ask («za stan so evidenten broj 82 i 75») — every named Евидентен број gets its own card, never only the first (the [10:58] capture: 82 described and 75 dropped)'),
  INFO_ASK_PAIR: M('INFO_ASK_PAIR', 'a facet ask over the TWO flats on the table («sporedba na cena po kvadrat za dvata stana», «na koj sprat e 94 ? a na koj 90 ?») — one answer per flat; the pair-on-table referent («dvata») makes the batch without re-naming the EBs'),
  WHICH_OF_BATCH_PLACE: M('WHICH_OF_BATCH_PLACE', 'which of the offered flats stands in the place the client names — answered per row, from each row\'s own words'),
  NEAREST_OF_SHOWN: M('NEAREST_OF_SHOWN', 'which of the offered flats is nearest to X'),
  NEAREST_OF_BATCH: M('NEAREST_OF_BATCH', '«ova bese blisku» — the one nearest of the batch, with its measured distance'),
  MARKET_MEMORY: M('MARKET_MEMORY', 'a recollected OLD agency listing (имаше/беше … кај вас + noun + amount) — honest archive ack, beats MARKET_PRICE'),
  MARKET_PRICE: M('MARKET_PRICE', 'category+area fare range, beats PRICE_ASK'),
  SURROUNDINGS: M('SURROUNDINGS', 'which-side / relative-to-named-place'),
  PROPERTY_DESCRIPTION: M('PROPERTY_DESCRIPTION', 'remembered-property flow'),
  SEEN_LISTING_RECALL: M('SEEN_LISTING_RECALL', 'a recalled listing («имавте една куќа накај Скопје Север, околу 130 000 беше») served from the bank by category+area+price in helpful mode — never the criteria ask ([18:41] capture)'),
  DESCRIBE_TABLE: M('DESCRIBE_TABLE', '“опиши ги?” — the flats she just offered, answered from the bank rows (inbound.ts 9414)'),
  MORE_STOCK: M('MORE_STOCK', 'a stock ask after a pair was served («сакам да видам уште», «што уште имате ?») — the NEXT unshown pair from the same search, or the honest drained line; never the availability table, never the booking protocol, never a repeat of a flat already served ([12:41] capture)'),
  AVAILABILITY_TABLE: M('AVAILABILITY_TABLE', 'an availability ask that points at ONE flat already on the table by its type/price («GARSONJERATA ZA 200E DALI E DOSTAPNA?») — the ack + the owner question for THAT flat, never a fresh criteria grill ([22:27] capture)'),
  CONTACT_MECHANICS: M('CONTACT_MECHANICS', 'the competence challenge «KAKO KE GO KONTAKTIRAS AKO NE ZNAES KOJ BROJ E?» — the number she holds + the mechanism, never the DEFER line ([22:28] capture; inbound.ts 7140)'),
  STOCK_ABSENCE_ASK: M('STOCK_ABSENCE_ASK', 'the client asks WHETHER a type exists at all («stance nema?», «има ли стан во Центар?») — the stock truth under his own criteria, the closest honest option and never the visit fee ([V16K11] live capture; inbound.ts 9090)'),
  STOCK_CONTRADICTION: M('STOCK_CONTRADICTION', 'the client quotes a card she served against a «нема» she said («PA KAKO NEMA … KOGA OVOJ E EDEN OD NIV?») — admission + the row\'s own facts + the next step, never a location line ([02:12] capture; inbound.ts 6990)'),
  PICK_DESCRIBED: M('PICK_DESCRIBED', 'a pick among the flats she just described → the availability answer'),
  POST_BOOKING_ACK: M('POST_BOOKING_ACK', 'a bare acknowledgement after the visit is booked — answered from the booked record, never left to the brain to re-promise an owner check (inbound.ts 8975)'),
  LOCATE_CONTINUE: M('LOCATE_CONTINUE', 'bare «не» while choosing among described flats — the hunt continues'),
  LOCATE_WIDEN: M('LOCATE_WIDEN', '«да» to the other-neighbourhoods question — the area lock is released'),
  LOCATE_REJECT_PLACE: M('LOCATE_REJECT_PLACE', '«не е таа» after the only flat at a NAMED place — the place lock holds, other areas only after the ask (inbound.ts 10483)'),
  CONTACT_AFTER_FEE: M('CONTACT_AFTER_FEE', 'the fee question answered with a name + phone — consent and the visit-time ask (inbound.ts 10275); evidence-gated on the last line being the fee line'),
  AGENCY_IDENTITY: M('AGENCY_IDENTITY', '«КОЈА АГЕНЦИЈА СТЕ ВИЕ?» mid ping-pong (client OR owner): the agency is named and the interrupted question repeated — never the pending-traffic line ([19:36] capture; inbound.ts 4820)'),
  'NEGOTIATE:fast': M('NEGOTIATE', 'commercial-state price pushback'),
  PRICE_EVAL_CHEAP: M('PRICE_EVAL_CHEAP', 'positive price remark beats the fee ladder'),
  'PROVISION_PUSH:fast': M('PROVISION_ASK', 'fee pushback resolves through the provision lane'),
  PROVISION_WHO: M('PROVISION_WHO', 'who pays the provision split'),
  'FEE_WHY:fast': M('FEE_WHY', 'the bare WHY claim (must beat provision.ask)'),
  SCHEDULING_FLEX: M('SCHEDULING_FLEX', 'time-window preference in visit states'),
  // --- mirrored by dispatchSimple (SIMPLE_DETECTORS), rows added in R1 ---
  TABLE_COMPARE: M('TABLE_COMPARE', 'a side-by-side of the flats on the table (price, м², €/м²)'),
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
  ADDRESS_WHY: M('ADDRESS_WHY', 'privacy ladder — why the exact address stays private (inbound.ts 8801); evidence-gated, never a text-only guess'),
  FEE_RULES: M('FEE_RULES', 'agency fee rules ask (the rules-of-work script)'),
  'FEE_COMPLAINT': M('FEE_COMPLAINT', 'the fee-arithmetic complaint leg (detectFeeTotalCost)'),
  'AGENT_ATTENDANCE_ASK': M('AGENT_ATTENDANCE_ASK', 'does the agent attend the viewing — bank lane, before any visit/fee lane'),
  BYE: M('BYE', 'goodbye / close chat'),
  'ENTHUSIASM:fast': M('ENTHUSIASM', 'positive eye-catch reaction — a SIMPLE_DISPATCH lane, so it serves only when nothing else claimed the text'),
  'EXIT_CHECK': M('EXIT_CHECK', 'the once-per-session exit.criteria.check ask before a farewell'),
  // NOT A LANE: the second exit-shaped turn logs and FALLS THROUGH to the
  // farewell lanes (inbound.ts 9967), so its mirror is BYE / SOFT_REFUSAL — the
  // lane that actually answers.
  'EXIT_CHECK_REPEAT': K('the repeat of an exit-shaped turn — logs and CONTINUES into the farewell lanes, so it has no serve of its own'),
  'FEE_AMOUNT_ASK:fast': M('FEE_AMOUNT_ASK', 'exact fee amount asked (the arbiter feeAmount claim)'),
  'FEE_COMPLAINT:fast': M('FEE_COMPLAINT', 'fee resistance in the ladder'),
  'FEEDDOWN:fast': M('FEEDDOWN', 'feed-down transparency lane — the EB is unconfirmed because the FEED is down, never a ghost (inbound.ts 10675)'),
  'FEE_FIRST_TIME:fast': M('FEE_FIRST_TIME', 'first-time fee question'),
  'FEE_PUSH:fast': M('FEE_PUSH', 'fee charge pushback (the nag ladder; the mirror row arrived in Phase 4)'),
  // THE ALIAS WAS THE WHOLE GAP (2026-11-15): the executor logs the fast tag
  // (`FEE_PER_PROPERTY:fast`, inbound.ts 7477) and the registry resolved the
  // lookup by its RAW string, so a mirrored lane with no `:fast` alias read as
  // `actualMirror === null` — a GAP on every CORRECT arithmetic turn
  // (`predicted=FALLTHROUGH actual=FEE_PER_PROPERTY:fast` filled the field
  // logs). Every other fast lane already had its alias row; this one did not.
  'FEE_PER_PROPERTY:fast': M('FEE_PER_PROPERTY', 'the per-visit fee arithmetic on the fast path (the executor logs the suffix — inbound.ts 7477); the row is the same lane'),
  'FEE_SURPRISE:fast': M('FEE_SURPRISE', 'fee surprise reaction'),
  'GHOST:fast': M('GHOST', 'the flat the turn would serve is gone from the feed — the not-found pivot (inbound.ts 10664)'),
  GLOSSARY: M('GLOSSARY', 'a term-definition ask — answered from the vocabulary, never re-rendered as a property facet'),
  INFO_ASK: M('INFO_ASK', 'a fact ask about the flat on the table — the price facet is why the plain price ask rarely fires with a property on the table'),
  INFO_ASK_YEAR: M('INFO_ASK_YEAR', 'year of construction ask with nothing bound — the property-agnostic miss line; a bound flat keeps INFO_ASK (inbound.ts 8040–8049)'),
  'INVESTMENT_OPINION:fast': M('INVESTMENT_OPINION', 'investment-advice ask (inbound.ts 10573)'),
  LANDMARK_LADDER: M('LANDMARK_LADDER', 'the rotation rung when the client cannot picture the anchor (inbound.ts 5062) — evidence-gated on the slots\' own rotation index'),
  LOCATION_NAG: M('LOCATION_NAG', 'location question refused again (inbound.ts 8578)'),
  TOLD_YOU_RECALL: M('TOLD_YOU_RECALL', '«па ти кажав каде» — the notebook read back (places/area on file, then only the missing criterion)'),
  MONEY_CLARIFY: M('MONEY_CLARIFY', 'money-without-target clarification — the arbiter\'s own clarify claim (inbound.ts 7530)'),
  NEARBY_ASK: M('NEARBY_ASK', 'what is near the building — the interceptor runs before every funnel branch'),
  NEARBY_THREAD: M('NEARBY_THREAD', 'what-else-is-near (rotation → protocol → lifecycle; inbound.ts 8838) — evidence-gated on a last reply that NAMED a landmark'),
  'OWNER_HOLD:fast': M('OWNER_HOLD', '«NE GO KONTAKTIRAJ USTE» — acknowledge and stop, never proceed (inbound.ts 10460)'),
  POI_CONFIRM: M('POI_CONFIRM', 'a place-confirm question about the bound flat («da ne e vo karpos ?») — the executor answers it only when the MAP resolves the named place (inbound.ts 6861: a landmark hit or a named area). The map is data, not text: a mirror row would have to guess, and the probe showed exactly that — «DA NE E VO SKOPJANKA ?» is a POI-confirm by wording while the executor served nothing. Labelled backlog, not a guessed row'),
  PLACE_PIVOT: M('PLACE_PIVOT', 'same search at a different named place («а нешто кај X?») — the criteria stand and one question confirms them (inbound.ts 7156)'),
  SET_CONFIRM: M('SET_CONFIRM', '«уште нешто има ли или тоа е тоа?» — the shown flats are the whole matching offer'),
  PLACE_RING_ASK: M('PLACE_RING_ASK', 'the 1 km place ring: nothing inside the ring — the place, the measured distance and the one binary widen question (predicted on the refinement pass, from the pool\'s own poiTooFarAsk verdict)'),
  PLACE_RING_ROW: M('PLACE_RING_ROW', 'the identity of the flat the place ring measured (“koj e toj stan na 1,4 km?”, inbound.ts 12640) — predicted from the ring\'s own slots (a pending ask, an unmoved anchor, a measured row)',),
  'PRICE_ASK:fast': M('PRICE_ASK', 'the plain price ask in the !fsmRequired fast block — the flat named or the one on the table, else the Евидентен број question'),
  PRICE_AVG_NASELBA: M('PRICE_AVG_NASELBA', 'average €/m² per neighbourhood (“во која населба се најевтини становите”) — the aggregate branch (inbound.ts 6146) needs per-м² rows in the FEED and falls through to PRICE_EXTREME when it has none. A row would predict the aggregate for every cheapest+населба ask, including the ones the executor answers with the plain listing — a false drift, which is worse than a labelled gap. The text half is mirrored by PRICE_EXTREME, which is what serves when the data is thin'),
  'PRICE_EVAL_EXPENSIVE': M('PRICE_EVAL_EXPENSIVE', 'negative price remark about the flat on the table — the arbiter\'s own `expensive` lane'),
  // NOT A LANE: it logs and FALLS THROUGH (inbound.ts 7072) — a data-collector
  // record of every negative evaluation that the evidence boundary did NOT
  // wire to a serve. The mirror predicts the lane that really answers the turn,
  // so giving this tag its own row would predict a serve that never happens.
  // A DATA COLLECTOR, NOT A LANE (and not backlog): the residual price evaluation
  // logs and falls through to the lane that really answers — the investment
  // opinion in presentation (enrichment.test.ts), the fee rung in closing
  // (negated-agreement.test.ts). `routeLog` skips markers, so it can never be a
  // gap; rows carrying it in older day files predate the marker rule and are
  // attributed as history by the audit (`tagStatus`).
  'PRICE_EVAL_EXPENSIVE_UNWIRED': K('a NEGATIVE price evaluation the evidence boundary does not wire — logs and continues (no serve, no state change), so it has no serve of its own'),
  'PRICE_EXTREME': M('PRICE_EXTREME', 'extreme price search (“do 1000 evra kuca”, inbound.ts 6485) — mirrored above; this tag carries no suffix'),
  'PRICE_EXTREME_MORE': M('PRICE_EXTREME_MORE', '«УШТЕ?» after an extreme-price list (inbound.ts 6250) — the next rows of the same queue'),
  'PRICE_EXTREME_MORE_EMPTY': M('PRICE_EXTREME_MORE_EMPTY', '«УШТЕ?»/«DRUGI IMAS?» when the €/м² list under the rate is ALREADY complete (inbound.ts 7661) — «тие се сите» plus the offer to raise the ceiling, never a pivot to another quarter'),
  'PRICE_FRESHNESS:fast': M('PRICE_FRESHNESS', 'is this price fresh? — last known price + the owners-reprice disclaimer + the owner-contact ask'),
  // PENDING MIGRATION — the Phase 2/5 lanes (turn record + answer-vs-funnel):
  // each logs itself today and gets its mirror row with the router work.
  OWN_CLAIM_EXPLAIN: M('OWN_CLAIM_EXPLAIN', 'a challenge about our own earlier answer — explained from the turn record, never a fee/price script'),
  SUBJECT_PER_M2: M('SUBJECT_PER_M2', 'the €/m² of the flat on the table (price ÷ м²), never the neighbourhood band'),
  RATE_COMPARE: M('RATE_COMPARE', 'the «да» that answers her own comparison offer — the same category/area rates, never contact collection (inbound.ts 8621); slot-gated on `pendingOffer`, so the yes has a referent the text alone cannot show'),

  PROXY_CONTACT: M('PROXY_CONTACT', 'contact via the agency, never in closing (where the fee protocol owns the contact)'),
  RECOMMEND_ASK: M('RECOMMEND_ASK', '“koj bi mi go preporacale?” — a judgment over the discussed flats, never the same cards again (inbound.ts 10432)'),
  RENT_TERMS: M('RENT_TERMS', 'the conditions of renting (commission tiers, first rent + deposit, one-year minimum) — provision.ask.rent, never the viewing fee'),
  FEE_AGREED_FIRST: M('FEE_AGREED_FIRST', 'the first «да» after the fee disclosure — agreement opens contact collection'),
  'REMARK:bank': M('REMARK', 'bank-backed generic remark — the same lane as REMARK:fast, different wording source'),
  'REMARK:fast': M('REMARK', 'generic remark (deterministic) — one intent for both tags'),
  'RENT_MATH:fast': M('RENT_MATH', 'total due at signing on a rental (first rent + deposit + commission) — arithmetic, never the viewing fee'),
  SOFT_REFUSAL: M('SOFT_REFUSAL', 'a bare soft decline — graceful close, never a fee rung'),
  WAITING: M('WAITING', 'the client is waiting for the details she promised — patience line, not remark/LLM traffic'),
  // THE DYNAMIC-SUFFIX FAMILY (`VISIT_CANCEL:<state>`, the executor's own tag):
  // routeLog resolves a tag through the registry, and a suffix the registry does
  // not know made every correct cancellation a GAP — the same alias bug
  // `WAITING:fast` was. The row names the intent; the tag keeps its state.
  VISIT_CANCEL: M('VISIT_CANCEL', 'a cancellation in a visit state (the tag carries the state: VISIT_CANCEL:visit_scheduling …)'),
  VISIT_DAY_CHOICE: M('VISIT_DAY_CHOICE', 'the day/shape answer inside a live arrangement («во ист ден», «различни денови») — the choice is stored and the TERM is asked; the client is never asked the day question twice (inbound.ts, lane 0-e)'),
  AVAILABILITY_PROCEED: M('AVAILABILITY_TABLE', 'an availability ask that ARRANGES the owner check («prasaj dali e dostapen i dogovori mi poseta») — same lane, the arranging half (inbound.ts 9732)'),
  // The smaller-by-rate lane has a detector but no ROUTING_ORDER row yet, so its
  // GOLEM variants cannot be mirrored without inventing one: pending, and the
  // test that every mirrored intent exists in the order stays honest.
  GOLEM_SMALLER: M('GOLEM_SMALLER', 'the size-down ladder for a bare TOO-BIG complaint (a large flat) — the closest smaller м² first (inbound.ts 17257)'),
  GOLEM_SMALLER_EMPTY: M('GOLEM_SMALLER_EMPTY', 'the same complaint with nothing smaller in the feed — the honest empty line (inbound.ts 17285)'),
  SMALLER_PER_M2: M('SMALLER_PER_M2', 'the €/м²-anchored size-down ask («pomalo so takva cena za kvadrat») — a smaller row at or under the anchor rate (inbound.ts 17257). It had NO row at all, which is why the GOLEM note called it the unmirrored sibling'),
  SMALLER_PER_M2_EMPTY: M('SMALLER_PER_M2_EMPTY', 'the same ask with nothing smaller at or under the rate — the honest line plus the register step (inbound.ts 17285)'),
  // NOT A CLIENT LANE: the executor logs the session→chain readiness marker with
  // a three-argument routeLog (`routeLog(chatId, 'chain', 'CHAIN_READY')`,
  // inbound.ts 2498) and serves nothing under it. It is registered so the audit
  // can tell "not a lane" from "a lane nobody mirrored".
  // TWO SERVING LANES WITH NO ROW YET — labelled, not guessed. Both are
  // decision-shaped and need the upstream choice/arithmetic parse to mirror
  // honestly; the audit shows them as PENDING (visible backlog) instead of
  // UNLISTED (a silent lane), which is the difference that matters.
  PROPERTY_CHOICE: M('PROPERTY_CHOICE', 'the pick among flats that were PRESENTED («go sakam toj», a named card) — the fee is disclosed first, and in closing the fee lanes own the turn (inbound.ts 7184)'),
  FEE_PER_PROPERTY: M('FEE_PER_PROPERTY', 'the per-visit fee arithmetic («ZA SEKOJ STAN STO KE SE POSETI PO 500 ?», «500 DEN PO STAN?», the count «АКО ПОСЕТАМ 3 ?») — the confirmation, then the ladder if a rung has already burned (inbound.ts 7477). It was P(...) for weeks, which is why the field logs are full of `predicted=FALLTHROUGH actual=FEE_PER_PROPERTY:fast`: a pending row re-reports every correct turn as a gap'),
  CHAIN_READY: K('a session/chains readiness marker logged by routeLog(chatId, \'chain\', …) at inbound.ts 2513 — it answers nothing, so a mirror row would predict an answer that never happens (and routeLog never writes a drift row for a marker, so its rows in old day files are history)'),
  'WAITING:fast': M('WAITING', 'the same lane on the fast path (the executor logs the suffix — an unregistered alias would read as a route gap)'),
  AREA_OF_PLACE: M('AREA_OF_PLACE', '„во која населба е X“ — the place\'s own map quarter'),
  AREA_HAVE_SEARCH: M('AREA_HAVE_SEARCH', '„а во која населба има?“ — the area-availability ask: the criteria are released and the pair is served, with the neighbourhoods that hold it named ([19:46] capture; inbound.ts 5210)'),
  WHERE_LANDMARK: M('WHERE_LANDMARK', 'каде + a NAMED place — the honest distance/direction line when the map knows it and the honest «не е во евиденција» line when it does not, so the MAP decides the wording and the Wording test decides the lane (inbound.ts 5049)'),
  'WHICH_PROPERTY:fast': M('WHICH_PROPERTY', 'which EB are you talking about — the fast tag of the same lane (inbound.ts 7208)'),
  'VISIT_CANCEL:WHICH': M('VISIT_CANCEL', 'a cancel that names no arranged visit — asks which Евидентен број instead of guessing; the same lane family as VISIT_CANCEL, carried by its own tag'),
  VISIT_RECALL: M('VISIT_RECALL', 'which flat the arrangement was for — answered from the appointment, never contact collection'),
  SEEN_RECALL_HELP: M('SEEN_RECALL_HELP', 'the listing he saw but cannot name — found from the held category + place, closed with the seen-property question'),
  BUSINESS_PLACE_SERVE: M('BUSINESS_PLACE_SERVE', 'business spaces at the named places by rate+distance (or an honest «нема» plus alternatives)'),
  DISTANCE_MATRIX: M('DISTANCE_MATRIX', 'several places × every flat on the table («kolku e daleku od X i od Y ?») — one measured line per place and flat, nearest first (inbound.ts 5470). Predicted on the EVIDENCE channel (`distanceBatch`): the map decides whether two flats really measure against the named place'),
  AVAILABILITY_PLURAL: M('AVAILABILITY_PLURAL', 'an availability ask over SEVERAL flats («se slobodni ?», «dvata ?») — the ack for the set plus the owner-confirm question, with the fee quoted per property (inbound.ts 9985)'),
  BARE_EB_FOLLOWUP: M('BARE_EB_FOLLOWUP', 'a bare Евидентен број follow-up («А 42?») after cards were shown — the answer about THAT flat only, never a fresh search (inbound.ts 9750)'),
  IDENTIFY_BY_FIGURE: M('IDENTIFY_BY_FIGURE', 'an identity question about a FIGURE the served rows carry («кој има 126 м² ?») — the row carrying it is named (out of the whole offer when the table has none), never a fresh search (inbound.ts 10176)'),
  SLOT_TAKEN: M('SLOT_TAKEN', 'a proposed visit hour already taken in the day calendar — the free hours of that day are named before any owner is asked (inbound.ts 9924)'),
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
    // DISCOVERY IS IN (the [10:16] V16K11 burst): a client who says «ke ve
    // kontaktiram ako se odlucam» while the funnel is still asking what he wants
    // is not answering the question — he is leaving. The gate used to start at
    // `closing`, so the turn fell to the criteria question the funnel had queued
    // (on the box: the locate ask for the m²/price of a flat she had just
    // quoted). `idle` stays out on purpose (tests/router.test.ts pins that a
    // «ќе размислам» opening gets the greeting lane, not a goodbye) and contact
    // collection stays out too — there the client is mid-answer.
    allowedStates: ['closing', 'presentation', 'property_query', 'property_locate', 'discovery'],
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
