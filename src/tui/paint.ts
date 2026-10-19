// THE REPAINT CONTRACT — one implementation, shared by the live TUI
// (src/tui/app.ts) and the headless frame check (scripts/tui-frame-check.ts).
//
// WHY THIS EXISTS (the [00:32] "TUI is acting strangely" capture): during the
// seconds between a client's message and Lina's reply — the antiban send delay
// plus the client-typing window — the ticker repainted every 100 ms because a
// countdown was running, and the screen ended up with duplicated headers,
// half-written panes and rows of a previous frame that never went away, until
// some later redraw made it "go back to normal".
//
// blessed renders by walking its composed lines and, for each row, comparing
// cells against a cached copy (`olines`). Two details of that renderer are what
// turn a repaint into garbage behind a lossy terminal broker:
//
//   • a row is SKIPPED entirely when its `lines[y].dirty` flag is false
//     (screen.js draw(): `if (!line.dirty && …) continue;`) — poisoning the
//     cache alone does NOT make blessed emit a row;
//   • a row that IS drawn is a cell diff: a cursor jump plus only the changed
//     characters. A scrolled/re-wrapped pane therefore arrives as a scatter of
//     one- and two-character writes, and a row blessed believes is blank is
//     left alone forever — a ghost that no later diff can repair.
//
// The contract here is deliberately blunt, because blunt is what a broker can
// execute:
//
//   1. NOTHING CHANGED → NOTHING IS WRITTEN. `paint()` compares a signature of
//      everything visible (all box contents, labels, scroll positions, the
//      menu, the terminal size) and skips the render entirely when it is
//      unchanged. Idle screens emit ZERO bytes; a waiting screen emits at most
//      one frame per visible change instead of ten per second.
//   2. EVERY WRITE RE-EMITS WHOLE ROWS. `markRowsWhole()` sets the dirty flag
//      and poisons the cached copy, so blessed sends the row in one piece with
//      one cursor jump.
//   3. A CHANGED SURFACE IS REWRITTEN WHOLE. Each pane, plus the clock line,
//      the input box and the status line, is tracked separately: when its
//      content, label or scroll position changed, EVERY row it owns is marked.
//      A shifted line is therefore a surface rewrite, never a fragment diff
//      that leaves the previous line's tail behind, and a countdown costs one
//      row instead of a screen.
//   4. THE HEAL REPAIRS EVERYTHING. Mark + poison the WHOLE screen and render
//      once: any frame a broker mangled is replaced by a correct one —
//      including the rows blessed would otherwise skip forever. Used ~1.5 s
//      after the content settles and on a 3 s cadence while a wait is open, so
//      damage cannot outlive a few seconds.
//   5. NO RUNE THE TERMINAL DRAWS WIDER THAN BLESSED MEASURES IT. One emoji in
//      a row makes that row one column wider than composed, the terminal wraps
//      it, and a wrap on the bottom row SCROLLS the frame out of sync. That is
//      the other half of the [00:32] failure — the waiting status line carried
//      '⏳' on the last row for the whole wait. `narrowGlyphs()` (layout.ts,
//      applied by `guardGlyphs()` to every box) enforces it for chrome AND for
//      text that arrives from clients and from Lina.

export interface FrameBoxes {
  screen: any;
  topBar: any;
  leadsBox: any;
  chatBox: any;
  ownerBox: any;
  inputBox: any;
  statusBar: any;
}

/** Terminal height, with a safe default for the pre-render state. */
export function screenRows(screen: any): number {
  return Number(screen?.rows) || Number(screen?.height) || 24;
}

/** Absolute rows [from, to) a box occupies, from its last painted position
 *  (`lpos`, set by blessed's render) with the layout constants as fallback. */
export function boxRows(box: any, fallback: [number, number], rows: number): number[] {
  const pos = box?.lpos;
  let from = pos ? pos.yi : fallback[0];
  let to = pos ? pos.yl : fallback[1];
  if (!Number.isFinite(from) || !Number.isFinite(to)) return [];
  from = Math.max(0, from);
  to = Math.min(rows, Math.max(to, from));
  const out: number[] = [];
  for (let y = from; y < to; y++) out.push(y);
  return out;
}

/**
 * Make blessed re-emit these rows WHOLE on the next render().
 *
 * Both halves are required: `lines[y].dirty` is the flag draw() gates on, and
 * the cached `olines[y]` is what the row is diffed against — rewriting it with
 * a character no composed line can contain makes every cell of the row count
 * as changed, so the row is written as one cursor jump plus the full line
 * (or a single erase-line for a blank row) instead of a handful of fragments.
 */
export function markRowsWhole(screen: any, rows: number[]): void {
  const lines = screen?.lines;
  const olines = screen?.olines;
  if (!Array.isArray(lines)) return;
  for (const y of rows) {
    const line = lines[y];
    if (!line) continue;
    line.dirty = true;
    const old = Array.isArray(olines) ? olines[y] : null;
    if (!old) continue;
    for (let x = 0; x < line.length; x++) {
      const cell = line[x];
      if (!cell || !old[x]) continue;
      old[x][0] = cell[0];   // same attributes → no SGR churn on the rewrite
      old[x][1] = '\u0000';  // …but a character the line cannot contain
    }
  }
}

