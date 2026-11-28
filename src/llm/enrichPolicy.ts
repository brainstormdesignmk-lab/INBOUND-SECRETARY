/**
 * THE TEACHER/EXAM POLICY — when does a reply enter the enrichment queue?
 *
 *   hybrid / gemini / groq  = TEACHER. Every reply is logged so the midnight
 *     cron can digest it into bank variants and new keys. The LLM does the
 *     work once; the bank keeps the rent forever.
 *
 *   free                    = EXAM. The pure deterministic+bank stack answers
 *     alone, with ZERO logging — nothing the exam generates may teach the
 *     bank, or the measurement would be circular ("did the bank work?" can't
 *     be answered with answers the bank learned a second ago). Escalations
 *     still happen (knowledge-based dispatch never caps knowledge); they are
 *     simply not recorded. This mode exists to TEST that the enrichment
 *     worked — the final goal: answering without LLMs.
 *
 * Unknown modes default to TEACHER — a bug must never silently stop learning.
 */
export function shouldLogForEnrichment(
  brainMode: string | undefined,
  _isLlmReply: boolean,
  _source?: string,
): boolean {
  return shouldTeachBank(brainMode);
}

/** TEACHING and MEASURING are two different questions, and conflating them left
 *  the exam mode blind: `free` returns false here, so the mode that exists to
 *  prove "the bank answers alone" wrote NOTHING to the queue — and the verdict
 *  ledger inherited the same silence. Teaching may be suppressed (exam answers
 *  must not become bank fuel); measurement never may. */
export function shouldTeachBank(brainMode: string | undefined): boolean {
  return brainMode !== 'free';
}

/** Recording a classify verdict is measurement: it feeds the route table, the
 *  abstain calibration and the local model, and it can never teach the bank.
 *  Always on — an appliance that stops measuring cannot be tuned, and the
 *  silent failure is indistinguishable from a healthy one. */
export function shouldRecordTurn(): boolean {
  return true;
}
