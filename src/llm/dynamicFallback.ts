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
  detectAvailabilityAsk, detectContactRequest, detectOwnerContact, detectPriceAsk,
  detectProvisionAsk, detectProvisionWho, detectVisitInterest, fsmRequired, isFeeFrame, isFeeTraffic,
} from './deterministic';
import { isPersonalAsk, revealsMachineIdentity } from './personal';
import type { LlmClient } from './types';
import type { ChatSession } from '../fsm/session';

/** The concrete-forbidden rule: no EB numbers, no amounts, no addresses.
 *  Session slots may only confirm what the client already established. */
const FORBIDDEN_FACTS: RegExp[] = [
  /(?:евидентен|evidenten)?\s*број\s*\d+|eb\s*\.?\s*\d+|\b\d{3,}\b\s*(?:број|br)/iu,
  /\d[\d\s.,]{2,}\s*(?:евра|денари|мкд|eur|evra)/iu,
  /улица\s+\p{Lu}|ул\.\s*\p{Lu}/u,
  /\b\d{1,3}\s*м2\b|\b\d{1,3}\s*м²/iu,
  /достапен\s+(?:е|e)\s+(?:во|во момент)|слободен\s+(?:е|e)\s+(?:во|сега)/iu,
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

/** Validation for a dynamic candidate — P1 baseline + hygiene + no-facts +
 *  RELEVANCE. `userMsg` is optional so existing callers/tests keep their
 *  contract; when given, a generic presentation pitch can no longer answer a
 *  factual question, because that is how the bank stored a wrong answer. */
export function validateDynamicAnswer(answer: string, userMsg?: string): string[] {
  const violations = violationsFor(answer, 'dynamic.fallback');
  if (!replyIsClean(answer)) violations.push('fails reply hygiene (replyIsClean)');
  // PERSONA GUARD (the [08:38] capture): the stored age answer said „Јас сум
  // дигитален асистент, па немам години“. A machine identity is a policy
  // breach, not a wording choice — rejected at generation AND on recall, so
  // tightening this rule retroactively neutralises rows stored before it.
  if (revealsMachineIdentity(answer)) violations.push('exposes a machine identity or refuses an age');
  for (const re of FORBIDDEN_FACTS) if (re.test(answer)) { violations.push('names a concrete fact (EB/amount/address)'); break; }
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

/** RECALL: a stored, previously-validated answer for this question shape. */
export function recallDynamic(
  bank: { retrieveDynamic: (m: string) => { key: string; answer: string } | undefined },
  userMsg: string,
): DynamicResult | undefined {
  const hit = bank.retrieveDynamic(userMsg);
  if (!hit) return undefined;
  // Re-validate on recall: a contract change or hygiene tightening applies
  // retroactively — stale rows degrade to the normal path instead of serving.
  if (validateDynamicAnswer(hit.answer, userMsg).length > 0) return undefined;
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
    addDynamic: (key: string, state: string, msg: string, answer: string) => boolean;
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
    if (!answer || validateDynamicAnswer(answer, userMsg).length > 0) return undefined;
    const key = dynamicSlug(session.state, userMsg);
    store.addDynamic(key, session.state, userMsg, answer);
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
    addDynamic: (key: string, state: string, msg: string, answer: string) => boolean;
  },
): Promise<DynamicResult | undefined> {
  const recalled = recallDynamic(store, userMsg);
  if (recalled) return recalled;
  return generateDynamic(llm, session, userMsg, store);
}
