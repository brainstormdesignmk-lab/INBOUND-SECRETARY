/**
 * THE REVIEW SERVICE — the human gate's logic, with no blessed and no argv.
 *
 * bank:tui (src/bank/tui.ts) is a thin screen over this class, so every action
 * the operator takes is also exercisable by a test and by a future CLI.
 *
 * THE FOUR CATEGORIES, and why each exists:
 *
 *   enrichment  — turns the loop logged (enrichment_queue). The cron used to
 *                 write these straight into the bank; now it STAGES them, and
 *                 this is where a human edits the reply, chooses the target
 *                 key and pushes it.
 *   dynamic     — bank_dynamic captures (a generated answer served and cached
 *                 for a question shape). Editable and pushable; rejecting one
 *                 deletes it so it stops serving.
 *   staged      — bank_variants lifecycle='staged': written by the cron /
 *                 digest / a push, NOT served. Edit → approve (promote) or
 *                 discard.
 *   active      — learned variants already serving. READ-ONLY by policy:
 *                 changing live copy must go through staging; the only action
 *                 here is retiring it (reversible).
 */
import { Db } from '../store/db';
import { BankStore, DATA_DRIVEN_KEYS, isExcludedFromEnrichment } from '../store/bank';
import { EnrichmentStore } from '../store/enrichment';
import { RESPONSE_BANK, RESPONSE_GENERATION_CONTEXT } from '../data/responses';
import { violationsFor } from '../llm/bankConstraints';
import { replyIsClean, similarity } from '../llm/enrichQuality';
import { revealsMachineIdentity } from '../llm/personal';
import { siblingQuestions } from './provenance';
import { routeTupleOf, unknownBucket, isMoneyVocab } from '../llm/moneyArbitration';
import { isCodeConstant } from './codeSource';
import { examplesFromImportNote, sourceIdFromImportNote, markImportDecision } from './fleet';
import { translitToLatin } from '../geo/offlineMap';

export type ReviewCategory = 'enrichment' | 'dynamic' | 'staged' | 'active';
export const REVIEW_CATEGORIES: ReviewCategory[] = ['enrichment', 'dynamic', 'staged', 'active'];

export interface ReviewItem {
  category: ReviewCategory;
  id: number;
  /** Target/suggested bank key. Dynamic rows carry their group key here. */
  key: string | null;
  userMsg: string | null;
  text: string;
  meta: string;
  /** When this row entered the log / bank (epoch ms). The screen groups the
   *  list by this day so the operator can see which batch produced what. */
  createdAt: number;
  /** 'logged' = digested enrichment; 'processed' = dynamic served by an approved route. */
  status: 'pending' | 'processed' | 'staged' | 'active' | 'logged';
  /** Original reference and prompt direction used to generate a seed; not client provenance. */
  generationContext?: { reference: string[]; instruction: string };
  /** Pushability verdict — drives the red/gray row colour in bank:tui.
   *  'fail' = refused by the text gates (hygiene/duplicate), 'key' = the
   *  turn's key is frozen/data-driven (nothing to bank here). */
  flag?: 'ok' | 'key' | 'fail';
  /** A refusal whose EVERY cause is a duplicate/similarity hit: the bank
   *  already owns this wording, so there is no content action left — the fix
   *  lives in the serve path (lane composition), not in the bank. Paints
   *  orange (= code) instead of the bankable-content red. */
  bankOwned?: boolean;
  /** A COMPOSED serve, not client-voice copy at all: property-card batches
   *  (the text embeds served Евидентен број rows) and owner-relay protocol
   *  pings (both directions). The gates misread its card prices/protocol
   *  wording as dirty copy because the serve context is lost on capture —
   *  the actionable fix is code/feed-side, so it paints orange like
   *  bankOwned, never the bankable-content red. */
  composed?: boolean;
  verdict?: string;
}

export interface ActionResult {
  ok: boolean;
  reason?: string;
  key?: string;
  staged?: boolean;
}

