/**
 * MONEY ARBITRATION — Options 1+2 of the routing program (P5.2, runbook
 * "Pushing further"). Replaces the money region's ARRAY ORDER with evidence.
 *
 * OPTION 1 (evidence-based arbitration): every money lane becomes a CLAIM —
 * its predicate is the HANDLER'S OWN detector + state gate, unchanged — plus
 * an evidence chip list ("why it fired") and an evidence strength. Resolution
 * is by strength; ties fall back to the legacy array order so every input the
 * old chain served unchanged, this chain serves unchanged, provable by the
 * corpus (tests/route-corpus.test.ts). When two claims tie at the top, the
 * serve defaults DOWN to the narrower informational lane and the collision is
 * logged (LANE_COLLISION:<a>|<b>) — never escalated to the heaviest script, a
 * collision is an event, never a silent swallow.
 *
 * THE VALENCE AXIOM (corpus-pinned): a price evaluation is one-directional
 * evidence. The fee is never called cheap, so a surviving cheap claim outranks
 * every fee lane in the arbiter — the same veto the fee detectors enforce, now
 * recorded as evidence instead of buried in a return-false.
 *
 * OPTION 2 (tuple extractor): every money turn is classified on the four axes
 * `topic × act × valence × target`. Route = tuple → key. A money turn NO lane
 * claims gets an EXPLICIT address, `unknown.<topic>.<act>` (option 2's
 * `unknown.*` bucket): the failure is named for the log and the review
 * evidence, it never invents a serve.
 *
 * DB-state vetoes (BankStore.neverServes) are passed IN as pre-resolved
 * booleans, so this module stays pure text+context — every decision is
 * replayable from a corpus row.
 */
import {
  detectFeeAmountAsk, detectFeeNag, detectFeeAnaphoricRefusal, detectMoreOptions,
  detectPriceEval, detectBudget, detectProvisionResistance,
  detectService, detectBothServices, detectHouse, detectBusiness, detectPlac,
  detectNegotiate, isMoneyWithoutTarget, isFeeFrame, detectFeeWhy,
  detectAmountFeeQuestion, detectFeePaymentAgreement, detectFeeComplaint,
  detectFeeChargePushback,
} from './deterministic';

export type RouteTuple = {
  topic: 'property-price' | 'fee' | 'commission' | 'fact' | 'logistics' | 'smalltalk' | 'unknown';
  act: 'ask' | 'assert' | 'evaluate' | 'complain' | 'accept' | 'refuse' | 'command' | 'unknown';
  valence: 'positive' | 'negative' | 'neutral' | 'none';
  target: 'property' | 'visit-fee' | 'commission' | 'agent' | 'none';
};

export type MoneyLane = 'cheap' | 'feeAmount' | 'provision' | 'clarify' | 'nag' | 'feeWhy' | 'expensive';

export interface MoneyClaim {
  lane: MoneyLane;
  /** Human-readable evidence chips: what fired, which state gate, which object. */
  evidence: string[];
  /** Evidence strength — a fee/visit referent (specific object) outranks bare
   *  money vocabulary; the cheap valence is sovereign (8). */
  strength: number;
}

export interface MoneyArbiterCtx {
  state: string;
  /** A bound price/property: propertyId | interestedPropertyId | lastPrice | presentedIds. */
  propertyOnTable: boolean;
  /** slots.viewingFeeAgreed — the fee is agreed; the ladder rungs are closed. */
  feeAgreed: boolean;
  /** The fee was ALREADY put to this client (a fee.ask served, or a rung burned).
   *  It scopes the options-ask veto below: a jab that rides a shopping ask is a
   *  repeat, not a first question, so it must not climb another rung — but a
   *  client who has never been told the fee and asks «PARI ZA POSETA / NESTO
   *  NOVO A ?» is asking ABOUT the money he just met, and the ladder owns it.
   *  Optional so every old ctx literal keeps the pre-existing reading. */
  feeTold?: boolean;
  /** Pre-resolved BankStore.neverServes() vetoes — false means the key family
   *  may serve. A blocked lane cannot claim (the serve-time veto moves DOWN
   *  into the arbiter, below the valence axiom, per hard invariant 3). */
  feeBlocked: boolean;
  provisionBlocked: boolean;
}