/** Everything a frame's look depends on. Two identical signatures mean the
 *  terminal already shows the right picture — no write is needed. */
export function frameSignature(boxes: FrameBoxes, extra = ''): string {
  const screen: any = boxes.screen;
  const part = (b: any): string => String(b?.getContent?.() ?? '');
  const label = (b: any): string => String(b?.getLabel?.() ?? '');
  const scroll = (b: any): string => {
    try { return String(Math.round(Number(b?.getScrollPerc?.() ?? 0))); } catch { return '?'; }
  };
  return [
    `${Number(screen?.width) || 0}x${screenRows(screen)}`,
    part(boxes.topBar),
    part(boxes.leadsBox), scroll(boxes.leadsBox),
    part(boxes.chatBox), scroll(boxes.chatBox),
    part(boxes.ownerBox), scroll(boxes.ownerBox),
    label(boxes.inputBox), part(boxes.inputBox),
    part(boxes.statusBar),
    extra,
  ].join('\u0000');
}

/** A surface whose content (or label, or scroll position) changed must be
 *  rewritten whole. The fallbacks mirror src/tui/layout.ts and only matter for
 *  the very first frame, before blessed has set `lpos`. */
export interface SurfaceSpec {
  key: string;
  box: any;
  fallback: [number, number];
}

export function surfaceRows(boxes: FrameBoxes): SurfaceSpec[] {
  const rows = screenRows(boxes.screen);
  return [
    { key: 'top', box: boxes.topBar, fallback: [0, 1] },
    { key: 'leads', box: boxes.leadsBox, fallback: [1, Math.max(1, rows - 1)] },
    { key: 'chat', box: boxes.chatBox, fallback: [1, Math.max(1, rows - 12)] },
    { key: 'owner', box: boxes.ownerBox, fallback: [Math.max(1, rows - 12), Math.max(1, rows - 4)] },
    { key: 'input', box: boxes.inputBox, fallback: [Math.max(0, rows - 4), Math.max(1, rows - 1)] },
    { key: 'status', box: boxes.statusBar, fallback: [Math.max(0, rows - 1), rows] },
  ];
}

/**
 * The only writer to the terminal. Owns the change gate, the whole-row
 * re-emission, the whole-pane rewrites and the full-frame heal, so no caller
 * can drift from the contract (the app and the frame check used to mirror this
 * by hand).
 */
export class FramePainter {
  private lastSig: string | null = null;
  private paneKeys = new Map<string, string>();
  /** Frames actually written — the wait-window assertions read this. */
  frames = 0;
  /** Frames skipped because nothing visible changed. */
  skipped = 0;

  constructor(private boxes: FrameBoxes, private extra: () => string = () => '') {}

  signature(): string {
    return frameSignature(this.boxes, this.extra());
  }

  private paneKey(box: any): string {
    const scroll = (() => {
      try { return String(Math.round(Number(box?.getScrollPerc?.() ?? 0))); } catch { return '?'; }
    })();
    return `${String(box?.getContent?.() ?? '')}\u0000${String(box?.getLabel?.() ?? '')}\u0000${scroll}`;
  }

  /** Render if — and only if — something visible changed. Returns whether a
   *  frame was written. `force` bypasses the gate (resize, menu open/close). */
  paint(opts: { force?: boolean } = {}): boolean {
    const sig = this.signature();
    if (!opts.force && sig === this.lastSig) {
      this.skipped++;
      return false;
    }
    this.lastSig = sig;
    const screen: any = this.boxes.screen;
    const rows = screenRows(screen);

    // Only the surfaces that actually changed are re-emitted — and each one is
    // rewritten from its first row to its last, so a scrolled or re-wrapped
    // pane can never leave the previous frame's lines as tails underneath.
    for (const s of surfaceRows(this.boxes)) {
      const key = this.paneKey(s.box);
      if (!opts.force && this.paneKeys.get(s.key) === key) continue;
      this.paneKeys.set(s.key, key);
      markRowsWhole(screen, boxRows(s.box, s.fallback, rows));
    }

    this.boxes.screen.render();
    this.frames++;
    return true;
  }

  /**
   * SELF-HEAL: mark the WHOLE screen dirty + poisoned and re-emit it once. A
   * row blessed skips is a row a broker can leave garbled forever, so the heal
   * must not rely on the diff engine at all — every row is written.
   */
  heal(): void {
    const screen: any = this.boxes.screen;
    const rows = screenRows(screen);
    const all: number[] = [];
    for (let y = 0; y < rows; y++) all.push(y);
    markRowsWhole(screen, all);
    this.lastSig = this.signature();
    screen.render();
    this.frames++;
  }
}