const STOP = new Set([
  'dali', 'ili', 'za', 'na', 'vo', 'od', 'do', 'kako', 'sto', 'shto',
  'kade', 'moze', 'mozam', 'imas', 'imate', 'li', 'se', 'e', 'a',
]);

const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
const fleetSourceTag = (note: string | null): string => { const id = /fleet-import:([^\n]+)/.exec(note ?? '')?.[1]?.split(/[ ·]/)[0]; return id ? `fleet:${id} ` : ''; };

function pushedQuestion(note: string | null): { category: 'enrichment' | 'dynamic'; id: number; question: string } | null {
  const match = /(?:^| · )review push from (enrichment|dynamic) #(\d+) · review-question:([^ ·]*)/.exec(note ?? '');
  if (!match) return null;
  try {
    return { category: match[1] as 'enrichment' | 'dynamic', id: Number(match[2]), question: decodeURIComponent(match[3]) };
  } catch {
    return null;
  }
}

/** Slug for a learned key, identical to the cron's own naming so a push from
 *  the review UI and a cron-created key land in the same namespace.
 *
 *  TRANSLITERATED (the #35 capture): a bank key is an ASCII identifier
 *  (`KEY_RE`), so a Cyrillic question used to suggest `learn.здраво-како-иде`
 *  — a key the push then refused with "key must be letters/digits/._-". The
 *  review screen offered an unbankable target for every client who typed in
 *  Cyrillic. Every learned key in the field is ASCII on purpose (phrases typed
 *  in Latin are the common case), so the slug is transliterated, never trusted
 *  as-is. */
export function learnKeySlug(msg: string): string {
  // THE SCRIPT MUST NOT CHANGE THE KEY: the stop list is Latin, so filtering
  // before transliteration dropped «kako» from «ZDRAVO KAKO IDE» but kept
  // «како» from «ЗДРАВО КАКО ИДЕ» — the same sentence named two different keys.
  const words = translitToLatin((msg || '').toLowerCase())
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !STOP.has(w));
  const slug = words.slice(0, 3).join('-') || 'misc';
  return `learn.${slug}`;
}

const KEY_RE = /^[a-z0-9][a-z0-9._-]{2,60}$/i;

/** A bank key a human may push into. Frozen/data-driven keys are refused: their
 *  wording is seeded and their routing is detector-owned. */
export function validateBankKey(key: string): string | null {
  const k = (key || '').trim();
  if (!k) return 'key is empty';
  if (k.startsWith('dynamic:')) return 'a dynamic group is not a bank key — bind it to a deterministic key';
  if (!KEY_RE.test(k)) return 'key must be letters/digits/._- (3–60 chars)';
  if (isExcludedFromEnrichment(k)) return 'frozen/data-driven key — its wording is seeded and its routing is detector-owned';
  return null;
}

/** Text a human may push/edit, under the same gates the runtime uses. */
export function validateBankText(key: string, text: string, existing: string[]): string[] {
  const t = (text || '').trim();
  const out: string[] = [];
  if (!t) return ['text is empty'];
  if (!replyIsClean(t)) out.push('fails reply hygiene (replyIsClean)');
  if (revealsMachineIdentity(t)) out.push('exposes a machine identity or refuses an age');
  out.push(...violationsFor(t, key));
  if (existing.some(e => norm(e) === norm(t))) out.push('duplicate variant for this key');
  else if (existing.some(e => similarity(e, t) > 0.7)) out.push('too similar to an existing variant (>0.7)');
  return out;
}

export class BankReview {
  private bank: BankStore;
  private enrichment: EnrichmentStore;

  constructor(private db: Db, bank?: BankStore, enrichment?: EnrichmentStore) {
    this.bank = bank ?? new BankStore(db);
    this.enrichment = enrichment ?? new EnrichmentStore(db);
  }

  /** The workstation master DB backing this review service. */
  get database(): Db { return this.db; }