export interface MoneyVerdict {
  /** The winning lane, or null when no money lane has standing evidence. */
  lane: MoneyLane | null;
  claims: MoneyClaim[];
  /** True when several claims tied at the top (or the valence beat a fee lane):
   *  the serve defaults down and the collision is logged. */
  conflict: boolean;
  /** Option 2 — the four-axis tuple for this turn. */
  tuple: RouteTuple;
  /** Option 2 — `unknown.<topic>.<act>` when money vocabulary exists but no
   *  lane has standing evidence. The serve NEVER changes; the bucket is the
   *  address the drift log and the review evidence chips carry. */
  bucket: string | null;
}

// ── THE MONEY VOCABULARY probe (for the unknown.* bucket only) ──────────────
const MONEY_WORD_RE =
  /(?:^|[^\p{L}])(?:цена\p{L}*|cena\p{L}*|пари|pari|плат\p{L}*|plat\p{L}*|евр\p{L}*|evr\p{L}*|денар\p{L}*|denar\p{L}*|такс\p{L}*|taksa\p{L}*|надомес\p{L}*|nadomes\p{L}*|наплат\p{L}*|naplat\p{L}*|провизи\p{L}*|provizi\p{L}*|комиси\p{L}*|komisi\p{L}*|кеш|kesh|готово|gotovo)/iu;

/** Explicit price noun — the evidence boundary that separates a property-price
 *  evaluation ("PREVISOKA CENA" / "превисока е цената") from a negotiative
 *  bare "скапо е тоа", which keeps its own lanes. A bare valence word with no
 *  price object on the table is NOT wired. */
const PRICE_NOUN_RE = /(?:^|[^\p{L}])(?:ценат?а?|cenat?a?)(?=$|[^\p{L}])/iu;

const FEE_STATES = ['closing', 'property_query', 'presentation', 'discovery', 'intent', 'idle', 'property_locate', 'contact_collection'];
const CHEAP_STATES = ['property_query', 'presentation', 'closing'];

const LEGACY_ORDER: MoneyLane[] = ['cheap', 'feeAmount', 'provision', 'clarify', 'nag', 'feeWhy', 'expensive'];

// ── THE TUPLE EXTRACTOR (Option 2) ──────────────────────────────────────────
const VISIT_NOUN_RE = /(?:посет\p{L}*|poset\p{L}*|разглед\p{L}*|razgled\p{L}*|гледањ\p{L}*|gledanj\p{L}*|pogledn\p{L}*)/iu;
const COMMISSION_NOUN_RE = /(?:провизи\p{L}*|provizi\p{L}*|комиси\p{L}*|komisi\p{L}*)/iu;
const FEE_SENSE_RE = /(?:такс\p{L}*|taksa\p{L}*|надомес\p{L}*|nadomes\p{L}*|наплат\p{L}*|naplat\p{L}*|плата\p{L}*|plata\p{L}*|трошок\p{L}*|trosok\p{L}*|трошкови|troskov)/iu;
const QUESTION_ACT_RE = /\?|(?:^|[^\p{L}])(?:колку|kolku|дали|dali|која|кој|кое|koe|koj|koja|каде|kade|зошто|zosto|кога|koga|кога|koga)(?=$|[^\p{L}])/iu;
const COMMAND_ACT_RE = /(?:^|[^\p{L}])(?:дај|daj|покажи|pokazi|организирај|organiziraj|кажи|kazi|договори|dogovori|најди|najdi)(?=$|[^\p{L}])/iu;
const REFUSE_ACT_RE = /(?:^|[^\p{L}])(?:не\s*сакам|не\s*sakam|нема\s*да|nema\s*da|неќам|некјам|откажувам|otkazuvam)/iu;
const AGENT_TARGET_RE = /(?:^|[^\p{L}])(?:ти\b|ti\b|вие\b|vie\b)/iu;
const PROPERTY_NOUN_RE =
  /(?:^|[^\p{L}])(?:стан\p{L}*|stan\p{L}*|куќ\p{L}*|кук\p{L}*|kuk\p{L}*|апартман\p{L}*|apartman\p{L}*|дуплекс\p{L}*|duplex\p{L}*|гараж\p{L}*|garaz\p{L}*|дуќан\p{L}*|dukan\p{L}*|плац\p{L}*|plac\p{L}*|вила\p{L}*|vila\p{L}*|котек\p{L}*|kotek\p{L}*|недвижнос\p{L}*|nedviznos\p{L}*|некретнин\p{L}*|nekretnin\p{L}*|деловн\p{L}*|delovn\p{L}*)/iu;
