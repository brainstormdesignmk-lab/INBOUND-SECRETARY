/**
 * dynamicFallback — the RUNTIME half of the closed-loop bank (2026-09-22).
 *
 * The architecture the skip-LLM system was always meant to have:
 *
 *   client asks → guard chain misses (no detector, no slot, no FSM intent)
 *   → RECALL: bank_dynamic holds a validated answer for this question
 *     (0 ms, offline, free) → serve
 *   → MISS: Gemini answers UNDER CONSTRAINTS (P1 baseline + no-facts rule +
 *     known session facts only) → VALIDATION (replyIsClean + violationsFor)
 *     → clean: SERVE (badge 'dynamic') + STORE IMMEDIATELY in bank_dynamic
 *     → dirty: honest fallback (existing cards/literals), nothing stored
 *   → nightly: digestDynamic() folds groups into answer variants (staged)
 *     + trigger examples, so next occurrence routes deterministically.
 *
 * NOTHING here touches the funnel: data-driven facts (price, availability,
 * address) are forbidden in the generated prose — the answer either says
 * nothing about them or hands off to the owner-contact protocol. Every
 * failure mode degrades to exactly what the system did before this module
 * existed.
 */

import { violationsFor } from './bankConstraints';
import { replyIsClean } from './enrichQuality';
import {
  detectAvailabilityAsk, detectContactRequest, detectInventoryAsk, detectOwnerContact, detectPriceAsk,
  detectProvisionAsk, detectProvisionWho, detectVisitInterest, extractInventoryPlace, extractPoiWish,
  fsmRequired, isDistanceQuestion, isFeeFrame, isFeeTraffic,
} from './deterministic';
import { feedAreasIn, placeTemplateFrom, placeWordKey } from './placeTemplate';
import { isPersonalAsk, revealsMachineIdentity } from './personal';
import type { LlmClient } from './types';
import type { ChatSession } from '../fsm/session';

/** The concrete-forbidden rule: no EB numbers, no amounts, no addresses — and
 *  NO PROPERTY DATA AT ALL. A generated answer may name a datum only when the
 *  CLIENT said it (knownFacts); everything else must be admitted missing and
 *  handed to the owner. Room count, area, year of build and the floor belong to
 *  the property ROW, exactly like the price: an LLM writing «двособен, 68 м²,
 *  изградена 2008, трети кат» invents facts the funnel cannot verify, which is
 *  the same defect class as «стан» in the service question (§4i) — the reason
 *  prompt wording failed there is the reason the guard lives here. */
const FORBIDDEN_FACTS: RegExp[] = [
  /(?:евидентен|evidenten)?\s*број\s*\d+|eb\s*\.?\s*\d+|\b\d{3,}\b\s*(?:број|br)/iu,
  /\d[\d\s.,]{2,}\s*(?:евра|денари|мкд|eur|evra)/iu,
  /улица\s+\p{Lu}|ул\.\s*\p{Lu}/u,
  /\b\d{1,3}\s*м2\b|\b\d{1,3}\s*м²/iu,
  /достапен\s+(?:е|e)\s+(?:во|во момент)|слободен\s+(?:е|e)\s+(?:во|сега)/iu,
  // ROOM COUNT / LAYOUT: «двособен», «трисобен», «гарсоњера» is a TYPE (own
  // rule), «со две спални», «2 спални соби». Whole words, both scripts —
  // «двособен» must not match inside a longer word.
  /(?<![\p{L}])(?:едноиполсобен\p{L}*|едноипособен\p{L}*|двособен\p{L}*|двособна\p{L}*|трисобен\p{L}*|трисобна\p{L}*|четирисобен\p{L}*|ednoipolssoben\p{L}*|dvosoben\p{L}*|dvosobna\p{L}*|trosoben\p{L}*|cetvorosoben\p{L}*)(?![\p{L}])/iu,
  /(?<![\p{L}])(?:една|две|три|четири|\d)\s+(?:спални|спална|spalni|spalna)(?![\p{L}])/iu,
  // AREA / YEAR / FLOOR — the data facts the price-per-m² and year asks expose.
  /(?<![\p{L}])\d{1,4}\s*(?:квадрат\p{L}*|kvadrat\p{L}*|квадратни\s+метри)(?![\p{L}])/iu,
  /(?:изград\p{L}*|градена|реновир\p{L}*|renovir\p{L}*|izgrad\p{L}*)[^.?!]{0,25}\b(?:18|19|20)\d{2}\b/iu,
  /\b(?:18|19|20)\d{2}\s*(?:година|godina)\b/iu,
  /(?<![\p{L}])(?:на|na|во|vo)\s+(?:\d{1,2}\.?|прв\p{L}*|втор\p{L}*|трет\p{L}*|четврт\p{L}*|петти\p{L}*|шести\p{L}*|приземје|поткровј\p{L}*|prv\p{L}*|vtor\p{L}*|tret\p{L}*|cetvrt\p{L}*)\s+(?:кат|kat)\p{L}*/iu,
  // A DISTANCE IS PROPERTY DATA (the [20:19] capture): «КОЛКУ ИМА ОД ГРАДСКА ДО
  // СТАНОТ?» was answered by generated prose («на само 410 метри од Градска
  // болница») and STORED, because no rule forbade a metre figure. The row then
  // answers a later distance question about a different flat with that 410 m —
  // a fabricated measurement, and one that contradicted the lane's own 980 m
  // for the same property. Metres and kilometres are measured from the row's
  // coordinates, never written by a model.
  /(?<![\p{L}\p{N}])\d[\d.,]*\s*(?:мет(?:ри|ар|ра|ров|рови)|километ\p{L}*|км|km|m)(?![\p{L}\p{N}])/iu,
];

