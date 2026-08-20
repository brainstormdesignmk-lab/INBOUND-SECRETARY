import { ChatSession } from '../fsm/session';
import { classifyOffensive, OffenseDetection } from './offensive';

// ========================================
// 3-STRIKE INSULT PROTOCOL — ported from ANA (offensive-filter.js v2)
// ========================================
// Detection is DETERMINISTIC (offensive.ts lexicon) and runs BEFORE any other
// processing — an insult is a strike no matter which brain is live (even the
// LLM-free path). All offenses escalate equally: strike 1 → professional
// rebuff, strike 2 → final warning, strike 3 → terminate + blocklist. No
// offense type (even sexual/violent severity-3) skips the warning stage.
//
// STRIKE DECAY:
//   - Strike 1 decays: if the NEXT message is clean (the client corrects
//     themselves), the counter resets to 0 — a later offense starts from
//     strike 1 again.
//   - Two CONSECUTIVE offenses reach strike 2 (final warning). After that the
//     counter NEVER decays: a clean message leaves it at 2, and any further
//     offense terminates the chat at strike 3.
// ========================================

// Strike 1 (first offense) — professional rebuff. Rotates so Lina doesn't
// sound like a broken record. All variants keep the professional tone.
export const STRIKE_1_RESPONSES = [
  'Ве молам, да ја задржиме комуникацијата професионална.',
  'Господине, ве молам да одржуваме професионален тон во разговорот.',
  'Ве молам, да продолжиме професионално — ова е деловна комуникација.',
  'Господине, ќе ви бидам благодарна доколку комуницираме професионално.',
];

// Strike 2 (final warning) — last chance before termination. All variants keep
// the 'последна опомена' phrasing.
export const STRIKE_2_RESPONSES = [
  'Господине, ова е последна опомена. Доколку продолжите со ваков речник, ќе морам да го прекинам разговорот.',
  'Господине, ова е вашата последна опомена. Ако продолжите вака, ќе бидам принудена да го прекинам разговорот.',
  'Господине, последна опомена — доколку не се смирите, разговорот ќе биде прекинат.',
];

export const OFFENSE_WARNINGS: Record<number, string> = {
  1: STRIKE_1_RESPONSES[0],
  2: STRIKE_2_RESPONSES[0],
};

export type StrikeOutcome = 'none' | 'warn' | 'warnFinal' | 'terminate';

/** STRIKE DECAY STATE MACHINE — the counter after one message:
 *  - offensive message → +1 (capped at 3)
 *  - clean message after strike 1 → 0 (the client corrected themselves)
 *  - clean message after strike 2+ → unchanged (final warning never decays) */
export function applyStrikeDecay(currentStrikes: number, messageWasOffensive: boolean): number {
  const cur = currentStrikes || 0;
  if (messageWasOffensive) return Math.min(cur + 1, 3);
  if (cur === 1) return 0;
  return cur;
}

/** Applies the 3-strike protocol to a session after a message. MUST be called
 *  on EVERY message (offensive ones strike; clean ones decay), and the result
 *  persists on the session. 'none' means the conversation continues normally. */
export function applyStrike(session: ChatSession, offense: OffenseDetection): StrikeOutcome {
  session.strikes = applyStrikeDecay(session.strikes, offense.isOffensive);
  if (!offense.isOffensive) return 'none';
  // All offenses escalate equally — severity 3 (sexual/violence) is still
  // strike 1/2/3 in order; nothing skips the warning stage (ANA parity).
  if (session.strikes >= 3) return 'terminate';
  return session.strikes === 2 ? 'warnFinal' : 'warn';
}

/** The deterministic offense scan — thin wrapper kept for call-site clarity. */
export function detectOffensive(text: string): OffenseDetection {
  return classifyOffensive(text);
}
