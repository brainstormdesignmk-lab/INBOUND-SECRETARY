// CaptureStore — the learning layer's DATA FLOOR (the TUI_LEARN piece).
//
// The pipeline was deterministic-first but its misses were INVISIBLE: exam
// mode logged nothing (the 09:xx "exam" policy) and the enrichment queue only
// logged teacher-mode replies — so every message that fell through to the
// Gemini classifier (and every Gemini prose serve) evaporated at the end of
// the TUI session. The whole "mine the frontier → detector owns it → the
// classifier stops firing on it" loop had no input file.
//
// What this store does: append-only jsonl of the two capture kinds, the ONLY
// two shapes that mean "a human should look at this message again":
//   kind 'fallthrough' — deterministicClassify() returned undefined, so the
//     Gemini classifier had to decide the intent. Detector candidate: mined
//     into data/hardening/*.json, the phrasing stops being novel forever.
//   kind 'prose' — the reply was Gemini-generated prose (replySource 'llm'),
//     not a bank variant. Wording candidate: promoted (after review) through
//     the bank importer into the master bank, deduped by normalized identity.
//
// It is a SINK, not a gate: capture failures never break the funnel. It is
// FILE-BACKED (jsonl, survives restarts, reviewable in the working tree,
// collectable by scripts/collect-atoms.sh). It holds NO opinions — the handler
// decides what to send; this store counts, dedupes per day, and flushes on
// demand.
//
// Two modes, one class: the TUI buffers and flushes on a timer (piece 1,
// TUI_LEARN); the ATOM (index.ts, piece 3) runs the same sink fallthrough-only
// with auto-flush — real-client frontier phrasings land in data/capture/ and
// are collected daily for the same mining loop. Prose is NOT captured on the
// atom: enrichment_queue already owns the wording channel there.

import * as fs from 'fs';
import * as path from 'path';

/** The kind of capture — WHY this turn needs a human look. */
export type CaptureKind = 'fallthrough' | 'prose';

export interface CaptureRecord {
  /** 'fallthrough' | 'prose' — see the header. */
  kind: CaptureKind;
  /** The client's message, verbatim. */
  text: string;
  /** FSM state BEFORE the turn. */
  state: string;
  /** ISO timestamp — write time, used for the daily dedupe key. */
  at: string;
  /** chatId — the TUI's client-1/client-2 …, or the Viber chat id. */
  chatId: string;
  /** Where the reply eventually came from ('bank' | 'deterministic' |
   *  'fallback' | 'llm'), for triage: a fallthrough answered by a bank lane
   *  is a pure wording gap; one answered by 'llm' prose is both. */
  replySource?: string;
  /** Which bank key served, when one did. */
  bankKey?: string;
  /** Set when the record is kind 'fallthrough' but the reply was ALSO
   *  Gemini-generated prose (decideCapture returned 'both') — one message,
   *  both review interests, one line. */
  alsoProse?: boolean;
}

/** Decides what (if anything) to capture for a completed turn. PURE — all
 *  policy lives here so tests pin the rules without any I/O.
 *  - 'fallthrough': the deterministic pre-classify gave up on this message
 *    (undefined → the Gemini classifier fired). Presentation-card batches are
 *    NOT captures: they are code-built data displays of an already-understood
 *    search, not a classification gap.
 *  - 'prose': the final reply was LLM-generated prose.
 *  - Both conditions hold → 'both' (one line, both flags — one message, one
 *    review item). Neither → null. */
export function decideCapture(kind: {
  deterministicClassifyGaveUp: boolean;
  replySource: string;
  isPresentationBatch: boolean;
}): CaptureKind | 'both' | null {
  const prose = kind.replySource === 'llm';
  // A presentation batch IS deterministic work on an understood search — the
  // slots were extracted fine; the cards are not prose and not a gap.
  const fallthrough = kind.deterministicClassifyGaveUp && !kind.isPresentationBatch;
  if (fallthrough && prose) return 'both';
  if (fallthrough) return 'fallthrough';
  if (prose) return 'prose';
  return null;
}

/** Stable identity of a wording — case/punctuation/spacing-collapsed with the
 *  x→кс fold. "До 160 000" and "до 160000" are the SAME capture; so are
 *  case variants and the Latin-x spelling twins. Numbers survive intact, so
 *  "DO 160000" ≠ "DO 150000". Import and capture dedupe share this. */