/** Serbian-only words. Whole-word, Cyrillic, so ordinary Macedonian is never
 *  matched. Kept small on purpose: only words with no Macedonian meaning. */
const SERBIAN_ONLY_RE = /(?<![\p{L}])(?:радо|радосн\p{L}*)(?![\p{L}])/iu;

/** --- THE BORROWED COMMITMENT RULE (the [01:51] capture) -------------------
 *
 *  «KOMPLICIRANI STE» during term negotiation was answered by a generated
 *  sentence that promised the owner would be asked about **четврток во 17:00**
 *  — a term belonging to that one client's negotiation. The row was stored
 *  (it passed every fact rule: a day and an hour are not an amount, an EB, an
 *  area or a floor) and the fuzzy recall is state-agnostic, so ANY later client
 *  whose wording scored 0.55 against «KOMPLICIRANI STE» could be told the
 *  owner is being asked about Thursday 17:00. A stored sentence must be true
 *  for any client; a calendar entry never is.
 *
 *  So: a day or a clock in a dynamic answer is a violation UNLESS the client's
 *  own message names it (the echo rule — «дали може четврток во 17?» must
 *  still be answered with «…за четврток во 17:00»). Comparison is by CANONICAL
 *  value, not by spelling: the day maps to mon…sun/today/tomorrow in either
 *  script, and the clock maps to an hour bucket where 6 and 18 are the same
 *  hour (the visit-side reader has always resolved a bare hour that way, and
 *  a client writing «во 6» means the afternoon).
 */
const DAY_FORMS: Array<{ key: string; re: RegExp }> = [
  { key: 'mon', re: /(?<![\p{L}])(?:понеделник|ponedelnik|ponedelak|ponedelok)\p{L}*/giu },
  { key: 'tue', re: /(?<![\p{L}])(?:вторник|vtornik|vtornok)\p{L}*/giu },
  { key: 'wed', re: /(?<![\p{L}])(?:среда|sreda)\p{L}*/giu },
  { key: 'thu', re: /(?<![\p{L}])(?:четврток|cetvrtok|chetvrtok|четврт[ао]к?)\p{L}*/giu },
  { key: 'fri', re: /(?<![\p{L}])(?:петок|petok)\p{L}*/giu },
  { key: 'sat', re: /(?<![\p{L}])(?:сабота|sabota)\p{L}*/giu },
  { key: 'sun', re: /(?<![\p{L}])(?:недела|nedela)\p{L}*/giu },
  { key: 'today', re: /(?<![\p{L}])(?:денес|denes|danas)\p{L}*/giu },
  { key: 'tomorrow', re: /(?<![\p{L}])(?:утре|utre|утрешн\p{L}*)\p{L}*/giu },
  { key: 'after', re: /(?<![\p{L}])(?:задутре|zadutre)\p{L}*/giu },
];

/** An explicit clock (17:00, 17.00 — and a date like 10.11, which is just as
 *  case-bound) or a prepositioned hour («во 6», «околу 17 часот»). A unit
 *  noun right after the number keeps it out: «во 5 минути», «на 5 кат»,
 *  «за 3 дена» are durations and floors, not appointments. */
