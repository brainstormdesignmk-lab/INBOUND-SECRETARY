/**
 * AUTO-PASSES (runbook P5.3) — the two mechanical filters that stand between
 * a serve and the human gate, so the operator approves copy instead of
 * triaging plumbing.
 *
 * PASS 1 (auto-reject): a served turn whose ANSWER GENRE disagrees with the
 * route the money arbiter derives from the question is never offered for
 * editing. It is dismissed from the pending queue and recorded in
 * bank_corrections (status 'new'), so the signal survives for Loop B —
 * unlike the review UI's X, which loses it (audit: 2026-10 rows #235, #197).
 *
 * PASS 2 (auto re-key / bank:rekey): a pending row whose reply already
 * passes validation under the RESOLVED key (the same keyOf() the review TUI
 * binds to: K-override else suggestKey) and is not money/frozen is staged
 * automatically — the #236 shape: correct wording, thin retrieval identity.
 *
 * Both decisions are PURE here (unit-testable); the scripts in
 * scripts/autopass.ts only apply them. Default is always --dry.
 */
import { routeTupleOf, RouteTuple } from '../llm/moneyArbitration';
import { BankReview, ReviewItem, validateBankKey } from './review';
import { BankStore } from '../store/bank';
import { EnrichmentStore } from '../store/enrichment';

export function tupleString(t: RouteTuple): string {
  return `${t.topic}·${t.act}·${t.valence}·${t.target}`;
}

/** The money-lane keys whose serves the arbiter adjudicates. */
export function isMoneyLaneKey(key: string | null | undefined): boolean {
  return !!key && /^(?:fee\.|remark\.price\.)/.test(key);
}

export interface AutoRejectDecision {
  reason: string;
  tuple: string;
}

/**
 * THE PASS-1 RULE (conservative by design): bounce ONLY the provable
 * disagreement — a money-lane key served a turn the arbiter reads as a
 * RESOLVED PRICE EVALUATION (positive→expensive lanes / the valence axiom;
 * negative→the expensive lane). Every unresolved turn (tuple unknown,
 * no money vocabulary) is NOT provable and stays with the operator.
 * Pinned by rows #235 (bounced) and #197 (kept) in tests/autopass.test.ts.
 */
export function autoRejectDecision(userMsg: string, bankKey: string | null): AutoRejectDecision | null {
  if (!isMoneyLaneKey(bankKey)) return null;
  const t = routeTupleOf(userMsg);
  const tuple = tupleString(t);
  if (t.topic === 'property-price' && t.act === 'evaluate'
    && (t.valence === 'positive' || t.valence === 'negative')) {
    return {
      tuple,
      reason: `auto-reject: ${bankKey} served a turn the money arbiter parses as ${tuple}`
        + ' — a price evaluation, never a fee/persuasion turn (P5.2 valence axiom)',
    };
  }
  return null;
}

// ── PASS 3 (Loop B planner) ───────────────────────────────────────────────
export interface RelearnPlanItem {
  key: string;
  /** Every 'new' correction for this key, newest first — all are marked
   *  processed when the ONE regeneration job for the key succeeds. */
  correctionIds: number[];
  /** The newest correction's audit inputs: what served, what the client asked, why rejected. */
  wrongReply: string;
  msg: string;
  reason: string;
}

export interface RelearnPlanSkip { id: number; reason: string }

export interface RelearnPlanOpts {
  isDataDriven: (key: string) => boolean;
  variantCount: (key: string) => number;
  maxVariants: number;
}

/**
 * Group NEW corrections into one regeneration job per key (Loop B's batch
 * face; the single-correction path already exists in scripts/relearn.ts).
 * Deterministic and pure — no LLM here. The newest correction per key is
 * the generation signal; a key is skipped when it is data-driven (property
 * facts are never prose) or already at the variant cap. Corrections with no
 * key cannot bind and stay 'new' for the operator.
 */
