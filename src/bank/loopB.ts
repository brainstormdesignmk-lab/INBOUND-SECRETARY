/**
 * LOOP B — the answer side of the closed loop (plan doc P2): corrections +
 * the client message + the key's P1 contract → strict-Gemini candidates →
 * validateBatch gates → STAGED. Nothing serves until a human promotes it.
 *
 * ONE implementation, two entry points (the relearnBank precedent):
 *   • `npm run bank:relearn -- --from-corrections` (scripts/relearn.ts)
 *   • the bank:tui 'P' menu (src/bank/tui.ts)
 * Neither construction (loadConfig/factory) nor the vetoes live in the CLI:
 * a per-key failure can never kill the batch, and the TUI runs the same code
 * on the same master DB, so the audit trail cannot diverge.
 */
import { BankStore, DATA_DRIVEN_KEYS, MAX_VARIANTS_PER_KEY } from '../store/bank';
import { RESPONSE_BANK } from '../data/responses';
import { createLlmStrict } from '../llm/factory';
import { loadConfig } from '../config';
import { renderPromptBlock, validateBatch, constraintsFor } from '../llm/bankConstraints';
import { relearnPlan, RelearnPlanItem } from './autoPass';

function seedVariants(bank: BankStore, key: string): string[] {
  return [...((RESPONSE_BANK as unknown as Record<string, string[]>)[key] ?? []), ...bank.variants(key)];
}

export type RelearnCoreResult = { ok: true; staged: number; kept: number } | { ok: false; error: string };

/** The strict-Gemini generation core: N candidates under the key's P1
 *  contract, gated by validateBatch, written STAGED. No process.exit — the
 *  batch face must survive per-key failures; rejection lines go to the
 *  provided sink (or console for the CLI). */