const CLOCK_EXPLICIT_RE = /(?<![\p{L}\d:])(\d{1,2})[:.](\d{2})(?![\d])/gu;
const CLOCK_WORD_RE = /(?<![\p{L}])(?:во|vo|околу|okolu|на|na|за|za)\s+(\d{1,2})(?![\p{L}\d])(?!\s*[-–—]\s*\d)(?!\s*(?:минути|минута|minuti|дена|дни|години|godini|месеци|meseci|реченици|реда|пати|pati|кат|kat|м2|м²|%))/giu;

/** Hour bucket: 6 and 18 are the same appointment hour. */
function hourBucket(h: number, m: string): string {
  const bucket = h > 12 ? h - 12 : h === 0 ? 12 : h;
  return `${bucket}:${m}`;
}

function commitmentsIn(text: string): { days: Set<string>; clocks: Set<string> } {
  const days = new Set<string>();
  const clocks = new Set<string>();
  for (const { key, re } of DAY_FORMS) {
    re.lastIndex = 0;
    if (re.test(text)) days.add(key);
  }
  CLOCK_EXPLICIT_RE.lastIndex = 0;
  for (const m of text.matchAll(CLOCK_EXPLICIT_RE)) {
    const h = Number(m[1]);
    if (h <= 24) clocks.add(hourBucket(h, m[2]));
  }
  CLOCK_WORD_RE.lastIndex = 0;
  for (const m of text.matchAll(CLOCK_WORD_RE)) {
    const h = Number(m[1]);
    if (h <= 24) clocks.add(hourBucket(h, '00'));
  }
  return { days, clocks };
}

/** Does this text pin a day or an hour the client never named? THE single
 *  reader for the [01:51] rule — the dynamic validator above and the
 *  protocol-state prose guard in Responder.escalate both ask it, so a
 *  tightening of the day/clock vocabulary cannot drift between them. */
export function pinsBorrowedCommitment(answer: string, userMsg?: string): boolean {
  const committed = commitmentsIn(answer);
  if (committed.days.size === 0 && committed.clocks.size === 0) return false;
  const fromClient = commitmentsIn(userMsg ?? '');
  return [...committed.days].some(d => !fromClient.days.has(d))
    || [...committed.clocks].some(c => !fromClient.clocks.has(c));
}

/** What may be echoed from session slots — client-established context only. */
function knownFacts(session: ChatSession): string[] {
  const facts: string[] = [];
  if (session.slots.location) facts.push(`населба: ${session.slots.location}`);
  if (session.slots.budget) facts.push(`буџет: ${session.slots.budget}`);
  if (session.slots.service) facts.push(`услуга: ${session.slots.service === 'rent' ? 'изнајмување' : 'купување'}`);
  if (session.slots.bedrooms) facts.push(`спални: ${session.slots.bedrooms}`);
  return facts;
}

export function dynamicSlug(state: string, msg: string): string {
  const stop = new Set(['dali', 'ili', 'za', 'na', 'vo', 'od', 'do', 'kako', 'sto', 'shto', 'shto', 'kade', 'moze', 'mozam', 'imas', 'imate', 'li', 'mi', 'se', 'e', 'a']);
  const words = msg.toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stop.has(w));
  return `dynamic:${state}:${words.slice(0, 3).join('-') || 'misc'}`;
}

/** The client asked for a FACT (which/whose/what/how many/when/where/whether).
 *  Used only to judge whether the answer actually addresses the question. */
const FACTUAL_ASK_RE = /(?:^|[\s?!.,])(?:koja|koj|koe|kolku|koga|kade|dali|od\s+koja|која|кој|кое|колку|кога|каде|дали|од\s+која)(?=[\s?!.,]|$)/iu;

/** The visit/presentation pitch family — the [00:33] "od koja godina e
 *  zgradata?" answer. It is a fine closing move and a terrible answer to a
 *  factual question. */
const GENERIC_PITCH_RE = /(?:извлеков|прилагодени на вашиот вкус|да договориме време|дали би сакале да (?:договориме|организираме|посетиме))/iu;

/** An answer that admits the datum is missing (the honest shape). */
const UNCERTAINTY_RE = /(?:не е наведено|немам (?:податок|информација)|не ми е достапно|ќе (?:го )?прашам (?:сопственикот|сопственик)|ќе проверам|не знам|не располагам)/iu;