const CHEAP_VALENCE_RE = /(?:ефтин\p{L}*|евтин\p{L}*|eftin\p{L}*|povoln\p{L}*|добра\s+цена|dobra\s+cena|добра\s+cena)/iu;
const EXPENSIVE_VALENCE_RE = /(?:скап\p{L}*|skap\p{L}*|превисок\p{L}*|previsok\p{L}*|висок\p{L}*|visok\p{L}*|преширок\p{L}*|премногу|premnogu|пре?\s?многу)/iu;

/** The mixed-sense word `цена`/`cena` is topic property-price ONLY when no
 *  fee sense is present — the sense-splitting this program exists to enforce.
 *  The fee senses keep their own topics. */
/** PURE, text-only classification for evidence display (review UI chips):
 *  no state, no slots, no serve implication. */
export function routeTupleOf(text: string): RouteTuple {
  return extractTuple(text);
}

/** PURE probe for evidence display: does the text carry money vocabulary
 *  (price/fee/payment words)? The residue-address chip needs it — a tuple can
 *  be unknown because the turn is nonsense, but the explicit address is only
 *  a fact for MONEY traffic. */
export function isMoneyVocab(text: string): boolean {
  return MONEY_WORD_RE.test(text.toLowerCase());
}
function extractTuple(text: string): RouteTuple {
  const cyr = text.toLowerCase();
  const hasCommission = COMMISSION_NOUN_RE.test(cyr);
  const hasFeeSense = FEE_SENSE_RE.test(cyr) || isFeeFrame(text);
  const hasPriceNoun = PRICE_NOUN_RE.test(cyr);
  const hasProperty = PROPERTY_NOUN_RE.test(cyr);
  const hasMoney = MONEY_WORD_RE.test(cyr) || hasFeeSense;

  const topic: RouteTuple['topic'] =
    hasFeeSense && (VISIT_NOUN_RE.test(cyr) || hasCommission) ? (hasCommission ? 'commission' : 'fee')
    : hasFeeSense && !hasProperty ? 'fee'
    : hasFeeSense ? 'fee'
    : hasPriceNoun ? 'property-price'
    : hasProperty ? 'fact': (/\?/.test(cyr) || /(?:каде|kade|кога|koga)\b/.test(cyr)) && !hasMoney ? 'logistics'
    : /^(?:zdravo|dobar\s*den|dobro|fala)\b/i.test(cyr) ? 'smalltalk'
    : 'unknown';

  const act: RouteTuple['act'] =
    REFUSE_ACT_RE.test(cyr) ? 'refuse'
    : QUESTION_ACT_RE.test(cyr) ? 'ask'
    : CHEAP_VALENCE_RE.test(cyr) || EXPENSIVE_VALENCE_RE.test(cyr) ? 'evaluate'
    : COMMAND_ACT_RE.test(cyr) ? 'command'
    : hasMoney && /премногу|пре?\s?многу/i.test(cyr) ? 'complain'
    : hasMoney ? 'assert'
    : 'unknown';

  const valence: RouteTuple['valence'] =
    CHEAP_VALENCE_RE.test(cyr) ? 'positive'
    : EXPENSIVE_VALENCE_RE.test(cyr) ? 'negative'
    : hasMoney ? 'neutral'
    : 'none';

  const target: RouteTuple['target'] =
    hasCommission ? 'commission'
    : hasFeeSense && VISIT_NOUN_RE.test(cyr) ? 'visit-fee'
    : hasFeeSense ? 'visit-fee'
    : hasProperty || hasPriceNoun || topic === 'property-price' ? 'property'
    : AGENT_TARGET_RE.test(cyr) ? 'agent'
    : 'none';

  return { topic, act, valence, target };
}

/** The explicit tuple address for an UNRESOLVABLE money turn. The failure is
 *  named, never filed under a family by accident (`unknown.money.ask`). */
export function unknownBucket(tuple: RouteTuple): string {
  return `unknown.${tuple.topic}.${tuple.act}`;
}

// ── THE ARBITER (Option 1) ──────────────────────────────────────────────────
/**
 * The money-region claim list. Each claim predicate is the HANDLER'S OWN
 * detector + state gate — today's behavior is the array order (see
 * inbound.ts); the arbiter keeps every legacy serve byte-identical by
 * resolving equal-strength ties in legacy order, and adds the ONE lane the
 * order used to refuse: `expensive` (detected, previously unwired), gated to
 * the narrowest evidence boundary.
 */