export function relearnPlan(
  corrections: Array<{ id: number; key: string | null; msg: string; reply: string; reason: string }>,
  opts: RelearnPlanOpts,
): { plan: RelearnPlanItem[]; skipped: RelearnPlanSkip[] } {
  const byKey = new Map<string, Array<{ id: number; msg: string; reply: string; reason: string }>>();
  const skipped: RelearnPlanSkip[] = [];
  for (const c of corrections) {            // rows arrive newest-first
    if (!c.key || !c.key.trim()) { skipped.push({ id: c.id, reason: 'no key to bind' }); continue; }
    if (opts.isDataDriven(c.key)) { skipped.push({ id: c.id, reason: `${c.key} is data-driven — facts are never prose` }); continue; }
    // The cap is checked only when the key is new to the plan — the job rides
    // on the newest signal, and later corrections for the same key join it.
    if (!byKey.has(c.key) && opts.variantCount(c.key) >= opts.maxVariants) {
      skipped.push({ id: c.id, reason: `${c.key} is at the variant cap (${opts.maxVariants})` });
      continue;
    }
    const rows = byKey.get(c.key) ?? [];
    rows.push({ id: c.id, msg: c.msg, reply: c.reply, reason: c.reason });
    byKey.set(c.key, rows);
  }
  const plan: RelearnPlanItem[] = [...byKey.entries()].map(([key, rows]) => ({
    key,
    correctionIds: rows.map(r => r.id),
    wrongReply: rows[0].reply,
    msg: rows[0].msg,
    reason: rows[0].reason,
  }));
  return { plan, skipped };
}

// ── THE SHARED RUNNERS (one implementation, two entry points) ───────────────
// The CLI wrappers (scripts/autopass.ts) and the bank:tui 'P' menu both call
// these: the decision logic above never duplicates, and the write path is
// byte-identical wherever it is invoked.

export interface AutoPassRun {
  /** Pending rows examined. */
  total: number;
  /** Rows affected (would be affected in dry). */
  affected: number;
  /** Per-row report lines (the leading tag says DRY or the action). */
  lines: string[];
}

function pendingItems(review: BankReview): ReviewItem[] {
  return review.list('enrichment').filter(it => it.status === 'pending').sort((a, b) => a.id - b.id);
}

function clip(s: string | null | undefined, n: number): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > n ? t.slice(0, n) : t;
}

/**
 * PASS 1 — bounce genre-mismatched serves into bank_corrections. Dry is a
 * pure report; apply writes the correction row FIRST and only then dismisses
 * the queue row, so an interrupted run can dismiss at most rows whose signal
 * is already recorded.
 */
export function runAutoReject(review: BankReview, opts: { apply?: boolean } = {}): AutoPassRun {
  const apply = !!opts.apply;
  const bank = new BankStore(review.database);
  const en = new EnrichmentStore(review.database);
  const items = pendingItems(review);
  const lines: string[] = [];
  let affected = 0;
  for (const it of items) {
    const d = autoRejectDecision(it.userMsg ?? '', it.key ?? null);
    if (!d) continue;
    affected++;
    const rest = `[${d.tuple}] ${clip(it.userMsg, 48)}`;
    lines.push(`${apply ? 'BOUNCED' : 'DRY'} #${it.id} ${rest}`);
    if (!apply) continue;
    bank.correctionManual(it.userMsg ?? '', it.text ?? '', d.reason, it.key ?? null, null);
    en.markEnriched([it.id]);
  }
  return { total: items.length, affected, lines };
}

/**
 * PASS 2 — stage rows whose wording validates under the RESOLVED key. The
 * same guard chain the TUI's own A uses (suggestKey → flag → validateBankKey
 * → review.push), which is what makes an auto-stage safe enough to be
 * reversible by an X on the staged row.
 */
export function runRekey(review: BankReview, opts: { apply?: boolean } = {}): AutoPassRun {
  const apply = !!opts.apply;
  const items = pendingItems(review);
  const lines: string[] = [];
  let affected = 0;
  for (const it of items) {
    if (autoRejectDecision(it.userMsg ?? '', it.key ?? null)) continue; // pass 1's job
    const target = review.suggestKey(it);
    if (!target || target === it.key) continue;            // no re-key to do
    if (it.flag === 'key' || it.flag === 'fail') continue;  // stays with the operator
    if (validateBankKey(target)) continue;                 // belt: push re-checks
    affected++;
    const rest = `${it.key ?? '—'} → ${target} ${clip(it.userMsg, 40)}`;
    if (!apply) { lines.push(`DRY #${it.id} ${rest}`); continue; }
    const r = review.push(it, target, it.text ?? '');
    if (!r.ok) { affected--; lines.push(`STAGING FAILED #${it.id}: ${r.reason}`); continue; }
    lines.push(`STAGED #${it.id} ${rest}`);
  }
  return { total: items.length, affected, lines };
}