/** A PROPERTY TYPE IS A FACT THE CLIENT OWNS, and the SERVICE question is not
 *  allowed to presume it (the [21:20] capture: «ZDRAVO , STO IMATE INTERESNO
 *  OKOLU KAPITOL MOL ?» was answered «Дали барате СТАН за купување или за
 *  изнајмување?» — he had named a place, never a flat). The bank copy is clean
 *  ("…купување или изнајмување на недвижност?"); the leak lives in the
 *  GENERATED path, where an LLM writes the sentence and no post-condition
 *  forbade the noun. Prompt text alone is not a guard — this is. */
export const PROPERTY_TYPE_NOUN_RE = /(?<![\p{L}])(?:стан|станот|станови|становите|станчиња|куќа|куќата|куќи|kukja|kukjata|kukji|kukj|kuc|апартман\p{L}*|apartman\w*|локал\p{L}*|lokal\w*|деловен\s+простор|деловниот\s+простор|deloven\s+prostor|плац\p{L}*|plac\w*|гарсоњер\p{L}*|garsonjer\w*|stan(?:ce|cevi|ovi|ovite|ot)?)(?![\p{L}])/iu;

/** Does this text name a property TYPE? Whole words only — «стандард»,
 *  «станбена површина» and «станар» are not types. */
export function namesPropertyType(text: string): boolean {
  return PROPERTY_TYPE_NOUN_RE.test(text ?? '');
}

/** THE SERVICE QUESTION (купување или изнајмување), in either order/script. */
const ASKS_SERVICE_RE = /(?:купувањ\p{L}*[^.?!]{0,30}изнајмувањ|изнајмувањ\p{L}*[^.?!]{0,30}купувањ|kupuvanj\w*[^.?!]{0,30}iznajmuvanj|iznajmuvanj\w*[^.?!]{0,30}kupuvanj)/iu;

/** Is the property TYPE established by the client? A slot set by applySlots is
 *  the normal answer; `userMsg` covers the turn that names it. */
export function typeEstablished(
  slots: { flat?: boolean; house?: boolean; business?: boolean; plac?: boolean; garsonjera?: boolean; yard?: boolean },
  userMsg?: string,
): boolean {
  return slots.flat === true || slots.house === true || slots.business === true
    || slots.plac === true || slots.garsonjera === true || slots.yard === true
    || namesPropertyType(userMsg ?? '');
}

/** Validation for a dynamic candidate — P1 baseline + hygiene + no-facts +
 *  RELEVANCE. `userMsg` is optional so existing callers/tests keep their
 *  contract; when given, a generic presentation pitch can no longer answer a
 *  factual question, because that is how the bank stored a wrong answer.
 *  `typeKnown` says whether the client has established the property TYPE — the
 *  service question may only presume it when he has. */
/** The places a SESSION has already established — the only context a live
 *  answer may lean on. One reader for both recall doors and generation. */
export function sessionPlaces(session: ChatSession): string[] {
  return [session.slots.location, session.slots.poiAnchor]
    .filter((p): p is string => typeof p === 'string' && p.trim().length > 0);
}

/**
 * The feed areas an answer names that NEITHER the client's message NOR the
 * session established (the #29/#30 rows). Compared canonically, so the
 * stored/typed spelling («Центар», «CENTAR», «Центар (населба)») never matters.
 * A stored place name may be a longer feed spelling of the area the client
 * used («Центар (населба)» for «центар»), never the other way round: «Лисиче»
 * does not authorise «Ново Лисиче».
 */
function borrowedAreas(answer: string, userMsg?: string, allowed?: string[]): string[] {
  const said = feedAreasIn(answer);
  if (said.length === 0) return [];
  const known = [...feedAreasIn(userMsg ?? ''), ...(allowed ?? [])]
    .map(placeWordKey)
    .filter(Boolean);
  return said.filter(area => {
    const key = placeWordKey(area);
    return !known.some(k => k === key || k.includes(key));
  });
}

