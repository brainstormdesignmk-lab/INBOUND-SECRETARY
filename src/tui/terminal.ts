// TERMINAL EMULATOR — the one screen model behind every rendering check.
//
// WHY THIS MODULE EXISTS: a TUI can only be verified through a terminal, and a
// terminal is not a byte stream — it is a GRID plus a cursor. Asserting on raw
// ANSI bytes ("did the frame contain '┌─ РАЗГОВОР'?") passes even when the
// frame is drawn into the wrong row, wraps the bottom row (which SCROLLS the
// physical screen and desynchronises blessed's cell-diff model forever), or
// leaves stale rows under a re-layout. So both render verifications run the
// REAL byte stream through this emulator and assert on the resulting SCREEN:
//
//   1. scripts/tui-frame-check.ts — headless: the real buildLayout()/FramePainter
//      driven with fake streams, replayed through this emulator (no scroll, no
//      orphaned rows, heal repairs garbled frames, one frame per visible second).
//   2. scripts/tui-pty-check.ts / tests/tui-pty-funnel.test.ts — the REAL TUI
//      process under a REAL pty (`script`): keystrokes in, the emulated screen
//      out. This is the layer the old headless check could not reach — actual
//      keyboard routing, actual blessed startup, actual terminal sizing.
//
// Both share THIS implementation on purpose: two emulators would drift, and a
// check that lies about what the operator sees is worse than no check.
//
// Supported: CUP/HVP, CUU/CUD/CUF/CUB, ED (0/1/2 + counter), EL (0/1/2), DECSTBM
// scroll region, DECSET alt-screen (1049), SGR (attributes are ignored — the
// grid stores characters, not styling; width is what corrupts a frame), CHA-free
// cursor math with cursor save/restore (ESC 7/8), DEC graphics (ACS) charset
// switching, OSC strings, deferred-wrap (the "write into the last column" rule),
// backspace, CR/LF with scrolling, BEL and SO/SI.
//
// STREAM SAFETY: a pty delivers bytes in arbitrary chunks, so an escape sequence
// or a multi-byte rune CAN be split across two write() calls. A parser that
// forgot this would print the tail of `\x1b(B` as literal text, fill the row and
// report a bogus scroll — the exact way this check lied before the carry buffer
// existed. Incomplete sequences are kept and completed by the next chunk, and
// the UTF-8 decode is incremental (StringDecoder) for the same reason.

/** DEC special graphics (ACS) — blessed draws box borders in this charset. */
export const ACS: Record<string, string> = {
  l: '┌', q: '─', k: '┐', x: '│', m: '└', j: '┘',
  t: '├', u: '┤', n: '┼', v: '┴', w: '┬', '~': '·', '0': '█', a: '▒', '`': '◆',
};

/** East-Asian AMBIGUOUS-width runes used in the TUI chrome. Under the
 *  ambiguous-width model a terminal draws them TWO columns wide while blessed
 *  composed them as one — the overflow that scrolls the frame out of sync.
 *  Reported as a diagnostic (TUI_WIDE_AMB=1), enforced by the no-scroll rule. */
export const AMBIGUOUS_WIDTH = new Set(['·', '▸', '»', '«', '…', '✗', '—', '–', '•', '→', '←']);

/** Bones a blessed scrollable box draws in its last interior column when the
 *  content overflows: '│' track, '█' thumb (and the shade variants some
 *  terminals substitute). Never content — always chrome. Exported so tests can
 *  state the same rule the pane reader applies. */
export const SCROLLBAR_GLYPHS = new Set(['│', '█', '▒', '░', '▓', '║']);
const TRAILING_CHROME_RE = /[│█▒░▓║]+$/;

import { StringDecoder } from 'string_decoder';

export interface TerminalOptions {
  cols: number;
  rows: number;
  /** Replay treating ambiguous-width runes as double-width (diagnostic model). */
  wideAmbiguous?: boolean;
}

export class Terminal {
  readonly cols: number;
  readonly rows: number;