/** THE FEE-AMOUNT ASK, as ONE predicate for the arbiter AND the router mirror.
 *  `detectFeeAmountAsk` owns the question shapes («kolku e za poseta?»); the
 *  AMOUNT-FIRST sibling («500DEN ZA POSETA ?», «5 EVRA ZA POSETA?») names the
 *  figure and the viewing noun with no how-much word, and `detectAmountFeeQuestion`
 *  owns it — but only the provision ask read that detector, so the turn reached
 *  the money region with no claim at all and was filed as `unknown.fee.ask`
 *  (the [12:31] residue class: fee traffic with no lane). A committed amount
 *  («ke platam 500 den za poseta») is CONSENT, not an ask — excluded, exactly
 *  as `detectProvisionAsk` excludes it. */
export function isFeeAmountClaim(text: string): boolean {
  if (detectFeeAmountAsk(text)) return true;
  // …and the amount-first statement is an ASK only while it is NEUTRAL: «MNOGU
  // NEKAKO 500DEN ZA POSETA» carries the figure and the viewing noun too, but it
  // is a complaint — with the wider predicate the feeAmount claim (strength 7)
  // OUTRANKED the nag claim (6) and the ladder served a second disclosure to a
  // client who had just objected (the re-disclosure bug §2 forbids). Resistance
  // keeps its rung; the disclose/full statement keeps the disclosure.
  return detectAmountFeeQuestion(text) && !detectFeePaymentAgreement(text)
    && !detectFeeNag(text) && !detectFeeComplaint(text) && !detectFeeChargePushback(text);
}