export function validateDynamicAnswer(
  answer: string,
  userMsg?: string,
  opts?: { typeKnown?: boolean; storedMsg?: string; allowedPlaces?: string[] },
): string[] {
  const violations = violationsFor(answer, 'dynamic.fallback');
  // THE BORROWED PLACE (the [20:18]/[20:28] pair, and the [20:29] exact door):
  // a stored sentence names its own place («во тој дел околу Градска болница
  // имаме…»), so handing it to a client who asked about a DIFFERENT place
  // states a location he never mentioned — the same defect class as the
  // borrowed calendar entry below. The row's own question is the reference, so
  // the rule costs nothing when extraction finds no place on either side.
  // ONE PREDICATE, BOTH DOORS: the exact/containment recall runs first and used
  // to skip this check entirely, so the guard lives here rather than in the
  // fuzzy recall caller.
  if (opts?.storedMsg) {
    const rowPlace = placeOf(opts.storedMsg);
    const nowPlace = userMsg ? placeOf(userMsg) : undefined;
    if (rowPlace && nowPlace && rowPlace !== nowPlace) {
      violations.push('names a place the client did not ask about (borrowed place from the stored row)');
    }
  }
  // THE BORROWED AREA (the #29/#30 rows): the rule above compares two
  // MESSAGES, so an area that lives only in the ANSWER was invisible — the
  // sentence was stored and could reach any client whose phrasing scored near
  // its trigger. An answer may name an area only because the client named it
  // or the session established it; `allowedPlaces` is that session context for
  // the live turn, and the row audit passes none, which is what makes such a
  // row unbankable.
  const borrowed = borrowedAreas(answer, userMsg, opts?.allowedPlaces);
  if (borrowed.length > 0) {
    violations.push(`names a place the client did not ask about (borrowed area: ${borrowed.join(', ')})`);
  }
  if (!replyIsClean(answer)) violations.push('fails reply hygiene (replyIsClean)');
  // PERSONA GUARD (the [08:38] capture): the stored age answer said „Јас сум
  // дигитален асистент, па немам години“. A machine identity is a policy
  // breach, not a wording choice — rejected at generation AND on recall, so
  // tightening this rule retroactively neutralises rows stored before it.
  if (revealsMachineIdentity(answer)) violations.push('exposes a machine identity or refuses an age');
  // SERBIAN GUARD (the «Радо ќе ги проверам достапните» capture): Gemini answered
  // in Serbian register. «Радо» is a Serbian word, not Macedonian. Rejected at
  // generation AND on recall, so rows already stored in bank_dynamic stop serving.
  if (SERBIAN_ONLY_RE.test(answer)) violations.push('uses a Serbian-only word (радо)');
  for (const re of FORBIDDEN_FACTS) if (re.test(answer)) { violations.push('names a concrete fact (EB/amount/address/rooms/area/year/floor)'); break; }
  // THE SERVICE QUESTION PRESUMES NO TYPE (the [21:20] capture): asking
  // «купување или изнајмување?» over «стан» claims a fact the client never
  // gave. Rejected at generation AND on recall, so a stored row from before
  // this rule degrades to the deterministic line instead of serving.
  if (!(opts?.typeKnown ?? typeEstablished({}, userMsg))
    && ASKS_SERVICE_RE.test(answer) && namesPropertyType(answer)) {
    violations.push('names a property type the client never mentioned (ask купување/изнајмување on недвижност)');
  }
  // THE BORROWED COMMITMENT (the [01:51] capture): a day or a clock the client
  // never named is that client's calendar, not ours to store. Checked on
  // generation, on recall, in the row audit AND (via the same predicate) on the
  // protocol-state escalation prose — one rule, one reader.
  if (pinsBorrowedCommitment(answer, userMsg)) {
    violations.push('pins a day/hour the client never named (a stored answer must be true for any client)');
  }
  if (userMsg && FACTUAL_ASK_RE.test(userMsg) && GENERIC_PITCH_RE.test(answer)
    && !UNCERTAINTY_RE.test(answer)) {
    // Deliberately narrower than "any answer that offers a visit": a legit
    // answer may end with an offer („…документите. Дали сакате да
    // организираме посета?“). What is rejected is the BOILERPLATE pitch that
    // carries no content at all — the shape the year question was answered
    // with, then stored and recalled.
    violations.push('does not answer the question (generic pitch for a factual ask)');
  }
  return violations;
}

/** A message shaped like a question (Latin or Cyrillic). Used as a gate: we
 *  generate prose for QUESTIONS the bank cannot answer, not for fillers like
 *  "MOZE" / "OK" / "TWO" that the funnel itself must interpret. */