export async function relearnCore(
  bank: BankStore,
  key: string,
  wrongReply: string,
  correction: string,
  correctionMsg: string,
  opts: { logRejection?: (line: string) => void } = {},
): Promise<RelearnCoreResult> {
  if (DATA_DRIVEN_KEYS.has(key)) {
    return { ok: false, error: `${key} is DATA-DRIVEN — property facts live in the row, never in bank prose. Nothing to relearn.` };
  }
  const existing = seedVariants(bank, key);
  if (existing.length >= MAX_VARIANTS_PER_KEY) {
    return { ok: false, error: `${key} already has ${existing.length} variants (max ${MAX_VARIANTS_PER_KEY}). Retire weak ones first (bank:relearn --retire <id>).` };
  }
  try {
    const llm = createLlmStrict(loadConfig());
    const res = await llm.complete({
      role: 'generate',
      messages: [
        {
          role: 'system',
          content:
            'You are a Macedonian text generator for the Metropolis real-estate assistant. The assistant gave a WRONG or unhelpful reply; a human supervisor corrected it. Your job is to GENERALIZE the correction: produce 5 alternative phrasings of the CORRECT answer, each on a new line prefixed with "- ". Different sentence structures, same policy and facts. Natural, professional, warm Macedonian. No numbering, no markdown, only the "- " prefix.\n\n' +
            renderPromptBlock(key),
        },
        {
          role: 'user',
          content:
            `Bank key: ${key}\n` +
            `Client message that triggered the wrong reply:\n${correctionMsg || '(not recorded)'}\n\n` +
            `WRONG reply the assistant gave:\n${wrongReply}\n\n` +
            `SUPERVISOR CORRECTION (the policy to express):\n${correction}\n\n` +
            `Correct existing variants for tone reference (do not copy):\n${existing.slice(0, 3).map((s, i) => `Sample ${i + 1}: ${s}`).join('\n')}\n\n` +
            `Generate 5 NEW correct variations:`,
        },
      ],
      temperature: 0.9,
      maxTokens: 900,
      topP: 0.95,
    });

    const lines = res.split('\n').filter(l => l.startsWith('- '));
    const candidates = lines.map(l => l.slice(2).trim()).filter(Boolean);
    if (candidates.length === 0) return { ok: false, error: 'the model returned no "- " lines' };
    const { kept, rejected } = validateBatch(key, candidates);
    for (const r of rejected) {
      const line = `[relearn] REJECTED — ${r.reasons.join('; ')}\n   "${r.text.slice(0, 90)}"`;
      if (opts.logRejection) opts.logRejection(line);
      else console.log(line);
    }

    let staged = 0;
    for (const v of kept) {
      const dup = existing.some(e => e.toLowerCase() === v.toLowerCase());
      if (dup) continue;
      if (bank.addStagedVariant(key, v, `relearn from correction: ${correction.slice(0, 80)}`)) staged++;
    }
    return { ok: true, staged, kept: kept.length };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

/** The DRY face of the batch: the planner over NEW corrections, no LLM. */
export function planLoopB(bank: BankStore): { plan: RelearnPlanItem[]; keys: string[] } {
  const { plan } = relearnPlan(bank.correctionsByStatus('new'), {
    isDataDriven: k => DATA_DRIVEN_KEYS.has(k),
    variantCount: k => seedVariants(bank, k).length,
    maxVariants: MAX_VARIANTS_PER_KEY,
  });
  return { plan, keys: plan.map(j => j.key) };
}

export interface LoopBRunResult {
  jobs: number;
  ok: number;
  failed: number;
  staged: number;
  lines: string[];
}

/** The batch face: every `new` correction becomes feedback for a constrained
 *  regeneration of its key. One job per key (newest correction = signal);
 *  succeeded keys mark their corrections processed (family `answer-regen`),
 *  failed keys stay `new` for a retry. apply=false is a pure dry report. */
export async function relearnFromCorrections(
  bank: BankStore,
  opts: { apply: boolean; limit?: number; correctionText?: string; log: (line: string) => void },
): Promise<LoopBRunResult> {
  const { apply, limit = 10, log } = opts;
  const { plan } = planLoopB(bank);
  const jobs = plan.slice(0, Math.max(1, limit));
  const lines: string[] = [];
  log(`[relearn:batch] plan: ${plan.length} key(s)${jobs.length < plan.length ? ` (running ${jobs.length}, --limit raises)` : ''}${plan.length ? '' : ' — nothing to do'}`);
  for (const j of plan) {
    if (jobs.includes(j)) continue;
    lines.push(`  (over limit) ${j.key} (corrections ${j.correctionIds.join(',')})`);
  }
  let ok = 0, failed = 0, staged = 0;
  if (!apply) {
    for (const j of jobs) {
      log(`  DRY ${j.key} (corrections ${j.correctionIds.join(',')}) ← "${(j.msg || '').slice(0, 48)}"`);
      lines.push(`DRY ${j.key} (corrections ${j.correctionIds.join(',')})`);
    }
    return { jobs: jobs.length, ok: 0, failed: 0, staged: 0, lines };
  }
  for (const j of jobs) {
    log(`[relearn:batch] ${j.key} (corrections ${j.correctionIds.join(',')})`);
    const supervisor = j.reason && j.reason.trim()
      ? `The served reply was rejected with audit note: "${j.reason.trim()}". Key policy: ${constraintsFor(j.key).note ?? 'answer the client correctly.'}`
      : `See the supervisor's intent: the served reply was wrong for this situation. Key policy: ${constraintsFor(j.key).note ?? 'answer the client correctly.'}`;
    const correction = opts.correctionText ?? supervisor;
    const r = await relearnCore(bank, j.key, j.wrongReply, correction, j.msg, { logRejection: log });
    if (!r.ok) {
      failed++;
      log(`[relearn:batch]   failed: ${r.error} (correction${j.correctionIds.length > 1 ? 's' : ''} stay${j.correctionIds.length > 1 ? 's' : ''} 'new')`);
      continue;
    }
    ok++;
    staged += r.staged;
    for (const id of j.correctionIds) bank.correctionResolve(id, 'answer-regen');
    log(`[relearn:batch]   staged ${r.staged}/${r.kept} candidate(s) — bank:relearn --list to review`);
  }
  return { jobs: jobs.length, ok, failed, staged, lines };
}