  counts(): Record<ReviewCategory, number> {
    return {
      // The tab lists the whole log now, so its count is the log's size.
      enrichment: this.enrichment.totalCount(),
      dynamic: this.bank.dynamicRowCount(),
      staged: this.bank.stagedVariants().length,
      active: this.bank.activeVariantCount(),
    };
  }

  list(category: ReviewCategory): ReviewItem[] {
    if (category === 'enrichment') {
      // THE LOG, not just the backlog: every turn the loop has seen, digested
      // or pending. Newest first. Each row carries its pushability verdict so
      // the screen can paint the refused ones whole-row red.
      const existing = new Map<string, string[]>();
      const existingFor = (key: string): string[] => {
        const hit = existing.get(key);
        if (hit) return hit;
        const list = [
          ...(RESPONSE_BANK[key] ?? []),
          ...this.bank.variants(key),
          ...this.bank.stagedVariants(key).map(v => v.text),
        ];
        existing.set(key, list);
        return list;
      };
      return this.enrichment.listLog(500).map(r => {
        const item: ReviewItem = {
          category,
          id: r.id,
          key: r.bankKey,
          userMsg: r.userMsg,
          text: r.replyText,
          meta: `${r.eventType} · ${r.replySource}${r.bankKey ? ` · ${r.bankKey}` : ''} · ${r.state} · ${r.enriched ? 'digested' : 'pending'}`,
          createdAt: r.createdAt,
          status: r.enriched ? 'logged' : 'pending',
        };
        // COMPOSED-SERVE class (see the interface note). An Евидентен број
        // card serve is code-composed from feed rows; owner-relay rows are
        // protocol pings logged in both directions. Neither is client-voice
        // learnable copy, so their gates' verdicts must not paint red.
        item.composed = r.replySource === 'owner-relay'
          || /Евидентен број \d+/.test(r.replyText ?? '');
        const key = this.suggestKey(item);
        const kerr = validateBankKey(key);
        if (kerr) {
          item.flag = 'key';
          item.verdict = kerr;
        } else {
          const errs = validateBankText(key, r.replyText, existingFor(key));
          if (errs.length > 0) {
            item.flag = 'fail';
            item.verdict = errs.join('; ');
            // CODE-CLASS REFUSAL: only duplicate/similarity causes — the exact
            // (or near) wording already sits in the bank, so E/push can add
            // nothing. The red “dirty text” class stays bankable: an E edit
            // CAN clean it. A “bank-owned” refusal is a lane problem — #251/
            // #252 (budget-up asks served the price.negotiate pitch the pool
            // already held) were exactly this and painted red forever.
            item.bankOwned = errs.every(e => /^(duplicate variant|too similar to an existing)/.test(e));
          } else {
            item.flag = 'ok';
          }
        }
        return item;
      });
    }
    if (category === 'dynamic') {
      return this.bank.dynamicRows(300).map(r => ({
        category,
        id: r.id,
        key: r.key,
        userMsg: r.msg,
        text: r.answer,
        // The day is in the group header now, so the row only carries the time.
        meta: `${r.processed ? 'processed · ' : ''}${r.state} · ${new Date(r.createdAt).toTimeString().slice(0, 5)}`,
        createdAt: r.createdAt,
        status: r.processed ? 'processed' as const : 'pending' as const,
      }));
    }
    if (category === 'staged') {
      return this.bank.stagedVariants().reverse().map(v => ({
        category,
        id: v.id,
        key: v.key,
        userMsg: this.questionFor(v.note, v.key),
        text: v.text,
        meta: `${v.source} ${fleetSourceTag(v.note)}${v.note ? ` · ${v.note}` : ''}`,
        createdAt: v.created_at,
        status: 'staged' as const,
        generationContext: RESPONSE_GENERATION_CONTEXT[v.key],
      }));
    }
    return this.bank.activeVariants(300).map(v => ({
      category,
      id: v.id,
      key: v.key,
      userMsg: this.questionFor(v.note, v.key),
      text: v.text,
      meta: `${v.source} ${fleetSourceTag(v.note)}${v.note ? ` · ${v.note}` : ''}`,
      createdAt: v.createdAt,
      status: 'active' as const,
      generationContext: RESPONSE_GENERATION_CONTEXT[v.key],
    }));
  }