const QUESTION_SHAPE_RE = /(?:\?|(?:^|[\s?!.,])(?:koj|koja|koe|kolku|koga|kade|dali|kako|shto|sto|zosto|кој|која|кое|колку|кога|каде|дали|како|што|зошто)(?=[\s?!.,]|$)|(?:^|\s)(?:ima|има)\s+li(?=[\s?!.,]|$))/iu;
const GREETING_ONLY = /^(?:zdravo|dobar\s*den|dobro\s*utro|zdr|pozz|poz|hello|hi|selam|hey|здраво|добар\s*ден|добро\s*утро|привет|селам)[\s!.,?]*$/iu;

/** States whose sub-funnel owns deterministic protocol wording. Mirrors the
 *  LAYER 0 exclusion in Responder.respond(): generating prose inside the
 *  fee/contact/visit ladder would let a model paraphrase a protocol. */
export function inProtocolState(session: ChatSession): boolean {
  return ['closing', 'contact_collection', 'visit_scheduling', 'owner_checking', 'time_confirm', 'pending', 'queued'].includes(session.state)
    || !!session.slots.viewingFeeAgreed || !!session.slots.ownerContactPending;
}

/** Per-session ceiling on GENERATED answers. The gate fires on any uncovered
 *  question, so without a cap a client asking twenty novel questions buys
 *  twenty Gemini calls. At the cap the turn keeps today's honest fallback
 *  (owner-relay / classifier), which is the right answer once we have spent
 *  the budget: the loop is a learning aid, not an infinite chat engine. */
export const MAX_GENERATED_PER_SESSION = 3;

/**
 * THE EXPLICIT MISS GATE — when may the handler try generate+store?
 *
 * Only for a genuine question the deterministic stack provably could not
 * route, outside the protocol sub-funnel, and never for money/availability/
 * contact traffic: those keys are frozen or data-driven and must keep their
 * own lane. Everything else (small talk, fillers, greetings, funnel commands)
 * keeps today's path — no Gemini call. This is the "none verdict" the loop was
 * missing: without it, a broad lane answers and nothing is ever learned.
 */
export function shouldTryDynamic(session: ChatSession, text: string): boolean {
  const t = text.trim();
  if (!t || !QUESTION_SHAPE_RE.test(t) || GREETING_ONLY.test(t)) return false;
  // Personal small talk about Lina (name/age/compliment) has its own
  // deterministic lane in the handler — it must never reach generate+store,
  // or the bank learns an improvised persona.
  if (isPersonalAsk(t)) return false;
  if ((session.slots.generatedAnswers ?? 0) >= MAX_GENERATED_PER_SESSION) return false;
  if (inProtocolState(session) || fsmRequired(t)) return false;
  if (isFeeTraffic(t) || isFeeFrame(t) || detectProvisionAsk(t) || detectProvisionWho(t)) return false;
  if (detectPriceAsk(t) || detectAvailabilityAsk(t) || detectOwnerContact(t) || detectContactRequest(t)) return false;
  if (detectVisitInterest(t)) return false;
  // A DISTANCE IS MEASURED, NEVER GENERATED: the lane reads the row's own
  // coordinates and the map. Reaching a model here is what stored the 410 m
  // sentence in the first place.
  if (isDistanceQuestion(t)) return false;
  return true;
}

/** THE PROTOCOL DOOR — may this turn be answered by generated prose at all?
 *
 *  `shouldTryDynamic` has always refused the visit/fee/contact ladder; the
 *  ESCALATION door (`Responder.escalate`) did not ask, and that is how the
 *  [01:51] capture banked a scheduling sentence. The visit ladder owns its own
 *  counters, its own relay and its own term question — a model paraphrasing
 *  them can promise a term nobody proposed. One predicate, both entries. */
export function dynamicAllowedHere(session: ChatSession): boolean {
  return !inProtocolState(session);
}

export interface DynamicResult {
  text: string;
  source: 'dynamic-recall' | 'dynamic';
  key?: string;
}

/** THE STORED-ROW AUDIT — which rule a `bank_dynamic` row breaks (empty =
 *  clean). The row's own `msg` is the client's question, so a type presumption
 *  is judged against it exactly as a fresh answer is judged against the turn:
 *  one predicate for generation, recall and the purge sweep, or the sweep
 *  drifts from what actually serves. */
export function dynamicRowViolations(row: { msg: string; answer: string }): string[] {
  return validateDynamicAnswer(row.answer, row.msg, { typeKnown: typeEstablished({}, row.msg) });
}