  /** The screen grid; a wide glyph's second cell holds ''. */
  private grid: string[][];
  private cx = 0;
  private cy = 0;
  /** Deferred wrap: a write into the last column leaves the cursor there until
   *  the NEXT character, which wraps first (xterm semantics). */
  private pendingWrap = false;
  private regionTop = 0;
  private regionBot: number;
  private g0: 'ascii' | 'acs' = 'ascii';
  private savedCursor: { cx: number; cy: number } | null = null;
  private runLen = 0;

  private readonly wideAmbiguous: boolean;
  /** Bytes of an INCOMPLETE escape sequence / rune carried to the next write. */
  private carry = '';
  private readonly decoder = new StringDecoder('utf8');

  // ── diagnostics the checks assert on ──
  /** The physical screen scrolled — blessed's cell-diff model is desynced. */
  scrolled = false;
  /** How many times it scrolled. A boolean cannot tell a scroll that happened
   *  BEFORE the app took the screen over (a wrapper's warning lines, pm2 logs)
   *  from one that corrupts a live frame — the pty harness compares counts. */
  scrolls = 0;
  /** A cursor position OUTSIDE the screen was addressed. */
  overflowCup = false;
  /** Runs of printed characters of length ≤ 2 (informational; healed). */
  tinyRuns = 0;
  /** The longest contiguous run of printed characters. */
  maxRun = 0;
  /** How many full-screen clears (ED 2) arrived. */
  ed2Count = 0;

  constructor(opts: TerminalOptions) {
    this.cols = Math.max(1, opts.cols);
    this.rows = Math.max(1, opts.rows);
    this.wideAmbiguous = !!opts.wideAmbiguous;
    this.grid = Array.from({ length: this.rows }, () => Array<string>(this.cols).fill(' '));
    this.regionBot = this.rows - 1;
  }

  /** Feed a chunk of the terminal's output stream (any chunk boundary). */
  write(chunk: string | Buffer): void {
    // StringDecoder keeps a partial multi-byte rune; the carry keeps a partial
    // escape sequence. Both are normal on a pty and must never reach the grid.
    const stream = this.carry + (typeof chunk === 'string' ? chunk : this.decoder.write(chunk));
    this.carry = '';
    let i = 0;
    while (i < stream.length) {
      const ch = stream[i];
      if (ch === '\x1b') {
        this.closeRun();
        const next = this.escape(stream, i);
        if (next < 0) { this.carry = stream.slice(i); break; }   // incomplete — finish it next chunk
        i = next;
        continue;
      }
      if (ch === '\r') { this.cx = 0; this.pendingWrap = false; i++; continue; }
      if (ch === '\n') {
        this.pendingWrap = false;
        this.lineFeed();
        i++; continue;
      }
      if (ch === '\x08') { this.cx = Math.max(0, this.cx - 1); i++; continue; }
      if (ch === '\x07' || ch === '\x0e' || ch === '\x0f') { i++; continue; }
      this.put(ch);
      i++;
    }
  }

  /** One row of the emulated screen (wide glyph cells render as ''). */
  row(index: number): string {
    return (this.grid[index] ?? []).join('');
  }

  /** Every row, top to bottom. */
  rowsText(): string[] {
    return Array.from({ length: this.rows }, (_, r) => this.row(r));
  }

  /** The whole screen as text, newline-separated. */
  text(): string {
    return this.rowsText().join('\n');
  }

