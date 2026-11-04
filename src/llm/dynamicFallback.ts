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
  detectProvisionAsk, detectProvisionWho, detectVisitInterest, extractPoiWish, fsmRequired, isFeeFrame, isFeeTraffic,
} from './deterministic';
import { placeTemplateFrom } from './placeTemplate';
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
];

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
export function validateDynamicAnswer(answer: string, userMsg?: string, opts?: { typeKnown?: boolean }): string[] {
  const violations = violationsFor(answer, 'dynamic.fallback');
  if (!replyIsClean(answer)) violations.push('fails reply hygiene (replyIsClean)');
  // PERSONA GUARD (the [08:38] capture): the stored age answer said „Јас сум
  // дигитален асистент, па немам години“. A machine identity is a policy
  // breach, not a wording choice — rejected at generation AND on recall, so
  // tightening this rule retroactively neutralises rows stored before it.
  if (revealsMachineIdentity(answer)) violations.push('exposes a machine identity or refuses an age');
  for (const re of FORBIDDEN_FACTS) if (re.test(answer)) { violations.push('names a concrete fact (EB/amount/address/rooms/area/year/floor)'); break; }
  // THE SERVICE QUESTION PRESUMES NO TYPE (the [21:20] capture): asking
  // «купување или изнајмување?» over «стан» claims a fact the client never
  // gave. Rejected at generation AND on recall, so a stored row from before
  // this rule degrades to the deterministic line instead of serving.
  if (!(opts?.typeKnown ?? typeEstablished({}, userMsg))
    && ASKS_SERVICE_RE.test(answer) && namesPropertyType(answer)) {
    violations.push('names a property type the client never mentioned (ask купување/изнајмување on недвижност)');
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
  return true;
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

/** RECALL: a stored, previously-validated answer for this question shape. */
export function recallDynamic(
  bank: { retrieveDynamic: (m: string) => { key: string; answer: string } | undefined },
  userMsg: string,
  typeKnown?: boolean,
): DynamicResult | undefined {
  const hit = bank.retrieveDynamic(userMsg);
  if (!hit) return undefined;
  // Re-validate on recall: a contract change or hygiene tightening applies
  // retroactively — stale rows degrade to the normal path instead of serving.
  if (validateDynamicAnswer(hit.answer, userMsg, { typeKnown }).length > 0) return undefined;
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
    addDynamic: (key: string, state: string, msg: string, answer: string, meta?: { template?: string; place?: string }) => boolean;
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
            '- Користи САМО дадениот познат контекст. Не измислувај населби, згради или знаменитости.\n' +
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
    if (!answer || validateDynamicAnswer(answer, userMsg, { typeKnown }).length > 0) return undefined;
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
    store.addDynamic(key, session.state, userMsg, answer,
      template && anchor ? { template, place: anchor } : undefined);
    // Count the call against the session budget only once it SUCCEEDED — a
    // dirty answer or a quota error teaches us nothing and must not spend it.
    session.slots.generatedAnswers = (session.slots.generatedAnswers ?? 0) + 1;
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
    retrieveDynamic: (m: string) => { key: string; answer: string } | undefined;
    addDynamic: (key: string, state: string, msg: string, answer: string, meta?: { template?: string; place?: string }) => boolean;
  },
): Promise<DynamicResult | undefined> {
  const recalled = recallDynamic(store, userMsg, typeEstablished(session.slots, userMsg));
  if (recalled) return recalled;
  return generateDynamic(llm, session, userMsg, store);
}