  /**
   * THE QUESTION BEHIND A VARIANT.
   *
   * bank_variants stores WORDING only, so for a long time ACTIVE/STAGED showed
   * a reply with no idea what it answers. Two sources, in order:
   *   1. the operator-correction note carries `ENRICHMENT #<id>` — that row's
   *      client message is the exact question the wording was written for;
   *   2. otherwise the key's retrieval examples (every question that reaches
   *      this key, newest set first) — a gapfill variant answers all of them.
   */
  private questionFor(note: string | null, key: string): string | null {
    const imported = examplesFromImportNote(note);
    if (imported.length) return imported.slice(0, 3).join('   |   ');
    const pushed = pushedQuestion(note);
    if (pushed) return pushed.question;
    const m = /ENRICHMENT #(\d+)/.exec(note ?? '');
    if (m) {
      try {
        const row = this.enrichment.byId(Number(m[1]));
        if (row) return row.userMsg;
      } catch { /* row purged after 30 days */ }
    }
    const ex = this.bank.examples(key);
    if (ex.length) return ex.slice(0, 3).join('   |   ');
    // Gapfill rows have generation instructions, not client turns. Keep the
    // client question field truthful and expose this separate provenance below.
    // A gapfill/digest variant has no note pointing at one turn — but the
    // queue still remembers which client questions reached this key. That is
    // the only surviving provenance for those rows.
    const asked = this.enrichment.questionsForKey(key, 3);
    if (asked.length) return asked.join('   |   ');
    // The chat log and the review DB are separate files here (tui.db logs the
    // turns, lina.db holds the bank), so the open file can have ZERO turns
    // while the questions exist right next to it. Look there instead of
    // telling the operator "no question" — they should never have to open a
    // second DB to see what a variant answers.
    const sib = siblingQuestions(this.db.file, key);
    return sib ? sib.questions.join('   |   ') : null;
  }

  /** WHERE A QUESTION WOULD COME FROM, and how much each source holds.
   *
   *  The detail pane says "no client question for this key" for gapfill rows.
   *  Without the counts that reads like the screen failed; with them it says
   *  which of the three sources is empty — usually all three, because the
   *  wording was generated offline and this DB never logged the turns (a
   *  different data/*.db does). */
  questionSources(item: ReviewItem): { note: boolean; examples: number; queue: number; sibling: number; fromDb?: string } {
    const key = item.key ?? this.suggestKey(item);
    const sib = siblingQuestions(this.db.file, key);
    return {
      note: /ENRICHMENT #\d+/.test(item.meta),
      examples: this.bank.examples(key).length,
      queue: this.enrichment.questionsForKey(key, 1000).length,
      sibling: sib?.questions.length ?? 0,
      fromDb: sib?.db,
    };
  }

  /** Existing keys a push may target (seed + learned). */
  keys(): string[] {
    return [...new Set([...Object.keys(RESPONSE_BANK), ...this.bank.learnedKeys()])].sort();
  }

  /**
   * The editable target key shown before a push.
   *
   * ROUTING IS NOT THE SAME AXIS AS COPY. A turn served by a frozen seed pool
   * (fee.*, contact.*) may not change that pool's wording — but its QUESTION is
   * still learnable: a wrong route must not kill the phrasing. So an
   * enrichment/dynamic turn whose own key is frozen-but-routable suggests a
   * `learn.<slug>` target, and the operator can rewrite the answer and stage it.
   *
   * Code constants (info.no.*, price.ask) and data-carried keys (address.exact,
   * availability.ack) keep their own key: there is no bankable wording and no
   * question to re-home.
   */
  suggestKey(item: ReviewItem): string {
    const own = item.key && !item.key.startsWith('dynamic:') ? item.key : '';
    if (own) {
      const capturable = item.category === 'enrichment' || item.category === 'dynamic';
      const routeOpen = capturable
        && isExcludedFromEnrichment(own)
        && !isCodeConstant(own)
        && !DATA_DRIVEN_KEYS.has(own);
      if (!routeOpen) return own;
    }
    return learnKeySlug(item.userMsg ?? '');
  }

