/**
 * THE LLM AS LAST-RESORT ARBITER — Option 3 of the routing program (P5.2).
 *
 * The deterministic money region (arbitrateMoney) resolves everything it can.
 * When a money-vocabulary turn leaves the region UNCLAIMED — the explicit
 * `unknown.<topic>.<act>` bucket — there is one safe thing left to try before
 * free-form prose: ask the escalation LLM to pick ONE bank key from a CLOSED
 * menu. The LLM is a router, never an author:
 *
 *   - it picks from an ALLOWED KEY LIST (the money serve menu, all bank-backed);
 *   - it must return the TUPLE (topic × act × valence × target) it is routing;
 *   - the deterministic VETOES stay sovereign: a pick whose object contradicts
 *     the seam evidence is REFUSED (undefined → the caller falls through
 *     unchanged);
 *   - the answered pair is stored as a LABELED EXAMPLE (bank.addExample) for
 *     the operator to review — it never serves again except through approval;
 *   - the serve text comes from pickVariant(key) — existing bank seeds only.
 *     The LLM never authors money copy.
 *
 * Reminder: a free-form escalation LLM call is MORE expensive and MORE
 * dangerous than a menu pick, so this path runs ONLY on turns the arbiter
 * already named as residue. If the LLM says nothing valid, the pre-existing
 * escalation path (full prose LLM) runs unchanged.
 */
import type { LlmClient, CompleteOpts } from './types';
import { isFeeFrame, detectPriceEval } from './deterministic';
import type { MoneyVerdict, RouteTuple } from './moneyArbitration';

/** The CLOSED serve menu. Every entry is a bank-backed money route whose copy
 *  is owned by the bank — the LLM may pick one, never write one. */
export const MONEY_ARBITER_MENU: string[] = [
  'ask.money.clarify',
  'remark.price.cheap',
  'remark.price.expensive',
  'fee.ask.agnostic',
  'fee.ask.buy',
  'fee.ask.rent',
  'provision.ask.buy',
  'provision.ask.rent',
];

export interface ArbiterPick {
  key: string;
  /** The tuple the ARBITER computed for the turn (not the LLM's copy of it). */
  tuple: RouteTuple;
}

const MENU_SET = new Set(MONEY_ARBITER_MENU);

/** Parse the JSON object out of an LLM reply (first balanced braces block). */
export function parseArbiterJson(reply: string): { key?: string; tuple?: Partial<RouteTuple>; reason?: string } | undefined {
  const start = reply.indexOf('{');
  const end = reply.lastIndexOf('}');
  if (start < 0 || end <= start) return undefined;
  try {
    const obj = JSON.parse(reply.slice(start, end + 1));
    return obj && typeof obj === 'object' ? obj : undefined;
  } catch {
    return undefined;
  }
}

/**
 * THE VETO VALIDATION — the deterministic layer keeps sovereignty. A pick is
 * an instruction the seam either can corroborate or rejects:
 *   - `ask.money.clarify` is always allowed (the ONE safe script for money);
 *   - `remark.price.cheap` requires the seam to have seen POSITIVE price valence;
 *   - `remark.price.expensive` requires NEGATIVE valence on the price topic;
 *   - fee/provision family keys require the FEE FRAME probe (a fee/visit
 *     referent really is in the text — the LLM may not conjure one).
 */
export function vetoPickedKey(key: string, text: string, arb: MoneyVerdict): string | undefined {
  if (!MENU_SET.has(key)) return `key not in the allowed menu: ${key}`;
  // The LLM NEVER authors the tuple it routes by — the arbiter's tuple rules,
  // not the LLM's self-report. (A self-reported mismatch is drift, logged.)
  if (!key.startsWith('ask.money.clarify')
    && (!arb.tuple || arb.tuple.topic === undefined)) return 'arbiter tuple missing';
  if (key === 'remark.price.cheap' && detectPriceEval(text) !== 'cheap') {
    return 'cheap pick without a positive price evaluation in the text';
  }
  if (key === 'remark.price.expensive'
    && !(arb.tuple.valence === 'negative' && arb.tuple.topic === 'property-price')) {
    return 'expensive pick without a negative property-price tuple';
  }
  if ((key.startsWith('fee.') || key.startsWith('provision.')) && !isFeeFrame(text)) {
    return 'fee-family pick without a fee frame in the text';
  }
  return undefined;
}

function firstOf(s: string | undefined): string {
  return (s ?? '').trim();
}

const MENU_LINE = MONEY_ARBITER_MENU.map(k => `"${k}"`).join(' | ');

const ARBITER_SYSTEM = `You are the LAST-RESORT ROUTER for a real-estate chat agent (Lina, Metropolis — skopje, Macedonian).
The message below is money traffic (price, fee, commission, payment) that the deterministic
router could NOT resolve. Your ONLY job: pick ONE bank key from the closed menu.

Menu — the full allowed list:
${MENU_LINE}

Rules:
1. Return ONLY a JSON object, no prose: {"key": <one menu key>, "tuple": {"topic": "...", "act": "...", "valence": "...", "target": "..."}, "reason": "<one short sentence>"}
2. tuple axes — topic: property-price|fee|commission|fact|logistics|smalltalk|unknown; act: ask|assert|evaluate|complain|accept|refuse|command|unknown; valence: positive|negative|neutral|none; target: property|visit-fee|commission|agent|none.
3. NEVER pick a fee/provision key unless the message explicitly talks about the visit fee or the commission. When in doubt pick "ask.money.clarify" — asking which object the money refers to is ALWAYS safe.
4. NEVER invent a pricing answer, a discount, or copy — you choose a key only.`;

/** Ask the escalation LLM to pick ONE money-lane key from the closed menu.
 *  Returns undefined on any veto/parse failure — the caller then falls
 *  through to the pre-existing escalation path unchanged. */
export async function llmArbitrateKey(
  llm: LlmClient | undefined,
  text: string,
  state: string,
  arb: MoneyVerdict,
): Promise<ArbiterPick | undefined> {
  if (!llm) return undefined;
  const opts: CompleteOpts = {
    role: 'respond',
    messages: [
      { role: 'system' as const, content: ARBITER_SYSTEM },
      {
        role: 'user' as const,
        content: `STATE: ${state}\nARBITER TUPLE (deterministic, authoritative): topic=${arb.tuple.topic} act=${arb.tuple.act} valence=${arb.tuple.valence} target=${arb.tuple.target}\n\nMESSAGE:\n${text}`,
      },
    ],
    temperature: 0,
    maxTokens: 160,
    topP: 1,
  };
  let reply: string;
  try {
    reply = await llm.complete(opts);
  } catch {
    return undefined; // LLM down — the pre-existing escalation path takes it
  }
  const parsed = parseArbiterJson(reply);
  if (!parsed) return undefined;
  const key = firstOf(parsed.key);
  const veto = vetoPickedKey(key, text, arb);
  if (veto) {
    console.log(`[arbiter-llm] vetoed ${key || '(no key)'}: ${veto}`);
    return undefined;
  }
  return { key, tuple: arb.tuple };
}