export function normalizedKey(text: string): string {
  // Whitespace is REMOVED (not collapsed to a space): digit-grouping style
  // ("160 000" vs "160000") must not split one phrase into two captures.
  // Word fusing this causes is acceptable — identity is per-phrase, and the
  // near-dup layer at import catches residual twins.
  return text
    .toLowerCase()
    .replace(/x/g, 'кс')
    .replace(/k[sс]/g, 'кс')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

export interface CaptureCounts { total: number; fallthrough: number; prose: number }

/** Sink options.
 *  - kinds: which capture kinds this sink accepts. The ATOM accepts only
 *    'fallthrough' (its prose replies already land in enrichment_queue —
 *    capturing them again would duplicate the wording channel). Default: both.
 *  - autoFlush: write every accepted record to the file immediately —
 *    production/atom mode, because the process is restart-deployed at any
 *    time and buffered records would die with it. Default false (TUI mode:
 *    buffer, flush on a timer). */
export interface CaptureStoreOpts { kinds?: CaptureKind[]; autoFlush?: boolean }

export class CaptureStore {
  private pending: CaptureRecord[] = [];
  private recentKeys = new Map<string, number>(); // normalized → epoch day

  constructor(private filePath: string, private opts: CaptureStoreOpts = {}) {
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
    } catch { /* read-only FS — appendFileSync will fail per write and be swallowed */ }
    // Rebuild the dedupe index from whatever the file already holds so a
    // restart doesn't re-capture yesterday's messages (same-day repeats only —
    // an old phrase asked again NEXT week is still worth seeing).
    try {
      if (fs.existsSync(filePath)) {
        const lines = fs.readFileSync(filePath, 'utf8').split('\n').filter(Boolean);
        for (const line of lines) {
          try {
            const rec = JSON.parse(line) as CaptureRecord;
            this.recentKeys.set(normalizedKey(rec.text), dayOf(rec.at));
          } catch { /* torn line — skip */ }
        }
      }
    } catch { /* unreadable file — start empty */ }
  }

  /** Handler seam — called once per completed turn with the record (or null). */
  onTurn(rec: CaptureRecord | null): void {
    if (!rec) return;
    if (this.opts.kinds && !this.opts.kinds.includes(rec.kind)) return;
    const key = normalizedKey(rec.text);
    const day = dayOf(rec.at);
    if (this.recentKeys.get(key) === day) return; // same wording, same day — already captured
    this.recentKeys.set(key, day);
    this.pending.push(rec);
    if (this.opts.autoFlush) this.flush(); // atom mode: survive restart-deploys
  }

  get pendingCount(): number { return this.pending.length; }

  counts(): CaptureCounts {
    const c: CaptureCounts = { total: 0, fallthrough: 0, prose: 0 };
    for (const rec of this.pending) {
      c.total++;
      if (rec.kind === 'fallthrough') c.fallthrough++;
      else if (rec.kind === 'prose') c.prose++;
      else { c.fallthrough++; c.prose++; } // 'both' counts in both columns
    }
    return c;
  }

  /** File-level counts (everything captured to date, flushed or not).
   *  The review/mining reminder reads this — unmined = the whole file,
   *  because mining (hardening rows / bank import) is what empties it. */
  fileCounts(): CaptureCounts {
    const c: CaptureCounts = { total: 0, fallthrough: 0, prose: 0 };
    for (const rec of this.readAll()) {
      c.total++;
      if (rec.kind === 'fallthrough') c.fallthrough++;
      else if (rec.kind === 'prose') c.prose++;
      else { c.fallthrough++; c.prose++; }
    }
    return c;
  }

  /** Append everything buffered to the jsonl. Returns the number of lines written. */
  flush(): number {
    if (this.pending.length === 0) return 0;
    const lines = this.pending.map(r => JSON.stringify(r)).join('\n') + '\n';
    try {
      fs.appendFileSync(this.filePath, lines);
      const n = this.pending.length;
      this.pending = [];
      return n;
    } catch {
      return 0; // read-only FS — records stay buffered; counts still reported
    }
  }

  /** Read the whole file (review tooling). Torn lines are skipped. */
  readAll(): CaptureRecord[] {
    try {
      return fs.readFileSync(this.filePath, 'utf8').split('\n').filter(Boolean)
        .map(l => { try { return JSON.parse(l) as CaptureRecord; } catch { return null; } })
        .filter((r): r is CaptureRecord => !!r);
    } catch { return []; }
  }
}

function dayOf(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? Math.floor(t / 86_400_000) : 0;
}
