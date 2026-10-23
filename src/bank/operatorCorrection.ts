/**
 * OPERATOR CORRECTION INTAKE — one path for "the human typed the right answer".
 *
 * The 2026-10 F9 session exposed the hole this module closes. The operator
 * corrected an answer and the right wording went into `bank_corrections.reply`,
 * where NOTHING reads it: loop-a mines the TRIGGER message for detector
 * families, never the reply. Meanwhile the enrichment row still held the WRONG
 * prose, so the midnight digest re-banked the mistake and the correction
 * vanished. In the operator's words: "enrichment has only the raw chat output".
 *
 * A correction now does four things, in this order:
 *
 *   1. the serve-log row is REWRITTEN to the corrected text, so ENRICHMENT
 *      shows what the operator wrote and the digest cannot re-learn the old
 *      line;
 *   2. the row is BOUND to the resolved key, so the next digest files the
 *      corrected prose under it instead of inventing a second `learn.*`;
 *   3. the operator's exact wording is written as a STAGED variant (never
 *      LLM-regenerated — the phrasing IS the instruction) plus the client
 *      message as a retrieval example;
 *   4. bank_corrections keeps BOTH texts: `reply` = what served (the mistake),
 *      `corrected` = the replacement, so the audit shows what changed and
 *      loop-a can stage any correction that arrived by another route.
 *
 * Staged means "in the bank, not yet serving": approval stays the explicit
 * promote in bank:tui (or `--serve` on the CLI).
 */

import { BankStore, DATA_DRIVEN_KEYS } from '../store/bank';
import { EnrichmentStore, EnrichmentRecord } from '../store/enrichment';
import { RESPONSE_BANK } from '../data/responses';
import { learnKeySlug, validateBankText } from './review';

export interface OperatorCorrectionInput {
  /** The client message whose answer was wrong. */
  triggerMsg: string;
  /** The wording the operator wants served instead. */
  rightReply: string;
  /** The text that actually served. Verbatim is best: it pins the row. */
  wrongReply?: string;
  /** Target the turn by id (bank:tui / teach --id)… */
  rowId?: number;
  /** …or by chat (defaults to that chat's newest logged turn). */
  chatId?: string;
  /** Explicit key when the turn carried none (teach --key). */
  key?: string | null;
}

export interface OperatorCorrectionResult {
  ok: boolean;
  reason?: string;
  rowId: number | null;
  key: string;
  /** The queue row now shows the corrected text. */
  queueUpdated: boolean;
  /** The operator's wording was written to the bank as a STAGED variant. */
  staged: boolean;
  /** Audit row id in bank_corrections. */
  correctionId: number | null;
}

/** Find the row being corrected: explicit id, else the exact reply in that
 *  chat, else that chat's newest logged turn. */
function resolveRow(
  enrichment: EnrichmentStore,
  input: OperatorCorrectionInput,
): EnrichmentRecord | null {
  if (input.rowId != null) return enrichment.byId(input.rowId);
  if (!input.chatId) return null;
  if (input.wrongReply) {
    const exact = enrichment.findByReply(input.chatId, input.wrongReply);
    if (exact) return exact;
  }
  const latest = enrichment.latestForChat(input.chatId);
  return latest ? enrichment.byId(latest.id) : null;
}

/** The key a correction belongs to. Dynamic groups are not bank keys: a
 *  corrected dynamic answer is bound to a key derived from the question. */
function resolveKey(input: OperatorCorrectionInput, row: EnrichmentRecord | null): string {
  const explicit = (input.key ?? '').trim();
  if (explicit) return explicit;
  const own = (row?.bankKey ?? '').trim();
  if (own && !own.startsWith('dynamic:')) return own;
  return learnKeySlug(input.triggerMsg || row?.userMsg || '');
}

