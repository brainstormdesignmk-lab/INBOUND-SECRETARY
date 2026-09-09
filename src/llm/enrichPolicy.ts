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
  return brainMode !== 'free';
}