  /** EVIDENCE CHIPS (P5.2, hard invariant 3's runbook Open item): the negative
   *  rules and the route evidence, as REPLAYABLE chips for the review UI's
   *  detail pane. Chips never change the serve — they explain it:
   *   - `нема услуга: fee.*` — a negative rule (bank_negative_rules) whose
   *     taught phrase EQUALS this row's question; the same veto the money
   *     lanes apply at serve time, now visible where the operator decides;
   *   - the tuple chip `tuple: topic·act·valence·target` — the pure, text-only
   *     classification of the question itself;
   *   - `адреса: unknown.<topic>.<act>` — the explicit residue address (money
   *     vocabulary with an unresolved tuple), the address the drift log and
   *     future banked examples carry. */
  evidenceChips(item: ReviewItem): string[] {
    const chips: string[] = [];
    const q = (item.userMsg ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
    const probe = item.userMsg ?? '';
    if (q) {
      for (const r of this.bank.negativeRules()) {
        const p = (r.phrase ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
        if (p === q) chips.push(`не служи: ${r.forbid_family}*`);
      }
    }
    if (probe) {
      const t = routeTupleOf(probe);
      chips.push(`tuple: ${t.topic}·${t.act}·${t.valence}·${t.target}`);
      // The residue address is a fact only for MONEY traffic: a tuple can be
      // unknown because the turn is smalltalk noise, but the explicit
      // unknown.<topic>.<act> address belongs to unresolvable money turns.
      if (isMoneyVocab(probe) && (t.topic === 'unknown' || t.act === 'unknown')) {
        chips.push(`адреса: ${unknownBucket(t)}`);
      }
    }
    return chips;
  }

  /** All variants a duplicate check must consider: seed + active + staged. */
  private existingFor(key: string): string[] {
    if (!key) return []; // stagedVariants('') means ALL — never let that happen
    return [
      ...(RESPONSE_BANK[key] ?? []),
      ...this.bank.variants(key),
      ...this.bank.stagedVariants(key).map(v => v.text),
    ];
  }

  /** Existing variants for the SAME resolved target key, minus the item's own
   *  text. `stagedVariants('')` returns EVERY staged row (falsy = all), so the
   *  key must be resolved before this call — never pass an empty/null key. */
  private existingExcluding(item: ReviewItem, key: string): string[] {
    return this.existingFor(key).filter(v => norm(v) !== norm(item.text));
  }

  /** EDIT — staged/enrichment/dynamic in place. ACTIVE is read-only by policy. */
  edit(item: ReviewItem, text: string, targetKey?: string): ActionResult {
    const key = targetKey?.trim() || this.suggestKey(item);
    if (item.category === 'dynamic' && item.status === 'processed') {
      return { ok: false, reason: 'dynamic capture is already processed (audit history only)' };
    }
    const kerr = validateBankKey(key);
    if (kerr) return { ok: false, reason: kerr };
    const errs = validateBankText(key, text, this.existingExcluding(item, key));
    if (errs.length > 0) return { ok: false, reason: errs.join('; ') };
    const t = text.trim();

    // ACTIVE IS EDITABLE AS A REPLACEMENT (2026-10 transcript: "why can't I
    // change the answer if I like"). Silent in-place mutation of serving copy
    // is still refused: the old row is RETIRED with a note, the new wording is
    // STAGED and then promoted, so the history shows what was replaced and
    // there is never a moment where the key serves nothing.
    if (item.category === 'active') {
      if (norm(t) === norm(item.text)) return { ok: false, reason: 'no change' };
      const staged = this.bank.addStagedVariant(key, t, `replacement for ACTIVE #${item.id}`, 'review:replace');
      if (!staged) return { ok: false, reason: 'not written (duplicate of another variant)' };
      const row = this.bank.stagedVariants(key).find(v => norm(v.text) === norm(t));
      if (!row) return { ok: false, reason: 'staged row not found after write' };
      if (!this.bank.promoteVariant(row.id)) return { ok: false, reason: 'staged, but promote failed — approve it in STAGED' };
      this.bank.retireVariant(item.id, `replaced by learn variant #${row.id} in bank:tui`);
      return { ok: true, key, staged: true };
    }

    if (item.category === 'enrichment') {
      return this.enrichment.updateReply(item.id, t)
        ? { ok: true, key }
        : { ok: false, reason: 'queue row not found' };
    }
    if (item.category === 'dynamic') {
      if (item.status === 'processed') return { ok: false, reason: 'dynamic capture is already processed (audit history only)' };
      return this.bank.updateDynamicAnswer(item.id, t)
        ? { ok: true, key }
        : { ok: false, reason: 'dynamic row not found' };
    }
    return this.bank.updateVariantText(item.id, t)
      ? { ok: true, key }
      : { ok: false, reason: 'staged variant not found (only staged rows are editable)' };
  }

  /**
   * PUSH — turn a queued turn / dynamic capture into a STAGED bank variant,
   * under the target key. It does NOT serve: approval is a separate, explicit
   * promote in the STAGED tab.
   */
  push(item: ReviewItem, key: string, text: string): ActionResult {
    if (item.category !== 'enrichment' && item.category !== 'dynamic') {
      return { ok: false, reason: 'push applies to enrichment and dynamic entries; staged entries are approved' };
    }
    if (item.category === 'dynamic' && item.status === 'processed') {
      return { ok: false, reason: 'dynamic capture is already processed (audit history only)' };
    }
    // COMPOSED rows are not client-voice copy: a property-card batch embeds
    // served EB rows and an owner-relay ping is protocol address (both
    // directions client→owner and owner→client). Pushing one would stage
    // machine-composed text as if a human had written it (#244 validated
    // CLEAN and was one keystroke away from staging the owner template).
    if (item.composed) {
      return { ok: false, reason: 'composed serve (card batch / owner-relay ping) — nothing to bank; fix lives in code/data' };
    }
    const kerr = validateBankKey(key);
    if (kerr) return { ok: false, reason: kerr };
    const errs = validateBankText(key, text, this.existingFor(key));
    if (errs.length > 0) return { ok: false, reason: errs.join('; ') };
    const t = text.trim();
    const note = `review push from ${item.category} #${item.id}`
      + (item.userMsg ? ` · review-question:${encodeURIComponent(item.userMsg)}` : '');
    const added = this.bank.addStagedVariant(
      key, t, note,
      item.category === 'enrichment' ? 'review:enrichment' : 'review:dynamic',
    );
    if (!added) return { ok: false, reason: 'not written (duplicate or data-driven key)' };
    // The queue row is done; a dynamic capture keeps serving until rejected or
    // promoted, because deleting it would remove the instant answer.
    if (item.category === 'enrichment') this.enrichment.markEnriched([item.id]);
    return { ok: true, key, staged: true };
  }

  /** Close dynamic evidence (the enqueuer rule, symmetrical): when a pair is
   *  solved through the enrichment lane, all still-live captures of the same
   *  question+answer go gray in the dynamic tab (✓ processed), and the
   *  dynamic-recall turns they logged go gray in the enrichment bar. The
   *  exact answer match preserves a capture that was edited after staging (it
   *  still serves and stays pending), same as the dynamic-lane path. */
  private closeDynamicEvidence(key: string | undefined, question: string, answer: string): void {
    const q = norm(question);
    if (!q || !answer.trim()) return;
    const rawA = answer.trim();          // capture stores its own casing
    const normA = norm(rawA);            // audit rows close case-insensitively
    let any = false;
    for (const r of this.bank.dynamicRows(2000).filter(r => r.processed === 0
      && norm(r.msg) === q && r.answer.trim() === rawA)) {
      if (this.bank.markDynamicProcessedIfMatches(r.id, r.msg, r.answer)) any = true;
    }
    // Rows whose bankKey was recorded close on the key; without one, an exact
    // question+answer match identifies the recall serve (replySource 'dynamic'
    // means the reply came FROM this pool — the served text is the capture's).
    // The sweep runs even with no capture newly closed: an already-processed
    // capture with pending audit turns still needs its gray paint-back.
    const log = this.enrichment.listLog(5000).filter(row =>
      row.replySource.startsWith('dynamic') && norm(row.userMsg ?? '') === q
      && (row.bankKey === key || (row.bankKey == null && norm(row.replyText ?? '') === normA))
    );
    this.enrichment.markEnriched(log.map(row => row.id));
  }

  /** APPROVE — promote a staged variant into the serve path. */
  approve(item: ReviewItem): ActionResult {
    if (item.category !== 'staged') {
      return { ok: false, reason: 'only staged variants are approved; push queue/dynamic entries first' };
    }
    const errs = validateBankText(item.key ?? '', item.text, this.existingExcluding(item, item.key ?? ''));
    if (errs.length > 0) return { ok: false, reason: errs.join('; ') };
    if (!this.bank.promoteVariant(item.id)) return { ok: false, reason: 'promote failed' };
    const sourceId = sourceIdFromImportNote(item.meta);
    if (sourceId && item.key) markImportDecision(this.db, sourceId, item.key, item.text, 'approved');
    const pushed = pushedQuestion(item.meta);
    if (pushed?.question && item.key) this.bank.addExample(item.key, pushed.question);
    if (pushed?.category === 'dynamic' && pushed.question) {
      // Dynamic capture wins before example recall. Keep the unchanged capture
      // as gray audit history, but mark it processed so it cannot serve or
      // count as pending. Preserve a newer answer if it changed after staging.
      this.bank.markDynamicProcessedIfMatches(pushed.id, pushed.question, item.text);
      // Same closure below — one rule for both lanes, so an approval grays the
      // audit turns identically no matter which lane staged the pair.
      this.closeDynamicEvidence(item.key ?? undefined, pushed.question, item.text);
    } else if (pushed?.question) {
      // THE GRAY RULE (solved through the enrichment lane): the capture evidence
      // is closed exactly as in the dynamic lane — the capture goes gray in the
      // dynamic tab and its dynamic-recall turns go gray in the enrichment bar.
      // Before this branch, an enrichment-solved pair left the still-serving
      // capture pending (white, counted as work) while the answer was live.
      this.closeDynamicEvidence(item.key ?? undefined, pushed.question, item.text);
    }
    // Imported retrieval examples are held with the candidate; rejecting a
    // candidate must not change master matching. They join retrieval only when
    // the operator approves the wording.
    for (const example of examplesFromImportNote(item.meta)) this.bank.addExample(item.key ?? '', example);
    return { ok: true, key: item.key ?? undefined };
  }

  /** REJECT / RETIRE — remove without serving. */
  reject(item: ReviewItem): ActionResult {
    if (item.category === 'staged') {
      const deleted = this.bank.deleteStagedVariant(item.id);
      if (deleted) {
        const sourceId = sourceIdFromImportNote(item.meta);
        if (sourceId && item.key) markImportDecision(this.db, sourceId, item.key, item.text, 'rejected');
      }
      return deleted ? { ok: true } : { ok: false, reason: 'staged variant not found' };
    }
    if (item.category === 'active') {
      return this.bank.retireVariant(item.id, 'retired in bank:tui')
        ? { ok: true }
        : { ok: false, reason: 'variant not found' };
    }
    if (item.category === 'dynamic') {
      return this.bank.deleteDynamic(item.id)
        ? { ok: true }
        : { ok: false, reason: 'dynamic row not found' };
    }
    // Enrichment: mark processed without writing to the bank. The queue has no
    // rejected status; "enriched" is exactly "no longer pending review".
    this.enrichment.markEnriched([item.id]);
    return { ok: true };
  }
}
