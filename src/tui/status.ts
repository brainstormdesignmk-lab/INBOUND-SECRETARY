/**
 * THE LOOP, ON THE OPERATOR'S SCREEN — `/status` rows for the learning loop.
 *
 * Why these two numbers and no others: the loop can fail in exactly two ways
 * that are invisible in a normal chat log.
 *
 *   1. THE STORE STOPS FILLING. A generate+store loop with a dead gate or a
 *      revoked key looks like a healthy bot — it just answers from the seed
 *      bank forever. The session counter says how many novel answers were
 *      actually generated (and how much of the budget is left).
 *   2. THE BACKLOG STOPS DRAINING. Captures accumulate in `bank_dynamic` and
 *      nobody binds them to a key, so every occurrence keeps costing a model
 *      call. `dynamicPending` is that queue.
 *
 * Kept as a pure function (no blessed, no DB) so a test can pin the wording and
 * the arithmetic without driving a terminal.
 */

import { MAX_GENERATED_PER_SESSION } from '../llm/dynamicFallback';

export interface LoopCounters {
  /** Dynamic captures still waiting for a key binding. */
  pending: number;
  /** Generated answers served in the ACTIVE chat this session. */
  generated: number;
  /** The per-session ceiling; defaults to the gate's own constant. */
  cap?: number;
}

export function loopStatusLines(c: LoopCounters): string[] {
  const cap = c.cap ?? MAX_GENERATED_PER_SESSION;
  const left = Math.max(0, cap - c.generated);
  const budget = c.generated === 0
    ? `генерирани одговори оваа сесија: 0/${cap} (сите одговори дојдоа од банката/детерминистиката)`
    : `генерирани одговори оваа сесија: ${c.generated}/${cap} (преостанати ${left})`;
  const backlog = c.pending === 0
    ? 'динамични каптури: 0 — сè е врзано за клуч'
    : `динамични каптури: ${c.pending} чекаат клуч — bank:relearn --pending → --bind <id> <key>`;
  return [budget, backlog];
}
