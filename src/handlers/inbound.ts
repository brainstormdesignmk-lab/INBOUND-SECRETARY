import { AppConfig } from '../config';
import { Db } from '../store/db';
import { decideCapture } from '../store/capture';
import {
  ChatSession, SessionStore, freshSession, isExpired, resetToIdle,
  touchInbound, touchOutbound, canSend, pushHistory, buildGreeting, assistantTexts,
} from '../fsm/session';
import { pickVariant, noMatchLine, exhaustedLine, fallbackVariant, relaxedCategoryLine } from '../data/responseBank';
import { shouldLogForEnrichment } from '../llm/enrichPolicy';
import { shouldTryDynamic, validateDynamicAnswer } from '../llm/dynamicFallback';
import { detectPersonalAsk, personalReply } from '../llm/personal';
import { fileMisrouteCorrection } from '../llm/misroute';
import { transition, Event, Service } from '../fsm/machine';
import { Classifier } from '../llm/classify';
import { Responder } from '../llm/respond';
import { PropertyService, Property, normalizeLocation, normalizeTimePhrase, locMatches, locPrep, isAddressUnknown, mkTimePhrase, placeLooseKey, pricePerM2, monthlyRent, rentUnitWord, rowsInArea, numberedAreasNamed, isNumberedArea, feedArea, interleaveMixedPairs, interleaveServicePairs, adText, textNamesPlace } from '../data/properties';
import { AGENT_ATTENDS_VIEWING_ANSWER, AGENT_ATTENDS_VIEWING_KEY, detectAgentAttendanceAsk, BUSINESS_BUDGET_ASK_KEY, BUSINESS_BUDGET_ASK_FALLBACK, detectBusinessBudgetAsk, PRICE_EVAL_CHEAP_KEY, PRICE_EVAL_CHEAP_FALLBACK, PRICE_EVAL_EXPENSIVE_KEY, PRICE_EVAL_EXPENSIVE_FALLBACK, detectPriceEval, isMoneyWithoutTarget, MONEY_CLARIFY_KEY, MONEY_CLARIFY_FALLBACK, cheapLaneConflict, detectAgreement, detectRejection, isPoiConfirmQuestion, extractPoiConfirmPlace, detectWidenIntent, detectExplicitWiden, detectLocation, detectLocationConfirm, isLocationConfirmMarker, detectWhereIs, detectSurroundingsAsk,  detectNearbyAsk, isOptionsFollowUp, detectExactAddressAsk, isKadeTocno,  detectOwnerContact, detectContactRequest, detectSeeOffers, detectPomaloAsk, detectBudgetUpAsk, detectSmallerPerM2Ask, detectGolemComplaint, detectAvailabilityAsk,  detectFeeWhy, detectFeeComplaint, detectFeeSurprise, detectFeeChargePushback, detectFeeNag, detectFeeFirstTime, detectFeeAnaphoricRefusal, detectInvestmentOpinion, isGenuineQuestion, detectPriceAsk, detectPriceFreshness, detectBudget, isWhereLandmarkQuestion, extractWhereLandmarkPlace, detectUnknownLandmark, isDistanceQuestion, extractDistancePlace, detectMarketPriceAsk, hasMarketTypePlural, isMarketRentWordAsk, detectMarketMemoryAsk, memoryTypeNoun, memoryRentSegment,
  memoryAmountText, detectPriceExtremeAsk, extractPriceExtremeQuery,  detectExhaustedFollowUp, detectRemark, detectEnthusiasm, detectSuggestAlternatives, detectOfftopic, detectDefer, detectNegotiate, detectProvisionAsk, detectProvisionWho, detectProvisionResistance, detectDrugAlternative, detectSchedulingFlex, detectVagueTime, detectWorkdaysQuestion, detectEscalation, detectDocumentsAsk, detectMortgageAsk, detectNeighborhoodAsk, detectAreaHaveAsk, detectComparison, detectFeatureAsk, detectResultSetQuestion, detectBedroomsRange, detectVisitCancellation, detectVisitTime, detectPropertyInterest,  detectPropertyDescription, detectVisitInterest, detectBothServices, detectService, detectBusiness, detectHouse, detectPlac, detectYardNeed, detectEyeCatch, detectPositiveEval, detectPriceReference, detectPricePriority, detectCheaperSearch, detectEbPriceAssertion, extractEbPriceAssertion, detectLocationNag, detectFeePaymentAgreement, detectWhyFollowUp, lastReplyWasNearby, lastReplyWasExhausted, mentionsMore, hasProximityAnchor, hasWhereWord, extractSlots, fsmRequired, mentionsLandmark,  detectNearCenter, namesCenterOutsideNearPhrase, detectRingElimination, CENTER_RING, hasDayWord, detectWaitingAck, detectOwnerContactHold, detectSendToOwnerAsk, GREETING_ONLY_RE, extractRentMath, computeRentMath, detectTotalCostAsk, detectMoreOptions, detectMeetingSpotAsk, detectNegatedAgreement, detectFeeRules, detectFeeTotalCost, detectFeeAmountAsk,  detectBye, detectSoftRefusal, detectVisitTimingQuestion, detectExplicitCancel, proposesVisitTerm,  detectExitCheck, extractPoiWish, extractPoiWishCandidates, detectWhichPropertyAsk, detectPropertyChoice, isFeeTraffic, isFeeFrame, detectDescribeAsk, detectContact, isPlausibleName, isValidPhone } from '../llm/deterministic';
import { arbitrateMoney, collisionTag } from '../llm/moneyArbitration';
import { detectCriteriaStatement, detectNegatedType, detectNegatedGarsonjera } from '../llm/deterministic';
import { laneServeDenied, GENERIC_ACK_KEY, GENERIC_ACK_FALLBACK } from '../llm/stateLanes';
import { hasClockHint, hasPeriodHint, extractDayWord } from '../visits/time';
import { buildCancelWhichAsk, buildCancelledByClient, buildCancelledByOwner } from '../visits/messages';
import { resolveMention, extractMentionSignals, hasIdentitySignals, describeCandidate, descriptorPhrases, isStudio, MIN_POI_DESCRIPTOR, type MentionCandidate, type MentionPoi } from '../llm/mentionResolve';
import { detectInfoFacets, buildInfoAnswer, isSuterenUnit, INFO_NO_YEAR_LINE, INFO_NO_RENOVATION_LINE, INFO_NO_YEAR_KEY, INFO_NO_RENOVATION_KEY } from '../llm/infoAnswer';
import { answerGlossary, detectGlossaryAsk } from '../llm/glossary';
import { inferPropertyId, propertyOnTable } from '../llm/classify';
import { AppointmentStore } from '../store/appointments';
import { EscalationStore } from '../store/escalations';
import { MetaStore } from '../store/meta';
import { OwnerStore } from '../store/owners';
import { AgentStore } from '../store/agents';
import { CustomerStore } from '../store/customers';
import { EventStore } from '../store/events';
import { PriceChangeStore } from '../store/priceChanges';
import { AddressChangeStore } from '../store/addressChanges';
import { BlocklistStore } from '../store/blocklist';
import { ChannelRegistry } from '../channels/types';
import { applyStrike, OFFENSE_WARNINGS, detectOffensive } from '../antiabuse/strikes';
import { OwnerAgent, DeferredOwnerAgent, LocalOwnerAgent, OwnerVerdict } from '../backoffice/ownerAgent';
import { AgentDispatcher } from '../backoffice/agentDispatcher';
import { LandmarkService, propertyAreaLink, landmarkLink, canServeLandmark, extractDetailsLandmark, resolveSearchCenter, FEED_LANDMARK_MAX_M, type PropertyRow, type Center } from '../geo/landmarks';
import { toCyrillic, translitToLatin } from '../geo/offlineMap';
import { walkMinutes, distM } from '../geo/precision';
import { routeLog, resolveIntent, dispatchSimple } from './router';
import { VisitScheduler } from '../visits/scheduler';
import {
  serviceLabel,  VISIT_TIME_QUESTION, OWNER_CHECK_ACK, PATIENCE_LINE,
  FEE_GRACEFUL_CLOSE, QUEUED_CONFIRM, buildVisitConfirmation, buildContactAsk,
  buildOwnerAsk, buildOwnerFollowupAsk, buildOwnerAcceptFollowupAsk, buildOwnerCounterRelay, buildOwnerWholeDayRelay,
  ownerPropertyLabels, buildWhereIsAnswer, feeLadder, buildFeeRule, FALLBACKS, NO_MATCH_LINE, normalizeOwnerTime,
  PROPERTY_NOT_FOUND_LINE, FEED_UNAVAILABLE_LINE, NO_MORE_ALTERNATIVES_LINE,
  LAST_INFO_PREFIX, DIRECTION_PIVOT_LINE, LOCATE_FIRST_ASK, LOCATE_DETAILS_ASK,
  LOCATE_NUMBER_PROMPT, LOCATE_REFINE_ASK, LOCATE_MORE_SPECS_ASK, LOCATE_SERVICE_ASK, buildLocateMatches,
  buildLocateLandmarkIntro, buildLocateLandmarkEntry, buildLocateLandmarkFallback, LOCATE_LANDMARK_PRICE_PROBE,
  locateNoun,  buildLocateFirstAsk, buildLocateServiceAsk, buildLocateMoreSpecsAsk,
  buildLocateLandmarkPriceProbe, buildDescribeIntro,
  AVAILABILITY_ACK, AVAILABILITY_ACK_FEM, buildPriceRelay, buildFeeAsk, buildFeeWhy, buildFeeRules, PROVISION_ASK_NEITHER,
  BYE_GRACEFUL, BYE_AGAIN, SOFT_REFUSAL_CLOSE, VISIT_CONFIRM_ASK, EXIT_CRITERIA_CHECK,
  buildPropertyCard, buildPropertyCards, pickCloser, waiverAck, PRESENTATION_CLOSERS_ALL, conversationalDetails,
  buildExactAddressAnswer, displayPlaceName, displayAreaName,
  buildSideAnswer,
  buildRecommendClose,
  OFFTOPIC_REDIRECT, FOLLOWUP_DEFER, PRICE_NEGOTIATE, PROVISION_ANSWER,
  SCHED_FLEX_ANSWER, ESCALATION_ANSWER, DOCUMENTS_ANSWER, MORTGAGE_ANSWER,
  NEIGHBORHOOD_ANSWER, COMPARISON_ANSWER, FEATURE_ANSWER,
  provisionLadder, type ProvisionRung,
} from '../llm/prompts';
import { detectRecommendAsk, collectMentionedEbs, buildRecommendation } from '../llm/recommend';

const NON_TEXT_REPLY = 'Ве молам, испратете ми текстуална порака за да можам да Ви помогнам.';
// Landmark reading (the [13:28] capture). AREA_DERIVE_M: how far from a map
// place the feed's own rows still count as "this place is in that area".
// LANDMARK_NEAR_M: the radius a listing may honestly be called "близина на"
// the place the client described (same honest walk radius the presentation
// anchor uses).
const AREA_DERIVE_M = 1500;
const LANDMARK_NEAR_M = 1500;

// EB-DISCLAIM (the [11:08] TUI capture): "БРОЈОТ НЕ ГО ЗАПИШАВ" — the client
// already said he does NOT have the Евидентен број; every later locate ask
// must DROP the number invitation (asking for what he just said he lacks is
// a dead loop). Negations only — the positive "го знам" owns its own branch
// (LOCATE_NUMBER_PROMPT). Both scripts, common inflections: запишав/записа/
// запишал, знам/знае/знаев, latin zapisav/pisuvav/znaev/nesum-go-pisal, and
// the bare "незнам".
const EB_DISCLAIM_RE =
  /(?<![\p{L}])(?:не\s+(?:го\s+)?(?:запиш[а-џ]*|запомнив|запамтив|зна[а-џ]*|знам|немам\s+број)|(?<![\p{L}])ne\s+go\s+(?:zapis[a-z]*|pisuv[a-z]*|zna[a-z]*|zapamt[a-z]*)|(?<![\p{L}])nesum\s+go\s+pi[a-z]*|(?<![\p{L}])neznam\b)/iu;

/** Does the MAP's place name stay within what the CLIENT said? Compared through
 *  the loose Skopje fold (ч/ц, ш/с, ќ/к, ѓ/џ, and the area aliases), so "BROZ
 *  KAFE" reaches "Broz Cafe" and "lisice" reaches "Лисиче". Only the map
 *  name's FIRST word is required: that is where a phantom business name puts
 *  the brand the client never typed ("ELS Novo Lisice"), while a real short
 *  reference stays valid ("kaj Zegin" → "Zegin Apteka", "kaj Vero" → "Vero
 *  Center"). Words shorter than 3 letters carry no identity and are skipped. */
function poiNameFollowsClientWords(clientText: string, poiName: string): boolean {
  const words = (s: string): string[] => placeLooseKey(normalizeLocation(s))
    .split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 3);
  const said = words(clientText);
  const head = words(poiName)[0];
  return !head || said.includes(head);
}
// GREETING_ONLY_RE moved to deterministic.ts (shared with the pre-classify's
// greeting ownership — the 15:12 TUI capture) and imported below.
const QUEUED_STAY_LINE = 'Вашите критериуми се забележани. Ќе Ве контактирам штом најдам соодветна недвижност.';
// The owner CAN'T do the client's proposed time and gave NO alternative. Lina
// must never fabricate a term ("по договор со сопственикот" was relayed as a
// fake proposal the client was asked to accept — and an accept then fell back
// to the REFUSED time). Relay the refusal honestly and ask for another time;
// the new time re-asks the owner (the healthy ping-pong keeps looping).
const OWNER_CANT_TIME_RELAY = (t: string) =>
  `Сопственикот не може во тој термин (${mkTimePhrase(t)}). ${VISIT_TIME_QUESTION}`;
/** A GONE verdict's note → a predicate that agrees with „недвижност“ (feminine).
 *  Owner notes arrive in every shape: `продаден` (the TUI /owner sold note),
 *  `недвижноста е продадена` (the LocalOwnerAgent default), `издаден`, an
 *  under-option explanation. Used after „недвижноста … е“, so a full sentence
 *  would double the copula ("е недвижноста е продадена") and the masculine
 *  form contradicts the noun ("недвижноста … е продаден"). */
function gonePredicate(note?: string): string {
  const n = (note ?? '').toLowerCase();
  if (/продад/.test(n)) return 'е продадена';
  if (/издад/.test(n)) return 'е издадена';
  if (/под опција/.test(n)) return 'е под опција и моментално не е достапна за посета';
  return 'веќе не е достапна';
}

/**
 * TYPED-CATEGORY EMPTY (the [09:29] business capture) — the answer for a
 * деловен простор / куќа / плац search with NOTHING in its own category
 * anywhere in budget. The category is never swapped (a typing client asked
 * for THAT kind of property; serving flats — the capture answered a 500 м² /
 * 500.000 € business ask with two ЕБ apartments — is a wrong answer, not a
 * consolation). The line names the category and the budget and offers the
 * register step; a bare „да" then walks the existing queueAfterContact →
 * contact_collection flow, so the criteria are kept.
 * Returns undefined for untyped (apartment) searches — they keep the normal
 * no-match → exhausted → register ladder.
 */
/** [22:24] BARE PRICE-ASK ANCHOR FROM HISTORY — the referent for "koja i bese
 *  cenata uste ednas?" (no EB named, no budget). Only the explicit EB
 *  mention words count — bare digits name prices, budgets and time, and a
 *  wrong anchor quoted the price of the property presented BEFORE the one in
 *  play (the [22:24] answer served 40.000 for EB 44's 130.000). The most
 *  recent explicit ECB phrasing in the conversation (user OR assistant) is
 *  the surviving referent and must outrank the stale batch tail. */
function lastHistoryEb(history: ChatSession['history']): number | undefined {
  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i]!.text;
    const m = /(?:евидентен\s*бро[уји]?|еvidenten\s*bro[уји]?|ев\.?\s*бро[уји]?|\bEV\b|\bev\b|\bшифр\b|\bифра\b)\s*(\d{2,3})/iu.exec(msg);
    if (m) {
      const n = parseInt(m[1]!, 10);
      if (Number.isFinite(n) && n >= 10) return n;
    }
  }
  return undefined;
}

/** «може друг ден?» / «пак?» — a reschedule ask built on a BARE day word. The
 *  shared DAY_WORD_RE carries weekdays and relative days only: «1000 ден» is a
 *  price there, so a bare «ден» may never join it. This arm lives here, where
 *  the only thing it can decide is whether a released chat re-opens. */
const DAYLESS_RETURN_RE =
  /(?<![\p{L}\p{N}])(?:друг|drug|drugi)\s*(?:ден|den)(?![\p{L}\p{N}])|(?<![\p{L}\p{N}])(?:пак|pak)(?![\p{L}\p{N}])/iu;

/**
 * POST-CANCEL RETURN — does a RELEASED chat's returning message continue the
 * visit it cancelled?
 *
 * The client cancels, the farewell promises «Ќе бидеме во контакт», and the
 * chat sits in `terminated` — where a TTL's worth of silence met every word
 * they wrote next, including «може друг ден?». The returning message is the
 * other half of that exchange: it is about WHEN to see THAT visit again, and
 * the scheduling lane is the only place it can be answered (asking «купување
 * или изнајмување?» of a client who cancelled EB 62 twelve minutes ago is how
 * the re-book is lost — and a term like «во сабота во 12» read from a fresh
 * idle funnel lands in the EB lookup, not the visit).
 *
 * A message that STATES NEW CRITERIA is not that: it is a new enquiry, and
 * resuming the visit lane for it would re-ask the owner about the OLD
 * Евидентен број — the [21:57] wrong-property class. Those re-open fresh
 * instead, and either way the message is PARSED, never eaten.
 */
function continuesCancelledVisit(text: string): boolean {
  // Any criterion the intake would have asked for (service, type, rooms,
  // budget, area, a bare «ми треба стан») makes this a NEW enquiry.
  if (Object.keys(extractSlots(text)).length > 0) return false;
  return detectVisitTime(text) !== undefined
    || detectVisitTimingQuestion(text)
    || detectVisitInterest(text)
    || detectSchedulingFlex(text)
    || detectVagueTime(text)      // «може после 6?» — a term too vague for the owner
    || hasDayWord(text)
    || DAYLESS_RETURN_RE.test(text);
}

function typedNoMatchLine(slots: ChatSession['slots']): string | undefined {
  const kind = slots.business === true ? 'деловен простор'
    : slots.house === true ? 'куќа'
    : slots.plac ? 'плац'
    : undefined;
  if (!kind) return undefined;
  // The slot often carries a feed qualifier ("Центар (населба)"); clients
  // never say the parenthetical — displayAreaName drops it for prose.
  const where = slots.location ? ` во ${displayAreaName(slots.location)}` : '';
  const budget = slots.budget ? ` (буџет до ${slots.budget} евра)` : '';
  return `Во моментов немам ${kind}${where} што одговара на Вашите барања${budget}. Можам да ги забележам Вашите критериуми и да Ве известам штом се појави соодветна опција — дали да Ве запишам?`;
}

/** ONE-LINE IDENTITY of the flat an answer rests on (the [04:04] cold read).
 *  The client points at an ad Lina has never shown, so «сè уште е достапна»
 *  alone is a claim about NOTHING — the answer has to say which flat it means.
 *  Евидентен број + type + м² + price + area: an identity line, never a card
 *  (no ad text, no street — address privacy, no meeting request). */
function boundFlatIdentity(p: Property): string {
  const bits = [`Евидентен број ${p.eb}`];
  const type = ownerPropertyLabels(p).type;
  bits.push(p.sqm !== undefined ? `${type}, ${p.sqm} м²` : type);
  if (p.price !== undefined) {
    bits.push(`${p.price.toLocaleString('mk-MK')} евра${monthlyRent(p) !== undefined ? ' месечно' : ''}`);
  }
  const where = p.location ? displayAreaName(p.location) : '';
  if (where) bits.push(where);
  return bits.join(' · ');
}

/** WHICH FLAT DID HE PICK — an Евидентен број in the message, or an ordinal
 *  («првата», «втората») mapping onto the set she just offered. Nothing else
 *  picks: a bare «да» is not a choice between two flats. */
/** A ONE-WORD REFUSAL («ne», «no», «не») — the shortest "not that one" there
 *  is. While the client is choosing among the flats she just described it is a
 *  rejection of the offer, never a farewell: the bye/soft-refusal lanes read
 *  «NE» as goodbye and ended the whole chat with offers still unexplored (the
 *  [10:01] capture). «NE FALA» / «CAO» are NOT this — those stay goodbyes. */
const BARE_REFUSAL_ONLY_RE = /^(?:ne|no|не)[\s.!?,]*$/iu;

/** How far from the named landmark the continuation of a locate hunt may serve
 *  before the other-neighbourhoods question is asked (the [09:59] embassy pair
 *  and its 300–700 m neighbours are in; another municipality's stock is out). */
const NEAR_ANCHOR_SCOPE_M = 900;

function pickDescribed(text: string, ebs: number[]): number | undefined {
  const pid = inferPropertyId(text);
  if (pid !== undefined && ebs.includes(pid)) return pid;
  // The ordinal forms carry suffixes (првата, prvata, втората, vtorata), so
  // the stem is what is matched — but «прв пат» (first time) is not a choice.
  const ORDINALS: Array<[RegExp, number]> = [
    [/(?<![\p{L}\p{N}])(?:прв|prv)(?!\p{L}*(?:пат|pat))\p{L}*/iu, 0],
    [/(?<![\p{L}\p{N}])(?:втор|vtor)\p{L}*/iu, 1],
  ];
  for (const [re, idx] of ORDINALS) {
    if (re.test(text) && ebs[idx] !== undefined) return ebs[idx];
  }
  return undefined;
}

/** THE STOREY as a sentence fragment — the row's own `floor`, never read off
 *  the ad prose (both are offered to the client, but only the column is a
 *  fact: the ad says «високо приземје» where the column says 1). */
function floorFragment(p: Property): string | undefined {
  const f = p.floor;
  if (f === undefined) return undefined;
  if (f < 0) return 'Во сутерен';
  if (f === 0) return 'На приземје';
  const total = p.totalFloors && p.totalFloors > f ? ` од ${p.totalFloors}` : '';
  return `На ${f}${total} кат`;
}

/** THE AD'S OWN DISTINGUISHING FACTS for one option line of the which-flat
 *  ask (the [09:59] capture): «таа со терасата» must be answerable from what
 *  she just wrote, so the line carries the facts the row really holds — the
 *  recorded features (тераса, лифт, наместен…), the storey and the renovation
 *  state. The ad's own first sentence is the fallback for a row whose feed has
 *  no structured columns; nothing here is ever invented. */
function flatOptionFacts(p: Property): string | undefined {
  const parts: string[] = [];
  const feats = [...new Set(p.features ?? [])].map(f => f.trim()).filter(Boolean);
  if (feats.length > 0) parts.push(`Има ${feats.join(', ')}`);
  const floor = floorFragment(p);
  if (floor) parts.push(floor);
  if (p.yardSqm) parts.push(`Двор од ${p.yardSqm} м²`);
  if (p.renovationYear) parts.push('По реновирање');
  if (parts.length > 0) return `${parts.join('. ')}.`;
  // No structured facts — the ad's FIRST remaining fact still tells the twins
  // apart (сутерен vs прв кат со тераса). Stripped of the punctuation the ad's
  // own list items leave behind («, , високо приземје»), because the line has
  // to read like a person wrote it.
  const facts = conversationalDetails(p);
  const cleaned = (facts ?? '').split(/(?<=\.)\s/)[0]
    .replace(/^[\s,.;:—-]+/, '').replace(/\s*,\s*(?=,)/g, '').replace(/\s+/g, ' ').trim();
  if (!cleaned || cleaned === '.') return undefined;
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** THE DETAIL THE CLIENT PICKS BY — «таа со терасата», «тој со лифтот»,
 *  «гарсоњерата на прв кат». A POINTING reference plus the fact is a choice
 *  among the flats on the table; a QUESTION («има ли лифт?») is not, and must
 *  keep its own answer lane. The client's word and the row's word are matched
 *  separately because the ad is written in the third person («со тераса»)
 *  while he picks in the definite form («со терасата»). */
const DETAIL_POINT_RE = /(?<![\p{L}\p{N}])(?:таа|таата|тоа|тој|тојот|онаа|оној|taa|taata|toa|toj|onaa|onoj|станот|stanot|гарсоњерата|garsonjerata|куќата|kukjata)(?![\p{L}\p{N}])/iu;
const DETAIL_LINK_RE = /(?<![\p{L}\p{N}])(?:со|so|што\s+има|што\s+поседува|kaj\s+што|кај\s+што)(?![\p{L}\p{N}])/iu;
const DETAIL_FACETS: Array<{ ask: RegExp; row: RegExp }> = [
  { ask: /(?:терас|teras)/iu, row: /терас|teras/iu },
  { ask: /(?:балкон|balkon)/iu, row: /балкон|balkon/iu },
  { ask: /(?:лифт|lift)/iu, row: /лифт|lift/iu },
  { ask: /(?:подрум|podrum)/iu, row: /подрум|podrum/iu },
  { ask: /(?:клима|klima|климатиз)/iu, row: /клима|klima|климатиз/iu },
  { ask: /(?:двор|градин|dvor|gradin)/iu, row: /двор|dvor|градин|gradin/iu },
  { ask: /(?:гараж|паркинг|parking|garaz)/iu, row: /гараж|паркинг|parking|garaz/iu },
  { ask: /(?:реновир|renovir)/iu, row: /реновир|renovir/iu },
  { ask: /(?:намест|опремен|namesht|oprem)/iu, row: /намест|опремен|namesht|oprem/iu },
  { ask: /(?:сутерен|suteren)/iu, row: /сутерен|suteren/iu },
  { ask: /(?:високо\s+приземје|приземје|prizemje)/iu, row: /високо\s+приземје|приземје|prizemj/iu },
  { ask: /(?:прв(?:иот|иот)?\s+кат|prv(?:iot)?\s+kat)/iu, row: /прв(?:иот)?\s+кат|prv(?:iot)?\s+kat|на\s+1\s+кат/iu },
];

/** Every word a row can be picked by: the ad text plus the structured columns
 *  rendered the way a client speaks them (floor 1 → «прв кат»). */
function detailHaystack(p: Property): string {
  const floorWord = p.floor === 1 ? 'прв кат'
    : p.floor === 2 ? 'втор кат'
    : p.floor === 0 ? 'приземје'
    : p.floor !== undefined && p.floor < 0 ? 'сутерен'
    : '';
  return [p.details ?? '', p.landmark ?? '', ...(p.features ?? []),
    ...(p.noFeatures ?? []), floorWord].join(' ');
}

/** The flat the client pointED AT by one of its facts. Only a POINTING phrase
 *  («таа со…») picks; exactly one carrier wins, and two carriers are never
 *  guessed between (the caller keeps the question open). */
function pickByDetail(text: string, rows: Property[]): number | undefined {
  if (rows.length < 2) return undefined;
  if (!DETAIL_POINT_RE.test(text) || !DETAIL_LINK_RE.test(text)) return undefined;
  const asked = DETAIL_FACETS.filter(f => f.ask.test(text));
  if (asked.length === 0) return undefined;
  const hits = rows.filter(p => {
    const hay = detailHaystack(p);
    return asked.every(f => f.row.test(hay));
  });
  const ebs = [...new Set(hits.map(p => p.eb))];
  return ebs.length === 1 ? ebs[0] : undefined;
}

export interface HandleOpts {
  kind?: 'text' | 'other';
  senderName?: string;
}

export interface HandlerDeps {
  cfg: AppConfig;
  db: Db;
  sessions: SessionStore;
  classifier: Classifier;
  responder: Responder;
  properties: PropertyService;
  appointments: AppointmentStore;
  escalations: EscalationStore;
  meta: MetaStore;
  channels: ChannelRegistry;
  /** Approximate-location resolver (address privacy). Defaults to the DB-only
   *  service (deterministic table layer) when not supplied. */
  landmarks?: LandmarkService;
  /** Visit-protocol scheduler (turns 2+3). Optional: without it the arranged
   *  message is skipped and only the client confirmation goes out. */
  visits?: VisitScheduler;
  /** Enrichment queue — stores LLM-backed responses for the midnight cron
   *  that generates bank variants. Optional: without it, the queue is silent. */
  enrichment?: import('../store/enrichment').EnrichmentStore;
  /** Learned bank store — the SQLite layer of the response bank. Used by the
   *  learning loop: escalated Q→A pairs are retired into it as new keys.
   *  Optional: without it, learning is inert (seed bank still serves). */
  bank?: import('../store/bank').BankStore;
  /** THE TEACHER/EXAM POLICY — current brain mode supplied by the runner
   *  (TUI). Teacher modes (hybrid/gemini/groq) log replies for the midnight
   *  cron; exam mode ('free') logs nothing so the deterministic+bank stack
   *  can be TESTED standalone. Server runs are always teacher. */
  brainMode?: () => string;
  /** THE LEARNING LAYER'S SINK (TUI_LEARN) — captures the two shapes the
   *  improvement loop can never otherwise see: (a) messages the deterministic
   *  pre-classify gave up on (the Gemini classifier had to decide the intent —
   *  detector candidates for data/hardening mining) and (b) Gemini-generated
   *  prose replies (wording candidates for the bank importer). Optional: the
   *  production server passes nothing (its enrichment queue already covers
   *  the wording side); the TUI supplies a file-backed CaptureStore. */
  capture?: import('../store/capture').CaptureStore;
}

// Address/street wording does not bypass the location ladder. First location
// ask gets an approximate landmark; a repeated ask gets the agency's address
// privacy rule. Exact street data is never sent to the client.
/** The address-privacy protocol rounds are counted PER PROPERTY: the count is
 *  keyed by the Евидентен број it was accumulated for, so switching to another
 *  property starts its own rotation of protocol variants instead of continuing
 *  the previous property's (the client was hearing round 2 of the NEW property
 *  because the LAST one had already reached round 1).
 *  Returns the round ALREADY served for this property (0 = nothing yet). */
function protocolRoundFor(session: ChatSession, eb: number): number {
  if (session.slots.addressProtocolEb !== eb) {
    session.slots.addressProtocolEb = eb;
    session.slots.addressProtocolIndex = 0;
  }
  return session.slots.addressProtocolIndex ?? 0;
}

export class InboundHandler {
  readonly ownerAgent: OwnerAgent;
  readonly agents: AgentStore;
  readonly customers: CustomerStore;
  readonly events: EventStore;
  readonly priceChanges: PriceChangeStore;
  /** Owner-corrected addresses, queued for the same Hermes pass that carries
   *  prices (src/scripts/hermes.ts). Written by the visit scheduler's Turn 0. */
  readonly addressChanges: AddressChangeStore;
  readonly appointments: AppointmentStore;
  readonly dispatcher: AgentDispatcher;
  readonly landmarks: LandmarkService;
  readonly visits?: VisitScheduler;
  readonly owners: OwnerStore;
  readonly blocklist: BlocklistStore;

  /** Same as lastHistoryEb, but only EBs the feed can confirm — a ghost
   *  never anchors a money lane (a broken EB must not receive a price
   *  answer). */
  private async lastKnownHistoryEb(session: ChatSession): Promise<number | undefined> {
    const hist = lastHistoryEb(session.history);
    if (hist == null) return undefined;
    return (await this.deps.properties.getById(hist).catch(() => undefined))?.eb;
  }

  /** Fired when Lina asks the OWNER about availability (owner_checking). The
   *  TUI renders this in the owner panel; Hermes consumes the same question
   *  from the owner_check_requested event in phase 2. */
  onOwnerAsk?: (chatId: string, eb: number, question: string) => void;
  /** Fired when Lina has something to TELL the owner (not ask): today the
   *  congratulation on a reported sale. The TUI renders it in the owner panel;
   *  production sends it to the owner's Viber phone. Best-effort — a missing
   *  hook never breaks the client relay. */
  onOwnerMessage?: (chatId: string, eb: number, text: string) => void;
  /** THE TEACHER/EXAM POLICY — current brain mode supplied by the runner
   *  (TUI). Teacher modes (hybrid/gemini/groq) log replies for the midnight
   *  cron; exam mode ('free') logs nothing so the deterministic+bank stack
   *  can be TESTED standalone. Server runs are always teacher. */
  brainMode?: () => string;

  /** True while THIS turn's deterministic pre-classify gave up (undefined →
   *  the LLM classifier fired). Set at the classify seam, consumed at the
   *  turn-end capture hook. Never read anywhere else. */
  private detGaveUp = false;

  /** THE [09:0x] BUG: a fee-refusal turn in an IDLE session — dispatchSimple
   *  (which runs BEFORE the classifier) resolved 'provision.ask' with
   *  service === undefined and the ternary defaulted to the BUY script
   *  (500 ден/0% провизија) at a RENT client. This per-turn field records the
   *  service the message itself declares; the provision lanes consult it so
   *  a burst can backfill the slot before the copy is picked. Semantics:
   *  undefined = message says nothing about market, NOT "buy". */
  private feeServiceHint: Service | undefined = undefined;

  private chains = new Map<string, Promise<void>>();
  /** The raw inbound message of the in-flight processMessage call — history
   *  helpers outside processMessage (presentCheaperBatch) push it into the
   *  session log. */
  private lastUserText = '';

  /** TYPED-RESIDENTIAL POOL LOCK (the [20:33] capture): a funnel whose ask was
   *  explicitly residential (the client typed a category that is NOT деловен —
   *  the plain "стан" shape, house=false) must never fill with деловен
   *  простор. candidates()'s category-neutral absence branch keeps business
   *  rows in an untyped pool (pre-existing behavior); this narrows it at the
   *  call sites that answer a TYPED funnel: business=true stays armed, an
   *  explicit house=false excludes business, an untyped funnel untouched.
   *  BEDROOM-AXIS RESIDENTIAL (the [20:33] "spalni bilo kolku" capture): a
   *  funnel that asked or waived a bedroom count is residential by
   *  construction (деловен rows have no спальни) — that untyped-shape funnel
   *  must never fill business junk either. */
  private businessPoolLock(slots: ChatSession['slots']): boolean | undefined {
    if (slots.business === true) return true;
    if (slots.house === false) return false;
    if (slots.business === undefined
      && (slots.bedrooms !== undefined || slots.bedroomsMin !== undefined
        || slots.bedroomsMax !== undefined || slots.garsonjera === true
        || slots.sizeWaived === true)) return false;
    return slots.business;
  }

  constructor(private deps: HandlerDeps) {
    this.agents = new AgentStore(deps.db);
    this.agents.ensureDefault(deps.cfg.agentDefaultPhone);
    this.customers = new CustomerStore(deps.db);
    this.events = new EventStore(deps.db);
    this.blocklist = new BlocklistStore(deps.db);
    this.priceChanges = new PriceChangeStore(deps.db);
    this.addressChanges = new AddressChangeStore(deps.db);
    this.appointments = deps.appointments;
    this.owners = new OwnerStore(deps.db);
    this.dispatcher = new AgentDispatcher(this.agents);
    this.landmarks = deps.landmarks ?? new LandmarkService(deps.db);
    this.visits = deps.visits;
    this.ownerAgent = deps.cfg.ownerAgentMode === 'local'
      ? new LocalOwnerAgent(this.owners, this.events)
      : new DeferredOwnerAgent(this.owners, this.events, deps.cfg.ownerCheckTimeoutMinutes * 60_000, deps.cfg.ownerBusPollMs);
  }

  private get cfg(): AppConfig {
    return this.deps.cfg;
  }

  /** Real Viber: the sender id IS the caller's phone number. Lina must KNOW the
   *  number that is contacting her — prefill it once so the contact step only
   *  collects the name and the appointment records the real number. */
  private prefillViberPhone(session: ChatSession, channel: string, chatId: string): void {
    if (!session.slots.phone && channel === 'viber' && /^\d{8,15}$/.test(chatId)) {
      session.slots.phone = chatId;
    }
  }

  // Per-chat serialized queue: preserves order inside one chat, parallel across chats.
  private enqueue(chatId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(chatId) ?? Promise.resolve();
    const next = prev.then(fn).catch(e => console.error('[pipeline]', chatId, (e as Error).message));
    this.chains.set(chatId, next);
    return next;
  }

  /** Viber conversation_started: welcome greeting (user-initiated, so allowed). */
  startConversation(channel: string, chatId: string, senderName?: string): Promise<void> {
    return new Promise(resolve => {
      this.enqueue(chatId, async () => {
        void senderName;
        let session = this.deps.sessions.get(chatId);
        if (session && session.history.length > 0) return; // already chatting — stay silent
        if (this.blocklist.isBlocked(chatId)) return;       // strike-3 blocked — no greeting either
        if (!session) session = freshSession(channel, chatId);
        session.channel = channel;
        this.prefillViberPhone(session, channel, chatId);
        session.state = 'idle';
        const greeting = buildGreeting(session);
        pushHistory(session, { role: 'assistant', text: greeting }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, greeting);
      }).then(resolve);
    });
  }

  /** One WHERE_IS turn for a property: reveal ONE public landmark per ask,
   *  rotating L1→L2→L3 across sequential "каде е? / сто има во близина?"
   *  asks (the t60 workflow), then the privacy protocol once all 3 are shown.
   *  The 3 landmarks are pre-resolved once per property into session slots
   *  (nearbyLandmarks + nearbyLandmarkCoords), so each follow-up costs
   *  nothing. Reply shape — agency rules:
   *    „Тоа се наоѓа во близина на {landmark}."
   *    + one original Google link (no tinyurl, no second coordinate sentence)
   *  No "X мин пеш", no "Недвижноста е приближно тука:" — the client drills into
   *  the landmark itself, never the street. */

  // ── MENTION BINDING (the 12:33 transcript, approved scope B) ──────────
  // The client may name ANY property ever mentioned in the chat by EB,
  // price, type, size, floor or descriptor landmark ("кај Димитар
  // Миладинов", "гарсоњерата", "овој од 99000"). The candidate set is the
  // session's own memory: presented pairs, the current batch, the current
  // pointer and seen-property. One clear match binds it; several equal
  // matches produce ONE clarify naming the options; no match leaves
  // today's behavior untouched (undefined, never a guess).
  private async bindMention(text: string, session: ChatSession, opts?: { historyFallback?: boolean; offerAtPlace?: boolean }): Promise<{ prop?: Property; clarify?: string; fromFeed?: boolean; clarifyEbs?: number[]; clarifyAnchor?: { name: string; lat: number; lon: number } } | undefined> {
    const ebSet = new Set<number>();
    for (const eb of [
      ...(session.slots.presentedIds ?? []),
      ...(session.slots.currentBatch ?? []),
      session.slots.propertyId,
      session.slots.interestedPropertyId,
    ]) {
      if (typeof eb === 'number') ebSet.add(eb);
    }
    // A COLD message can NAME the EB: "ZDRAVO DALI KUKJATA 55 IMA DVORCE?"
    // arrives before anything was presented, so the slot set is empty and the
    // ask used to fall through to discovery. The named EB is a binding signal
    // of the same family as "kaj 69" — resolve it against the feed's own EBs
    // (the price guard lives in collectMentionedEbs: "100.000" is never an EB).
    let all: Property[] | undefined;
    // THE TEXT-FIRST COLLECT (the [13:28] merged burst): "57 BI GO POSETIL.
    // / KOLKU KVADRATA E?" arrived while a presented pair was on the table,
    // so the slot-Eb gate skipped the number collect and the ask bound the
    // PAIR'S TAIL (EB 59) — the answer quoted EB 59's 105 м² for EB 57.
    // When THIS message carries visit/property interest, its own numbers
    // join the set FIRST: an explicitly named EB outranks everything
    // already presented. Price-shaped tails ("do 250 evra") carry NO
    // interest signal and keep the old behavior — a budget cap must never
    // bind as a mention.
    if (ebSet.size === 0 || detectVisitInterest(text) || detectPropertyInterest(text)) {
      all = await this.deps.properties.getAll();
      const textEbs = collectMentionedEbs([text], new Set(all.map(p => p.eb)));
      const merged = new Set<number>(textEbs);
      for (const eb of ebSet) merged.add(eb);
      ebSet.clear();
      for (const eb of merged) ebSet.add(eb);
      // NOTHING NAMED AS AN EB is not "nothing named": the descriptor pass
      // below reads a place name against the feed (the [04:04] capture). The
      // empty-set verdict belongs there, where the descriptor is known.
    }
    if (!all) all = await this.deps.properties.getAll();
    const discussed: Property[] = [];
    for (const p of all) if (ebSet.has(p.eb) && !discussed.some(x => x.eb === p.eb)) discussed.push(p);

    // Map evidence for descriptor signals: "Црногорска амбасада" (client)
    // vs "Embassy of Montenegro" (map row) — the offline map is the name
    // bridge, same role as the Latin→Cyrillic script bridge.
    const sig = extractMentionSignals(text);
    // A COLD message names a place and nothing else (the [04:04] capture):
    // „IMAVTE EDNA GARXONJERA KAJ CRNOGORSKA AMBASADA“ arrives with no slot EB
    // and no card on the table, so the discussed set is empty — but a
    // descriptor is a hint for the FEED, not for the table. Returning here was
    // why the whole feed-reading pass below never ran on a first message.
    //
    // COLD READING IS FOR ONE NAMED PROPERTY, NEVER FOR A SEARCH: „имате нешто
    // во Центар?“ also has a descriptor, and binding the first Центар row to it
    // would answer a search with a single wrong ad (and ask „која од нив?“
    // about rows the client never saw). Only a message that POINTS at one ad —
    // an availability ask or a demonstrative («овој/тој кај …») — reads the
    // feed. Searches keep going to the funnel.
    const POINTS_AT_ONE_RE = /(?<![\p{L}\p{N}])(?:овој|тој|оваа|таа|ова|тоа|ovoj|toj|ovaa|taa|ova|toa)(?![\p{L}\p{N}])/iu;
    // THE OFFER ASK AT A PLACE (the [11:29] recall): „имавте гарсоњера кај
    // Црногорска амбасада“ asks whether we HAVE one there — a question the
    // feed can answer without asking for a number the client does not have.
    // It is still ONE-place reading, not a search: the landmark must be
    // introduced by кај/до/близу (or «во близина на») AND resolve on the map.
    // „имате нешто во Центар?“ names an AREA, not a landmark — it keeps the
    // funnel, exactly like a search.
    const OFFER_ASK_RE = /(?<![\p{L}\p{N}])(?:imate|imavte|imase|ima\s+li|имате|имавте|имаше|има\s+ли)(?![\p{L}\p{N}])/iu;
    const LANDMARK_PREP_RE = /(?<![\p{L}\p{N}])(?:kaj|do|blizu|кај|до|близу|во\s+близина\s+на)(?![\p{L}\p{N}])/iu;
    const pointsAtOne = POINTS_AT_ONE_RE.test(text) || detectAvailabilityAsk(text);
    let poi: MentionPoi | undefined;
    if (sig.descriptor && sig.descriptor.trim().length >= MIN_POI_DESCRIPTOR) {
      // The map cannot resolve "сјо дали е достапен уште" — try the descriptor's
      // prefixes, longest first, so the landmark the client led with is what
      // the map is asked about (same seam as the text evidence above).
      const hit = descriptorPhrases(sig.descriptor)
        .filter(p => p.trim().length >= MIN_POI_DESCRIPTOR)
        .map(p => this.landmarks?.findPlace(p))
        .find(h => !!h);
      if (hit) poi = { name: hit.name, lat: hit.lat, lon: hit.lon };
    }
    const offerAtPlace = opts?.offerAtPlace === true
      && OFFER_ASK_RE.test(text) && LANDMARK_PREP_RE.test(text) && !!poi;
    if (discussed.length === 0 && !(sig.descriptor && (pointsAtOne || offerAtPlace))) return undefined;

    const cands: MentionCandidate[] = discussed.map(p => {
      const c: MentionCandidate = {
        eb: p.eb, price: p.price, bedrooms: p.bedrooms, sqm: p.sqm,
        business: p.business, house: p.house,
        // The feed's Гарсоњера category (see isStudio): without it the type
        // noun "garsonjerava" scores negative on every candidate and binds
        // nothing (the [23:09] capture).
        studio: p.studio, location: p.location,
        details: p.details, landmark: p.landmark, landmarks: p.landmarks,
        lat: p.lat, lon: p.lon,
      };
      if (session.slots.nearbyLandmarks?.length && session.slots.nearbyLandmarkEb === p.eb) {
        c.nearby = session.slots.nearbyLandmarks;
      }
      return c;
    });
    let match = discussed.length > 0 ? resolveMention(text, cands, { poi }) : undefined;
    if (!match && sig.descriptor) {
      // THE HINT NAMES SOMETHING SHE HAS NOT SHOWN (the [01:20] capture): the
      // client points at «овој кај СЈО» while the cards on the table are two
      // other flats. Reading only the presented set binds nothing, and the
      // answer then goes to whatever was on the table — the wrong flat. The
      // same resolver over the FEED finds the one whose own ad says СЈО.
      // Descriptor-only: criteria never ride this pass, so a search message
      // can never bind a property here.
      // One row per Евидентен број: a feed that repeats a row (a mirrored feed,
      // an injected fixture) must not present the same flat twice as two options.
      // SERVICE NARROWS THE FEED (the [04:04] capture): „DALI SE PRODVA
      // USTE?“ rules out every rental, and near one embassy the feed holds a
      // FOR-SALE garsonjera and a RENTED one side by side — without the
      // service the resolver can only ask which, with it the answer binds.
      const svc = extractSlots(text).service ?? session.slots.service;
      const byService = svc ? all.filter(p => p.service === svc) : all;
      const pool = byService.length > 0 ? byService : all;
      // THE CATEGORY NARROWS TOO (the [11:29] recall): „гарсоњера кај …“ is a
      // kind of flat, not only a compass — a 3-room flat 100 m from the embassy
      // is not an answer to it, and offering it as one of the options made the
      // which-one ask look like the old ignorance. Only when the category has
      // SOMETHING there (nothing → the near-by alternatives are still honest).
      const wantsStudio = extractSlots(text).garsonjera === true;
      const feedSeen = new Set<number>();
      const feedCands: MentionCandidate[] = pool.filter(p => {
        if (feedSeen.has(p.eb)) return false;
        feedSeen.add(p.eb);
        return true;
      }).map(p => ({
        eb: p.eb, price: p.price, bedrooms: p.bedrooms, sqm: p.sqm,
        business: p.business, house: p.house, studio: p.studio,
        location: p.location, details: p.details, landmark: p.landmark,
        landmarks: p.landmarks, lat: p.lat, lon: p.lon,
      }));
      const typedCands = !wantsStudio || !feedCands.some(c => isStudio(c))
        ? feedCands
        : feedCands.filter(c => isStudio(c));
      // THE PLACE IS READ FROM THE PROPERTY ITSELF (the [10:36] capture):
      // „близу Црногорска Амбасада“ may only offer flats that ARE there — a
      // гapсоњера in Кисела Вода is not near the embassy because it is also
      // for sale. The evidence is the property's OWN record, strongest first:
      // coordinates inside the ring around the named place, or the ad's words
      // naming it („во близина на Црногорска Амбасада“ — the customer page
      // says it, so Lina knows it). Only when NEITHER source places any row
      // may the wider pool stand: nothing to go on is not the same as nothing
      // near.
      const placeName = poi?.name ?? sig.descriptor;
      const placed = !placeName ? typedCands : typedCands.filter(c => {
        const coordsOk = !!poi && c.lat !== undefined && c.lon !== undefined
          && distM(poi.lat, poi.lon, c.lat, c.lon) <= NEAR_ANCHOR_SCOPE_M;
        const row = all.find(p => p.eb === c.eb);
        const namedOk = !!row && textNamesPlace(adText(row), placeName);
        return coordsOk || namedOk;
      });
      const placedCands = placed.length > 0 ? placed : typedCands;
      const feedHit = resolveMention(text, placedCands, { poi });
      if (feedHit?.kind === 'unique' && feedHit.eb !== undefined) match = feedHit;
      if (feedHit?.kind === 'ambiguous' && (feedHit.candidates ?? []).length > 1) {
        // Several feed rows sit near the place the client named (two Центар
        // flats within 200 m of СЈО is normal; the [09:59] capture had two
        // гapсоњери at one embassy). Guessing one is the wrong-property class,
        // so she ASKS — but a bare «ЕБ 63 (28 м², 36.000 €) или ЕБ 80 (…)?»
        // asks the client to choose between two numbers he has never seen. He
        // asked about a FLAT HE REMEMBERS, so each option is DESCRIBED (type,
        // м², price, area + the ad's own first fact) and the question is the
        // one he can actually answer: is one of these the one you meant — and
        // if not, the search goes on (the caller keeps the frame and the
        // REJECTED lane pulls fresh options).
        const shown = (feedHit.candidates ?? []).slice(0, 3);
        const rows = shown
          .map(c => all.find(p => p.eb === c.eb))
          .filter((p): p is Property => !!p);
        const countWord = ['', 'една', 'две', 'три'][rows.length] ?? String(rows.length);
        // The place is the one the client named: the map's resolved POI when it
        // exists, else the feed row's OWN landmark (a replay or a map-less run
        // must not lose the name the ad already carries).
        const placeName = poi?.name ?? rows[0]?.landmarks?.[0]?.landmark ?? rows[0]?.landmark;
        const place = placeName ? ` близу ${placeName}` : ' во тој дел од градот';
        const lines = rows.map(p => {
          // THE ROW'S OWN FACTS, structured columns first (тераса, лифт, кат,
          // реновирање) and the ad's first sentence only when it has none — the
          // client must be able to answer «таа со терасата» from this line.
          const first = flatOptionFacts(p);
          return `• ${boundFlatIdentity(p)}${first ? `.\n  ${first}` : '.'}`;
        }).join('\n');
        return {
          clarify: `Имам ${countWord} недвижности${place}:\n\n${lines}\n\n`
            + 'Дали некоја од нив е таа што ја баравте? Ако не, продолжувам да барам.',
          fromFeed: true,
          clarifyEbs: rows.map(p => p.eb),
          // The place the hunt is locked to: the map's POI when it resolved, else
          // the matched row's OWN coordinates and landmark (a map-less run —
          // replay, fixture — must scope the continuation the same way).
          clarifyAnchor: poi
            ? { name: poi.name, lat: poi.lat, lon: poi.lon }
            : (rows[0]?.lat !== undefined && rows[0]?.lon !== undefined
              ? {
                  name: rows[0]?.landmarks?.[0]?.landmark ?? rows[0]?.landmark ?? placeName ?? '',
                  lat: rows[0].lat, lon: rows[0].lon,
                }
              : undefined),
        };
      }
    }
    if (!match && opts?.historyFallback) {
      // Signal-less follow-up ("MORAS DA MI KAZES KADE E") right after a named
      // bind: the chat's LAST uniquely-bound property is the one in play —
      // never "the last item of the presented pair by feed order".
      for (let i = session.history.length - 1; i >= 0; i--) {
        const h = session.history[i];
        if (h.role !== 'user' || h.text === text) continue;
        // Only IDENTITY-carrying history binds ("кај Миладинов",
        // "гарсоњерата", "овој од 99000"). Criteria messages ("до 250 евра",
        // "minimum 2 spalni") are the client's SEARCH, not a property
        // reference — scoring them here bound a budget to the wrong EB.
        if (!hasIdentitySignals(extractMentionSignals(h.text))) continue;
        const m = resolveMention(h.text, cands);
        if (m?.kind === 'unique' && m.eb !== undefined) {
          return { prop: discussed.find(p => p.eb === m.eb) };
        }
      }
      return undefined;
    }
    if (!match) return undefined;
    if (match.kind === 'unique' && match.eb !== undefined) {
      // `all` — the feed-wide hint may name a property this chat never saw.
      return { prop: all.find(p => p.eb === match.eb) };
    }
    // Ambiguous → ONE clarify naming the options (never a silent guess,
    // never a silent wrong property).
    const labels = (match.candidates ?? []).map(describeCandidate).join(', ');
    if (!labels) return undefined;
    return { clarify: `Кажете ми точно на која недвижност мислите — ${labels}?` };
  }

  /**
   * THE AREA VOCABULARY FOR ONE MESSAGE — the feed's naselba list PLUS any
   * place its ads name that this message itself names (PropertyService
   * .placesNamedIn). The second half is what makes the ad readable: EB 91 is
   * filed under «Центар» while its address and ad both say «Маџар Маало», so a
   * client asking for the flat he saw there named a place the funnel had never
   * heard of — the area slot stayed empty and the search ran city-wide. The
   * phrase is never invented: it is kept only when an ad's own text carries it,
   * so a neighborhood nobody has listed yet starts working the day it is.
   */
  private async areaLocs(text: string): Promise<string[]> {
    try {
      const locs = await this.deps.properties.locations();
      const extra = await this.deps.properties.placesNamedIn(text).catch(() => [] as string[]);
      return extra.length > 0 ? [...extra, ...locs] : locs;
    } catch { return []; }
  }

  /**
   * THE AREA THE MESSAGE NAMES — an ad-defined micro-area outranks the
   * municipality its alias collapses to. „Маџар Маало“ IS inside Центар (the
   * alias table says so), but a client standing in Маџар Маало means the flat
   * on that street, not the whole district: letting the feed's longest name win
   * is how the [01:17] ask was answered with a Центар pair.
   */
  private async areaNamed(text: string): Promise<string | undefined> {
    try {
      const extra = await this.deps.properties.placesNamedIn(text).catch(() => [] as string[]);
      if (extra.length > 0) return extra.join(', ');
      return detectLocation(text, await this.deps.properties.locations());
    } catch { return undefined; }
  }

  /** THE NEXT FRESH OPTIONS of a locate hunt — same frame (service, area,
   *  category), never one already shown. Shared by the FSM's «не е тој» lane
   *  and the bare-negation lane that fires while the client is choosing among
   *  the flats she just described. Nothing left → the OTHER-NEIGHBOURHOODS
   *  question, with the area lock marked drained (its «да» widens). */
  private async locateNextOptions(session: ChatSession): Promise<{ reply: string; bankKey?: string; shown: Property[] }> {
    const price = session.slots.budget ? Number(session.slots.budget.replace(/[^\d]/g, '')) : undefined;
    const pool = await this.deps.properties.closestMatches({
      location: session.slots.location,
      price,
      sqm: session.slots.sqm,
      bedrooms: session.slots.bedrooms,
      business: session.slots.business === true,
      house: session.slots.house === true,
      plac: session.slots.plac === true,
      service: session.slots.service,
      exclude: session.slots.presentedIds ?? [],
    });
    // THE CATEGORY SURVIVES THE «НЕ» (the [09:59] capture): after гapсоњери
    // were offered, the next closest by price was a трисобен — a flat hunt
    // that answers «гарсоњерата?» with a three-room read as not listening.
    const withCategory = (rows: Property[]): Property[] => {
      if (session.slots.garsonjera !== true) return rows;
      const studios = rows.filter(p => p.studio === true || p.bedrooms === 1);
      return studios.length > 0 ? studios : rows;
    };
    // THE AREA/PLACE IS A LOCK, NOT JUST A RANK — while the client is hunting
    // in a neighbourhood she named (or near the landmark he pointed at — the
    // [09:59] embassy), the next options come from THERE; only when it holds
    // nothing more does she ask about other parts of town, and the «да» then
    // releases the lock. Serving Аеродром under «кај амбасадата» without the
    // question is how a place-locked hunt silently changed places.
    const anchor = session.slots.clarifyAnchor;
    const inScope = (p: Property): boolean => {
      if (session.slots.location && locMatches(String(p.location ?? ''), session.slots.location)) return true;
      if (anchor && p.lat !== undefined && p.lon !== undefined) {
        return distM(anchor.lat, anchor.lon, p.lat, p.lon) <= NEAR_ANCHOR_SCOPE_M;
      }
      return !session.slots.location && !anchor;
    };
    const scoped = pool.filter(inScope);
    const areaPool = session.slots.location || anchor ? scoped : pool;
    const nearBatch = withCategory(areaPool).slice(0, 2);
    if (nearBatch.length === 0 && (session.slots.location || anchor) && pool.length > 0) {
      // Drained HERE, not everywhere: the other-neighbourhoods question. The
      // unanswered pool stays for the widen — nothing is offered before the
      // client agrees to leave his area.
      session.slots.areaExhausted = true;
      return {
        reply: exhaustedLine(session.slots.location ?? anchor?.name, assistantTexts(session)) ?? LOCATE_REFINE_ASK,
        bankKey: 'exhausted.location',
        shown: [],
      };
    }
    const nextBatch = nearBatch.length > 0 ? nearBatch : withCategory(pool).slice(0, 2);
    if (nextBatch.length === 0) {
      // Nothing anywhere: no question is worth asking about areas — the honest
      // next step is one more detail from the client.
      return { reply: LOCATE_REFINE_ASK, shown: [] };
    }
    session.slots.presentedIds = [...new Set([...(session.slots.presentedIds ?? []), ...nextBatch.map(p => p.id)])];
    session.slots.currentBatch = nextBatch.map(p => p.id);
    // What he is choosing from NOW — a pick of one of these is the next turn's
    // availability question.
    session.slots.describedEbs = nextBatch.map(p => p.eb);
    const ebDisclaimed = (session.history ?? [])
      .filter(h => h.role === 'user').slice(-8).some(h => EB_DISCLAIM_RE.test(h.text));
    return {
      reply: buildLocateMatches(nextBatch, session.history.length, !ebDisclaimed),
      shown: nextBatch,
    };
  }

  /** THE AVAILABILITY ANSWER for a RESOLVED flat — the gender-agreed bank ack
   *  (the code-built masculine line for masculine categories), prefixed with
   *  the flat's IDENTITY only when the number is new to the chat and the client
   *  did not give it himself (an ask that carries the EB, a card already
   *  presented, or an earlier turn that named it keeps the short ack). */
  private availabilityReply(p: Property, session: ChatSession, text: string): string {
    const ack = ownerPropertyLabels(p).dostapen === 'достапна'
      ? pickVariant('availability.ack', { recent: assistantTexts(session) }) ?? AVAILABILITY_ACK_FEM
      : AVAILABILITY_ACK;
    const namedInText = inferPropertyId(text) !== undefined;
    const wasShown = (session.slots.presentedIds ?? []).includes(p.eb)
      || (session.slots.currentBatch ?? []).includes(p.eb);
    const alreadyNamed = assistantTexts(session)
      .some(t => new RegExp(`Евидентен број ${p.eb}(?!\\d)`).test(t));
    return !namedInText && !wasShown && !alreadyNamed
      ? `${boundFlatIdentity(p)}\n\n${ack}`
      : ack;
  }

  /** Sends the clarify line for an ambiguous mention; reports that it did. */
  private async sendIfClarify(mb: { prop?: Property; clarify?: string; fromFeed?: boolean; clarifyEbs?: number[]; clarifyAnchor?: { name: string; lat: number; lon: number } } | undefined, text: string, session: ChatSession): Promise<boolean> {
    if (!mb?.clarify) return false;
    // A FEED clarify («these two are at that place — is either yours?») leaves
    // the chat in the CHOOSING lane, not back at idle: the offered numbers are
    // recorded so a «не» pulls the NEXT options (never the same two again),
    // and the deal the client asked about is kept — «дали уште се продава» is
    // a SALE question, so the continuation stays on for-sale rows and never
    // drifts to rentals (rent is offered only when the client asks to rent).
    if (mb.fromFeed && mb.clarifyEbs?.length) {
      session.state = 'property_locate';
      session.slots.presentedIds = [...new Set([...(session.slots.presentedIds ?? []), ...mb.clarifyEbs])];
      session.slots.describedEbs = [...mb.clarifyEbs];
      if (mb.clarifyAnchor) session.slots.clarifyAnchor = mb.clarifyAnchor;
      const fromText = extractSlots(text);
      if (!session.slots.service && fromText.service) session.slots.service = fromText.service;
      if (fromText.garsonjera) session.slots.garsonjera = true;
    }
    pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
    pushHistory(session, { role: 'assistant', text: mb.clarify }, this.cfg.maxHistory);
    this.deps.sessions.set(session);
    await this.sendRaw(session, mb.clarify);
    return true;
  }

  private whereIsReply(p: Property, session: ChatSession, place?: string): string {
    // Coordinates ride the feed now (public-properties selects lat/lon/
    // geo_source/geocoded_at). NEVER zero them: resolveSearchCenter serves a
    // TRUSTED center from stored coords; only rows without coords fall to the
    // geocodeAddress fallback (untrusted) or the honest no-center path.
    const propRow: PropertyRow = {
      id: p.id, eb: p.eb, address: p.address,
      landmark_name: p.landmark,
      lat: p.lat, lon: p.lon,
      geo_source: p.geo_source ?? null,
      details: p.details,
      // The feed's OWN ranked landmark list (fix-list item 3): the rotation
      // serves it when it exists — LandmarkService.nearbyLandmarks falls back
      // to the offline map only for a property the feed has not placed.
      landmarks: p.landmarks,
    };
    // NO-ADDRESS PROTOCOL (EB 58 class): the agency never learned this
    // property's street — any landmark, neighborhood pin or "во близина на"
    // claim would be invented geography. BUT the ladder contract (turn 1 =
    // approximate location for every lurker) still owes the client the best
    // HONEST approximation: the feed neighborhood (ЦР data, never invented).
    // Only a row with no neighborhood at all gets the ask-the-owner pivot.
    if (isAddressUnknown(p)) {
      if (p.location) {
        // The feed disambiguates settlement rows with a parenthetical type
        // ("Центар (населба)", "Аеродром (општина)"). The carrier already
        // names "населбата" — echoing the tag reads as a stutter
        // ("во населбата Центар (населба)"). Strip only the settlement tag.
        const loc = p.location.replace(/\s*\(населба\)\s*$/u, '');
        return `Недвижноста се наоѓа во населбата ${loc}. Точната адреса ќе ја добиете на денот на посетата.`;
      }
      return pickVariant('location.unknown', {
        recent: assistantTexts(session),
        vars: { eb: String(p.eb) },
      })
        ?? `Локацијата на недвижнината со Евидентен број ${p.eb} не ми е позната во моментов. Ќе морам да го контактирам сопственикот и да Ви потврдам. Дали би сакале да погледнете нешто друго?`;
    }
    if (process.env.DBG_WHEREIS) console.error('[whereis] propRow=', JSON.stringify(propRow), 'center=', JSON.stringify(resolveSearchCenter(propRow)));
    const center = resolveSearchCenter(propRow);

    // Pre-resolve the top-3 rotation slots ONCE per property. The client asks
    // "каде е?" → L1, "што уште има во близина?" → L2, … then privacy protocol.
    // SELF-HEAL (21:51 bug): the slots are tagged with the EB they were
    // resolved for (nearbyLandmarkEb). A stale tag — the cached slots belong
    // to a DIFFERENT property than the one being served now — means the
    // client would get another property's landmarks (EB 57 got EB 56's
    // Завод „Топанско поле", 3.2 km away). Discard and re-resolve for THIS
    // property. Belt-and-braces for missed resets upstream.
    if (session.slots.nearbyLandmarks?.length && session.slots.nearbyLandmarkEb !== undefined
      && session.slots.nearbyLandmarkEb !== p.eb) {
      session.slots.nearbyLandmarks = undefined;
      session.slots.nearbyLandmarkCoords = undefined;
      session.slots.nearbyLandmarkPlaceIds = undefined;
      session.slots.nearbyLandmarkEb = undefined;
      session.slots.landmarkIndex = 0;
      session.slots.lastLandmark = undefined;
      session.slots.addressProtocolIndex = 0;
      session.slots.exactLocationTurns = 0;
    }
    const lm = session.slots.nearbyLandmarks;
    if ((!lm || lm.length === 0) && this.landmarks) {
      const nearby = this.landmarks.nearbyLandmarks(propRow);
      if (nearby.length > 0) {
        session.slots.nearbyLandmarks = nearby.map(n => n.landmark);
        session.slots.nearbyLandmarkCoords = nearby.map(n => ({ lat: n.lat, lon: n.lon }));
        session.slots.nearbyLandmarkPlaceIds = nearby.map(n => n.place_id ?? null);
        session.slots.nearbyLandmarkEb = propRow.eb;
        session.slots.landmarkIndex = 0;
        session.slots.lastLandmark = undefined;
      }
    }

    const lmList = session.slots.nearbyLandmarks ?? [];
    const idx = session.slots.landmarkIndex ?? 0;

    // Privacy protocol — ONLY after all 3 landmarks have been revealed.
    if (lmList.length > 0 && idx >= lmList.length) {
      // Exhaustion: after the 3 landmarks AND 2 protocol rounds, further
      // "во близина" asks get the polite shut-down — the neighborhood is
      // clear, the exact address comes on visit day. Bank-served so Gemini
      // variants accumulate over time (learned layer merges into the pool).
      // The round count is PER PROPERTY (protocolRoundFor): "во близина"
      // exhaustion on EB 76 must not deliver EB 50's round 2.
      const protoIdx = protocolRoundFor(session, p.eb);
      if (protoIdx >= 2) {
        return pickVariant('nearby.exhausted', { recent: assistantTexts(session) })
          ?? 'Мислам дека Ви е јасен реонот во кој се наоѓа недвижнината. Точната адреса ќе ја дознаете на ден на посетата.';
      }
      const protoLines = [
        'Точната адреса на недвижноста ја споделуваме два часа пред средбата, согласно политиките на Агенцијата.',
        'За безбедност на сопственикот, точната адреса се открива на денот на посетата — тоа е правило на Агенцијата.',
        'Агенцијата ги штити информациите за недвижноста. Точната адреса ќе ја дознаете кога ќе се договориме за термин.',
        'Заради приватноста на сопственикот, адресата се споделува само по закажување на посета. Дали би сакале да закажеме?',
      ];
      session.slots.addressProtocolIndex = protoIdx + 1;
      session.slots.landmarkIndex = idx + 1;
      return protoLines[protoIdx % protoLines.length];
    }

    // Landmark turns: idx=0→L1, idx=1→L2, idx=2→L3. If no rotation resolved,
    // fall back to the property's own landmark (feed/cache/enrichment).
    if (lmList.length > 0 || p.landmark) {
      const slot = lmList.length > 0 ? Math.min(idx, lmList.length - 1) : 0;
      const landmark = lmList.length > 0 ? lmList[slot] : (p.landmark ?? '');
      // THE FEED LANDMARK IS MEASURED, NEVER TRUSTED (the «што има во близина»
      // capture): the row's own `landmark` field was resolved at import under a
      // 100…1000 m ring, so a Кисела Вода гapсоњера carried «Црногорска
      // Амбасада» 3 km away — in ANOTHER municipality — and both the landmark
      // line and the «што има во близина» rotation named it as nearby. Only a
      // place MEASURED beyond the claim ring is denied: an UNMEASURABLE name
      // (no map in this deployment, a place the map does not carry) keeps the
      // line it always had — nothing to go on is not the same as nothing near.
      // The turn still counts as a ladder turn (the next exact ask must not
      // loop the same approximation).
      if (lmList.length === 0 && landmark) {
        const home = center.trusted && center.lat != null && center.lon != null
          ? { lat: center.lat, lon: center.lon } : undefined;
        const poi = this.landmarks?.findPlace(landmark, home);
        const claimM = home && poi && poi.lat != null && poi.lon != null
          ? distM(home.lat, home.lon, poi.lat, poi.lon)
          : undefined;
        if (claimM !== undefined && claimM > FEED_LANDMARK_MAX_M) {
          session.slots.landmarkIndex = idx + 1;
          return buildWhereIsAnswer(place ?? '', {
            address: p.address, location: p.location, eb: p.eb,
            business: p.business, landmark: undefined,
          });
        }
      }
      session.slots.landmarkIndex = idx + 1;
      // Remember WHICH anchor was just named: the next turn's "kade ima X? /
      // ne znam toa" is the client telling us this anchor means nothing, and
      // the ladder must answer with the NEXT landmark (never the fee pitch).
      if (landmark) session.slots.lastLandmark = landmark;
      const coords = session.slots.nearbyLandmarkCoords?.[slot];
      if (landmark) {
        // Find the landmark's coords/place link: rotation slots carry coords;
        // otherwise look it up in the offline map by name.
        // PLACE_ID REPAIR: sessions persisted before the identity map carry
        // coords-but-no-placeIds slots. When the slot lacks a place_id, look
        // the landmark up in the CURRENT map. That lookup supplies the SIGNED
        // point Google itself verified (a feed name like "Трговски Центар
        // Буњаковец" resolves to the Google row's own coordinates) — the link
        // is then the coordinate pin ([23:50] policy), and the place_id rides
        // along as the no-coordinate place-card fallback.
        let c = coords;
        let placeUrl: string | undefined;
        let placeId: string | null | undefined = session.slots.nearbyLandmarkPlaceIds?.[slot];
        if ((!c || !placeId) && this.landmarks) {
          // Center = the shown property: a chain name resolves to the NEAREST
          // branch (TTK Banka near Капиштец ≠ Ново Лисиче branch).
          const center = c ?? (session.slots.nearbyLandmarkCoords?.[0]) ?? undefined;
          const poi = this.landmarks.findPlace(landmark, center);
          if (poi) {
            if (!c) c = { lat: poi.lat, lon: poi.lon };
            placeUrl = poi.place_url ?? placeUrl;
            placeId = poi.place_id ?? placeId;
          }
        }
        const gmapsLine = c && Number.isFinite(c.lat) && Number.isFinite(c.lon)
          ? `\n${landmarkLink(landmark, placeId ?? null, c.lat, c.lon, placeUrl)}`
          : '';
        return `Тоа се наоѓа во близина на ${displayPlaceName(landmark)}.${gmapsLine}`;
      }
    }

    // Honest fallback — no landmark known: neighborhood-level answer, never
    // the exact street. This approximation COUNTS as a ladder turn (the
    // [15:57] contract: any served nearby answer advances the ladder, so the
    // next exact ask lands on the protocol instead of looping the same line).
    session.slots.landmarkIndex = (session.slots.landmarkIndex ?? 0) + 1;
    return buildWhereIsAnswer(place ?? '', {
      address: p.address, location: p.location, eb: p.eb,
      business: p.business, landmark: p.landmark,
    });
  }

  // THE 20:51 BUG — the where-is family has TWO dead ends, both ending in the
  // same visit-pitch line repeated forever:
  //   1. A NAMED property the feed no longer knows ("stanot so broj 77" →
  //      EB dropped from the feed): every lookup misses and the generic
  //      where-is answer lands on buildWhereIsAnswer('') — the visit pitch.
  //   2. NO property under discussion at all ("kade tocno se naogja?" in a
  //      fresh session): same pitch, and the client has no way to break the
  //      loop — they never realize the bot needs the Евидентен број.
  // Both now get an OUT: the not-found pivot (matching properties in the
  // named neighborhood) or the ask-for-the-number reply. The visit pitch is
  // served AT MOST ONCE per session — a repeat means the client asked again
  // and must get something actionable instead.
  // FEED-DOWN GUARD (EB-miss probe): `healthy` is false only when a fetch
  // failed and there was NEVER any data — zero rows is a healthy feed (an
  // empty portfolio is real data; a dead fetch is not). Every "EB not found"
  // decision MUST be gated on this: with no data we cannot know an EB is
  // gone, so we defer honestly instead of branding it a ghost.
  private feedHealthy(): boolean {
    return this.deps.properties.healthy;
  }

  private whereIsNoContext(session: ChatSession, userText: string): string {
    // 1) The client is asking about a SPECIFIC property. If the session ever
    //    saw an EB (named, interested, presented) and it is GONE from the
    //    feed → the honest not-found pivot with matches from that area.
    const eb = session.slots.propertyId ?? session.slots.interestedPropertyId
      ?? session.slots.lastGhostEb; // a just-served ghost is still THE topic — name it
    if (eb) {
      // FEED-DOWN GUARD: with zero data an "EB gone" verdict is a guess —
      // the outage line is the honest answer (a real property may be hiding
      // behind the dead feed). Same gate as the FSM ghost guards.
      if (!this.feedHealthy()) return FEED_UNAVAILABLE_LINE;
      return pickVariant('property.notfound', { recent: assistantTexts(session), vars: { eb: String(eb) } })
        ?? PROPERTY_NOT_FOUND_LINE(eb);
    }
    // 2) No property anchored at all — ask for the number. The pitch may
    //    appear once (the generic where-is fallback above already served it
    //    for the FIRST unanchored ask); repeating it is the loop. This line
    //    gives the client the actionable escape: name the Евидентен број.
    void userText;
    return 'Можам да Ви ги покажам ориентирите околу недвижноста — кажете ми само Евидентен број на станот (на пр. „станот со број 77“), или ако сакате, организирам посета.';
  }

  // ---------------- landmark (map place) reading ----------------

  /** Resolve a place the CLIENT named to the map's own POI. This is how a
   *  human reads a landmark the customer drops in passing (the [13:28]
   *  "PISUVASE DO BROZ KAFE"): not as a word to match exactly, but as a place
   *  on the map.
   *
   *  Order of attempts — the precise reference first, the permissive readings
   *  only after it:
   *    1. the phrase as typed ("Капитол Бисер");
   *    2. the OTHER script (a Latin tail the map stores Cyrillic, or the
   *       Cyrillic fold extractPoiWish returns for Latin input);
   *    3. the FIRST distinguishing token alone, and only for a 2-word
   *       mention: "BROZ KAFE" never matches the map's "Broz Cafe"
   *       word-by-word (phonetic k/c across two scripts), while "broz" finds
   *       the bar. A longer phrase carries its own context — a stray first
   *       token there would be a guess, so it stays unmatched and the funnel
   *       asks for details instead. */
  private resolvePlace(name: string | undefined): { name: string; lat: number; lon: number; place_url?: string; place_id?: string } | undefined {
    const clean = (name ?? '').trim();
    if (!this.landmarks || clean.length < 4) return undefined;
    const variants = (s: string): string[] => [s, translitToLatin(s), toCyrillic(s)];
    // CLAUSE PREFIXES: the extractor's capture is greedy, so a landmark typed
    // ahead of a second clause keeps it ("PISUVASE DO BROZ KAFE. BESE OKOLU
    // 200 000 EVRA" → "BROZ KAFE. BESE OKOLU"). The place is what stands
    // before the boundary, so the proper prefixes are tried in turn.
    const clauses = clean.split(/[.!?,;:]\s+/u).map(s => s.trim()).filter(Boolean);
    const tries: string[] = [...variants(clean)];
    for (let i = clauses.length - 1; i >= 1; i--) tries.push(...variants(clauses.slice(0, i).join(' ')));
    // DISTINCTIVE TOKEN — the first word of the first clause, when that clause
    // is a bare two-word reference ("BROZ KAFE"): it never matches the map's
    // "Broz Cafe" word-by-word (phonetic k/c across two scripts), while
    // "broz" alone finds the bar. Longer references keep their own context —
    // a stray first token there would be a guess, so they stay unresolved and
    // the funnel asks for details instead.
    const head = clauses[0].split(/\s+/).filter(Boolean);
    if (head.length === 2 && head[0].length >= 4) tries.push(...variants(head[0]));
    for (const t of tries) {
      const hit = this.landmarks.findPlace(t);
      // UNMENTIONED-WORD GUARD (the [10:28] capture): findPlace is a FUZZY
      // lookup, so an area the client named came back as the BUSINESS whose
      // name merely contains it — "kaj vas vo novo lisice" resolved to the post
      // office "ELS Novo Lisice", and the next turn served it as "баравте стан
      // во близина на ELS Novo Lisice": a landmark nobody had mentioned. The
      // map's own spelling therefore has to START with a word the client said
      // ("BROZ KAFE" → "Broz Cafe", "AVTOKOMANDA" → "Автокоманда"), while a
      // brand put in FRONT of the area ("ELS …") is refused. A client entering
      // a chain by its own word still resolves ("kaj TTK Banka" → "TTK Banka
      // Beverly Hills").
      if (hit && poiNameFollowsClientWords(clean, hit.name)) return hit;
    }
    return undefined;
  }

  /** The AREA a map place sits in, read from the feed's OWN rows — the bank is
   *  the agency's street knowledge here (the map carries no neighborhood
   *  polygons): Broz Cafe's neighbours are Центар rows, so a property
   *  "кај Broz Kafe" is assumed to be in Центар. The area is the most common
   *  neighborhood among the rows within AREA_DERIVE_M of the place (ties and
   *  the empty case fall back to the nearest row that has one). Beyond that
   *  radius nothing is assumed — a landmark two neighborhoods away is not
   *  evidence of an area. */
  private async areaAtPlace(point: { lat: number; lon: number; name?: string }): Promise<string | undefined> {
    try {
      const rows = await this.deps.properties.getAll();
      const near = rows
        .filter(p => typeof p.lat === 'number' && typeof p.lon === 'number' && p.lat !== 0 && p.lon !== 0 && !!p.location)
        .map(p => ({ loc: p.location as string, addr: (p.address ?? '').trim(), d: distM(point.lat, point.lon, p.lat as number, p.lon as number) }))
        .filter(x => x.d <= AREA_DERIVE_M)
        .sort((a, b) => a.d - b.d);
      if (near.length === 0) return undefined;
      // A PLACE THAT IS ITSELF AN AREA (the [20:56] replay): «Водно» is one of
      // the feed's own locations, so the rows tagged «Водно» ARE the answer —
      // the vote must not hand the settlement to a neighbouring tag and say
      // «кај Водно (Центар)», inventing a district for a place the bank names
      // as an area itself.
      if (point.name) {
        const wanted = placeLooseKey(normalizeLocation(point.name)).trim();
        const self = near.find(x => placeLooseKey(normalizeLocation(displayAreaName(x.loc))).trim() === wanted);
        if (self) return self.loc;
      }
      // THE ADDRESS EVIDENCE (the [11:07] capture): a row whose OWN ADDRESS names
      // the place IS the property at that place — the agency recorded it there —
      // so its area tag outranks the neighbours' vote. ТЦ Олимпико: EB 62 sits
      // 247 m away with address "Тц Олимпико" and area "Тафталиџе", while two
      // Карпош III rows inside the 1.5 km ring won the vote — the funnel then
      // told the client his house was in Карпош III and served the Тафталиџе
      // card in the same breath. A place the addresses do not name keeps the
      // vote below (a landmark is not evidence of the nearest row's area).
      const placeWords = new Set(placeLooseKey(normalizeLocation(point.name ?? ''))
        .split(/[^\p{L}\p{N}]+/u).filter(w => w.length >= 5));
      if (placeWords.size > 0) {
        for (const x of near) {
          if (!x.addr) continue;
          const addrWords = placeLooseKey(normalizeLocation(x.addr)).split(/[^\p{L}\p{N}]+/u);
          if (addrWords.some(w => placeWords.has(w))) return x.loc;
        }
      }
      const votes = new Map<string, number>();
      for (const x of near) votes.set(x.loc, (votes.get(x.loc) ?? 0) + 1);
      let best = near[0].loc;
      let bestVotes = 0;
      for (const [loc, n] of votes) {
        // Ties resolve to the NEAREST row's area (near is distance-sorted).
        const nearer = near[0].loc === loc;
        if (n > bestVotes || (n === bestVotes && nearer)) { best = loc; bestVotes = n; }
      }
      return best;
    } catch { return undefined; }
  }


  handle(channel: string, chatId: string, text: string, opts: HandleOpts = {}): Promise<void> {
    return new Promise(resolve => {
      this.enqueue(chatId, () => this.processMessage(channel, chatId, text, opts)).then(resolve);
    });
  }

  // ---------------- main message path ----------------

  /**
   * LEARNED SERVE — the closed loop at the TOP of the funnel: recall, else
   * generate ONCE and store, else fall through to the classifier.
   *
   * The runtime store (`bank_dynamic`) and the learned examples existed, but
   * they were only consulted inside escalate() — i.e. after every deterministic
   * lane had a chance to answer, which is why a stored answer almost never
   * served (four rows since September) and why a misroute never fed the loop.
   * This runs at the one seam where the turn is provably uncovered: the
   * deterministic pre-classify returned nothing (the fallthrough seam).
   *
   * RECALL is deliberately EXACT (+ word-bounded containment) and dynamic rows
   * only in the current FSM state: a stored answer may serve the phrasing it
   * was taught, never a reworded funnel question. GENERATE runs only behind
   * `shouldTryDynamic` — a real question, out of the protocol sub-funnel, and
   * never money/availability/contact traffic (those keys are frozen or
   * data-driven). A clean answer serves AND is stored immediately, so the next
   * occurrence is free; a dirty one stores nothing.
   */
  private async tryLearnedServe(session: ChatSession, text: string): Promise<boolean> {
    const bank = this.deps.bank;
    if (!bank || fsmRequired(text)) return false;
    const before = session.state;
    let reply: string | undefined;
    let source: string | undefined;
    let bankKey: string | undefined;
    try {
      const dyn = bank.retrieveDynamicExact(text, before);
      if (dyn && validateDynamicAnswer(dyn.answer).length === 0) {
        reply = dyn.answer; source = 'dynamic-recall'; bankKey = dyn.key;
      } else {
        const ex = bank.retrieveExact(text);
        if (ex) {
          const v = pickVariant(ex.key, { recent: assistantTexts(session) });
          if (v) { reply = v; source = 'bank'; bankKey = ex.key; }
        }
        // THE MISS → GENERATE + STORE half. Only for a genuine question the
        // deterministic stack could not route and the protocol sub-funnel does
        // not own; the answer has already passed the no-facts/hygiene gate and
        // is stored by dynamicAnswer before we serve it.
        if (!reply && shouldTryDynamic(session, text)) {
          const generated = await this.deps.responder.tryDynamic(session, text, bank);
          if (generated) { reply = generated.text; source = generated.source; bankKey = generated.key; }
        }
      }
    } catch { /* recall is advisory — fall through to the classifier */ }
    if (!reply || !source) return false;

    pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
    pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
    this.deps.sessions.set(session);

    console.log(`[timing] learned-recall state=${before} src=${source} bank=${bankKey}`);

    // The phrasing is still a DETECTOR gap (that is why we are here) — keep it
    // in the capture corpus so hardening can own it later, exactly as the
    // normal fallthrough path would.
    if (this.deps.capture) {
      try {
        this.deps.capture.onTurn({
          kind: 'fallthrough', text, state: before, at: new Date().toISOString(),
          chatId: session.chatId, replySource: source, bankKey,
        });
      } catch { /* advisory */ }
    }
    if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), source !== 'bank', source)) {
      try {
        this.deps.enrichment.insert({
          chatId: session.chatId, state: before, eventType: 'LEARNED_RECALL',
          userMsg: text, replyText: reply, replySource: source, bankKey,
        });
      } catch { /* advisory */ }
    }
    this.detGaveUp = false;
    await this.sendRaw(session, reply, source);
    return true;
  }

  private async processMessage(channel: string, chatId: string, text: string, opts: HandleOpts): Promise<void> {
    const pipelineStart = Date.now();
    // History helpers (presentCheaperBatch) read the raw message — set before
    // any early return that reaches the cheaper-search batch presentation.
    this.lastUserText = text;
    let session = this.deps.sessions.get(chatId) ?? freshSession(channel, chatId);
    session.channel = channel;

    if (session.state === 'terminated') {
      // A STRIKE-3 BAN IS FOREVER; A CANCELLATION RELEASES THE CHAT. Only the
      // ban paints `terminatedAt` (with the persistent blocklist behind it),
      // and only the ban is answered with silence.
      if (session.terminatedAt !== undefined) {
        if (isExpired(session, this.cfg.chatTtlMinutes)) {
          resetToIdle(session);
          this.deps.sessions.set(session);
        }
        return; // absolute silence
      }
      // POST-CANCEL RETURN (the [22:18] capture): the cancelling farewell is
      // not a farewell to the client. They came back — answer them. Their
      // words decide what the chat re-opens AS: continuing the cancelled visit
      // (re-book for the property whose visit was dropped) or a new enquiry
      // from a clean funnel. Either way the turn is PARSED below, never eaten;
      // a pure greeting gets the fresh greeting the reset arms.
      const cancelledEb = session.slots.propertyId ?? session.slots.interestedPropertyId;
      if (cancelledEb !== undefined
          && !isExpired(session, this.cfg.chatTtlMinutes)
          && continuesCancelledVisit(text)) {
        session.state = 'visit_scheduling';
        session.resetGreeting = false; // the return is the turn, not a greeting
      } else {
        resetToIdle(session);
      }
      this.deps.sessions.set(session);
    }

    // Persistent blocklist (strike-3, ANA parity): checked BEFORE the TTL reset
    // so a blocked chat can never be resurrected by expiry. Phone-backed only —
    // synthetic TUI/sim chatIds block nothing.
    if (this.blocklist.isBlocked(chatId, session.slots.phone)) return;

    // TTL expiry — resume or reset (the 22:18 bug). The visit offer sat on
    // the table past the TTL and the client answered "ORGABIZIRAJ MI" 73
    // minutes later; the old code reset the funnel to idle mid-close and the
    // message was eaten by the fresh greeting. Reset only from CLOSED states
    // (idle — nothing was offered yet). Mid-funnel states RESUME: keep
    // state/slots/history, just re-anchor with a short bridge line so the
    // client knows the offer is still live.
    // INTAKE RESUME (the [12:32] transcript): discovery/intent are ANSWER-
    // WAITING states — the client returning 3.5h later with "SO DVE SPALNI
    // SOBI DO 160000" is answering the pending intake questions, not starting
    // over. These states fall through to NORMAL PARSING (no reset, no bridge
    // return): the answer flows into the funnel exactly where it left off.
    // [01:17]/[01:20] OWNER PING-PONG: Lina relayed the owner's counter and
    // asked for a NEW term at 01:17 — 2h46m after the client's last inbound —
    // and his "cetvrtok togas?" 3 minutes later hit the 60-minute TTL measured
    // from that STALE inbound, so the resume bridge swallowed a legitimate
    // answer to the pending ask. HER outbound re-arms the exchange the same way
    // his reply re-arms hers (touchInbound resets the outbound budget): while
    // the last WITHIN-TTL outbound to the client is an open question, the
    // funnel stays open for an answer and the expiry NEVER bridges.
    const askStillLive = session.lastOutboundAt > 0
      && !!(Date.now() - session.lastOutboundAt < this.cfg.chatTtlMinutes * 60_000);
    if (isExpired(session, this.cfg.chatTtlMinutes)) {
      const funnelOpen = ['presentation', 'property_query', 'property_locate', 'closing',
        'contact_collection', 'visit_scheduling', 'owner_checking', 'time_confirm'].includes(session.state);
      const intakeOpen = session.state === 'discovery' || session.state === 'intent';
      // LOCATION IS NOT SMALL TALK (the [10:16] transcript): the client came
      // back 77 minutes later with "KAJ SE NAOGJA?" and the bridge swallowed
      // it — they asked where the flat is and were asked, again, whether to
      // organise a visit. The bridge exists to re-anchor traffic that needs
      // re-anchoring (an agreement, a visit command, a greeting); a where /
      // proximity ask is a BUSINESS question and must be ANSWERED. State and
      // slots are preserved either way, and a location ask never resets the
      // funnel, so the WHERE_IS lane below resolves the property the session
      // was already discussing.
      // Includes a bare proximity anchor ("IMA LI MARKT BLIZU?"): the anchor
      // also carries search traffic, and every one of those messages is the
      // continuation the bridge must not overwrite.
      const locationAsk = !!detectWhereIs(text) || detectExactAddressAsk(text)
        || hasProximityAnchor(text);
      if (funnelOpen && !locationAsk && !askStillLive) {
        touchInbound(session);
        // The TTL gap restarted the conversation socially — a fresh farewell
        // should thank again, so the second-bye swap never fires here.
        delete session.slots.byeServed;
        // Same for the exit final-check: a fresh session (a brand-new funnel)
        // gets the last-chance question again exactly once.
        delete session.slots.exitCheckServed;
        const bridge = pickVariant('session.resume', { recent: assistantTexts(session) })
          ?? 'Се враќаме на вашиот избор. Дали организираме посета?';
        pushHistory(session, { role: 'assistant', text: bridge }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, bridge, 'deterministic:resume');
        return;
      }
      if (funnelOpen || intakeOpen) {
        // The message is the continuation — parse it below, funnel intact
        // (state/slots/history all preserved).
        touchInbound(session); // re-anchor the TTL clock
        if (funnelOpen) {
          delete session.slots.byeServed;
          delete session.slots.exitCheckServed;
        }
        this.deps.sessions.set(session);
      } else {
        resetToIdle(session);
      }
    }

    if (session.resetGreeting) {
      session.resetGreeting = false;
      // A reset must never EAT a business message (the [12:32] transcript:
      // the intake answer disappeared into the fresh greeting). Consume the
      // turn with the greeting only when the text is itself a pure greeting —
      // or the reset came from strike-3 termination expiry (absolute-silence
      // neighbor: the greeting is the correct re-open there). A business
      // message after an ordinary reset is PROCESSED: the funnel restarts
      // from the message, not from zero.
      if (session.resetFromTerminated || GREETING_ONLY_RE.test(text.trim())) {
        touchInbound(session);
        const greeting = buildGreeting(session);
        pushHistory(session, { role: 'assistant', text: greeting }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, greeting);
        return;
      }
    }

    touchInbound(session);
    this.prefillViberPhone(session, channel, chatId);

    if (opts.kind !== undefined && opts.kind !== 'text') {
      pushHistory(session, { role: 'user', text: '[non-text message]' }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: NON_TEXT_REPLY }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, NON_TEXT_REPLY);
      return;
    }

    // 0-bis) MISROUTE INTAKE (A+B) — the system's eyes on wrong-key serves.
    // The previous logged pair is still the latest one here (the new reply
    // hasn't been produced yet), so this judges the PREVIOUS exchange with the
    // client's newest words: A) an explicit correction ("ne toa prasav")
    // auto-files the previous pair as a bank correction; B) a reply-class
    // mismatch (client answered outside every class the key expects) flags it
    // for the weekly review. Corrections → nightly loop-a → corpus → gates.
    // Best-effort: any failure must never break the funnel.
    try {
      const last = this.deps.enrichment?.latestForChat(chatId) ?? null;
      if (last) fileMisrouteCorrection(this.deps.bank, text, last);
    } catch { /* misroute intake is best-effort */ }

    // 0) Insult protocol (3 strikes, ANA parity): the DETERMINISTIC lexicon
    // scan runs BEFORE any other processing — an insult is a strike no matter
    // which brain is live (even the LLM-free path, where "DA SE EBETE VO
    // GAZOT" used to slip through as an agreement and close the deal). All
    // offenses escalate equally: 1 = warning, 2 = final warning, 3 = terminate
    // + permanent blocklist. Strike 1 decays on the next clean message; strike
    // 2 never decays. applyStrike is called on EVERY message (offenses strike,
    // clean messages decay).
    const offense = detectOffensive(text);
    const outcome = applyStrike(session, offense);
    if (outcome === 'none') {
      // Routing prediction log — the mirror in router.ts resolves which intent
      // WOULD fire; branch points below log the ACTUAL intent. Divergence
      // between [route?] and [route] in data/tui.log = the mirror drifted
      // from the real chain and needs updating.
      routeLog(chatId, text, resolveIntent(text, session.state), 'predict');
    }
    if (outcome !== 'none') {
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      if (outcome === 'terminate') {
        this.blocklist.add(chatId, offense.category ?? 'offensive_behavior', session.slots.phone);
        session.state = 'terminated';
        session.terminatedAt = Date.now();
        this.deps.sessions.set(session);
        console.error(`[EVENT] TERMINATE_SESSION ${JSON.stringify({ chatId, channel, strikes: session.strikes, reason: offense.reason })}`);
        // Ban notice (user-approved): the offender must KNOW they are banned.
        // One final line — everything afterwards stays absolute silence.
        const banNotice = 'Разговорот е завршен.';
        pushHistory(session, { role: 'assistant', text: banNotice }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, banNotice);
        return;
      }
      // Bank-backed warnings (warn.1/warn.2): same 3-strike protocol, varied
      // wording. Falls back to the exact code-built lines.
      const warning = pickVariant(`warn.${session.strikes}`, { recent: assistantTexts(session) })
        ?? OFFENSE_WARNINGS[session.strikes] ?? OFFENSE_WARNINGS[2];
      pushHistory(session, { role: 'assistant', text: warning }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, warning);
      return;
     }

    // PERSONAL LANE — the client asking about LINA HERSELF: her name, her age,
    // or paying her a compliment. Closed-class, deterministic, 0 ms. It runs
    // BEFORE the question gate because a genuine question (the age ask) would
    // otherwise reach the classifier and, on a miss, the dynamic
    // generate+store door — which is exactly how „Јас сум дигитален
    // асистент“ got written into bank_dynamic and served forever. The reply
    // keeps the funnel untouched: no state change, no slots, no enrichment
    // write, so the next business message continues where it left off.
    const personalAsk = detectPersonalAsk(text);
    if (personalAsk) {
      routeLog(chatId, text, `PERSONAL:${personalAsk}`);
      const reply = personalReply(personalAsk, assistantTexts(session));
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, reply, 'deterministic:personal');
      return;
    }

    // Agent attendance is an informational question, distinct from the fee
    // disclosure/visit-consent protocol. Handle before the broad visit detector
    // so a question about who attends cannot be interpreted as a request to
    // schedule and routed to frozen fee.ask.buy.
    if (detectAgentAttendanceAsk(text)) {
      const reply = pickVariant(AGENT_ATTENDS_VIEWING_KEY, { recent: assistantTexts(session) })
        ?? AGENT_ATTENDS_VIEWING_ANSWER;
      routeLog(chatId, text, 'AGENT_ATTENDANCE_ASK');
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic')) {
        try {
          this.deps.enrichment.insert({
            chatId, state: session.state, eventType: 'AGENT_ATTENDANCE_ASK',
            userMsg: text, replyText: reply, replySource: 'deterministic', bankKey: AGENT_ATTENDS_VIEWING_KEY,
          });
        } catch { /* advisory log */ }
      }
      await this.sendRaw(session, reply, 'deterministic:attendance');
      return;
    }

    // BUSINESS-SPACE BUDGET — the explicit deterministic route for a COMMERCIAL
    // price question in the intake states ("kolku cini deloven prostor vo
    // Centar?", "koja e cenata za lokal?"). Lina cannot quote a number she does
    // not have, and the residential lanes answer this with "колку спални…" /
    // "цената на станот" (wrong category). The route records the commercial
    // type plus the details the message itself carries, then serves the BUSINESS
    // budget question from its own key. State-gated: in property_query /
    // presentation / closing the flat on the table owns its price and the fee
    // protocol owns the money talk.
    if (detectBusinessBudgetAsk(text) && ['idle', 'intent', 'discovery'].includes(session.state)) {
      const carried = extractSlots(text);
      session.slots.business = true;
      if (carried.service) session.slots.service = carried.service;
      if (carried.sqm) session.slots.sqm = carried.sqm;
      // extractSlots does not resolve feed neighborhoods — ask the feed, or the
      // area named in the question is lost and the funnel asks for it again.
      if (!session.slots.location) {
        try {
          const loc = await this.areaNamed(text);
          if (loc) session.slots.location = loc;
        } catch { /* feed unavailable — the ask still stands */ }
      }
      session.state = 'discovery';
      const reply = pickVariant(BUSINESS_BUDGET_ASK_KEY, { recent: assistantTexts(session) })
        ?? BUSINESS_BUDGET_ASK_FALLBACK;
      routeLog(chatId, text, 'BUSINESS_BUDGET_ASK');
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic')) {
        try {
          this.deps.enrichment.insert({
            chatId, state: session.state, eventType: 'BUSINESS_BUDGET_ASK',
            userMsg: text, replyText: reply, replySource: 'deterministic', bankKey: BUSINESS_BUDGET_ASK_KEY,
          });
        } catch { /* advisory log */ }
      }
      await this.sendRaw(session, reply, 'deterministic:business-budget');
      return;
    }

    // Question gate: when the client asks a genuine question (investment opinion,
    // price comparison, fee debate, neighborhood advice, etc.), skip ALL
    // deterministic interceptors and fall through to the FSM classifier +
    // LLM responder. Each interceptor has its own exclusion guards (e.g.
    // detectInvestmentOpinion on PROPERTY_DESCRIPTION), but a question that
    // false-positives on one interceptor would never reach the LLM. This
    // single gate ensures question-intent messages reach the LLM where they
    // get proper context-aware handling + enrichment logging.
    // NOTE: service intents (sakam da kupam) and property descriptions (garsonjerata
    // kaj ambasada) are NOT caught here — they must still hit their fast paths.
    const skipInterceptors = isGenuineQuestion(text)
      && !detectService(text) && !detectBothServices(text)
      && !detectPropertyDescription(text)  // excluded — property descriptions need the fast path
      && !detectExactAddressAsk(text);    // excluded — exact address has its own WHERE_IS guard

    // Exact street/address questions are deterministic and NEVER disclose the
    // street. Both the EXACT_ADDRESS and WHERE_IS routes share one ladder:
    // first ask gets an approximate landmark; a repeated ask gets the agency
    // privacy rule. The detector chooses the route, not the response stage.
    // WHERE-IS DEFERRAL, refined (the [22:15] transcript): the old gate used
    // the whole detectWhereIs — but the where-is EXTENSION also fires on
    // exact-address phrases without any каде word ("TOCNATA ULICA I BROJ AKO
    // MOZE?" hits the 'kazete tochna adresa' stem family), so the SECOND ask
    // of the address ladder was served landmark rotation 2 instead of the
    // privacy protocol. Deferral now requires a REAL where/proximity anchor
    // (hasWhereWord): a каде word or близина/близу/околу/наспроти/спроти/тука.
    // Exact demands without them (улица и број / точната адреса families) ride
    // the same ladder in the EXACT_ADDRESS handler — turn 1 nearby, turn 2 the
    // day-of-visit protocol.
    if (detectExactAddressAsk(text) && !isKadeTocno(text)
      && !(detectWhereIs(text) && hasWhereWord(text)) && !skipInterceptors) {
      routeLog(chatId, text, 'EXACT_ADDRESS');
      // THE LOCATION LADDER: an EXACT-address demand is still a location ask.
      // Turn 1 resolves the property and gives ROTATION 1 ("во близина на
      // {landmark}") — the privacy protocol serves on the SECOND ask, when
      // the client has heard the area and insists. No anchor → the ask-for-EB
      // escape (same as the where-is no-context lane). This is the contract:
      // approximate location for every location lurker, agency protocol only
      // for the ones who push past it.
      const mbExact = await this.bindMention(text, session, { historyFallback: true });
      if (await this.sendIfClarify(mbExact, text, session)) return;
      const allExact = await this.deps.properties.getAll();
      const shownIdsExact = new Set(session.slots.presentedIds ?? []);
      const shownExact = allExact.filter(p => shownIdsExact.has(p.id));
      const ebInTextExact = (() => {
        const m = text.match(/\b(?:na|на)\s+(\d{1,4})\b/i);
        return m ? parseInt(m[1], 10) : undefined;
      })();
      // PINNED-EB STICKINESS (the [09:23] transcript): "koja mu e lokacijata
      // na 89?" explicitly binds the discussion to EB 89 — an EB NAMED IN A
      // RECENT MESSAGE outranks "the last item ever shown", so a follow-up
      // with no EB of its own ("tocnata adresa, ako moze?") still answers for
      // THE NAMED property, never for the tail of presentedIds. Budget/price
      // guard first: a number with a cap/currency word is not an EB (same
      // veto family as inferPropertyId).
      const pinnedEbExact = (() => {
        // Newest-first: a number in THIS message wins, then the last 3 user
        // messages (newest first). Budget-carrying numbers never pin.
        const candidates: number[] = [];
        if (ebInTextExact !== undefined) candidates.push(ebInTextExact);
        const bare = inferPropertyId(text);
        if (bare !== undefined && !detectBudget(text)) candidates.push(bare);
        const hist = session.history.filter(h => h.role === 'user');
        for (let i = hist.length - 1; i >= Math.max(0, hist.length - 3); i--) {
          const n = inferPropertyId(hist[i].text);
          if (n !== undefined && !detectBudget(hist[i].text)) candidates.push(n);
        }
        return candidates[0];
      })();
      const target = mbExact?.prop
        ?? (pinnedEbExact !== undefined
          ? await this.deps.properties.getByEb(pinnedEbExact).catch(() => undefined)
          : undefined)
        ?? (ebInTextExact
          ? await this.deps.properties.getByEb(ebInTextExact).catch(() => undefined)
          : undefined)
        ?? shownExact[shownExact.length - 1]
        ?? (session.slots.propertyId
          ? await this.deps.properties.getByEb(session.slots.propertyId)
          : undefined)
        ?? (session.slots.interestedPropertyId
          ? await this.deps.properties.getByEb(session.slots.interestedPropertyId)
          : undefined);
      let answer: string;
      if (target) {
        // Anchor + rotation state reset on switch (same contract as WHERE_IS).
        // The exact-insistence counter follows the ANCHOR: switching property
        // starts the ladder over for the new one.
        if (session.slots.propertyId !== target.eb && session.slots.interestedPropertyId !== target.eb) {
          session.slots.propertyId = target.eb;
          session.slots.nearbyLandmarks = undefined;
          session.slots.nearbyLandmarkCoords = undefined;
          session.slots.nearbyLandmarkPlaceIds = undefined;
          session.slots.nearbyLandmarkEb = undefined;
          session.slots.landmarkIndex = 0;
          session.slots.lastLandmark = undefined;
          session.slots.addressProtocolIndex = 0;
          session.slots.exactLocationTurns = 0;
        }
        // THE LADDER: turn 1 → rotation 1 (approximate location for every
        // lurker); turn 2 → the agency privacy protocol; turn 3+ → the polite
        // shut-down (nearby.exhausted). The counter lives on the session so a
        // nearby-ask between exact demands keeps the count. The TURN counts
        // approximate answers already served: a client who arrived via the
        // WHERE_IS rotation (landmarkIndex 1) and then insists bare (12:08
        // "AMA TOCNO , TOCNO") is on turn 2 — the protocol — not a second
        // landmark. COUNTER HYGIENE (the [09:23] transcript): the no-address
        // rung below answers WITHOUT walking the ladder — if it bumped the
        // turn, turn 2 (the protocol) would fire one rung early and the
        // client would never hear an approximate location first. So: when
        // THIS turn serves the no-address approximation, the turn stays 1.
        if (isAddressUnknown(target)) {
          const turnNoAddr = Math.max(session.slots.exactLocationTurns ?? 0, session.slots.landmarkIndex ?? 0) + 1;
          if (turnNoAddr <= 1) {
            // Count the rung: the NEXT exact ask must land on turn 2 (the
            // day-of-visit protocol), not re-serve the approximation forever.
            session.slots.exactLocationTurns = turnNoAddr;
            answer = `Недвижноста се наоѓа во населбата ${target.location!.replace(/\s*\(населба\)\s*$/u, '')}. Точната адреса ќе ја добиете на денот на посетата.`;
            pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
            pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
            this.deps.sessions.set(session);
            await this.sendRaw(session, answer);
            return;
          }
        }
        // All location questions use the same ordered ladder, including
        // "на која улица е?" and explicit address requests: first landmark,
        // second ask privacy protocol, later asks a polite close. The street
        // and number are never disclosed.
        const turn = Math.max(session.slots.exactLocationTurns ?? 0, session.slots.landmarkIndex ?? 0) + 1;
        session.slots.exactLocationTurns = turn;
        const protocolRound = protocolRoundFor(session, target.eb);
        if (turn >= 2 && protocolRound >= 1) {
          answer = pickVariant('nearby.exhausted', { recent: assistantTexts(session) })
            ?? 'Мислам дека Ви е јасен реонот во кој се наоѓа недвижнината. Точната адреса ќе ја дознаете на ден на посетата.';
        } else if (turn >= 2) {
          session.slots.addressProtocolIndex = protocolRound + 1;
          answer = buildExactAddressAnswer(assistantTexts(session));
        } else {
          answer = this.whereIsReply(target, session, text); // landmarkIndex++ inside
        }
      } else {
        answer = this.whereIsNoContext(session, text);
      }
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, answer);
      return;
    }

    // LANDMARK LADDER — "I DON'T KNOW THAT PLACE" (the 11:45 capture).
    // After Lina names an anchor, the client may answer "kade ima reptil
    // tamu?" / "ne znam toa" — they cannot picture it. The agency contract is
    // three steps: the NEXT nearby landmark, then the third, and after that
    // "the area is clear enough". Before this gate that message matched no
    // lane (findPlace missed the "ima reptil tamu" capture and detectWhereIs
    // was undefined), so it fell into the closing state and got the VISIT-FEE
    // pitch — a non-sequitur on a location question. Never a fee line while
    // the client is still asking WHERE.
    // A DISTANCE question is never an „I don't know that place“ answer, even
    // when it names one of the rotation's anchors ([16:11]: „NA KOLKAVO
    // RASTOJANIE E STANOT OD LJUBEN LAPE?“ named L2 and the ladder advanced to
    // L3 instead of measuring). The measurement lane below owns these.
    if (session.slots.lastLandmark && !isDistanceQuestion(text)) {
      const lmList = session.slots.nearbyLandmarks ?? [];
      // The client may name the anchor just served OR any of the property's
      // rotation anchors (the live 11:45 transcript asked about the FIRST one
      // after an exact-address turn sat between them). A BARE "ne znam toa"
      // only counts right after a landmark line, so ordinary chat is untouched.
      const anchors = [...new Set([session.slots.lastLandmark, ...lmList])];
      const lastLine = assistantTexts(session).slice(-1)[0] ?? '';
      // Mention REQUIRED for the named leg (the [22:27] TUI): a bare ignorance
      // cue with no anchor ("pa ne znam" answering a fee ask) must not rotate
      // — only a message that NAMES an anchor counts here; the bare cue keeps
      // its own after-landmark-line gate below.
      const named = anchors.some(n => mentionsLandmark(text, n) && detectUnknownLandmark(text, n));
      const bareAfterLandmark = /во\s+бли[зж]ин/u.test(lastLine)
        && detectUnknownLandmark(text, session.slots.lastLandmark);
      const idx = session.slots.landmarkIndex ?? 0;
      // The ladder's terminal state: once all three anchors are named, a
      // nearby/area ask ("sto uste ima vo reonot?" — the [11:50] capture) is
      // answered with the "clear enough" close. It used to fall through to the
      // availability ack because no detector owns the word "reon".
      const areaAsk = lmList.length > 0 && idx >= lmList.length
        && /во\s+бли[зж]ин/u.test(lastLine)
        && (mentionsMore(text) || /(?:реон|близин|близу|околу|reon|blizin|blizu|okolu)/iu.test(text));
      if (named || bareAfterLandmark || areaAsk) {
        const ladderEb = session.slots.propertyId ?? session.slots.interestedPropertyId
          ?? session.slots.presentedIds?.[session.slots.presentedIds.length - 1];
        const ladderProp = ladderEb != null
          ? await this.deps.properties.getByEb(ladderEb).catch(() => undefined)
          : undefined;
        if (ladderProp) {
          // L2 / L3, or — all three already named — the polite shut-down.
          const answer = lmList.length > 0 && idx < lmList.length
            ? this.whereIsReply(ladderProp, session, text)
            : pickVariant('nearby.exhausted', { recent: assistantTexts(session) })
              ?? 'Мислам дека Ви е доволно јасно за локацијата. Точната адреса ќе ја дознаете на ден на посетата.';
          routeLog(chatId, text, 'LANDMARK_LADDER');
          pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
          pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
          this.deps.sessions.set(session);
          await this.sendRaw(session, answer);
          return;
        }
      }
    }

    // GONE → SIMILAR ALTERNATIVES (the [12:08] capture). The sold-property
    // notice asks „Дали би сакале да Ви понудам нешто друго со слични
    // карактеристики?" — this turn answers it. YES serves the next PAIR on the
    // GONE property's own profile (rooms, area, a price band around its price);
    // the normal presentation ladder then carries the rest of the pairs until
    // the client chooses or changes criteria/neighborhood. The offer is
    // one-shot: ANY answer consumes it, so a stale "yes" can never fire later.
    const goneEb = session.slots.goneAlternativesEb;
    if (goneEb !== undefined) {
      session.slots.goneAlternativesEb = undefined;
      const goneYes = detectAgreement(text) || detectSuggestAlternatives(text)
        || detectSeeOffers(text) || detectMoreOptions(text);
      const goneNo = detectSoftRefusal(text) || detectBye(text) || detectNegatedAgreement(text);
      if (goneYes && !goneNo) {
        const goneProp = await this.deps.properties.getByEb(goneEb).catch(() => undefined);
        if (goneProp) {
          // LOCK TO THE GONE PROPERTY'S PROFILE. Rooms and area come from the
          // row itself; the budget is a band around ITS price (+15 %) rather
          // than the earlier search ceiling — a client who was looking at
          // 92.000 is shown the 85–106k cohort, closest first (candidates()
          // orders by distance to the budget).
          session.slots.service = goneProp.service ?? session.slots.service;
          session.slots.location = goneProp.location ?? session.slots.location;
          session.slots.bedrooms = goneProp.bedrooms;
          session.slots.bedroomsMin = undefined;
          session.slots.bedroomsMax = undefined;
          session.slots.bedroomsAlt = undefined;
          session.slots.garsonjera = goneProp.studio ? true : undefined;
          session.slots.business = goneProp.business ? true : undefined;
          session.slots.house = goneProp.house ? true : undefined;
          session.slots.plac = goneProp.plac ? true : undefined;
          session.slots.yard = undefined;
          session.slots.budget = goneProp.price === undefined
            ? undefined
            : `до ${Math.round(goneProp.price * 1.15)} евра`;
          // Fresh pair ladder for these criteria (the old one belonged to the
          // previous search and would serve unrelated rows).
          session.slots.ladderKey = undefined;
          session.slots.ladderQueue = [];
          session.slots.alternativesExhausted = false;
          session.slots.areaExhausted = false;
          session.state = 'presentation';
          const similar = await this.loadProps(session, false, false);
          let answer: string;
          if (similar.length > 0) {
            // Cards without the bank opener/closer: this turn has its OWN intro
            // and its OWN "more options?" closer. buildPropertyCards would add
            // a second closer ("…дали да организираме посета?") and the client
            // would read two different questions in one reply.
            answer = 'Секако. Еве ги сличните недвижности што ги имам:\n\n'
              + similar.map(p => buildPropertyCard(p)).join('\n\n')
              + '\n\nДали некој од овие Ви одговара? Ако не, веднаш ќе Ви покажам уште опции.';
          } else {
            // Nothing in the band: offer the widen NOW (areaExhausted arms the
            // existing pivot) instead of leaving the client without an answer.
            session.slots.areaExhausted = true;
            const loc = session.slots.location ? ` во ${session.slots.location}` : '';
            answer = `За жал, во моментов немам друга слична недвижност${loc}. Дали да погледнеме во друга населба?`;
          }
          pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
          pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
          this.deps.sessions.set(session);
          await this.sendRaw(session, answer);
          return;
        }
      }
      // NO (or a new search / criteria change): fall through to the normal
      // lanes — the funnel continues, the offer is already consumed.
    }

    // WHERE-THE-LANDMARK-IS — the [12:48] push-back ("KADE TI E TOA 26 JULI
    // TC ?"): the client asks where a PLACE Lina herself named is located.
    // The number inside the place name ("ТЦ 26 Јули") must never read as an
    // Евидентен број — resolved against the offline map, answered with the
    // honest distance/direction line, and the discussed property stays
    // anchored. No map hit → an honest "не е во нашата евиденција" that talks
    // about the PLACE, never pretending a property was meant.
    if (isWhereLandmarkQuestion(text)
      && !detectAreaHaveAsk(text)
      && !detectPriceAsk(text) && !detectBudget(text)
      && !detectService(text) && !detectBothServices(text)) {
      const placeName = extractWhereLandmarkPlace(text);
      const anchorEb = session.slots.propertyId ?? session.slots.interestedPropertyId
        ?? session.slots.presentedIds?.[session.slots.presentedIds.length - 1];
      const anchorProp = anchorEb != null
        ? await this.deps.properties.getByEb(anchorEb).catch(() => undefined)
        : undefined;
      if (placeName && this.landmarks && anchorProp?.lat != null && anchorProp?.lon != null) {
        const hit = this.landmarks.findPlace(placeName, { lat: anchorProp.lat, lon: anchorProp.lon });
        if (hit) {
          let answer: string;
          if (anchorProp.lat != null && anchorProp.lon != null) {
            const d = Math.round(distM(anchorProp.lat, anchorProp.lon, hit.lat, hit.lon));
            const distPhrase = d < 1000 ? `${Math.max(10, Math.round(d / 10) * 10)} метри` : `${(d / 1000).toFixed(1).replace('.', ',')} километри`;
            const prep = locPrep(anchorProp.location ?? '');
            answer = `${hit.name} се наоѓа на ${distPhrase} од недвижноста што ја разгледуваме${anchorProp.location ? ` (${prep} ${anchorProp.location.replace(/\s*\([^)]*\)\s*$/u, '')})` : ''}. Точната адреса на недвижноста се открива на денот на посетата.`;
          } else {
            answer = `Тоа е ориентир во градот — недвижноста што ја разгледуваме е ${locPrep(anchorProp.location ?? '')} ${anchorProp.location}.`;
          }
          session.slots.location = anchorProp.location ?? session.slots.location;
          routeLog(chatId, text, 'WHERE_LANDMARK');
          pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
          pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
          this.deps.sessions.set(session);
          await this.sendRaw(session, answer, 'deterministic');
          return;
        }
      }
      // Map miss / no anchor: fall through. isWhereLandmarkQuestion text also
      // carries каде, so the WHERE_IS lanes below answer it with property
      // context; inferPropertyId no longer binds the place-name number.
    }

    // ── DISTANCE TO A NAMED PLACE (the [22:25] capture) ─────────────────────
    // „KOLKU IMA OD STANOT DO BUNJAKOVEC TRGOVSKI?“ — how far is the discussed
    // property from a place the client names. This is neither a каде ask (so
    // the WHERE_LANDMARK lane above never saw it) nor a property lookup: the
    // classifier read „STANOT“ as PROPERTY_ID_REQUESTED and answered with the
    // property CARD, which tells the client nothing about the distance they
    // asked for.
    //
    // The place is resolved by the geo engine (findPlace, which bridges script,
    // word order AND language: „BUNJAKOVEC TRGOVSKI“ ≡ „Shopping Center
    // Bunjakovec“) and measured from the property's OWN coordinates — the same
    // distance line the where-is lane serves. A map miss or an unanchored
    // session falls through untouched: the code answers only what it can
    // measure, never an invented number.
    if (isDistanceQuestion(text)
      && !detectService(text) && !detectBothServices(text)) {
      const placeName = extractDistancePlace(text);
      // Anchor: the property on the table. An EB named a turn or two ago still
      // owns the conversation — read straight from the history, because
      // inferPropertyId() deliberately VETOES any text containing каде/наоѓа
      // (it guards the landmark lane), and the turn before this one is exactly
      // that („KADE VI SE NAOGJA EV BR 70?“). The local regex understands the
      // EB spellings (EB/EV/ЕВ + бр/br/број).
      const histEb = (() => {
        for (const h of [...session.history].reverse()) {
          if (h.role !== 'user') continue;
          const m = h.text.match(/\b(?:ev|eb|ев|еб)\s*(?:br|бр|broj|број)?\.?\s*(\d{1,3})\b/iu)
            ?? h.text.match(/\b(?:na|на)\s+(\d{1,3})\b/iu);
          if (!m) continue;
          const n = parseInt(m[1], 10);
          if (n >= 10 && n <= 999) return n;
        }
        return undefined;
      })();
      const anchorEb = session.slots.propertyId ?? session.slots.interestedPropertyId
        ?? session.slots.presentedIds?.[session.slots.presentedIds.length - 1]
        ?? histEb;
      const anchorProp = anchorEb != null
        ? await this.deps.properties.getByEb(anchorEb).catch(() => undefined)
        : undefined;
      // THE REAL LOCATION — resolveSearchCenter, never the raw feed column.
      // A stored pin can disagree with the trusted building point by hundreds
      // of metres (the EB 70 class), and a distance measured from a damaged
      // pin is a fabricated number even when the arithmetic is right. The
      // resolver also repairs that pin (map anchor wins over a mismatched
      // stored point) and reports trust, which decides the wording below.
      const center = anchorProp
        ? resolveSearchCenter({
          id: anchorProp.id, eb: anchorProp.eb, address: anchorProp.address,
          lat: anchorProp.lat, lon: anchorProp.lon,
          geo_source: anchorProp.geo_source ?? null,
        } as PropertyRow)
        : undefined;
      const hasPoint = !!center && Number.isFinite(center.lat) && Number.isFinite(center.lon)
        && !(center.lat === 0 && center.lon === 0);
      if (placeName && anchorProp && center && hasPoint) {
        const hit = this.landmarks.findPlace(placeName, { lat: center.lat, lon: center.lon });
        if (hit) {
          const d = Math.round(distM(center.lat, center.lon, hit.lat, hit.lon));
          const distPhrase = d < 1000
            ? `${Math.max(10, Math.round(d / 10) * 10)} метри`
            : `${(d / 1000).toFixed(1).replace('.', ',')} километри`;
          // „околу“ only when the point is not a trusted building: a
          // street-centroid/geocode point is a estimate and must say so.
          const approx = center.trusted ? '' : 'околу ';
          const prep = locPrep(anchorProp.location ?? '');
          // Walking time only when it is honest (a real walk, not a 3-hour
          // one) AND the start point is trusted — never a minute figure built
          // on an estimate.
          const mins = walkMinutes(d);
          const walk = center.trusted && d >= 100 && d <= 2000 ? ` (околу ${mins} минути пешки)` : '';
          const answer = `${hit.name} се наоѓа на ${approx}${distPhrase}${walk} од недвижноста што ја разгледуваме${anchorProp.location ? ` (${prep} ${anchorProp.location.replace(/\s*\([^)]*\)\s*$/u, '')})` : ''}. Точната адреса на недвижноста се открива на денот на посетата.`;
          session.slots.location = anchorProp.location ?? session.slots.location;
          routeLog(chatId, text, 'DISTANCE');
          pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
          pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
          this.deps.sessions.set(session);
          await this.sendRaw(session, answer, 'deterministic');
          return;
        }
      }
      // No place / no anchor / map miss → the chains below keep the turn.
    }

    // ── MARKET MEMORY — a recall of an OLD agency listing ([02:00]:
    // „ИМАШЕчЕ ЕДНА КУчА ПРЕД НЕКОЕ ВРЕМЕ КАЈ ВАС КАЈ ОЛИМПИКО ОКОЛУ 400 ЕВРА
    // КИРИЈА / ДАЛИ Е СЛОБОДНА МОМЕНТАЛНО?”). The rent noun + the ask shape
    // made the mirror predict MARKET_PRICE, but the market arm's own capture
    // failed („Олимпико” is a landmark, not a feed area; „куќа” is singular;
    // the rent-only guard keeps bare rent words with the property lane) — so
    // the turn fell through to the discovery funnel and the client was asked
    // „Кој дел од градот Ви е најпривлечен?” about a house the agency itself
    // once listed. The ack here is HONEST by construction: the old offer is
    // NOT in the feed, so the serve admits the archive, never quotes the
    // remembered figure as a live one, and pivots to the current search — the
    // recollected type/segment/amount land in slots so the confirmation
    // „Да” runs a real filtered offer.
    if (detectMarketMemoryAsk(text) && inferPropertyId(text) === undefined) {
      routeLog(chatId, text, 'MARKET_MEMORY');
      const noun = memoryTypeNoun(text);
      const amount = memoryAmountText(text);
      const rent = memoryRentSegment(text);
      if (rent) session.slots.service = 'rent';
      if (noun === 'куќа') session.slots.house = true;
      else if (noun === 'деловен простор' || noun === 'локал') session.slots.business = true;
      else if (noun === 'гарсоњера') session.slots.garsonjera = true;
      if (amount) session.slots.budget = amount;
      // LIVE CHECK BEFORE THE ARCHIVE VERDICT (the [20:56] capture): „КАЈ
      // ОЛИМПИКО ОКОЛУ 400 ЕВРА БЕШЕ“ was answered with „таа куќа беше стара
      // понуда од нашата архива и веќе не е активна кај нас“ — while EB 62 sat
      // in the live feed, same place, same category, 450 евра. Declaring our
      // OWN live listing archived is the worst kind of wrong: it invents an
      // absence. The recall is therefore verified against the bank FIRST —
      // place + category + segment, ranked from the place, price remembered as
      // a band — and only a recall with no live match keeps the archive line.
      const recalledPlace = this.resolvePlace(session.slots.poiAnchor)
        ?? extractPoiWishCandidates(text, { withCriteria: true })
          .map(c => this.resolvePlace(c)).find(Boolean);
      if (recalledPlace) {
        const recalledArea = session.slots.location
          ?? await this.areaAtPlace({ lat: recalledPlace.lat, lon: recalledPlace.lon, name: recalledPlace.name });
        const recalledPrice = amount ? Number(String(amount).replace(/[^\d]/g, '')) : undefined;
        const distTo = (p: Property): number => (typeof p.lat === 'number' && typeof p.lon === 'number'
          && p.lat !== 0 && p.lon !== 0)
          ? distM(recalledPlace.lat, recalledPlace.lon, p.lat, p.lon) : Number.POSITIVE_INFINITY;
        const live = (await this.deps.properties.closestMatches({
          location: recalledArea,
          house: noun === 'куќа' ? true : undefined,
          business: (noun === 'деловен простор' || noun === 'локал') ? true : undefined,
          plac: noun === 'плац' ? true : undefined,
          service: rent ? 'rent' : session.slots.service,
          price: recalledPrice,
        }))
          .filter(p => distTo(p) <= LANDMARK_NEAR_M)
          .sort((x, y) => distTo(x) - distTo(y)
            || (recalledPrice === undefined ? 0
              : Math.abs((x.price ?? Number.POSITIVE_INFINITY) - recalledPrice)
                - Math.abs((y.price ?? Number.POSITIVE_INFINITY) - recalledPrice))
            || x.eb - y.eb)
          .slice(0, 2);
        if (live.length > 0) {
          session.slots.poiAnchor = recalledPlace.name;
          if (recalledArea) { session.slots.location = recalledArea; session.slots.poiArea = recalledArea; }
          session.slots.presentedIds = [...new Set([...(session.slots.presentedIds ?? []), ...live.map(p => p.id)])];
          session.slots.currentBatch = live.map(p => p.id);
          session.state = 'presentation';
          const disclaimed = (session.history ?? []).filter(h => h.role === 'user').slice(-8)
            .some(h => EB_DISCLAIM_RE.test(h.text));
          const answer = `${buildLocateLandmarkEntry(recalledPlace.name, recalledArea, session.slots, live.length)}\n\n${buildLocateMatches(live, session.history.length, !disclaimed)}`;
          pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
          pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
          this.deps.sessions.set(session);
          await this.sendRaw(session, answer, 'deterministic');
          return;
        }
      }
      const plural: Record<string, string> = {
        'куќа': 'куќи', 'стан': 'станови', 'гарсоњера': 'гарсоњери',
        'локал': 'локали', 'деловен простор': 'деловни простори', 'понуда': 'понуди',
      };
      const pluralType = plural[noun ?? 'понуда'] ?? 'понуди';
      const tail = `Дали сакате да Ви покажам тековни ${pluralType}`
        + `${rent ? ' на изнајмување' : ''}${amount ? ` до ${amount} евра` : ''}?`;
      const answer = `${noun ? `Таа ${noun}` : 'Тоа'} беше стара понуда од нашата архива и веќе не е активна кај нас. ${tail}`;
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, answer, 'deterministic');
      return;
    }

    // ── MARKET PRICE LEVELS (the [16:57] capture) ───────────────────────────
    // „KAZI MI KAKO SE DVIZAT CENIVE ZA STANOVI VO AERODROM?“ — how do FLAT
    // prices move in a neighborhood. No lane owned it, so it fell into the
    // funnel start and the client was asked buy-or-rent. The answer is the
    // MEASURED €/m² band of the feed's own rows for that category in that
    // area — never a market statistic we cannot see, never a property card.
    //
    // Segment: a funnel that already declared buy/rent keeps its segment; a
    // cold ask uses the segment the matching rows actually have (sale when
    // both exist — a mixed band would compare a monthly rent to a sale price).
    // Guards: a named property (EB) owns its lane; an anchored funnel asking
    // about ITS flat without naming an area ("kako e cenata za m2?") keeps the
    // property-price lane; "both services" (buy-or-rent) is a funnel answer,
    // not a market ask.
    // A SERVICE WORD is NOT a veto any more: „цените за ИЗНАЈМУВАЊЕ на станови
    // во Аеродром“ IS the market question, and the declared service simply
    // selects the segment (rent) for the measurement. Before this, the rent
    // wording fell into the funnel and asked „на кој дел од градот?“.
    if (detectMarketPriceAsk(text)
      && !detectBothServices(text)
      && inferPropertyId(text) === undefined) {
      const feedLocs = await this.areaLocs(text);
      // CITY ASK — „kako odat cenite za stanovite VO SKOPJE“ is the WHOLE-city
      // band: a client from another city asking about Skopje is not asking
      // about whatever area this funnel happened to hold, so the session area
      // must NOT be inherited here.
      const cityAsk = /(?<![\p{L}\p{N}])(?:скопје|skopje|skopju|скопју)(?![\p{L}\p{N}])/iu.test(text);
      // The area named IN THE MESSAGE wins; otherwise the funnel's own area
      // carries over ("A KOJA E CENATA PO KVADRAT?" right after the Аеродром
      // ask is still about Аеродром — the first turn stored it).
      // NUMBERED SUB-AREAS ARE THEIR OWN AREA („KARPOS 2“): the client's numeral
      // is bound to the place word and canonicalized against the feed, because
      // detectLocation() returns only the bare family name („Карпош“) for
      // „KARPOS 2“ — which would measure all of I–IV under one label.
      const numbered = numberedAreasNamed(text, feedLocs);
      const areaRaw = cityAsk ? undefined
        : numbered.length > 0 ? numbered.join(', ')
          : ((await this.areaNamed(text)) ?? session.slots.location);
      const pluralType = hasMarketTypePlural(text);
      const anchoredEb = session.slots.propertyId ?? session.slots.interestedPropertyId;
      // A RENT noun alone („колку му е киријата?“, „kolku mu e renta?“) is a
      // question about the flat on the table: it opens the band only when the
      // message NAMES an area or the category in the plural. Without this the
      // rent word sent the shown flat's price question into a city band.
      const rentOnlyAsk = isMarketRentWordAsk(text);
      const areaInMessage = cityAsk || numbered.length > 0 || (await this.areaNamed(text)) !== undefined;
      if (areaInMessage || pluralType || (anchoredEb === undefined && !rentOnlyAsk)) {
        const slots = extractSlots(text);
        const isLand = !!slots.plac;
        const typeOk = (p: Property): boolean => isLand
          ? !!p.plac
          : slots.business ? !!p.business
            : slots.house ? !!p.house
              : !p.business && !p.house && !p.plac;
        // TOPIC rows = every offer of the asked category with a price, whether
        // or not it has a surface. A row WITHOUT м² is still an offer — the
        // band cannot measure it, but the reply must say „немам доволно
        // податоци“ rather than the false „немам понуди“.
        const topicRows = (await this.deps.properties.getAll()).filter(p =>
          typeOk(p) && typeof p.price === 'number' && p.price > 0);
        const allRows = topicRows.filter(p => typeof p.sqm === 'number' && p.sqm > 0);
        // rowsInArea(): a numbered sub-area is matched EXACTLY (digits, roman
        // and ordinal words all normalize), so „Карпош II“ can never absorb
        // „Карпош III“ rows; everything else keeps the fuzzy place matcher.
        const inArea = (area: string): Property[] => rowsInArea(allRows, area);
        /** Offers of the topic in the area — the honest answer to „има ли
         *  воопшто понуди?“, independent of whether they carry м². */
        const hasRowsIn = (area: string): boolean => rowsInArea(topicRows, area).length > 0;
        const fmt = (n: number): string => n >= 1000
          ? n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
          : String(n);
        // TWO METRICS: SALE is quoted per m² (the unit a buyer negotiates in),
        // RENT is quoted as the MONTHLY price — a „8 евра за м²“ rent band means
        // nothing to a tenant ([17:34] follow-up: rents read as totals).
        const typePlural = isLand ? 'плацови' : slots.business ? 'деловни простори' : slots.house ? 'куќи' : 'станови';
        // A band carries HOW MANY rows back it: one row is a listing, not a
        // price level, and the thin feed (45 active rows) makes that common
        // (Аеродром rent = one row; Карпош = one row). The caller says so
        // instead of dressing a single offer up as a market range.
        type BandInfo = { text: string; n: number; lo: number; hi: number; unit: string };
        const bandFor = (area: string | undefined): BandInfo | undefined => {
          const rows = (area ? inArea(area) : allRows).filter(p => p.service === segment);
          // €/m² is computed by pricePerM2() — a SALE row without м² contributes
          // NO value (never price/1), so one bad row cannot stretch the band.
          const values = (segment === 'rent'
            ? rows.map(p => p.price as number)
            : rows.map(p => pricePerM2(p)))
            .filter((v): v is number => typeof v === 'number')
            .sort((a, b) => a - b);
          if (values.length === 0) return undefined;
          const lo = values[0];
          const hi = values[values.length - 1];
          if (segment === 'rent') {
            // The period word is READ OFF the feed's own figures (rentUnitWord):
            // the feed has no period column, so a band may only say „месечно“
            // when every rent figure in it is monthly-sized. A per-day number
            // in the band makes the reply state the amount without the period.
            const unit = rentUnitWord(rows) ? 'евра месечно' : 'евра';
            const money = unit === 'евра' ? 'евра (единицата не е наведена во огласот)' : unit;
            const text = lo === hi
              ? (values.length === 1
                ? `единствената активна понуда во моментов е ${fmt(lo)} ${money}`
                : `цените за изнајмување на ${typePlural} се околу ${fmt(lo)} ${money}`)
              : `цените за изнајмување на ${typePlural} варираат од ${fmt(lo)} до ${fmt(hi)} ${money}`;
            return { text, n: values.length, lo, hi, unit };
          }
          const text = lo === hi
            ? (values.length === 1
              ? `единствената активна понуда во моментов е ${fmt(lo)} евра за м²`
              : `цените се околу ${fmt(lo)} евра за м²`)
            : `цените варираат од ${fmt(lo)} до ${fmt(hi)} евра за м²`;
          return { text, n: values.length, lo, hi, unit: 'евра за м²' };
        };
        // The sentence a band becomes in an area (one row is stated AS one row).
        const bandSentence = (label: string, b: BandInfo): string =>
          b.n === 1
            ? `Во ${label}, во моментов имаме една активна понуда: ${fmt(b.lo)} ${b.unit}`
            : `Во ${label}, ${b.text}`;
        const familySentence = (base: string, b: BandInfo): string =>
          b.n === 1
            ? `За целата населба ${base} во моментов имаме една активна понуда: ${fmt(b.lo)} ${b.unit}`
            : `За целата населба ${base} ${b.text}`;
        // ONE BAND PER AREA ([17:34]): „KARPOS ILI CENTAR“ is TWO answers — the
        // merged sentence (1.286–2.889) described neither neighborhood. The
        // area string detectLocation returns is comma-joined, so it splits back
        // into the areas the client actually named (or the session's).
        // „KARPOS“ means the whole family (I/II/III/IV): the feed's canonical
        // „Карпош III“ is a SUB-AREA, so a bare ask groups it under „Карпош“.
        // Only an explicitly numbered area („KARPOS 2“) stays narrow.
        const family = (loc: string): string => {
          const bare = loc.replace(/\s*\([^)]*\)\s*/gu, ' ').trim();
          // The client NAMED a number → each is its own area with its own band.
          // Otherwise a stored „Карпош III“ answers for the whole family (the
          // [17:34] rule: a bare KARPOS ask covers I–IV).
          if (numbered.length > 0) return bare;
          return bare.replace(/\s+(?:I{1,3}V?|IV|[1-4])\s*$/u, '').trim();
        };
        const areaNames = [...new Set((areaRaw ?? '').split(/,\s*/u).map(s => s.trim()).filter(Boolean).map(family))];
        // The FAMILY a numbered area belongs to („Карпош I“ → „Карпош“). Used
        // for ONE widening: a numbered area with NO offers at all falls back to
        // the family band, LABELLED as the family — never silently passed off
        // as the numbered area's own price.
        const familyBaseOf = (loc: string): string | undefined => {
          const bare = loc.replace(/\s*\([^)]*\)\s*/gu, ' ').trim();
          if (!isNumberedArea(bare)) return undefined;
          return bare.replace(/\s+(?:I{1,3}V?|IV|[1-4])\s*$/u, '').trim() || undefined;
        };
        const familyBandFor = (loc: string): BandInfo | undefined => {
          const base = familyBaseOf(loc);
          return base && base !== loc ? bandFor(base) : undefined;
        };
        // Reply order follows the client's own sentence („KARPOS ILI CENTAR“).
        const at = (s: string): number => {
          const i = text.toLowerCase().indexOf(s.toLowerCase());
          return i < 0 ? Number.MAX_SAFE_INTEGER : i;
        };
        areaNames.sort((a, b) => at(a) - at(b));
        // The SEGMENT is chosen once for the whole reply (a funnel that
        // declared buy/rent keeps it; a cold ask uses what the asked scope
        // actually holds — a mixed band would compare a monthly rent to a sale
        // price). Areas are then measured inside that segment.
        // A numbered area with no rows of its own still shares the FAMILY's
        // segment (the band it will fall back to). Without this the empty
        // sub-area left the segment to guess „rent“ and the family band the
        // reply was about to quote came back empty.
        const scopeRows = areaNames.length > 0
          ? areaNames.flatMap(a => {
            const own = inArea(a);
            if (own.length > 0) return own;
            const base = familyBaseOf(a);
            return base ? inArea(base) : [];
          })
          : allRows;
        // The service the MESSAGE declares wins („цените за изнајмување…“),
        // then the funnel's own segment, then whatever the scope holds.
        const segmentSource = scopeRows.length > 0 ? scopeRows : allRows;
        const segment = slots.service ?? session.slots.service
          ?? (segmentSource.some(p => p.service === 'buy') ? 'buy' : 'rent');

        const tail = 'во зависност од местоположбата, квалитетот, годината на градба, опремата и условите што ги нуди самиот објект.';
        const cap = (s: string): string => `${s.charAt(0).toUpperCase()}${s.slice(1)}`;
        let answer: string;
        if (areaNames.length > 1) {
          const lines = areaNames.map(name => {
            const band = bandFor(name);
            if (band) return `${bandSentence(name, band)}.`;
            // „no offers“ and „offers but no measurable figure“ are DIFFERENT
            // facts, and a multi-area reply must phrase them the same way the
            // single-area one does (it used to call both „немам доволно
            // податоци“, promising a band for an area that holds nothing).
            if (hasRowsIn(name)) return `За ${name} во моментов немам доволно податоци за цена по м².`;
            const base = familyBaseOf(name);
            const wider = familyBandFor(name);
            return wider && base
              ? `За ${name} во моментов немам понуди — ${familySentence(base, wider)}.`
              : `За ${name} во моментов немам понуди.`;
          });
          lines.push(cap(tail));
          answer = lines.join('\n');
        } else {
          const label = areaNames[0] ?? (cityAsk ? 'Скопје' : undefined);
          const band = bandFor(areaNames[0]);
          if (!band) {
            // Honest no-data: never invent a band, and never promise offers in
            // an area that holds none (a numbered sub-area with no rows).
            const hasRows = !!label && hasRowsIn(label);
            const base = label ? familyBaseOf(label) : undefined;
            const wider = label ? familyBandFor(label) : undefined;
            if (label && !hasRows && wider && base) {
              // A numbered sub-area with NO offers at all: say THAT first, then
              // give the family band with the family named — widening is never
              // silent, and a sibling's price is never presented as this one's.
              answer = `За ${label} во моментов немам понуди. ${familySentence(base, wider)}. ${tail}`;
            } else {
              answer = label
              ? hasRows
                ? `За ${label} во моментов немам доволно податоци за цена по м². Можам да Ви ги покажам актуелните понуди во ${label} — дали сакате?`
                : `За ${label} во моментов немам понуди. Можам да Ви покажам понуди во друга населба — дали сакате?`
                : 'Во моментов немам доволно податоци за цена по м² за тој тип на недвижност. Можам да Ви ги покажам актуелните понуди — дали сакате?';
            }
          } else if (band.n === 1) {
            // ONE row: a listing, not a market level. Say so, then the usual
            // dependency line — never „цените се околу“ off a single offer.
            const sentence = label
              ? bandSentence(label, band)
              : `Во моментов имаме една активна понуда на ${typePlural}: ${fmt(band.lo)} ${band.unit}`;
            answer = `${sentence}. ${cap(tail)}`;
          } else {
            // With an area prefix the band continues the sentence (lowercase);
            // without one it OPENS it, so it starts capitalized.
            const opening = label ? `Во ${label}, ${band.text}` : cap(band.text);
            answer = `${opening} ${tail}`;
          }
        }
        // Persist the area ONLY when it has data: an honest „нема податоци за
        // Карпош I“ must not strand the funnel in an empty area, which made
        // every later ask (even „кој е најевтиниот?“, „по 1286?“) come back
        // empty. A no-data answer leaves the previously working area in place.
        const anyBand = areaNames.length > 0
          ? areaNames.some(name => bandFor(name) !== undefined)
          : bandFor(undefined) !== undefined;
        if (areaRaw && anyBand) session.slots.location = areaRaw;
        routeLog(chatId, text, 'MARKET_PRICE');
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, answer, 'deterministic');
        return;
      }
    }

    // ── „УШТЕ?“ AFTER A PRICE LIST ──────────────────────────────────────────
    // A list answer („покажи ги сите“) keeps the rows that did not fit. The
    // ordinary options lane never built a queue from this entry point, so the
    // follow-up used to bounce to the discovery ladder and the extra rows were
    // unreachable. Continue the SAME ranked list here, three at a time.
    if ((session.slots.extremeQueue?.length ?? 0) > 0
      && /(?:^|[\s,.:;!?])(?:uste|уште|ushte|poveke|повеќе|povece|повече)(?![\p{L}\p{N}])/iu.test(text)) {
      const ids = session.slots.extremeQueue!;
      const byId = new Map((await this.deps.properties.getAll()).map(p => [p.id, p]));
      const batch = ids.map(id => byId.get(id)).filter((p): p is Property => !!p).slice(0, 3);
      session.slots.extremeQueue = ids.slice(batch.length);
      if (batch.length > 0) {
        await this.landmarks.enrich(batch);
        const plural = session.slots.extremePlural ?? 'станови';
        const noun = session.slots.extremeNoun ?? 'стан';
        const where = session.slots.extremeWhere ?? '';
        const intro = batch.length === 1
          ? `Еве уште еден ${noun}${where}:`
          : `Еве уште ${plural}${where}:`;
        const answer = `${intro}\n\n${batch.map(p => buildPropertyCard(p)).join('\n\n')}`;
        const p0 = batch[0];
        session.slots.propertyId = p0.eb;
        session.slots.interestedPropertyId = p0.eb;
        const presented = session.slots.presentedIds ?? [];
        session.slots.presentedIds = [...presented, ...batch.map(p => p.id).filter(id => !presented.includes(id))];
        session.slots.currentBatch = batch.map(p => p.id);
        session.state = 'presentation';
        const nearLm = this.landmarks.nearbyLandmarks(p0);
        if (nearLm.length > 0) {
          session.slots.nearbyLandmarks = nearLm.map(n => n.landmark);
          session.slots.nearbyLandmarkCoords = nearLm.map(n => ({ lat: n.lat, lon: n.lon }));
          session.slots.nearbyLandmarkPlaceIds = nearLm.map(n => n.place_id ?? null);
          session.slots.nearbyLandmarkEb = p0.eb;
          session.slots.landmarkIndex = 0;
          session.slots.lastLandmark = undefined;
        }
        routeLog(chatId, text, 'PRICE_EXTREME_MORE');
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, answer, 'deterministic');
        return;
      }
    }

    // ── PRICE EXTREMES / BAND LOOKUP (the [17:44] capture) ──────────────────
    // „KOJ TI E TOJ STAN PO 1286E PO M2“ — the client read the LOW END of the
    // band and asks which flat it is; „POCNI OD NAJEVTINITE / POKAZI MI
    // NAJSKAPITE“ — start from the cheapest or show the dearest. Served from
    // the same scope as the band (areas + category + segment) and sorted on
    // that segment's own metric: monthly price for RENT, €/m² for SALE.
    // Before this lane the question fell into the funnel and asked for the
    // bedroom count.
    // FEE traffic is NEVER a property lookup: „ZA SEKOJ STAN PO 300DEN“ is a
    // fee objection that must climb the ladder, and „KOLKU E ZA POSETA“ is the
    // per-visit fee question. ONE structural gate (isFeeFrame) replaces the
    // per-lane enumeration of fee detectors: it requires a fee NOUN beside a
    // figure/pay verb (or denar money), so a wording none of the named
    // detectors knows still cannot be read as a property price, while the
    // serve-verb homograph („покажи“) no longer swallows price asks.
    if (detectPriceExtremeAsk(text) && inferPropertyId(text) === undefined && !isFeeFrame(text)) {
      const q = extractPriceExtremeQuery(text);
      if (q) {
        const feedLocs = await this.areaLocs(text);
        const cityAsk = /(?<![\p{L}\p{N}])(?:скопје|skopje|skopju|скопју)(?![\p{L}\p{N}])/iu.test(text);
        // Same area resolution as the band: a NUMERAL in the message binds to its
        // place word and is matched exactly, so „KARPOS 2“ never returns a
        // „Карпош III“ flat through the shared family token.
        const numbered = numberedAreasNamed(text, feedLocs);
        // The message's own area is the ONLY scope for a BARE RESIDENTIAL ask:
        // city-wide („во сите населби“) — neither the discovery location nor
        // the previous band's area may silently narrow it. The replay that
        // answered „Најевтиниот стан во Центар и Карпош III“ for a bare
        // „DAJ MI GO NAJEVTINIOT STAN“ is exactly what this prevents; an
        // explicit area (or „Скопје“) is how the client narrows.
        // TYPED-FUNNEL EXCEPTION (the [12:34] capture): a mid-funnel stock ask
        // under a PINNED area and a TYPED criteria set (business/house/plac, or
        // a dual-service funnel) means MY TYPED STOCK IN MY AREA — «покажи ми
        // ги сите…» from the деловен-in-Центар funnel served the whole city
        // instead of the pinned Center. Untyped bare asks keep the city-wide
        // contract (the scope test pins it).
        const pinnedTypedFunnel = !!session.slots.location && !session.slots.anywhere
          && (!!session.slots.business || session.slots.house !== undefined
            || !!session.slots.plac || !!session.slots.yard || !!session.slots.dualService);
        const namedArea = numbered.length > 0 ? numbered.join(', ') : await this.areaNamed(text);
        const areaRaw = cityAsk ? undefined : namedArea ?? (pinnedTypedFunnel ? session.slots.location : undefined);
        // A bare family word in the message („KARPOS“) must rank the WHOLE
        // family, not whichever numbered row the feed happens to hold first —
        // the same collapse the band lane makes. An explicit numeral (named in
        // the message) or an inherited price scope stays exact.
        const areaForScope = (a: string): string =>
          namedArea !== undefined && numbered.length === 0 && isNumberedArea(a)
            ? a.replace(/\s+(?:I{1,3}V?|IV|[1-4])\s*$/u, '').trim() || a
            : a;
        const areaNames = [...new Set((areaRaw ?? '').split(/,\s*/u).map(s => s.trim()).filter(Boolean).map(areaForScope))];
        const slots = extractSlots(text);
        // TYPE INHERITANCE (the [12:34] capture): the message names no
        // property type — a mid-funnel stock ask rides the funnel's OWN type
        // (the деловен funnel served гарсоњера + трисобен стан apartments).
        // An explicit type word in THIS message keeps its own scope; with
        // nothing armed anywhere the residential default stands.
        const msgTyped = !!slots.business || slots.house !== undefined || !!slots.plac || !!slots.yard || !!slots.garsonjera;
        const srcBusiness = !!slots.business || (!msgTyped && !!session.slots.business);
        const srcHouse = slots.house ?? (!msgTyped ? session.slots.house : undefined);
        const srcPlac = !!slots.plac || (!msgTyped && !!session.slots.plac);
        const yardWant = !msgTyped && !!session.slots.yard;
        const isLand = srcPlac;
        const typeOk = (p: Property): boolean => isLand
          ? !!p.plac
          : srcBusiness ? !!p.business
            : srcHouse === true || yardWant ? !!p.house
              : srcHouse === false ? !p.business && !p.house && !p.plac
              : !p.business && !p.house && !p.plac;
        const allRows = (await this.deps.properties.getAll()).filter(p =>
          typeOk(p) && typeof p.price === 'number' && p.price > 0);
        const inScope = areaNames.length > 0
          ? areaNames.flatMap(a => rowsInArea(allRows, a))
          : allRows;
        // This lane's ROW FILTER is the STATUS QUO for typed sessions: a business
        // row must not ride an apartment stock list. The dual-service flag (the
        // [12:33] capture) builds its own pair serve below.
        const dualServe = session.slots.dualService === true && slots.service === undefined
          && q.mode !== 'value';
        const segment = dualServe ? undefined : slots.service ?? session.slots.service
          ?? (inScope.some(p => p.service === 'buy') ? 'buy' : 'rent');
        const rows = inScope.filter(p => p.service === segment);
        // A 'value' ask may name a WHOLE price („станот од 90.000 евра“) instead
        // of a €/m² figure. For a buy row that is the price column; a rent metric
        // is the monthly price either way. A small figure that matches a row's
        // own price is read as that whole price too (the feed shows both).
        const val = q.value;
        const totalMode = q.total === true && val !== undefined
          && (segment === 'rent' || val >= 10000
            || rows.some(p => typeof p.price === 'number' && Math.abs(p.price - val) <= Math.max(1000, val * 0.05)));
        // €/m² comes from pricePerM2(): a sale row with no м² has NO metric and
        // is excluded from the ranking — never treated as price/1, which made a
        // surface-less flat the permanent "most expensive".
        const metric = (p: Property): number | undefined => totalMode
          ? p.price
          : segment === 'rent' ? p.price : pricePerM2(p);
        const rankable = rows
          .map(p => ({ p, m: metric(p) }))
          .filter((x): x is { p: Property; m: number } => typeof x.m === 'number');
        const fmtEur = (n: number): string => n >= 1000
          ? n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.')
          : String(n);
        const areaLabel = areaNames.map(a => a.replace(/\s*\([^)]*\)\s*$/u, '')).join(' и ');
        // ── WHICH-NASELBA COMPARISON (the [13:47] capture) ────────────────────
        // „VO KOJA NASELBA SE NAJEFTINI STANOVITE“ — the client compares
        // NEIGHBOURHOODS, not rows. Pin maths: each row's own €/м² averaged
        // over its naselba (the sum of the rows' per-м² prices divided by that
        // naselba's row count), the naselba with the LOWEST mean wins. The
        // reply is the operator's exact wording; the named plural follows the
        // type in the ask (станovi default, куќи / деловни објекти / плацови),
        // so the same lane answers the comparison for houses, business
        // premises and plots too. Fire only when the message itself says
        // „населба/naselba“ (ordinary cheapest asks keep their row listing)
        // and only where per-м² exists (buy): a rent rate is not a €/м² fact.
        const aggPluralNoun = slots.plac ? 'ПЛАЦОВИ' : slots.business ? 'ДЕЛОВНИ ОБЈЕКТИ' : slots.house ? 'КУЌИ' : 'СТАНОВИ';
        if (q.mode === 'cheapest'
          && /(?<![\p{L}\p{N}])(?:населб|naselb)\p{L}*/iu.test(text)
          && areaNames.length === 0
          && segment === 'buy'
          && rankable.length > 0) {
          const byArea = new Map<string, { sum: number; n: number }>();
          for (const x of rankable) {
            const a = feedArea(x.p);
            if (!a) continue; // a row with no naselba cannot name one
            const g = byArea.get(a) ?? { sum: 0, n: 0 };
            g.sum += x.m;
            g.n += 1;
            byArea.set(a, g);
          }
          const best = [...byArea.entries()]
            .map(([a, g]) => ({ a, avg: g.sum / g.n }))
            .sort((u, v) => u.avg - v.avg)[0];
          if (best) {
            // THE FLAT BESIDE THE NUMBER (the [02:56] owner rule): naming the
            // naselba is half the answer — the client still couldn't act on
            // it ("she does not know which apartment has that price"). From
            // THAT naselba's own rows, the flat whose €/м² is CLOSEST to the
            // naselba's average is the pick (equidistant → the cheaper row);
            // served as EB + whole price + the €/м² figure, per the owner
            // template, and closed with the visit followup.
            const nearAvg = rankable.filter(x => feedArea(x.p) === best.a)
              .sort((u, v) => Math.abs(u.m - best.avg) - Math.abs(v.m - best.avg) || u.m - v.m)[0];
            // The pick is typed like the ask's own noun (стан / куќа /
            // деловен простор / плац) — the (type) of property the template
            // names.
            const aggNoun = slots.plac ? 'Плац' : slots.business ? 'Деловен простор' : slots.house ? 'Куќа' : 'Стан';
            const answer = `МОМЕНТАЛНО НАСЕЛБА СО НАЈЕФТИНА ЦЕНА НА ${aggPluralNoun} ВО СКОПЈЕ Е ${best.a.toUpperCase()} СО ПРОСЕЧНА ЦЕНА ОД ${fmtEur(Math.round(best.avg))} ПО МЕТАР КВАДРАТЕН.`
              + (nearAvg ? ` ${aggNoun} со цена најблиску до просечната цена по квадрат во ${best.a} е Евидентен број ${nearAvg.p.eb} — цената од ${fmtEur(nearAvg.p.price ?? 0)} евра, односно ${fmtEur(nearAvg.m)} евра за м².` : '')
              + ' Дали би сакале да Ви организирам посета?';
            // The pick stays on the table: the followup turn ("да, за утре?")
            // must bind to THAT flat — propertyId gains it, presentedIds keeps
            // the visited list honest (no duplicate on a re-ask).
            if (nearAvg) {
              session.slots.propertyId = nearAvg.p.eb;
              const presented = session.slots.presentedIds ?? [];
              session.slots.presentedIds = [...new Set([...presented, nearAvg.p.eb])];
            }
            routeLog(chatId, text, 'PRICE_AVG_NASELBA');
            pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
            pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
            this.deps.sessions.set(session);
            await this.sendRaw(session, answer, 'deterministic');
            return;
          }
        }
        // PLURAL ask = show a batch. The suffix must END the token — „najevtiniot“
        // (singular, „the cheapest flat“) merely STARTS with „najevtini“ and
        // must serve ONE property, not a two-card list.
        const pluralAsk = /(?:naj(?:e|е)?(?:v|f)tin(?:i|ite)(?![\p{L}])|najskap(?:i|ite)(?![\p{L}])|нај(?:е)?(?:в|ф)тин(?:и|ите)(?![\p{L}])|најскап(?:и|ите)(?![\p{L}])|po(?:e|е)?(?:v|f)tin(?:ite|i)(?![\p{L}])|по(?:е)?(?:в|ф)тин(?:ите|и)(?![\p{L}])|(?:^|[\s,.:;!?])(?:site|сите|sto\s+ima|што\s+има)(?![\p{L}]))/iu.test(text);
        // THE CAP FOLLOWS THE ASK: „site/site stanovi/што има“ is the whole list
        // (5 cards), a plural superlative a small batch (3), a singular exactly
        // one. The old hard cap of two cut the list the client asked for.
        const allAsk = /(?:^|[\s,.:;!?])(?:site|сите|sto\s+ima|што\s+има)(?![\p{L}\p{N}])/iu.test(text);
        const pluralListAsk = pluralAsk
          || ((q.mode === 'cheaper' || q.mode === 'dearer') && /(?:stanovi|станови|opcii|опции|kukji|куќи)/iu.test(text));
        const limit = allAsk ? 5 : pluralListAsk ? 3 : 1;
        // ── DUAL-SERVICE PAIRED SERVE (the [12:33] capture) ──────────────────
        // Both budgets are on file («za kirija do 1000 evra» + «za kupuvanje
        // do 2000000») and the ask picked no segment: every serve is PAIRS —
        // one RENT card ≤ rentBudget + one BUY card ≤ buyBudget — under the
        // type/area inherited above. A rent rate and a buy € never share a
        // ranking metric, so each segment orders by its OWN price ascending
        // (a list ask sorts whole prices; a superlative narrows to one pair).
        if (dualServe) {
          const rowsFor = (svc: 'rent' | 'buy', cap?: number): Property[] =>
            inScope.filter(p => p.service === svc
              && typeof p.price === 'number' && p.price > 0
              && (cap === undefined || p.price <= cap))
              .sort((a, b) => (a.price as number) - (b.price as number));
          const rentRows = rowsFor('rent', Number(session.slots.rentBudget));
          const buyRows = rowsFor('buy', Number(session.slots.buyBudget));
          const full = interleaveServicePairs(rentRows, buyRows);
          const pluralAll = srcPlac ? 'плацови' : srcBusiness ? 'деловни простори' : srcHouse ? 'куќи' : 'станови';
          const where = areaLabel ? ` во ${areaLabel}` : ' во сите населби';
          let ans: string;
          if (full.length === 0) {
            ans = `Во моментов немам ${pluralAll}${where} во тие граници — ниту за кирија до ${fmtEur(Number(session.slots.rentBudget))} евра, ниту за купување до ${fmtEur(Number(session.slots.buyBudget))} евра.`;
          } else {
            const pairCount = limit === 1 ? 1 : 2; // the pair is 1 rent + 1 buy
            const chosenD = full.slice(0, pairCount * 2);
            const overflowD = full.slice(pairCount * 2);
            const p0 = chosenD[0];
            const nounBaseD = p0.plac ? 'плац' : p0.business ? 'деловен простор' : p0.house ? 'куќа' : 'стан';
            const pluralNounD = p0.plac ? 'плацови' : p0.business ? 'деловни простори' : p0.house ? 'куќи' : 'станови';
            const dirD = q.mode === 'expensive' ? 'Најскапите' : 'Најевтините';
            const intro = allAsk
              ? `Еве ги сите ${pluralNounD}${where}:`
              : `${dirD} ${pluralNounD}${where} — еден за кирија, еден за купување:`;
            const gap = rentRows.length === 0
              ? ` За кирија до ${fmtEur(Number(session.slots.rentBudget))} евра немам ${pluralNounD}${where}.`
              : buyRows.length === 0
                ? ` За купување до ${fmtEur(Number(session.slots.buyBudget))} евра немам ${pluralNounD}${where}.`
                : '';
            ans = `${intro}\n\n${chosenD.map(p => buildPropertyCard(p)).join('\n\n')}${gap}`.trimEnd();
            // The cards stay on the table exactly like the list serve above:
            // the followup („уште?“) continues from the remaining pairs.
            session.slots.propertyId = p0.eb;
            session.slots.interestedPropertyId = p0.eb;
            const presented = session.slots.presentedIds ?? [];
            session.slots.presentedIds = [...presented, ...chosenD.map(p => p.id).filter(id => !presented.includes(id))];
            session.state = 'presentation';
            session.slots.extremeQueue = overflowD.map(p => p.id);
            session.slots.extremeWhere = areaLabel ? where : '';
            session.slots.extremePlural = pluralNounD;
            session.slots.extremeNoun = nounBaseD;
          }
          routeLog(chatId, text, 'PRICE_EXTREME');
          pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
          pushHistory(session, { role: 'assistant', text: ans }, this.cfg.maxHistory);
          this.deps.sessions.set(session);
          await this.sendRaw(session, ans, 'deterministic');
          return;
        }
        let chosen: Property[] = [];
        // Rows beyond this answer's cap, in the lane's own order — the queue
        // „уште?“ continues from.
        let overflow: Property[] = [];
        let approx = false;
        if (q.mode === 'value' && val !== undefined) {
          const near = [...rankable].sort((a, b) => Math.abs(a.m - val) - Math.abs(b.m - val));
          if (near.length > 0) {
            const diff = Math.abs(near[0].m - val);
            approx = diff > Math.max(5, val * 0.02);
            chosen = [near[0].p];
          }
        } else if (q.mode === 'cheaper' || q.mode === 'dearer') {
          // STRICTLY one side of the reference the client named — the flat AT
          // the reference is not „поевтини“ from their point of view.
          const ref = val ?? 0;
          const side = rankable
            .filter(x => q.mode === 'cheaper' ? x.m < ref : x.m > ref)
            .sort((a, b) => q.mode === 'cheaper' ? a.m - b.m : b.m - a.m);
          chosen = side.slice(0, limit).map(x => x.p);
          overflow = side.slice(limit).map(x => x.p);
        } else if (rankable.length > 0) {
          const sorted = [...rankable].sort((a, b) => a.m - b.m).map(x => x.p);
          if (q.mode === 'expensive') {
            chosen = sorted.slice(-limit).reverse();
            overflow = sorted.slice(0, Math.max(0, sorted.length - limit)).reverse();
          } else {
            chosen = sorted.slice(0, limit);
            overflow = sorted.slice(limit);
          }
        }
        let answer: string;
        if (chosen.length === 0) {
          if (q.mode === 'cheaper' || q.mode === 'dearer') {
            const dir = q.mode === 'cheaper' ? 'поевтини' : 'поскапи';
            const unit = totalMode ? 'евра' : segment === 'rent' ? 'евра месечно' : 'евра за м²';
            answer = `Во моментов немам ${dir} понуди${areaLabel ? ` во ${areaLabel}` : ' во сите населби'} од ${fmtEur(val as number)} ${unit}. Можам да Ви покажам понуди во друга населба — дали сакате?`;
            routeLog(chatId, text, 'PRICE_EXTREME');
            pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
            pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
            this.deps.sessions.set(session);
            await this.sendRaw(session, answer, 'deterministic');
            return;
          }
          // OFFERS EXIST BUT NO м² → never rank them: say what is missing and
          // offer the cards instead of inventing a per-м² order.
          const noSize = segment === 'buy' && rows.length > 0;
          answer = noSize
            ? `За ${areaLabel || 'тој тип на недвижност'} има понуди, но без податок за квадратура не можам да ги споредам по цена за м². Можам да Ви ги покажам сите — дали сакате?`
            : areaLabel
              ? `Во ${areaLabel} во моментов немам активни понуди во таа категорија. Можам да Ви покажам нешто слично на друго место — дали сакате?`
              : 'Во моментов немам активни понуди во таа категорија. Можам да Ви покажам нешто слично — дали сакате?';
        } else {
          const p0 = chosen[0];
          // Base form for the superlative („најевтиниот стан“), definite form
          // for the demonstrative („станот со 1.286 …“).
          const nounBase = p0.plac ? 'плац' : p0.house ? 'куќа' : p0.business ? 'деловен простор' : 'стан';
          const noun = p0.plac ? 'плацот' : p0.house ? 'куќата' : p0.business ? 'деловниот простор' : 'станот';
          const pluralNoun = p0.plac ? 'плацови' : p0.house ? 'куќи' : p0.business ? 'деловни простори' : 'станови';
          const priceLabel = (p: Property): string => {
            if (segment === 'rent') {
              // The monthly word is the FEED's claim, checked in monthlyRent():
              // a per-day figure in the feed is never called monthly here.
              return `${fmtEur(p.price as number)} евра${monthlyRent(p) !== undefined ? ' месечно' : ''}`;
            }
            const perM2 = pricePerM2(p);
            return perM2 !== undefined
              ? `${fmtEur(p.price as number)} евра (${fmtEur(perM2)} евра за м²)`
              : `${fmtEur(p.price as number)} евра`;
          };
          // With no area in the message OR in the price scope the ranking is
          // city-wide — say so, so the client never mistakes it for their area.
          const where = areaLabel ? ` во ${areaLabel}` : ' во сите населби';
          let intro: string;
          if (q.mode === 'value') {
            // A rent figure is monthly whether the ask named a total or a €/m²
            // number — and only when the feed's rows can back the period word.
            const valUnit = segment === 'rent'
              ? (rentUnitWord(rows) ? ' месечно' : '')
              : totalMode ? '' : ' за м²';
            if (approx) {
              // NO exact row: answer with the scope's REAL range plus the
              // nearest row, instead of only „нема понуда точно“ (a 300 € rent
              // ask against 250–400 rows deserves the range, not a refusal).
              const vals = rankable.map(x => x.m).sort((a, b) => a - b);
              const lo = vals[0];
              const hi = vals[vals.length - 1];
              const range = lo === hi
                ? `${fmtEur(lo)} евра${valUnit}`
                : `од ${fmtEur(lo)} до ${fmtEur(hi)} евра${valUnit}`;
              intro = `За ${fmtEur(q.value as number)} евра${valUnit}${where} во моментов имаме понуди ${range} — најблиску е ${noun} со Евидентен број ${p0.eb}: ${priceLabel(p0)}.`;
            } else {
              intro = `${noun.charAt(0).toUpperCase()}${noun.slice(1)} за ${fmtEur(q.value as number)} евра${valUnit} е со Евидентен број ${p0.eb}: ${priceLabel(p0)}.`;
            }
          } else if (q.mode === 'cheaper' || q.mode === 'dearer') {
            const plural = p0.plac ? 'плацови' : p0.house ? 'куќи' : p0.business ? 'деловни простори' : 'станови';
            const dir = q.mode === 'cheaper' ? 'поевтини' : 'поскапи';
            intro = chosen.length > 1
              ? `Еве ${dir} ${plural}${where}:`
              : `${(q.mode === 'cheaper' ? 'Поевтиниот' : 'Поскапиот')} ${nounBase}${where} е со Евидентен број ${p0.eb}: ${priceLabel(p0)}.`;
          } else if (chosen.length > 1) {
            // „СИТЕ“ is the whole list, not a ranked pair: say so instead of
            // claiming a „најниска цена“ order the client did not ask for.
            intro = allAsk
              ? `Еве ги сите ${pluralNoun}${areaLabel ? where : ''}:`
              : q.mode === 'expensive'
                ? `Еве ги ${pluralNoun} со највисока цена${where}:`
                : `Еве ги ${pluralNoun} со најниска цена${where}:`;
          } else {
            intro = q.mode === 'expensive'
              ? `Најскапиот ${nounBase}${where} е со Евидентен број ${p0.eb}: ${priceLabel(p0)}.`
              : `Најевтиниот ${nounBase}${where} е со Евидентен број ${p0.eb}: ${priceLabel(p0)}.`;
          }
          answer = `${intro}\n\n${chosen.map(p => buildPropertyCard(p)).join('\n\n')}`;
          session.slots.propertyId = p0.eb;
          session.slots.interestedPropertyId = p0.eb;
          const presented = session.slots.presentedIds ?? [];
          session.slots.presentedIds = [...presented, ...chosen.map(p => p.id).filter(id => !presented.includes(id))];
          session.state = 'presentation';
          // The list this answer opened: keep the rest, in the same order, for
          // the follow-up „уште?“ (served by the continuation above).
          session.slots.extremeQueue = overflow.map(p => p.id);
          // City-wide reads as „сите станови“ — no redundant „во сите населби“.
          session.slots.extremeWhere = areaLabel ? where : '';
          session.slots.extremePlural = pluralNoun;
          session.slots.extremeNoun = nounBase;
          const nearLm = this.landmarks.nearbyLandmarks(p0);
          if (nearLm.length > 0) {
            session.slots.nearbyLandmarks = nearLm.map(n => n.landmark);
            session.slots.nearbyLandmarkCoords = nearLm.map(n => ({ lat: n.lat, lon: n.lon }));
            session.slots.nearbyLandmarkPlaceIds = nearLm.map(n => n.place_id ?? null);
            session.slots.nearbyLandmarkEb = p0.eb;
            session.slots.landmarkIndex = 0;
            session.slots.lastLandmark = undefined;
          }
        }
        routeLog(chatId, text, 'PRICE_EXTREME');
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, answer, 'deterministic');
        return;
      }
    }

    // ── WHICH-SIDE / SURROUNDINGS (the [01:29] capture) ─────────────────────
    // "od stranata na trgovskiot ili odkaj pazarceto": the client names the
    // places they can see and asks WHICH SIDE of them the property is on.
    // Nothing in the chain claimed it, so the classifier's STAY path answered a
    // LOCATION question with the closing fee pitch. Answered here from the
    // property's REAL anchors — every named place resolved against the offline
    // map and gated to the property's own radius (LandmarkService.findAnchor,
    // which also strips the definite article a client types: "trgovskiot").
    // The nearest named place IS the side the client is asking about; any
    // others are named as further away. When no named place resolves locally,
    // nothing is claimed and the chain keeps its existing behaviour.
    //
    // ABOVE POI-CONFIRM, on purpose: the confirm lane answers the FIRST named
    // place with its yes/no template, so a two-place comparison question
    // ("od stranata na X ili odkaj Y?") got "Да, директно до X" and the second
    // place — the actual comparison the client asked for — was dropped. The
    // confirm lane keeps every message this detector does NOT claim ("da ne e
    // vo skopjanka ?" has no side word and no "или", so it still lands there),
    // including its honest far-place correction when nothing here resolves.
    //
    // NOT gated on !skipInterceptors, unlike its neighbours: skipInterceptors
    // means "some knowledge detector recognised this as a question", and a
    // side ask is exactly such a question — "od stranata na X ili od Y?"
    // co-fires the comparison reader and was punted to the classifier, where an
    // LLM-down turn answers a LOCATION question with the closing fee pitch
    // (the [01:29] capture again, only with a question mark). The code owns
    // location facts, and nothing here is invented: with no anchor of THIS
    // property to name, the lane serves the same approximate-location line the
    // "kade e?" lane serves. Near-center asks ("poblisku do centar ili do
    // aerodrom ?") are a SEARCH refinement and keep their own ladder.
    if (!detectNearCenter(text)) {
      const side = detectSurroundingsAsk(text);
      if (side) {
        const mbSide = await this.bindMention(text, session, { historyFallback: true });
        if (await this.sendIfClarify(mbSide, text, session)) return;
        const ebSide = mbSide?.prop?.eb ?? inferPropertyId(text);
        const shownSide = session.slots.presentedIds ?? [];
        const sideProp = mbSide?.prop
          ?? (ebSide !== undefined
            ? await this.deps.properties.getByEb(ebSide).catch(() => undefined)
            : undefined)
          ?? (session.slots.propertyId
            ? await this.deps.properties.getByEb(session.slots.propertyId).catch(() => undefined)
            : undefined)
          ?? (session.slots.interestedPropertyId
            ? await this.deps.properties.getByEb(session.slots.interestedPropertyId).catch(() => undefined)
            : undefined)
          ?? (shownSide.length
            ? await this.deps.properties.getByEb(shownSide[shownSide.length - 1]).catch(() => undefined)
            : undefined);
        // THE PROPERTY'S REAL POINT: the question is about the place itself, so
        // the anchor search is centred on the stored coordinates — falling back
        // to the map's own address resolution only for a row the feed never
        // gave a point.
        const sideCenter = sideProp
          ? (sideProp.lat != null && sideProp.lon != null
            ? { lat: sideProp.lat, lon: sideProp.lon }
            : (() => {
              const c = resolveSearchCenter({
                id: sideProp.id, eb: sideProp.eb, address: sideProp.address,
                lat: sideProp.lat, lon: sideProp.lon,
                geo_source: sideProp.geo_source ?? null,
              } as PropertyRow);
              return c.lat && c.lon ? { lat: c.lat, lon: c.lon } : undefined;
            })())
          : undefined;
        if (sideProp && sideCenter && this.landmarks) {
          // ONE PLACE, ONE MENTION: two of the client's names can resolve to the
          // same place ("castello by alikas" once whole, once cut in two). The
          // answer must then never name that place as both the side AND the
          // farther one — dedupe on the resolved point before ranking.
          const found = side.anchors
            .map(a => this.landmarks!.findAnchor(a, sideCenter))
            .filter((a): a is { name: string; lat: number; lon: number; distance_m: number } => !!a)
            .filter((a, idx, all) => all.findIndex(b => b.lat === a.lat && b.lon === a.lon) === idx);
          if (found.length > 0) {
            const nearest = found.reduce((a, b) => (a.distance_m <= b.distance_m ? a : b));
            const further = found
              .filter(a => a !== nearest)
              .sort((a, b) => a.distance_m - b.distance_m);
            const sideAnswer = buildSideAnswer(nearest.name, further.map(f => f.name));
            routeLog(chatId, text, 'SURROUNDINGS');
            // Same context contract as the landmark answers: the property the
            // client is asking about becomes the one under discussion, so the
            // next ask resolves to it instead of the visit pitch.
            if (session.slots.propertyId !== sideProp.eb) {
              session.slots.propertyId = sideProp.eb;
              const presented = session.slots.presentedIds ?? [];
              if (sideProp.id !== undefined && !presented.includes(sideProp.id)) {
                session.slots.presentedIds = [...presented, sideProp.id];
              }
            }
            pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
            pushHistory(session, { role: 'assistant', text: sideAnswer }, this.cfg.maxHistory);
            this.deps.sessions.set(session);
            await this.sendRaw(session, sideAnswer);
            return;
          }
          // NOTHING THE CLIENT NAMED IS AN ANCHOR OF THIS PROPERTY — or they
          // named nothing at all ("na koja strana e ?"). Two ways out, and the
          // fee pitch is neither:
          //   • a named place the map knows ELSEWHERE is POI-CONFIRM's honest
          //     far correction ("Не, тоа е 2 км од недвижноста") — leave it there;
          //   • with no place to correct, the message is still a LOCATION
          //     question, so it gets the property's own approximate location —
          //     the same code-owned line (and the same ladder) as "kade e?".
          // The [01:29] capture's whole failure was a location question being
          // served the closing fee pitch; an unnamed side ask must not reopen
          // that hole through the back door.
          if (!side.anchors.some(a => this.landmarks!.findPlace(a, sideCenter))) {
            const approx = this.whereIsReply(sideProp, session);
            routeLog(chatId, text, 'SURROUNDINGS');
            pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
            pushHistory(session, { role: 'assistant', text: approx }, this.cfg.maxHistory);
            this.deps.sessions.set(session);
            await this.sendRaw(session, approx);
            return;
          }
        }
      }
    }

    // POI-CONFIRM — the 22:59 push-back ("da ne e vo skopjanka ?"). The client
    // tests a NAMED PLACE against the discussed property. This is a QUESTION
    // about the property under discussion — it must be ANSWERED, never
    // misread as fee/agreement traffic. Answered here, BEFORE isGenuineQuestion
    // can punt it to the LLM (the LLM was producing the generic fee pitch).
    //   1. Map-confirmed POI → honest yes/no + the visit-reveal protocol:
    //      neighborhood is fair game, exact address is not — same privacy
    //      contract as the rotation.
    //   2. No map hit → try a NEIGHBORHOOD reading ("da ne e vo karpos ?" —
    //      the extract also catches bare areas) and fall to the feed-verified
    //      location.confirm answer.
    //   3. Neither → untouched: fall through to the exact stack as before.
    if (isPoiConfirmQuestion(text)
        // "VO CENTAR IMA NESTO?" (21:16) is an area-availability probe — a
        // SEARCH pivot, never a POI/neighborhood confirm about the property
        // on the table (the confirm template answered "Не, станот 41 всушност
        // се наоѓа во Ѓорче Петров" to a client asking to LEAVE that area).
        && !detectAreaHaveAsk(text)
        && (session.slots.propertyId || session.slots.interestedPropertyId
          || session.slots.presentedIds?.length)) {
      // ANCHORING (the [12:47] transcript: "OVOJ KAJ KIPER . KOJA ADRESA JA IMA
      // ?" after EB 43 Маџари was presented, but propertyId still held a stale
      // EB from an earlier funnel → the answer described the WRONG property).
      // The demonstrative "ovoj/овај" binds what is ON THE TABLE — the last-
      // presented card (or the batch tail). Only when the message itself names
      // no property and nothing was ever presented does the legacy propertyId
      // chain apply. A pinned EB ("stan 50 kade e?") outranks everything.
      const pinnedPoi = inferPropertyId(text);
      // WHAT THE DEMONSTRATIVE POINTS AT (the pick → fee follow-up capture):
      // only a message that actually POINTS («овој/тој/таа/ова») reads the
      // table's tail. Otherwise the flat the chat has already BOUND is the one
      // under discussion — the tail re-anchored a chat whose flat was picked
      // one turn earlier («DA SE SAKAM» moved the slot from the picked ЕБ to
      // the last of the described list).
      const pointsAtTable = /(?<![\p{L}\p{N}])(?:овој|тој|оваа|таа|ова|тоа|ovoj|toj|ovaa|taa|ova|toa)(?![\p{L}\p{N}])/iu.test(text);
      const tableTail = pointsAtTable
        ? (session.slots.presentedIds?.[session.slots.presentedIds.length - 1]
          ?? session.slots.currentBatch?.[session.slots.currentBatch.length - 1])
        : undefined;
      const poiEb = pinnedPoi
        ?? tableTail
        ?? session.slots.interestedPropertyId
        ?? session.slots.propertyId
        ?? session.slots.presentedIds?.[session.slots.presentedIds.length - 1]
        ?? session.slots.currentBatch?.[session.slots.currentBatch.length - 1];
      const poiProp = poiEb != null
        ? await this.deps.properties.getByEb(poiEb).catch(() => undefined)
        : undefined;
      if (poiProp?.location) {
        const actualLoc = poiProp.location.replace(/\s*\([^)]*\)\s*$/, '');
        const prep = locPrep(actualLoc);
        const poiType = poiProp.house ? 'Куќата' : poiProp.business ? 'Деловниот простор' : 'Станот';
        const poiHint = `${poiType} со Евидентен број ${poiProp.eb} се наоѓа ${prep} ${actualLoc}. Точната адреса се открива на денот на посетата.`;
        // Anchor the context on the discussed property
        if (session.slots.propertyId !== poiProp.eb && session.slots.interestedPropertyId !== poiProp.eb) {
          session.slots.interestedPropertyId = poiProp.eb;
        }
        const placeCandidate = extractPoiConfirmPlace(text);
        let answer: string | undefined;
        if (placeCandidate && this.landmarks) {
          const hit = this.landmarks.findPlace(placeCandidate,
            poiProp.lat != null && poiProp.lon != null ? { lat: poiProp.lat, lon: poiProp.lon } : undefined);
          if (hit) {
            const d = poiProp.lat != null && poiProp.lon != null
              ? Math.round(distM(poiProp.lat, poiProp.lon, hit.lat, hit.lon))
              : null;
            const near = d != null && d <= 500;
            const distPhrase = d == null ? ''
              : d < 1000 ? `на ${Math.round(d / 10) * 10} метри од`
              : `на ${(d / 1000).toFixed(1).replace('.', ',')} километри од`;
            answer = near
              ? `${d != null && d <= 300 ? 'Да, директно до' : 'Да, во непосредна близина на'} ${hit.name}. ${poiHint}`
              : `Не, тоа е ${distPhrase} ${hit.name}, а недвижноста е ${prep} ${actualLoc}. Точната адреса се открива на денот на посетата.`;
          }
        }
        if (!answer && placeCandidate) {
          // Neighborhood reading of the candidate ("da ne e vo karpos ?") —
          // ONLY with a real candidate: marker words alone (дека/така/тогас)
          // must never fabricate a location answer out of an opinion.
          const namedLoc = await this.areaNamed(placeCandidate);
          if (namedLoc) {
            const agree = locMatches(namedLoc, poiProp.location);
            answer = agree
              ? `Точно, ${poiHint}`
              : `Не, ${poiType} со Евидентен број ${poiProp.eb} всушност се наоѓа ${prep} ${actualLoc}. Точната адреса се открива на денот на посетата.`;
          }
        }
        if (answer) {
          session.slots.location = actualLoc;  // anchor the discussion context
          routeLog(chatId, text, 'POI_CONFIRM');
          pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
          pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
          this.deps.sessions.set(session);
          await this.sendRaw(session, answer, 'deterministic');
          return;
        }
      }
      // No map hit, no neighborhood reading, no confirm form → fall through
      // untouched (LLM handles it with full context).
    }

    // WHICH PROPERTY / PROPERTY CHOICE (the [00:06]–[00:08] live burst).
    // A batch is on the table; the client says "E OVOJ MOZE" (this one works)
    // and then "ZA KOJ STAN STANUVA ZBOR ?". Two deterministic obligations:
    //   • the CHOICE arms the flat the client is looking at (the last served
    //     card) and, when the fee has not been disclosed yet, hands the session
    //     to the fee question — it is NOT consent, and it must never jump to
    //     contact collection before the money gate (the [00:06] field bug);
    //   • the WHICH-question names that flat (EB + neighbourhood + price) and
    //     asks whether the choice stands. It used to be answered with the FEE
    //     copy — the client asked which flat, and heard the 500 again.
    // Runs before the fee/price/contact lanes; a fee-sized amount in the
    // message disqualifies the choice reading (detectPropertyChoice).
    if (!session.slots.viewingFeeAgreed && !['queued', 'terminated', 'escalated'].includes(session.state)) {
      const whichAsk = detectWhichPropertyAsk(text);
      const choice = !whichAsk && detectPropertyChoice(text);
      if (whichAsk || choice) {
        const anchorEb = session.slots.interestedPropertyId ?? session.slots.propertyId
          ?? session.slots.currentBatch?.[session.slots.currentBatch.length - 1]
          ?? session.slots.presentedIds?.[session.slots.presentedIds.length - 1];
        const anchor = anchorEb != null
          ? await this.deps.properties.getById(anchorEb).catch(() => undefined)
          : undefined;
        if (anchor) {
          session.slots.interestedPropertyId = anchor.eb;
          if (session.slots.propertyId == null) session.slots.propertyId = anchor.eb;
        }
        const fmtPrice = (n: number | undefined) => n === undefined ? '-' : n.toLocaleString('mk-MK', { maximumFractionDigits: 1 });
        let reply: string;
        let bankKey: string;
        if (whichAsk) {
          bankKey = anchor ? 'property.which.anchor' : 'property.which.none';
          reply = anchor
            ? (pickVariant('property.which.anchor', {
                recent: assistantTexts(session),
                vars: { eb: String(anchor.eb), location: anchor.location ?? '', price: fmtPrice(anchor.price) },
              }) ?? `За станот што го одбравте — Евидентен број ${anchor.eb}${anchor.location ? ` во ${anchor.location}` : ''}${anchor.price !== undefined ? `, ${fmtPrice(anchor.price)} евра` : ''}. Дали останува Вашиот избор?`)
            : (pickVariant('property.which.none', { recent: assistantTexts(session) })
              ?? 'Не можам да одредам за кој стан зборувате — кажете ми го Евидентен број (на пр. „станот со број 88“) и веднаш ќе Ви кажам детали.');
          routeLog(chatId, text, 'WHICH_PROPERTY:fast');
        } else {
          // The choice was made in the PRESENTATION (or earlier): disclose the
          // fee first. In closing the fee is already on the table, so the
          // normal fee/interest lanes own the turn (no duplicate disclosure).
          if (session.state === 'closing' || !anchor) {
            reply = ''; bankKey = '';
          } else {
            session.slots.ownerContactPending = false;
            session.state = 'closing';
            const svc = session.slots.service ?? anchor.service ?? 'buy';
            bankKey = svc === 'rent' ? 'fee.ask.rent' : 'fee.ask.buy';
            reply = pickVariant(bankKey, { recent: assistantTexts(session) }) ?? buildFeeAsk(svc);
            routeLog(chatId, text, 'PROPERTY_CHOICE:fast');
          }
        }
        if (reply) {
          pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
          pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
          this.deps.sessions.set(session);
          if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic')) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'PROPERTY_ANCHOR_FAST', userMsg: text, replyText: reply, replySource: 'deterministic', bankKey }); } catch { /* ignore */ } }
          console.log(`[timing] ${Date.now() - pipelineStart}ms (fast-property-anchor) state=${session.state} src=deterministic bank=${bankKey}`);
          await this.sendRaw(session, reply, 'deterministic:fast');
          return;
        }
      }
    }

    // CHEAP-PRICE REMARK — the client says the quoted price is GOOD ("MNOGU
    // EFTINA CENA E TOA", "cenata e dobra"). This is valence, not money talk:
    // the fee is never called cheap, so a compliment can never be resistance —
    // before this lane it climbed the fee ladder and served persuasion copy at a
    // happy client, and the review bank then refused the turn as a frozen key.
    // Gated to states where a price is ON THE TABLE (property_query /
    // presentation / closing): in intake there is nothing to evaluate yet, and
    // a "cheap" in discovery is search chatter. No state change, no slots, no
    // fee; the wording is bank-backed and grows through review.
    // INVARIANT 4 — the collision record. If the cheap-price vocabulary ever
    // overlaps the fee-claim grammar again (predicate drift), this probe fires
    // BEFORE the veto eats it and the drift log carries the alarm — a collision
    // is an event, never a silent swallow. pure-regex, no state.
    const laneConflict = cheapLaneConflict(text);
    if (laneConflict) routeLog(chatId, text, `LANE_COLLISION:${laneConflict}`);
    const priceEval = detectPriceEval(text);
    // MONEY ARBITRATION (P5.2, option 1 — evidence, not array order): every
    // money lane in this region becomes a CLAIM with its evidence chips, and
    // the arbiter resolves by evidence strength; strength ties fall back to
    // the legacy array order, so every serve the old chain made, this chain
    // makes byte-identical (tests/route-corpus.test.ts). The arbiter is also
    // the collision log (invariant 4): two surviving claims at the top is an
    // event, and an unclaimed money turn gets its explicit
    // `unknown.<topic>.<act>` address (option 2) instead of a silent fall-
    // through into a family by accident.
    const moneyArb = arbitrateMoney(text, {
      state: session.state,
      propertyOnTable: !!(session.slots.propertyId || session.slots.interestedPropertyId
        || session.slots.lastPrice || session.slots.presentedIds?.length),
      feeAgreed: !!session.slots.viewingFeeAgreed,
      feeBlocked: !!this.deps.bank?.neverServes(text, 'fee.'),
      provisionBlocked: !!this.deps.bank?.neverServes(text, 'provision.'),
    });
    if (moneyArb.conflict) routeLog(chatId, text, collisionTag(moneyArb.claims));
    if (moneyArb.bucket) routeLog(chatId, text, `ROUTE_UNKNOWN:${moneyArb.bucket}`);
    if (moneyArb.lane === 'cheap') {
      const reply = pickVariant(PRICE_EVAL_CHEAP_KEY, { recent: assistantTexts(session) })
        ?? PRICE_EVAL_CHEAP_FALLBACK;
      routeLog(chatId, text, 'PRICE_EVAL_CHEAP');
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic')) {
        try {
          this.deps.enrichment.insert({
            chatId, state: session.state, eventType: 'PRICE_EVAL_CHEAP',
            userMsg: text, replyText: reply, replySource: 'deterministic', bankKey: PRICE_EVAL_CHEAP_KEY,
          });
        } catch { /* advisory log */ }
      }
      await this.sendRaw(session, reply, 'deterministic:price-eval');
      return;
    }
    if (priceEval === 'expensive'
      && (session.state === 'closing' || session.state === 'presentation')
      && !session.slots.viewingFeeAgreed
      && moneyArb.lane !== 'expensive') {
      // INVARIANT 4, second record, now RESIDUAL ONLY (P5.2): with the evidence
      // boundary met the negative evaluation is SERVED below (the arbiter's
      // narrowest lane); this log stays for the closing state and every
      // boundary the serve does not cross — the data collector keeps counting.
      routeLog(chatId, text, 'PRICE_EVAL_EXPENSIVE_UNWIRED');
    }
    // THE WIRED EXPENSIVE LANE (P5.2, the decision the evidence makes): a
    // negative evaluation whose object is the EXPLICIT price noun, on a
    // property that is on the table, non-question, no negotiation shape, no
    // other money claim. The serve is the bank-backed remark — acknowledge,
    // owner-set price, invite the live viewing. Bare "скапо" (no price noun),
    // negotiation-shaped turns and closing-state turns keep their lanes.
    if (moneyArb.lane === 'expensive' && priceEval === 'expensive') {
      const reply = pickVariant(PRICE_EVAL_EXPENSIVE_KEY, { recent: assistantTexts(session) })
        ?? PRICE_EVAL_EXPENSIVE_FALLBACK;
      routeLog(chatId, text, 'PRICE_EVAL_EXPENSIVE');
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic')) {
        try {
          this.deps.enrichment.insert({
            chatId, state: session.state, eventType: 'PRICE_EVAL_EXPENSIVE',
            userMsg: text, replyText: reply, replySource: 'deterministic', bankKey: PRICE_EVAL_EXPENSIVE_KEY,
          });
        } catch { /* advisory log */ }
      }
      await this.sendRaw(session, reply, 'deterministic:price-eval');
      return;
    }

    // FEE-AMOUNT ASK — the client asks what the VISIT costs: "KOLKU E ZA
    // POSETA?", "kolku ke me kosta 10 poseti?", "KOJA E CENATA NA
    // RAZGLEDUVANJETO?". The OBJECT of the question is the FEE, so every
    // property lane below answers the wrong thing — the INFO block served the
    // flat's rent ("Станот со Евидентен број 79 — киријата изнесува 250 евра"),
    // the negotiate lane the owner-price policy. The answer is the fee
    // DISCLOSURE (fee.ask; the AGNOSTIC copy when no market is declared) and
    // the funnel lands at the fee question. Runs FIRST in this region, before
    // freshness/negotiate/INFO/price can claim the message.
    // (The fee-amount ask is now the arbiter's feeAmount claim — same
    // predicate, same state gate, same neverServes veto — moved into the
    // evidence claim list above; the serve below is unchanged.)
    if (moneyArb.lane === 'feeAmount') {
      if (!session.slots.service) session.slots.service = this.feeServiceHint;
      const askSvc = session.slots.service;
      const askKey = askSvc === undefined ? undefined : askSvc === 'rent' ? 'fee.ask.rent' : 'fee.ask.buy';
      // NO DECLARED MARKET → the AGNOSTIC disclosure (buildFeeAsk(undefined)
      // names BOTH fees), never a defaulted buy copy — the [09:0x] rule, which
      // exists because a reset session used to quote 500 ден/0% at a renter.
      const askReply = askKey
        ? (pickVariant(askKey, { recent: assistantTexts(session) }) ?? buildFeeAsk(askSvc))
        : buildFeeAsk(undefined);
      // The fee is on the table now — the same place every other disclosure
      // leaves the funnel. From a post-gate state (contact_collection) the
      // state stands: the client is asking about a fee already agreed.
      if (['property_query', 'presentation', 'discovery', 'intent', 'idle', 'property_locate'].includes(session.state)) {
        session.state = 'closing';
      }
      routeLog(chatId, text, 'FEE_AMOUNT_ASK:fast');
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: askReply }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic')) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'FEE_AMOUNT_ASK_FAST', userMsg: text, replyText: askReply, replySource: 'deterministic', bankKey: askKey ?? 'fee.ask.agnostic' }); } catch { /* ignore */ } }
      console.log(`[timing] ${Date.now() - pipelineStart}ms (fast-fee-amount) state=${session.state} src=deterministic bank=${askKey ?? 'fee.ask.agnostic'}`);
      await this.sendRaw(session, askReply, 'deterministic:fast');
      return;
    }

    // PROVISION (rent-commission) RESISTANCE — the second money topic, its OWN
    // ladder and its OWN counter. The rent commission (50% of one monthly rent
    // below 1.000 €, one full rent from 1.000 € up) is money the client pays us
    // BESIDE the visit fee, and it gets resisted the same way: "50% E MNOGU",
    // "NE SAKAM DA PLATAM PROVIZIJA", "нема да платам провизија". Before this
    // lane those bursts burned a VISIT-FEE rung (the negation + payment verb
    // read as a fee refusal) and answered a commission complaint with the
    // visit-fee copy — wrong topic AND wrong ladder. The serve is the
    // commission's own four rungs; slots.feeRejections is never touched (the
    // isolation contract, tests/fee-serve-routing.test.ts). A buyer pays 0%
    // commission: resistance there is a misunderstanding, so provisionLadder
    // returns the 0%-clarification and no rung is counted. Runs FIRST in this
    // region — before freshness/negotiate/INFO/price can claim the message.
    // (Provision resistance is likewise the arbiter's provision claim — the
    // serve below is unchanged.)
    if (moneyArb.lane === 'provision') {
      const served = this.serveProvisionResistance(session, text);
      routeLog(chatId, text, 'PROVISION_PUSH:fast');
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: served.reply }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic')) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'PROVISION_PUSH_FAST', userMsg: text, replyText: served.reply, replySource: 'deterministic', bankKey: served.bankKey }); } catch { /* ignore */ } }
      console.log(`[timing] ${Date.now() - pipelineStart}ms (fast-provision-ladder) state=${session.state} src=deterministic bank=${served.bankKey} rung=${served.rung}`);
      await this.sendRaw(session, served.reply, 'deterministic:fast');
      return;
    }

    // NO MONEY REPLY WITHOUT A TARGET (hard invariant 3): a money wording
    // whose object is unresolved — no fee referent, no property noun, nothing
    // bound — gets the ONE safe script, the clarify question, and NEVER a
    // protocol line. Deliberately placed LAST among the money lanes (after
    // fee-amount-ask and provision, right before the ladder): every targeted
    // lane still wins; this catches only the residue that would otherwise
    // slip down into heavier scripts. Fires only in the money-script states
    // when nothing is on the table: a bound property / an agreed fee / a
    // money noun ("пари") IS a target, and the fee-funnel refusal arms stay
    // with the ladder. No state change, no slots; logs MONEY_CLARIFY + key.
    // (The clarify gate is now the arbiter's clarify claim — object unresolved
    // + protocol states + nothing on the table + no agreed fee.)
    if (moneyArb.lane === 'clarify') {
      const clarify = pickVariant(MONEY_CLARIFY_KEY, { recent: assistantTexts(session) })
        ?? MONEY_CLARIFY_FALLBACK;
      routeLog(chatId, text, 'MONEY_CLARIFY');
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: clarify }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic')) {
        try {
          this.deps.enrichment.insert({
            chatId, state: session.state, eventType: 'MONEY_CLARIFY',
            userMsg: text, replyText: clarify, replySource: 'deterministic', bankKey: MONEY_CLARIFY_KEY,
          });
        } catch { /* advisory log */ }
      }
      await this.sendRaw(session, clarify, 'deterministic:money-clarify');
      return;
    }

    // THE FEE-NAG LADDER (both markets, one order) — EARLY, right after the
    // commission ladder and for the same reason: a nag is money traffic, and
    // money traffic must not pass through the search machinery. Every resistance
    // shape — charge accusation ("PARI ZA POSETA BARATE"), value complaint
    // ("MNOGU NEKAKO 500DEN…", "SKAPO E TOA . ZA SEKOJ STAN PO 300DEN"),
    // "nobody charges but you", refusal and surprise — burns exactly ONE visit-
    // fee rung: persuade → agency rule → decision → graceful close. Runs in
    // `closing` AND in `presentation` (the [23:12] field case: the client was
    // looking at a batch when he objected; from the late lane the criteria/
    // present path claimed the message first and answered a fee objection with
    // MORE PROPERTIES, and the bookkeeping grew by a batch nobody saw). The
    // commission counter is never touched (the isolation contract).
    if (moneyArb.lane === 'nag') {
      // OPTIONS-ASK VETO stays INSIDE the arbiter's nag claim (the [22:2x]
      // joined burst): "pari za poseta / nesto novo" carries a fee jab AND a
      // shopping ask, and the fee already disclosed must not climb another
      // rung. The fee-sized amount complaint ("SKAPO E TOA . ZA SEKOJ STAN PO
      // 300DEN") reads as suggest-alternatives ONLY in the options engine, so
      // that veto never gates the ladder's rung 3 — the claim keeps the veto
      // scoped exactly where the field transcript demanded it.
      const served = this.serveFeeNagLadder(session);
      routeLog(chatId, text, 'FEE_PUSH:fast');
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: served.reply }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic')) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'FEE_PUSH_FAST', userMsg: text, replyText: served.reply, replySource: 'deterministic', bankKey: served.bankKey }); } catch { /* ignore */ } }
      console.log(`[timing] ${Date.now() - pipelineStart}ms (fast-fee-ladder) state=${session.state} src=deterministic bank=${served.bankKey} rung=${served.rung}`);
      await this.sendRaw(session, served.reply, 'deterministic:fast');
      return;
    }

    // PRICE ASSERTION (the [22:33] capture): "44 e 130000 evra kaj vas na
    // stranicata" — the client TELLS Lina the price he saw on the public
    // site. The money number names the EB's price (extractBudget vacated it),
    // never his budget. Serve the system's CURRENT price for THAT property:
    // matching → a plain confirm + visit offer; differing → the freshness
    // disclaimer (system price + owner relay). Needs an identifiable EB —
    // without one (or without the property in the feed) the message keeps
    // its old lanes.
    if (detectEbPriceAssertion(text)
      && (session.slots.propertyId || session.slots.interestedPropertyId
        || session.slots.presentedIds?.length || extractEbPriceAssertion(text)?.eb != null)) {
      const assertOk = extractEbPriceAssertion(text);
      const ebAssert = assertOk?.eb
        ?? session.slots.propertyId ?? session.slots.interestedPropertyId
        ?? await this.lastKnownHistoryEb(session)
        ?? session.slots.presentedIds?.[session.slots.presentedIds.length - 1];
      const propA = ebAssert != null
        ? await this.deps.properties.getById(ebAssert).catch(() => undefined)
        : undefined;
      if (propA?.price !== undefined) {
        session.slots.interestedPropertyId = propA.eb;
        session.slots.propertyId = session.slots.propertyId ?? propA.eb;
        const sys = propA.price.toLocaleString('mk-MK');
        const agrees = assertOk?.amount != null && Math.abs(propA.price - assertOk.amount) < 1;
        const noun = propA.house ? 'Куќата' : propA.business ? 'Деловниот простор' : 'Станот';
        const assertReply = agrees
          ? `Точно, ${noun} со Евидентен број ${propA.eb} се нуди по ${sys} евра — тоа е тековната цена во системот. Дали би сакале да организираме посета за да го погледнете?`
          : `Ви благодарам за напомената. Последната цена што ја имаме во системот за ${noun.toLowerCase()} со Евидентен број ${propA.eb} е ${sys} евра. Сопствениците имаат пракса на менување на условите и цените без знаење на агенцијата. За моменталната достапност и цена морам да се консултирам со сопственикот. Дали би сакале да остварам контакт со сопственикот и да Ви дадам повратна информација?`;
        routeLog(chatId, text, agrees ? 'PRICE_ASSERT:fast' : 'PRICE_ASSERT_DIFF:fast');
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: assertReply }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic')) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'PRICE_ASSERT_FAST', userMsg: text, replyText: assertReply, replySource: 'deterministic', bankKey: 'price.freshness' }); } catch { /* ignore */ } }
        console.log(`[timing] ${Date.now() - pipelineStart}ms (fast-price-assert) state=${session.state} src=deterministic bank=price.freshness`);
        await this.sendRaw(session, assertReply, 'deterministic:fast');
        return;
      }
      // EB named but NOT in the feed: honesty, not a criteria-miss — the
      // not-found lane already owns that verdict (below, post-FSM), so this
      // only guards the ghost anchor from being armed by the assertion.
      if (ebAssert != null && !propA) {
        session.slots.lastGhostEb = ebAssert;
      }
    }

    // PRICE FRESHNESS (08:50 protocol) — "a dali mu e uste taa cena?" (the
    // client asks whether the price already quoted is still current). The
    // reply is NEVER a bare amount: system price = LAST KNOWN price, owners
    // change terms without telling the agency. Serve the disclaimer + contact
    // ask; the client's "да" rides the EXISTING ownerContactPending agreement
    // gate → fee → visit workflow (no new funnel steps invented). Runs BEFORE
    // the INFO block (which would serve the flat "чини X евра" quote) and
    // before the fast price ask. Requires a property on the table AND a price
    // in the slot (a brand-new search with no price yet has nothing to be
    // "still" current — it stays a plain price.ask). The named-mention case
    // binds the named property, ambiguity asks back once.
    if (detectPriceFreshness(text)
      && (session.slots.propertyId || session.slots.interestedPropertyId
        || session.slots.presentedIds?.length)
      && !detectRemark(text)
      && !detectBudget(text)
      && !detectFeeComplaint(text)
      && !detectFeePaymentAgreement(text)
      && !detectNegotiate(text) // a reduction/discount ask ("korekcija na cenata?") wants the fixed-prices policy, never the freshness disclaimer
      && !detectService(text) && !detectBothServices(text)) {
      const mbFresh = await this.bindMention(text, session, { historyFallback: true });
      if (await this.sendIfClarify(mbFresh, text, session)) return;
      const ebFresh = mbFresh?.prop?.eb
        ?? inferPropertyId(text)
        ?? session.slots.propertyId ?? session.slots.interestedPropertyId
        // [22:24] the conversation's last explicit EB outranks the stale batch
        // tail — "koja i bese cenata uste ednas?" after an EB-44 confirm must
        // quote EB 44, not the property presented before it.
        ?? await this.lastKnownHistoryEb(session)
        ?? session.slots.presentedIds?.[session.slots.presentedIds.length - 1];
      if (ebFresh) {
        const pFresh = await this.deps.properties.getById(ebFresh)
          ?? (await this.loadProps(session, false, true)).find(x => x.eb === ebFresh);
        const priceNum = pFresh?.price ?? parseFloat(session.slots.lastPrice ?? '');
        if (priceNum && Number.isFinite(priceNum)) {
          session.slots.interestedPropertyId = ebFresh;
          session.slots.ownerContactPending = true;
          if (session.state !== 'closing') session.state = 'closing';
          const freshReply = pickVariant('price.freshness', {
            recent: assistantTexts(session),
            vars: { price: `${priceNum.toLocaleString('mk-MK')} евра` },
          }) ?? `Последната цена што ја имаме во системот е ${priceNum.toLocaleString('mk-MK')} евра. Сопствениците имаат пракса на менување на условите и цените без знаење на агенцијата. За моменталната достапност и цена морам да се консултирам со сопственикот. Дали би сакале да остварам контакт со сопственикот и да Ви дадам повратна информација?`;
          routeLog(chatId, text, 'PRICE_FRESHNESS:fast');
          pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
          pushHistory(session, { role: 'assistant', text: freshReply }, this.cfg.maxHistory);
          this.deps.sessions.set(session);
          if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic')) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'PRICE_FRESHNESS_FAST', userMsg: text, replyText: freshReply, replySource: 'deterministic', bankKey: 'price.freshness' }); } catch { /* ignore */ } }
          console.log(`[timing] ${Date.now() - pipelineStart}ms (fast-price-freshness) state=${session.state} src=deterministic bank=price.freshness`);
          await this.sendRaw(session, freshReply, 'deterministic:fast');
          return;
        }
      }
    }

    // PRICE NEGOTIATION — the correction/reduction family ("BI SAKAL DA SE
    // NAMALI MALKU", "dali e vozmozna korekcija na cenata?"): the client
    // pushes back on the PROPERTY's price. The banked fixed-prices policy
    // (price.negotiate — owners set the price, the agency only mediates) is
    // the only correct serve; the closing fee disclosure (22:10) or a flat
    // re-quote from the INFO block below are wrong-answer classes. Runs right
    // after the freshness gate (whose negotiate-veto hands this family over
    // here) and BEFORE the INFO block, whose price facet would otherwise
    // serve the bare amount. Requires a property on the table — a negotiation
    // with nothing bound has no referent and falls through to the FSM/LLM.
    // EB-CHOICE VETO ([17:01] capture): "MISLAM DEKA NAJDOBAR BI BIL 57" is the
    // client CHOOSING a property by Евидентен број — the counter-offer B8
    // bridge (`bi` + short bridge + bare digits) reads it as a price offer and
    // this lane answered with the owner-relay line (“сопственикот ги одредува
    // условите…”). A number is an EB REFERENCE — not an offer amount — when
    // it is ≤4 digits, has NO currency token attached, NO counter
    // preposition (za/na), and matches a property the client was already
    // shown or is discussing. Real offers keep their digits big or suffix a
    // currency ("ke dadam 400 e", "ke dadam 115000") — never misvetoed.
    const negotiatedText = detectNegotiate(text);
    const ebChoiceOnly = negotiatedText && (() => {
      if (/\b(?:za|за|на|na)\s*\d/iu.test(text)) return false;               // counter preposition → an offer
      const nums = (text.match(/\d[\d\s.,]*/g) ?? [])
        .map(n => parseInt(n.replace(/[\s.,]/g, ''), 10))
        .filter(n => Number.isFinite(n));
      if (nums.length === 0) return false;
      if (!nums.every(n => n <= 9999)) return false;                          // property-price orders of magnitude
      const discussed = new Set([
        ...(session.slots.presentedIds ?? []),
        session.slots.propertyId, session.slots.interestedPropertyId,
      ].filter((n): n is number => n != null));
      if (!nums.every(n => discussed.has(n))) return false;
      // currency token right AFTER any number → price traffic, never an EB
      return !nums.some(n => {
        const tail = text.slice(text.indexOf(String(n)) + String(n).length, text.indexOf(String(n)) + String(n).length + 8);
        return /\s*(?:ден[\p{L}]*|den[\p{L}]*|евр[\p{L}]*|evr[\p{L}]*|eur|€|мкд|mkd|[еe])(?![\p{L}\p{N}])/iu.test(tail);
      });
    })();
    if (detectNegotiate(text)
      && !ebChoiceOnly
      && ['closing', 'presentation', 'property_query'].includes(session.state)
      && !detectFeeComplaint(text)
      && !detectFeePaymentAgreement(text)
      && (session.slots.propertyId || session.slots.interestedPropertyId
        || session.slots.presentedIds?.length)) {
      const negoReply = pickVariant('price.negotiate', { recent: assistantTexts(session) })
        ?? 'Цената е фиксна, но ако сакате можам да го контактирам сопственикот за да видам дали има простор за преговарање.';
      routeLog(chatId, text, 'NEGOTIATE:fast');
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: negoReply }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic')) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'NEGOTIATE_FAST', userMsg: text, replyText: negoReply, replySource: 'deterministic', bankKey: 'price.negotiate' }); } catch { /* ignore */ } }
      await this.sendRaw(session, negoReply, 'deterministic');
      return;
    }

    // BARE BUDGET-UP ([25:2x] queue, three same-day misroutes) — the FAST
    // serve for "DAJ NESTO POSKAPO TOGAS" / "a nesto poskapo vo Centar?".
    // The old NEGOTIATE_RE carried the bare comparatives, so this family
    // answered with the fixed-prices owner-contact pitch (price.negotiate)
    // while the client was asking for a WIDER, pricier selection. The
    // detector owns the direction split now (the downward comparatives stay
    // with negotiate) and this lane serves the upward ask the way the
    // cheaper-ask family is served: same characteristics, prices strictly
    // ABOVE the anchor, priciest-first, already-shown rows excluded.
    // Requires a property on the table (no anchor → no referent → the
    // existing lanes answer, unchanged); the fee-traffic vetoes keep a fee
    // objection that merely contains the word "поскапо" (the [23:12]
    // value-complaint class) inside the fee lanes.

    // GLOSSARY — the client asks what a term MEANS ("sto znaci toa suteren ?"),
    // or follows up on how deep the unit sits ("dali e vkopan ?"). The [08:52]
    // transcript showed the info-ask family answering the definition with the
    // property's floor line, because both messages carry the word "сутерен".
    // The vocabulary answer needs no binding and must not be re-rendered as a
    // facet, so it is served here — before the info-ask block — and the block
    // itself vetoes these messages.
    {
      const kind = detectGlossaryAsk(text);
      if (kind === 'suteren-meaning') {
        const meaning = answerGlossary(text);
        routeLog(chatId, text, 'GLOSSARY');
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: meaning! }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, meaning!, 'deterministic');
        return;
      }
      // The DUG-IN line is reserved for a suteren unit: it is served only when
      // the bound property really is кат −1. With an upper-floor flat (or no
      // bound property at all) the phrase must never appear — the message
      // falls through to the normal lanes instead.
      if (kind === 'suteren-dug-in') {
        const eb = inferPropertyId(text)
          ?? session.slots.propertyId
          ?? session.slots.interestedPropertyId
          ?? session.slots.presentedIds?.[session.slots.presentedIds.length - 1];
        const bound = eb !== undefined && eb !== null
          ? await this.deps.properties.getByEb(eb).catch(() => undefined)
          : undefined;
        const dugIn = bound && isSuterenUnit(bound) ? answerGlossary(text, { suteren: true }) : undefined;
        if (dugIn) {
          routeLog(chatId, text, 'GLOSSARY');
          pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
          pushHistory(session, { role: 'assistant', text: dugIn }, this.cfg.maxHistory);
          this.deps.sessions.set(session);
          await this.sendRaw(session, dugIn, 'deterministic');
          return;
        }
      }
    }

    // ── [00:12] SMALLER-BY-RATE — the per-м² anchored size-down ask ──────
    // The client keeps the €/м² RATE of the flat on the table and asks SMALLER
    // ("pomalo mi treba so takva cena za kvadrat", "rekov takva cena za
    // kvadrat ama pomal"). Two dead ends own this shape otherwise: the INFO
    // block's pricePerSqm facet re-renders the SAME flat's rate forever, and
    // the pomalo lane re-asks bedrooms the client already priced. The honest
    // answer is a search: same service + same category, strictly smaller м²,
    // €/м² at or BELOW the anchor's rate (smaller × same-or-cheaper rate = a
    // cheaper TOTAL — the client's own spec), same-area rows first, already-
    // shown rows excluded.
    if (detectSmallerPerM2Ask(text)) {
      const servedSmaller = await this.presentSmallerPerM2(session, text);
      if (servedSmaller) return;
    }

    // [00:12] head — the bare TOO-BIG COMPLAINT ("GOLEM MI E NEKAKO"): the
    // same size-down ladder, anchored on SIZE alone — the closest-smaller м²
    // ranks first, any rate serves. Veto:
    // a size QUESTION ("kolku e golem?", "golemina") belongs to the INFO sqm
    // facet; fee-traffic money complaints ("golemo e" about the fee) belong
    // to the fee lanes. With no anchor (no property on the table) the lane
    // returns false and the existing lanes answer unchanged.
    if (detectGolemComplaint(text) && !/\?/.test(text)
      && !/колку\s*(?:е\s*)?(?:голем|gol)/iu.test(text)
      && !/golemina|големина/iu.test(text)
      && !detectFeeComplaint(text) && !detectFeeSurprise(text)) {
      const servedGolem = await this.presentSmallerPerM2(session, text, 'golem');
      if (servedGolem) return;
    }

    // INFO-ASK (scope C) — "kolku e garsonjerata?", "a 63 kolku kvadrati",
    // "dali 76 ima lift?" — the public-add becomes quotable, same contract as
    // the where-is family: the property is bound by MENTION (EB, price, type,
    // descriptor) from everything the chat has put on the table, and the
    // answer is built from the feed's public-add data — never the LLM, never
    // invented. Facets with no stored data fall through to the owner-relay
    // paths; an ambiguous mention asks back once (the clarify machinery).
    {
      // The ELLIPTICAL last-floor follow-up ("POSLEDEN ?") carries its noun in
      // the previous answer — only when Lina's last line named a floor is the
      // bare word a top-floor yes/no rather than "the last property".
      const lastAssistant = [...session.history].reverse().find(h => h.role === 'assistant')?.text ?? '';
      const infoFacets = detectInfoFacets(text, {
        floorOnTable: /(?:кат|спрат|приземје|сутерен)/iu.test(lastAssistant),
      });
      // A fee complaint that ECHOES Lina's wording can contain "cena ?" (the
      // 10:18 line: "1 EVRO E SIMBOLICNA CENA ?") — that reads as a price ask
      // facet. Fee traffic belongs to the fee protocol, never the INFO block.
      if (infoFacets
        && !detectFeeComplaint(text)
        // MORE-OPTIONS veto (the [22:2x] Viber transcript): "a drugi stanovi
        // do taa cena imate?" echoes the discussed PRICE (a cena facet) but is
        // an alternatives ask — the price re-render answered it wrongly and
        // the fee funnel swallowed the shopping intent. A more-marker ask
        // belongs to the options lane even when it names the old price.
        && !detectMoreOptions(text)
        // FEE-TRAFFIC veto (the [00:08] burst): "KOJA SIMBOLICNA CENA .
        // 500DEN SE PARI" carries a cena facet, but it is an objection to the
        // VISIT FEE — the INFO block answered it with the flat's 133.000. Any
        // fee traffic belongs to the fee lanes, never the price facet.
        && !isFeeTraffic(text)
        // COMMISSION veto (the same misclassification class as the fee-amount
        // ask): "KOLKU E PROVIZIJATA?" is a money question whose OBJECT is the
        // agency commission, and the price facet claimed it — the client got
        // the flat's rent ("Станот со Евидентен број 79 — киријата изнесува
        // 250 евра") instead of the published tier rule. Commission traffic
        // belongs to provision.ask / provision.who below.
        && !detectProvisionAsk(text) && !detectProvisionWho(text)
        // SMALLER-BY-RATE veto (the [00:12] burst): "pomalo mi treba so takva
        // cena za kvadrat" carries a cena+per-м² shape, but the client is
        // SEARCHING for a smaller unit, not asking the shown flat's rate
        // again — re-rendering it is exactly the loop the smaller-by-rate
        // lane above owns.
        && !detectSmallerPerM2Ask(text)
        // A COLD ask that NAMES its EB is still an info ask: the [00:00]
        // transcript "ZDRAVO DALI KUKJATA 55 IMA DVORCE?" was turned into the
        // discovery/service question because no property was on the table yet,
        // although the message itself carried the number. The mention layer
        // binds the named EB (bindMention reads EBs out of the text), so the
        // gate accepts that case too.
        && (session.slots.propertyId || session.slots.interestedPropertyId
          || session.slots.presentedIds?.length
          || inferPropertyId(text) !== undefined
          // The BUILDING-YEAR question is answerable with no unit on the table:
          // the honest "немам податок — ќе го прашам сопственикот" line is a
          // general answer about every property, not a property-specific fact.
          // Without this the ask fell to the LLM and got a presentation pitch
          // (queue #185: "od koja godina e zgradata?").
          || infoFacets.yearBuilt || infoFacets.renovation)) {
        const mbInfo = await this.bindMention(text, session, { historyFallback: true });
        if (await this.sendIfClarify(mbInfo, text, session)) return;
        // No binding signal in the message ("kolku e ?") → the legacy slot
        // chain (current → interested → presented[last]) — the mention layer
        // must never STARVE the ask that the FSM price path already served.
        const infoProp = mbInfo?.prop
          ?? (session.slots.propertyId
            ? await this.deps.properties.getByEb(session.slots.propertyId).catch(() => undefined)
            : undefined)
          ?? (session.slots.interestedPropertyId
            ? await this.deps.properties.getByEb(session.slots.interestedPropertyId).catch(() => undefined)
            : undefined)
          ?? (session.slots.presentedIds?.length
            ? await this.deps.properties.getByEb(session.slots.presentedIds[session.slots.presentedIds.length - 1]).catch(() => undefined)
            : undefined);
        if (!infoProp && (infoFacets.yearBuilt || infoFacets.renovation)) {
          // No unit bound (a cold "from which year is the building?"): still
          // answer the question — the missing-fact line is property-agnostic.
          const miss = [
            ...(infoFacets.yearBuilt ? [INFO_NO_YEAR_LINE] : []),
            ...(infoFacets.renovation ? [INFO_NO_RENOVATION_LINE] : []),
          ].join(' ');
          routeLog(chatId, text, 'INFO_ASK_YEAR');
          pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
          pushHistory(session, { role: 'assistant', text: miss }, this.cfg.maxHistory);
          this.deps.sessions.set(session);
          // This lane returns before the epilogue logger, so record it here:
          // otherwise the year answer — the one the operator must be able to
          // review and improve — never reaches ENRICHMENT (queue #185).
          if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic')) {
            try {
              this.deps.enrichment.insert({
                chatId: session.chatId, state: session.state, eventType: 'INFO_ASK_YEAR',
                userMsg: text, replyText: miss, replySource: 'deterministic',
                // The key is FOR RECOGNITION ONLY: it lets the review screen
                // paint this row as code and name the constant that owns the
                // wording. Nothing writes to it — the rule lives in code.
                bankKey: infoFacets.yearBuilt ? INFO_NO_YEAR_KEY : INFO_NO_RENOVATION_KEY,
              });
            } catch { /* advisory */ }
          }
          await this.sendRaw(session, miss, 'deterministic');
          return;
        }
        if (infoProp) {
          const sqmMissing = !!infoFacets.sqm && infoProp.sqm === undefined;
          const it = infoProp.business ? 'Деловниот простор'
            : infoProp.plac ? 'Плацот' : infoProp.house ? 'Куќата' : 'Станот';
          let infoAnswer = buildInfoAnswer(infoProp, infoFacets);
          // THE SQM-UNKNOWN RELAY (the [13:28] capture): a м² ask on a bound
          // unit with NO stored surface fell through silently — the
          // property_query lane re-served the CARD, the question went
          // unanswered and the pending visit was never re-confirmed. The
          // missing-fact contract: name the unit, admit the surface is not
          // in the base, promise the owner check — never a card re-serve.
          if (sqmMissing) {
            const relay = `${it} со Евидентен број ${infoProp.eb} — за квадратурата ќе го прашам сопственикот и ќе Ве потврдам.`;
            infoAnswer = infoAnswer ? `${infoAnswer} ${relay}` : relay;
          }
          // THE COMBINED ANSWER (the [13:28] burst): the client typed the
          // visit interest AND the м² question in one burst — Lina answers
          // the fact FROM THE DB and RE-CONFIRMS the visit in the same
          // reply, like a human would. The fee protocol opens only AFTER
          // the client answers the re-confirm with yes (pendingVisitConfirm);
          // a refusal clears it and the conversation flows on.
          const lastUserText = [...session.history].reverse().find(h => h.role === 'user')?.text ?? '';
          if (infoAnswer && (detectVisitInterest(text) || detectVisitInterest(lastUserText))) {
            // OWN THE ANSWER (the [13:28] template): the combined burst's
            // fact answer names the unit FIRST — "Деловниот простор со
            // Евидентен број 57 има XX м²" — never a bare "Има X м²…"
            // with no referent.
            infoAnswer = infoAnswer.replace(
              /^Има (\d+) м² станбена површина\.$/u,
              `${it} со Евидентен број ${infoProp.eb} има ${infoProp.sqm} м².`);
            infoAnswer = `${infoAnswer}\nДали сè уште сте заинтересовани за посета?`;
            session.slots.pendingVisitConfirm = true;
          }
          if (infoAnswer) {
            if (infoProp.eb !== session.slots.propertyId) {
              // An ask that BOUND its property moves the conversation there:
              // the next bare follow-up ("kolku kvadrati ima ?") must answer
              // THAT unit, not the flat that sat in the slot before. The
              // [08:58] bug: EB 84 was asked about by number, then the bare
              // size ask answered the previously discussed 28 м² flat.
              if (mbInfo?.prop) session.slots.propertyId = infoProp.eb;
              session.slots.interestedPropertyId = infoProp.eb;
            }
            session.slots.lastPrice = infoProp.price !== undefined ? String(infoProp.price) : session.slots.lastPrice;
            routeLog(chatId, text, 'INFO_ASK');
            pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
            pushHistory(session, { role: 'assistant', text: infoAnswer }, this.cfg.maxHistory);
            this.deps.sessions.set(session);
            await this.sendRaw(session, infoAnswer, 'deterministic');
            return;
          }
        }
        // Facet asked but nothing stored for the bound property, or no
        // property could be bound — fall through to the existing paths
        // (owner-relay for unknown facets, FSM price fallback, LLM).
      }
    }

    // Location nagging: after the privacy protocol ("the exact address is shared
    // 2 hours before the visit"), the client pushes back with "how will I know
    // if the location suits me?" — they want to know the general area, not the
    // exact address. Instead of repeating the protocol, reveal the nearby landmark
    // as a compromise (same as WHERE_IS but triggered by location-suitability
    // questions, not explicit каде-questions).
    // A bare area-confirmation question ("dali e vo vodno?", "vo vodno li e?")
    // about the IDENTIFIED property is a yes/no confirm/correct, not a nag —
    // the nag path repeats the landmark line; the confirm path answers from
    // the feed (and corrects a wrong area). Marker forms (znaci…) fall through
    // here and are handled by the confirm branch in the FSM chain below.
    // !detectWhereIs — "moram da znam kade e" (the 13:38 push) matches BOTH
    // this detector and detectWhereIs. The nag branch serves shown[last] —
    // after a pair presentation that is the WRONG property (EB 63 got served
    // when the client was pushing about EB 69) — while the where-is branch
    // binds by mention (historyFallback re-resolves the previous identity
    // message). Location-suitability asks keep their nag answer; where-is
    // questions belong to the rotation.
    if (detectLocationNag(text) && !detectLocationConfirm(text) && !detectWhereIs(text)) {
      routeLog(chatId, text, 'LOCATION_NAG');
      // MENTION BINDING (12:33 rule): a nag that NAMES the property
      // ("garsonjerata kaj ambasadata") binds THAT property — shown[last]
      // served EB 63 while the client was pushing about EB 69 (the pair bug
      // this branch's own history documents). No mention keeps the legacy
      // chain; ambiguity asks back once.
      const mbNag = await this.bindMention(text, session);
      if (await this.sendIfClarify(mbNag, text, session)) return;
      // Find the property being discussed — same logic as WHERE_IS generic.
      const all = await this.deps.properties.getAll();
      const shownIds = new Set(session.slots.presentedIds ?? []);
      const shown = all.filter(p => shownIds.has(p.id));
      const hit = mbNag?.prop
        ?? shown[shown.length - 1]
        ?? (session.slots.propertyId
          ? await this.deps.properties.getByEb(session.slots.propertyId)
          : undefined)
        ?? (session.slots.interestedPropertyId
          ? await this.deps.properties.getByEb(session.slots.interestedPropertyId)
          : undefined);
      if (hit) {
        await this.landmarks.enrich([hit]);
        // Record the discussed property; reset the rotation if the client
        // switched to a different property mid-session.
        if (session.slots.propertyId !== hit.eb) {
          session.slots.propertyId = hit.eb;
          session.slots.nearbyLandmarks = undefined;
          session.slots.nearbyLandmarkCoords = undefined;
          session.slots.nearbyLandmarkPlaceIds = undefined;
          session.slots.nearbyLandmarkEb = undefined;
          session.slots.landmarkIndex = 0;
          session.slots.lastLandmark = undefined;
          session.slots.addressProtocolIndex = 0;
          session.slots.exactLocationTurns = 0;
        }
        const answer = this.whereIsReply(hit, session, '');
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, answer);
        return;
      }
      // No property found — fall through to LLM.
    }

    // Owner contact refusal: the client asks for the owner's phone/contact.
    // The agency NEVER shares owner contacts before a visit is arranged.
    if (detectOwnerContact(text)) {
      routeLog(chatId, text, 'OWNER_CONTACT');
      const answer = pickVariant('owner.contact.refusal', { recent: assistantTexts(session) })
        ?? 'Контактот на сопственикот не се споделува директно. Можам да организирам посета каде ќе се сретнете со сопственикот. Дали би сакале да закажеме термин?';
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, answer);
      return;
    }

    // PROXY-CONTACT (audit #47): the client asks the AGENCY to contact the
    // owner and report back ("STAPI VO KONTAKT I INFORMIRAJ ME"). In `closing`
    // the FSM fee protocol must keep claiming these first (fee-before-contact
    // is the judged-correct order), so this block only fires in every OTHER
    // position — where the class used to fall into documents/info fast-paths.
    if (detectContactRequest(text) && session.state !== 'closing') {
      routeLog(chatId, text, 'PROXY_CONTACT');
      const answer = pickVariant('owner.contact.refusal', { recent: assistantTexts(session) })
        ?? 'Контактот на сопственикот не се споделува директно. Можам да организирам посета каде ќе се сретнете со сопственикот. Дали би сакале да закажеме термин?';
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, answer);
      return;
    }

    // "каде е X?" — a question about a PLACE's whereabouts ("каде е Палома
    // Бјанка?", "каде се наоѓа тој стан?"), NEVER a search for properties IN X.
    // Answer code-built from DB facts (address/neighborhood) so it can never
    // derail into a bogus "exhausted all properties in X" reply — the classifier
    // never even sees it, so the LLM can't misread the place as a location.
    // 0a-pre) NEARBY ask — "what else is near the building?" ("sto ima drugo
    // vo blizina na zgradata?"). Grammar-based (order-free) so no word order
    // variant can slip through to the FSM. It is a where-is question about the
    // CURRENT property → route into the same landmark-rotation reply path.
    // Checked BEFORE detectWhereIs: no kade-verb → detectWhereIs returns
    // undefined for these, and if it ever DOES match (e.g. "kade sto ima
    // drugo vo blizina"), the dedicated nearby path must win anyway.
    if (!skipInterceptors && detectNearbyAsk(text)) {
      routeLog(chatId, text, 'NEARBY_ASK');
      // EB-anchored nearby asks ("sto drugo ima vo blizina na 78?") MUST
      // resolve the NAMED property — falling back to shown[last] served a
      // Влае center for a Капиштец property (Reptil/Badu bug).
      const ebInText = (() => {
        const m = text.match(/\b(?:na|на)\s+(\d{1,4})\b/i);
        return m ? parseInt(m[1], 10) : undefined;
      })();
      const all = await this.deps.properties.getAll();
      const shownIds = new Set(session.slots.presentedIds ?? []);
      const shown = all.filter(p => shownIds.has(p.id));
      // Descriptor mentions bind too ("vo blizina na garsonjerata kaj
      // ambasadata") — the numeric-only ebInText regex left those on
      // shown[last] (the 00:09 class).
      const mbNear = await this.bindMention(text, session);
      if (await this.sendIfClarify(mbNear, text, session)) return;
      const cur = mbNear?.prop
          ?? (ebInText
          ? await this.deps.properties.getByEb(ebInText).catch(() => undefined)
          : undefined)
        ?? shown[shown.length - 1]
        ?? (session.slots.propertyId
          ? await this.deps.properties.getByEb(session.slots.propertyId)
          : undefined)
        ?? (session.slots.interestedPropertyId
          ? await this.deps.properties.getByEb(session.slots.interestedPropertyId)
          : undefined);
      if (!cur) {
        // Nothing under discussion — a nearby ask without context is a search
        // wish; let the normal pipeline handle it.
      } else {
        await this.landmarks.enrich([cur]);
        const answer = this.whereIsReply(cur, session, text);
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, answer);
        return;
      }
    }

    // ADDRESS-WHY push-back — a bare "ZOSTO?" right after a privacy-protocol
    // line gets the agency-rules explanation ("затоа што тоа се правилата на
    // Агенцијата…"), NOT the options thread (the 20:56 transcript bug).
    // Bank-backed (address.why) so Gemini variants accumulate. Topic
    // why-questions ("зошто наплаќате?") belong to their own detectors and
    // never match the bare form.
    if (!skipInterceptors && detectWhyFollowUp(text)
      && lastReplyWasNearby(assistantTexts(session).slice(-1)[0] ?? '')) {
      routeLog(chatId, text, 'ADDRESS_WHY');
      // Frozen key — same family as fee.why: fixed protocol pool, never
      // enriched, never learned (no unbounded bank growth).
      const answer = pickVariant('address.why', { recent: assistantTexts(session) })
        ?? 'Затоа што тоа се правилата на Агенцијата, кои и Јас и Вие мора да ги почитуваме.';
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, answer);
      return;
    }

    // NEARBY-THREAD continuation — a bare "more" ask ("I STO USTE?", "сто
    // друго има?") right after a landmark/protocol/nearby reply means
    // "what else is near the building" — the nearby thread continues into
    // the rotation → protocol → shut-down lifecycle. WITHOUT this gate the
    // ask leaked into the property-options thread (the 21:00 transcript bug).
    // Genuine search/availability/price intents own their words regardless
    // of context and are excluded.
    const lastLineNearby = assistantTexts(session).slice(-1)[0] ?? '';
    // A "more?" right after a reply that NAMED a landmark IS the rotation, even
    // when it looks like a genuine question: "I STO DRUGO?" (the [13:31]
    // capture) has the landmark just named as its referent, but isGenuineQuestion
    // set skipInterceptors and the ask fell through to the classifier — which
    // answered with the discovery greeting ("Добредојдовте… купување или
    // изнајмување?") while L3 was still owed. After ANY other nearby reply
    // (privacy protocol / exhausted line) the old rule stands, so a real
    // availability/search question still reaches the classifier.
    const lastNamedLandmark = /во\s+бли[зж]ин/iu.test(lastLineNearby);
    if ((!skipInterceptors || lastNamedLandmark)
      && mentionsMore(text)
      && !hasProximityAnchor(text)
      && !detectWidenIntent(text) && !detectExplicitWiden(text)
      && !detectAvailabilityAsk(text) && !detectPriceAsk(text)
      && lastReplyWasNearby(lastLineNearby)) {
      routeLog(chatId, text, 'NEARBY_THREAD');
      // EB-anchored asks resolve the NAMED property (same rule as NEARBY_ASK);
      // descriptor mentions bind too ("za garsonjerata kaj ambasadata") — the
      // numeric-only ebInText regex left those on shown[last] (00:09 class).
      const mbNear = await this.bindMention(text, session);
      if (await this.sendIfClarify(mbNear, text, session)) return;
      const ebInText = (() => {
        const m = text.match(/\b(?:na|на)\s+(\d{1,4})\b/i);
        return m ? parseInt(m[1], 10) : undefined;
      })();
      const all = await this.deps.properties.getAll();
      const shownIds = new Set(session.slots.presentedIds ?? []);
      const shown = all.filter(p => shownIds.has(p.id));
      const cur = mbNear?.prop
          ?? (ebInText
          ? await this.deps.properties.getByEb(ebInText).catch(() => undefined)
          : undefined)
        ?? shown[shown.length - 1]
        ?? (session.slots.propertyId
          ? await this.deps.properties.getByEb(session.slots.propertyId)
          : undefined)
        ?? (session.slots.interestedPropertyId
          ? await this.deps.properties.getByEb(session.slots.interestedPropertyId)
          : undefined);
      if (cur) {
        await this.landmarks.enrich([cur]);
        const answer = this.whereIsReply(cur, session, text);
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, answer);
        return;
      }
      // No property under discussion — fall through to the normal pipeline.
    }

    // CONTEXT GATE — bare "sto drugo ima?" is ambiguous. After a LANDMARK
    // reply it means "what else is near the building" (rotation stands);
    // after a PROPERTY presentation it means "what OTHER apartments do you
    // have with those characteristics" — the where-is interception must
    // stand down so the classifier serves the NEXT options batch
    // (SEARCH_REQUESTED → presentation's next-2 engine).
    const whereIsRaw = detectWhereIs(text);
    const recentAssistant = assistantTexts(session);
    // STAND-DOWN for the bare "more/other" family ("drugo sto imas?",
    // "nesto drugo?"): no proximity anchor in the message and the last reply
    // was NOT a nearby-thread answer → this is options/search traffic, never
    // a where-is question. The old guard required lastReplyWasProperty — a
    // funnel ask in discovery ("Во кој дел од градот…?") or the
    // exhausted/widen line did not match it, so the ask fell into the WHERE_IS
    // lane and got the "кажете ми Евидентен број" escape (the [21:26]
    // freeze class).
    const whereIs = whereIsRaw && whereIsRaw.generic
      && mentionsMore(text) && !hasProximityAnchor(text)
      && !lastReplyWasNearby(recentAssistant[recentAssistant.length - 1] ?? '')
      ? undefined
      : whereIsRaw;
    if (whereIs) {
      routeLog(chatId, text, 'WHERE_IS');
      const all = await this.deps.properties.getAll();
      // PRESENTATION ORDER, not feed order: "the last shown" must mean the last
      // card the client SAW. Filtering the feed left shown[] in feed order, so
      // the tail could be a card from the TOP of the batch — the [23:09]
      // capture answered "GARSONJERAVA KAJ SE NAOGJA TOCNO?" with the other
      // property's landmark whenever the feed ordered them the other way
      // round. Every other "last shown" site in this file already reads
      // presentedIds[last]; this is the same rule.
      const shown = (session.slots.presentedIds ?? [])
        .map(id => all.find(p => p.id === id))
        .filter((p): p is Property => !!p);
      let hit: Property | undefined;
      // MENTION BINDING — the 12:33 rule: name-by-anything beats "last
      // shown". A clear bind takes the reply, ambiguity asks back once,
      // a miss falls through to the existing resolution untouched.
      const mb = await this.bindMention(text, session, { historyFallback: true });
      if (await this.sendIfClarify(mb, text, session)) return;
      if (mb?.prop) hit = mb.prop;
      if (hit === undefined) {
      if (whereIs.generic) {
        // The client asks about the current property ("каде е?", "сто има во
        // близина?"). If shown[] is empty (property looked up by EB number,
        // not via presentation), fall back to the property the client is
        // currently discussing via session slots.
        // PINNED-EB OVERRIDE (the [15:58] transcript): an EB named in THIS or
        // the last 3 user messages ("TE PRASAV ZA STAN 50") is THE topic —
        // the presented-tail (a stale batch card) never outranks it.
        const pinnedWhere = (() => {
          const candidates: number[] = [];
          const bare = inferPropertyId(text);
          if (bare !== undefined && !detectBudget(text)) candidates.push(bare);
          const hist = session.history.filter(h => h.role === 'user');
          for (let i = hist.length - 1; i >= Math.max(0, hist.length - 3); i--) {
            const n = inferPropertyId(hist[i].text);
            if (n !== undefined && !detectBudget(hist[i].text)) candidates.push(n);
          }
          return candidates[0];
        })();
        hit = (pinnedWhere !== undefined
          ? await this.deps.properties.getByEb(pinnedWhere).catch(() => undefined)
          : undefined)
          ?? (session.slots.propertyId
            ? await this.deps.properties.getByEb(session.slots.propertyId).catch(() => undefined)
            : undefined)
          ?? shown[shown.length - 1]
          ?? (session.slots.interestedPropertyId
            ? await this.deps.properties.getByEb(session.slots.interestedPropertyId).catch(() => undefined)
            : undefined);
      } else {
        const p = whereIs.place;
        // EB number: "каде се наоѓа 89?" — look up directly by evidence number.
        const ebNum = parseInt(p, 10);
        if (Number.isFinite(ebNum) && ebNum > 0) {
          hit = await this.deps.properties.getByEb(ebNum);
        }
        if (!hit) {
          // If the asked location matches the CURRENT property's location,
          // use the current property — the client is asking WHERE IN that
          // area it is, not asking to see OTHER properties there.
          const curProp = shown[shown.length - 1]
            ?? (session.slots.propertyId
              ? await this.deps.properties.getByEb(session.slots.propertyId)
              : undefined)
            ?? (session.slots.interestedPropertyId
              ? await this.deps.properties.getByEb(session.slots.interestedPropertyId)
              : undefined);
          if (curProp && curProp.location && locMatches(p, curProp.location)) {
            hit = curProp;
          } else {
            hit = [...shown, ...all].find(pr =>
              (!!pr.address && locMatches(p, pr.address)) || (!!pr.location && locMatches(p, pr.location)));
          }
        }
      }
      } // end !hit — mention-bound property above skips the legacy resolution
      let answer: string;
      if (hit) {
        // Address privacy: "каде е X?" is answered with the nearest PUBLIC
        // landmark ("во близина на City Mall"), never the street.
        await this.landmarks.enrich([hit]);
        // Session context: mark the answered property as the one under
        // discussion. Without this, a fresh-session "каде се наоѓа 76?" is
        // answered once and every follow-up ("kade tocno?", "sto ima vo
        // blizina?", "dali e dostapen?") finds NO context and dead-ends on
        // the visit pitch. Recording it here makes the whole follow-up chain
        // resolve to the same property — the landmark answer never reveals
        // the exact address, so privacy is unaffected.
        if (session.slots.propertyId !== hit.eb) {
          session.slots.propertyId = hit.eb;
          const presented = session.slots.presentedIds ?? [];
          if (!presented.includes(hit.id)) {
            session.slots.presentedIds = [...presented, hit.id];
          }
          // Property switched — reset the nearby-landmark rotation so the new
          // property's L1→L2→L3 start fresh.
          session.slots.nearbyLandmarks = undefined;
          session.slots.nearbyLandmarkCoords = undefined;
          session.slots.nearbyLandmarkPlaceIds = undefined;
          session.slots.nearbyLandmarkEb = undefined;
          session.slots.landmarkIndex = 0;
          session.slots.lastLandmark = undefined;
          session.slots.addressProtocolIndex = 0;
          session.slots.exactLocationTurns = 0;
        }
        answer = this.whereIsReply(hit, session, whereIs.place);
      } else if (whereIs.place) {
        // (a) The client asks about a landmark WE just gave ("kade e toa
        // Helen Doron?") — match against the rotation slots before anything
        // else; claiming ignorance of our own answer is worse than any miss.
        const q = whereIs.place.toLowerCase();
        const lmList = session.slots.nearbyLandmarks ?? [];
        let givenIdx = -1;
        for (let i = 0; i < lmList.length; i++) {
          const n = lmList[i].toLowerCase();
          if ((n.includes(q) || q.includes(n)) && Math.min(n.length, q.length) >= 4) { givenIdx = i; break; }
        }
        if (givenIdx >= 0) {
          const nm = lmList[givenIdx];
          const c = session.slots.nearbyLandmarkCoords?.[givenIdx];
          answer = `Ова е местото што Ви го спомнав — ${nm}.${c ? `\n${landmarkLink(nm, null, c.lat, c.lon)}` : ''}`;
        } else {
          // (b) Any known POI ("kade e Ramstor?") — answer from the offline map.
          // Center = the property under discussion: chain names resolve to the
          // NEAREST branch (TTK Banka near Капиштец ≠ Ново Лисиче branch).
          const ctxProp = session.slots.propertyId
            ? await this.deps.properties.getByEb(session.slots.propertyId).catch(() => undefined)
            : undefined;
          const center = ctxProp?.lat && ctxProp?.lon ? { lat: ctxProp.lat, lon: ctxProp.lon } : undefined;
          const poi = this.landmarks.findPlace(whereIs.place, center);
          if (poi) {
            answer = `${poi.name}:\n${landmarkLink(poi.name, poi.place_id ?? null, poi.lat, poi.lon, poi.place_url)}`;
          } else {
            // (c) Neighborhood / unknown — property-neighborhood or honest miss.
            // BUT: if we have a currently-shown property, the client is likely
            // asking about THAT property ("kade potocno se naogja garsonjerava?"
            // = where is this apartment we just saw?).  Answer with the
            // property's landmark instead of saying "I don't know".
            const curProp = shown[shown.length - 1]
              ?? (session.slots.propertyId
                ? await this.deps.properties.getByEb(session.slots.propertyId)
                : undefined)
              ?? (session.slots.interestedPropertyId
                ? await this.deps.properties.getByEb(session.slots.interestedPropertyId)
                : undefined);
            if (curProp) {
              await this.landmarks.enrich([curProp]);
              answer = this.whereIsReply(curProp, session, whereIs.place);
            } else {
              // EB rescue: the "place" text is unrecognized (verb typo junk like
              // "naogjaa 76", or an unknown name that happens to carry a number),
              // but it CONTAINS a property number. Before claiming ignorance,
              // try it as an EB — the number is almost always the property the
              // client means, and this branch only runs after the rotation slots
              // and the POI table both failed to match the text as a place.
              const m = whereIs.place.match(/(?:^|\s)(\d{1,5})(?:\s|$)/);
              if (m) {
                const ebHit = await this.deps.properties.getByEb(parseInt(m[1], 10));
                if (ebHit) {
                  await this.landmarks.enrich([ebHit]);
                  answer = this.whereIsReply(ebHit, session, whereIs.place);
                } else {
                  const loc = await this.areaNamed(whereIs.place);
                  answer = buildWhereIsAnswer(whereIs.place, loc ? { location: loc } : undefined);
                }
              } else {
                const loc = await this.areaNamed(whereIs.place);
                answer = buildWhereIsAnswer(whereIs.place, loc ? { location: loc } : undefined);
              }
            }
          }
        }
      } else {
        // NO ANCHOR: named-but-missing EB → honest not-found pivot; nothing
        // under discussion → ask for the Евидентен број. NEVER the repeated
        // visit pitch (the 20:51 stuck loop).
        answer = this.whereIsNoContext(session, text);
      }
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, answer);
      return;
    }

    // 0) Property DESCRIPTION without service type: the client remembers a
    // specific property they saw ("гарсоњерата кaj crnogorska ambasada") but
    // doesn't know the EB number. Route to property_locate for guided search.
    // Must come BEFORE the classifier so the FSM doesn't go to discovery.
    // Exclude service intents ("sakam da kupam/iznajmam") — those go to discovery.
    // EXCLUDE any message carrying an Евидентен броj ("ZDRAVO\nME
    // ZAINTERESIRA STANCETO SO BROJ 90\nDALI USTE GO IMATE?"): the number WINS
    // — property_locate is the NO-number funnel, and entering it asked "do you
    // know the EB?" for a number the client had just given (the 20:02 field
    // bug). With the EB present the classifier routes property_query, where
    // the availability branch (detectAvailabilityAsk) fires the correct ack.
    // THE PLACE ALONE (the «имавте нешто кај Црногорска амбасада?» capture):
    // a first message that names a PLACE and asks whether we have ANYTHING
    // there carries no category word, so detectPropertyDescription never fired
    // and the discovery "купување или изнајмување?" was the answer — about a
    // place the bank can read. The one-place reading below answers it.
    const placeOfferAsk = extractPoiWishCandidates(text, { withCriteria: true }).length > 0
      && /(?<![\p{L}\p{N}])(?:nesto|нешто)(?![\p{L}\p{N}])/iu.test(text)
      && /(?<![\p{L}\p{N}])(?:imate|imavte|imase|ima\s+li|имате|имавте|имаше|има\s+ли)(?![\p{L}\p{N}])/iu.test(text);
    if ((detectPropertyDescription(text) || placeOfferAsk) && inferPropertyId(text) === undefined
        && !session.slots.service
        && !detectService(text) && !detectBothServices(text)
        && !detectDrugAlternative(text)
        && !detectInvestmentOpinion(text)
        // EXCEPTION (00:09): the descriptor may carry PROPERTY INTEREST —
        // "гарсоњерата кај Црногорска амбасада ми е интересна". With a property
        // on the table that is an INTERESTED funnel message, not a guided
        // search: property_locate would answer "Дали го знаете Евидентен број?"
        // about the garsonjera Lina HERSELF had just offered. Interest wins;
        // the classifier's funnel override routes it to closing. A cold
        // interest line with nothing on the table keeps the guided search.
        // EXCEPTION (19:28 family): same for AVAILABILITY asks — "дали е
        // достапна гарсоњерата кај амбасадата?" is funnel traffic about a
        // property on the table, never a guided search; the classifier's
        // availability-with-known-EB guard (or the event-seam mention bind)
        // routes it to the ack for THAT property.
        && !(detectPropertyInterest(text) && propertyOnTable(session))
        && !(detectAvailabilityAsk(text) && propertyOnTable(session))) {
      routeLog(chatId, text, 'PROPERTY_DESCRIPTION');
      const slots = extractSlots(text);
      if (!slots.service) {
        // OFFER-AT-A-PLACE SERVE (the [11:29] recall): „имавте една гарсоњера
        // кај Црногорска амбасада“ asks whether we HAVE one there. The guided
        // search answered it with „Дали го знаете Евидентен број?“ — a number
        // the client almost never has. The feed can answer it: one row at that
        // landmark → the availability answer about THAT flat (named once, see
        // boundFlatIdentity); several → the which-one ask naming each of them.
        // Nothing at the place → the locate funnel below, unchanged (an area
        // like „во Центар“ never reaches here — bindMention needs кај/до/близу).
        // Only the PURE recall engages („имавте гарсоњера кај …“). A message
        // that also names the deal („куќа ЗА ИЗДАВАЊЕ кај Олимпико“) is a
        // guided search the locate funnel already answers with the row AT that
        // place — intercepting it here answered an availability question
        // nobody asked and dropped the service/location slots on the floor.
        const SERVICE_MARK_RE = /(?:izdava|izdavam|izdavanje|prodava|prodazba|prodavam|издава|издавам|издавање|продава|продажба|продавам|kirija|кирија)/iu;
        const offerMb = SERVICE_MARK_RE.test(text)
          ? undefined
          : await this.bindMention(text, session, { offerAtPlace: true });
        if (offerMb?.clarify) {
          session.state = 'property_locate';
          await this.sendIfClarify(offerMb, text, session);
          return;
        }
        if (offerMb?.prop) {
          const p = offerMb.prop;
          session.state = 'closing';
          session.slots.propertyId = p.eb;
          session.slots.interestedPropertyId = p.eb;
          session.slots.ownerContactPending = true;
          if (!session.slots.service && p.service) session.slots.service = p.service;
          // Same pre-resolve as the availability branch: the follow-up «каде
          // се наоѓа?» must have its landmarks ready.
          if (!session.slots.nearbyLandmarks?.length) {
            const nearby = this.landmarks.nearbyLandmarks(p);
            if (nearby.length > 0) {
              session.slots.nearbyLandmarks = nearby.map(n => n.landmark);
              session.slots.nearbyLandmarkCoords = nearby.map(n => ({ lat: n.lat, lon: n.lon }));
              session.slots.nearbyLandmarkEb = p.eb;
              session.slots.landmarkIndex = 0;
              session.slots.lastLandmark = undefined;
            }
          }
          const answer = this.availabilityReply(p, session, text);
          pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
          pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
          this.deps.sessions.set(session);
          await this.sendRaw(session, answer);
          return;
        }
        // No service declared — route to property_locate for guided search
        // extractSlots doesn't resolve feed neighborhoods — use detectLocation
        let loc = slots.location;
        if (!loc) {
          try {
            loc = await this.areaNamed(text);
          } catch { /* ignore */ }
        }
        if (loc) session.slots.location = loc;
        if (slots.bedrooms) session.slots.bedrooms = slots.bedrooms;
        if (slots.sqm) session.slots.sqm = slots.sqm;
        if (slots.budget) session.slots.budget = slots.budget;
        if (slots.sizeWaived) session.slots.sizeWaived = true;
        if (slots.pricePriority) session.slots.pricePriority = true;
        if (slots.garsonjera) session.slots.garsonjera = true;
        if (slots.plac) { session.slots.plac = true; session.slots.house = undefined; session.slots.business = undefined; }
        if (slots.yard) { session.slots.yard = true; if (!slots.business) session.slots.house = true; }
        // "та цена" / "та cenа" — client references a previously discussed price
        // but no number is in the message. Resolve to the last answered price.
        if (!session.slots.budget && detectPriceReference(text) && session.slots.lastPrice) {
          session.slots.budget = session.slots.lastPrice;
        }
        session.state = 'property_locate';
        // When location was already extracted from the first message, skip
        // the generic "do you know the EB number?" and ask for the remaining
        // specs (m², price) — the client already told us the neighborhood.
        // EB-DISCLAIM (the [11:08] capture rule): no Евидентен број
        // invitation once the client said he lacks it — the specs he CAN
        // give (населба / м² / цена) are the ask.
        const disclaimed = EB_DISCLAIM_RE.test(text);
        const answer = disclaimed && !loc
          ? LOCATE_DETAILS_ASK
          : loc
            ? buildLocateMoreSpecsAsk(displayAreaName(loc), { house: session.slots.house, business: session.slots.business, garsonjera: session.slots.garsonjera, plac: session.slots.plac }, !disclaimed)
            : buildLocateFirstAsk({ house: session.slots.house, business: session.slots.business, garsonjera: session.slots.garsonjera, plac: session.slots.plac });
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, answer);
        return;
      }
      // Service declared — fall through to classifier/discovery
    }

    // 0-b) THE FLATS SHE JUST OFFERED — DESCRIBE THEM, OR TAKE THE PICK.
    // Two lanes that own one conversation shape: Lina has just described
    // flats (the which-one ask) and the client either asks what she knows
    // about them ("OPISI MI GI?" — the [10:00] capture) or names the one he
    // meant. Both are answered from the bank's OWN rows: the records she said
    // she did not have ARE the feed she was reading from, and a pick is the
    // availability question, not a request for the whole card again.
    const onTableEbs = (session.slots.describedEbs?.length
      ? session.slots.describedEbs
      : session.slots.currentBatch?.length
        ? session.slots.currentBatch
        : [session.slots.interestedPropertyId ?? session.slots.propertyId]
          .filter((n): n is number => typeof n === 'number'))
      .slice(0, 2);
    if (onTableEbs.length > 0 && detectDescribeAsk(text)) {
      const rows = (await Promise.all(onTableEbs.map(eb => this.deps.properties.getByEb(eb).catch(() => undefined))))
        .filter((p): p is Property => !!p);
      if (rows.length > 0) {
        routeLog(chatId, text, 'DESCRIBE_TABLE');
        const intro = buildDescribeIntro(rows.length, {
          house: rows[0].house, business: rows[0].business,
          plac: rows[0].plac, garsonjera: rows[0].studio === true,
        });
        const answer = `${intro}\n\n${rows.map(p => buildPropertyCard(p)).join('\n\n')}`;
        session.slots.presentedIds = [...new Set([...(session.slots.presentedIds ?? []), ...rows.map(p => p.eb)])];
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, answer);
        return;
      }
    }
    if (session.slots.describedEbs?.length) {
      const describedRows = (await Promise.all(
        session.slots.describedEbs.map(eb => this.deps.properties.getByEb(eb).catch(() => undefined))))
        .filter((p): p is Property => !!p);
      const picked = pickDescribed(text, session.slots.describedEbs)
        ?? pickByDetail(text, describedRows);
      if (picked !== undefined) {
        const p = await this.deps.properties.getByEb(picked).catch(() => undefined);
        if (p) {
          routeLog(chatId, text, 'PICK_DESCRIBED');
          session.state = 'closing';
          session.slots.propertyId = p.eb;
          session.slots.interestedPropertyId = p.eb;
          session.slots.ownerContactPending = true;
          session.slots.describedEbs = undefined;
          if (!session.slots.nearbyLandmarks?.length) {
            const nearby = this.landmarks.nearbyLandmarks(p);
            if (nearby.length > 0) {
              session.slots.nearbyLandmarks = nearby.map(n => n.landmark);
              session.slots.nearbyLandmarkCoords = nearby.map(n => ({ lat: n.lat, lon: n.lon }));
              session.slots.nearbyLandmarkEb = p.eb;
              session.slots.landmarkIndex = 0;
              session.slots.lastLandmark = undefined;
            }
          }
          // The client JUST read the identity line — the short ack is the answer.
          const answer = this.availabilityReply(p, session, text);
          pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
          pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
          this.deps.sessions.set(session);
          await this.sendRaw(session, answer);
          return;
        }
      }
    }

    // THE WIDEN (the answer to the exhausted question above): the place held
    // nothing he wanted and she asked about other parts of town — «да» releases
    // the area lock and the SAME hunt continues there (service, category and
    // budget unchanged; only the neighborhood is dropped).
    if ((session.slots.describedEbs?.length ?? 0) > 0
        && session.slots.areaExhausted === true
        && (detectAgreement(text) || detectWidenIntent(text) || detectExplicitWiden(text))) {
      routeLog(chatId, text, 'LOCATE_WIDEN');
      session.slots.areaExhausted = false;
      session.slots.location = undefined;
      session.slots.poiArea = undefined;
      session.slots.poiAnchor = undefined;
      session.slots.clarifyAnchor = undefined;
      const next = await this.locateNextOptions(session);
      let answer = next.reply;
      if (next.shown.length === 0) {
        // Nothing anywhere else either — do not loop the same question: the
        // refine ask is the honest next step, and the hunt stops reading this
        // agreement as a widen.
        session.slots.areaExhausted = false;
        session.slots.describedEbs = undefined;
        answer = LOCATE_REFINE_ASK;
      }
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, answer);
      return;
    }

    if ((session.slots.describedEbs?.length ?? 0) > 0 && BARE_REFUSAL_ONLY_RE.test(text.trim())) {
      routeLog(chatId, text, 'LOCATE_CONTINUE');
      const next = await this.locateNextOptions(session);
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: next.reply }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, next.reply);
      return;
    }

    // 0-c) PLACE-LOCKED REJECTION (the [10:36] follow-up). «NE, NE E TAA» after
    // the ONE flat at the named place: the availability answer had already
    // bound it, so the chat sat in `closing` and the rejection fell through to
    // the standard presentation — another municipality's гapсоњера offered
    // under the generic «совршено се вклопуваат» opener, which reads as a
    // proximity claim. The place the client named is a LOCK: the next options
    // come from THERE, and when it is drained she asks about other areas
    // BEFORE leaving it (the same contract as the property_locate hunt).
    if (session.state !== 'property_locate'
        && detectRejection(text)
        && !detectFeeNag(text) && !detectFeeWhy(text) && !detectFeeComplaint(text)
        && !detectFeeSurprise(text) && !detectVisitCancellation(text)
        && !detectCheaperSearch(text)) {
      const rejectedEb = session.slots.propertyId ?? session.slots.interestedPropertyId;
      const rejectedProp = rejectedEb != null
        ? await this.deps.properties.getByEb(rejectedEb).catch(() => undefined)
        : undefined;
      // The lock: the client's own anchor when one was recorded, else the
      // place the REJECTED ROW's OWN record names (its feed landmark list,
      // then its resolved landmark) — the same evidence rule as the [10:36]
      // offer. No place recorded anywhere → no lock, and the standard
      // rejection handling keeps the turn.
      const ownPlace = rejectedProp?.landmarks?.[0]?.landmark ?? rejectedProp?.landmark;
      const lock = session.slots.clarifyAnchor
        ?? (session.slots.poiAnchor ? this.resolvePlace(session.slots.poiAnchor) : undefined)
        ?? (rejectedProp && ownPlace && rejectedProp.lat != null && rejectedProp.lon != null
          ? { name: ownPlace, lat: rejectedProp.lat, lon: rejectedProp.lon }
          : undefined);
      const atPlace = !!lock && !!rejectedProp
        && rejectedProp.lat != null && rejectedProp.lon != null
        && distM(lock.lat, lock.lon, rejectedProp.lat, rejectedProp.lon) <= NEAR_ANCHOR_SCOPE_M;
      if (atPlace && lock) {
        routeLog(chatId, text, 'LOCATE_REJECT_PLACE');
        session.state = 'property_locate';
        session.slots.propertyId = undefined;
        session.slots.interestedPropertyId = undefined;
        session.slots.ownerContactPending = false;
        session.slots.clarifyAnchor = { name: lock.name, lat: lock.lat, lon: lock.lon };
        if (rejectedEb != null) {
          session.slots.presentedIds = [...new Set([...(session.slots.presentedIds ?? []), rejectedEb])];
          // The rejected flat is what was ON the table — the widen gate reads
          // this to know a hunt is still open («да» → other neighbourhoods).
          session.slots.describedEbs = [rejectedEb];
        }
        const nextOpts = await this.locateNextOptions(session);
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: nextOpts.reply }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, nextOpts.reply);
        return;
      }
    }

    // 0-d) THE FEE QUESTION ANSWERED WITH THE CONTACT (the pick → full-flow
    // capture). «PETAR 070123456» arrives while `closing` sits on the fee
    // question: the message carries no criteria and no place, but it carries a
    // NAME and a PHONE for the flat the client already PICKED. That is the
    // consent the fee gate waits for, and the visit protocol starts — the flat
    // stays the picked one and nothing is re-presented (the LLM-down path
    // re-ran a fresh presentation about a flat he had already chosen). The
    // lane is narrow on purpose: the LAST thing she said must be the fee line,
    // and a real phone plus a plausible name must be present.
    if (session.state === 'closing'
        && (session.slots.propertyId ?? session.slots.interestedPropertyId) != null
        && !session.slots.name && !session.slots.phone
        && /(?<!\p{L})(?:денари|надомест|провизиј)/iu.test(assistantTexts(session).slice(-1)[0] ?? '')
        && !detectWhereIs(text) && !detectExactAddressAsk(text)
        && !detectFeeWhy(text) && !detectFeeNag(text) && !detectFeeComplaint(text)
        && !detectVisitCancellation(text)) {
      const contact = detectContact(text);
      if (contact.phone && isValidPhone(contact.phone) && contact.name && isPlausibleName(contact.name)) {
        routeLog(chatId, text, 'CONTACT_AFTER_FEE');
        session.slots.name = contact.name;
        session.slots.phone = contact.phone;
        session.slots.viewingFeeAgreed = true;
        session.state = 'visit_scheduling';
        const answer = VISIT_TIME_QUESTION;
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, answer);
        return;
      }
    }

    // Reply accumulators — declared early so the fast deterministic path
    // can use them before the classifier/FSM chain.
    let reply: string = '';
    let replySource = 'deterministic';
    let bankKey: string | undefined;

    // 0-ter) CONVERSATION-EXIT LANE (the [13:2x] V16K11 ending): "ne fala ti
    // / cao" rode the dynamic fallback, whose system prompt force-ends every
    // answer with a forward question — Lina thanked the client and asked
    // whether she can help with anything else AFTER he said goodbye. The exit
    // needs NO brain: a short warm farewell ending „Се најдобро!", no
    // question, no re-offer. A bare soft decline ("ne sakam", "не фала")
    // closes gracefully too — criteria stay registered, no re-offer question,
    // and it never burns a fee-refusal rung. State-free by design: a goodbye
    // is a goodbye in every funnel state.
    //
    // 0-ter-b) EXIT FINAL-CHECK (the V16K11 second capture): "Se predomisliv /
    // ke si piseme drugoat / moram da prekina" rode the dynamic fallback into
    // a cold farewell — the conversation ended without the one last-chance
    // question. BEFORE any farewell, serve the exit.criteria.check bank ask;
    // the farewell comes after the client's next turn (a simple "не" keeps the
    // pure-exit lane below; silence → TTL reset). Once per session.
    if (detectExitCheck(text)) {
      routeLog(chatId, text, 'EXIT_CHECK');
      if (session.slots.exitCheckServed !== true) {
        session.slots.exitCheckServed = true;
        reply = pickVariant('exit.criteria.check', { recent: assistantTexts(session) }) ?? EXIT_CRITERIA_CHECK;
        bankKey = 'exit.criteria.check';
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        console.log(`[timing] pipeline ${Date.now() - pipelineStart}ms (fast-deterministic) state=${session.state} src=deterministic bank=exit.criteria.check`);
        await this.sendRaw(session, reply, 'deterministic:fast');
        return;
      }
      // Already asked this session → let the farewell lanes below own it
      // (a burst this exit-shaped is closer to soft.refusal.close than to
      // bye.graceful: no fee-why, no EB, no question mark inside).
      routeLog(chatId, text, 'EXIT_CHECK_REPEAT');
    }
    if (detectBye(text)) {
      routeLog(chatId, text, 'BYE');
      // SECOND goodbye in one session: every bye.graceful variant shares the
      // «Ви благодарам за издвоеното време» skeleton — repeating it
      // word-for-word sounded robotic (the [20:0x] "Ne fala" → "Cao"
      // ending). A farewell already sent → swap to the short bye.again
      // parting: no thank-you skeleton, no repeat, no re-offer question.
      const byeAgain = session.slots.byeServed === true;
      session.slots.byeServed = true;
      reply = byeAgain
        ? (pickVariant('bye.again', { recent: assistantTexts(session) }) ?? BYE_AGAIN)
        : (pickVariant('bye.graceful', { recent: assistantTexts(session) }) ?? BYE_GRACEFUL);
      bankKey = byeAgain ? 'bye.again' : 'bye.graceful';
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      console.log(`[timing] pipeline ${Date.now() - pipelineStart}ms (fast-deterministic) state=${session.state} src=deterministic bank=${bankKey}`);
      await this.sendRaw(session, reply, 'deterministic:fast');
      return;
    }
    if (detectSoftRefusal(text)) {
      routeLog(chatId, text, 'SOFT_REFUSAL');
      reply = pickVariant('soft.refusal.close', { recent: assistantTexts(session) }) ?? SOFT_REFUSAL_CLOSE;
      bankKey = 'soft.refusal.close';
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      console.log(`[timing] pipeline ${Date.now() - pipelineStart}ms (fast-deterministic) state=${session.state} src=deterministic bank=soft.refusal.close`);
      await this.sendRaw(session, reply, 'deterministic:fast');
      return;
    }


    // 0b) Bank-backed informational interceptors — fire BEFORE needsClassifier.
    // These are pure Q&A (fee-why, investment opinion, price ask) that don't
    // need FSM transitions. They used to be trapped inside `if (!needsClassifier)`
    // so they NEVER fired in idle/intent/discovery — those states forced Groq.
    // Moving them here eliminates Groq calls for any message the bank can answer.
    // Guard: skip if the message needs the FSM (classifier → state transition).
    // fsmRequired is the SINGLE source of truth for all FSM-triggering detectors.
    // RENT-MATH / TOTAL-COST lane (the [00:36] transcript + owner commission
    // tiers): "ZNACI 0D 250 EVRA 125 SE ZA VAS?" and the "KOLKU KE ME KOSTA
    // KOMPLET? / KOLKU TREBA DA NOSAM SO MENE? / SO KOLKU PARI TREBA DA
    // DOJDAM?" family. Computed, never LLM-guessed. Owner commission rule:
    //   rent < 1000 → agency 50% of monthly rent (total = rent × 2.5)
    //   rent ≥ 1000 → agency 100% of monthly rent (total = rent × 3)
    //   owner payload (1st month + deposit = rent × 2) UNCHANGED in both.
    // The lane sits ABOVE the !fsmRequired gate: amount-bearing questions
    // extract budget → fsmRequired → the search machinery would swallow them
    // (and the budget must NOT apply — early return before applySlots).
    // Two inlets: a STATED amount (extractRentMath) or an amount-free
    // total-cost ask anchored on the rent property on the table
    // (slots.lastPrice, feed-verified service=rent).
    const mkMoney = (n: number) => n.toLocaleString('mk-MK', { maximumFractionDigits: 1 });
    let rentMath = extractRentMath(text);
    if (!rentMath && detectTotalCostAsk(text)) {
      // Anchor = the SUBJECT property on the table (interest/current/presented),
      // NOT slots.lastPrice — lastPrice holds the PRICE VALUE, and getById()
      // looks up by Евидентен број (getById(1200) would miss EB 42 @ 1200).
      const subject = session.slots.interestedPropertyId ?? session.slots.propertyId
        ?? session.slots.currentBatch?.[session.slots.currentBatch.length - 1]
        ?? session.slots.presentedIds?.[session.slots.presentedIds.length - 1];
      const anchor = subject !== undefined
        ? await this.deps.properties.getById(subject).catch(() => undefined)
        : undefined;
      if (anchor && anchor.price !== undefined && (anchor.service ?? session.slots.service) === 'rent') {
        rentMath = computeRentMath(anchor.price);
      }
    }
    if (rentMath) {
      const mathKey = rentMath.tier === 'high' ? 'rent.math.check.high' : 'rent.math.check';
      reply = pickVariant(mathKey, { recent: assistantTexts(session), vars: {
        r: mkMoney(rentMath.rent), c: mkMoney(rentMath.commission), d: mkMoney(rentMath.deposit), t: mkMoney(rentMath.total),
      } }) ?? (rentMath.tier === 'high'
        ? `За недвижност со месечна кирија од ${mkMoney(rentMath.rent)} евра: провизијата на агенцијата е една месечна кирија — ${mkMoney(rentMath.commission)} евра — а ${mkMoney(rentMath.deposit)} евра (депозит + прва кирија) е за сопственикот. Вкупна сума од ${mkMoney(rentMath.total)} евра на денот на потпишување на договорот.`
        : `Точно. Од месечна кирија од ${mkMoney(rentMath.rent)} евра: половина — ${mkMoney(rentMath.commission)} евра — е за агенцијата, а ${mkMoney(rentMath.deposit)} евра (депозит + прва кирија) за сопственикот. Вкупно на денот на потписот: ${mkMoney(rentMath.total)} евра.`);
      bankKey = mathKey;
      routeLog(chatId, text, 'RENT_MATH:fast');
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic') && bankKey) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'RENT_MATH_FAST', userMsg: text, replyText: reply, replySource: 'deterministic', bankKey }); } catch { /* ignore */ } }
      console.log(`[timing] ${Date.now() - pipelineStart}ms (fast-deterministic) state=${session.state} src=deterministic bank=${bankKey}`);
      await this.sendRaw(session, reply, 'deterministic:fast');
      return;
    }
    if (!fsmRequired(text)) {
      // OWNER-CONTACT HOLD ([22:47]): "NE GO KONTAKTIRAJ USTE" / "NE SME SE
      // DOGOVORILE" — the client pumps the brakes on the owner contact or says
      // the deal is not agreed yet. Before this lane the first read as the
      // "contact me" agreement token (the funnel advanced) and the second hit
      // the documents regex's bare "договор" arm inside "договориле" (a
      // paperwork lecture). Acknowledge and do NOT proceed; when the owner
      // check was already in flight, step back to visit_scheduling so the late
      // owner verdict is dropped (applyOwnerVerdict bails unless state is
      // owner_checking).
      if (detectOwnerContactHold(text)) {
        if (session.state === 'owner_checking') session.state = 'visit_scheduling';
        reply = pickVariant('owner.hold', { recent: assistantTexts(session) })
          ?? 'Во ред, нема да го контактирам сопственикот додека не се договориме. Кажете ми што би сакале претходно да разјасниме, па ќе продолжиме кога ќе бидете подготвени.';
        bankKey = 'owner.hold';
        routeLog(chatId, text, 'OWNER_HOLD:fast');
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic') && bankKey) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'OWNER_HOLD_FAST', userMsg: text, replyText: reply, replySource: 'deterministic', bankKey }); } catch { /* ignore */ } }
        console.log(`[timing] ${Date.now() - pipelineStart}ms (fast-deterministic) state=${session.state} src=deterministic bank=${bankKey}`);
        await this.sendRaw(session, reply, 'deterministic:fast');
        return;
      }
      // THE FEE-NAG LADDER (both markets, one order): every resistance shape —
      // charge accusation ("PARI ZA POSETA BARATE", "PARI ZEMATE ZA POSETA ?"),
      // value complaint ("MNOGU NEKAKO 500DEN..."), "nobody charges but you",
      // refusal and surprise — burns exactly ONE visit-fee rung: persuade →
      // agency rule → decision → graceful close. Before this, complaints and
      // "nikoj ne naplatuva" were answered from fee.why WITHOUT advancing, so
      // the ladder stalled on repeated filter answers and never reached the
      // rule or the decision (the 300/500 transcript). detectFeeNag is the one
      // grammar-based predicate for both fees; the commission lane above keeps
      // its own counter untouched (the isolation contract).
      // PRESENTATION IS A FEE CONTEXT TOO (the [23:12] field case): a client
      // looking at a batch of flats can object to the fee he was told about
      // earlier. Before this gate, the nag fell into the criteria/present
      // machinery and the funnel answered a fee objection with MORE PROPERTIES —
      // the exact pivot the fix above killed for the cheaper-search lane. The
      // ladder owns the objection in presentation as well; the counter is the
      // same one (a nag is a nag wherever the client is standing).
      // (The fee-nag ladder used to live HERE, ~800 lines into the chain — after
      // the criteria extraction, the area locks and the property loaders had
      // already run. A nag therefore MUTATED the search bookkeeping on its way
      // to the ladder: presentedIds grew by a batch the client never saw
      // (fee=1 in presentation appended EB 78). It now runs FIRST in this
      // region — see the lane right after the commission ladder — so a fee
      // objection reaches NO search machinery at all.)
      // FIRST TIME HEARING THE FEE ([00:28] TUI): "OVA PRV PAT SLUSAM" — the
      // client is not asking WHY the fee exists, he is saying he never met it
      // before. The answer is the FACT, not another filter rationale: it is
      // the agency's standing rule, in our price list, the same for every
      // client. Explanation traffic — no rung burned, funnel stays at the fee.
      if (detectFeeFirstTime(text) && ['closing', 'property_query', 'presentation', 'discovery', 'intent', 'idle'].includes(session.state)) {
        reply = pickVariant('fee.rule.hold', { recent: assistantTexts(session) }) ?? buildFeeRule();
        bankKey = 'fee.rule.hold';
        routeLog(chatId, text, 'FEE_FIRST_TIME:fast');
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic') && bankKey) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'FEE_FIRST_TIME_FAST', userMsg: text, replyText: reply, replySource: 'deterministic', bankKey }); } catch { /* ignore */ } }
        console.log(`[timing] ${Date.now() - pipelineStart}ms (fast-deterministic) state=${session.state} src=deterministic bank=${bankKey}`);
        await this.sendRaw(session, reply, 'deterministic:fast');
        return;
      }
      if (detectFeeWhy(text) && ['closing', 'property_query', 'presentation', 'discovery', 'intent', 'idle'].includes(session.state)) {
        reply = pickVariant('fee.why', { recent: assistantTexts(session) }) ?? 'Разбирам. Надоместот за разгледување е симболичен и служи како филтер за сериозни клиенти.';
        bankKey = 'fee.why';
        routeLog(chatId, text, 'FEE_WHY:fast');
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic') && bankKey) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'FEE_WHY_FAST', userMsg: text, replyText: reply, replySource: 'deterministic', bankKey }); } catch { /* ignore */ } }
        console.log(`[timing] ${Date.now() - pipelineStart}ms (fast-deterministic) state=${session.state} src=deterministic bank=${bankKey}`);
        await this.sendRaw(session, reply, 'deterministic:fast');
        return;
      }
      if (detectFeeComplaint(text) && session.state === 'closing' && !detectFeeWhy(text)) {
        reply = pickVariant('fee.why', { recent: assistantTexts(session) }) ?? 'Разбирам. Надоместот за разгледување е симболичен и служи како филтер за сериозни клиенти.';
        bankKey = 'fee.why';
        routeLog(chatId, text, 'FEE_COMPLAINT:fast');
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic') && bankKey) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'FEE_COMPLAINT_FAST', userMsg: text, replyText: reply, replySource: 'deterministic', bankKey }); } catch { /* ignore */ } }
        console.log(`[timing] ${Date.now() - pipelineStart}ms (fast-deterministic) state=${session.state} src=deterministic bank=${bankKey}`);
        await this.sendRaw(session, reply, 'deterministic:fast');
        return;
      }
      // Fee SURPRISE ("AUUU OVA E NESTO NOVO") — the reaction to learning
      // visits cost money. The 13:01 transcript: the pushback ("NAPLAKJATE
      // ZA POSETA") substring-matched provision-who and the surprise fell
      // through to the LLM, which answered CONTRACT terms (advokat/notar
      // 50/50). Both messages are fee-protocol traffic: Lina must explain
      // the visit-fee REASONS. closing-only gate — "imate nesto novo vo
      // karpos?" (a property ask) must never reach this branch.
      if (detectFeeSurprise(text) && session.state === 'closing') {
        reply = pickVariant('fee.why', { recent: assistantTexts(session) }) ?? 'Разбирам. Надоместот за разгледување е симболичен и служи како филтер за сериозни клиенти.';
        bankKey = 'fee.why';
        routeLog(chatId, text, 'FEE_SURPRISE:fast');
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic') && bankKey) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'FEE_SURPRISE_FAST', userMsg: text, replyText: reply, replySource: 'deterministic', bankKey }); } catch { /* ignore */ } }
        console.log(`[timing] ${Date.now() - pipelineStart}ms (fast-deterministic) state=${session.state} src=deterministic bank=${bankKey}`);
        await this.sendRaw(session, reply, 'deterministic:fast');
        return;
      }
      if (detectInvestmentOpinion(text)) {
        reply = pickVariant('investment.opinion', { recent: assistantTexts(session) })
          ?? 'Разбирам. Цените ги одредуваат сопствениците, а ние сме само посредници. Дали сакате да Ви понудам некои опции во друг реон, или да го контактирам сопственикот за моменталната цена?';
        bankKey = 'investment.opinion';
        routeLog(chatId, text, 'INVESTMENT_OPINION:fast');
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic') && bankKey) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'INVESTMENT_OPINION_FAST', userMsg: text, replyText: reply, replySource: 'deterministic', bankKey }); } catch { /* ignore */ } }
        console.log(`[timing] ${Date.now() - pipelineStart}ms (fast-deterministic) state=${session.state} src=deterministic bank=${bankKey}`);
        await this.sendRaw(session, reply, 'deterministic:fast');
        return;
      }
      // Praise WITHOUT a visit verb ("ODLICNA LOKACIJA IMA", "BAS TAKOV MI
      // TREBA") — the 21:02 bug: with the LLM down the bare INTERESTED branch
      // disclosed the fee BEFORE any visit interest. Session-mutating, so it
      // must sit BEFORE the stateless fast-remark/LLM paths (mirror below at
      // the FSM leg). Mark the property as liked + owner-contact pending and
      // serve property.liked (enthusiasm + visit offer). NO fee here — the fee
      // comes only after the client confirms. Same guards as the FSM mirror:
      // fee-family and search-criteria messages keep their own paths.
      if (detectPositiveEval(text)
        && (session.slots.propertyId || session.slots.interestedPropertyId || session.slots.presentedIds?.length)
        && !detectPropertyInterest(text) && !detectVisitInterest(text)
        && !detectVisitTimingQuestion(text) // timing QUESTION → its own lane (the [19:56] rule)
        && !detectAvailabilityAsk(text) && !detectRemark(text)
        && !detectFeeWhy(text) && !detectFeeComplaint(text) && !detectFeeSurprise(text)
        && !detectFeePaymentAgreement(text) && !detectInvestmentOpinion(text)
        && !detectVisitTime(text)
        && !detectBudget(text) && !detectService(text) && !detectBothServices(text)
        && !detectHouse(text) && !detectBusiness(text) && !detectPriceAsk(text)
        && !detectWhereIs(text) && !detectExactAddressAsk(text)
        && !detectAgreement(text)
        && (session.state !== 'closing' || !!session.slots.ownerContactPending)) {
        const eb = session.slots.propertyId ?? session.slots.interestedPropertyId
          ?? session.slots.presentedIds?.[session.slots.presentedIds.length - 1];
        // GHOST GUARD (P4 follow-up): same rule as the slow lanes — an anchor
        // the feed can no longer confirm gets the not-found pivot, never the
        // funnel (getById = authoritative rescue for off-batch properties).
        const anchored = eb != null && !!(await this.deps.properties.getById(eb).catch(() => undefined));
        if (eb != null && !anchored) {
          // FEED-DOWN GUARD: a failed feed with no cache cannot confirm the
          // EB is gone — brand nothing as a ghost, clear no anchors. The
          // not-found line still NAMES the EB the client asked about.
          if (!this.feedHealthy()) {
            routeLog(chatId, text, 'FEEDDOWN:fast');
            pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
            pushHistory(session, { role: 'assistant', text: FEED_UNAVAILABLE_LINE }, this.cfg.maxHistory);
            this.deps.sessions.set(session);
            await this.sendRaw(session, FEED_UNAVAILABLE_LINE, 'deterministic:fast');
            return;
          }
          const nf = pickVariant('property.notfound', { recent: assistantTexts(session), vars: { eb: String(eb) } })
            ?? PROPERTY_NOT_FOUND_LINE(eb);
        session.slots.propertyId = undefined;
        session.slots.interestedPropertyId = undefined;
        session.slots.lastGhostEb = eb;
        routeLog(chatId, text, 'GHOST:fast');
          pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
          pushHistory(session, { role: 'assistant', text: nf }, this.cfg.maxHistory);
          this.deps.sessions.set(session);
          if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic')) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'GHOST_NOTFOUND_FAST', userMsg: text, replyText: nf, replySource: 'deterministic', bankKey: 'property.notfound' }); } catch { /* ignore */ } }
          await this.sendRaw(session, nf, 'deterministic:fast');
          return;
        }
        if (eb) {
          session.slots.interestedPropertyId = eb;
          session.slots.ownerContactPending = true;
          if (session.state !== 'closing') session.state = 'closing';
        }
        const liked = pickVariant('property.liked', { recent: assistantTexts(session) })
          ?? 'Одличен избор! Дали би сакале да организирам посета, за да го погледнете во живо?';
        routeLog(chatId, text, 'ENTHUSIASM:fast');
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: liked }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic')) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'ENTHUSIASM_FAST', userMsg: text, replyText: liked, replySource: 'deterministic', bankKey: 'property.liked' }); } catch { /* ignore */ } }
        console.log(`[timing] ${Date.now() - pipelineStart}ms (fast-enthusiasm) state=${session.state} src=deterministic bank=property.liked`);
        await this.sendRaw(session, liked, 'deterministic:fast');
        return;
      }
      // WAITING-TURN (the [16:06] transcript): "CEKAM USTE" — the client is
      // WAITING for the details Lina promised. Not funnel traffic, not a
      // remark: the LLM "compensates" for the info gap with invented
      // owner-contact activity and another visit offer, deepening the gap.
      // The FSM already routes STAY-while-waiting in visit_scheduling to the
      // owner_checking patience line — this extends the same contract to the
      // other conversation states (property_query/closing/presentation),
      // statelessly, before the remark/LLM fast paths can swallow it. The
      // detector vetoes every concurrent topic (day/time, agreement, fee,
      // search criteria, property reference), so a real request never lands
      // here.
      if (detectWaitingAck(text)
        && !['visit_scheduling', 'owner_checking', 'time_confirm', 'pending', 'queued', 'escalated', 'terminated'].includes(session.state)
        && (session.slots.propertyId || session.slots.interestedPropertyId || session.slots.presentedIds?.length)) {
        const patience = pickVariant('patience.line', { recent: assistantTexts(session) }) ?? PATIENCE_LINE;
        routeLog(chatId, text, 'WAITING:fast');
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: patience }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic')) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'WAITING_FAST', userMsg: text, replyText: patience, replySource: 'deterministic', bankKey: 'patience.line' }); } catch { /* ignore */ } }
        console.log(`[timing] ${Date.now() - pipelineStart}ms (fast-waiting) state=${session.state} src=deterministic bank=patience.line`);
        await this.sendRaw(session, patience, 'deterministic:fast');
        return;
      }
      // Conversational remark about the property under discussion ("DOBRA
      // LOKACIJA IMA", "ubavo mesto") — the 22:05 bug: it fell through to the
      // STAY card re-serve (property_query) or the INTERESTED fee jump. A
      // remark is NOT funnel traffic: answer it with the REAL brain
      // conversationally, change no state, touch no slots. Guarded to contexts
      // where a property actually exists (a "nice place" during discovery with
      // no property is search chatter and stays with the classifier), and to
      // messages with no search criteria ("ubavo mesto vo karpos do 500" = a
      // search, not a remark).
      if (detectRemark(text)
        && (session.slots.propertyId || session.slots.interestedPropertyId || session.slots.presentedIds?.length)
        && !detectBudget(text) && !detectService(text) && !detectBothServices(text)
        && !detectHouse(text) && !detectBusiness(text) && !detectPriceAsk(text)) {
        // BANK-FIRST, knowledge-based dispatch: a compliment is routine, and
        // routine must be free. pickVariant = seed (responses.ts) + learned
        // (SQLite bank_variants, live). If a variant exists, serve it — same
        // protocol as fee.why/investment.opinion — and tag the enrichment row
        // with the bankKey so the cron CAN grow the key. Missing variants
        // escalate to the REAL brain (never a canned wrong line); Gemini's
        // reply is logged WITHOUT bankKey so the cron learns NEW variants into
        // this key's pool.
        const ack = pickVariant('remark.ack', { recent: assistantTexts(session) });
        if (ack) {
          routeLog(chatId, text, 'REMARK:bank');
          pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
          pushHistory(session, { role: 'assistant', text: ack }, this.cfg.maxHistory);
          this.deps.sessions.set(session);
          if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic')) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'REMARK_FAST', userMsg: text, replyText: ack, replySource: 'deterministic', bankKey: 'remark.ack' }); } catch { /* ignore */ } }
          console.log(`[timing] ${Date.now() - pipelineStart}ms (fast-remark) state=${session.state} src=deterministic bank=remark.ack`);
          await this.sendRaw(session, ack, 'deterministic:fast');
          return;
        }
        // Current property in context — Gemini needs it to talk ABOUT the
        // remark's subject ("да, локацијата е одлична, во строг Центар…").
        // Without it Gemini hallucinates availability. And if the LLM fails,
        // the fallback re-serves THE CURRENT property's card — the only card
        // that is never "offering other properties" junk.
        // A remark that NAMES a property gives the brain THAT property as
        // context ("ubava e garsonjerata kaj ambasadata") — the stale slot
        // fed it the wrong card (00:09 class). No clarify here: a remark
        // must stay frictionless; an unresolved mention keeps the old chain.
        const mbRemark = await this.bindMention(text, session);
        const remarkEb = mbRemark?.prop?.eb ?? session.slots.propertyId ?? session.slots.interestedPropertyId
          ?? (session.slots.presentedIds?.length ? session.slots.presentedIds[session.slots.presentedIds.length - 1] : undefined);
        const remarkProp = remarkEb ? await this.deps.properties.getById(remarkEb).catch(() => undefined) : undefined;
        const r = await this.deps.responder.respond(session, remarkProp ? [remarkProp] : [], text);
        routeLog(chatId, text, 'REMARK:fast');
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: r.text }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), r.source !== 'deterministic' && r.source !== 'fallback', r.source)) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'REMARK', userMsg: text, replyText: r.text, replySource: r.source, bankKey: r.source === 'fallback' ? 'remark.ack' : undefined }); } catch { /* ignore */ } }
        console.log(`[timing] ${Date.now() - pipelineStart}ms (fast-remark) state=${session.state} src=${r.source}`);
        await this.sendRaw(session, r.text, r.source);
        return;
      }
      // detectPriceAsk matches 'DO 500 EVRA' because it contains 'евра' —
      // that's a budget statement, NOT a price question. Guard: exclude messages
      // that contain a budget number (detectBudget fires) so they reach the
      // classifier as DETAILS_PROVIDED instead of being swallowed here.
      if (detectPriceAsk(text) && !detectBudget(text)
          && !detectProvisionAsk(text) && !detectProvisionWho(text) && !detectDrugAlternative(text)
          && !detectFeeComplaint(text)
          // PRICE-SHY VETO (the [14:46] capture): "REALNA CENA ZA OVOJ REON
          // AMA SAKAM NESTO POEFTINO" is a CHEAPER-SEARCH with a price word
          // riding along. The price echo („Станот … чини 190.000“) is the
          // WRONG serve — the cheaper lane owns the message.
          && !detectCheaperSearch(text)
          // FEE-TRAFFIC veto: a fee objection that happens to carry "cena"
          // must climb the fee ladder, never quote the property's price.
          && !isFeeTraffic(text)) {
        // MENTION BINDING (12:33 rule, fast leg): this path PREEMPTS the FSM
        // price branch (same detector guard, earlier in the pipeline), so
        // without a bind here a NAMED price ask ("KOLKU E GARSONJERATA KAJ
        // AMBASADATA?") answered from the stale shown[last] slot — the 00:09
        // class. A clear mention binds THAT property; ambiguity asks back
        // once (the FSM branch's own protocol, mirrored); no mention keeps
        // the legacy chain.
        const mbPriceFast = await this.bindMention(text, session);
        const priceEb = mbPriceFast?.prop?.eb
          ?? inferPropertyId(text)
          ?? session.slots.propertyId
          ?? session.slots.interestedPropertyId
          // Same [22:24] anchor rule as the freshness lane: a bare price ask
          // names the property the conversation last spoke about, never the
          // batch presented before it.
          ?? await this.lastKnownHistoryEb(session)
          ?? (session.slots.presentedIds?.length ? session.slots.presentedIds[session.slots.presentedIds.length - 1] : undefined);
        if (mbPriceFast?.clarify) {
          reply = mbPriceFast.clarify;
        } else if (priceEb) {
          const p = await this.deps.properties.getById(priceEb);
          if (p?.price !== undefined) {
            const priceLoc = p.location?.replace(/\s*\([^)]*\)\s*$/, '') ?? '';
            const priceType = p.house ? 'Куќата' : p.business ? 'Деловниот простор' : 'Станот';
            // Rent-aware wording (the [22:53] contract): a rental's price is
            // "киријата", not "чини" — the client asked KOLKU MU E KIRIJA and
            // must hear kirija in the answer.
            const isRentP = (p.service ?? session.slots.service) === 'rent';
            reply = isRentP
              ? `${priceType} со Евидентен број ${p.eb}${priceLoc ? ` ${locPrep(priceLoc)} ${priceLoc}` : ''} — киријата изнесува ${p.price.toLocaleString('mk-MK')} евра.`
              : `${priceType} со Евидентен број ${p.eb}${priceLoc ? ` ${locPrep(priceLoc)} ${priceLoc}` : ''} чини ${p.price.toLocaleString('mk-MK')} евра.`;
            session.slots.lastPrice = String(p.price);
          } else {
            // Price-less feed row: the “price” here IS the viewing fee — serve
            // the fee.ask for the PROPERTY'S OWN service. A rental must never
            // get the buy fee (audit fix; previously hardcoded 'fee.ask.buy').
            const psvc = p?.service ?? session.slots.service ?? 'buy';
            reply = pickVariant(psvc === 'rent' ? 'fee.ask.rent' : 'fee.ask.buy', { recent: assistantTexts(session) }) ?? 'Цената ја одредува сопственикот.';
          }
        } else {
          reply = 'За кое конкретно станува збор? Кажете ми Евидентен број и ќе Ви ја соопштам цената.';
        }
        bankKey = 'price.ask';
        routeLog(chatId, text, 'PRICE_ASK:fast');
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'deterministic') && bankKey) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'PRICE_ASK_FAST', userMsg: text, replyText: reply, replySource: 'deterministic', bankKey }); } catch { /* ignore */ } }
        console.log(`[timing] ${Date.now() - pipelineStart}ms (fast-deterministic) state=${session.state} src=deterministic bank=${bankKey}`);
        await this.sendRaw(session, reply, 'deterministic:fast');
        return;
      }
    }

    // RECOMMENDATION ask — "koj bi mi go preporacale?" after the client named
    // EBs. THE FIX: no detector fired, the LLM misread it as SEEN_PROPERTY and
    // asked "Дали го знаете Евидентен број?" for numbers the client JUST gave.
    // Deterministic: collect the mentioned EBs from recent messages, validate
    // against the DB, present each as a full card (DB facts) + the professional
    // close (clientela line + visit offer). One per-turn slot consumed.
    if (detectRecommendAsk(text)
      && !fsmRequired(text)
      && ['idle', 'intent', 'discovery', 'property_query', 'presentation'].includes(session.state)) {
      const userMsgs = session.history.filter(m => m.role === 'user').map(m => m.text);
      const ebs = collectMentionedEbs(userMsgs, await this.deps.properties.getAllEbs());
      const picks = (await Promise.all(ebs.map(eb => this.deps.properties.getByEb(eb).catch(() => undefined))))
        .filter((p): p is NonNullable<typeof p> => !!p);
      if (picks.length > 0) {
        routeLog(chatId, text, 'RECOMMEND_ASK');
        if (picks.length === 1) session.slots.propertyId = picks[0]!.eb;
        else session.slots.presentedIds = picks.map(p => p.eb);
        const answer = buildRecommendation(picks, buildRecommendClose(assistantTexts(session)));
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, answer);
        return;
      }
      // No EBs named in recent messages, but properties were just presented
      // ("KOJ OD OVIE DVA E PODOBAR SPORED VAS?" right after a card batch):
      // the judgment question is about THOSE — serve the clientela close
      // WITHOUT re-dumping the cards (the client just read them).
      const shownIds2 = session.slots.presentedIds ?? [];
      if (shownIds2.length > 0) {
        routeLog(chatId, text, 'RECOMMEND_ASK');
        const answer = buildRecommendClose(assistantTexts(session));
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, answer);
        return;
      }
      // Nothing under discussion at all: fall through — the classifier may
      // still handle a legit recommendation frame.
    }

    // FEE-WHY / FEE-RULES / TOTAL-COST INTERCEPT BEFORE THE PROVISION LANES
    // (the [09:0x] + [12:40] V16K11 transcripts): "nikoj ne zema pari za
    // poseta" matched CHARGE_MONEY_RE inside detectProvisionAsk →
    // PROVISION_ASK → the buy rules-of-work script; "ako gledam 10 stana toa
    // se 5000 od moj djeb" rode the INTERESTED lane into the fee ask with the
    // WRONG service. Both are fee-EXPLANATION traffic in ANY funnel state —
    // dispatchSimple runs pre-classifier, so the ownership must live HERE.
    // fsmRequired guard: when the FSM forces the full path, the fee.why FSM
    // legs already own the serve — no double-talk.
    const feeRulesQ = detectFeeRules(text);
    const feeWhyFast = !feeRulesQ && detectFeeWhy(text);
    const feeTotalCost = !feeRulesQ && !feeWhyFast && detectFeeTotalCost(text);
    if (!fsmRequired(text) && (feeRulesQ || feeWhyFast || feeTotalCost)) {
      const beforeWhy = session.state;
      // property_locate + contact_collection too: an explanation mid-locate
      // must never advance the locate funnel (the [12:40] idle→closing leg
      // proved the narrow list leaks).
      if (['closing', 'property_query', 'presentation', 'discovery', 'intent', 'idle', 'property_locate', 'contact_collection'].includes(beforeWhy)) {
        routeLog(chatId, text, feeRulesQ ? 'FEE_RULES' : feeWhyFast ? 'FEE_WHY' : 'FEE_COMPLAINT');
        if (!session.slots.service) session.slots.service = this.feeServiceHint;
        // Market questions without a declared market get the AGNOSTIC copy
        // (buildFeeAsk(undefined) names both fees) — never a defaulted buy
        // disclosure at a rent client.
        reply = feeRulesQ
          ? (pickVariant('fee.rules', { recent: assistantTexts(session) }) ?? buildFeeRules())
          : feeTotalCost
            ? (pickVariant('fee.why', { recent: assistantTexts(session) }) ?? buildFeeWhy())
            : (pickVariant('fee.why', { recent: assistantTexts(session) }) ?? buildFeeWhy());
        bankKey = feeRulesQ ? 'fee.rules' : 'fee.why';
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        console.log(`[timing] pipeline ${Date.now() - pipelineStart}ms (fast-deterministic) state=${beforeWhy} src=deterministic bank=${bankKey}`);
        await this.sendRaw(session, reply, 'deterministic:fast');
        return;
      }
    }

    // 0c) dispatchSimple: bank-backed informational intents (offtopic, defer,
    // negotiate, provision, documents, mortgage, scheduling, etc.). These fire
    // BEFORE the classifier — they don't need FSM transitions, they just answer
    // a question and stay in the current state. The dispatchSimple table already
    // has allowedStates gates so they only fire in appropriate states.
    // Guard: skip if fsmRequired — same guard as the interceptors above.
    const simpleFast = !fsmRequired(text) ? dispatchSimple(text, session.state) : undefined;
    if (simpleFast) {
      routeLog(chatId, text, simpleFast.intent);
      // [09:0x] burst backfill: "samo vie rabotite taka / nikoj ne zema pari za
      // poseta" — the SECOND line declares the market; WITHOUT the backfill the
      // provision ternary reads slots.service of a RESET session (undefined) and
      // defaults to the buy script (the yesterday renter got 500 ден + 0%).
      if (!session.slots.service) session.slots.service = this.feeServiceHint;
      let effectiveKey = simpleFast.bankKey;
      if (effectiveKey === 'provision.ask') {
        effectiveKey = provisionKeyFor(session.slots.service);
      } else if (effectiveKey === 'provision.who') {
        const isDanok = /danok|danokot|данок|данокот/i.test(text);
        if (isDanok && session.slots.service !== 'rent') {
          effectiveKey = 'provision.who.danok.buy';
        } else {
          effectiveKey = session.slots.service === 'rent' ? 'provision.who.rent'
            : session.slots.service === 'buy' ? 'provision.who.buy'
            : PROVISION_ASK_NEITHER;
        }
      }
      const pickedFast = pickVariant(effectiveKey, { recent: assistantTexts(session) });
      if (pickedFast) {
        reply = pickedFast;
        bankKey = effectiveKey;
      } else {
        // Bank miss (P4): the literal serves with NO bank identity and the
        // serve is logged as FALLBACK_ORPHAN right here — this lane returns
        // early, so the epilogue capture never sees it.
        reply = simpleFast.fallback;
        replySource = 'fallback';
        if (this.deps.enrichment && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'fallback')) {
          try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'FALLBACK_ORPHAN', userMsg: text, replyText: reply, replySource: 'fallback' }); } catch { /* advisory */ }
        }
      }
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      if (this.deps.enrichment && bankKey) {
        try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'DETERMINISTIC_FAST', userMsg: text, replyText: reply, replySource: 'deterministic', bankKey }); } catch (e) { console.error('[enrichment] log failed:', (e as Error).message); }
      }
      const pipelineMs = Date.now() - pipelineStart;
      console.log(`[timing] pipeline ${pipelineMs}ms (fast-deterministic) state=${session.state} src=deterministic bank=${bankKey}`);
      await this.sendRaw(session, reply, 'deterministic:fast');
      return;
    }

    // 1) Deterministic intent extraction — NO LLM call.
    // Classify using only regex detectors + buildEvent. Only falls to Groq
    // when the message is truly novel (no detector fires, no slots extracted).
    let classified = await this.deps.classifier.deterministicClassify(session, text);
    if (!classified) {
      // Truly novel message — Groq classifies the state, then Gemini answers.
      // LEARNING LAYER: flag the fallthrough — the turn-end capture hook turns
      // this into a hardening-corpus candidate (the phrasing stops being
      // novel once a detector owns it).
      this.detGaveUp = true;
      // LEARNED SERVE before the classifier: a stored answer serves free, and
      // a genuine uncovered question is generated ONCE (gated) and stored, so
      // the next occurrence never reaches the classifier or Gemini again.
      if (await this.tryLearnedServe(session, text)) return;
      classified = await this.deps.classifier.classify(session, text);
    }

    // 2) Slots + FSM transition
    // EVENT-SEAM MENTION BINDING (audit): several classifier guards stamp
    // propertyId from the SLOTS (availability-with-known-EB, interest
    // overrides) and the LLM may stamp its own guess — applySlots then pins
    // that id into slots.propertyId, re-anchoring the WHOLE funnel (loadProps
    // property_query trusts it exclusively). When THIS message names a
    // property by anything (descriptor, type, price, POI anchor) and carries
    // no bare EB, a UNIQUE mention bind outranks the slot/LLM-derived stamp
    // (the 12:33 rule at the event level). An availability ask that binds is
    // promoted to PROPERTY_ID_REQUESTED so the FSM's availability ack fires
    // for THAT property (the [19:28] class: never "Дали го знаете Евидентен
    // број?" about a property that is on the table). Ambiguous mentions fall
    // through — the FSM branches ask back ONCE (clarify protocol); an
    // explicit EB in the text is never overridden.
    let ev = classified.event;
    if (!inferPropertyId(text)) {
      const mbEv = await this.bindMention(text, session);
      // A FEED-WIDE ambiguity is the one case the FSM cannot recover from: the
      // table holds a different property and nothing on it matches the hint, so
      // the turn would answer about whatever was shown. Ask which one it is.
      if (mbEv?.fromFeed && (await this.sendIfClarify(mbEv, text, session))) return;
      if (mbEv?.prop) {
        if (detectAvailabilityAsk(text) && ev.type !== 'PROPERTY_ID_REQUESTED'
          && ev.type !== 'REJECTED' && ev.type !== 'ESCALATE') {
          ev = { type: 'PROPERTY_ID_REQUESTED', propertyId: mbEv.prop.eb };
        } else if (ev.propertyId !== mbEv.prop.eb) {
          ev.propertyId = mbEv.prop.eb;
        }
      }
    }
    // RESULT-SET RESTATEMENT (the [23:57] rule): "SAMO OVIE DVA STANA GI IMATE
    // SO DVE ILI TRI SPALNI ?" asks about the POOL just shown — the numbers in
    // it RESTATE the criteria the funnel already armed ("dve… najmalce" →
    // bedrooms=3); applying them as a fresh range relabels the criteria
    // "2 или 3 спални" in the counted-inventory answer and skews the pool
    // question. A result-set question never re-arms the size axis.
    const resultSetQuestion = detectResultSetQuestion(text);
    // DUAL-BUDGET CAPTURE (the [12:33] business capture): the client splits
    // the money PER SERVICE in consecutive messages — «za kirija do 1000
    // evra», then «za kupuvanje do 2000000». The service word is anchored
    // HERE against the raw text: the classifier's own event can leave
    // service undefined ("kupuvanje" is not a noun the buildEvent detectors
    // know), so an event-only check would bank BOTH legs into the first
    // service's budget slot. This runs BEFORE applySlots — on engage the
    // pure delivery is fully banked and applySlots is skipped so the legacy
    // `if (ev.budget)` cannot overwrite rentBudget with the money of the
    // OTHER service leg (the wrong-serve bug this guard is for).
    let dualEngaged = false;
    if (!resultSetQuestion) {
      dualEngaged = this.captureDualBudgets(session, text, ev);
    }
    if (!dualEngaged) {
      this.applySlots(session, resultSetQuestion
        ? { ...ev, bedroomsMin: undefined, bedroomsMax: undefined } as Event
        : ev);
    }
    // MIXED-PARSE SEAM (the [02:02] capture): the classifier event for a
    // stretch message ("EDNA ILI DVE , A MOZE I GARSONJERA AKO E DOBRA") can
    // carry garsonjera but DROP the rooms range; the deterministic extractor
    // parses both. The funnel, the near-center pair serve and the presentation
    // ladder all key on the slots — a range only extractSlots sees must still
    // land, or the mixed ask presents as a plain pool. Event fields win; an
    // exact count that arrives next supersedes the range via applySlots's own
    // retirement (the [09:17] rule), which runs first by construction above.
    {
      const esRange = extractSlots(text);
      if (!resultSetQuestion && !ev.bedrooms && !ev.bedroomsMin
        && esRange.bedroomsMin !== undefined && esRange.bedroomsMax !== undefined) {
        session.slots.bedrooms = undefined;
        session.slots.bedroomsMin = esRange.bedroomsMin;
        session.slots.bedroomsMax = esRange.bedroomsMax;
        session.slots.bedroomsAlt = true;
      }
    }
    // HISTORY-TYPE MEMORY (the [13:48] capture): "NESTO VO GJORCE IMA?" names
    // an AREA and no type; the talk above it („VO KOJA NASELBA SE NAJEFTINI
    // STANOVITE“) was about APARTMENTS. With all type slots empty, the share
    // pool ran as an untyped wildcard and answered a Gjorce-apartment
    // conversation with a Влае куќа. When THIS message names no property
    // type and no type slot is armed, inherit the client's LAST typed ask
    // from the chat history: стан talk → apartments (house=false), kuќa talk
    // → houses (house=true), деловен → business, плац → plac, двор → yard.
    // The current message's own type words already apply via applySlots
    // above and an armed slot is never clobbered; when the WHOLE history is
    // type-neutral the default wildcard pool stays (a client who said only
    // "нesto" can see everything).
    {
      const esMemo = extractSlots(text);
      const typedNow = esMemo.house !== undefined || !!esMemo.business || !!esMemo.plac
        || !!esMemo.yard || !!esMemo.garsonjera || esMemo.bedrooms !== undefined
        || esMemo.bedroomsMin !== undefined || ev.house !== undefined
        || ev.business !== undefined || ev.plac || ev.yard;
      if (!typedNow && session.slots.house === undefined && !session.slots.business
        && !session.slots.plac && (ev.location || session.slots.location)) {
        for (let i = session.history.length - 1; i >= 0; i--) {
          const h = session.history[i];
          if (h.role !== 'user') continue;
          const house = detectHouse(h.text);
          const business = detectBusiness(h.text) === true;
          const plac = detectPlac(h.text);
          const yard = detectYardNeed(h.text);
          if (house === undefined && !business && !plac && !yard) continue;
          if (business) session.slots.business = true;
          else if (plac) session.slots.plac = true;
          else if (yard) session.slots.yard = true;
          else session.slots.house = house === true;
          break;
        }
      }
    }
    const before = session.state;
    // NEAR-CENTER INTENT REGISTRATION (the [02:01] contract): "STO POBLISKU DO
    // CENTAR" names AREAS AROUND the centre — Kisela Voda, Карпош, Аеродром,
    // Капиштец are all in scope — not the centre itself, though the centre
    // LEADS the serve (she starts with the center fits, then expands the
    // neighborhoods in cross-area pairs, the [02:01..03] serve contract).
    // Earlier this ask in the funnel just fell to the bedrooms/budget
    // questions and the eventual serve silently led with one Центар card and
    // nothing else. Register the intent here (stage 'ring' — the choices were
    // already handed back, so the ladder never re-asks). The extractor stamps
    // ev.location='Центар' from the centre word in this same phrase; the stamp
    // STAYS (it keeps the location question from re-firing — she never asked
    // "Во кој дел…" at [02:01]) but the near-center lane owns the serve scope
    // (its pool never passes location through). A concrete ring neighborhood
    // named in the same message keeps the normal search lane instead.
    if (!session.slots.nearCenter
      && (before === 'discovery' || before === 'idle' || before === 'intent')
      && detectNearCenter(text)
      && !namesCenterOutsideNearPhrase(text)
      && !/(?:карпош|karpos|аеродром|aerodrom|кисела\s+вода|kisela\s+voda|капиштец|kapistec)/iu.test(text)) {
      session.slots.nearCenter = { stage: 'ring' as const, ring: [...CENTER_RING] };
    }
    // "та цена" / "та cenа" — client references a previously discussed price
    // but no number is in the message. Resolve to the last answered price so
    // the property search has a budget filter.
    if (!session.slots.budget && detectPriceReference(text) && session.slots.lastPrice) {
      session.slots.budget = session.slots.lastPrice;
    }
    // Did THIS message explicitly name a neighborhood ("што имаш во Карпош?")?
    // If so, the presentation must stay inside that area — and an area with no
    // matches gets the honest no-match line, never a silent different-area spill.
    let areaRequested = false;
    /** The place resolved on THIS entry (the [11:07] capture) — an entry that
     *  names a place with a category the bank is thin in is a search that can
     *  be answered now, not a reason to grill (see the serve below). */
    let landmarkEntry = false;
    try {
      areaRequested = !!(await this.areaNamed(text));
      // POI WISH IN DISCOVERY (the [10:56] TUI capture) — the candidate
      // arbitration ran only in property_locate; the discovery funnel left
      // "КУЌА ЗА ИЗДАВАЊЕ КАЈ ОЛИМПИКО" with an empty location and asked
      // "Во кој дел од градот…?" — re-asking the neighborhood the client had
      // just pointed at with a LANDMARK. Same seam as the locate funnel: the
      // first resolving candidate fills the anchor and the feed's area for
      // the place (рядот на Олимпико се гласува од rows around it), so the
      // location ask never fires and the later search ranks from the right
      // area. A concrete neighborhood named in the SAME message wins (the
      // extractor's ev.location already set areaRequested above); the
      // landmark fills only the void. Search-signal guard keeps random
      // landmark chatter ("КАЈ ОЛИМПИКО ИМА ПОСТАВА") from locking an area.
      if (!areaRequested && !session.slots.location
        && (before === 'discovery' || before === 'intent' || before === 'idle')
        && (ev.service || session.slots.service || ev.house !== undefined
          || ev.business !== undefined || ev.plac || ev.yard
          || session.slots.house !== undefined || session.slots.business
          || session.slots.plac || session.slots.yard
          || session.slots.garsonjera)) {
        for (const cand of extractPoiWishCandidates(text, { withCriteria: true })) {
          const a = this.resolvePlace(cand);
          if (!a) continue;
          session.slots.poiAnchor = a.name;
          const area = await this.areaAtPlace({ lat: a.lat, lon: a.lon, name: a.name });
          if (area) {
            session.slots.location = area;
            session.slots.poiArea = area;
          }
          areaRequested = true;
          landmarkEntry = true;
          break;
        }
      }
    } catch {
      areaRequested = false;
    }
    let next = transition(before, ev);
    /** True when the FSM-leg nag branch already served (and counted) this
     *  turn's visit-fee rung — the FEE_REFUSED ladder must not count it twice. */
    let nagRungServed = false;

    // Mid-discovery the client asks to SEE current offers before the criteria
    // are complete ("што имате во понуда?", "помало нешто", "покажи ми") —
    // Lina ANSWERS with real DB offers (smallest м² first, area-locked) instead
    // of repeating the missing question. The classifier routes this to
    // SEARCH_REQUESTED; the incomplete-criteria guard is bypassed so the offers
    // are presented, and an area with nothing gets the honest no-match line.
    // NOTE: this lane keeps its no-budget contract (the bare show-me is a
    // catalog browse, pinned by the see-offers regression guard) — the
    // money-anchor gate applies to the property_locate serve paths only.
    const seeOffers = before === 'discovery' && detectSeeOffers(text);

    // [17:14] POMALO = SMALLER-SIZE INTENT, not a show-me: "NESTO POMALO" says
    // the units shown were TOO BIG, and "smaller" is ambiguous (garsonjera OR
    // a small 1-bedroom flat). When the client's size is still unknown, Lina
    // must NOT guess a card — she asks the bedrooms question (bank-backed,
    // budget already stored from the same message) and STAYS in discovery;
    // the answer resolves small next turn ("garsonjera" → studio pool,
    // "edna spalna" → bedrooms 1). The event's own slots are applied first so
    // a same-message budget lands BEFORE the ask. Known-size contexts skip:
    // an explicit studio ask owns itself; a named sqm/bedrooms search already
    // knows what "smaller" means; "ushte edna pomalo" (a category pick with a
    // smaller qualifier) rides its existing lane. The flag keeps the ask
    // once-per-funnel: it clears when the client answers with a size.
    if (detectPomaloAsk(text) && ev.type !== 'REJECTED' && ev.type !== 'ESCALATE') {
      const sizeKnown = session.slots.bedrooms !== undefined || session.slots.garsonjera === true
        || session.slots.sqm !== undefined || session.slots.business === true
        || ev.bedrooms !== undefined || ev.sqm !== undefined || ev.business !== undefined;
      if (!session.slots.pomaloSize && !sizeKnown) {
        if (ev.budget) session.slots.budget = ev.budget;
        if (ev.location) session.slots.location = ev.location;
        session.slots.pomaloSize = true;
        if (before !== 'discovery' && before !== 'presentation') next = 'discovery';
        session.state = 'discovery';
        const ask = pickVariant('discovery.ask.bedrooms.stan', { recent: assistantTexts(session) })
          ?? 'Колку спални соби би сакале да има Вашиот иден стан?';
        const reply = `${ask}`;
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        if (this.deps.enrichment) {
          try {
            this.deps.enrichment.insert({ chatId: session.chatId, state: 'discovery', eventType: 'POMALO_ASK', userMsg: text, replyText: reply, replySource: 'deterministic', bankKey: 'discovery.ask.bedrooms.stan' });
          } catch { /* ignore */ }
        }
        await this.sendRaw(session, reply, 'deterministic');
        return;
      }
    }
    if (seeOffers) next = 'presentation';

    if (before === 'discovery' && ev.type === 'DETAILS_PROVIDED' && this.slotsComplete(session)) {
      next = 'presentation';
    }
    // property_locate: the client saw a specific property but has no number.
    // Details keep coming while Lina tries to identify it; once the remembered
    // criteria are complete, the closest DB matches are presented (the reply
    // strategy below decides ask vs. present based on what is known).
    if (before === 'property_locate' && ev.type === 'SEARCH_REQUESTED') {
      next = 'property_locate';
    }
    if (before === 'discovery' && ev.type === 'SEARCH_REQUESTED' && !this.slotsComplete(session) && !seeOffers) {
      next = 'discovery';
    }
    // AREA-PIVOT SLOT CLEARING (the 21:16 rule): in property states a PURE
    // budget correction ("A ZA 250?", "ZA 250 EVRA MISLEV" — a budget and
    // NOTHING else) is area-agnostic: the previously pinned area ("Ѓорче
    // Петров" from the not-found anchor) must NOT area-lock the re-search
    // down to one stray property. Clear the stale slot; the popularity sort
    // then orders the city-wide pool Центар-first. Size/type refinements
    // ("edna spalna", "garsonjera") KEEP the pinned area — they narrow the
    // current context, they don't abandon it. A text naming a new area keeps
    // the lock too (applySlots already set the new one).
    if ((before === 'presentation' || before === 'property_query' || before === 'property_locate')
      && (ev.type === 'SEARCH_REQUESTED' || ev.type === 'DETAILS_PROVIDED')
      && ev.budget && !ev.bedrooms && !ev.sqm && !ev.location
      && !ev.house && !ev.business && !ev.garsonjera && !ev.plac && !ev.yard) {
      session.slots.location = undefined;
      session.slots.anywhere = true;
    }
    // A FIRST message with the full criteria set (service+location+bedrooms+budget)
    // skips discovery entirely — "сакам стан во Центар, 2 спални, до 80.000 евра"
    // goes straight to presentation without asking anything.
    if (before === 'idle'
      && (ev.type === 'SEARCH_REQUESTED' || ev.type === 'DETAILS_PROVIDED')
      && this.slotsComplete(session)) {
      next = 'presentation';
    }
    if (ev.type === 'INTERESTED') {
      if (ev.propertyId) session.slots.interestedPropertyId = ev.propertyId;
      else if (session.slots.propertyId) session.slots.interestedPropertyId = session.slots.propertyId;
      else if (session.slots.currentBatch?.length) session.slots.interestedPropertyId = session.slots.currentBatch[0];
      else if (session.slots.presentedIds?.length) session.slots.interestedPropertyId = session.slots.presentedIds[0];
      // Service backfill (audit): the fee sites fall back to slots.service →
      // props[0]?.service → 'buy'. Binding interest on a RENTAL without the
      // slot left every later fee site defaulting to the buy fee. The
      // property's own service is the truth — record it (async, best-effort).
      if (session.slots.service === undefined && session.slots.interestedPropertyId !== undefined) {
        const p = await this.deps.properties.getById(session.slots.interestedPropertyId).catch(() => undefined);
        if (p?.service) session.slots.service = p.service;
      }
    }
    if (ev.type === 'FEE_AGREED') session.slots.viewingFeeAgreed = true;

    // Fee refusal ladder (deterministic, in closing only). A WHY question
    // ("зошто наплаќате посета?", "никој не го прави тоа") is NOT a refusal —
    // Lina answers it with the agency's rationale (the fee is a filter for real
    // clients) and the funnel STAYS at the fee question: no persuasion rung is
    // burned, and a classifier misread (closing + REJECTED would exit to
    // presentation) is corrected back to closing.
    // Fee-why can appear in ANY state after the fee was disclosed (closing)
    // or even mid-property-viewing ("nikoj ne naplakja za poseti" in
    // property_query). Widen the check so the pivot always fires.
    const feeWhyQuestion = detectFeeWhy(text) && ['closing', 'property_query', 'presentation', 'discovery', 'intent', 'idle'].includes(before);
    // Fee-rules dismissal is NOT a refusal either — same rung-protection as
    // the why-question (the [12:40] family).
    const feeRulesQuestion = detectFeeRules(text) && !feeWhyQuestion;
    const feeExplQuestion = feeWhyQuestion || feeRulesQuestion;
    if (ev.type === 'FEE_REFUSED' && before === 'closing' && !feeExplQuestion && !nagRungServed) {
      // Copy follows the DECLARED market (the [09:0x] 500-den bug): the
      // message itself is the truth — a rent declaration in a burst must win
      // over the stale/reset slot before the 300-vs-500 rungs are built.
      // (props is not loaded yet here; the property backfill happens in the
      // FSM-leg refusal branch where props is in scope.)
      if (!session.slots.service) session.slots.service = this.feeServiceHint;
      session.slots.feeRejections = (session.slots.feeRejections ?? 0) + 1;
      // The rung is counted here; the FSM-leg nag branch must serve it without
      // incrementing again (one turn = one rung).
      nagRungServed = true;
      // 3 persuasion attempts before graceful close: 1st refusal → persuade,
      // 2nd refusal → ask what concerns you + persuade, 3rd refusal → one more
      // try, 4th → graceful close (queued).
      next = (session.slots.feeRejections ?? 0) >= 4 ? 'queued' : 'closing';
    }
    if (feeExplQuestion) next = 'closing';

    // Negotiation loop bound (deterministic, in time_confirm only)
    if (ev.type === 'TIME_REJECTED' && before === 'time_confirm') {
      session.slots.negotiationCount = (session.slots.negotiationCount ?? 0) + 1;
      if (session.slots.negotiationCount >= this.cfg.negotiationCap) next = 'escalated';
    }

    // Exhausted-options agreement: after every matching property was shown, an
    // agreement ("добро", "контактирај ме") registers the criteria instead of
    // looping the exhausted line forever ("DOBRO" -> contact collection).
    // BUT: if the client IS interested in a specific property (propertyId /
    // interestedPropertyId), the flow must proceed to visit_scheduling — the
    // queue is only for "no specific property, register my criteria".
    const hasProperty = !!(session.slots.propertyId || session.slots.interestedPropertyId);
    if (ev.type === 'CONTACT_PROVIDED' && session.slots.queueAfterContact && !hasProperty) {
      next = 'queued';
    }

    session.state = next;

    // Suggest-alternatives pivot from a FAILED EB lookup: the client answered
    // the not-found line ("predlozi mi", "drugi lokaciii") and the funnel moved
    // to presentation — the bad propertyId must be cleared so a later INTERESTED
    // ("sakam da ja vidam") never grabs the non-existent EB.
    if (before === 'property_query' && next === 'presentation'
      && session.slots.propertyId !== undefined && detectSuggestAlternatives(text)) {
      session.slots.propertyId = undefined;
    }

    // Contact complete when the phone is already known (Viber sender id) and
    // the client gave their name — deterministic, no LLM needed: "GORAN MOZE NA
    // OVOJ BROJ" means name + the number he is writing from.
    // Also fire when queueAfterContact is set BUT a specific property was shown:
    // the client wants to VISIT it, not queue criteria.
    if (session.state === 'contact_collection'
      && session.slots.name
      && session.slots.phone
      && (!session.slots.queueAfterContact || hasProperty)) {
      next = 'visit_scheduling';
      session.state = next;
    }

    // Post-transition side effects
    if (next === 'queued') {
      this.queueCustomer(session, session.slots.queueAfterContact ? 'исцрпени опции — регистрирани барања' : '3x одбиен надомест');
    }
    if (next === 'escalated') this.raiseEscalation(session, text);

    // Visit cancellation: client or owner says they can't make it.
    // Works in visit_scheduling, owner_checking, time_confirm, pending.
    // SUPPRESSION: when the client counters with a new time proposal in
    // time_confirm ("не можам тогаш, задутре во 18:00?"), the rejection
    // is a counter-offer, NOT a cancellation — let the time_confirm handler
    // below process it as TIME_REJECTED so the ping-pong continues.
    const visitStates = ['visit_scheduling', 'owner_checking', 'time_confirm', 'pending', 'queued'];
    // A NEGATED PROPOSAL IS A COUNTER-OFFER, not a cancellation — and not only
    // in time_confirm (the [21:56] family): "не можам четврток, ајде петок во 6"
    // anywhere in a visit state must flow to the scheduling lanes, which ask
    // the owner again. Detecting it needs BOTH halves: an explicit cancel
    // token AND a proposed term.
    const isTimeCounterProposal = visitStates.includes(session.state)
      && detectExplicitCancel(text) && !!detectVisitTime(text);
    if (detectVisitCancellation(text) && visitStates.includes(session.state) && !isTimeCounterProposal) {
      routeLog(chatId, text, `VISIT_CANCEL:${session.state}`);
      // Find the active appointment for this chat
      const appts = this.deps.appointments.listByChat(session.chatId)
        .filter(a => a.status === 'finalized');
      // THE APPOINTMENT MUST BE THE PROPERTY IN PLAY (the [21:57] capture): the
      // cancel hit a leftover finalized appointment for EB 47 while the whole
      // conversation was about the house at Олимпико (EB 62) — the owner was
      // told the WRONG property was cancelled. With a property anchored, only
      // ITS appointment may be cancelled. A number NAMED IN THE MESSAGE
      // outranks the slot: it is the answer to Lina's which-visit question
      // ("otkazete ja posetata za 47" while the Олимпико house 62 is on the
      // table), and reading the stale slot first made Lina ask the same
      // question forever. A number that matches no arranged visit falls into
      // the ask below — it never cancels anything.
      const discussedEb = inferPropertyId(text)
        ?? session.slots.propertyId ?? session.slots.interestedPropertyId;
      const anchored = discussedEb !== undefined;
      const scoped = anchored ? appts.filter(a => a.propertyId === discussedEb) : appts;
      // NEVER GUESS WHICH VISIT WHEN THERE IS MORE THAN ONE: with nothing
      // anchored, a single arranged visit is unambiguous ("откажи ја посетата"
      // can only mean it), but two or more must be ASKED about — picking the
      // newest is how a wrong Евидентен број reaches an owner. An anchor with
      // no appointment of its own is equally ambiguous: the chat HAS arranged
      // visits, just not for the property being discussed.
      const appt = anchored
        ? (scoped.length > 0 ? scoped[scoped.length - 1] : undefined)
        : (appts.length === 1 ? appts[0] : undefined);
      if (appt) {
        const by: 'client' | 'owner' = (session.chatId === this.cfg.viberOperatorId)
          ? 'owner' : 'client';
        // The SCHEDULER owns this message: cancelVisit notifies BOTH parties
        // with the Евидентен број and writes the operator log. The handler only
        // writes history and steps back — sending its own short «Откажана
        // посета по желба на клиент.» line too put TWO cancellation messages on
        // the client's phone, the second one without the Евидентен број. The
        // line is still sent when no scheduler is wired in (tests, minimal
        // deployments), so the client is never left without an answer.
        const done = (await this.deps.visits?.cancelVisit(appt.id, by)) ?? false;
        session.state = 'terminated';
        const cancelled = by === 'client'
          ? buildCancelledByClient(appt.propertyId)
          : buildCancelledByOwner(appt.propertyId);
        pushHistory(session, { role: 'assistant', text: cancelled }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        if (!done) await this.sendRaw(session, cancelled);
        // The turn ENDS here: falling through let the scheduling lanes add a
        // second message after the cancellation ("Кој термин би Ви одговарал за
        // посета?") on a chat that was just terminated.
        return;
      } else if (appts.length > 0) {
        // Ambiguous: several arranged visits (or a leftover for another
        // property) with no anchor pointing at one of them. Ask WHICH instead
        // of cancelling the newest; the answer names the Евидентен број, the
        // turn re-enters this branch anchored, and only that visit is cancelled.
        const ebs = [...new Set(appts.map(a => a.propertyId))];
        routeLog(chatId, text, 'VISIT_CANCEL:WHICH');
        const ask = buildCancelWhichAsk(ebs);
        pushHistory(session, { role: 'assistant', text: ask }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        // Sent here, not through the reply chain: the scheduling lanes would
        // overwrite it with a term ask (the [21:57] replay did exactly that).
        await this.sendRaw(session, ask, 'deterministic:visit-cancel-which');
        return;
      }
    }

    // RESULT-SET QUESTION (23:59) — "SAMO OVIE DVA STANA GI IMATE SO DVE ILI
    // TRI SPALNI ?" asks about the RESULTS just shown. Count the CURRENT
    // candidate pool (the same criteria the presentation ladder uses) and
    // answer truthfully from memory — never the feature.after.show owner-
    // consult line, and never a fabricated inventory. Runs before the FSM
    // chain: the count needs the pool, and the question must not be eaten by
    // the feature-ask lane (FEATURE_RE's bare "спални" arm owns it otherwise).
    // No property-anchor exclusion: the detector's singular guard already
    // keeps "ovoj stan/stanot" questions out, and a PLURAL demonstrative
    // ("ovie dva stana") is never about the auto-anchored last card — the
    // presentation turn anchors it, the client still asks about the SET.
    if (session.state === 'presentation'
        && detectResultSetQuestion(text)) {
      const pool = await this.deps.properties.candidates({
        bedrooms: session.slots.bedrooms,
        bedroomsMin: session.slots.bedroomsMin,
        bedroomsMax: session.slots.bedroomsMax,
        sqm: session.slots.sqm,
        business: session.slots.business,
        house: session.slots.house,
        service: session.slots.service,
        budget: session.slots.budget,
      });
      // The count is the FULL current pool (shown items included) — the honest
      // denominator for "samo ovie dva gi imate?": what was presented is a
      // batch, not the inventory.
      const count = pool.length;
      // Room-count convention: slots store ROOMS ("2 спални" → 3); speak beds.
      // RANGE ([09:17]): speak the spoken band ("една или две спални").
      const spokenBeds = session.slots.bedrooms ? session.slots.bedrooms - 1 : undefined;
      const rangeBeds = session.slots.bedroomsMin !== undefined && session.slots.bedroomsMax !== undefined
        ? [session.slots.bedroomsMin - 1, session.slots.bedroomsMax - 1] : undefined;
      const bedsLabel = rangeBeds
        ? (rangeBeds[0] === 1 ? 'една или две спални' : `${rangeBeds[0]} или ${rangeBeds[1]} спални`)
        : spokenBeds === 1 ? 'една спална'
        : spokenBeds === 2 ? 'две спални'
        : spokenBeds === 3 ? 'три спални'
        : spokenBeds !== undefined ? `${spokenBeds} спални`
        : undefined;
      const criteria = [
        bedsLabel,
        session.slots.budget ? `буџет до ${session.slots.budget} евра` : undefined,
      ].filter(Boolean).join(' и ') || 'Вашите критериуми';
      reply = count === 1
        ? `Во моментов имам само еден стан според ${criteria}. Да Ви го покажам?`
        : count > 1
          ? `Во моментов имам ${count} станови според ${criteria}. Дали да ги видите сите, или да ги прескокнеме оние што веќе ги видовте?`
          : (pickVariant('no.match.location', { recent: assistantTexts(session), vars: { location: session.slots.location ?? '' } })
            ?? NO_MATCH_LINE(session.slots.location));
      if (count > 0) bankKey = undefined;
      pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, reply, 'deterministic');
      return;
    }

    // NEAR-CENTER LADDER — runs BEFORE loadProps so the ring pool never leaks
    // into the normal presentation ladder's presentedIds (the ring owns its own
    // shown-set). Full flow documented at the branch below (steps 1–5).
    // The [02:01] contract: the ask can arrive MID-FUNNEL ("STO POBLISKU DO
    // CENTAR" while the criteria questions are still open) — the intent is
    // then registered during discovery (see the preset right after
    // applySlots) and
    // the FUNNEL-COMPLETION turn (before=discovery → next=presentation) serves
    // the ring pairs directly instead of the normal Центар-first pool.
    // FRESH-CRITERIA GUARD (the [02:03] capture): once the funnel has opened,
    // a criteria-bearing message ("A DVOSOBNO NESTO SO POSEBNA SPALNA?") is a
    // REFINEMENT — the re-present lane owns it; running the ladder over it
    // re-asked "Дали имате конкретна населба на ум?" and starved the actual
    // ask. Only the funnel-completion turn (before=discovery → presentation,
    // the [02:02] "DO 350 EVR" burst) keeps the serve.
    const ncRefine = (() => {
      const s = extractSlots(text);
      return !!(s.bedrooms || s.bedroomsMin !== undefined || s.sqm
        || s.budget || s.garsonjera || s.sizeWaived || s.house !== undefined || s.business);
    })();
    if ((session.state === 'presentation' || (before === 'discovery' && next === 'presentation'))
      && (detectNearCenter(text) || session.slots.nearCenter)
      && !session.slots.propertyId && !session.slots.interestedPropertyId
      && !(next === 'presentation' && before !== 'discovery' && ncRefine)) {
      const nc = session.slots.nearCenter ?? { stage: 'ask' as const, ring: [...CENTER_RING] };
      const ring = nc.ring;
      // Ring-pair presenter: serves the next PAIR — Центар first, then the
      // (remaining) ring, expanding the neighborhoods outward, one card from
      // a DIFFERENT neighborhood per pair wherever the pool can supply that
      // (one from Kisela Voda, one from Karpos/an/other area — never two
      // cards of the same area when a second area is in stock). A MIXED-types
      // criteria set (garsonjera stretch + rooms range) unions the studio
      // pass with the regular pass and interleaves (interleaveMixedPairs),
      // consistent with the presentation lane; the biggest in-budget unit
      // LEADS (sortBySqmDesc pools), and across the pair the two cards pick
      // ALTERNATE types first when the serve spans two categories.
      const presentRingPair = async (intro: string): Promise<boolean> => {
        // MIXED-TYPES stretch (garsonjera + rooms spec): both pools sort
        // BIGGEST-in-budget first (sortBySqmDesc) so the lead card is the
        // biggest unit the money buys (the [02:02] contract).
        const mixedTypes = !!session.slots.garsonjera
          && (session.slots.bedrooms !== undefined || session.slots.bedroomsMin !== undefined);
        const baseCall = {
          bedrooms: session.slots.bedrooms,
          bedroomsMin: session.slots.bedroomsMin,
          bedroomsMax: session.slots.bedroomsMax,
          sqm: session.slots.sqm,
          business: session.slots.business,
          house: session.slots.house,
          service: session.slots.service,
          budget: session.slots.budget,
          sortBySqmDesc: mixedTypes || !!session.slots.sizeWaived,
        };
        // NOTE: location is deliberately NOT passed — the near-center lane
        // owns the scope (Центар + the remaining ring), never the extractor's
        // stamp from the original ask.
        let pool = await this.deps.properties.candidates(baseCall);
        // Mixed-types union (same rule as the presentation lane): a stretch
        // ask carries BOTH the studio category and a rooms range, so the
        // pool unites the studio pass with the regular pass and keeps
        // both categories paired.
        if (mixedTypes) {
          const studioPool = await this.deps.properties.candidates({ ...baseCall, garsonjera: true });
          pool = interleaveMixedPairs(pool, studioPool);
        }
        // SCOPE — Центар + the (remaining) ring, CENTER FIRST: she starts
        // with the center fits and then EXPANDS the neighborhoods (the
        // [02:01..03] serve contract), so Центар rows rank ahead of the ring
        // rows. An exhausted Центар search keeps the ring-only walk (`centerLead`
        // off): the client already saw and declined the center.
        const centreLead = !session.slots.areaExhausted;
        const isCentre = (p: Property): boolean => locMatches('Центар', p.location ?? '');
        const inScope = (p: Property): boolean => isCentre(p) || ring.some(l => locMatches(l, p.location ?? ''));
        let scope = pool.filter(inScope);
        if (centreLead) scope = [...scope.filter(isCentre), ...scope.filter(p => !isCentre(p))];
        const shown = session.slots.presentedIds ?? [];
        const avail = scope.filter(p => !shown.includes(p.eb));
        if (avail.length === 0) return false;
        // One card per DIFFERENT neighborhood first (the pair rule): the
        // head card, then the best card from an area whose feed location
        // does not match the head's (both directions of locMatches —
        // "Карпош" vs "Карпош 1" read as the same neighborhood). A mixed-types
        // serve prefers card 2 to carry the ALTERNATE category (garsonjera vs
        // rooms-range fit) wherever the pool can supply that pair.
        const first = avail[0];
        const isStudio = (p: Property): boolean =>
          p.studio === true || /гарсоњер|garsonjer|студио|studio/i.test(p.details ?? '');
        const altType = (p: Property): boolean => mixedTypes && isStudio(p) !== isStudio(first);
        const diffArea = (p: Property): boolean => !!p.location
          && !locMatches(p.location ?? '', first.location ?? '')
          && !locMatches(first.location ?? '', p.location ?? '');
        const second = avail.find(p => p.eb !== first.eb && altType(p) && diffArea(p))
          ?? avail.find(p => p.eb !== first.eb && diffArea(p))
          ?? avail[1];
        const batch = (second && second.eb !== first.eb ? [first, second] : avail.slice(0, 2))
          .slice(0, 2);
        if (batch.length === 0) return false;
        session.slots.presentedIds = [...shown, ...batch.map(p => p.eb)];
        await this.landmarks.enrich(batch);
        const reply = `${intro}\n\n${buildPropertyCards(batch, 'presentation', session.history.length, assistantTexts(session), { budget: session.slots.budget })}`;
        pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, reply, 'deterministic');
        return true;
      };
      const exhaustedNoRing = async (): Promise<void> => {
        session.slots.nearCenter = undefined;
        session.slots.areaExhausted = true;
        const line = exhaustedLine(undefined, assistantTexts(session))
          ?? 'Ги прегледавме сите опции во населбите околу центарот. Можам да ги запишам Вашите барања и да Ве известам штом се појави нешто соодветно, или да погледнеме во друга населба?';
        pushHistory(session, { role: 'assistant', text: line }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, line, 'deterministic');
      };
      const ringIntro = () => pickVariant('near.center.ring', { recent: assistantTexts(session) })
        ?? 'Еве ги најблиските опции до центарот:';

      // Step 1 — the ask: "vo blizina na centar" with no ring session yet.
      if (!session.slots.nearCenter) {
        session.slots.nearCenter = { stage: 'ask', ring: [...CENTER_RING] };
        const ask = pickVariant('near.center.ask', { recent: assistantTexts(session) });
        const reply = ask ?? 'Најблиску до Центар се населбите Карпош, Аеродром, Капиштец и Кисела Вода. Дали имате конкретна населба на ум, или да Ви покажам сè што е најблиску?';
        pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, reply, 'deterministic');
        return;
      }
      // FUNNEL-COMPLETION SERVE (the [02:02] contract): the near-center ask
      // arrived MID-FUNNEL ("STO POBLISKU DO CENTAR"), the criteria
      // questions followed, and the turn that completes the funnel
      // (before=discovery → next=presentation) must serve the RING PAIRS —
      // never the normal Центар-first pool. The step-3 serve below handles
      // it via this flag.
      const funnelCompleted = before === 'discovery' && next === 'presentation';
      // Step 4 — elimination: "ne sakam karpos", "bez kisela voda" shrinks the
      // ring and the flow continues with what remains (like a human agent).
      const eliminated = detectRingElimination(text);
      if (eliminated && ring.length > 1) {
        const remaining = ring.filter(l => !locMatches(eliminated, l));
        if (remaining.length > 0 && remaining.length !== ring.length) {
          session.slots.nearCenter = { stage: 'ring', ring: remaining };
          if (await presentRingPair(ringIntro())) return;
          await exhaustedNoRing();
          return;
        }
      }
      // Step 3 — the client hands the choice back: "okolu centar",
      // "sto poblisku do centar", "drugo nesto" → MIXED pairs from the ring.
      // funnelCompleted: the mid-funnel ask case — the criteria answers just
      // landed and presentation begins with the intent already registered.
      if (funnelCompleted || detectNearCenter(text) || detectAgreement(text)
        || detectDrugAlternative(text) || detectSeeOffers(text)) {
        session.slots.nearCenter = { stage: 'ring', ring };
        if (await presentRingPair(ringIntro())) return;
        await exhaustedNoRing();
        return;
      }
      // Step 2 — the client names a SPECIFIC ring neighborhood: release the
      // ladder and fall through to the normal search path.
      if (session.slots.location) {
        session.slots.nearCenter = undefined;
        // fall through to the normal flow below
      } else {
        // No named neighborhood, no ring phrase: re-ask (ask stage persists).
        const ask = pickVariant('near.center.ask', { recent: assistantTexts(session) });
        const reply = ask ?? 'Најблиску до Центар се населбите Карпош, Аеродром, Капиштец и Кисела Вода. Дали имате конкретна населба на ум?';
        pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, reply, 'deterministic');
        return;
      }
    }

    // [14:47] RESTATEMENT WITH APOLOGY — must precede the choice-answer and
    // the plain cheaper lanes: after Lina served the WRONG types (a
    // garsoњera and a Влаe house against a two-bedroom apartment ask), the
    // client restates the criteria ("MI TREBA STAN SO DVE SPALNI SOBI VO TOJ
    // REON , NE GARSONJERI I KUKJI"). The rule: APOLOGIZE ONCE and give him
    // what he wants — same-bedroom, same-type cheaper options in the chosen
    // naselba (or the two-way ask when none exist).
    if (session.slots.pricePriority
        && detectCriteriaStatement(text) && detectNegatedType(text)) {      session.slots.cheaperChoicePending = undefined;
      // RE-ANCHOR ON RESTATEMENT: serveBatch re-points propertyId at the
      // newest served row — after the (wrong) turn the "last seen" is the
      // mis-serve, not his choice, and the cheaper pool measured against it
      // reads empty. The client's CHOSEN flat is the funnel's first
      // presentation (presentedIds[0] — the [14:47] restatement is relative
      // to THAT, "во тој реон" = his chosen naselba).
      const originChoice = session.slots.presentedIds?.[0];
      if (originChoice != null) {
        session.slots.propertyId = originChoice;
        session.slots.interestedPropertyId = originChoice;
      }
      const sorry = pickVariant('correction.apology', { recent: assistantTexts(session) })
        ?? 'Извинете за недоразбирањето — еве станови со истите карактеристики, а поевтини:';
      // FRESH POOL: the client is asking AGAIN for the same characteristics —
      // the correction re-serves the asked-for pool even when it overlaps the
      // rows already shown (the anchored cheaper flat EB 77 sits in
      // presentedIds after the first cheaper turn; without the waiver the
      // pool reads empty twice and the ask re-fires instead of the serve).
      if (await this.presentCheaperBatch(session, sorry, { freshPool: true })) return;
    }

    // CHOICE-ANSWER interceptor (the [14:46] two-way ask): the answer to
    // „помали станови во истата населба, или станови со истите карактеристики
    // во други населби?“ routes here. An agreement or a smaller-word picks
    // the SMALLER-IN-AREA batch (the first-named option); an other-naselba
    // wording picks the same-characteristics ELSEWHERE batch.
    if (session.slots.cheaperChoicePending) {
      const anchor = session.slots.cheaperAnchor;
      // BARE AGREEMENT BEATS WIDEN-INTENT ([14:46] routing): detectWidenIntent
      // fires on the bare yes ("da") too — but the question's FIRST-named
      // option is the smaller-in-area batch, so the bare agreement must pick
      // it. Only widening WORDING ("druga naselba", "iste karakteristiki vo
      // ..." or an explicit widen) routes elsewhere.
      const bareAgree = detectAgreement(text) && !detectExplicitWiden(text);
      const wantsElsewhere = !bareAgree && (detectExplicitWiden(text) || detectWidenIntent(text));
      const wantsHere = !wantsElsewhere
        && (detectAgreement(text)
          || /pomalo|pomali|помало|помал[ооии]|pomаl/iu.test(text));
      if (wantsHere || wantsElsewhere) {
        session.slots.cheaperChoicePending = undefined;
        if (wantsElsewhere) {
          // Same characteristics, neighbouring naselbi: no location filter,
          // the anchor's own axes kept verbatim, cheapest first.
          const batch = (await this.deps.properties.candidates({
            bedrooms: anchor?.bedrooms,
            sqm: anchor?.sqm,
            business: anchor?.business,
            house: anchor?.house,
            service: session.slots.service,
            exclude: session.slots.presentedIds ?? [],
          })).sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity)).slice(0, 2);
          if (batch.length > 0) {
            const intro = pickVariant('cheaper.choice.elsewhere', { recent: assistantTexts(session) })
              ?? 'Еве станови со истите карактеристики во соседните населби:';
            await this.serveBatch(session, batch, intro, 'CHEAPER_CHOICE_ELSEWHERE', 'cheaper.choice.elsewhere');
            return;
          }
        } else {
          // Smaller AND cheaper in the SAME naselba, cheapest first.
          const batch = (await this.deps.properties.candidates({
            location: session.slots.location,
            service: session.slots.service,
            exclude: session.slots.presentedIds ?? [],
          }))
            .filter(p => (anchor?.price === undefined || (p.price ?? Infinity) < anchor.price))
            .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity)).slice(0, 2);
          if (batch.length > 0) {
            const intro = pickVariant('cheaper.choice.area', { recent: assistantTexts(session) })
              ?? 'Разбирам — еве ги поевтините помали станови во таа населба:';
            await this.serveBatch(session, batch, intro, 'CHEAPER_CHOICE_AREA', 'cheaper.choice.area');
            return;
          }
        }
        // The chosen pool drained between ask and answer: re-run the cheaper
        // lane on the (criteria-applied) slots as the catch-all serve.
        if (await this.presentCheaperBatch(session,
          pickVariant('cheaper.choice.area', { recent: assistantTexts(session) }) ?? '')) return;
      }
    }

    // ANSWER to the criteria-done two-way choice (the [20:33] fix): Lina just
    // asked „поскапо во истиот реон, или истата цена во други населби?“ —
    // options come only AFTER the ask. A bare agreement or pricier wording
    // takes the FIRST-named option (more expensive in the same area — the
    // budget cap lifts by consent, never silently); other-naselba wording
    // serves the same-price batch city-wide. The junk refill (over-budget,
    // off-type, off-area rows without the client's choice) never fires again.
    if (session.slots.moreChoicePending) {
      // IMPORTANT: a PRICIER word wins before the widen check. The widen
      // detector's budget-up escape makes detectExplicitWiden("DA POSKAPO")
      // true (an upward ask IS a relaxation), so an elsewhere-first order
      // answered the FIRST-named option — more expensive in the same area —
      // with the same-price-elsewhere batch. "да" with no other ask stays
      // the elsewhere answer only when it names neither direction.
      const bareAgree = detectAgreement(text) && !detectExplicitWiden(text);
      const pricierWord = /(?:poskap?o|поскапо|по(?:дирек|голем)|podir?ek|pogolem)/iu.test(text)
        || detectBudgetUpAsk(text);
      // More-word answers ("drugi", "nesto novo", "pokazi drugi") name
      // NEITHER direction — they answer the ask's own “или” clause, i.e.
      // ANOTHER neighborhood — so they follow the elsewhere lane, never the
      // pricier one (the old order sent “drugi” at presentPricierBatch).
      const moreWord = detectMoreOptions(text) || detectSuggestAlternatives(text) || mentionsMore(text);
      const wantsElsewhere = !bareAgree && !pricierWord
        && (detectExplicitWiden(text) || detectWidenIntent(text) || moreWord);
      const wantsPricier = bareAgree || pricierWord;
      if (wantsPricier || wantsElsewhere) {
        session.slots.moreChoicePending = undefined;
        if (wantsPricier) {
          if (await this.presentPricierBatch(session, text)) return;
          // Nothing pricier in the area either: the honest exhausted line,
          // never a silent junk refill and never silence.
          const exhausted = exhaustedLine(session.slots.location, assistantTexts(session))
            ?? 'Ги прегледавме опциите во овој реон. Можам да ги запишам Вашите барања и да Ве известам штом се појави нешто соодветно, или да погледнеме во друга населба?';
          pushHistory(session, { role: 'user', text: this.lastUserText ?? '' }, this.cfg.maxHistory);
          pushHistory(session, { role: 'assistant', text: exhausted }, this.cfg.maxHistory);
          this.deps.sessions.set(session);
          await this.sendRaw(session, exhausted, 'deterministic');
          return;
        }
        // SAME PRICE, different neighborhoods: release the area lock (the
        // client's consent), budget KEPT, already-shown rows excluded.
        session.slots.location = undefined;
        session.slots.anywhere = true;
        session.slots.areaExhausted = false;
        const batch = (await this.deps.properties.candidates({
          bedrooms: session.slots.bedrooms,
          bedroomsMin: session.slots.bedroomsMin,
          bedroomsMax: session.slots.bedroomsMax,
          sqm: session.slots.sqm,
          business: this.businessPoolLock(session.slots) ?? undefined,
          house: session.slots.house,
          garsonjera: session.slots.garsonjera,
          plac: session.slots.plac,
          yard: session.slots.yard,
          service: session.slots.service,
          budget: session.slots.budget,
          exclude: [...(session.slots.presentedIds ?? [])],
          sortByPopularity: true,
        })).slice(0, 2);
        if (batch.length > 0) {
          const intro = pickVariant('batch.done.elsewhere', { recent: assistantTexts(session) })
            ?? 'Немам повеќе соодветни во овој реон — еве станови со Вашата цена во соседните населби:';
          await this.serveBatch(session, batch, intro, 'MORE_CHOICE_ELSEWHERE', 'batch.done.elsewhere');
          return;
        }
        // Nothing anywhere either: the honest exhausted line keeps the funnel
        // alive (another-neighborhood / register offer).
        const exhausted = exhaustedLine(undefined, assistantTexts(session))
          ?? 'И во другите населби немам слободни предлози по Вашите критериуми. Можам да ги запишам Вашите барања и да Ве известам штом се појави нешто соодветно.';
        pushHistory(session, { role: 'user', text: this.lastUserText ?? '' }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: exhausted }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, exhausted, 'deterministic');
        return;
      }
      if (detectNegatedAgreement(text)) {
        // A NO / correction: not a pivot answer — clear the pending choice so
        // the normal lanes own the message from here on.
        session.slots.moreChoicePending = undefined;
      }
    }

    // BARE-MORE PIVOT (the [20:33] fix): a bare more-ask in presentation
    // ("drugo", "nesto drugo", "daj nesto novo") when the criteria-fitting
    // pool is DRAINED must never silently refill with off-criteria rows
    // (over budget, other area, wrong type) — Lina first says the matching
    // choices are done and offers the two standard pivots. Lanes that own
    // their own serving stay out of the way (fee/visit/money detectors and a
    // NEW criteria in the message are refinements, not more-asks).
    if (before === 'presentation'
      && !session.slots.moreChoicePending && !session.slots.cheaperChoicePending
      && !session.slots.areaExhausted
      && (session.slots.presentedIds?.length ?? 0) > 0) {
      const esFire = extractSlots(text);
      // Latin input ("VO CENTAR") normalizes away inside extractSlots —
      // resolve the area the same way the other intake lanes do, against the
      // live feed's list, so a same-area more-ask ("DRUGO NESTO VO CENTAR")
      // counts as a NAMED criterion and not a bare widen: the old FSM flow
      // (exhausted ask + areaExhausted) owns it, never the criteria-done
      // choice ask.
      if (!esFire.location) {
        try {
          esFire.location = await this.areaNamed(text);
        } catch { /* feed hiccup — treat as unnamed */ }
      }
      const newCriteria = !!esFire.location || !!esFire.bedrooms
        || esFire.bedroomsMin !== undefined || esFire.bedroomsMax !== undefined
        || !!esFire.sqm || esFire.house !== undefined || !!esFire.business
        || !!esFire.plac || !!esFire.garsonjera || !!esFire.yard
        || !!esFire.budget || !!esFire.sizeWaived || !!esFire.anywhere;
      const moreAsk = (detectSuggestAlternatives(text) || detectMoreOptions(text) || mentionsMore(text))
        && !detectAvailabilityAsk(text) && !detectFeeWhy(text) && !detectFeeComplaint(text)
        && !detectFeeSurprise(text) && !detectFeePaymentAgreement(text)
        && !detectAgreement(text) && !detectRejection(text) && !detectVisitTime(text)
        && !extractRentMath(text) && !detectTotalCostAsk(text)
        && !detectPriceAsk(text) && !detectCheaperSearch(text) && !detectPomaloAsk(text)
        && !detectGolemComplaint(text) && !detectSmallerPerM2Ask(text) && !detectBudgetUpAsk(text)
        && !detectBusiness(text) && detectHouse(text) === undefined && !detectPlac(text)
        && !detectYardNeed(text);
      if (moreAsk && !newCriteria
        && await this.presentCriteriaDoneChoice(session)) return;
    }
    // CHEAPER-SEARCH INTERCEPTOR (the 21:39 fix) — MUST run BEFORE loadProps:
    // the budget ladder in loadProps consumes the cheapest not-yet-shown row
    // into presentedIds, which made the cheaper-ask below see an empty pool and
    // wrongly fire the price.shy.empty ask ("nothing in the area") right after
    // eating the row the client asked for. “daj nesto poeKtino vo toj reon” is
    // a search instruction, NOT contact traffic and NOT a market opinion.
    if ((next === 'presentation' || next === 'closing')
        && detectCheaperSearch(text)
        && !detectService(text) && !detectBothServices(text)
        && !detectBudget(text)
        // NEGATED agreement veto (the [22:2x] refusal fix): "ne se
        // soglasuvam, skapo e" carries the suggest-alternatives keyword
        // "skapo e" — but it is a fee REFUSAL (the negation flips the
        // consent token), never a cheaper-search instruction. Without this
        // veto refusal #2 abandoned the fee funnel and dumped properties.
        // FEE-COMPLAINT veto (the [09:0x] capture): "ako gledam 10 stana toa
        // se 5000 od moj djeb" — total-cost arithmetic about the FEE — read
        // as INTERESTED and the amount re-triggered the search machinery.
        // Fee traffic stays in the fee lanes (fee.why at closing).
        && !detectNegatedAgreement(text)
        && !detectFeeComplaint(text)
        // FEE-NAG VETO (the [23:12] capture): "SKAPO E TOA . ZA SEKOJ STAN PO
        // 300DEN" is a complaint about the FEE whose only number IS the fee —
        // it was not recognised as fee traffic at all, so this pivot fired and
        // the funnel abandoned the fee ladder for a property pair. A nag
        // belongs to the ladder, never to the search machinery.
        && !detectFeeNag(text)
        // In presentation, a criteria message that carries a cheaper-word
        // ("една спална, нешто поевтино, до 50") is a FILTER — the dedicated
        // re-present branch's job. A BARE cheaper-ask (no bedrooms/sqm/
        // location/budget in the message) is a search instruction and must be
        // served HERE (the old ev.type exclusion swallowed it — the 21:39
        // presentation variant). In closing there is no such branch: WITHOUT
        // the cheaper interceptor the event falls off the chain into the LLM
        // fallback (the 21:39 swallow).
        && !(next === 'presentation'
             && (ev.bedrooms || ev.sqm || ev.location || ev.budget)   // real criteria present
             && detectPricePriority(text)                             // …plus a cheaper-word
             && !detectAgreement(text))) {                            // “da, nesto poeftino” = consent, not a filter
      const intro = pickVariant('price.shy', { recent: assistantTexts(session) })
        ?? 'Разбирам — цената е важна. Еве ги најпристапните опции што моментално ги имам во таа населба.';
      if (await this.presentCheaperBatch(session, intro)) return;
    }

    // BUDGET-UP INTERCEPTOR (the [25:2x] queue): the bare pricier ask after a
    // presentation ("DAJ NESTO POSKAPO TOGAS") is a SEARCH instruction — the
    // serve is the next pricier batch (strictly above the shown anchor,
    // already-shown rows excluded), never the price.negotiate pitch and never
    // the location-confirm lane (the togas/togash marker inside "poskapo
    // togas" used to claim the ask and re-serve the shown EB). Mirror of the
    // cheaper-search interceptor above; MAPPING: the handler wiring for this
    // lane was cut off mid-session (presentPricierBatch existed, no caller) —
    // this block is the missing connection.
    // NOTE (case 252, #252): detectFeeComplaint is NOT a veto here — its
    // keyword family matches the Cyrillic form ("ПОСКАПО" contains "СКAPO",
    // the stingy-price family), so a veto made the upward ask fall through to
    // the empty-criteria no-match line even while the pool had rows. The ask
    // itself is the contract: naming pricier criteria IS a property search,
    // not a fee complaint.
    if ((next === 'presentation' || next === 'closing')
        && detectBudgetUpAsk(text)
        && !detectService(text) && !detectBothServices(text)
        && !detectBudget(text)
        && !detectNegatedAgreement(text)
        && !detectFeeNag(text)) {
      if (await this.presentPricierBatch(session, text, ev.location)) return;
    }

    // 4) Property context (responder only needs it for LLM-driven states)
    let props = await this.loadProps(session, areaRequested, seeOffers);

    // Service pinning: a client who jumps straight to an Евидентен број
    // ("zainteresiran sum za sifra 62") never declared buy/rent — the property's
    // OWN service is the truth. Pinning it here makes the whole downstream flow
    // consistent: the fee script (300 vs 500 денари), the agent pool, the
    // stored appointment fee and the visit protocol all follow the property's
    // market, never a missing slot.
    if (!session.slots.service && props[0]?.service) {
      session.slots.service = props[0].service;
    }

    // Exhausted-area pivot: the selected area(s) are drained and Lina just asked
    // whether to widen ("…или да погледнеме во друга населба?"). A pure
    // agreement (no register/contact intent, no NEW area named in the same
    // message) releases the area lock and presents the next batch from the REST
    // of the city — options come only AFTER the ask, never silently. Register
    // intents ("контактирај ме") fall through to the queue escape below.
    // EXPLICIT widen commands ("PROSIRI JA POTRAGATA", "а во други населби
    // нешто со тие карактеристики?", bare "drugi naselbi?") release the lock
    // TOO — they are commands/answers, not agreements, and grammar.ts matches
    // every real phrasing of them.
    // Exhausted-area pivot: the selected area(s) are drained and Lina just asked
    // whether to widen ("…или да погледнеме во друга населба?"). A pure
    // agreement (no register/contact intent, no NEW area named in the same
    // message) releases the area lock and presents the base batch from the REST
    // of the city — options come only AFTER the ask, never silently. Register
    // intents ("контактирај ме") fall through to the queue escape below.
    // EXPLICIT widen commands ("PROSIRI JA POTRAGATA", "а во други населби
    // нешто со тие карактеристики?", bare "drugi naselbi?") release the lock
    // TOO — they are commands/answers, not agreements, and grammar.ts matches
    // every real phrasing of them.
    if (next === 'presentation' && props.length === 0
      && session.slots.areaExhausted
      && ((detectWidenIntent(text) || detectExplicitWiden(text))
        // REPEAT-WIDEN (the [21:26] freeze): a bare more-ask ("drugo sto
        // imas?") right after the exhausted line — which itself ends with the
        // widen ask — IS the widen answer. Repeating the same exhausted ask
        // is what read as a freeze; release the lock and serve the rest of
        // the city instead.
        || (mentionsMore(text) && !hasProximityAnchor(text)
          && lastReplyWasExhausted(recentAssistant[recentAssistant.length - 1] ?? '')))
      && !ev.location
      // Fresh-criteria pivots ("a kukuca so dvor NADVOR OD GRADOT") belong to
      // the release block below: widening here would clear areaExhausted
      // BEFORE the new plac/yard criteria are applied, so the re-search ran
      // with the OLD specs and the pivot died in another exhausted ask.
      && !detectPlac(text) && !detectYardNeed(text)) {
      session.slots.areaExhausted = false;
      session.slots.location = undefined;
      props = await this.loadProps(session, false, false);
    }
    // New search while exhausted: the client asks about a service or specific
    // property ("skapa kirija ima za toj reon", "што имаш за купување?") while
    // areaExhausted is true from a previous exhausted interaction.
    //
    // PRICE/AVAILABILITY COMPLAINT: when the client asks about rent/buy prices
    // or availability in an exhausted area, they are essentially questioning the
    // market — same as "MISLAM DEKA CENITE SE PREVISOKI".  Route through the
    // investment.opinion bank which explains that prices are set by owners, not
    // the agency.  This covers both buy and rent scenarios generically.
    if ((next === 'presentation' || next === 'closing') && props.length === 0
      && session.slots.areaExhausted
      && (detectService(text) || detectBothServices(text) || detectPropertyDescription(text) || detectSeeOffers(text))) {
      // Check if this is a price/availability complaint (not a fresh search)
      if (detectExhaustedFollowUp(text) || detectInvestmentOpinion(text) || detectPriceAsk(text) || detectFeeComplaint(text)) {
        reply = pickVariant('investment.opinion', { recent: assistantTexts(session) })
          ?? 'Ве разбирам. Цените ги одредуваат сопствениците на недвижностите, а ние сме тука само како посредници. Дали сакате да Ви понудам некои опции во друг реон, или да го контактирам сопственикот за моменталната цена?';
        bankKey = 'investment.opinion';
      } else {
        // Pure new search — reset exhausted and reload props
        session.slots.areaExhausted = false;
        props = await this.loadProps(session, false, false);
      }
    }
    // NEW-CRITERIA RELEASE (the 23:26 transcript): after exhaustion, a fresh
    // criteria message ("a so edna spalna nesto", "drugi garsonjeri nemate ?")
    // is a NEW SEARCH, not a yes/no on the exhausted ask. If the message names
    // criteria but NO trigger fired on it, release the area lock here — both
    // for the exhausted line (no matches) and when the last visible line WAS
    // the exhausted ask (the render path may still hold matches from earlier
    // states). The re-search/re-present itself happens downstream (the
    // DETAILS_PROVIDED/SEARCH_REQUESTED re-present branch), so the answer
    // always reflects the client's ACTUAL question.
    const es = extractSlots(text);
    const criteriaSignals = [
      !!ev.bedrooms || !!es.bedrooms,
      !!ev.sqm || !!es.sqm,
      !!ev.budget || !!es.budget,
      !!es.garsonjera,
      !!es.sizeWaived,        // "a nesto pogolem da vidime" — size-direction pivot
      es.house !== undefined || !!es.business,  // TYPE pivot ("a kuka so dvor", "deloven prostor imas?")
      !!es.plac || !!es.yard,                   // CATEGORY pivot ("a plac za gradenje", "a nesto so dvorce")
    ];
    if ((next === 'presentation' || next === 'closing') && session.slots.areaExhausted
      && criteriaSignals.some(Boolean)
      && !detectService(text) && !detectBothServices(text) && !detectPropertyDescription(text)
      && !detectSeeOffers(text)
      // Agreement veto is OVERRIDDEN by criteria presence: consent never
      // carries search specs ("a dvosoben da barame sega?" — the bare "da"
      // inside "da barame" must not read this as register-consent and dump
      // it into contact-collection; hardening sweep CROSS find).
      && !(detectAgreement(text) && !criteriaSignals.some(Boolean)) && !detectOfftopic(text)
      && !detectExhaustedFollowUp(text) && !detectInvestmentOpinion(text)
      && !detectPriceAsk(text) && !detectFeeComplaint(text)) {
      // applySlots only honors ev.* — a bare STAY event would drop the fresh
      // criteria on the floor. Apply the message's OWN extraction so the
      // re-search below runs with the client's ACTUAL new criteria.
      if (!ev.bedrooms && es.bedrooms) session.slots.bedrooms = es.bedrooms;
      // RANGE pivot ([09:17]): a fresh range supersedes an exact count; an
      // exact count supersedes a range (applySlots owns the exact-direction
      // retirement — this seam covers the exhausted-pivot path that bypasses
      // applySlots). 
      if (!ev.bedroomsMin && es.bedroomsMin && es.bedroomsMax) {
        session.slots.bedrooms = undefined;
        session.slots.bedroomsMin = es.bedroomsMin;
        session.slots.bedroomsMax = es.bedroomsMax;
        session.slots.bedroomsAlt = true;
      } else if (!ev.bedrooms && es.bedrooms && session.slots.bedroomsMin !== undefined) {
        session.slots.bedrooms = es.bedrooms;
        session.slots.bedroomsMin = undefined;
        session.slots.bedroomsMax = undefined;
        session.slots.bedroomsAlt = undefined;
      }
      if (!ev.sqm && es.sqm) session.slots.sqm = es.sqm;
      if (!ev.budget && es.budget) session.slots.budget = es.budget;
      if (es.garsonjera) session.slots.garsonjera = true;
      if (es.sizeWaived) session.slots.sizeWaived = true;
      if (es.house !== undefined) session.slots.house = es.house;
      if (es.business) session.slots.business = true;
      // Plac/yard are CATEGORIES — the newest category message wins over the
      // previous one ("a plac za gradenje" after a garsonjera search must not
      // keep the studio filter; "a nesto so dvorce" must not keep it either).
      if (es.plac) session.slots.plac = true;
      if (es.yard) { session.slots.yard = true; session.slots.house = true; }
      if (es.plac || es.yard) {
        session.slots.garsonjera = undefined;
        session.slots.business = undefined;
      }
      if (es.plac) session.slots.house = undefined;   // плац is not a house
      if ((es.bedrooms || es.sqm || es.sizeWaived || es.house !== undefined || es.business) && !es.garsonjera) {
        // Category and size are alternative framings of "how big" — the
        // newest message wins ("a so edna spalna nesto" after a garsonjera
        // search means the client MOVED OFF the studio category; keeping the
        // ≤35м² filter here strangled the re-search into another exhausted).
        session.slots.garsonjera = undefined;
        // Same logic for the WAIVER: a fresh bedroom/sqm criterion means the
        // client named a size after all — the sizeWaived flag ("nebitno") must
        // not survive the pivot, or the re-search sorts biggest-first and
        // silently ignores the size they just gave (the 21:40 contract: adapt
        // with the flow). Mirrors the garsonjera clear above.
        session.slots.sizeWaived = undefined;
      }
      session.slots.ladderQueue = [];   // rebuild the presentation ladder for the new search
      session.slots.areaExhausted = false;
      // Already-served guard (the [23:57–59] house capture): when the loadProps
      // above already produced results (the typed-search tier widens IN-PLACE
      // and returns a non-empty pool), re-running loadProps would exclude the
      // just-served batch — the second call sees presentedIds already holding
      // those houses, returns [], and the widened pool dies in the no-match
      // ask (a Влае house search dead-ended though city-wide houses existed).
      // Re-search only when the first load was empty: the true "drained area,
      // fresh criteria" signal. The lock is still released and the area marked
      // live again (the pivot means options exist), so the reset above stands.
      if (props.length === 0) {
        props = await this.loadProps(session, false, false);
      }
      if (props.length === 0 && session.slots.location) {
        // New criteria in a drained area — the pivot means "elsewhere with
        // these specs" (same contract as the widen flow: rest of the city).
        session.slots.location = undefined;
        props = await this.loadProps(session, false, false);
      }
      if (props.length === 0 && (session.slots.plac || session.slots.yard)) {
        // The category itself is drained CITY-WIDE (the live feed has no plac
        // rows): the honest next step is the no-match/other-area ask, which the
        // re-present path serves on empty — leave props empty so it fires.
      }
      if (props.length > 0) {
        // Render through the re-present branch (type-aware prefixes, fresh
        // cards) instead of the stale exhausted/no-match line. Post-transition
        // promotion — mirrors the availability-bind promotion precedent.
        ev.type = 'SEARCH_REQUESTED';
      }
    }

    // Exhausted dead-end escape: once every option is shown (props empty), an
    // agreement message must move to contact collection, never loop the same
    // exhausted line. (Runs after the state transition above.)
    if (next === 'presentation' && props.length === 0 && detectAgreement(text)
        // PROPERTY CHOICE is not agreement (the [00:06] burst): "E OVOJ MOZE"
        // picks a flat from the batch on screen; treating it as exhausted-
        // options consent jumped to contact collection with the FEE NEVER
        // DISCLOSED. The choice lane above owns it.
        && !detectPropertyChoice(text)) {
      next = 'contact_collection';
      session.state = next;
      session.slots.queueAfterContact = true;
    }

    // 5) Reply strategy — deterministic where exactness matters
    pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);

    // Client accepted the owner's counter-time -> code-built confirmation
    if (next === 'pending' && before === 'time_confirm') {
      const eb = session.slots.interestedPropertyId ?? session.slots.propertyId ?? 0;
      const time = session.slots.ownerTime ?? session.slots.visitTime ?? '';
      await this.confirmVisit(session, eb, time);
      return;
    }


    // ANCHORED ENTRY SERVE (the [11:07] capture): "ИМАТЕ ОБЈАВЕНО ЕДНА КУЌА ЗА
    // ИЗДАВАЊЕ КАЈ ОЛИМПИКО" — the client opens with a PLACE plus a category
    // the bank is thin in. Asking спални and цена first is the grill the
    // operator keeps flagging: the place IS the search, so the rows standing
    // at it are served now, ranked from the map place, with the price he
    // remembers probed after them. Flats keep the funnel — the bank is full
    // of them, a place alone says too little there. Computed before the reply
    // chain because the chain's last arm replaces an earlier code-built reply
    // with the LLM's discovery ask.
    let anchoredServe: string | undefined;
    // A remembered PRICE does not cancel the serve — it ranks it (the [20:56]
    // capture: place + «околу 400 евра» + куќа за изнајмување, and the funnel
    // still asked «колку спални соби?»). Area + category + service + a place
    // are enough; the money orders the cards.
    if (!reply && landmarkEntry
        && (before === 'discovery' || before === 'intent' || before === 'idle')
        && session.slots.poiAnchor
        && (session.slots.house === true || session.slots.business === true
          || session.slots.plac === true)) {
      const a = this.resolvePlace(session.slots.poiAnchor);
      const distTo = (p: Property): number => (a && typeof p.lat === 'number' && typeof p.lon === 'number'
        && p.lat !== 0 && p.lon !== 0) ? distM(a.lat, a.lon, p.lat, p.lon) : Number.POSITIVE_INFINITY;
      const rememberedPrice = session.slots.budget
        ? Number(session.slots.budget.replace(/[^\d]/g, '')) : undefined;
      const hits = a ? await this.deps.properties.closestMatches({
        location: session.slots.location,
        house: session.slots.house === true,
        business: session.slots.business === true,
        plac: session.slots.plac === true,
        service: session.slots.service,
        price: rememberedPrice,
      }) : [];
      let nearPlace = hits.filter(p => distTo(p) <= LANDMARK_NEAR_M)
        .sort((x, y) => distTo(x) - distTo(y) || x.eb - y.eb).slice(0, 2);
      // The assumed area had nothing of the category — drop ONLY the assumption
      // (it was inferred from the place in the first place) and keep the same
      // characteristics, exactly like the locate branch's fallback.
      if (nearPlace.length === 0 && a && session.slots.location) {
        const citywide = await this.deps.properties.closestMatches({
          house: session.slots.house === true,
          business: session.slots.business === true,
          plac: session.slots.plac === true,
          service: session.slots.service,
          price: rememberedPrice,
        });
        nearPlace = citywide.filter(p => distTo(p) <= LANDMARK_NEAR_M)
          .sort((x, y) => distTo(x) - distTo(y) || x.eb - y.eb).slice(0, 2);
      }
      if (a && nearPlace.length > 0) {
        session.slots.presentedIds = [...new Set([...(session.slots.presentedIds ?? []), ...nearPlace.map(p => p.id)])];
        session.slots.currentBatch = nearPlace.map(p => p.id);
        // CONFIRM, do not echo: he told us what he is looking for, so the line
        // answers «да, имаме…» and hands over the rows at the place.
        // The price probe only when the price is still unknown — he may have
        // just given it («ОКОЛУ 400 ЕВРА БЕШЕ»), and asking again the question
        // he answered is the loop this funnel keeps being fixed for.
        anchoredServe = `${buildLocateLandmarkEntry(a.name, session.slots.location, session.slots, nearPlace.length)}\n\n${buildLocateMatches(nearPlace, session.history.length)}`
          + (session.slots.budget ? '' : `\n\n${buildLocateLandmarkPriceProbe(session.slots)}`);
      }
    }

    // Locate-a-seen-property funnel (deterministic, like the no-match lines):
    // the client saw a specific property but has no Евидентен број. First ask
    // for the number (known -> easy property_query lookup); then collect
    // identifying details (населба / цена / квадрати) and present the CLOSEST
    // DB matches code-built — the LLM must never invent them. "не е тој" pulls
    // the next closest batch; only when every match was shown do we ask for
    // more details.
    if (next === 'property_locate') {
      const price = session.slots.budget ? Number(session.slots.budget.replace(/[^\d]/g, '')) : undefined;
      // ROOM COUNT rides with every locate serve (the [19:42] capture):
      // "PAMTAM SAMO DEKA CENATA MU BESE OKOLU 115 ILJADI I DEKA IMASE DVE
      // SPALNI" — the client's remembered rooms/спални count steers the
      // pair exactly as цена/квадрати do, so a serve never shows a
      // гарсоњера when he described two bedrooms.
      const locateOpts = {
        location: session.slots.location,
        price,
        sqm: session.slots.sqm,
        bedrooms: session.slots.bedrooms,
        // CATEGORY LOCK (the [20:15] rule): a seen-property serve is for the
        // flat the client described — "STAN" — so деловен/куќа/плац rows are
        // junk and junk is NEVER served. Only the client's OWN category words
        // (деловен/куќа/плац slots) unlock the wider family; unlike the wide
        // search categories, a locate serve has no permission to go
        // category-neutral.
        business: session.slots.business === true,
        house: session.slots.house === true,
        plac: session.slots.plac === true,
        service: session.slots.service,
      };
      // EB-DISCLAIM LADDER (the [11:08] rule): once the client said he does
      // not have the Евидентен број — this turn (pushed above) or within the
      // last 8 — no locate ask may invite it again, the pick-closer included.
      const ebDisclaimed = (session.history ?? [])
        .filter(h => h.role === 'user').slice(-8)
        .some(h => EB_DISCLAIM_RE.test(h.text));
      const present = (matches: Property[]): string => {
        // Mark the batch as shown ONLY when it is actually presented, so the
        // next "не е тој" pulls the NEXT closest ones (never re-shows).
        // De-duplicated: a message that repeats the SAME specs re-announces
        // the same pair but must not double-register them (the exclusion
        // below is a Set, so dupes were harmless — but the list ballooned).
        session.slots.presentedIds = [...new Set([...(session.slots.presentedIds ?? []), ...matches.map(p => p.id)])];
        session.slots.currentBatch = matches.map(p => p.id);
        return buildLocateMatches(matches, session.history.length, !ebDisclaimed);
      };
      // Interest expressed while locating a property — route to closing if
      // we have a known propertyId (e.g. "go gledav stanot 79" → "zainteresiran sum").
      // Without this, the property_locate block catches the interest message
      // and shows property cards instead of the closing enthusiasm + fee path.
      if (before === 'property_locate' && detectPropertyInterest(text)) {
        const eb = session.slots.propertyId ?? session.slots.interestedPropertyId ?? props[0]?.eb;
        if (eb) {
          session.slots.interestedPropertyId = eb;
          session.slots.ownerContactPending = true;
          session.state = 'closing';
          next = 'closing';
          reply = pickVariant('property.liked', { recent: assistantTexts(session) })
            ?? 'Одличен избор! Дали би сакале да организирам посета, за да го погледнете во живо?';
          bankKey = 'property.liked';
        }
      }
      // LANDMARK READING (the [13:28] capture: "PISUVASE DO BROZ KAFE") — the
      // client anchors the property he saw to a MAP PLACE instead of a
      // neighborhood. Resolve it ONCE, here, so every branch below reads the
      // same geography: the map's OWN name for the place, and the AREA the
      // feed's rows put it in (Broz Cafe → Центар — a human's street knowledge
      // is exactly what the bank holds). A place the map does not know leaves
      // the funnel untouched (the asks below stay honest).
      let placeAnchor: { name: string; lat: number; lon: number; place_url?: string; place_id?: string } | undefined;
      if (!reply && this.landmarks) {
        // AREAS ARE NOT PLACES (the [10:28] capture): "kaj vas vo novo lisice"
        // names a neighborhood, and the POI map's fuzzy lookup turned it into
        // the post office "ELS Novo Lisice" — a landmark the client never
        // mentioned, which the next turn then served as if he had. The feed's
        // own area names are passed in so the tail can be vetoed as an area.
        // CANDIDATE ARBITRATION (the [09:38] capture): a client sentence can
        // carry SEVERAL "кај/до/околу" tails and only one of them names the
        // map place ("… КАЈ ВАС НА СТРАНИЦАТА , КАЈ ОЛИМПИКО …"). First-match
        // extraction stopped at the grammar tail, so the real place was never
        // offered to the map and the entry fell into the area-less ask. Every
        // candidate is verified against the map; the FIRST REAL PLACE wins
        // (text order = the speaker's own priority).
        for (const cand of extractPoiWishCandidates(text, { withCriteria: true })) {
          const a = this.resolvePlace(cand);
          if (a) { placeAnchor = a; break; }
        }
        if (placeAnchor) {
          session.slots.poiAnchor = placeAnchor.name;
          if (!session.slots.location) {
            const area = await this.areaAtPlace({ lat: placeAnchor.lat, lon: placeAnchor.lon, name: placeAnchor.name });
            if (area) { session.slots.location = area; session.slots.poiArea = area; }
          }
        }
      }
      // The landmark may have arrived EARLIER ("пишуваше до Broz Kafe") and the
      // client now adds a detail ("околу 200 000 беше"): the search keeps
      // ranking from the place he named. Only while the area is still the one
      // the landmark gave — a NEW neighborhood in the message means a
      // different search, and the landmark stops steering it.
      const anchor = placeAnchor ?? (session.slots.location === session.slots.poiArea
        ? this.resolvePlace(session.slots.poiAnchor) : undefined);
      // The [20:15] rule, executed — he said enough to match the search:
      // LET THE CHAIN BELOW SERVE when the money anchor or a service-locked
      // room/sqm pool exists; ask the ONE missing intent question otherwise.
      // The money anchor (budget) is the strongest serve trigger regardless
      // of service: the price-proximity ranking keeps the pair near what he
      // paid, and the category lock keeps it in the flat family.
      // When specs exist but the price is unwritten AND the buy/rent intent
      // untold, the ONE thing she may ask is the sale-or-rent of THE property
      // he saw — never a re-ask of what he already said.
      const specsKnown = !!(session.slots.bedrooms || session.slots.sqm);
      // MONEY-ANCHOR GATE (the [madjari] sequential-path regression): at
      // ENTRY the PRICE is the ONLY thing that unlocks a serve. The
      // specs+service arm ranked an unfiltered pool with no price band to
      // steer by — the closestMatches tie broke on EB order and dumped area
      // junk (EB 42 rent-ish, EB 56 деловен) on a client who only typed
      // населба + спални. Price unwritten → the specs+price question
      // (the branch below); follow-up turns keep their own serve rules.
      const serveOnEntry = !!(session.slots.location && session.slots.budget);
      const askServiceOnEntry = !!(session.slots.location && specsKnown
        && !session.slots.budget && !session.slots.service);
      // NOTE: serveOnEntry must fall through to the serve chain below — these
      // are if/else-if branches, so an inner "empty else" BREAKS the chain and
      // leaves the reply empty (hit twice in the [20:15] repair).
      if (before !== 'property_locate' && !reply && askServiceOnEntry) {
        reply = buildLocateServiceAsk(session.slots, !ebDisclaimed);
      } else if (before !== 'property_locate' && !reply && !serveOnEntry && !(anchor && ebDisclaimed)) {
        // Just entered — ask the number first (the easy path when known),
        // UNLESS the entering message already named the area ("go gledav
        // oglasot za stan vo karpos…"): the [19:22] family. Asking "do you
        // know the EB?" after the client just told us the neighborhood is the
        // dead-end the desc interceptor always skipped — mirror its smart ask.
        // ANCHORED ENTRY (the [11:07] capture): an anchored entry whose
        // client ALREADY disclaimed the number falls THROUGH to the landmark
        // serve below — inviting the number he just said he lacks, then
        // grilling m²/price, is the dead grill the operator kept flagging;
        // the near-place cards + the price probe are the helpful mode. An
        // anchored entry WITHOUT the disclaim keeps the number-first ask
        // (the [11:29] pin: the number is the cheapest resolution path).
        reply = session.slots.location
          ? buildLocateMoreSpecsAsk(displayAreaName(session.slots.location), session.slots, !ebDisclaimed)
          : (ebDisclaimed ? LOCATE_DETAILS_ASK : buildLocateFirstAsk(session.slots));
      } else if (/го\s+знам|знам\s+го|znam\s+go|го\s+знам\s+бројот/i.test(text)) {
        // "да, го знам" — the client knows the number; prompt for it instead
        // of looping the first ask (the number itself routes to property_query).
        reply = LOCATE_NUMBER_PROMPT;
      } else if (ev.type === 'REJECTED') {
        // "не е тој" — pull the NEXT closest batch (never re-show what was
        // just rejected); when the place is drained, ASK ABOUT OTHER
        // NEIGHBOURHOODS (the hunt continues, it never stops at «кажете ми
        // уште некој детал»).
        const next = await this.locateNextOptions(session);
        reply = next.reply;
        if (next.bankKey) bankKey = next.bankKey;
      } else if (anchor && (before === 'property_locate' || (ebDisclaimed && !reply))) {
        // THE LANDMARK ANSWER (the [10:56]/[11:07]-ruled transcript): "пишуваше
        // до Broz Kafe" — the client does not know the Евидентен број but he
        // knows WHERE it was. Search the bank with the characteristics he
        // already described (услуга, соби, цена, м²), ranked from the place
        // he named, so the 3-room flat ~100 m from the bar leads. Nothing
        // near the place → the SAME characteristics offered as the closest
        // alternatives (the owner's rule: "if she does not find the apartment
        // wanted she must offer him different ones with the characteristics
        // discussed"). The area stays a lock, never a barrier: it was only
        // ever ASSUMED from the landmark in the first place.
        // The (ebDisclaimed && !reply) arm is the [11:07] capture: an
        // anchored entry that already disclaimed the number turns HERE
        // instead of the specs grill above.
        const distTo = (p: Property): number => (typeof p.lat === 'number' && typeof p.lon === 'number' && p.lat !== 0 && p.lon !== 0)
          ? distM(anchor.lat, anchor.lon, p.lat, p.lon)
          : Number.POSITIVE_INFINITY;          // Order: CATEGORY first (the [13:28] complaint), then the client's
          // OWN price when he gave one (the detail he remembers best), then
          // how close it is to the place. The category tier is the rooms he
          // described: a two-room flat must never take a serve slot ahead of
          // a three-room match of the SAME "трособен" ask just because it is
          // closer to the bar — distance breaks ties INSIDE the right room
          // count, never across it.
          const roomTier = (p: Property): number =>
            session.slots.bedrooms !== undefined && p.bedrooms !== undefined
              ? Math.min(2, Math.abs(p.bedrooms - session.slots.bedrooms)) : 0;
          const ranked = async (extra: { location?: string }): Promise<Property[]> => {
            const hits = await this.deps.properties.closestMatches({
              ...locateOpts, location: extra.location, bedrooms: session.slots.bedrooms,
            });
            return [...hits].sort((a, b) =>
              roomTier(a) - roomTier(b)
              || (price === undefined ? 0 : Math.abs((a.price ?? Number.POSITIVE_INFINITY) - price) - Math.abs((b.price ?? Number.POSITIVE_INFINITY) - price))
              || distTo(a) - distTo(b) || a.eb - b.eb);
          };
        let matches = await ranked({ location: session.slots.location });
        // The ring never serves out-of-category: a two-room flat must not
        // take a near-ring slot ahead of the three-room match further away
        // because it happens to be closer to the bar — distance breaks ties
        // INSIDE the right room count, never across it ([13:28]).
        let near = matches.filter((p) => distTo(p) <= LANDMARK_NEAR_M
          && roomTier(p) === 0);
        if (near.length === 0 && session.slots.location) {
          // The assumed area had nothing matching his criteria — drop ONLY the
          // assumption and re-search the same characteristics city-wide.
          matches = await ranked({ location: undefined });
        }
        if (near.length > 0) {
          session.slots.poiAnchorTooFar = undefined;
          const nearPair = near.slice(0, 2);
          reply = `${buildLocateLandmarkIntro(anchor.name, session.slots.location, session.slots, nearPair.length)}\n\n${present(nearPair)}`;
        } else if (matches.length > 0) {
          session.slots.poiAnchorTooFar = true;
          // Same-characteristics serve: when the client described a room
          // count, the alternative slots hold ONLY same-room matches (the
          // [13:28] owner rule); a wrong-room flat is shown only when the
          // bank holds literally nothing else that matches.
          const same = matches.filter((p) => roomTier(p) === 0);
          reply = `${buildLocateLandmarkFallback(anchor.name, session.slots.location)}\n\n${present((same.length > 0 ? same : matches).slice(0, 2))}`;
        } else {
          reply = LOCATE_REFINE_ASK;
        }
        // He remembers the place, not the price — keep the missing piece
        // asked ("по која цена беше") without blocking the matches.
        if (!session.slots.budget) reply += `\n\n${buildLocateLandmarkPriceProbe(session.slots)}`;
      } else if (session.slots.location && !session.slots.sqm && !session.slots.budget
        && !session.slots.bedrooms && !(session.slots.bedroomsMin !== undefined && session.slots.bedroomsMax !== undefined)) {
        // Location known but m² / price / bedrooms missing — collect more
        // specs before dumping ALL properties in the area.  The client said
        // "stan na Vodno" but we need size and budget to narrow the list.
        reply = buildLocateMoreSpecsAsk(displayAreaName(session.slots.location ?? ''), session.slots);
      } else if (session.slots.location || session.slots.sqm || session.slots.budget) {
        // A NEW identifying detail (населба / цена / квадрати) re-ranks the
        // WHOLE candidate pool — excluding already-shown matches here would
        // hide the property the client is actually narrowing toward.
        const matches = (await this.deps.properties.closestMatches(locateOpts)).slice(0, 2);
        reply = matches.length > 0 ? present(matches) : LOCATE_REFINE_ASK;
      } else {
        // No identifying details yet — collect населба / цена / квадрати.
        reply = LOCATE_DETAILS_ASK;
      }
    } else if (next === 'queued') {
      reply = session.slots.queueAfterContact
        ? (pickVariant('queued.confirm', { recent: assistantTexts(session) }) ?? QUEUED_CONFIRM)
        : (pickVariant('fee.graceful.close', { recent: assistantTexts(session) }) ?? FEE_GRACEFUL_CLOSE);
    } else if (session.slots.queueAfterContact && session.state === 'contact_collection') {
      // Out-of-context questions during contact collection: the client asks
      // about terms, fees, neighborhoods, etc. instead of giving name/phone.
      // Answer the question FIRST, then remind about contact info — like a
      // human agent would: "ЗА ИЗНАЈМУВАЊЕ УСЛОВИТЕ СЕ... btw ми требаат
      // име и телефон."
      const simple = dispatchSimple(text, session.state);
      if (simple) {
        routeLog(chatId, text, simple.intent);
        let effectiveKey = simple.bankKey;
        if (effectiveKey === 'provision.ask') {
          effectiveKey = provisionKeyFor(session.slots.service);
        } else if (effectiveKey === 'provision.who') {
          const isDanok = /danok|danokot|данок|данокот/i.test(text);
          if (isDanok && session.slots.service !== 'rent') {
            effectiveKey = 'provision.who.danok.buy';
          } else {
            effectiveKey = session.slots.service === 'rent' ? 'provision.who.rent' : 'provision.who.buy';
          }
        }
        const picked = pickVariant(effectiveKey, { recent: assistantTexts(session) });
        const n = session.slots.contactAsks ?? 0;
        session.slots.contactAsks = n + 1;
        const contactReminder = buildContactAsk(session.slots, assistantTexts(session));
        if (picked) {
          reply = `${picked}

${contactReminder}`;
          bankKey = effectiveKey;
        } else {
          // Bank miss (P4): the informational half is an anonymous literal.
          // bankKey stays unset + fallback source → the epilogue capture
          // logs the serve as FALLBACK_ORPHAN instead of crediting a bank
          // key it never had.
          reply = `${simple.fallback}

${contactReminder}`;
          replySource = 'fallback';
        }
      } else {
        // Non-informational message during contact_collection — answer with
        // the LLM (it can handle questions about terms, process, etc.) and
        // append the contact reminder. The LLM has the system prompt context
        // to answer authoritatively about the agency.
        const r = await this.deps.responder.respond(session, props, text);
        const n = session.slots.contactAsks ?? 0;
        session.slots.contactAsks = n + 1;
        const contactReminder = buildContactAsk(session.slots, assistantTexts(session));
        reply = `${r.text}

${contactReminder}`;
        replySource = r.source;
      }
    } else if (next === 'closing'
        && detectPropertyInterest(text)
        && !detectRemark(text)
        && !detectVisitInterest(text) // visit noun INSIDE the praise ("ke go kupam ako e dobar vo zivo", the [02:31] capture) is an AGREEMENT TO VISIT — the fee gate below owns it, never property.liked
        && !detectVisitTimingQuestion(text) // timing QUESTION → the confirm-ask leg below, never the visit offer (the [19:56] rule)
        && before !== 'closing'
        && (before === 'property_query' || before === 'presentation' || before === 'discovery'
          || before === 'idle' || before === 'intent' || before === 'property_locate')) {
      // Enthusiasm: the client said 'mi se svigja 89' / 'zainteresiran sum' /
      // 'go sakam' — general interest (NOT explicit scheduling like 'кога
      // може да се погледне' / 'договори ми'). Send enthusiasm + visit offer,
      // NOT the fee yet. The fee is disclosed ONLY after the client confirms ('да').
      // Availability asks ('дали е достапен?') are caught by detectPropertyInterest
      // exclusion (PROPERTY_INTEREST_RE doesn't match them), so they go to the
      // availability ack path below.
      // (00:09) before-guard widened to idle/intent/property_locate: from those
      // states the old guard let the INTERESTED event fall to the responder's
      // closing fallback, which fee-asked IMMEDIATELY — skipping the enthusiasm
      // + visit-offer step the 21:02 rule mandates. Same pre-closing set as the
      // praise branch below.
      // MENTION BINDING (00:09): "GARSONJERAVA KAJ CRNOGORSKA AMBASADA MI E
      // INTERESNA" — the enthusiasm belongs to the property the client NAMED
      // (EB 76, offered two turns earlier), never to the stale slot or
      // props[0]. A tie serves ONE clarify question instead of a guess (same
      // protocol as the visit branch below).
      const mb = await this.bindMention(text, session);
      if (await this.sendIfClarify(mb, text, session)) return;
      const eb = mb?.prop?.eb
        ?? session.slots.propertyId ?? session.slots.interestedPropertyId ?? props[0]?.eb;
      // GHOST GUARD (P4 follow-up): an anchored EB (named or slot) that the
      // feed cannot confirm is GONE — "mi se svigja 999" must serve the
      // honest not-found pivot, never arm the funnel for a ghost (fee for a
      // property that does not exist). getById is the authoritative rescue:
      // a real property outside the current batch is NOT a ghost.
      const anchored = eb != null && (props.some(p => p.eb === eb)
        || !!(await this.deps.properties.getById(eb).catch(() => undefined)));
      if (eb != null && !anchored) {
        // FEED-DOWN GUARD: with zero feed data the miss may be the outage, not
        // a ghost — never clear the client's anchor while we cannot know.
        if (!this.feedHealthy()) {
          reply = FEED_UNAVAILABLE_LINE;
          bankKey = undefined;
          // The FSM may have already advanced the session toward closing on
          // this event — REVERT it: a feed-down turn must not move the funnel
          // (the next message would hit the closing catch-alls).
          session.state = before;
        } else {
          reply = pickVariant('property.notfound', { recent: assistantTexts(session), vars: { eb: String(eb) } })
            ?? PROPERTY_NOT_FOUND_LINE(eb);
          bankKey = 'property.notfound';
          session.slots.propertyId = undefined;
          session.slots.interestedPropertyId = undefined;
          session.slots.lastGhostEb = eb;
        }
      } else {
        if (eb) {
          session.slots.interestedPropertyId = eb;
          session.slots.ownerContactPending = true;
          session.state = 'closing';
        }
        reply = pickVariant('property.liked', { recent: assistantTexts(session) })
          ?? 'Одличен избор! Дали би сакале да организирам посета, за да го погледнете во живо?';
        bankKey = 'property.liked';
      }

    } else if (next === 'closing'
        && detectPositiveEval(text)
        && !detectPropertyInterest(text)
        && !detectVisitInterest(text)
        && !detectAvailabilityAsk(text)
        && !detectRemark(text)
        && !detectAgreement(text)
        && !detectFeeWhy(text) && !detectFeeComplaint(text) && !detectFeeSurprise(text)
        && !detectFeePaymentAgreement(text) && !detectInvestmentOpinion(text)
        && !detectExhaustedFollowUp(text)
        && (before === 'property_query' || before === 'presentation' || before === 'discovery'
          || before === 'idle' || before === 'intent' || before === 'property_locate'
          || (before === 'closing' && !!session.slots.ownerContactPending))) {
      // Praise WITHOUT a visit verb ("ODLICNA LOKACIJA IMA", "BAS TAKOV MI
      // TREBA") — the 21:02 bug: the bare INTERESTED branch below disclosed
      // the fee before the client ever said they want a visit. Serve
      // property.liked (enthusiasm + visit offer); the fee comes only after
      // the client confirms. Agreements ("да") are excluded — in closing they
      // belong to the fee/owner-contact gates below. Re-praise after the
      // visit offer (ownerContactPending) re-serves the offer; after the fee
      // was disclosed it falls through to the closing catch-alls.
      // MENTION BINDING (00:09): same protocol as the interest branch above —
      // praise that NAMES a property ("taj kaj ambasadata e prekrasen") must
      // anchor the funnel on THAT property, not on the stale slot.
      const mb = await this.bindMention(text, session);
      if (await this.sendIfClarify(mb, text, session)) return;
      const eb = mb?.prop?.eb
        ?? session.slots.propertyId ?? session.slots.interestedPropertyId ?? props[0]?.eb;
      // GHOST GUARD (P4 follow-up): an anchored EB (named or slot) that the
      // feed cannot confirm is GONE — "mi se svigja 999" must serve the
      // honest not-found pivot, never arm the funnel for a ghost (fee for a
      // property that does not exist). getById is the authoritative rescue:
      // a real property outside the current batch is NOT a ghost.
      const anchored = eb != null && (props.some(p => p.eb === eb)
        || !!(await this.deps.properties.getById(eb).catch(() => undefined)));
      if (eb != null && !anchored) {
        // FEED-DOWN GUARD: with zero feed data the miss may be the outage, not
        // a ghost — never clear the client's anchor while we cannot know.
        if (!this.feedHealthy()) {
          reply = FEED_UNAVAILABLE_LINE;
          bankKey = undefined;
          // The FSM may have already advanced the session toward closing on
          // this event — REVERT it: a feed-down turn must not move the funnel
          // (the next message would hit the closing catch-alls).
          session.state = before;
        } else {
          reply = pickVariant('property.notfound', { recent: assistantTexts(session), vars: { eb: String(eb) } })
            ?? PROPERTY_NOT_FOUND_LINE(eb);
          bankKey = 'property.notfound';
          session.slots.propertyId = undefined;
          session.slots.interestedPropertyId = undefined;
          session.slots.lastGhostEb = eb;
        }
      } else {
        if (eb) {
          session.slots.interestedPropertyId = eb;
          session.slots.ownerContactPending = true;
          session.state = 'closing';
        }
        reply = pickVariant('property.liked', { recent: assistantTexts(session) })
          ?? 'Одличен избор! Дали би сакале да организирам посета, за да го погледнете во живо?';
        bankKey = 'property.liked';
      }

    } else if (before === 'closing' && next === 'closing'
        && detectPropertyInterest(text)
        && !detectAvailabilityAsk(text)
        && !detectVisitInterest(text)
        && !detectRemark(text) && !detectAgreement(text)
        && !detectFeeWhy(text) && !detectFeeComplaint(text) && !detectFeeSurprise(text)
        && !detectFeePaymentAgreement(text) && !detectInvestmentOpinion(text)
        && !detectExhaustedFollowUp(text) && !detectPositiveEval(text)
        && !detectCheaperSearch(text) && !detectPriceAsk(text)
        && !detectWaitingAck(text)
        && !detectExactAddressAsk(text) && !detectWhereIs(text)) {
      // PROPERTY SWITCH INSIDE CLOSING (the [16:05] transcript): the client
      // already went through the fee disclosure for one property, then names
      // ANOTHER ("ME INTERESIRA STANOT 76"). Closing is not in the funnel
      // override's state set, so the interest line fell through as STAY and
      // the LLM "compensated" for details it did not have — deepening the
      // info gap. A fresh EB that differs from the bound one is the client
      // SWITCHING properties: re-anchor, serve the card (like property_query
      // does), restart the closing funnel for the NEW property.
      const freshPid = inferPropertyId(text);
      const mbSwitch = freshPid === undefined ? await this.bindMention(text, session) : undefined;
      if (await this.sendIfClarify(mbSwitch, text, session)) return;
      const targetEb = freshPid ?? mbSwitch?.prop?.eb;
      const target = targetEb != null
        ? await this.deps.properties.getById(targetEb).catch(() => undefined)
        : undefined;
      if (target) {
        session.slots.propertyId = target.eb;
        session.slots.interestedPropertyId = target.eb;
        session.slots.ownerContactPending = true;
        // Rotation reset: the new property's nearby ladder starts fresh.
        session.slots.nearbyLandmarks = undefined;
        session.slots.nearbyLandmarkCoords = undefined;
        session.slots.nearbyLandmarkPlaceIds = undefined;
        session.slots.nearbyLandmarkEb = undefined;
        session.slots.landmarkIndex = 0;
        session.slots.lastLandmark = undefined;
        session.slots.addressProtocolIndex = 0;
        session.slots.exactLocationTurns = 0;
        session.slots.feeRejections = undefined;
        session.slots.viewingFeeAgreed = false;
        session.state = 'closing';
        next = 'closing';
        await this.landmarks.enrich([target]);
        reply = `${buildPropertyCard(target)}\n\n${pickVariant('property.liked', { recent: assistantTexts(session) })
          ?? 'Одличен избор! Дали би сакале да организирам посета, за да го погледнете во живо?'}`;
        bankKey = 'property.liked';
      }
      // No resolvable target → fall through to the responder below with the
      // old anchors intact; the LLM gets a normal context, not a switch.

    } else if ((next === 'closing'
          // THE [21:28] CAPTURE: a card was just served in DISCOVERY and "KOGA
          // MOZE DA SE VIDI?" arrived as SEARCH_REQUESTED — the timing lane was
          // gated on next === 'closing', so the turn fell into the presentation
          // re-run, which excluded the card it had just served and announced
          // the area empty. A property on the table is enough for the lane.
          || session.slots.propertyId || session.slots.interestedPropertyId
          || (session.slots.currentBatch?.length ?? 0) > 0)
        && detectVisitTimingQuestion(text)
        && !session.slots.viewingFeeAgreed // fee settled → a timing ask is SCHEDULING, not the confirm gate
        && (before === 'closing' // [19:56]: the closing catch-all read the question as a command and fee-asked
          || before === 'property_query' || before === 'presentation' || before === 'discovery'
          || before === 'intent' || before === 'idle')) {
      // VISIT-TIMING QUESTION (the [19:56] funnel-order rule): "KOGA BI MOZELO
      // DA SE POSETI" asks WHEN — it is NOT the confirmation the fee gate
      // waits for. Answer with the owner-contact confirm ask (visit.confirm.ask,
      // amount-free); the fee is disclosed only AFTER the client agrees
      // ("во ред" / "се согласувам" rides the agreement gate below).
      reply = pickVariant('visit.confirm.ask', { recent: assistantTexts(session) }) ?? VISIT_CONFIRM_ASK;
      bankKey = 'visit.confirm.ask';
      session.state = 'closing';
      next = 'closing';
      const mbTiming = await this.bindMention(text, session);
      if (await this.sendIfClarify(mbTiming, text, session)) return;
      const ebTiming = mbTiming?.prop?.eb
        ?? session.slots.propertyId ?? session.slots.interestedPropertyId
        ?? session.slots.currentBatch?.[0] ?? props[0]?.eb;
      if (ebTiming != null) session.slots.interestedPropertyId = ebTiming;
      session.slots.ownerContactPending = true;

    } else if (next === 'closing'
        && (ev.type === 'INTERESTED' || detectVisitInterest(text))
        && before !== 'closing'
        && !session.slots.viewingFeeAgreed
        && !detectVisitTimingQuestion(text) // belt-and-braces: the confirm-ask leg above owns timing questions
        && !detectAvailabilityAsk(text)
        // A visit noun INSIDE property praise ("ke go kupam ako e dobar vo
        // zivo", the [02:31] capture) is still an agreement to visit: the
        // client buys only if he likes it IN PERSON. The old exclusion let
        // mixed messages skip this gate (propertyInterest was true) and fall
        // to property.liked — a second round of "want a visit?" with the fee
        // never disclosed. detectVisitInterest is this gate's FIRST condition,
        // so dropping the interest exclusion only changes MIXED messages, and
        // for those the visit wins over the sentiment.
        && !detectRemark(text)
        && !detectFeeWhy(text)
        && !detectInvestmentOpinion(text)
        && !detectFeeComplaint(text)
        && !detectFeeChargePushback(text) // the charge ACCUSATION is resistance, never a fresh visit interest (the [00:27] re-disclosure)
        && !detectFeeFirstTime(text)       // "prv pat slusam" asks for the RULE, not a second disclosure
        && !detectExhaustedFollowUp(text)
        && (before === 'property_query' || before === 'presentation' || before === 'discovery')) {
      // Explicit visit interest: 'sakam da ja vidam', 'koga moze da se
      // pogledne', 'dogovori mi' — the client wants to SEE the property.
      // Show the fee disclosure directly (NOT enthusiasm — that's for general
      // interest like 'mi se svigja'). This is the main fee-disclosure gate.
      // MENTION BINDING (12:33): "sakam da ja vidam garsonjerata" — the visit
      // is requested for the NAMED property, not the last one on the table.
      const mb = await this.bindMention(text, session);
      if (await this.sendIfClarify(mb, text, session)) return;
      const visitTarget = mb?.prop
        ?? props.find(p => p.eb === (session.slots.propertyId ?? session.slots.interestedPropertyId))
        ?? props.find(p => p.eb === ev.propertyId)
        ?? props[0];
      if (visitTarget) session.slots.interestedPropertyId = visitTarget.eb;
      else if (session.slots.propertyId) session.slots.interestedPropertyId = session.slots.propertyId;
      else if (ev.propertyId) session.slots.interestedPropertyId = ev.propertyId;
      session.state = 'closing';
      const service = session.slots.service ?? props[0]?.service ?? 'buy';
      const fee = pickVariant(service === 'rent' ? 'fee.ask.rent' : 'fee.ask.buy', { recent: assistantTexts(session) })
        ?? buildFeeAsk(service);
      reply = fee;
      bankKey = service === 'rent' ? 'fee.ask.rent' : 'fee.ask.buy';

    } else if ((next === 'closing' || session.state === 'closing' || before === 'closing')
        && detectProvisionResistance(text)) {
      // PROVISION ladder — the FSM-leg mirror of the fast lane. It sits BEFORE
      // every fee leg for two reasons: the commission has its OWN rungs (a
      // commission complaint must not be answered with visit-fee copy), and a
      // commission refusal must never burn a VISIT-FEE rung (the isolation
      // contract). The fast lane owns the common case; this leg is what makes
      // the guarantee hold for FSM-forced turns too.
      const served = this.serveProvisionResistance(session, text);
      reply = served.reply;
      bankKey = served.bankKey;
    } else if ((before === 'closing' || before === 'presentation')
        && !session.slots.viewingFeeAgreed
        && (detectFeeNag(text) || detectFeeAnaphoricRefusal(text))
        && !detectMoreOptions(text)) { // OPTIONS ASK WINS — same rule as the fast lane;
      // the anaphoric arm covers the object-less "не ми одговара" answered to
      // the fee stack ([14:36]): the ladder owns it like every other resistance
      // shape — never property suggestions, never the goodbye on rung 1.
      // THE NAG LADDER — the FSM-leg mirror of the fast lane above. Same order
      // for the 300 and the 500: one rung per nag, its own counter, and the
      // commission counter is never touched (provision resistance is handled
      // by the branch above). Without this leg, FSM-forced turns bypassed the
      // fast lane and fee.why answered complaints without advancing.
      // nagRungServed suppresses the FEE_REFUSED counter below — the same turn
      // must never burn two rungs (fast lane / refusal ladder are one rung).
      // The classifier's FEE_REFUSED ladder above may ALREADY have counted
      // this turn (it runs before the reply chain); never count it twice.
      // ONE ladder implementation (serveFeeNagLadder): the fast lane and this
      // leg can never drift apart, and `counted` carries the classifier's
      // already-burned rung so one message never costs two rungs.
      const counted = nagRungServed;
      nagRungServed = true;
      const served = this.serveFeeNagLadder(session, { counted });
      reply = served.reply;
      bankKey = served.bankKey;
      next = served.rung === 'closed' ? 'queued' : 'closing';
    } else if (detectFeeRules(text) && ['closing', 'property_query', 'presentation', 'discovery', 'intent', 'idle'].includes(before)) {
      // Fee-RULES dismissal (the [12:40] serve): "тоа се правилата на
      // агенцијата кои важат и за мене и за Вас" — the client files the fee
      // under "just your policy". Confirm the policy AND show it binds both
      // sides (fee.rules bank — same rules for clients and agency), stay at
      // the fee question. Before the fee.why leg (both are explanation
      // traffic; the rules frame deserves the rules answer).
      reply = pickVariant('fee.rules', { recent: assistantTexts(session) }) ?? buildFeeRules();
      bankKey = 'fee.rules';
    } else if (detectFeeWhy(text) && ['closing', 'property_query', 'presentation', 'discovery', 'intent', 'idle'].includes(before)) {
      // "Зошто наплаќате?" / "Никој не наплаќа за посета" / "Како тоа да платам?"
      // — the client QUESTIONS the fee, they don't REFUSE it. Always answer
      // with the agency rationale (fee.why) and stay at closing. The pivot
      // to alternatives is only for actual fee REFUSALS (FEE_REFUSED below),
      // not for why-questions. Answering WHY first, then re-asking the fee,
      // lets the client make an informed decision.
      reply = pickVariant('fee.why', { recent: assistantTexts(session) }) ?? buildFeeWhy();
      bankKey = 'fee.why';
    } else if (detectFeeTotalCost(text) && ['closing', 'property_query', 'presentation', 'discovery', 'intent', 'idle'].includes(before)) {
      // Multiplication total-cost complaint (the [12:40] serve): "10 стана ×
      // 5000 од мој џеб" — the client multiplies the fee by their search
      // size. The math acknowledgment + value answer (fee.why pool covers
      // it), never the fee re-disclosure, never the property search.
      reply = pickVariant('fee.why', { recent: assistantTexts(session) }) ?? buildFeeWhy();
      bankKey = 'fee.why';
    } else if (detectFeeSurprise(text)
        && ['closing', 'property_query', 'presentation', 'discovery', 'intent', 'idle'].includes(before)
        && !detectFeeWhy(text)
        && !detectFeeComplaint(text)) {
      // FSM-leg mirror of the FEE_SURPRISE fast interceptor (the 08:32 bug):
      // the fee-surprise reaction ("OVA E NESTO NOVO ?") reached the FSM when a
      // boundary-macro bug made detectLocationConfirm claim it ("NOVO ?" read
      // as "vo … ?"). The classifier then tagged INTERESTED and re-disclosed
      // the fee.ask — answering "is this new?" by repeating the fee. The
      // surprise is fee-protocol traffic: the REASONS (the time-waster filter),
      // never a second disclosure. Same state gate as the fast interceptor
      // (closing-only there; FSM leg adds the pre-closing contexts because the
      // classifier may have moved us here mid-funnel).
      reply = pickVariant('fee.why', { recent: assistantTexts(session) }) ?? buildFeeWhy();
      bankKey = 'fee.why';
    } else if (detectFeeComplaint(text)
        && before === 'closing'
        && !detectFeeWhy(text)) {
      // Price complaints about the viewing fee ("500 денари за посета?", "скупо",
      // "50 станови за 25000 ден") — the client is questioning value, NOT refusing.
      // Answer with the agency rationale (fee.why: the fee is a filter for real
      // clients, symbolic for serious ones) instead of burning a refusal rung
      // and eventually pivoting to property dumping. The fee.why bank key covers
      // this — it explains WHY the fee exists, then re-asks for agreement so the
      // funnel keeps moving. WITHOUT this check, a price complaint would be
      // classified as FEE_REFUSED, increment the refusal counter, and on the 2nd+
      // refusal dump alternative properties — abandoning the fee discussion
      // instead of answering the client's actual concern.
      reply = pickVariant('fee.why', { recent: assistantTexts(session) }) ?? buildFeeWhy();
      bankKey = 'fee.why';
    } else if ((next === 'closing')
        && ev.type === 'FEE_REFUSED') {
      // FEE RESISTANCE — THE LADDER (feeLadder, prompts.ts):
      //   1st pushback → ONE persuasion (value framing, the declared market)
      //   2nd pushback → the AGENCY RULE (the fee is in our published price list)
      //   3rd pushback → THE DECISION (book under these conditions, or not)
      //   4th pushback → 'queued' (already set above) → the bye protocol
      // The old deep-persuasion rungs and the neighborhood PIVOT are gone:
      // offering other neighborhoods to a client who is fighting the FEE only
      // restarts the same fight on a new property. The decision question is
      // what ends the loop — yes moves to contact collection, no closes the
      // chat gracefully (fee.graceful.close).
      // Property backfill (the [09:0x] bug): no declared market anywhere →
      // the property on the table IS the market; the 300-vs-500 rungs must
      // never quote the wrong script.
      if (!session.slots.service) session.slots.service = props[0]?.service;
      const rejections = session.slots.feeRejections ?? 1;
      const rung = feeLadder(session.slots.service, rejections);
      reply = pickVariant(rung.key, { recent: assistantTexts(session) }) ?? rung.line;
      bankKey = rung.key;
    } else if ((next === 'closing' || session.state === 'closing')
        && !session.slots.viewingFeeAgreed
        && detectFeeChargePushback(text)) {
      // CHARGE ACCUSATION FSM-leg mirror ("PARI ZA POSETA BARATE" — the [00:27]
      // TUI capture): the client objects to PAYING for the visit at all. Not a
      // why-question (nothing to explain) and not a refusal with a payment
      // object — it is the FIRST resistance rung, so she PERSUADES ONCE
      // (value framing) instead of re-disclosing the fee. Without this lane
      // the classifier read the accusation as INTERESTED and served the
      // fee.ask again.
      if (!session.slots.service) session.slots.service = props[0]?.service;
      session.slots.feeRejections = (session.slots.feeRejections ?? 0) + 1;
      if ((session.slots.feeRejections ?? 0) >= 4) {
        // The decision question was asked and not accepted — the bye protocol.
        next = 'queued';
        session.state = 'queued';
        this.queueCustomer(session, '3x одбиен надомест');
        reply = pickVariant('fee.graceful.close', { recent: assistantTexts(session) }) ?? FEE_GRACEFUL_CLOSE;
        bankKey = 'fee.graceful.close';
      } else {
        const rung = feeLadder(session.slots.service, session.slots.feeRejections ?? 1);
        reply = pickVariant(rung.key, { recent: assistantTexts(session) }) ?? rung.line;
        bankKey = rung.key;
      }
    } else if (detectFeeFirstTime(text)
        && ['closing', 'property_query', 'presentation', 'discovery', 'intent', 'idle'].includes(before)) {
      // FIRST TIME HEARING IT ("OVA PRV PAT SLUSAM" — the [00:28] TUI capture):
      // the client is not asking WHY the fee exists, he is saying he never met
      // it before. The answer he needs is the FACT, not another filter
      // rationale: it is the agency's standing rule, it is in our price list
      // and it is the same for every client. Explanation traffic — no rung
      // burned; the funnel stays at the fee question.
      reply = pickVariant('fee.rule.hold', { recent: assistantTexts(session) }) ?? buildFeeRule();
      bankKey = 'fee.rule.hold';
    } else if (ev.type === 'REJECTED' && ['idle', 'intent', 'discovery'].includes(before)) {
      // The client denies the current direction ("не барам стан", "нешто
      // друго") before anything was shown — pivot to what they DO want
      // instead of re-asking the same discovery question.
      reply = DIRECTION_PIVOT_LINE;
    } else if (next === 'visit_scheduling') {
      // An agency-hours question ("rabotite vo nedela?") gets ANSWERED, not
      // another time re-ask — the client asked something concrete first.
      if (detectWorkdaysQuestion(text)) {
        reply = pickVariant('workdays.question', { recent: assistantTexts(session) })
          ?? 'Агенцијата работи од понеделник до петок, од 09:00 до 17:00 часот. Посетите се организираат во работните денови; сабота и недела не работиме.';
        bankKey = 'workdays.question';
      } else {
        reply = VISIT_TIME_QUESTION;
      }
    } else if (next === 'owner_checking') {
      const eb = session.slots.interestedPropertyId ?? session.slots.propertyId ?? 0;
      const t = session.slots.visitTime ?? '';
      // Vague time guard: "попладне", "после 5", "pred 17:00" etc. are valid
      // time intentions but too imprecise for the owner — stay in visit_scheduling
      // and ask for the exact clock before proceeding.
      if (t && detectVagueTime(t)) {
        session.state = 'visit_scheduling';
        next = 'visit_scheduling';
        reply = pickVariant('vague.time', { recent: assistantTexts(session) })
          ?? 'Може ли да ми кажете точно во колку часот? Така ќе можам да го договорам терминот со сопственикот.';
        bankKey = 'vague.time';
      } else if (t && hasDayWord(t) && !hasClockHint(t) && !hasPeriodHint(t) && detectVisitTime(text)) {
        // DAY-ONLY SPLIT INTAKE (the [14:35] transcript): "VO PONEDELNIK MOZAM"
        // alone names a day but no clock — handing THAT to the owner forces the
        // owner to guess the hour. Arm the day as context (slot keeps the raw
        // phrase) and ask for the exact clock; the follow-up ("6 SAAT") then
        // completes the pair through the owner_checking completion path.
        session.state = 'visit_scheduling';
        next = 'visit_scheduling';
        reply = pickVariant('vague.time', { recent: assistantTexts(session) })
          ?? 'Може ли да ми кажете точно во колку часот? Така ќе можам да го договорам терминот со сопственикот.';
        bankKey = 'vague.time';
      } else if (before === 'owner_checking' && ev.type === 'TIME_REJECTED') {
        // The client can't do the proposed time ("не можам во 18:00", "може
        // покасно?") — collect a NEW concrete time instead of keeping the owner
        // check on a time the client already rejected.
        session.state = 'visit_scheduling';
        reply = VISIT_TIME_QUESTION;
      } else if (before === 'owner_checking' && ev.type === 'VISIT_TIME_PROVIDED') {
        // The client changed the proposed time mid-check — re-ask the owner
        // with the NEW time (the ping-pong continues with the new proposal).
        // Same combined shape as the transition arm: a riding meeting-spot
        // ask gets the reveal-protocol answer next to the ACK.
        reply = detectMeetingSpotAsk(text)
          ? `${OWNER_CHECK_ACK} ${buildExactAddressAnswer(assistantTexts(session))}`
          : OWNER_CHECK_ACK;
        if (eb && t) void this.runOwnerCheck(session, eb, t);
      } else if (before === 'owner_checking') {
        // Bank-backed: patience variants rotate, never the same sentence twice.
        reply = pickVariant('patience.line', { recent: assistantTexts(session) }) ?? PATIENCE_LINE;
        bankKey = 'patience.line';
      } else {
        // First transition into owner_checking. A time completion that ALSO
        // asks where the two of them will wait (the [01:07] capture: «MOZAM VO
        // 5\nNAKOE MESTO BI SE CEKALE ?») is answered with the location-reveal
        // protocol — the pure ACK left the client's question hanging and the
        // chat stalled there. (a pure spot ask mid-scheduling rides the
        // address lanes upstream; only the COMBINED shape needs this.)
        reply = detectMeetingSpotAsk(text)
          ? `${OWNER_CHECK_ACK} ${buildExactAddressAnswer(assistantTexts(session))}`
          : OWNER_CHECK_ACK;
        if (eb && t) void this.runOwnerCheck(session, eb, t);
      }
    } else if (next === 'escalated') {
      reply = fallbackVariant('escalated', assistantTexts(session))
        ?? FALLBACKS.escalated ?? 'Ќе Ве контактира менаџер.';
    } else if (session.state === 'owner_checking') {
      // An agency-hours question ("VO NEDELA RABOTITE?") must be ANSWERED
      // even while the owner check is in flight — the patience line alone
      // ignores the client's question entirely.
      if (detectWorkdaysQuestion(text)) {
        reply = pickVariant('workdays.question', { recent: assistantTexts(session) })
          ?? 'Агенцијата работи од понеделник до петок, од 09:00 до 17:00 часот. Посетите се организираат во работните денови; сабота и недела не работиме.';
        bankKey = 'workdays.question';
      } else {
        // client wrote while the owner check is in flight — bank-backed patience line
        reply = pickVariant('patience.line', { recent: assistantTexts(session) }) ?? PATIENCE_LINE;
        bankKey = 'patience.line';
      }
    } else if (session.state === 'queued') {
      reply = QUEUED_STAY_LINE;
    } else if (detectPriceAsk(text) && !detectBudget(text)
        && !detectProvisionAsk(text) && !detectProvisionWho(text)
        && !detectDrugAlternative(text)
        && !isFeeTraffic(text)) {
      // Price question: the client asks "која е цената?" / "колку чини?"
      // or "не ја памтам цената" (I forgot the price).
      // BUDGET GUARD (the [09:38] expansion, fast-leg mirror at ~'PRICE_ASK:fast'):
      // detectPriceAsk also matches "ОКОЛУ 400 ЕВРА МЕСЕЧНО БЕШЕ" (it contains
      // «евра») — that is a remembered PRICE STATEMENT feeding the search,
      // never a question about an EB. Without the guard this branch asked the
      // EB invite "За кое конкретно станува збор?" while the slot extractor
      // had ALREADY stored the 400 budget — she asked for a number the client
      // cannot give, mid-funnel, ignoring the search she was collecting.
      // Look up the most recently discussed property from the feed and show
      // MENTION BINDING first (the 12:33 rule, one family over): a property
      // named by anything ("garsonjerata", "a 63", "ovoj od 99000") beats the
      // last-shown slot. No binding signal → the legacy slot chain
      // (current → interested → presentedIds[last]). An ambiguous mention asks
      // back once via the clarify line (sent by the normal tail below).
      const mbPrice = await this.bindMention(text, session);
      if (mbPrice?.clarify) {
        reply = mbPrice.clarify;
      } else {
      const priceEb = mbPrice?.prop?.eb
        ?? inferPropertyId(text)
        ?? session.slots.propertyId
        ?? session.slots.interestedPropertyId
        ?? (session.slots.presentedIds?.length ? session.slots.presentedIds[session.slots.presentedIds.length - 1] : undefined);
      if (priceEb) {
        const p = mbPrice?.prop ?? await this.deps.properties.getById(priceEb);
        if (p?.price !== undefined) {
          // Strip "(населба)" suffix — internal feed disambiguator, not spoken language
          const priceLoc = p.location?.replace(/\s*\([^)]*\)\s*$/, '') ?? '';
          const priceType = p.house ? 'Куќата' : p.business ? 'Деловниот простор' : 'Станот';
          const pricePrep = priceLoc ? locPrep(priceLoc) : 'во';
          // Rent-aware wording (the [22:53] contract), mirroring the fast lane.
          const isRentP = (p.service ?? session.slots.service) === 'rent';
          reply = isRentP
            ? `${priceType} со Евидентен број ${p.eb}${priceLoc ? ` ${pricePrep} ${priceLoc}` : ''} — киријата изнесува ${p.price.toLocaleString('mk-MK')} евра.`
            : `${priceType} со Евидентен број ${p.eb}${priceLoc ? ` ${pricePrep} ${priceLoc}` : ''} чини ${p.price.toLocaleString('mk-MK')} евра.`;
          session.slots.lastPrice = String(p.price);
        } else {
          // Price-less feed row: the “price” here IS the viewing fee — serve
          // the fee.ask for the PROPERTY'S OWN service. A rental must never
          // get the buy fee (audit fix; previously hardcoded 'fee.ask.buy').
          const psvc = p?.service ?? session.slots.service ?? 'buy';
          reply = pickVariant(psvc === 'rent' ? 'fee.ask.rent' : 'fee.ask.buy', { recent: assistantTexts(session) }) ?? 'Цената ја одредува сопственикот. Дали сакате да го контактирам за да го пренесам Вашето прашање за цената?';
        }
      } else {
        reply = 'За кое конкретно станува збор? Кажете ми Евидентен број и ќе Ви ја соопштам цената.';
      }
      }
    } else if (detectInvestmentOpinion(text)) {
      // Investment/market opinion: the client expresses doubt about prices,
      // investment viability, or market conditions. This is a digression from
      // the funnel — the LLM would misunderstand it as visit interest and
      // generate a fee disclosure. Instead, respond with a bank-backed redirect
      // that acknowledges the concern and steers back to the funnel.
      reply = pickVariant('investment.opinion', { recent: assistantTexts(session) })
        ?? 'Разбирам. Цените ги одредуваат сопствениците, а ние сме само посредници. Дали сакате да Ви понудам некои опции во друг реон, или да го контактирам сопственикот за моменталната цена?';
      bankKey = 'investment.opinion';
    } else if (before === 'closing'
        && next === 'closing'
        && detectVisitInterest(text)
        && (session.slots.viewingFeeAgreed || session.slots.ownerContactPending
          || (session.slots.feeRejections ?? 0) >= 1)
        && !detectAvailabilityAsk(text)
        && !detectVisitTimingQuestion(text) // a timing QUESTION is not the confirmation — its own lane owns it (the [19:56] rule)
        && !detectFeePaymentAgreement(text) && !detectInvestmentOpinion(text)
        && !detectFeeWhy(text) && !detectFeeComplaint(text) && !detectFeeSurprise(text)
        && !detectCheaperSearch(text) && !detectRemark(text)) {
      // Visit COMMAND in closing: "AKO E TAKA TOGAS DOGOVORI MI" (21:05) —
      // the client orders the visit. The original visit-interest branch skips
      // closing-state entry (its before-guard is pre-closing only), the
      // agreement catch-all needs a 'да/добро' token ('dogovori mi' has none),
      // and the location.confirm branch (no event guard) then swallowed the
      // message via its 'togas' marker — answering a visit order with a
      // neighborhood confirmation. Two sub-cases:
      //  - fee talk ALREADY happened (agreed, or a refusal/persuasion/why
      //    round was spent — the 21:04–21:05 transcript): this order IS the
      //    acceptance → close the funnel NOW: contact collection for name+phone
      //    (the tail serves the deterministic contact ask), i.e. straight
      //    toward the owner ping-pong.
      //  - fee NOT yet disclosed (ownerContactPending from the availability
      //    ack or the enthusiasm offer): the command doubles as the
      //    confirmation → disclose the fee first (same contract as the
      //    agreement gate below), never skip it.
      const feeHandled = !!session.slots.viewingFeeAgreed || (session.slots.feeRejections ?? 0) >= 1;
      if (feeHandled) {
        session.slots.ownerContactPending = false;
        session.slots.viewingFeeAgreed = true;
        session.state = 'contact_collection';
        next = 'contact_collection';
        reply = pickVariant('visit.scheduled', { recent: assistantTexts(session) })
          ?? 'Одлично! Ќе организирам посета — последниве информации и закажуваме.';
        bankKey = 'visit.scheduled';
      } else {
        session.slots.ownerContactPending = false;
        session.state = 'closing';
        next = 'closing';
        const service = session.slots.service ?? props[0]?.service ?? 'buy';
        reply = pickVariant(service === 'rent' ? 'fee.ask.rent' : 'fee.ask.buy', { recent: assistantTexts(session) })
          ?? buildFeeAsk(service);
        bankKey = service === 'rent' ? 'fee.ask.rent' : 'fee.ask.buy';
      }
    } else if (detectLocationConfirm(text)
        && (before === 'property_query' || before === 'presentation' || before === 'closing' || before === 'property_locate')
        && session.slots.location
        && (session.slots.propertyId || session.slots.interestedPropertyId || session.slots.presentedIds?.length)
        // Search criteria in the same message ("znaci sakam stan vo vodno do
        // 300") = a real request, never a confirmation
        && !detectBudget(text) && !detectService(text) && !detectBothServices(text)
        && !detectHouse(text) && !detectBusiness(text)
        // "VO CENTAR IMA NESTO?" (21:16) — an AREA SEARCH, not a question
        // about the discussed property's area. The "има нешто" probe
        // (detectAreaHaveAsk) means "do you HAVE anything in X" — it must
        // pivot the search to X, never answer "Не, станот 41 се наоѓа во
        // Ѓорче Петров" about a property the client just asked to leave.
        && !detectAreaHaveAsk(text)
        // "koja adresa ima 88. ?" (V16K11 live) — an EXACT-address ask, not a
        // neighborhood confirmation; it must ride the address ladder (turn 1
        // landmark → privacy protocol), never the neighborhood-only confirm.
        && !detectExactAddressAsk(text)
        // FE AGREEMENT IS NEVER AN AREA CONFIRM (the [01:28] TUI capture):
        // "ШТОМ ТАКА МОРА , ЗАКАЖИ" in closing is the fee acceptance (the
        // classifier said FEE_AGREED and the FSM moved the session to
        // contact_collection) — but the bare "така" marker inside made this
        // branch swallow it: the funnel was yanked BACK to closing and the
        // client got "Точно, Станот со Евидентен број 82 се наоѓа во
        // Аеродром…" instead of the name+phone ask. A turn the classifier
        // (or the agreement detectors) already consented to the fee owns the
        // funnel; contact collection must run, never the neighborhood echo.
        && ev.type !== 'FEE_AGREED' && !detectFeePaymentAgreement(text)) {
      // Location confirmation about the property under discussion — "ZNACI NA
      // VODNO E" (21:27). The client draws a conclusion about WHERE the
      // discussed property is; Lina must CONFIRM or CORRECT against the
      // property's actual feed location. Never a re-search: the old behavior
      // parsed the named neighborhood as a fresh request and answered "немам
      // слободна недвижност во Водно" about a property that IS in Водно — stupid.
      const isQuestion = !isLocationConfirmMarker(text);
      // MENTION BINDING (12:33 rule): a confirm that NAMES the property
      // ("znaci garsonjerata kaj ambasadata e vo centar?") anchors on THAT
      // property, never on the stale slot. A mention IS an explicit anchor,
      // so it satisfies the tight-anchor rule for bare questions too.
      const mbConf = await this.bindMention(text, session);
      if (await this.sendIfClarify(mbConf, text, session)) return;
      const confEb = mbConf?.prop?.eb ?? session.slots.propertyId ?? session.slots.interestedPropertyId
        ?? (session.slots.presentedIds?.length ? session.slots.presentedIds[session.slots.presentedIds.length - 1] : undefined);
      // Bare questions ("vo vodno li e?") have no znaci-marker to prove intent,
      // so they require a TIGHT anchor: an explicitly identified property.
      const anchor = isQuestion
        ? (mbConf?.prop?.eb ?? session.slots.propertyId ?? session.slots.interestedPropertyId)
        : confEb;
      const confProp = anchor != null
        ? await this.deps.properties.getById(anchor).catch(() => undefined)
        : undefined;
      // [22:2x] PERSIST the anchoring EB: the turn THAT names the property
      // (mention/explicit number) is an explicit anchor, and leaving it
      // unbound stranded every later "it" on the stale batch tail — the
      // confirm for EB 44 ran, then "koja i bese cenata uste ednas?" quoted
      // the price of the property presented before 44. Only an EXPLICIT anchor
      // persists; a fallback anchor stays fallback, as before.
      const explicitConfirmAnchor = mbConf?.prop?.eb ?? inferPropertyId(text);
      if (confProp && explicitConfirmAnchor != null) {
        session.slots.propertyId = explicitConfirmAnchor;
        if (session.slots.interestedPropertyId == null) session.slots.interestedPropertyId = explicitConfirmAnchor;
      }
      if (confProp?.location) {
        // Strip "(населба)" feed disambiguator — internal, not spoken language
        const actualLoc = confProp.location.replace(/\s*\([^)]*\)\s*$/, '');
        const namedLoc = session.slots.location;
        const agree = locMatches(namedLoc, confProp.location) || locMatches(actualLoc, namedLoc);
        const confType = confProp.house ? 'Куќата' : confProp.business ? 'Деловниот простор' : 'Станот';
        // NA/VO agreement: Водно is a mountain — "на Водно"; everywhere else "во"
        const prep = locPrep(actualLoc);
        // Anchor the context: the discussion is about this property's area now
        session.slots.location = actualLoc;
        reply = agree
          ? `Точно, ${confType} со Евидентен број ${confProp.eb} се наоѓа ${prep} ${actualLoc}. Дали сакате да организираме посета за да го погледнете?`
          : `Не, ${confType} со Евидентен број ${confProp.eb} всушност се наоѓа ${prep} ${actualLoc}. Дали сакате да организираме посета за да го погледнете?`;
        bankKey = 'location.confirm';
        // A confirmation is not a transition — stay in the current state
        session.state = before;
        next = before;
      }
      // No property context/location -> fall through IN THIS BRANCH (the
      // [13:48] hole): a question-form confirm with NO anchor left `reply`
      // empty and the epilogue SENT the abortive empty string. The same-branch
      // fallback serves the presentation the way the re-present lane does; an
      // empty pool gets the honest no-match line with the area named — never
      // a silent discard.
      if (!confProp?.location) {
        if (props.length > 0) {
          reply = buildPropertyCards(props, 'presentation', session.history.length,
            assistantTexts(session), { anywhere: session.slots.anywhere, budget: session.slots.budget });
        } else {
          session.slots.areaExhausted = true;
          reply = !this.deps.properties.healthy
            ? FEED_UNAVAILABLE_LINE
            : noMatchLine(session.slots.location, assistantTexts(session))
              ?? NO_MATCH_LINE(session.slots.location);
        }
      }
    } else if (next === 'presentation' && props.length === 0
        && !detectInvestmentOpinion(text)
        && !detectProvisionAsk(text) && !detectProvisionWho(text)) {
      // Deterministic empty-result lines — never let the LLM invent properties.
      // A search that names an area but has nothing there -> honest no-match;
      // follow-up rejections after every candidate was shown -> "exhausted" line.
      // Investment/market opinions are NOT rejections — they fall through to the
      // LLM for a contextual response.
      // Either way the area lock is marked drained: the client's next pure
      // agreement widens the search to the rest of the city (options come only
      // AFTER the ask), while register/contact intents go to the queue.
      // The exhausted line is bank-backed (exhausted.location/plain) so the
      // widen question varies like the other protocol lines; the code-built
      // line stays the fallback.
      session.slots.areaExhausted = true;
      const typedMiss = typedNoMatchLine(session.slots);
      reply = !this.deps.properties.healthy
        ? FEED_UNAVAILABLE_LINE
        : typedMiss
          ?? (before === 'discovery' || areaRequested
            ? noMatchLine(session.slots.location ?? ev.location, assistantTexts(session))
              ?? NO_MATCH_LINE(session.slots.location ?? ev.location)
            : exhaustedLine(session.slots.location, assistantTexts(session))
              ?? NO_MORE_ALTERNATIVES_LINE(session.slots.location));
    // PENDING-VISIT CONFIRM (the [13:28] multi-question capture): Lina just
    // answered a fact question WITH the re-confirm ("Дали сè уште сте
    // заинтересирани за посета?"). A bare "да" now means YES TO THE VISIT —
    // it must NOT re-serve the card; it opens the fee protocol, exactly
    // like the visit-interest lane. A refusal clears the pending confirm
    // and the flow continues to the normal lanes below.
    } else if (session.slots.pendingVisitConfirm === true
        && !detectAgreement(text)
        && (detectRejection(text) || detectNegatedAgreement(text) || detectSoftRefusal(text))) {
      session.slots.pendingVisitConfirm = undefined;
    } else if (session.slots.pendingVisitConfirm === true
        && detectAgreement(text)
        && !detectNegatedAgreement(text) // "da, ama ne za ovoj" is not visit consent
        && !session.slots.ownerContactPending // the availability-ack lane owns those turns
        && !session.slots.viewingFeeAgreed) {
      session.slots.pendingVisitConfirm = undefined;
      session.state = 'closing';
      next = 'closing';
      session.slots.feeRejections = undefined;
      const svc = session.slots.service ?? props[0]?.service ?? 'buy';
      reply = pickVariant(svc === 'rent' ? 'fee.ask.rent' : 'fee.ask.buy', { recent: assistantTexts(session) })
        ?? buildFeeAsk(svc);
      bankKey = svc === 'rent' ? 'fee.ask.rent' : 'fee.ask.buy';
    } else if (next === 'property_query' && props.length > 0
        && !detectAvailabilityAsk(text)
        // A POSITIVE evaluation of the card ("OVOJ 79 NE E LOS", "odlichen")
        // must NEVER re-render the full card — the [14:22] transcript served
        // the identical text three times in a row. The property_query branch
        // below handles QUESTIONS (price/feature/availability); the fast
        // property.liked interceptor already owns the praise shapes in
        // property states. Excluded here as belt-and-braces so a guard slip
        // can never resurrect the re-render.
        && !detectPositiveEval(text)
        && !detectProvisionAsk(text) && !detectProvisionWho(text)
        && !session.slots.ownerContactPending) {
      // The client asked about a known EB ("кажи ми нешто за 57", "што е со
      // 62?"): show the property card deterministically. No LLM needed — the
      // card is code-built with all the property details + landmark.
      // Availability asks ("дали е сеуште достапен?") are excluded — they
      // route to the closing/fee path below. Also excluded when
      // ownerContactPending ("да" after availability ack) — the agreement
      // handler below shows the fee instead of re-showing the card.
      // Eye-catch phrasing ("mi fati oko 94", "ми фати окото") — the client
      // saw the ad and the number IS the EB: answer with the enthusiasm ack
      // + visit offer (bank-backed 'property.liked' variants), NOT the full
      // card. Landmarks are pre-resolved so an immediate "каде се наоѓа?"
      // rotates correctly.
      if (detectEyeCatch(text)) {
        session.slots.interestedPropertyId = props[0].eb;
        session.slots.ownerContactPending = true;
        session.state = 'closing';
        if (!session.slots.nearbyLandmarks?.length) {
          const nearby = this.landmarks.nearbyLandmarks(props[0]);
          if (nearby.length > 0) {
            session.slots.nearbyLandmarks = nearby.map(n => n.landmark);
            session.slots.nearbyLandmarkCoords = nearby.map(n => ({ lat: n.lat, lon: n.lon }));
            session.slots.nearbyLandmarkEb = props[0].eb;
            session.slots.landmarkIndex = 0;
            session.slots.lastLandmark = undefined;
          }
        }
        reply = pickVariant('property.liked', { recent: assistantTexts(session) })
          ?? 'Одличен избор! Дали би сакале да организирам посета, за да го погледнете во живо?';
        bankKey = 'property.liked';
      } else {
        reply = buildPropertyCard(props[0]);
      }
      // Pre-resolve top-3 nearby landmarks for rotation ("каде?" → first,
      // "каде поточно?" → second, …) + Google Maps links. Cached on the
      // session so repeated asks don't re-geocode.
      if (!session.slots.nearbyLandmarks?.length && props[0]) {
        const nearby = this.landmarks.nearbyLandmarks(props[0]);
        if (nearby.length > 0) {
          session.slots.nearbyLandmarks = nearby.map(n => n.landmark);
          session.slots.nearbyLandmarkCoords = nearby.map(n => ({ lat: n.lat, lon: n.lon }));
          session.slots.nearbyLandmarkEb = props[0].eb;
          session.slots.landmarkIndex = 0;
          session.slots.lastLandmark = undefined;
        }
      }
    } else if (next === 'property_query' && props.length === 0) {
      // The EB doesn't exist. The not-found line itself asks whether the
      // client wants similar properties from other locations — an agreement
      // ("да") or an alternatives request ("predlozi mi", "drugi lokaciii")
      // must PIVOT to a REAL city-wide presentation instead of repeating the
      // not-found line forever (the stuck loop: every follow-up re-rendered
      // "не можам да ја најдам недвижноста со Евидентен број 250"). The bad EB is
      // cleared so a later INTERESTED ("sakam da ja vidam") never grabs it.
      const pivot = detectAgreement(text) || detectSuggestAlternatives(text);
      if (pivot && this.deps.properties.healthy) {
        session.slots.propertyId = undefined;
        session.state = 'presentation';
        props = await this.loadProps(session, false, false);
      }
      if (props.length > 0) {
        // Type-aware relaxed intro (19:34): garsonjera gets a garsonjera line;
        // спални labels speak ROOMS-1 (slots store room count: "2 спални" → 3).
        const requestedBeds = session.slots.bedrooms;
        // RANGE ([09:17]): the pool is exact 2…3 rooms — never the relaxed intro.
        const rangeActive = session.slots.bedroomsAlt && session.slots.bedroomsMin !== undefined && session.slots.bedroomsMax !== undefined;
        const exactMatch = requestedBeds ? props.some(p => p.bedrooms === requestedBeds) : true;
        const garsonjeraNoExact = session.slots.garsonjera
          && !props.some(p => /гарсоњер|garsonjer|студио|studio/i.test(p.details ?? ''));
        let prefix = '';
        if (garsonjeraNoExact) {
          prefix = relaxedCategoryLine(true, undefined, session.slots.location, assistantTexts(session)) ?? '';
        } else if (rangeActive) {
          // Range pool: every card is an exact-category match — no relaxed intro.
        } else if (requestedBeds && !exactMatch) {
          const spokenRooms = requestedBeds - 1;
          const requestedLabel = spokenRooms === 1 ? 'една спална'
            : spokenRooms === 2 ? 'две спални'
            : `${spokenRooms} спални`;
          const hasBigger = props.some(p => p.bedrooms && p.bedrooms > requestedBeds);
          const hasSmaller = props.some(p => p.bedrooms && p.bedrooms < requestedBeds);
          if (hasBigger && !hasSmaller) {
            prefix = `Во моментов нема стан со ${requestedLabel} во ${session.slots.location ?? 'оваа населба'} во Вашата цена, но има поголеми станови кои би можеле да Ви одговараат. `;
          } else if (hasSmaller && !hasBigger) {
            prefix = `Во моментов нема стан со ${requestedLabel} во ${session.slots.location ?? 'оваа населба'} во Вашата цена, но има помали станови кои би можеле да Ви одговараат. `;
          } else {
            prefix = `Во моментов нема стан со ${requestedLabel} во ${session.slots.location ?? 'оваа населба'} во Вашата цена, но има слични опции кои би можеле да Ви се допаднат. `;
          }
        }
        const cards = buildPropertyCards(props, 'presentation', session.history.length,
          assistantTexts(session), { anywhere: session.slots.anywhere, budget: session.slots.budget, noOpener: !!prefix });
        reply = prefix ? `${prefix.trimEnd()}\n\n${cards}` : cards;
      } else {
        // FEED-DOWN GUARD: healthy=false means a failed fetch with NO cache —
        // we cannot know whether the EB is gone. Serve the outage line and
        // preserve the anchor; ghost cleanup is a healthy-feed verdict only.
        if (!this.deps.properties.healthy) {
          reply = FEED_UNAVAILABLE_LINE;
          session.state = before;
        } else {
          reply = (session.slots.propertyId != null
            ? (pickVariant('property.notfound', { recent: assistantTexts(session), vars: { eb: String(session.slots.propertyId) } })
              ?? PROPERTY_NOT_FOUND_LINE(session.slots.propertyId))
            : NO_MATCH_LINE(session.slots.location));
          if (session.slots.propertyId != null) bankKey = 'property.notfound';
          // GHOST CLEANUP (P4 follow-up): the EB-miss lane must not leave the
          // poisoned anchor armed — a later availability/praise turn would
          // re-anchor the funnel on the ghost (the EB-999 sequence).
          const missedEb = session.slots.propertyId; // capture BEFORE clearing
          session.slots.propertyId = undefined;
          session.slots.interestedPropertyId = undefined;
          if (missedEb != null) session.slots.lastGhostEb = missedEb;
          if (session.state === 'closing' && missedEb != null) session.state = before;
        }
      }
    } else if (detectAvailabilityAsk(text)
      && (next === 'property_query' || next === 'closing')
      && session.slots.ownerContactPending
      && detectSendToOwnerAsk(text)
      && (session.slots.propertyId ?? session.slots.interestedPropertyId ?? props[0]?.eb)) {
      // CONFIRM-ARROW STEP-UP (the [18:59] field capture): "prasaj\nako e
      // slobodna i ako e dobra ke ja iznajmam" enters as ONE combined turn
      // (the typing-window merge in both the TUI and the relay), and the
      // accessibility-ack arm below read the bundle as a FRESH availability
      // question — re-animating the permission ask the same turn's arrow
      // half just answered. The client is confirming the pending ack, not
      // re-asking: this is exactly the AGREEMENT serve (same contract as
      // the 'да' consent arm below) — disclose the fee, downstay in closing.
      next = 'closing';
      session.state = 'closing';
      session.slots.ownerContactPending = false;
      const arrowService = session.slots.service ?? props[0]?.service ?? 'buy';
      reply = pickVariant(arrowService === 'rent' ? 'fee.ask.rent' : 'fee.ask.buy', { recent: assistantTexts(session) })
        ?? buildFeeAsk(arrowService);
      bankKey = arrowService === 'rent' ? 'fee.ask.rent' : 'fee.ask.buy';
    } else if (detectAvailabilityAsk(text)
      && (next === 'property_query' || next === 'closing')
      && (session.slots.propertyId ?? session.slots.interestedPropertyId ?? props[0]?.eb)) {
      // Availability question about a KNOWN property ("дали е сеуште достапен?",
      // "dali e seuste dostapen?"): the client saw the ad on the website and
      // knows the details — Lina does NOT re-describe it. She answers that it
      // should still be available and ASKS if the client wants her to contact
      // the owner. The fee is NOT disclosed yet — it comes AFTER the client
      // confirms they want to proceed. The ack is bank-backed (varied), with
      // the code-built line as fallback.
      // MENTION BINDING (12:33): "dali e dostapna garsonjerata?" — the ask
      // names a property; availability is answered for THAT one.
      const mb = await this.bindMention(text, session);
      if (await this.sendIfClarify(mb, text, session)) return;
      const anchorEb = session.slots.propertyId ?? session.slots.interestedPropertyId;
      const anchored = mb?.prop
        ?? (anchorEb != null ? props.find(p => p.eb === anchorEb) : undefined);
      // GHOST GUARD (P4 follow-up): an anchored EB (named via mention or the
      // slot) that the feed cannot resolve is GONE — props[0] is legal ONLY
      // when there is no anchor at all (availability about the property on
      // the table). getById is the feed-authoritative rescue: a real
      // property outside the current batch is NOT a ghost. Claiming "сè уште
      // е достапен" about a ghost and arming ownerContactPending leads
      // straight to the fee for a property that does not exist (the EB-999
      // probe). Honest not-found pivot instead.
      const target = anchored
        ?? (anchorEb != null
          ? await this.deps.properties.getById(anchorEb).catch(() => undefined)
          : props[0]);
      if (!target) {
        // FEED-DOWN GUARD: with zero data the miss may be the outage —
        // the outage line is the honest answer, no ghost branding.
        if (!this.feedHealthy()) {
          reply = FEED_UNAVAILABLE_LINE;
          bankKey = undefined;
          // The FSM may have already advanced the session toward closing on
          // this event — REVERT it: a feed-down turn must not move the funnel
          // (the next message would hit the closing catch-alls).
          session.state = before;
        } else {
          const ghostEb = anchorEb ?? 0; // 0 only on an unreachable path (branch guard requires some eb)
          reply = pickVariant('property.notfound', { recent: assistantTexts(session), vars: { eb: String(ghostEb) } })
            ?? PROPERTY_NOT_FOUND_LINE(ghostEb);
          bankKey = 'property.notfound';
          // Poisoned-anchor cleanup (same precedent as the suggest-alternatives
          // pivot): a ghost anchor must never re-arm the funnel on a later turn.
          // The FSM already moved the session to closing on the availability
          // event — REVERT it: a ghost must not drag the funnel to closing
          // (the next message would hit the fee catch-all for a ghost).
          // lastGhostEb REMEMBERS the topic so where-is follow-ups still name
          // it (the where-stuck fix) — it never re-arms anything.
          session.slots.propertyId = undefined;
          session.slots.interestedPropertyId = undefined;
          session.slots.lastGhostEb = ghostEb;
          session.state = before;
        }
      } else {
        const eb = target.eb; // else-branch: anchored match, or unanchored props[0]
        session.state = 'closing';
        session.slots.interestedPropertyId = eb;
        session.slots.ownerContactPending = true;
        // Pre-resolve nearby landmarks for when the client asks "каде се наоѓа?"
        if (!session.slots.nearbyLandmarks?.length && target) {
          const nearby = this.landmarks.nearbyLandmarks(target);
          if (nearby.length > 0) {
            session.slots.nearbyLandmarks = nearby.map(n => n.landmark);
            session.slots.nearbyLandmarkCoords = nearby.map(n => ({ lat: n.lat, lon: n.lon }));
            session.slots.nearbyLandmarkEb = target.eb;
            session.slots.landmarkIndex = 0;
            session.slots.lastLandmark = undefined;
          }
        }
        // GENDER-AGREED ACK (the [00:49] "ЕВИДЕНТЕН БРОЈ 47" capture): the
        // bank pool is written for the feminine noun ("недвижноста …
        // достапна") and stays for куќа/гарсоњера asks. Every other type —
        // стан, плац, деловен простор, and the EB-number frame itself (an
        // ask BY number points at a masculine noun) — takes the code-built
        // masculine line; serving "достапна" after "ЕВИДЕНТЕН БРОЈ 47" read
        // wrong-gender.
        bankKey = 'availability.ack';
        // NO landmark line here — location is revealed ONLY when the client
        // explicitly asks ("каде се наоѓа?"). The availability ack is just
        // about contacting the owner. The answer itself (with the cold-read
        // IDENTITY line when this chat has never named the flat) is built in
        // one place — see availabilityReply.
        reply = this.availabilityReply(target, session, text);
      }
    } else if ((next === 'closing' || before === 'closing')
        && session.slots.ownerContactPending
        && detectAgreement(text)
        && !detectCheaperSearch(text)
        && !detectFeePaymentAgreement(text)) {
      // Client confirmed they WANT the owner contacted ("да" / "согласен" after
      // the availability ack). NOW disclose the fee — the client knows the
      // property, wants it checked, and the fee is the last gate before the
      // owner ping-pong starts. Override next AND state to stay in closing —
      // the fee has not been agreed yet, only the permission to contact.
      // BUT: if the client says "DOBRO KE PLATAM" (I'll pay), that's a fee
      // payment agreement — skip this block and let it reach the fee agreement
      // path below.
      next = 'closing';
      session.state = 'closing';
      session.slots.ownerContactPending = false;
      const service = session.slots.service ?? props[0]?.service ?? 'buy';
      const fee = pickVariant(service === 'rent' ? 'fee.ask.rent' : 'fee.ask.buy', { recent: assistantTexts(session) })
        ?? buildFeeAsk(service);
      reply = fee;
      bankKey = service === 'rent' ? 'fee.ask.rent' : 'fee.ask.buy';
    } else if (next === 'closing' && before === 'closing'
        && detectAgreement(text)
        && !session.slots.ownerContactPending
        && !detectCheaperSearch(text)
        && !detectVisitTimingQuestion(text) // a timing QUESTION is not the fee consent (the [19:56] rule)
        && (session.slots.viewingFeeAgreed || props[0]?.eb)) {
      // Fee already disclosed + client says "да" / "moze" / "dogovori" / etc.
      // → proceed to visit scheduling (owner contact). The fee block above set
      //   ownerContactPending=false; this catch-all moves the conversation
      //   forward instead of re-showing the fee or falling to the LLM.
      next = 'visit_scheduling';
      session.state = 'visit_scheduling';
    // NOTE: OFFTOPIC, DEFER, NEGOTIATE, PROVISION_ASK, ESCALATION,
    // DOCUMENTS_ASK, MORTGAGE_ASK, NEIGHBORHOOD_ASK, COMPARISON,
    // FEATURE_ASK, SCHEDULING_FLEX — now handled by dispatchSimple()
    // in the final else block below.  Order matters: the table in
    // router.ts SIMPLE_DETECTORS encodes the same precedence.
    } else if (next === 'presentation'
        && !detectFeeNag(text)   // a fee objection is never a criteria refinement (the [23:12] pivot)
        && (ev.type === 'DETAILS_PROVIDED' || ev.type === 'SEARCH_REQUESTED')) {
      // LLM-free: the client refined criteria mid-presentation ("една спална",
      // "гарсоњера", "во Карпош") — re-search and re-present with the
      // updated filters. When props is empty (previous search found nothing),
      // reload with the new criteria so relaxed requirements ("моќе и со
      // една спална") actually trigger a fresh search.
      // REPEAT-WIDEN ([21:26] freeze) lives in the pre-FSM widen-pivot block
      // above — the empty-presentation leg below intercepts an empty pool
      // before this leg ever sees it.
      if (props.length === 0) {
        // CRITERIA-DONE PIVOT (the [20:33] fix): the refined pool is empty
        // AFTER rows were already served and no EB anchor owns the turn —
        // the honest answer is "the matching choices are done" + the two
        // standard pivots, NEVER a junk refill of off-criteria rows and
        // never the bare no-match line loop. The builder declines (undefined)
        // when nothing was served yet (a first-ever search keeps the
        // no-match line) or fresh fit rows exist.
        const doneAsk = this.deps.properties.healthy
          && session.slots.propertyId == null
          && session.slots.interestedPropertyId == null
          ? await this.criteriaDoneAsk(session)
          : undefined;
        if (doneAsk != null) { reply = doneAsk; bankKey = 'batch.done.choice'; }
        else reply = !this.deps.properties.healthy
          ? FEED_UNAVAILABLE_LINE
          : (session.slots.propertyId != null
            ? PROPERTY_NOT_FOUND_LINE(session.slots.propertyId)
            : typedNoMatchLine(session.slots) ?? NO_MATCH_LINE(session.slots.location));
      } else {
        // The 19:34 fix: the relaxed-intro is TYPE-AWARE. Garsonjera asks get
        // a garsonjera line (never the fabricated "стан со една спална" — the
        // client named a category, not a спални count). The prefix replaces
        // the default opener (buildPropertyCards' bank intro) — "нема… еве ги
        // најблиските" followed by "Врз основа на… издвоив" read as two
        // contradictory speakers (the 19:34 transcript).
        const requestedBeds = session.slots.bedrooms;
        // RANGE ([09:17]): the pool is exact 2…3 rooms, so every card IS a
        // match — never run the bigger/smaller relaxed intro for a range.
        const rangeActive = session.slots.bedroomsAlt && session.slots.bedroomsMin !== undefined && session.slots.bedroomsMax !== undefined;
        const exactMatch = requestedBeds ? props.some(p => p.bedrooms === requestedBeds) : true;
        const rangeMatch = rangeActive || (requestedBeds === undefined
          && session.slots.bedroomsMin !== undefined && session.slots.bedroomsMax !== undefined
          && props.every(p => !p.bedrooms || (p.bedrooms >= session.slots.bedroomsMin! && p.bedrooms <= session.slots.bedroomsMax!)));
        const garsonjeraNoExact = session.slots.garsonjera
          && !props.some(p => /гарсоњер|garsonjer|студио|studio/i.test(p.details ?? ''));
        let prefix = '';
        if (garsonjeraNoExact) {
          prefix = relaxedCategoryLine(true, undefined, session.slots.location, assistantTexts(session)) ?? '';
        } else if (rangeActive) {
          // Range pool: every card is an exact-category match — no relaxed intro.
        } else if (requestedBeds && !exactMatch) {
          // Room-count convention: slots.bedrooms stores ROOMS ("2 спални" → 3).
          // The spoken label is the bedroom count: rooms-1 (3 rooms = 2 спални).
          const spokenRooms = requestedBeds - 1;
          const requestedLabel = spokenRooms === 1 ? 'една спална'
            : spokenRooms === 2 ? 'две спални'
            : `${spokenRooms} спални`;
          const hasBigger = props.some(p => p.bedrooms && p.bedrooms > requestedBeds);
          const hasSmaller = props.some(p => p.bedrooms && p.bedrooms < requestedBeds);
          if (hasBigger && !hasSmaller) {
            prefix = `Во моментов нема стан со ${requestedLabel} во ${session.slots.location ?? 'оваа населба'} во Вашата цена, но има поголеми станови кои би можеле да Ви одговараат. `;
          } else if (hasSmaller && !hasBigger) {
            prefix = `Во моментов нема стан со ${requestedLabel} во ${session.slots.location ?? 'оваа населба'} во Вашата цена, но има помали станови кои би можеле да Ви одговараат. `;        } else {
          prefix = `Во моментов нема стан со ${requestedLabel} во ${session.slots.location ?? 'оваа населба'} во Вашата цена, но има слични опции кои би можеле да Ви се допаднат. `;
          }
        }
        // TYPED-AREA RELAX (the [23:59] owner contract, tightened by the
        // [09:29] capture): a typed pool (куќа / плац / деловен простор) can
        // ONLY be non-empty here from the city-wide retry — every tier keeps
        // the category, so the cards always match the ask. The prefix says
        // WHY the area changed instead of reading them as local matches, and
        // names the drained area the client asked about.
        if (!prefix && session.slots.location) {
          const kind = session.slots.business === true ? 'деловен простор'
            : session.slots.house === true ? 'куќа'
            : session.slots.plac ? 'плац'
            : undefined;
          // Every card sits OUTSIDE the pinned area (the city-wide retry
          // supplied them) — read that off the rows themselves; the
          // areaExhausted flag is cleared by the fresh-criteria release on
          // this same turn and would miss the widen.
          const elsewhere = props.length > 0
            && props.every(p => !!p.location && !locMatches(session.slots.location as string, p.location));
          // NEVER CALL AN AREA EMPTY WHILE HOLDING A MATCH IN IT (the [21:28]
          // capture): «немам куќа во Тафталиџе» was said one sentence after
          // serving a Тафталиџе house — the area pool merely EXCLUDED it as
          // already shown. The absence claim is only honest when the rows we
          // already served do not sit there with that category.
          let servedInArea = false;
          if (elsewhere && (session.slots.presentedIds ?? []).length > 0) {
            const servedRows = await Promise.all((session.slots.presentedIds ?? []).slice(-6)
              .map(id => this.deps.properties.getById(id).catch(() => undefined)));
            servedInArea = servedRows.some(p => !!p && !!p.location
              && locMatches(session.slots.location as string, p.location)
              && (kind === 'куќа' ? p.house === true
                : kind === 'плац' ? p.plac === true
                : kind === 'деловен простор' ? p.business === true : true));
          }
          if (kind && elsewhere && !servedInArea) {
            // Name the areas the cards actually come from: "во други населби"
            // is the exhausted ASK's wording (and reads as a loop right after
            // a fresh-criteria pivot), while the concrete names are a fact.
            const areas = [...new Set(props.map(p => displayAreaName(p.location as string)).filter(Boolean))].slice(0, 2);
            const cardsIn = areas.length > 1 ? `во ${areas[0]} и ${areas[1]}` : `во ${areas[0]}`;
            prefix = `Во моментов немам ${kind} во ${displayAreaName(session.slots.location)} што одговара на Вашите барања, но имам ${kind} ${cardsIn}: `;
          }
        }
        // Price-priority clients ("што поевтино", "daj nesto poeKtino") get a
        // dedicated bank intro — the default opener reads as if the price
        // concern was never heard. Details-led presentation remains for the
        // rest (the 19:34 convention).
        if (!prefix && session.slots.pricePriority) {
          prefix = pickVariant('price.shy', { recent: assistantTexts(session) }) ?? '';
        }
        // Size-waiver ack: the client waived bedrooms ("nebitno") — confirm it
        // and name the biggest-for-the-money ordering ONCE (the flag keeps
        // later batches plain). The ladder really does lead with the biggest
        // unit (sortBySqmDesc), so the ack states a fact, not a promise.
        if (!prefix && session.slots.sizeWaived && !session.slots.waiverAcked) {
          prefix = waiverAck(session.slots.budget, assistantTexts(session));
          session.slots.waiverAcked = true;
        }
        // POI-ANCHOR honesty (the [22:41] contract): when nothing in the pool
        // is within the honest 1.5 km walk radius of the client's named place,
        // SAY SO — never present a far apartment as if it answered the wish.
        if (!prefix && session.slots.poiAnchorTooFar && session.slots.poiAnchor) {
          const anchorPlace = displayPlaceName(session.slots.poiAnchor);
          prefix = pickVariant('poi.tooFar', { recent: assistantTexts(session), vars: { place: anchorPlace } })
            ?? `Во моментов немам недвижност во непосредна близина на ${anchorPlace}. Еве ги најблиските опции во ${session.slots.location ?? 'реонот'}:`;
          bankKey = 'poi.tooFar';
          session.slots.poiAnchorTooFar = undefined; // once per search
        }
        const cards = buildPropertyCards(props, 'presentation', session.history.length,
          assistantTexts(session), { anywhere: session.slots.anywhere, budget: session.slots.budget, noOpener: !!prefix });
        reply = prefix ? `${prefix.trimEnd()}\n\n${cards}` : cards;
      }
    } else if (detectBothServices(text)
        && ['idle', 'intent'].includes(before)
        && !session.slots.service) {
      // Both buy + rent: client said 'I TOA I TOA' / 'za dvete' — ask
      // what TYPE of property they want (stan, kukja, business, plac).
      // The bothServices flag persists so the next message (type) triggers
      // the buy-vs-rent question instead of the normal discovery flow.
      session.slots.bothServices = true;
      session.state = 'intent';
      reply = pickVariant('both.ask.type', { recent: assistantTexts(session) })
        ?? 'Ќе ми треба типот на недвижност што Ве интересира, за да Ви понудам соодветни опции — стан, куќа, деловен простор или плац?';
      bankKey = 'both.ask.type';
    } else if (session.slots.bothServices
        && before === 'intent'
        && (detectBusiness(text) || detectHouse(text)
            || /(?:стан|stan(?:ot)?|куќа|kukj[ae]|дуќан|dukj[ae]n|локал|lokal|деловен|deloven|канцеларија|plac|плац)/iu.test(text))) {
      // Type chosen after both-services: 'DUKJAN' / 'stan' / 'kuќa' /
      // 'plac'. Now ask buy vs rent with the type baked in.
      // Keep state = 'intent' so the buy/rent answer goes through the normal
      // INTENT_DECLARED path into discovery.
      session.state = 'intent';
      if (detectBusiness(text)) session.slots.business = true;
      const h = detectHouse(text);
      if (h !== undefined) session.slots.house = h;
      const typeLabel = detectBusiness(text) ? 'Деловен простор'
        : h ? 'Куќа'
        : /(?:плац|plac)/iu.test(text) ? 'Плац'
        : 'Стан';
      reply = (pickVariant('both.ask.service', { recent: assistantTexts(session) })
        ?? `{type} — одлично. Дали сакате да купите или да изнајмите?`)
        .replace('{type}', typeLabel);
      bankKey = 'both.ask.service';
    } else if (session.slots.bothServices
        && before === 'intent'
        && !session.slots.service
        && !session.slots.business && !session.slots.house) {
      // Still undecided on property type after both-services: "не сум се одлучил",
      // "не знам", "кажете ми опции" — re-ask the type question.
      session.state = 'intent';
      reply = pickVariant('both.ask.type', { recent: assistantTexts(session) })
        ?? 'Ќе ми треба типот на недвижност што Ве интересира, за да Ви понудам соодветни опции — стан, куќа, деловен простор или плац?';
      bankKey = 'both.ask.type';
    } else if (anchoredServe) {
      reply = anchoredServe;
      bankKey = 'locate.landmark';
    } else {
      // Table-driven deterministic dispatch: the 15 simple detectors
      // (OFFTOPIC, DEFER, NEGOTIATE, etc.) are encoded as data in
      // SIMPLE_DETECTORS — first match wins, order mirrors the old chain.
      const simple = dispatchSimple(text, session.state);
      if (simple) {
        routeLog(chatId, text, simple.intent);
        // Provision: pick buy or rent bank based on declared service
        let effectiveKey = simple.bankKey;
        if (effectiveKey === 'provision.ask') {
          effectiveKey = provisionKeyFor(session.slots.service);
        } else if (effectiveKey === 'provision.who') {
          // Danok-specific question: buyer pays tax to Grad Skopje
          const isDanok = /danok|danokot|данок|данокот/i.test(text);
          if (isDanok && session.slots.service !== 'rent') {
            effectiveKey = 'provision.who.danok.buy';
          } else {
            effectiveKey = session.slots.service === 'rent' ? 'provision.who.rent' : 'provision.who.buy';
          }
        }
        const picked = pickVariant(effectiveKey, { recent: assistantTexts(session) });
        if (picked) {
          reply = picked;
          bankKey = effectiveKey;
        } else {
          // Bank miss: the inline literal serves, and the serve is HONEST
          // about having no bank identity — bankKey stays unset and the
          // source is flagged as fallback, so the P4 capture logs it as a
          // FALLBACK_ORPHAN (the cron's learn.* path banks frequent ones).
          reply = simple.fallback;
          replySource = 'fallback';
        }
      } else {
        // LLM responder — the cold-brained fallback for unmatched intents
        const r = await this.deps.responder.respond(session, props, text);
        reply = r.text;
        replySource = r.source;
      }
    }

    // The contact ask is deterministic but KEYLESS: the epilogue logger only
    // records `bankKey || non-deterministic`, so the turn that asked for
    // name/phone never showed up in ENRICHMENT (the 18:22 transcript). Name
    // the key the responder just used so the serve is reviewable.
    if (!bankKey && replySource === 'deterministic' && before === 'contact_collection') {
      const needName = !session.slots.name;
      const needPhone = !session.slots.phone;
      bankKey = needName && needPhone ? 'contact.ask.name.phone' : needName ? 'contact.ask.name' : 'contact.ask.phone';
    }

    pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
    this.deps.sessions.set(session);

    // P4 fallback-literal capture: a reply served from an inline ?? '…'
    // literal (bank miss in dispatchSimple, or the responder's own hard
    // fallback) has NO bank identity — it was invisible to every improvement
    // pipeline, no matter how often it fired. Log it as an orphan serve
    // (FALLBACK_ORPHAN, bankKey null): the midnight cron's existing learn.*
    // path digests frequent orphan groups into banked keys (contract-gated),
    // and bank:fallback-census makes the fire counts visible.
    // EXCLUDED: property-card presentations (code-built data display, not
    // bankable prose) — the responder builds cards only in property_query/
    // presentation when properties exist; every other fallback serve is a
    // genuine orphan literal.
    if (this.deps.enrichment
      && !bankKey
      && replySource === 'fallback'
      && !((before === 'property_query' || before === 'presentation') && props.length > 0)
      && shouldLogForEnrichment(this.deps.brainMode?.(), false, 'fallback')) {
      try {
        this.deps.enrichment.insert({
          chatId: session.chatId,
          state: before,
          eventType: 'FALLBACK_ORPHAN',
          userMsg: text,
          replyText: reply,
          replySource: 'fallback',
        });
      } catch { /* advisory — never break the funnel */ }
    }

    // Enrichment queue: log responses for the midnight cron job — but ONLY in
    // TEACHER modes (hybrid/gemini/groq). Exam mode ('free') logs nothing:
    // the deterministic+bank stack must score alone, uncontaminated by what
    // it just learned. (shouldLogForEnrichment defaults to teacher, so the
    // production server without a brainMode getter keeps learning.)
    // Logs BOTH LLM-generated replies AND bank-backed deterministic replies —
    // the latter are exactly the ones that benefit most from variant diversity.
    if (this.deps.enrichment
      && shouldLogForEnrichment(this.deps.brainMode?.(), replySource !== 'deterministic' && replySource !== 'fallback', replySource)
      && (bankKey || (replySource !== 'deterministic' && replySource !== 'fallback'))) {
      try {
        this.deps.enrichment.insert({
          chatId: session.chatId,
          state: before,
          eventType: ev.type,
          userMsg: text,
          replyText: reply,
          replySource,
          bankKey,
        });
      } catch (e) {
        console.error('[enrichment] log failed:', (e as Error).message);
      }
    }

    // MONEY QUESTION + FEE IN ONE BREATH (the [11:07]-family capture): "КОЛКУ
    // Е КИРИЈАТА И ШТО ПЛАЌАМ ЗА ПОСЕТА?" asked the RENT of the house on the
    // table and the visit fee. The fee lanes own the turn — the client is in
    // closing and the fee is the next gate — but the figure he asked about was
    // simply not answered, which reads as evasion. The price lands first (it
    // is his own property's data), then the fee protocol continues unchanged.
    // Central on purpose: every fee.ask site (six of them) gets it for free.
    if (reply && (bankKey === 'fee.ask.rent' || bankKey === 'fee.ask.buy')
        && !session.slots.viewingFeeAgreed
        && (detectPriceAsk(text)
          || (/(?:кириј|kirij|рента|renta)/iu.test(text)
            && /(?:колку|која|кое|каква|kolku|koja|koe|kakva)/iu.test(text)))) {
      const moneyEb = session.slots.propertyId ?? session.slots.interestedPropertyId
        ?? (session.slots.currentBatch?.length ? session.slots.currentBatch[0] : undefined);
      const moneyProp = moneyEb ? await this.deps.properties.getById(moneyEb) : undefined;
      if (moneyProp?.price !== undefined) {
        const priceLoc = displayAreaName(moneyProp.location ?? '');
        const priceType = moneyProp.house ? 'Куќата' : moneyProp.business ? 'Деловниот простор' : 'Станот';
        const rentPrice = (moneyProp.service ?? session.slots.service) === 'rent';
        reply = `${priceType} со Евидентен број ${moneyProp.eb}`
          + `${priceLoc ? ` ${locPrep(priceLoc)} ${priceLoc}` : ''} — `
          + `${rentPrice ? `киријата изнесува ${moneyProp.price.toLocaleString('mk-MK')} евра` : `чини ${moneyProp.price.toLocaleString('mk-MK')} евра`}.`
          + `\n\n${reply}`;
        session.slots.lastPrice = String(moneyProp.price);
      }
    }

    // THE DISCLOSURE TURN IS NEVER CONSENT. A visit command ("KONTAKTIRAJTE
    // GO I KAZETE MI", "DOGOVORI MI") is also an agreement token, so the
    // classifier could set viewingFeeAgreed on the very turn that DISCLOSED
    // the fee. The next message — even a fee question ("PARI ZEMATE ZA
    // POSETA ?") — then jumped straight to contact collection: the rent
    // capture. Serving fee.ask means the fee is by definition NOT yet agreed.
    if ((bankKey === 'fee.ask.rent' || bankKey === 'fee.ask.buy') && session.slots.viewingFeeAgreed) {
      session.slots.viewingFeeAgreed = undefined;
      this.deps.sessions.set(session); // re-persist after clearing
    }

    const pipelineMs = Date.now() - pipelineStart;
    void pipelineMs;

    // LEARNING LAYER (TUI_LEARN) — one hook, once per completed turn: report
    // the two capture shapes (fallthrough / prose) to the sink. Presentation-
    // card batches are excluded inside decideCapture (code-built data display
    // of an already-understood search, never a classification gap). Advisory
    // only — a capture failure must never break the funnel.
    if (this.deps.capture) {
      try {
        const kind = decideCapture({
          deterministicClassifyGaveUp: this.detGaveUp,
          replySource,
          isPresentationBatch: (before === 'property_query' || before === 'presentation') && props.length > 0,
        });
        if (kind) {
          const rec: import('../store/capture').CaptureRecord = {
            kind: kind === 'both' ? 'fallthrough' : kind,
            text, state: before, at: new Date().toISOString(),
            chatId: session.chatId,
            replySource,
            bankKey: bankKey ?? undefined,
          };
          if (kind === 'both') rec.alsoProse = true; // same message was ALSO Gemini prose
          this.deps.capture.onTurn(rec);
        }
      } catch { /* advisory */ }
    }
    this.detGaveUp = false;

    await this.sendRaw(session, reply, replySource);
  }

  // ---------------- owner check continuation ----------------

  /** Resolve a pending owner check with a verdict (plain-text owner reply or
   *  the TUI /owner command — the same seam Hermes will use). */
  ownerAnswer(chatId: string, eb: number, verdict: OwnerVerdict): boolean {
    const agent = this.ownerAgent as unknown as {
      answer?: (c: string, e: number, v: OwnerVerdict) => boolean;
    };
    return agent.answer?.(chatId, eb, verdict) ?? false;
  }

  private async runOwnerCheck(session: ChatSession, eb: number, proposedTime: string): Promise<void> {
    try {
      // normalizeOwnerTime (the [14:22] transcript): the owner never reads
      // client shorthand — the raw term ("VO PONEDELNIK MOZAM 6 SAAT") is
      // resolved to the concrete date and rewritten canonically
      // ("Понеделник, 28.09.2026 во 18:00") before the ask is composed.
      const askTime = normalizeOwnerTime(proposedTime);
      // SECOND OWNER TURN (the [00:23] capture): when the owner was already
      // asked and the client now proposes a DIFFERENT term, repeating the
      // first-time intro ("Здраво… Дали е сè уште достапна?") re-asks what is
      // already known. The follow-up states which term the client cannot do
      // and the new proposal, and asks only for the owner's verdict.
      // Recorded BEFORE the first await: this method is fire-and-forget, so the
      // caller persists the session as soon as its own turn ends — a flag set
      // after an await would never reach the DB and the next inbound would
      // load a session that "never asked the owner".
      const priorAsk = session.slots.ownerAskTime;
      const isFollowup = !!priorAsk && !!askTime && priorAsk !== askTime;
      // ACCEPTANCE follow-up (the [01:07] capture): an OPEN whole-day counter
      // means the client's completed term accepts the owner's own proposal —
      // the refusal-shaped follow-up asserted a refusal that never happened.
      // Only a completion on THE SAME DAY binds it; a different day in the new
      // term is a counter of the counter (the refusal wording is then true).
      const wholeDaySeed = session.slots.ownerCounterWholeDay;
      const acceptFollowup = !!wholeDaySeed && !!askTime
        && (!extractDayWord(askTime) || extractDayWord(wholeDaySeed) === extractDayWord(askTime));
      // The flag is consumed the moment the ping is composed — whatever the
      // client offered afterwards no longer binds a future loop.
      session.slots.ownerCounterWholeDay = undefined;
      session.slots.ownerAskTime = askTime;
      this.deps.sessions.set(session);
      // The ping-pong starts HERE: Lina asks the owner whether the property is
      // available right now and whether he accepts the client's proposed time.
      // The answer (ok/counter/gone) is relayed to the client; a counter loops
      // back until the visit date+time are arranged.
      const ownerProp = eb ? await this.deps.properties.getById(eb) : undefined;
      const ownerLabels = ownerProp ? ownerPropertyLabels(ownerProp) : undefined;
      // Bank-served for the GENERIC form (no property-type agreement — the
      // typed form stays code-built for its gender agreement): the owner ask
      // now varies too, with the code-built line as the always-there fallback.
      const ownerAskText = acceptFollowup
        ? buildOwnerAcceptFollowupAsk(mkTimePhrase(wholeDaySeed!), askTime)
        : isFollowup
        ? buildOwnerFollowupAsk(mkTimePhrase(priorAsk), mkTimePhrase(askTime))
        : ownerLabels
          ? buildOwnerAsk(eb, askTime, { eb, proposedTime: askTime, propertyType: ownerLabels.type, propertyTypeDef: ownerLabels.def, possessive: ownerLabels.possessive, dostapen: ownerLabels.dostapen, relative: ownerLabels.relative, entered: ownerLabels.entered })
          : pickVariant('owner.ask', { recent: assistantTexts(session), vars: { eb: String(eb), time: askTime } })
            ?? buildOwnerAsk(eb, askTime, { eb, proposedTime: askTime });
      // OWNER-ASK INTAKE (judge layer 1): the owner ask logs the CLIENT's raw
      // proposed term — a question forwarded as a term (20:26 "VO NEDELA
      // RABOTITE ?") is detectable only against the raw words, not the relay.
      if (this.deps.enrichment) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'OWNER_ASK', userMsg: session.slots.visitTime ?? proposedTime, replyText: ownerAskText, replySource: 'owner-relay', bankKey: 'owner.ask' }); } catch { /* ignore */ } }
      this.onOwnerAsk?.(session.chatId, eb, ownerAskText);
      const verdict = await this.ownerAgent.check(session.chatId, eb, proposedTime);
      this.enqueue(session.chatId, () => this.applyOwnerVerdict(session.chatId, eb, verdict));
    } catch (e) {
      console.error('[owner] check failed:', (e as Error).message);
    }
  }

  /** OWNER-RELAY INTAKE (judge layer 1): the owner-exchange serves were
   *  invisible to the enrichment log — a wrong relay (dropped day/clock,
   *  a question forwarded as a term, an English day mid-sentence) looked
   *  identical to a healthy one and the judge could never audit them.
   *  Logged with a SYNTHETIC key (owner.*:<verdict>:<time>) whose shape the
   *  judge's owner-relay assertions parse. bankKey stays null-free: these
   *  rows never feed the variant pools, only the audit. */
  private logOwnerExchange(session: ChatSession, eb: number, verdict: OwnerVerdict, relayText: string): void {
    if (!this.deps.enrichment) return;
    try {
      // The operator log carries the SAME term the client relay will show —
      // normalizedOwnerTime-canonical (day + date + 24h). mkTimePhrase is the
      // lossy display form (the [19:29] capture: '@ Петок во 11' next to a
      // relay that said 'Петок, 30.10.2026 во 11:00'). Vague/bare-day verdicts
      // normalize only to the dated day name (no fabricated clock).
      const timeTag = typeof verdict.ownerTime === 'string' ? normalizeOwnerTime(verdict.ownerTime) : '';
      this.deps.enrichment.insert({
        chatId: session.chatId,
        state: session.state,
        eventType: 'OWNER_RELAY',
        userMsg: `[owner:${eb}] ${verdict.status}${verdict.canAcceptWholeDay ? '+wholeday' : ''}${timeTag ? ` @ ${timeTag}` : ''}${verdict.note ? ` (${verdict.note})` : ''}`,
        replyText: relayText,
        replySource: 'owner-relay',
        bankKey: `owner.relay:${verdict.status}${verdict.canAcceptWholeDay ? '.wholeday' : ''}`,
      });
    } catch { /* the audit must never break the relay */ }
  }

  private async applyOwnerVerdict(chatId: string, eb: number, verdict: OwnerVerdict): Promise<void> {
    const session = this.deps.sessions.get(chatId);
    if (!session || session.state !== 'owner_checking') return; // stale/reset — drop
    // Any verdict RESOLVES the open whole-day offer (a fixed counter binds an
    // exact term; ok/gone close the visit) — the acceptance follow-up must not
    // fire from a stale seed on a later ping (see ownerCounterWholeDay).
    session.slots.ownerCounterWholeDay = undefined;

    // The owner dictates the CURRENT price ("цената е променета на 60.000") —
    // the owner is the source of truth and the price can change. Store it so
    // Hermes corrects the public app (Lovable/Cloudflare) AND relay the change
    // to the client (our price must follow the owner's word).
    let priceRelay = '';
    if (verdict.price !== undefined) {
      const old = (await this.deps.properties.getById(eb))?.price;
      this.priceChanges.insert({ eb, oldPrice: old ?? null, newPrice: verdict.price, chatId, source: 'owner' });
      this.events.insert('price_changed', chatId, eb, { oldPrice: old ?? null, newPrice: verdict.price, source: 'owner' });
      console.log(`[EVENT] PRICE_CHANGED ${JSON.stringify({ eb, oldPrice: old ?? null, newPrice: verdict.price })}`);
      priceRelay = buildPriceRelay(eb, verdict.price, old);
    }

    if (verdict.status === 'ok') {
      session.state = 'pending';
      session.slots.ownerTime = verdict.ownerTime ?? session.slots.visitTime;
      // The price relay goes FIRST (if any), then the confirmation — the client
      // must hear the new price before the visit is locked in.
      if (priceRelay) {
        pushHistory(session, { role: 'assistant', text: priceRelay }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, priceRelay);
      }
      await this.confirmVisit(session, eb, session.slots.ownerTime ?? '');
      return;
    }

    if (verdict.status === 'counter') {
      // Bare counter = the owner can't do the proposed time, NO alternative
      // given. There is no term for the client to accept — routing to
      // time_confirm fabricated "по договор со сопственикот" (and accepting
      // it fell back to the REFUSED time). Ask the client for another time;
      // the new proposal re-asks the owner.
      if (!verdict.ownerTime) {
        session.state = 'visit_scheduling';
        // The relay must read proper Macedonian in BOTH scripts: the client
        // typed "UTRE VO 4" Latin, and mkTimePhrase alone only fixes known
        // misspellings — it echoed "терминот во UTRE VO 4". normalizeTimePhrase
        // first translits the Latin phrase ("утре во 4"), mkTimePhrase then
        // applies the Cyrillic misspelling fixes on top.
        const refusedTime = mkTimePhrase(normalizeTimePhrase(session.slots.visitTime ?? ''));
        // Bank-served with the code-built line as fallback; the refusal is
        // relayed honestly — never a fabricated term the client could accept.
        const reply = `${priceRelay ? `${priceRelay} ` : ''}${pickVariant('owner.relay:counter.bare', { recent: assistantTexts(session), vars: { time: refusedTime } }) ?? OWNER_CANT_TIME_RELAY(refusedTime)}`;
        this.logOwnerExchange(session, eb, verdict, reply);
        pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, reply);
        return;
      }
      // Vague owner time: "попладне", "после 5" etc. — ask owner for exact
      // clock instead of relaying a vague time to the client.
      // WHOLE-DAY counter: the owner offered an entire day ("ке морам во
      // сабота, било кое време"). There is no fixed term to accept — relay
      // the day and ask the client to precise the exact clock; the answer
      // re-asks the owner with the completed term.
      if (verdict.canAcceptWholeDay) {
        session.state = 'visit_scheduling';
        // Same refused-term → proposal shape as every other counter relay
        // (the [00:23] contract), with the clock still open on the owner's day.
        const dayRelay = buildOwnerWholeDayRelay(
          normalizeOwnerTime(session.slots.visitTime ?? ''),
          // Same canonical day form the operator log's time tag carries
          // (normalizeOwnerTime) — the dropped-alternative judge requires the
          // tagged term to appear verbatim in the relay, and the [19:29]
          // contract wants one display family everywhere. DAY-ONLY output (a
          // bare day never gains a fabricated clock).
          normalizeOwnerTime(verdict.ownerTime ?? ''),
        );
        // Seed the slot with the OWNER'S DAY (clock still on the client). The
        // old slot held the client's own REJECTED clock — a clock-carrying
        // store vetoes the day-first merge, so the client's completing answer
        // ("MOZAM VO 5" after "Понеделник — било кое време") would land as a
        // day-less clock and resolve to TODAY (the [01:06] transcript).
        const seededDay = mkTimePhrase(verdict.ownerTime ?? '');
        if (seededDay) {
          session.slots.visitTime = seededDay;
          // The counter is OPEN: the client's exact-clock answer complements
          // the OWNER'S day — the next owner ping must read acceptance, not a
          // refusal of a term the owner himself proposed (the [01:07] scrape).
          session.slots.ownerCounterWholeDay = seededDay;
        }
        this.logOwnerExchange(session, eb, verdict, dayRelay);
        pushHistory(session, { role: 'assistant', text: dayRelay }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, dayRelay);
        return;
      }
      if (detectVagueTime(verdict.ownerTime)) {
        session.state = 'owner_checking'; // stay in owner_checking, re-ask
        const vagueReply = pickVariant('vague.time.owner', { recent: assistantTexts(session) })
          ?? 'Може ли да ми кажете точно во колку часот? Така ќе можам да го пренесам терминот на клиентот.';
        const fullReply = `${priceRelay ? `${priceRelay} ` : ''}${vagueReply}`;
        pushHistory(session, { role: 'assistant', text: fullReply }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, fullReply);
        return;
      }
      session.state = 'time_confirm';
      session.slots.ownerTime = verdict.ownerTime;
      // The CLIENT-facing relay shows the owner's counter in the canonical
      // 24h display (normalizeOwnerTime → "Четврток, 29.10.2026 во 19:30"),
      // exactly like the refused term next to it. mkTimePhrase is the LOSSY
      // display normalizer — the [19:29] capture: the owner countered
      // "Cetvrtok vo 7ipol ?" and the relay told the client "Четврток во 7"
      // (the :30 dropped, and the clock stayed bare instead of 24h).
      // Unresolvable phrases still fall back to mkTimePhrase inside it, so
      // vague counters keep their shape.
      const counterTime = normalizeOwnerTime(verdict.ownerTime ?? '');
      // Fixed counter relay (the [00:23] contract): name the term the owner
      // cannot do AND the proposed alternative in one sentence, then ask the
      // client to accept it. Code-built so both terms are always present (a
      // vague "предложи поинаков термин" dropped the refused term).
      const reply = `${priceRelay ? `${priceRelay} ` : ''}${buildOwnerCounterRelay(normalizeOwnerTime(session.slots.visitTime ?? ''), counterTime)}`;
      this.logOwnerExchange(session, eb, verdict, reply);
      pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, reply);
      return;
    }

    // gone (sold / rented / under option)
    session.state = 'presentation';
    session.slots.soldEb = eb; // exclude from alternatives
    // The property is "недвижност" (feminine): the predicate must agree with
    // it, whatever form the owner's note arrived in (the [12:08] capture said
    // "недвижноста ... е продаден", and the full-sentence note produced
    // "е недвижноста е продадена"). Canonicalise, never interpolate the raw
    // note into an "е …" slot.
    const note = gonePredicate(verdict.note);
    // SOLD is good news for the OWNER: congratulate him BEFORE the client hears
    // the bad news. Only a reported SALE earns this — a rental or an
    // under-option status is not a milestone the owner announced, and inventing
    // one would congratulate him for something he never said.
    if (/продад/.test((verdict.note ?? '').toLowerCase())) {
      this.onOwnerMessage?.(chatId, eb, 'Ви честитам на продажбата. Се најдобро.');
    }
    // The offer must be a QUESTION. The bank family (owner.relay:gone) is eight
    // STATEMENT variants that end with "…што одговара на Вашите критериуми." —
    // the client had no cue to answer and the funnel died on a sold property.
    // Code-built (same precedent as the counter relays) so the ask is always
    // there; the answer is consumed by the GONE-ALTERNATIVES lane in handle().
    const reply = `За жал, недвижноста со Евидентен број ${eb} ${note}. Дали би сакале да Ви понудам нешто друго со слични карактеристики?`;
    session.slots.goneAlternativesEb = eb;
    pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
    this.deps.sessions.set(session);
    await this.sendRaw(session, reply);
  }

  /** Agent assignment (quota-balanced) + code-built confirmation + persistence. */
  private async confirmVisit(session: ChatSession, eb: number, time: string): Promise<void> {
    const agent = this.dispatcher.pick(session.slots.service ?? 'buy');
    const agentPhone = agent?.phone ?? this.cfg.agentDefaultPhone;
    const agentName = agent?.name ?? 'Агент';
    session.slots.agentName = agentName;
    session.slots.agentPhone = agentPhone;

    const reply = buildVisitConfirmation(eb, time, agentPhone);
    pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
    this.deps.sessions.set(session);
    if (this.deps.enrichment) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: session.state, eventType: 'VISIT_CONFIRMED', userMsg: `[owner:${eb}] visit confirmed`, replyText: reply, replySource: 'owner-relay', bankKey: 'owner.relay:ok' }); } catch { /* ignore */ } }

    if (agent) this.dispatcher.recordVisit(agent.id, session.slots.service ?? 'buy');
    const apptId = this.finalizeAppointment(session, time, agentPhone);
    // The visit is LOCKED IN (owner ok'd, client accepted) — the appointment is
    // finalized so the visit protocol's timed turns can schedule against it.
    this.deps.appointments.markFinalized(apptId, time);
    this.events.insert('agent_assigned', session.chatId, eb, {
      agentId: agent?.id ?? null, agentPhone, time,
    });
    this.events.insert('visit_confirmed', session.chatId, eb, {
      appointmentId: apptId, time, agentPhone,
      customerName: session.slots.name ?? '', customerPhone: session.slots.phone ?? '',
    });
    this.promoteCustomer(session);

    await this.sendRaw(session, reply);

    // The visit protocol, turn 1: the moment the visit is confirmed, BOTH the
    // owner and the client get ДОГОВОРЕНА ПОСЕТА, the operator gets the
    // ARRANGED log line, and turns 2+3 (morning confirmation / exact location)
    // are scheduled by the VisitScheduler.
    if (this.visits) {
      const owner = this.owners.get(eb);
      await this.visits.arrange({
        appointmentId: apptId,
        chatId: session.chatId,
        eb,
        time,
        agentPhone,
        clientName: session.slots.name ?? 'Непознат клиент',
        clientPhone: session.slots.phone ?? 'Непознат телефон',
        owner: owner && (owner.name || owner.phone)
          ? { name: owner.name || 'Сопственик', phone: owner.phone || '?' }
          : undefined,
      });
    }
  }

  // ---------------- side-effect helpers ----------------

  private finalizeAppointment(session: ChatSession, time?: string, agentPhone = ''): number {
    const fee = session.slots.service === 'rent' ? '300 MKD' : '500 MKD';
    const propertyId = session.slots.interestedPropertyId ?? session.slots.propertyId ?? 0;
    const rowId = this.deps.appointments.insert({
      chatId: session.chatId,
      clientName: session.slots.name ?? 'Непознат клиент',
      clientPhone: session.slots.phone ?? 'Непознат телефон',
      propertyId,
      service: serviceLabel(session.slots.service),
      viewingFee: fee,
      time: time ?? null,
      agentPhone,
    });
    console.log(`[EVENT] APPOINTMENT_PENDING ${JSON.stringify({
      id: rowId, chatId: session.chatId,
      clientName: session.slots.name, clientPhone: session.slots.phone,
      propertyId, service: serviceLabel(session.slots.service), viewingFee: fee, time,
    })}`);
    return rowId;
  }

  /** The RENT-COMMISSION ladder serve — the SINGLE source of truth for the
   *  second money topic, shared by the pre-classifier lane and the FSM leg so
   *  the two can never serve different rungs (the same reason feeLadder lives
   *  in prompts.ts).
   *
   *  Counting contract: ONLY the rent script resists a real commission, so only
   *  the rent branch moves slots.provisionRejections. A buyer (0% — the owner
   *  pays) or an undeclared market gets the CLARIFICATION and no rung, and
   *  slots.feeRejections is never touched: the visit-fee ladder and the
   *  commission ladder are independent (resisting one must not advance the
   *  other, in either direction).
   *
   *  The 4th rent resistance closes the chat: the decision question was asked
   *  and refused, so the customer is queued and served the graceful close.
   */
  private serveProvisionResistance(session: ChatSession, text: string):
    { reply: string; bankKey: string; rung: ProvisionRung | 'closed' } {
    // Market backfill (the [09:0x] rule): an undeclared session on a rent
    // property IS a rent session — never default to the buy 0% copy.
    if (!session.slots.service) session.slots.service = this.feeServiceHint;
    const service = session.slots.service;
    if (service === 'rent') {
      session.slots.provisionRejections = (session.slots.provisionRejections ?? 0) + 1;
      if ((session.slots.provisionRejections ?? 0) >= 4) {
        session.state = 'queued';
        this.queueCustomer(session, '3x одбиена провизија');
        return {
          reply: pickVariant('fee.graceful.close', { recent: assistantTexts(session) }) ?? FEE_GRACEFUL_CLOSE,
          bankKey: 'fee.graceful.close',
          rung: 'closed',
        };
      }
    }
    const rung = provisionLadder(service, session.slots.provisionRejections ?? 0);
    return {
      reply: pickVariant(rung.key, { recent: assistantTexts(session) }) ?? rung.line,
      bankKey: rung.key,
      rung: rung.rung,
    };
  }

  /** The VISIT-FEE nag ladder — the SINGLE source of truth for the first money
   *  topic, shared by the pre-classifier lane and the FSM leg so the two can
   *  never serve different rungs (the same reason serveProvisionResistance and
   *  feeLadder exist).
   *
   *  Counting contract: one nag = one rung. `counted` says the caller already
   *  moved the counter this turn (the classifier's FEE_REFUSED leg runs before
   *  the reply chain), so the same message is never billed twice. The
   *  commission counter (slots.provisionRejections) is never touched — the two
   *  ladders are independent in both directions.
   *
   *  The 4th resistance closes the chat: the decision question was asked and
   *  refused, so the customer is queued and served the graceful close.
   */
  private serveFeeNagLadder(session: ChatSession, opts: { counted?: boolean } = {}):
    { reply: string; bankKey: string; rung: number | 'closed' } {
    // Market backfill (the [09:0x] rule): an undeclared session on a rent
    // property IS a rent session — never default to the buy 500 copy.
    if (!session.slots.service) session.slots.service = this.feeServiceHint;
    const rungNo = opts.counted
      ? (session.slots.feeRejections ?? 1)
      : (session.slots.feeRejections ?? 0) + 1;
    session.slots.feeRejections = rungNo;
    if (rungNo >= 4) {
      session.state = 'queued';
      this.queueCustomer(session, '3x одбиен надомест');
      return {
        reply: pickVariant('fee.graceful.close', { recent: assistantTexts(session) }) ?? FEE_GRACEFUL_CLOSE,
        bankKey: 'fee.graceful.close',
        rung: 'closed',
      };
    }
    const rung = feeLadder(session.slots.service, rungNo);
    return {
      reply: pickVariant(rung.key, { recent: assistantTexts(session) }) ?? rung.line,
      bankKey: rung.key,
      rung: rungNo,
    };
  }

  private queueCustomer(session: ChatSession, reason: string): void {
    const id = this.customers.upsert({
      chatId: session.chatId,
      phone: session.slots.phone,
      name: session.slots.name,
      service: serviceLabel(session.slots.service),
      location: session.slots.location,
      bedrooms: session.slots.bedrooms,
      budget: session.slots.budget,
      refusedEb: session.slots.interestedPropertyId ?? session.slots.propertyId,
      reason,
    });
    this.events.insert('customer_reengage', session.chatId, null, { customerId: id });
    console.log(`[EVENT] CUSTOMER_QUEUED ${JSON.stringify({ id, chatId: session.chatId, reason })}`);
  }

  private promoteCustomer(session: ChatSession): void {
    const existing = this.customers.getByChat(session.chatId);
    if (existing) this.customers.upsert({ chatId: session.chatId }, 'client');
  }

  private raiseEscalation(session: ChatSession, lastText: string): void {
    const history = [...session.history, { role: 'user' as const, text: lastText }];
    const rowId = this.deps.escalations.insert({
      chatId: session.chatId,
      customer: session.slots.name ?? 'Непознат клиент',
      history: JSON.stringify(history),
    });
    console.log(`[EVENT] NEEDS_MANAGER_ASSISTANCE ${JSON.stringify({
      id: rowId, chatId: session.chatId, customer: session.slots.name ?? 'Непознат клиент',
    })}`);
  }

  // ---------------- slots / props ----------------

  /** CHEAPER-SEARCH PRESENTATION (the 21:39 contract): the client asked for
   *  something cheaper (“daj nesto poeKtino vo toj reon”) — serve REAL cheaper
   *  options from the DB, never the generic price excuse. Area-locked batch
   *  cheapest-first under the price.shy bank intro; when the current area has
   *  nothing (or is drained), offer OTHER NEIGHBORHOODS (price.shy.empty ask)
   *  and let the widen release happen on the client's “да” — options never
   *  spill silently. */
  /** [00:12] SMALLER-BY-RATE — the size-down ladder. Anchor = the property
   *  the chat put on the table (mention in the message itself, else current →
   *  interested → last-presented — the chain the INFO block trusts). Pool =
   *  same service + same category, strictly smaller м² (fewer спални when the
   *  anchor has no м²), €/м² at or BELOW the anchor's rate, already-shown rows
   *  excluded, same-area rows first. Serves up to 2 cards, each with its own
   *  €/м² line; nothing left → the honest no-match line with the register
   *  offer. Returns false only when the ask is unanchorable (no property, no
   *  rate, no size basis) and the normal lanes must still get their chance. */
  /** mode 'perM2': the rate ceiling is the client's own spec (≤ anchor's €/м²).
   *  mode 'golem': no ceiling — "golem mi e" anchors on SIZE, so the closest
   *  smaller м² ranks first (a bigger-rate row may honestly serve). */
  private async presentSmallerPerM2(session: ChatSession, text: string, mode: 'perM2' | 'golem' = 'perM2'): Promise<boolean> {
    const isGolem = mode === 'golem';
    const mbAnchor = await this.bindMention(text, session, { historyFallback: true });
    const anchor = mbAnchor?.prop
      ?? (session.slots.propertyId
        ? await this.deps.properties.getByEb(session.slots.propertyId).catch(() => undefined)
        : undefined)
      ?? (session.slots.interestedPropertyId
        ? await this.deps.properties.getByEb(session.slots.interestedPropertyId).catch(() => undefined)
        : undefined)
      ?? (session.slots.presentedIds?.length
        ? await this.deps.properties.getByEb(session.slots.presentedIds[session.slots.presentedIds.length - 1]).catch(() => undefined)
        : undefined);
    if (!anchor) return false;
    const anchorRate = pricePerM2(anchor);
    if (anchorRate === undefined) return false;
    // "Smaller" needs a size basis: the anchor's own м², else its bedroom
    // grid. A garsonjera anchor (1 спална) has nothing smaller under it — the
    // honest empty line is the correct answer, never a bigger row.
    const smallerThan = (p: Property): boolean => {
      if (anchor.sqm !== undefined) return p.sqm !== undefined && p.sqm < anchor.sqm;
      if (anchor.bedrooms !== undefined) return p.bedrooms !== undefined && p.bedrooms < anchor.bedrooms;
      return false;
    };
    const exclude = new Set<number>([anchor.eb, ...(session.slots.presentedIds ?? [])]);
    const inAnchorArea = (p: Property): number =>
      anchor.location && p.location && locMatches(anchor.location, p.location) ? 0 : 1;
    const rate = (p: Property): number | undefined => pricePerM2(p);
    const pool = (await this.deps.properties.getAll())
      .filter(p => !exclude.has(p.eb))
      .filter(p => !p.service || p.service === anchor.service)
      .filter(p => (p.business ?? false) === (anchor.business ?? false)
        && (p.house ?? false) === (anchor.house ?? false))
      .filter(smallerThan)
      .filter(p => rate(p) !== undefined) // a row with no м² has no rate line to show
      .filter(p => isGolem || (rate(p) as number) <= anchorRate)
      .sort((a, b) => inAnchorArea(a) - inAnchorArea(b)
        // 'perM2': the CLOSEST rate under the anchor first. 'golem': the
        // biggest smaller м² first — closest size under the anchor.
        || (isGolem ? (b.sqm ?? 0) - (a.sqm ?? 0) : (rate(b) as number) - (rate(a) as number))
        || a.eb - b.eb)
      .slice(0, 2);
    const fmt = (n: number): string => n.toLocaleString('mk-MK');
    if (pool.length > 0) {
      session.slots.presentedIds = [...(session.slots.presentedIds ?? []), ...pool.map(p => p.eb)];
      session.slots.currentBatch = pool.map(p => p.eb);
      session.slots.propertyId = pool[0].eb;
      session.slots.interestedPropertyId = pool[0].eb;
      session.slots.lastPrice = pool[0].price !== undefined ? String(pool[0].price) : session.slots.lastPrice;
      session.state = 'presentation';
      await this.landmarks.enrich(pool);
      const cards = pool.map(p =>
        `${buildPropertyCard(p)}\nЦена за м²: ${fmt(pricePerM2(p) as number)} евра за м² (${p.sqm} м²).`).join('\n\n');
      const intro = isGolem
        ? pickVariant('golem.smaller.intro', { recent: assistantTexts(session) })
          ?? 'Помал стан — помала квадратура, помала вкупна сума:'
        : pickVariant('smaller.perM2.intro', { recent: assistantTexts(session), vars: { rate: fmt(anchorRate) } })
          ?? `Помал стан, идентична или пониска цена за м² (${fmt(anchorRate)} евра за м² е референцата):`;
      const reply = `${intro}\n\n${cards}\n\n${pickCloser(PRESENTATION_CLOSERS_ALL, session.history.length)}`;
      pushHistory(session, { role: 'user', text: this.lastUserText || text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      routeLog(session.chatId, text, isGolem ? 'GOLEM_SMALLER' : 'SMALLER_PER_M2');
      if (this.deps.enrichment) {
        try {
          this.deps.enrichment.insert({
            chatId: session.chatId, state: 'presentation',
            eventType: isGolem ? 'GOLEM_SMALLER' : 'SMALLER_PER_M2',
            userMsg: text, replyText: reply, replySource: 'deterministic',
            bankKey: isGolem ? 'golem.smaller' : 'smaller.perM2',
          });
        } catch { /* advisory */ }
      }
      await this.sendRaw(session, reply, 'deterministic');
      return true;
    }
    // Nothing smaller at or under the rate — anywhere. The honest line says
    // so AND keeps the funnel alive with the register step (same contract as
    // the typed-no-match ladder).
    session.slots.currentBatch = [];
    const anchorDesc = anchor.sqm !== undefined ? `${anchor.sqm} м²`
      : anchor.bedrooms !== undefined ? `${anchor.bedrooms} спални` : '';
    const areaDesc = anchor.location ? ` во ${displayAreaName(anchor.location)}` : '';
    const reply = isGolem
      ? pickVariant('golem.smaller.empty', { recent: assistantTexts(session), vars: { size: anchorDesc || 'таа квадратура', where: areaDesc } })
        ?? `Помал стан${anchorDesc ? ` од ${anchorDesc}` : ''} немам во моментов${areaDesc}. Можам да ги запишам Вашите критериуми и да Ве известам штом се појави соодветна опција — дали да Ве запишам?`      : pickVariant('smaller.perM2.empty', { recent: assistantTexts(session), vars: { rate: fmt(anchorRate), size: anchorDesc || 'таа квадратура', where: areaDesc } })
        ?? `Помал стан${anchorDesc ? ` од ${anchorDesc}` : ''} со цена за м² до ${fmt(anchorRate)} евра${areaDesc} немам во моментов — евидентниот број ${anchor.eb} е најдобрата ставка што ја имам во таа рамка. Можам да ги запишам Вашите критериуми и да Ве известам штом се појави соодветна опција — дали да Ве запишам?`;
    pushHistory(session, { role: 'user', text: this.lastUserText || text }, this.cfg.maxHistory);
    pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
    this.deps.sessions.set(session);
    routeLog(session.chatId, text, isGolem ? 'GOLEM_SMALLER_EMPTY' : 'SMALLER_PER_M2_EMPTY');
    if (this.deps.enrichment) {
      try {
        this.deps.enrichment.insert({
          chatId: session.chatId, state: 'presentation',
          eventType: isGolem ? 'GOLEM_SMALLER_EMPTY' : 'SMALLER_PER_M2_EMPTY',
          userMsg: text, replyText: reply, replySource: 'deterministic',
          bankKey: isGolem ? 'golem.smaller.empty' : 'smaller.perM2.empty',
        });
      } catch { /* advisory */ }
    }
    await this.sendRaw(session, reply, 'deterministic');
    return true;
  }

  /** The shared cheaper-lane serve: marks the batch, enriches landmarks,
   *  builds intro + cards + closer, logs the enrichment row and sends. */
  private async serveBatch(session: ChatSession, batch: Property[], intro: string,
    eventType: string, bankKey: string): Promise<true> {
    // R2 (stateLanes): the ONLY choke every batch serve crosses. The deny is
    // decided on the PRE-serve state — this line re-points the session at
    // 'presentation' as a side-effect, so a caller in, say, owner_checking
    // must not gain its card by its own re-point. Fail-open outside the deny
    // rows: a state missing from the map serves exactly as before.
    const stateBefore = session.state;
    if (laneServeDenied(eventType, stateBefore, 'property-batch')) {
      const ack = pickVariant(GENERIC_ACK_KEY, { recent: assistantTexts(session) }) ?? GENERIC_ACK_FALLBACK;
      pushHistory(session, { role: 'user', text: this.lastUserText ?? '' }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: ack }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      console.log(`[serve-deny] ${session.chatId} state=${stateBefore} lane=${eventType} batch denied → generic ack`);
      await this.sendRaw(session, ack, 'deterministic');
      return true;
    }
    session.slots.presentedIds = [...(session.slots.presentedIds ?? []), ...batch.map(p => p.id)];
    session.slots.currentBatch = batch.map(p => p.id);
    session.slots.areaExhausted = false;
    session.slots.pricePriority = true;
    session.state = 'presentation';
    // NO RE-ANCHOR (the stuck.test contract): the batch lead lives in
    // presentedIds/currentBatch, NOT in propertyId. The pivot (“predloži mi”
    // after an unknown EB) relies on the cleared propertyId STAYING cleared —
    // a later INTERESTED must never grab either the dead EB or, once the
    // client has CHOSEN, the chosen anchor (kept via interestedPropertyId
    // by the lines above). presentCheaperBatch passes through here on a
    // pivot turn; a blanket re-point squashed the pivot's own
    // `propertyId = undefined` and served the dead anchor instead.
    await this.landmarks.enrich(batch);
    const reply = `${intro}\n\n${batch.map(p => buildPropertyCard(p)).join('\n\n')}\n\n${pickCloser(PRESENTATION_CLOSERS_ALL, session.history.length)}`;
    pushHistory(session, { role: 'user', text: this.lastUserText ?? '' }, this.cfg.maxHistory);
    pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
    this.deps.sessions.set(session);
    if (this.deps.enrichment) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: 'closing', eventType, userMsg: this.lastUserText ?? '', replyText: reply, replySource: 'deterministic', bankKey }); } catch { /* ignore */ } }
    await this.sendRaw(session, reply, 'deterministic');
    return true;
  }

  // BARE BUDGET-UP serve ([25:2x] queue): the upward-paid mirror of
  // presentCheaperBatch. The contract now lives in ONE place (see
  // presentPricierBatch — case 252): the ask's own slots steer the pool, the
  // standing budget cap is released, the anchor fills the remaining axes and
  // sets only the price FLOOR, priciest-first, already-shown rows excluded.
  // THE UPWARD RULE (case 252) — one contract for EVERY property the ask rides:
  //   1. The ASK's own slots win first: a newly named area/error/type in the
  //      same breath (“ПОСКАПО НЕШТО ВО ЦЕНТАР”, “nesto poskapo, edna spalna”)
  //      steers the pricier pool at the client's request — never the stale
  //      session naselba, and never a later pivot that re-searches the fresh
  //      area under the OLD budget cap (the miss the probe found).
  //   2. The standing budget cap is deliberately NOT passed down: “more
  //      expensive” IS the budget lift; the anchor price is only the FLOOR.
  //   3. The anchor supplies whichever axis NEITHER the ask nor the session
  //      carries (bedrooms/type/service) — same-studio discipline as the
  //      cheaper lane.
  //   4. NO anchor yet: the rule still applies — the priciest-first batch of
  //      the declared criteria (no strictly-above filter — nothing to be
  //      above), so ALL properties answer the ask, not only ones with a
  //      presented row.
  // Drained pool (→ return false) keeps the funnel alive through the
  // pre-existing lanes, exactly like the smaller-per-m² ladder.
  /** CRITERIA-DONE CHOICE BUILDER (the [20:33] fix): the strict criteria
   *  pool (location + budget + category, excluding everything already shown)
   *  is drained AND rows were served before — Lina SAYS the matching options
   *  are done and offers the two standard pivots (more expensive in the same
   *  area / same price elsewhere). Options come only AFTER the ask.
   *  Returns the ask TEXT (and arms moreChoicePending), or undefined when
   *  the pivot declines: a failed feed (the outage line owns it), rows were
   *  never served (a no-match line is honest there), or fresh criteria-fit
   *  rows exist (the caller serves them). Sends nothing — the pre-FSM lane
   *  and the FSM branches wire their own history/epilogue conventions. */
  private async criteriaDoneAsk(session: ChatSession): Promise<string | undefined> {
    // FEED-DOWN GUARD: the outage line handles a failed fetch — the pivot
    // ask would promise options a dead feed cannot supply.
    if (!this.deps.properties.healthy) return undefined;
    const shown = new Set(session.slots.presentedIds ?? []);
    if (session.slots.propertyId != null) shown.add(session.slots.propertyId); // already discussed
    if (session.slots.soldEb != null) shown.add(session.slots.soldEb);
    if (shown.size === 0) return undefined; // nothing served yet — no "choices are done" claim
    const mixedTypes = !!session.slots.garsonjera
      && (session.slots.bedrooms !== undefined || session.slots.bedroomsMin !== undefined);
    const strict = await this.deps.properties.candidates({
      location: session.slots.location,
      bedrooms: session.slots.bedrooms,
      bedroomsMin: session.slots.bedroomsMin,
      bedroomsMax: session.slots.bedroomsMax,
      sqm: session.slots.sqm,
      business: this.businessPoolLock(session.slots),
      house: session.slots.house,
      garsonjera: session.slots.garsonjera,
      plac: session.slots.plac,
      yard: session.slots.yard,
      service: session.slots.service,
      budget: session.slots.budget,
      exclude: [...shown],
      sortBySqmDesc: mixedTypes || !!session.slots.sizeWaived,
    });
    // Fresh criteria-fit rows exist → the next batch serves them; the pivot
    // ask is only for a DRAINED pool. The drained turn leaves NOTHING on the
    // table: the batch is cleared and the alternatives ladder is marked
    // exhausted — the [20:33]/ladder contract (batch().length == 0,
    // alternativesExhausted) on the drained turn, and no stale pair anchors
    // mention picks across the choice ask.
    if (strict.length > 0) return undefined;
    session.slots.currentBatch = [];
    session.slots.alternativesExhausted = true;
    session.slots.moreChoicePending = true;
    return pickVariant('batch.done.choice', { recent: assistantTexts(session) })            ?? 'Ги разгледав Вашите критериуми — предлозите што Ви ги покажав се сè што имам соодветно во моментов. Дали да Ви покажам нешто поскапо во истиот реон, или станови со истата цена во други населби?';
  }

  /** The pre-FSM fire lane's wrapper: the ask-builder plus the interceptor
   *  bookkeeping (user turn is NOT yet in history there) — pushes the turn,
   *  persists, logs the enrichment row and sends. */
  private async presentCriteriaDoneChoice(session: ChatSession): Promise<boolean> {
    const ask = await this.criteriaDoneAsk(session);
    if (ask == null) return false;
    pushHistory(session, { role: 'user', text: this.lastUserText ?? '' }, this.cfg.maxHistory);
    pushHistory(session, { role: 'assistant', text: ask }, this.cfg.maxHistory);
    this.deps.sessions.set(session);
    if (this.deps.enrichment) {
      try {
        this.deps.enrichment.insert({ chatId: session.chatId, state: 'presentation',
          eventType: 'MORE_OPTIONS_DONE', userMsg: this.lastUserText ?? '',
          replyText: ask, replySource: 'deterministic', bankKey: 'batch.done.choice' });
      } catch { /* ignore */ }
    }
    await this.sendRaw(session, ask, 'deterministic');
    return true;
  }

  private async presentPricierBatch(session: ChatSession, text: string,
      overrideLocation?: string): Promise<boolean> {
    const anchorEb = session.slots.interestedPropertyId ?? session.slots.propertyId
      ?? (session.slots.presentedIds?.length ? session.slots.presentedIds[session.slots.presentedIds.length - 1] : undefined);
    const anchor = anchorEb != null
      ? await this.deps.properties.getById(anchorEb).catch(() => undefined)
      : undefined;
    const anchorIsStudio = anchor?.studio === true;
    const es = extractSlots(text);
    const location = overrideLocation ?? es.location ?? session.slots.location ?? anchor?.location;
    const pool = (await this.deps.properties.candidates({
      location,
      bedrooms: es.bedrooms ?? session.slots.bedrooms ?? anchor?.bedrooms,
      sqm: es.sqm ?? session.slots.sqm,
      // The type lock rides even here (the [20:33] capture): a bedroom-axis
      // residential funnel never lifts to a деловен простор because it is
      // the priciest row in the area.
      business: this.businessPoolLock({ ...session.slots,
        business: es.business ?? session.slots.business ?? anchor?.business }) ?? undefined,
      house: es.house ?? session.slots.house ?? anchor?.house,
      garsonjera: es.garsonjera ?? session.slots.garsonjera,
      plac: es.plac ?? session.slots.plac,
      service: session.slots.service ?? anchor?.service,
      exclude: session.slots.presentedIds ?? [],
      // The money-lift: the pricier serve never inherits the standing cap —
      // “budget” stays out of this candidates() call ON PURPOSE ([25:2x] case).
    }))
      .filter(p => (session.slots.garsonjera === undefined && anchor != null
        ? anchorIsStudio || p.studio !== true : true))
      .filter(p => (anchor?.price === undefined || (p.price ?? -Infinity) > anchor.price))
      .sort((a, b) => (b.price ?? -Infinity) - (a.price ?? -Infinity))
      .slice(0, 2);
    if (pool.length === 0) return false;
    const intro = pickVariant('pricier.search.intro', { recent: assistantTexts(session) })
      ?? 'Разбирам — еве нешто поскапо со истите карактеристики:';
    await this.serveBatch(session, pool, intro, 'BUDGET_UP_SEARCH', 'pricier.search.intro');
    return true;
  }

  private async presentCheaperBatch(session: ChatSession, intro: string,
      opts?: { freshPool?: boolean }): Promise<boolean> {
    // ANCHOR SUPPLEMENTS (the [14:46] rule): the cheaper search anchors on
    // the property the client CHOSE — "nesto poeKtino vo toj reon" right
    // after EB 74 must mean the SAME bedroom count and the SAME type in the
    // SAME naselba. The slots alone were empty in the capture, so the old
    // untyped pool served a garsoњera and a Влаe house. The focused
    // property supplies whichever axis the client did NOT restate here.
    const anchorEb = session.slots.interestedPropertyId ?? session.slots.propertyId
      ?? (session.slots.presentedIds?.length ? session.slots.presentedIds[session.slots.presentedIds.length - 1] : undefined);
    const anchor = anchorEb != null
      ? await this.deps.properties.getById(anchorEb).catch(() => undefined)
      : undefined;
    const anchorIsStudio = anchor?.studio === true;
    // Area-locked pool, already-shown rows EXCLUDED (never re-serve a row the
    // client rejected — the anti-loop convention) — EXCEPT a freshPool serve
    // (the [14:47] correction) where the client is asking AGAIN for the same
    // characteristics and the presented row IS the answer. The slots object is COPIED
    // (a cheaper-ask must never let one branch mutate the live slots for the
    // other) and the batch is sorted cheapest-first — candidates() orders by
    // budget proximity, which is meaningless when the client's entire ask is
    // “something cheaper”.
    // (No anchor-sqm floor: candidates() reads `sqm` as a MINIMUM, and a
    // cheaper same-bedroom flat a few м² smaller than the anchor (EB 77 at
    // 70 м² vs. the 72 м² anchor) is exactly the serve the client asked
    // for — the anchor's size must never filter its own cheaper pool. A
    // client-stated minimum (slots.sqm from THIS search) still applies.
    const poolA = (await this.deps.properties.candidates({
      location: session.slots.location,
      bedrooms: session.slots.bedrooms ?? anchor?.bedrooms,
      sqm: session.slots.sqm,
      business: session.slots.business ?? anchor?.business,
      house: session.slots.house ?? anchor?.house,
      garsonjera: session.slots.garsonjera,
      plac: session.slots.plac,
      service: session.slots.service,
      exclude: opts?.freshPool ? [] : (session.slots.presentedIds ?? []),
    }))
      // Same-characteristics discipline: unless the client asked for studios
      // or the anchor itself IS one, a studio row is NOT the "same
      // characteristics" serve (the [14:46] mis-serve — a garsoњera riding a
      // two-bedroom context).
      .filter(p => (session.slots.garsonjera === undefined && anchor != null
        ? anchorIsStudio || p.studio !== true : true))
      .filter(p => (anchor?.price === undefined || (p.price ?? Infinity) < anchor.price))
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    if (poolA.length > 0) {
      await this.serveBatch(session, poolA.slice(0, 2), intro, 'CHEAPER_SEARCH', 'price.shy');
      return true;
    }
    // The [14:46] brief: when NOTHING cheaper with the same characteristics
    // exists in the naselba, Lina ASKS which fallback the client wants —
    // cheaper+smaller in the SAME naselba, or the same characteristics in
    // NEIGHBOURING naselbi — but only when at least one of the two pools has
    // rows (otherwise the old widen offer below keeps the funnel alive).
    const poolB = (await this.deps.properties.candidates({
      location: session.slots.location,
      service: session.slots.service,
      exclude: session.slots.presentedIds ?? [],
    }))
      .filter(p => (anchor?.price === undefined || (p.price ?? Infinity) < anchor.price))
      // "казали" — actually SMALLER than the anchor: a same-size cheaper flat
      // would have been pool A; B is the smaller-sqm fallback.
      .filter(p => (anchor?.sqm === undefined || p.sqm === undefined || p.sqm < anchor.sqm))
      .sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    const poolC = (await this.deps.properties.candidates({
      bedrooms: session.slots.bedrooms ?? anchor?.bedrooms,
      sqm: session.slots.sqm ?? anchor?.sqm,
      business: session.slots.business ?? anchor?.business,
      house: session.slots.house ?? anchor?.house,
      garsonjera: session.slots.garsonjera,
      plac: session.slots.plac,
      service: session.slots.service,
      exclude: session.slots.presentedIds ?? [],
    })).sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity));
    // On an ALREADY-DRAINED area (price-shy contract) the exhausted ask has
    // already offered other neighborhoods — the cheaper ask IS consent to
    // widen, so the two-way ask must NOT re-fire here; the lane falls
    // straight through to the widen presentation below.
    if ((poolB.length > 0 || poolC.length > 0) && !session.slots.areaExhausted) {
      session.slots.pricePriority = true;
      session.slots.cheaperChoicePending = true;
      session.slots.cheaperAnchor = {
        bedrooms: session.slots.bedrooms ?? anchor?.bedrooms,
        sqm: session.slots.sqm ?? anchor?.sqm,
        house: anchor?.house ?? undefined,
        business: anchor?.business ?? undefined,
        price: anchor?.price,
      };
      const ask = pickVariant('price.shy.choice', { recent: assistantTexts(session) })
        ?? 'Во таа населба нема поевтини станови со истите карактеристики. Дали да Ви покажам помали станови во истата населба, или станови со истите карактеристики во соседните населби?';
      pushHistory(session, { role: 'user', text: this.lastUserText ?? '' }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: ask }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      if (this.deps.enrichment) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: 'closing', eventType: 'CHEAPER_SEARCH_EMPTY', userMsg: this.lastUserText ?? '', replyText: ask, replySource: 'deterministic', bankKey: 'price.shy.choice' }); } catch { /* ignore */ } }
      await this.sendRaw(session, ask, 'deterministic');
      return true;
    }
    // No cheaper options left in the area: OFFER other neighborhoods (bank
    // ask) — the option to widen, never a silent spill and never the phone ask.
    if (!session.slots.areaExhausted) {
      session.slots.areaExhausted = true;
      session.slots.pricePriority = true;
      const ask = pickVariant('price.shy.empty', { recent: assistantTexts(session) })
        ?? 'Ја проверив понудата во таа населба — сè е над Вашиот буџет. Дали да Ви покажам најпристапни опции од други населби?';
      pushHistory(session, { role: 'user', text: this.lastUserText ?? '' }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: ask }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      if (this.deps.enrichment) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: 'closing', eventType: 'CHEAPER_SEARCH_EMPTY', userMsg: this.lastUserText ?? '', replyText: ask, replySource: 'deterministic', bankKey: 'price.shy.empty' }); } catch { /* ignore */ } }
      await this.sendRaw(session, ask, 'deterministic');
      return true;
    }
    // Area already drained AND nothing cheaper: release the lock and widen —
    // the “cheaper” ask itself is consent to look at the rest of the city,
    // cheapest-first, so the search never dead-ends into contact pushes.
    session.slots.areaExhausted = false;
    session.slots.location = undefined;
    const wide = (await this.deps.properties.candidates({
      bedrooms: session.slots.bedrooms,
      sqm: session.slots.sqm,
      business: session.slots.business,
      house: session.slots.house,
      garsonjera: session.slots.garsonjera,
      plac: session.slots.plac,
      service: session.slots.service,
      exclude: session.slots.presentedIds ?? [],
    })).slice(0, 2);
    if (wide.length > 0) {
      session.slots.presentedIds = [...(session.slots.presentedIds ?? []), ...wide.map(p => p.id)];
      session.slots.currentBatch = wide.map(p => p.id);
      session.state = 'presentation';
      await this.landmarks.enrich(wide);
      const wideIntro = pickVariant('price.shy.empty', { recent: assistantTexts(session) })
        ?? 'Во таа населба нема повеќе пристапни опции — еве најевтините од другите населби.';
      const reply = `${wideIntro}\n\n${wide.map(p => buildPropertyCard(p)).join('\n\n')}\n\n${pickCloser(PRESENTATION_CLOSERS_ALL, session.history.length)}`;
      pushHistory(session, { role: 'user', text: this.lastUserText ?? '' }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      if (this.deps.enrichment) { try { this.deps.enrichment.insert({ chatId: session.chatId, state: 'closing', eventType: 'CHEAPER_SEARCH_WIDEN', userMsg: this.lastUserText ?? '', replyText: reply, replySource: 'deterministic', bankKey: 'price.shy.empty' }); } catch { /* ignore */ } }
      await this.sendRaw(session, reply, 'deterministic');
      return true;
    }
    // Genuinely nothing left anywhere: the exhausted line (bank-backed).
    session.slots.areaExhausted = true;
    const exhausted = exhaustedLine(session.slots.location, assistantTexts(session))
      ?? NO_MORE_ALTERNATIVES_LINE(session.slots.location);
    pushHistory(session, { role: 'user', text: this.lastUserText ?? '' }, this.cfg.maxHistory);
    pushHistory(session, { role: 'assistant', text: exhausted }, this.cfg.maxHistory);
    this.deps.sessions.set(session);
    await this.sendRaw(session, exhausted, 'deterministic');
    return true;
  }

  /** DUAL-BUDGET CAPTURE (the [12:33] business capture): the client delivers
   * the money PER SERVICE in two messages — «za kirija do 1000 evra», then
   * «za kupuvanje do 2000000». Each message carries ONE service (a word the
   * raw text may own even when the classifier event does not) + ONE budget
   * and nothing else: it banks per-service, and when the SECOND service's
   * budget arrives while the first is on file, the funnel becomes a
   * dual-service search — slots.service and slots.budget retire (a single
   * service would pin every serve to one segment and a single budget would
   * govern both), slots.dualService drives the paired rent/buy serve, and
   * applySlots is skipped for this pure delivery.
   * Pure deliveries only: a type/size/area word makes the event a full
   * search, whose service applies through applySlots as before. */
  private captureDualBudgets(session: ChatSession, text: string, ev: Event): boolean {
    // Pure money deliveries only: type/size/area words make it a full search.
    if (!ev.budget || ev.bedrooms || ev.sqm || ev.house !== undefined
      || ev.business || ev.plac || ev.yard || ev.location || ev.anywhere) return false;
    // The classifier's event can DROP the money-word's service noun — the
    // [12:33] archive: «za kupuvanje do 2000000» left service unknown while
    // the raw text plainly names the buy leg. The message's own words are
    // the anchor when the event is poor.
    const svc: Service | undefined = ev.service
      ?? (extractSlots(text).service)
      ?? (/((kupuvanj)|(kupuvanе)|(купувањ)|(kupuvam)|(купувам)|(kupam)|(купам)|(kupi\b)|(купи\b)|(prodazb)|(продажб)|(prodav)|(продав))/iu.test(text)
        ? 'buy'
        : /((kirij)|(кириј)|(iznajm)|(изнајм)|(najmam)|(најмам)|(naстам)|(наjм)|(izdav)|(издав)|(rent(?:am|iram|irav|ira|irat|im)?\b)|(\brent\b))/iu.test(text)
          ? 'rent' : undefined);
    if (!svc) return false;
    const budget = String(ev.budget);
    if (svc === 'rent') session.slots.rentBudget = budget;
    else session.slots.buyBudget = budget;
    const otherBudget = svc === 'rent' ? session.slots.buyBudget : session.slots.rentBudget;
    if (otherBudget !== undefined) {
      // PAIRED: both services' budgets are on file → dual-service funnel.
      // (Whether the first leg had already pinned its service into slots or
      // sat unapplied — the classifier can drop the service noun on BOTH
      // legs — two different-service budgets means the search covers both.)
      session.slots.dualService = true;
      session.slots.service = undefined;
      session.slots.budget = undefined;
      session.slots.bothServices = undefined;
      return true; // fully handled — applySlots skipped this turn
    }
    // FIRST LEG: apply the legacy pair HERE — an event-only applySlots would
    // drop the service when the classifier's event carries budget without
    // service (the [12:33] base case: the client answered, the funnel still
    // re-asked buy-vs-rent).
    session.slots.service = svc;
    session.slots.budget = budget;
    session.slots.bothServices = undefined;
    return true; // fully handled — applySlots skipped this turn
  }

  private applySlots(session: ChatSession, ev: Event): void {
    if (ev.service) { session.slots.service = ev.service; session.slots.bothServices = undefined; }
    // Clients type Latin ("centar", "kapistec"); canonicalize to Cyrillic so
    // replies and the deterministic no-match lines read naturally.
    // A MULTI-WORD place is never collapsed into a one-word district alias: the
    // alias table maps «Маџар Маало» → «Центар» (it IS in Центар), and keeping
    // the collapse is exactly how a client who named one street was served the
    // whole district's pair (the [01:17] capture). The named micro-area stays,
    // and the search reads it off the ads (see isAdDefinedArea).
    if (ev.location) {
      const canon = normalizeLocation(ev.location);
      session.slots.location = /\s/.test(ev.location.trim()) && !/\s/.test(canon.trim())
        ? ev.location.trim()
        : canon;
    }
    // POI anchor ("okolu Kapitol Biser"): stored so loadProps can rank the
    // candidates by distance TO THE ANCHOR, not just the neighborhood (the
    // [22:41] transcript presented an apartment nowhere near Бисер/Капитол).
    // A new anchor replaces a stale one; a message with no anchor keeps the old.
    if ((ev as { poiAnchor?: string }).poiAnchor) session.slots.poiAnchor = (ev as { poiAnchor?: string }).poiAnchor;
    if (ev.bedrooms) {
      session.slots.bedrooms = ev.bedrooms;
      // An EXACT count supersedes a bedroom RANGE ([09:17] contract: "a new
      // client request overrides"): "daj so edna" retires the alternation.
      session.slots.bedroomsMin = undefined;
      session.slots.bedroomsMax = undefined;
      session.slots.bedroomsAlt = undefined;
    }
    // Bedroom RANGE (the [09:17] fix): "edna ili dve" arms the alternating
    // 1-спална/2-спални presentation — the range NEVER becomes a minimum
    // bedrooms slot (exact-category semantics; candidates() handles it). A
    // range event carries no exact count, so the exact retirement above
    // cannot fire on the same message.
    if (ev.bedroomsMin !== undefined && ev.bedroomsMax !== undefined) {
      session.slots.bedroomsMin = ev.bedroomsMin;
      session.slots.bedroomsMax = ev.bedroomsMax;
      session.slots.bedroomsAlt = true;
    }
    if (ev.sqm) session.slots.sqm = ev.sqm;
    if (ev.business !== undefined) session.slots.business = ev.business;
    if (ev.house !== undefined) session.slots.house = ev.house;
    if (ev.budget) session.slots.budget = ev.budget;
    if (ev.anywhere) session.slots.anywhere = true;
    if (ev.sizeWaived) session.slots.sizeWaived = true;
    // A FRESH bedroom/sqm criterion retires the size waiver ("nebitno"): the
    // client named a size after all, so the biggest-first ordering must not
    // ride along with a search the waiver no longer governs (21:40 contract:
    // adapt with the flow). A waiver-only message never carries bedrooms/sqm,
    // so ordering in the same applySlots pass is safe.
    if ((ev.bedrooms || ev.sqm) && ev.sizeWaived === undefined) session.slots.sizeWaived = undefined;
    // A fresh bedroom RANGE retires the size waiver too — the client named a
    // size after all ("edna ili dve" IS a size answer, [09:17]).
    if (ev.bedroomsMin !== undefined && ev.sizeWaived === undefined) session.slots.sizeWaived = undefined;
    // [17:14] pomalo resolution: a fresh bedroom/sqm/range criterion means the
    // client answered the "smaller = how many bedrooms?" ask — the pomalo ask
    // must not re-fire on every later message. "2 spalni"+ (2+ bedrooms, an
    // EXACT count, not a range's lower end) is not "small" at all: the flag
    // clears and the normal lane serves. "garsonjera" retires it via the
    // garsonjera slot below (a studio IS the small answer).
    if ((ev.bedrooms !== undefined || ev.sqm !== undefined) && ev.bedroomsMin === undefined) session.slots.pomaloSize = undefined;
    if (ev.bedrooms !== undefined && ev.bedrooms >= 2) session.slots.pomaloSize = undefined;
    if (ev.pricePriority) session.slots.pricePriority = true;
    if (ev.garsonjera) { session.slots.garsonjera = true; session.slots.pomaloSize = undefined; }
    // STRETCH-OVERWRITE (the [02:03] capture): a client who ACCEPTED garsonjera
    // as a stretch ("Edna ili dve, a mozhe i garsonjera ako e dobra") and then
    // names a concrete SIZE ("a dvosobno nesto so posebna spalna?") has MOVED
    // OFF the studio category — the ≤35 м² filter left armed re-locked that
    // later search to studios and the wrong-type have-not mis-served to a
    // dvosobno ask ("Моментално немам слободна гарсоњера…"). A fresh
    // bedroom/sqm/range criterion without a studio word IN THE SAME message
    // retires the flag; a same-message mixed parse (e.g. `ev.garsonjera` in a
    // range burst) is protected by the negation. Same rule as the
    // exhausted-pivot seam (see class inbox ~4434). Mirrors the sizeWaived
    // retirement above: the newest size spec wins the size axis.
    if ((ev.bedrooms !== undefined || ev.sqm !== undefined || ev.bedroomsMin !== undefined) && !ev.garsonjera) {
      session.slots.garsonjera = undefined;
    }
    // Plac/yard are CATEGORIES (like garsonjera): a plac never coexists with
    // a house/business search, and a yard need implies the house category.
    if (ev.plac) { session.slots.plac = true; session.slots.house = undefined; session.slots.business = undefined; }
    if (ev.yard) { session.slots.yard = true; if (!ev.business) session.slots.house = true; }
    if ((ev.plac || ev.yard) && !ev.garsonjera) session.slots.garsonjera = undefined;
    if (ev.propertyId) session.slots.propertyId = ev.propertyId;
    // Visit-time MERGE (the split [14:35] intake): a bare clock ("6 SAAT")
    // completing a day-only phrase ("VO PONEDELNIK MOZAM") replaces the
    // stored day-only slot — the owner ask then reads ONE phrase with day+
    // clock, which normalizeOwnerTime resolves. The clock comes FIRST: the
    // event phrase is the new information, the stored day is context. A term
    // with its own day word replaces the slot outright.
    // CLOCK-CARRYING STORE ([12:43] lesson): a stored phrase with a clock
    // ("NE MOZAM VO 18:00…" ping-pong, "во 18:00" counters) never donates its
    // day to a new clock-bearing proposal — "MOZAM VO 19:00" after a
    // rejection must re-ask the owner with 19:00, never a resurrect of the
    // rejected 18:00. The donation applies only to day-only stored context.
    if (ev.visitTime) {
      const storedVt = session.slots.visitTime ?? '';
      const storedHasClock = storedVt.length > 0 && hasClockHint(storedVt);
      if (hasDayWord(ev.visitTime) || !hasDayWord(storedVt) || (storedHasClock && !detectVagueTime(storedVt))) {
        session.slots.visitTime = ev.visitTime;
      } else if (storedHasClock) {
        // STORED DAY + VAGUE CLOCK ("MOZAM VO VTORNIK POSLE 5"): the precise
        // follow-up ("PA NEKA BIDE PET I POL" = 17:30) REFINES the same day
        // rather than replacing it. Donate the stored day and drop the vague
        // clock so the owner ask reads the correct weekday AND hour — the
        // [22:50] transcript asked the owner about НЕДЕЛА 05:30 instead of
        // ВТОРНИК 17:30.
        const storedDay = extractDayWord(storedVt);
        session.slots.visitTime = storedDay ? `${storedDay} ${ev.visitTime.trim()}` : ev.visitTime;
      } else {
        // DAY-FIRST order (the [12:43] contract): hasClockHint's
        // day-trailing-hour arm reads "DAY … hour" — a clock-first
        // "6, VO PONEDELNIK MOZAM" is invisible to it and the owner ask
        // silently dropped the hour.
        session.slots.visitTime = `${storedVt.trim()} ${ev.visitTime.trim()}`;
      }
    }
    if (ev.name) session.slots.name = ev.name;
    if (ev.phone) session.slots.phone = ev.phone;
  }

  private slotsComplete(s: ChatSession): boolean {
    // "Било каде" (anywhere) satisfies the location criterion AND waives the
    // bedroom requirement — a flexible client gets the budget-driven city-wide
    // presentation ("bilo kade do 250" → rent options till 250) instead of a
    // location/bedrooms loop they explicitly didn't care about.
    // Same for sizeWaived ("nebitni se spalnite" — the 13:53 loop: bedrooms
    // question kept repeating although the client had waived it).
    const loc = !!s.slots.location || !!s.slots.anywhere;
    if (s.slots.business) {
      // Dual-service funnel (the [12:33] capture): the service and budget
      // criteria are satisfied by the PAIRED budgets — slots.service/'
      // slots.budget are deliberately retired in that mode.
      return (!!s.slots.service || !!s.slots.dualService) && loc && !!s.slots.sqm
        && (!!s.slots.budget || !!s.slots.dualService);
    }
    if (s.slots.dualService) {
      // Dual-service funnel without a type: the service criterion is satisfied
      // by the PAIRED budgets; only the size criteria still render it complete.
      return loc
        && (!!s.slots.bedrooms || (s.slots.bedroomsMin !== undefined && s.slots.bedroomsMax !== undefined)
          || !!s.slots.anywhere || !!s.slots.sizeWaived || !!s.slots.garsonjera || !!s.slots.plac || !!s.slots.yard)
        && !!s.slots.rentBudget && !!s.slots.buyBudget;
    }
    // garsonjera: the explicit studio category IS the size answer (19:34 —
    // "garsonjera mi treba do 250" must PRESENT, not loop "Колку спални…").
    // Same for plac ("плац за градење" names the type outright) and yard
    // ("со двор" — the outdoor need replaces any спални spec).
    return !!s.slots.service && loc && (!!s.slots.bedrooms || (s.slots.bedroomsMin !== undefined && s.slots.bedroomsMax !== undefined)
      || !!s.slots.anywhere || !!s.slots.sizeWaived || !!s.slots.garsonjera || !!s.slots.plac || !!s.slots.yard) && !!s.slots.budget;
  }

  private async loadProps(session: ChatSession, areaRequested = false, seeOffers = false): Promise<Property[]> {
    const s = session.state;
    if (s === 'property_query') {
      const id = session.slots.propertyId;
      if (!id) return [];
      const p = await this.deps.properties.getById(id);
      if (!p) return [];
      await this.landmarks.enrich([p]); // approximate location, never the street
      return [p];
    }
    if (s === 'presentation') {
      // Alternatives engine: every presentation shows the NEXT 2 candidates —
      // same area first (price-closest to budget), then other areas — and every
      // shown EB is excluded from later batches. Never re-asks discovery.
      const shown = session.slots.presentedIds ?? [];
      if (session.slots.propertyId) shown.push(session.slots.propertyId); // already discussed
      if (session.slots.soldEb) shown.push(session.slots.soldEb);
      // Mixed-types ask (the [02:02] capture): the garsonjera stretch + a
      // rooms spec — both passes below sort BIGGEST-in-budget first so the
      // lead card is the biggest unit the money buys.
      const mixedTypes = !!session.slots.garsonjera
        && (session.slots.bedrooms !== undefined || session.slots.bedroomsMin !== undefined);
      const sqmDesc = (!seeOffers && (!!session.slots.sizeWaived || mixedTypes)) === true;
      // `let` — the mixed-types pair union below can replace the pool.
      let candidates = await this.deps.properties.candidates({
        location: session.slots.location,
        bedrooms: session.slots.bedrooms,
        // Bedroom RANGE ([09:17]): exact 2…3-rooms pool, both ends required.
        bedroomsMin: session.slots.bedroomsMin,
        bedroomsMax: session.slots.bedroomsMax,
        sqm: session.slots.sqm,
        business: session.slots.business,
        house: session.slots.house,
        // "garsonjera mi treba" — the STUDIO category is the criterion: filter
        // to small units (≤ 35 м²), never by a fabricated спални number. When
        // the small pool would be empty, keep the broad pool (the feed has few
        // tagged rows — the category prefix + client self-filter do the rest).
        garsonjera: session.slots.garsonjera,
        // Land-plot and yard categories flow through like every other type
        // (the 22:53 sweep): a plac ask presents plac rows only; a yard need
        // leads with houses that HAVE a yard (fallback: any house).
        plac: session.slots.plac,
        yard: session.slots.yard,
        service: session.slots.service,
        budget: session.slots.budget,
        exclude: shown,
        // see-offers ("помало нешто"): SMALLEST м² first, going up — Lina
        // answers the "what do you have?" question with the smallest offer,
        // then progressively larger ones, instead of re-asking the missing sqm.
        sortBySqm: seeOffers,
        // Size waived ("nebitno"): the client only capped the money, so the
        // biggest in-budget unit LEADS — the money buys space, not bedrooms.
        // When the client later names a size ("edna spalna"), the pivot flow
        // re-searches with bedrooms and rebuilds the ladder (existing lane).
        // A MIXED stretch ask leads biggest-first too (the [02:02] contract).
        sortBySqmDesc: sqmDesc,
        // Popularity order (the 21:16 rule): explicit "било каде", or a pure
        // budget correction after a presentation ("A ZA 250?" — the area pivot
        // sets anywhere=true), leads with the most popular neighborhoods
        // (Центар, Капиштец, Карпош, Аеродром, …): central-first,
        // center-outward. A pinned location stays a hard lock; a silently
        // widened search keeps the price-distance ladder contract.
        sortByPopularity: !!session.slots.anywhere && !session.slots.location,
      });
      // MIXED-TYPES PAIRS (the [02:02] capture): the stretch ask sets BOTH the
      // studio category AND a rooms range ("Edna ili dve, a mozhe i garsonjera
      // ako e dobra" + budget). The studio filter alone collapses the pool to
      // ≤35 м² rows and silently DROPS the rooms-range ask (that serve showed
      // one garsonjera and no spaced option at all). When the session still
      // carries studio AND a concrete size, garsonjera is the STRETCH, not the
      // primary — the pool becomes the UNION of both passes, paired by
      // interleaveMixedPairs: the biggest in-budget unit leads, then the
      // alternate type, alternating on. A later pure-size ask retires the
      // flag upstream (applySlots), so this never re-fires after the client
      // has moved off the category.
      if (mixedTypes) {
        const regular = await this.deps.properties.candidates({
          location: session.slots.location,
          bedrooms: session.slots.bedrooms,
          bedroomsMin: session.slots.bedroomsMin,
          bedroomsMax: session.slots.bedroomsMax,
          sqm: session.slots.sqm,
          business: session.slots.business,
          house: session.slots.house,
          plac: session.slots.plac,
          yard: session.slots.yard,
          service: session.slots.service,
          budget: session.slots.budget,
          exclude: shown,
          sortBySqm: seeOffers,
          sortBySqmDesc: sqmDesc,
          sortByPopularity: !!session.slots.anywhere && !session.slots.location,
        });
        if (regular.length > 0) candidates = interleaveMixedPairs(regular, candidates);
      }
      // DUAL-SERVICE PAIRS (the [12:33] business capture): the client banked a
      // budget PER SERVICE («za kirija do 1000 evra» + «za kupuvanje do
      // 2000000») — every batch is a PAIR, one RENT card + one BUY card, each
      // under its own budget, from the same pinned area and type. The single
      // pass above ran without service/budget (both are retired in this mode),
      // so the pool is the interleaved union of two typed passes.
      if (session.slots.dualService) {
        const dualPass = (service: Service | undefined, budget: string | undefined) =>
          this.deps.properties.candidates({
            location: session.slots.location,
            bedrooms: session.slots.bedrooms,
            bedroomsMin: session.slots.bedroomsMin,
            bedroomsMax: session.slots.bedroomsMax,
            sqm: session.slots.sqm,
            business: session.slots.business,
            house: session.slots.house,
            plac: session.slots.plac,
            yard: session.slots.yard,
            service,
            budget,
            exclude: shown,
            sortBySqm: seeOffers,
            sortByPopularity: !!session.slots.anywhere && !session.slots.location,
          });
        const rentPool = await dualPass('rent', session.slots.rentBudget);
        const buyPool = await dualPass('buy', session.slots.buyBudget);
        // APARTMENT-TYPED DUAL POOLS (the pair-serve replay leak): type-less
        // candidates() keeps business rows — the «стан» funnel only bans HOUSES
        // there (house=false), so the pair's RENT card presented a деловен
        // простор (EB 42, 126 м², „Се изнајмува деловен простор“) under a
        // „Станот под Евидентен број“ rubric. This mirrors the [12:33]
        // contract's other side — every batch is one RENT card + one BUY card,
        // both of the FUNNELED type: an apartment-shaped funnel (explicit стан
        // / typed rooms / garsonjera — the same test the criteria-type guard
        // applies to the plain pool downstream) never serves a typed business
        // row in either leg. Filtering happens BEFORE the interleave so the
        // rent→buy alternation pairs actual survivors: a washed-out leg just
        // tails the other one (interleaveServicePairs semantics).
        const apartmentTyped = session.slots.house !== true
          && (session.slots.house === false
            || session.slots.bedrooms !== undefined
            || session.slots.garsonjera);
        const rentLeg = apartmentTyped ? rentPool.filter(p => p.business !== true) : rentPool;
        const buyLeg = apartmentTyped ? buyPool.filter(p => p.business !== true) : buyPool;
        if (rentLeg.length > 0 || buyLeg.length > 0) candidates = interleaveServicePairs(rentLeg, buyLeg);
      }
      // Studio-relax: the area has NO garsonjera at all — falling back to the
      // plain no-match loses the "give him what he wants" instruction. Retry
      // WITHOUT the category filter (same budget/area); the presentation
      // branches detect garsonjera-without-garsonjera-results and introduce        // the closest units honestly ("немам гарсоњера, но еве мало станче").
        // [17:14] ladder: a garsonjera IS a one-room home — before the broad
        // size-sorted retry, try ONE-BEDROOM flats (feed 2-rooms) in budget.
        // The honest "немам гарсоњера…" prefix still fires (no exact studio in
        // the pool), and the cards are the smallest honest step up — not
        // size-sorted duplexes.
        let relaxedCandidates = candidates;
        if (session.slots.garsonjera && candidates.length === 0) {
          const oneRoom = await this.deps.properties.candidates({
            location: session.slots.location,
            bedrooms: 2, // feed convention: 2 rooms = 1 спална
            business: session.slots.business,
            house: session.slots.house,
            service: session.slots.service,
            budget: session.slots.budget,
            exclude: shown,
          });
          if (oneRoom.length > 0) {
            relaxedCandidates = oneRoom;
          } else {
            relaxedCandidates = await this.deps.properties.candidates({
              location: session.slots.location,
              sqm: session.slots.sqm,
              business: session.slots.business,
              house: session.slots.house,
              service: session.slots.service,
              budget: session.slots.budget,
              exclude: shown,
              // SMALLEST first — the relaxed line says "мало станче", so the
              // cards must lead with the smallest units in budget, not
              // price-closest 70-m² duplexes.
              sortBySqm: true,
              sortByPopularity: !!session.slots.anywhere && !session.slots.location,
            });
          }
        }
      const pool = relaxedCandidates;
      // CRITERIA-TYPE GUARD (the V16K11 Vlae capture): the client searched a
      // 1-спална APARTMENT ≤100k; the ladder walked EB 46/54, and the next
      // batch served EB 55 — a 240 m² HOUSE — because the row mapped as a
      // type-less wildcard. An apartment-SHAPED search must never present a
      // typed house: explicit стан (house === false) or an exact room count
      // (bedrooms / garsonjera — rooms count presumes a flat) drops house rows
      // from the pool BEFORE the ladder carves batches. Type-less searches
      // (bare budget) keep houses eligible, a bedroom RANGE is deliberately
      // not apartment-shaped (houses ride it as bedroom-less wildcards), an
      // EXPLICIT куќа search (house === true) keeps them regardless of
      // bedroom details ("DVE SPALNI" on a house funnel is a size spec, not
      // a flat flip). BUSINESS ROWS are the same complaint family (the
      // [madjari] capture): they used to "keep their pre-existing wildcard
      // behavior", and the [madjari] money-anchor serve led a "dve spalni
      // stan" presentation with EB 56 — a 210 м² деловен простор — because
      // type-less candidates() keeps business rows. The owner's rule is
      // absolute: JUNK CAN NEVER BE SERVED — an apartment-shaped funnel never
      // serves a деловен row either, and an explicitly typed деловен funnel
      // (business === true) keeps its own family. Mirrors the dual-pair
      // contract's apartmentTyped filter applied to every dual leg.
      if (pool.length > 0
        && session.slots.house !== true
        && (session.slots.house === false
          || session.slots.bedrooms !== undefined
          || session.slots.garsonjera)) {
        const forbidden = session.slots.business === true
          ? pool.filter(p => p.house === true)
          : pool.filter(p => p.house === true || p.business === true);
        if (forbidden.length > 0) {
          const forbiddenIds = new Set(forbidden.map(p => p.id));
          // ALIASING: `pool` and `relaxedCandidates` are the SAME array — the
          // kept rows must be computed BEFORE `pool.length = 0`, otherwise the
          // filter below reads an already-drained array and the whole honest
          // serve empties into a junk no-match (the [madjari] probe caught it).
          const kept = relaxedCandidates.filter(p => !forbiddenIds.has(p.id));
          pool.length = 0;
          pool.push(...kept);
        }
      }
      // LAST-RESORT TYPE FLOW (the [23:57–59] house capture): a PINNED area
      // with zero matching properties must not dead-end in the no-match loop —
      // the owner contract: "if they don't match, at least offer something
      // different as an option". Retry the SAME specs city-wide once; the pool
      // fills with the closest honest alternatives (popularity order) and the
      // area is marked drained, so a rejection keeps walking other areas and
      // the exhausted ask still fires when the widened pool drains too. Only
      // TYPED searches (куќа / плац / деловен) take this tier — the [23:59]
      // widen answer ("moze i vo druga naselba") must show houses from OTHER
      // locations, never re-ask about a drained one. Plain apartment searches
      // keep the pinned ask-then-widen protocol (options come only AFTER the
      // ask — the stuck-loop tests pin that contract).
      if (pool.length === 0 && session.slots.location && this.deps.properties.healthy
        && (session.slots.house === true || session.slots.plac || session.slots.business === true)) {
        const wide = await this.deps.properties.candidates({
          location: undefined,
          bedrooms: session.slots.bedrooms,
          bedroomsMin: session.slots.bedroomsMin,
          bedroomsMax: session.slots.bedroomsMax,
          sqm: session.slots.sqm,
          business: session.slots.business,
          house: session.slots.house,
          garsonjera: session.slots.garsonjera,
          plac: session.slots.plac,
          yard: session.slots.yard,
          service: session.slots.service,
          budget: session.slots.budget,
          exclude: shown,
          sortByPopularity: true,
        });
        // Locationless rows („Непозната“ address protocol) never ride the
        // fallback tiers — presenting a no-location row as a "match" is the
        // EB 56 mystery-property bug the stuck tests pin. The category cut
        // rides with it: the guard above is not re-run after this push, so a
        // куќа/плац funnel's city-wide fallback must not bring деловен rows
        // back into the pool (junk can never be served), while an explicit
        // деловен tier (business === true) keeps its own family.
        const wideLocated = wide.filter(p => !!p.location
          && (session.slots.business === true ? p.business === true : p.business !== true));
        if (wideLocated.length > 0) {
          session.slots.areaExhausted = true;
          pool.push(...wideLocated);
        }
      }
      // NO CROSS-CATEGORY TIER (the [09:29] business capture): an earlier
      // tier dropped the type filter when a typed pool was empty city-wide
      // ("at least offer something different"), so a 500 м² / 500.000 €
      // business ask was answered with two apartments after the "немам
      // деловен простор…" prefix. That answers a search the client never
      // made — the wrong CATEGORY is worse than an honest miss. The category
      // is now a hard invariant of every tier (area → city-wide); a typed
      // pool that is empty everywhere lands in typedNoMatchLine(), which
      // names the category and offers registration instead of other types.
      // POI-ANCHORED PRESENTATION (the [22:41] transcript): the client named a
      // MAP PLACE in the search phrase ("okolu Kapitol Biser"). The feed's
      // neighborhood lock (Аеродром) is too coarse — EB 89 was on the other
      // side of the area from Бисер/Капитол. When the anchor resolves to a
      // real POI, order the pool NEAREST-FIRST; when nothing in the pool is
      // within the honest 1.5 km walk radius, say so instead of pretending.
      if (session.slots.poiAnchor && this.landmarks && pool.length > 0) {
        const anchor = this.landmarks.findPlace(session.slots.poiAnchor);
        if (anchor) {
          const R = 6371000;
          const dist = (a: { lat?: number | null; lon?: number | null }, b: { lat: number; lon: number }): number | undefined => {
            if (typeof a.lat !== 'number' || typeof a.lon !== 'number' || a.lat === 0 || a.lon === 0) return undefined;
            const dLat = (b.lat - a.lat) * Math.PI / 180;
            const dLon = (b.lon - a.lon) * Math.PI / 180;
            const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * Math.PI / 180) * Math.cos(b.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
            return 2 * R * Math.asin(Math.sqrt(s));
          };
          const withDist = pool.map(p => ({ p, d: dist(p, anchor) }));
          const known = withDist.filter(x => x.d !== undefined);
          if (known.length > 0) {
            known.sort((a, b) => (a.d as number) - (b.d as number));
            // Rows with unknown coords keep the original (candidates) order
            // AFTER the known ones.
            const rest = withDist.filter(x => x.d === undefined).map(x => x.p);
            pool.length = 0;
            pool.push(...known.map(x => x.p), ...rest);
            if ((known[0].d as number) > 1500) {
              session.slots.poiAnchorTooFar = true;
            } else {
              session.slots.poiAnchorTooFar = undefined;
            }
          } else {
            session.slots.poiAnchorTooFar = true;
          }
        }
      }
      // candidates() already locks to the selected area(s) and never spills —
      // an exhausted area returns [] here, which routes to the "different area?"
      // ask instead of silently offering another neighborhood.
      // PRESENTATION LADDER: every batch is a PAIR of 2, walked as
      //   1st: price-closest to budget (the best-guess top picks)
      //   2nd: the CHEAPEST pair
      //   3rd: the MIDDLE pair (of what remains)
      //   4th+: the rest
      // …until the specs run out → alternativesExhausted → the "another
      // neighborhood?" offer. The ladder key is (location|anywhere, service,
      // budget): a NEW search rebuilds the queue from the top.
      const ladderKey = `${session.slots.anywhere ? '*' : session.slots.location ?? '-'}|${session.slots.service ?? '-'}|${session.slots.dualService ? `dual${session.slots.rentBudget}-${session.slots.buyBudget}` : session.slots.budget ?? '-'}|${session.slots.bedroomsAlt && session.slots.bedroomsMin !== undefined && session.slots.bedroomsMax !== undefined ? `alt${session.slots.bedroomsMin}-${session.slots.bedroomsMax}` : `b${session.slots.bedrooms ?? '-'}`}`;
      let queue = session.slots.ladderQueue ?? [];
      if (session.slots.ladderKey !== ladderKey || queue.length === 0) {
        if (session.slots.dualService) {
          // DUAL-SERVICE LADDER (the [12:33] contract): the interleaved pool
          // is walked IN ORDER so every batch of 2 stays a PAIR — one rent
          // card + one buy card. The price ladder's cheapest/middle re-carve
          // would serve two rents or two buys in a row.
          queue = pool.map(p => p.id);
        } else if (mixedTypes) {
          // MIXED-TYPES LADDER (the [02:02] contract): `pool` IS the
          // interleaved studio/regular union — walk it IN ORDER so every
          // batch of 2 stays a MIXED PAIR (one card per category, led by the
          // biggest in-budget unit). The price ladder's cheapest/middle
          // re-carve would shuffle the union into same-type batches, and the
          // range ladder's room-category buckets collapse the studio/
          // bigger distinction the client explicitly asked to alternate on.
          queue = pool.map(p => p.id);
        } else if (session.slots.bedroomsAlt && session.slots.bedroomsMin !== undefined && session.slots.bedroomsMax !== undefined) {
          // RANGE LADDER (the [09:17] contract): "give him one with one
          // bedroom, the second one with two bedrooms, until one category is
          // exhausted; then give him what is left". Interleave the exact
          // categories round-robin (smallest first), one card per category per
          // pair — batches of 2 naturally serve one of each. When a bucket
          // drains, the survivor continues alone. Within a category the
          // candidates() order stands (price-closest to budget leads). Rows
          // without a bedrooms tag ride at the tail (wildcards, never
          // duplicated across buckets).
          const cats: number[] = [];
          const buckets = new Map<number, Property[]>();
          for (let rooms = session.slots.bedroomsMin; rooms <= session.slots.bedroomsMax; rooms++) {
            const bucket = pool.filter(p => p.bedrooms === rooms);
            if (bucket.length > 0) { buckets.set(rooms, bucket); cats.push(rooms); }
          }
          const wildcards = pool.filter(p => !p.bedrooms).map(p => p.id);
          const interleaved: Property[] = [];
          let takeFirst = true;
          for (;;) {
            if (cats.length === 0) break;
            const idx = takeFirst ? 0 : cats.length - 1;
            const bucket = buckets.get(cats[idx])!;
            const next = bucket.shift();
            if (next) interleaved.push(next);
            if (bucket.length === 0) { buckets.delete(cats[idx]); cats.splice(idx, 1); }
            takeFirst = !takeFirst;
          }
          queue = [...interleaved.map(p => p.id), ...wildcards];
        } else {
        const firstTwo = pool.slice(0, 2).map(p => p.id);
        const remaining = pool.slice(2);
        const byPrice = [...remaining].sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) || a.eb - b.eb);
        const cheapest2 = byPrice.slice(0, 2).map(p => p.id);
        const afterCheap = byPrice.slice(2);
        const mid = Math.floor(afterCheap.length / 2);
        const middle2 = afterCheap.slice(Math.max(0, mid - 1), Math.max(0, mid - 1) + 2).map(p => p.id);
        const middleSet = new Set(middle2);
        const rest = afterCheap.filter(p => !middleSet.has(p.id)).map(p => p.id);
        queue = [...firstTwo, ...cheapest2, ...middle2, ...rest];
        }
        session.slots.ladderKey = ladderKey;
        session.slots.ladderQueue = queue;
      }
      const batch = queue.slice(0, 2)
        .map(id => pool.find(p => p.id === id))
        .filter((p): p is Property => !!p);
      session.slots.ladderQueue = queue.slice(batch.length);
      session.slots.presentedIds = [...shown, ...batch.map(p => p.id)];
      session.slots.currentBatch = batch.map(p => p.id);
      session.slots.alternativesExhausted = pool.length === 0;
      await this.landmarks.enrich(batch); // cards name a landmark, never a street
      return batch;
    }
    if (['closing', 'contact_collection', 'visit_scheduling', 'owner_checking', 'time_confirm'].includes(s)) {
      const id = session.slots.interestedPropertyId ?? session.slots.propertyId;
      if (!id) return [];
      const p = await this.deps.properties.getById(id);
      if (!p) return [];
      await this.landmarks.enrich([p]);
      return [p];
    }
    return [];
  }

  // ---------------- outbound ----------------

  private async sendRaw(session: ChatSession, text: string, source = 'deterministic'): Promise<void> {
    if (!canSend(session)) {
      console.error(`[budget] ${session.channel} 100/hr per-chat limit reached for ${session.chatId} — send dropped`);
      return;
    }
    if (this.deps.meta.get('monthly_initiated') >= this.cfg.monthlyInitiatedLimit) {
      console.error('[budget] monthly initiated-message limit reached — send blocked');
      return;
    }
    touchOutbound(session);
    // PERSIST the outbound clock ([01:17]/[01:20]): the ping-pong's ask window
    // is measured from lastOutboundAt on the NEXT read — a non-persisted clock
    // reads as 0 and the resume bridge swallowed the client's answer to an ask
    // Lina had just relayed. (The same write also survives the per-chat 100/hr
    // budget counter across process restarts.) The enqueue chain is serial per
    // chat, so this cannot clobber a concurrent turn.
    this.deps.sessions.set(session);
    this.deps.meta.increment('monthly_initiated');
    await this.deps.channels.send(session.channel, session.chatId, text, source);
  }
}

/**
 * Provision bank resolution (the [09:0x] 500-den bug): an idle/reset session
 * has slots.service === undefined — the old inline ternary read that as "buy"
 * and served a RENT searcher the 500 ден/0% провизија rules-of-work script.
 * A market question WITHOUT a declared market gets the service-agnostic
 * answer (both scripts, both fees, correct by construction); only an explicit
 * 'rent' picks the rent bank. The service-agnostic PROVISION_ANSWER stays the
 * bank-miss fallback in every provision lane.
 */
function provisionKeyFor(service: Service | undefined): string {
  return service === 'rent' ? 'provision.ask.rent'
    : service === 'buy' ? 'provision.ask.buy'
    : 'provision.ask.neither';
}
