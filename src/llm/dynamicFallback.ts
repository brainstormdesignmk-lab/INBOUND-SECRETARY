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
            'You are Лина, the Metropolis real-estate assistant. The question was not in your knowledge bank. Answer it helpfully, warmly, in natural Macedonian, 1–3 sentences, ending with a question that moves the conversation forward (usually offering to contact the owner or organize a visit).\n\n' +
            'EXCEPTION — CONVERSATION EXIT: if the client is clearly saying goodbye or politely declining (чао/фала/пријатно/не сакам/не фала), answer with ONE short warm farewell sentence that ends with „Се најдобро!" — and NOTHING else. NO question at the end, NO offer of further help: she helped enough, the exit must be clean.\n\n' +
            'HARD RULES (answers violating them are discarded):\n' +
            '- NEVER state or invent: a price, an availability status, an address, an Евидентен број, a size, or any property fact. Prices and availability belong to owners and are verified by calling them — say you will check with the owner if asked.\n' +
            '- If the client asks for a fact you do not have (year built, renovation year, floor, orientation, exposure…), say plainly that the detail is not in your record and that you will check with the owner. Do NOT answer a factual question with a general presentation or visit offer.\n' +
            '- Use ONLY the known context provided. Do not invent neighborhoods, buildings, or landmarks.\n' +
            '- No promises, no guarantees, no discounts, no concrete commitments.\n' +
            `- Maximum 420 characters.\n\n${factBlock}`,
        },
        ...session.history.slice(-6).map(m => ({ role: m.role as 'user' | 'assistant', content: m.text })),
        { role: 'user', content: userMsg },
      ],
      temperature: 0.7,
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