export function arbitrateMoney(text: string, ctx: MoneyArbiterCtx): MoneyVerdict {
  const claims: MoneyClaim[] = [];
  const nonQuestion = !/\?/.test(text);
  const noSteal = !detectBudget(text) && !detectService(text) && !detectBothServices(text)
    && !detectHouse(text) && !detectBusiness(text) && !detectPlac(text)
    && !detectNegotiate(text);
  const feeStates = FEE_STATES.includes(ctx.state);

  // VALENCE FIRST — a price evaluation is one-directional evidence the fee
  // lanes may never contradict (corpus-pinned). The cheap claim fires only
  // where the legacy lane fired (state gates + property on the table).
  const priceEval = detectPriceEval(text);
  if (priceEval === 'cheap'
    && CHEAP_STATES.includes(ctx.state)
    && ctx.propertyOnTable && nonQuestion && noSteal) {
    claims.push({ lane: 'cheap', strength: 8, evidence: ['valence:cheap — the fee is never cheap', 'target:property-on-table', `state:${ctx.state}`] });
  }

  if (isFeeAmountClaim(text) && feeStates && !ctx.feeBlocked) {
    claims.push({ lane: 'feeAmount', strength: 7, evidence: ['referent:visit-fee', 'act:ask', `state:${ctx.state}`] });
  }
  if (detectProvisionResistance(text) && feeStates && !ctx.provisionBlocked) {
    claims.push({ lane: 'provision', strength: 7, evidence: ['referent:commission', 'topic:resistance', `state:${ctx.state}`] });
  }
  if (isMoneyWithoutTarget(text)
    && (ctx.state === 'closing' || ctx.state === 'presentation')
    && !ctx.feeAgreed && !ctx.propertyOnTable) {
    claims.push({ lane: 'clarify', strength: 6, evidence: ['topic:money', 'target:unresolved', `state:${ctx.state}`] });
  }
  // THE CHARGE QUESTION ARRIVES BEFORE THE CLOSING STATE TOO (the [10:19]
  // field capture): «КЕ МИ НАПЛАТИТЕ ЗА ДА ГО ВИДАМ ?» was typed while the
  // client was still identifying the flat on the site (property_locate), so
  // the nag claim had no standing — the classifier read the future-tense
  // charge verb as agreement and the funnel jumped straight to contact
  // collection. A nag is nag traffic in ANY funnel state when it carries its
  // OWN fee/visit referent (charge verb + viewing word/fee noun); the bare
  // hesitation family («НЕ ЗНАМ …») is passed feeContext:false there because
  // in property_locate that sentence is an ANSWER to the identify question
  // («НЕ ЗНАМ НИШТО ПОВЕЌЕ ОД ОВА ШТО ВИ ГО КАЖАВ»), never fee resistance.
  const nagInFeeStates = ctx.state === 'closing' || ctx.state === 'presentation';
  const nagInLocate = ctx.state === 'property_locate';
  if ((nagInFeeStates || nagInLocate)
    && !ctx.feeAgreed && !ctx.feeBlocked
    && detectFeeNag(text, { feeContext: nagInFeeStates })
    && (!detectMoreOptions(text) || !ctx.feeTold)) {
    claims.push({ lane: 'nag', strength: 6, evidence: ['referent:visit-fee', 'act:complain', `state:${ctx.state}`] });
  }
  // THE FEE-WHY EXPLANATION CLAIM (the [01:23] transcript): the WHY/EXISTENCE
  // question ("IMATE NEKAKVA TAKSA ZA POSETA ?", "zoska 500 denari ?",
  // "nova praksa nekoja") is fee-explanation traffic — the fast intercept above
  // the funnel (inbound.ts feeWhyFast) answers it with the filter rationale,
  // so the money region must CLAIM it, not address it as residue
  // (unknown.fee.ask). Same evidence tier as nag (6) and placed after it in
  // the legacy order so a why-word riding a COMPLAINT keeps the legacy nag
  // serve byte-identical; the pure existence/why rows have no competing claim
  // (they fell to the residue bucket before), so this claim never shifts a
  // legacy serve — it only upgrades their address.
  if (detectFeeWhy(text) && feeStates && !ctx.feeBlocked) {
    claims.push({ lane: 'feeWhy', strength: 6, evidence: ['referent:visit-fee', 'act:ask-why', `state:${ctx.state}`] });
  }

  // THE ANAPHORIC REFUSAL (the [14:36] transcript): the object-less "не ми
  // одговара" answered to the fee stack — the fee is the only open question in
  // this state, so a bare refusal IS fee resistance. Same claim shape as the
  // legacy arm: one rung, ladder copies, graceful close on the LAST rung —
  // never the goodbye on the first nag, never property suggestions.
  if ((ctx.state === 'closing' || ctx.state === 'presentation')
    && !ctx.feeAgreed && !ctx.feeBlocked
    && nonQuestion && noSteal
    && detectFeeAnaphoricRefusal(text) && (!detectMoreOptions(text) || !ctx.feeTold)) {
    claims.push({ lane: 'nag', strength: 6, evidence: ['referent:visit-fee(anaphoric)', 'act:refuse', `state:${ctx.state}`] });
  }

  // THE NEW LANE, under the evidence boundary (option 1 makes the wiring a
  // decision the evidence makes for you): a NEGATIVE evaluation whose object
  // is the explicit price noun on a property that is on the table, in the
  // query/presentation states, fee not agreed, non-negotiatively phrased,
  // nothing else claiming. Bare "skapo" (no price noun) stays vetoed —
  // the negotiation cheapest lane owns it, as the corpus pins.
  if (priceEval === 'expensive'
    && PRICE_NOUN_RE.test(text.toLowerCase())
    && (ctx.state === 'property_query' || ctx.state === 'presentation')
    && ctx.propertyOnTable && !ctx.feeAgreed && nonQuestion && noSteal
    && !claims.some(c => c.lane !== 'cheap')) {
    claims.push({ lane: 'expensive', strength: 5, evidence: ['valence:expensive', 'referent:price-noun', 'target:property-on-table', `state:${ctx.state}`] });
  }

  // RESOLUTION: max strength; ties → legacy array order (option 1's mechanism,
  // preserving every legacy serve). Empty → no money lane claims.
  const maxStrength = Math.max(-1, ...claims.map(c => c.strength));
  const best = claims.filter(c => c.strength === maxStrength);
  const lane = best.length === 0 ? null
    : best.sort((a, b) => LEGACY_ORDER.indexOf(a.lane) - LEGACY_ORDER.indexOf(b.lane))[0].lane;
  const conflict = best.length > 1;

  const tuple = extractTuple(text);
  const bucket = lane === null && MONEY_WORD_RE.test(text.toLowerCase())
    ? unknownBucket(tuple)
    : null;

  return { lane, claims, conflict, tuple, bucket };
}

/** Human shape for the collision log: `LANE_COLLISION:cheap|nag`. */
export function collisionTag(claims: MoneyClaim[]): string {
  return `LANE_COLLISION:${claims.map(c => c.lane).join('|')}`;
}