/** THE PLACE a message is about, read with the funnel's own extractors — no map,
 *  no new vocabulary. Two shapes are place-bound in practice: a stock ask at a
 *  place («ШТО ИМА КАЈ ГРАДСКА БОЛНИЦА») and a proximity wish («станови околу
 *  Капитол Мол»). */
function placeOf(msg: string): string | undefined {
  const p = extractInventoryPlace(msg) ?? extractPoiWish(msg);
  if (!p) return undefined;
  const folded = p.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  return folded || undefined;
}

/** RECALL: a stored, previously-validated answer for this question shape. */
export function recallDynamic(
  bank: { retrieveDynamic: (m: string) => { key: string; answer: string; msg?: string } | undefined },
  userMsg: string,
  typeKnown?: boolean,
  allowedPlaces?: string[],
): DynamicResult | undefined {
  const hit = bank.retrieveDynamic(userMsg);
  if (!hit) return undefined;
  // THE BORROWED PLACE is enforced by `validateDynamicAnswer` (it owns the rule
  // for BOTH recall doors) — the row's own question travels with the check.
  if (validateDynamicAnswer(hit.answer, userMsg, { typeKnown, storedMsg: hit.msg, allowedPlaces }).length > 0) return undefined;
  return { text: hit.answer, source: 'dynamic-recall', key: hit.key };
}

/**
 * GENERATE ONLY: one constrained Gemini call, validated, stored immediately.
 * No recall — the top-of-funnel path has already done its own EXACT,
 * state-scoped recall and must not fall back to the fuzzy (state-agnostic)
 * one here, or a `closing` answer could leak into `idle` through this door.
 */