  /**
   * The INSIDE of a labelled pane box (the text a reader sees), found by its
   * border label the way a human finds it: the row carrying `┌─ <label>`, then
   * every content row down to the box's closing corner, taking the cells between
   * the vertical borders. Returns undefined when the label is not on screen
   * (either the pane is too short to draw a labelled border, or the frame is
   * damaged). Whitespace inside a line is preserved; lines are newline-joined.
   */
  paneText(label: string): string | undefined {
    const rows = this.rowsText();
    const top = rows.findIndex(r => r.includes(`┌─ ${label}`));
    if (top < 0) return undefined;
    // The pane's COLUMNS come from its OWN label position, not from the first
    // corner on the row: the TUI puts a client list in column 0 and the chat to
    // its right, so `indexOf('┌')` would take the neighbour's box and every
    // content row would come back with both panes' borders inside it.
    const labelRow = rows[top];
    const left = labelRow.indexOf(`┌─ ${label}`);
    const right = labelRow.indexOf('┐', left);
    if (left < 0 || right <= left) return undefined;
    const content: string[] = [];
    for (let r = top + 1; r < this.rows; r++) {
      const line = rows[r];
      // The pane's bottom border ends its content (blessed puts no corner in a
      // content row; a line starting with a corner is the next pane's top).
      const first = line.slice(left, left + 1);
      if (first !== '│') break;
      content.push(line.slice(left + 1, right));
    }
    // A SCROLLABLE box draws scrollbar bones in its last interior column once
    // the content overflows — chrome, not text. A box-border glyph can never end
    // a line of prose, so any trailing run of them is dropped: without this, a
    // reply whose last row carries the thumb reads as "…Ваша.│" and every
    // "does it end with a question mark" assertion fails on real screens.
    const lines = content.map(l => l.replace(TRAILING_CHROME_RE, '').replace(/\s+$/, ''));
    return lines.join('\n');
  }

  /**
   * Pane text with ALL whitespace removed — the needle form for wrapped copy:
   * blessed word-wraps a long reply across pane rows, so a phrase test must
   * ignore the wrap points. `paneText(label)` + collapseWhitespace on both sides
   * of the comparison is the honest way to assert "the client SAW this".
   */
  paneCollapsed(label: string): string | undefined {
    const t = this.paneText(label);
    return t === undefined ? undefined : t.replace(/\s+/g, '');
  }

  // ── internals ──────────────────────────────────────────────────────────────

  private closeRun(): void {
    if (this.runLen === 0) return;
    if (this.runLen <= 2) this.tinyRuns++;
    if (this.runLen > this.maxRun) this.maxRun = this.runLen;
    this.runLen = 0;
  }

  /** LF semantics: advance one row, or scroll when already at the bottom margin
   *  — the SCREEN bottom by default, the DECSTBM region bottom when one is set
   *  (a region that ignored its own margin would let a frame scroll unnoticed). */
  private lineFeed(): void {
    if (this.cy >= this.regionBot) { this.scrollUp(); return; }
    this.cy++;
    if (this.cy >= this.rows) this.cy = this.rows - 1;
  }

  private scrollUp(): void {
    for (let r = this.regionTop; r < this.regionBot; r++) this.grid[r] = this.grid[r + 1];
    this.grid[this.regionBot] = Array<string>(this.cols).fill(' ');
    this.scrolled = true;
    this.scrolls++;
  }

  private put(ch: string): void {
    this.runLen++;
    if (this.pendingWrap) {
      this.cx = 0;
      this.lineFeed();
    }
    const width = this.wideAmbiguous && AMBIGUOUS_WIDTH.has(ch) ? 2 : 1;
    this.grid[this.cy][this.cx] = this.g0 === 'acs' ? (ACS[ch] ?? ch) : ch;
    if (width === 2 && this.cx + 1 < this.cols) this.grid[this.cy][this.cx + 1] = '';
    if (this.cx + width >= this.cols) this.pendingWrap = true; else this.cx += width;
  }

  private clearRow(r: number, from: number, to: number): void {
    for (let c = from; c < to && c < this.cols; c++) this.grid[r][c] = ' ';
  }