/** The scoping prefix of a route family: the first segment plus the dot.
 *  "fee.persuade.1.buy" → "fee." — the whole fee script family, every market
 *  and rung. "learn." → "learn." (the rule never forbids learn keys targets). */
export function routeFamily(key: string): string {
  const dot = key.indexOf('.');
  return dot > 0 ? `${key.slice(0, dot)}.` : key;
}

export function applyOperatorCorrection(
  bank: BankStore,
  enrichment: EnrichmentStore,
  input: OperatorCorrectionInput,
): OperatorCorrectionResult {
  const text = (input.rightReply ?? '').trim();
  const empty: OperatorCorrectionResult = {
    ok: false, rowId: null, key: '', queueUpdated: false, staged: false, correctionId: null,
  };
  if (!text) return { ...empty, reason: 'corrected text is empty' };

  const row = resolveRow(enrichment, input);
  const triggerMsg = (input.triggerMsg || row?.userMsg || '').trim();
  if (!triggerMsg) return { ...empty, reason: 'no trigger message — nothing to bind the correction to' };

  const key = resolveKey(input, row);
  if (DATA_DRIVEN_KEYS.has(key)) {
    return { ...empty, rowId: row?.id ?? null, reason: `${key} is data-driven — property facts live in the property row, never in prose` };
  }

  // Same gate as bank:tui's push: the corrected line is client-facing copy, so
  // it passes reply hygiene, the key contract, and the duplicate check.
  const existing = [
    ...(RESPONSE_BANK[key] ?? []),
    ...bank.variants(key),
    ...bank.stagedVariants(key).map(v => v.text),
  ];
  // A duplicate is not a reason to reject a human: if the wording is already
  // banked, the correction simply has nothing to add. Hygiene, identity and
  // key-contract failures stay fatal — those are the ones that must not serve.
  const already = existing.some(e => e.replace(/\s+/g, ' ').trim() === text.replace(/\s+/g, ' ').trim());
  const errs = validateBankText(key, text, existing)
    .filter(e => !/^duplicate variant/i.test(e) && !/^too similar/i.test(e));
  if (errs.length > 0) {
    return { ...empty, rowId: row?.id ?? null, key, reason: errs.join('; ') };
  }

  // 1/2 — the queue row becomes the corrected turn, bound to its key.
  let queueUpdated = false;
  if (row) {
    queueUpdated = enrichment.updateReply(row.id, text);
    if (!row.bankKey) enrichment.setBankKey(row.id, key);
  }

  // 3 — the operator's exact wording enters the bank as STAGED.
  const note = row ? `operator correction of ENRICHMENT #${row.id}` : 'operator correction';
  const staged = already ? false : bank.stageOperatorVariant(key, text, triggerMsg, note);

  // 4 — audit: what served vs what the human wanted. A re-run of the same
  // correction reuses its row instead of duplicating the tray entry.
  const wrongReply = (input.wrongReply ?? row?.replyText ?? '').trim();
  const correctionId = bank.findCorrectionId(triggerMsg, text) ?? bank.correctionManual(
    triggerMsg,
    wrongReply,
    `operator corrected → staged ${key}`,
    row?.bankKey ?? null,
    text,
  );

  // 5 — P5.1: the route correction becomes a FIRST-CLASS OBJECT. When the
  // question moved to a different key family, the old family already burned
  // this exact utterance — write the negative rule so its lanes can NEVER
  // claim that phrasing again, and record the correction id in the note so
  // the rule is auditable back to the mistake.
  const fromKey = (row?.bankKey ?? '').trim();
  if (fromKey && fromKey !== key) {
    const fromFamily = routeFamily(fromKey);
    if (fromFamily !== routeFamily(key)) {
      bank.addNegativeRule(
        row?.userMsg || triggerMsg,
        fromFamily,
        `route correction #${correctionId}: ${fromKey} → ${key}`,
      );
    }
  }

  return { ok: true, rowId: row?.id ?? null, key, queueUpdated, staged, correctionId };
}