export async function generateDynamic(
  llm: LlmClient,
  session: ChatSession,
  userMsg: string,
  store: {
    addDynamic: (key: string, state: string, msg: string, answer: string, meta?: { template?: string; place?: string; unreviewed?: boolean }) => boolean;
  },
): Promise<DynamicResult | undefined> {
  const facts = knownFacts(session);
  const factBlock = facts.length > 0
    ? `KNOWN CONTEXT (established by the client this session — you may reference these, nothing else): ${facts.join('; ')}`
    : 'NO PROPERTY CONTEXT. Do not mention any specific property, price, availability, or address.';
  try {
    const res = await llm.complete({
      role: 'respond',
      messages: [
        {
          role: 'system',
          content:
            'Ти си Лина, агент за недвижности во агенцијата Метрополис. Прашањето не е во твојата банка со одговори. Одговори природно на македонски, топло и професионално, во 1–3 реченици, и заврши со прашање што го води разговорот напред (обично понуда да се контактира сопственикот или да се организира посета).\n\n' +
            'ЛИЧНОСТ (важи за секој одговор): ти си Лина, жена агент од Метрополис. НИКОГАШ не кажувај дека си дигитален асистент, вештачка интелигенција, бот, робот, програма или јазичен модел. Никогаш не кажувај дека немаш години. Ако те прашаат за име, години или ти упатат комплимент, одговори кратко и топло како човек и врати се на недвижноста — без измислени лични податоци и без откривање на возраст.\n\n' +
            'ИСКЛУЧОК — ЗАВРШУВАЊЕ: ако клиентот очигледно се збогува или учтиво одбива (чао/фала/пријатно/не сакам/не фала), одговори со ЕДНА кратка топла реченица што завршува со „Се најдобро!“ — и НИШТО друго. БЕЗ прашање на крајот, БЕЗ понуда за понатамошна помош: излезот мора да биде чист.\n\n' +
            'ТВРДИ ПРАВИЛА (одговорите што ги кршат се отфрлаат):\n' +
            '- НИКОГАШ не наведувај и не измислувај: цена, достапност, адреса, Евидентен број, квадратура или друг податок за имотот. Цените и достапноста се на сопственикот и се проверуваат со јавување — кажи дека ќе провериш кај сопственикот ако те прашаат.\n' +
            '- Ако клиентот бара податок што го немаш (година на градба, година на реновирање, кат, ориентација…), кажи јасно дека податокот не е во твоите записи и дека ќе провериш кај сопственикот. НЕ одговарај на фактолошко прашање со општа презентација или понуда за посета.\n' +
            '- Користи САМО дадениот познат контекст. Не именувај населба, зграда или знаменитост што клиентот НЕ ја навел (ни во пораката, ни во познатиот контекст) и не измислувај нови.\n' +
            '- Без ветувања, гаранции, попусти или конкретни обврски.\n' +
            '- Ако клиентот НЕ кажал каков вид недвижност бара, НИКОГАШ не именувај стан, куќа, локал, плац или гарсоњера. Прашај само „дали Ве интересира купување или изнајмување на недвижност?“ — видот се прашува потоа, откако ќе се знае услугата.\n' +
            `- Максимум 420 знаци. Само македонски — без англиски зборови освен имиња на места.\n\n${factBlock}`,
        },
        ...session.history.slice(-6).map(m => ({ role: m.role as 'user' | 'assistant', content: m.text })),
        { role: 'user', content: userMsg },
      ],
      // LOW temperature: the persona + no-facts contract is a policy, not a
      // creative brief. 0.7 produced the „дигитален асистент“ phrasing that
      // then had to be purged from the bank; 0.3 keeps the voice but removes
      // the stylistic detours that break the contract.
      temperature: 0.3,
      maxTokens: 300,
      topP: 0.95,
    });
    const answer = res.trim();
    const typeKnown = typeEstablished(session.slots, userMsg);
    // THE LIVE ANSWER may lean on what the session already established (an
    // answer that mentions «Центар» because the client picked Центар two turns
    // ago is correct copy).
    if (!answer || validateDynamicAnswer(answer, userMsg, { typeKnown, allowedPlaces: sessionPlaces(session) }).length > 0) return undefined;
    // BANK COPY STANDS ON THE TRIGGER ALONE. A stored row is served to a
    // DIFFERENT client and is audited against its own question only
    // (`dynamicRowViolations`), so a sentence that needed the session's area to
    // be true is served this once and NOT stored — the #29/#30 defect, where
    // «…во Центар…» / «…во Аеродром…» was banked under a question that named
    // no area at all.
    const bankable = validateDynamicAnswer(answer, userMsg, { typeKnown }).length === 0;
    // Count the call against the session budget only once it SUCCEEDED — a
    // dirty answer or a quota error teaches us nothing and must not spend it.
    session.slots.generatedAnswers = (session.slots.generatedAnswers ?? 0) + 1;
    if (!bankable) return { text: answer, source: 'dynamic' };
    const key = dynamicSlug(session.state, userMsg);
    // A — A STOCK-AT-A-PLACE ANSWER IS STORED TWICE (the [22:58] capture round):
    // verbatim, for the phrasing it was taught, AND as a {place} template plus
    // the anchor it was written for. The template is what makes the same
    // sentence recyclable: same place in different words, and (once B promotes
    // it) a different place in any words. `placeTemplateFrom` refuses a
    // district-bound sentence, so this can never launder one district's claim
    // into another's.
    const anchor = session.slots.poiAnchor;
    const template = detectInventoryAsk(userMsg) && anchor
      ? placeTemplateFrom(answer, [anchor, extractPoiWish(userMsg)])
      : undefined;
    // PHASE 6 — QUARANTINED (review gate): the answer is served THIS turn (the
    // caller returns it directly), and it may not be recalled for anyone else
    // until a human approves the row (`npm run bank:review-dynamic`). Validation
    // is hygiene, not truth: this sentence was written for THIS question and
    // validated against it, which is no warrant for the next client.
    store.addDynamic(key, session.state, userMsg, answer,
      { ...(template && anchor ? { template, place: anchor } : {}), unreviewed: true });
    return { text: answer, source: 'dynamic', key };
  } catch {
    // Quota, network, timeout — degrade to the pre-existing path silently.
    return undefined;
  }
}

/**
 * GENERATE-OR-RECALL: the entry point wired into Responder.escalate().
 * Recall first (free); on miss, one constrained Gemini call; on failure or
 * dirty output, undefined → the caller falls back exactly as before.
 */
export async function dynamicAnswer(
  llm: LlmClient,
  session: ChatSession,
  userMsg: string,
  store: {
    retrieveDynamic: (m: string) => { key: string; answer: string; msg?: string } | undefined;
    addDynamic: (key: string, state: string, msg: string, answer: string, meta?: { template?: string; place?: string; unreviewed?: boolean }) => boolean;
  },
): Promise<DynamicResult | undefined> {
  const recalled = recallDynamic(store, userMsg, typeEstablished(session.slots, userMsg), sessionPlaces(session));
  if (recalled) return recalled;
  return generateDynamic(llm, session, userMsg, store);
}