  /**
   * Parse one escape sequence starting at `i`.
   * Returns the index just past it, or -1 when the sequence is INCOMPLETE (the
   * caller carries those bytes over to the next write).
   */
  private escape(stream: string, i: number): number {
    const next = stream[i + 1];
    if (next === undefined) return -1;                       // bare ESC at a chunk end
    if (next === '[') {
      let j = i + 2;
      // Final byte range is 0x40..0x7E; everything below is parameter/intermediate.
      while (j < stream.length && stream[j].charCodeAt(0) < 0x40) j++;
      if (j >= stream.length) return -1;
      const final = stream[j];
      const params = stream.slice(i + 2, j);
      const priv = params.startsWith('?');
      const nums = params.replace(/^\?/, '').split(';').map(p => parseInt(p || '1', 10));
      this.csi(final, params, nums, priv);
      return j + 1;
    }
    if (next === ']') {
      // OSC string — skip to BEL or ST.
      let j = i + 2;
      while (j < stream.length && stream[j] !== '\x07' && !(stream[j] === '\x1b' && stream[j + 1] === '\\')) j++;
      if (j >= stream.length) return -1;
      return stream[j] === '\x07' ? j + 1 : j + 2;
    }
    if (next === '(' || next === ')' || next === '*' || next === '+' || next === '-' || next === '#') {
      if (stream[i + 2] === undefined) return -1;
      if (next === '(') this.g0 = stream[i + 2] === '0' ? 'acs' : 'ascii';
      return i + 3;
    }
    if (next === '7') { this.savedCursor = { cx: this.cx, cy: this.cy }; return i + 2; }
    if (next === '8') {
      if (this.savedCursor) {
        this.cx = this.savedCursor.cx;
        this.cy = this.savedCursor.cy;
        this.pendingWrap = false;
      }
      return i + 2;
    }
    return i + 2;   // ESC = > M D E c and the rest: single-character sequences
  }

  private csi(final: string, params: string, nums: number[], priv: boolean): boolean {
    if (!priv && (final === 'H' || final === 'f')) {
      const row = nums[0] || 1;
      const col = nums[1] || 1;
      if (row > this.rows || col > this.cols) this.overflowCup = true;
      this.cy = Math.min(Math.max(row - 1, 0), this.rows - 1);
      this.cx = Math.min(Math.max(col - 1, 0), this.cols - 1);
      this.pendingWrap = false;
      return true;
    }
    if (!priv && final === 'J') {
      const mode = nums[0] ?? 0;
      if (mode === 0) {
        this.clearRow(this.cy, this.cx, this.cols);
        for (let r = this.cy + 1; r < this.rows; r++) this.clearRow(r, 0, this.cols);
      } else if (mode === 1) {
        for (let r = 0; r < this.cy; r++) this.clearRow(r, 0, this.cols);
        this.clearRow(this.cy, 0, this.cx + 1);
      } else {
        this.ed2Count++;
        for (let r = 0; r < this.rows; r++) this.clearRow(r, 0, this.cols);
      }
      return true;
    }
    if (!priv && final === 'K') {
      const mode = nums[0] ?? 0;
      if (mode === 0) this.clearRow(this.cy, this.cx, this.cols);
      else if (mode === 1) this.clearRow(this.cy, 0, this.cx + 1);
      else this.clearRow(this.cy, 0, this.cols);
      return true;
    }
    if (!priv && 'ABCD'.includes(final)) {
      const n = nums[0] || 1;
      if (final === 'A') this.cy = Math.max(0, this.cy - n);
      else if (final === 'B') this.cy = Math.min(this.rows - 1, this.cy + n);
      else if (final === 'C') this.cx = Math.min(this.cols - 1, this.cx + n);
      else this.cx = Math.max(0, this.cx - n);
      this.pendingWrap = false;
      return true;
    }
    if (!priv && final === 'r') {
      this.regionTop = Math.max(0, (nums[0] || 1) - 1);
      this.regionBot = Math.min(this.rows - 1, (nums[1] || this.rows) - 1);
      return true;
    }
    if (final === 'h' && params.includes('1049')) {
      // Alt-screen entry: a fresh screen (blessed starts in it).
      for (let r = 0; r < this.rows; r++) this.grid[r] = Array<string>(this.cols).fill(' ');
      this.cx = 0;
      this.cy = 0;
      this.pendingWrap = false;
      return true;
    }
    return true; // SGR, DECSET/DECRST modes, and everything else: no screen effect
  }
}

/** Convenience: replay a whole byte stream into a fresh screen. */
export function replayScreen(stream: string, opts: TerminalOptions): Terminal {
  const t = new Terminal(opts);
  t.write(stream);
  return t;
}
