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

/** Validation for a dynamic candidate — P1 baseline + hygiene + no-facts. */
export function validateDynamicAnswer(answer: string): string[] {
  const violations = violationsFor(answer, 'dynamic.fallback');
  if (!replyIsClean(answer)) violations.push('fails reply hygiene (replyIsClean)');
  for (const re of FORBIDDEN_FACTS) if (re.test(answer)) { violations.push('names a concrete fact (EB/amount/address)'); break; }
  return violations;
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
  if (validateDynamicAnswer(hit.answer).length > 0) return undefined;
  return { text: hit.answer, source: 'dynamic-recall', key: hit.key };
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
            'HARD RULES (answers violating them are discarded):\n' +
            '- NEVER state or invent: a price, an availability status, an address, an Евидентен број, a size, or any property fact. Prices and availability belong to owners and are verified by calling them — say you will check with the owner if asked.\n' +
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
    if (!answer || validateDynamicAnswer(answer).length > 0) return undefined;
    const key = dynamicSlug(session.state, userMsg);
    store.addDynamic(key, session.state, userMsg, answer);
    return { text: answer, source: 'dynamic', key };
  } catch {
    // Quota, network, timeout — degrade to the pre-existing path silently.
    return undefined;
  }
}
