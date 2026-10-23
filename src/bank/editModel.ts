/**
 * THE EDITOR'S TEXT MODEL — visual lines and caret arithmetic.
 *
 * `bank:tui` used blessed's `textarea`, whose own source carries
 * `// TODO: Handle directional keys`: arrows were swallowed and the caret could
 * only ever sit at the end of the answer, so the operator had to retype a whole
 * reply to fix one word. The screen now owns the buffer (`editBuf`/`editPos`);
 * this module is the part that must be provably right — where a visual line
 * starts and ends in the SOURCE string (so offsets stay exact through wrapping,
 * skipped spaces and explicit newlines), and where ↑/↓ land.
 *
 * Everything here is pure: no blessed, no terminal, no DB.
 */

export interface VisualLine {
  /** Index in the source text of the first character shown on this line. */
  start: number;
  /** Index just past the last character shown (exclusive). */
  end: number;
}

/**
 * Word-wrap `text` to `width` columns, keeping source offsets.
 * A wrapped space and a literal '\n' are not part of any line's text.
 */
export function editLayout(text: string, width: number): VisualLine[] {
  const w = Math.max(8, Math.floor(width));
  const out: VisualLine[] = [];
  let p0 = 0;
  for (let i = 0; i <= text.length; i++) {
    if (i !== text.length && text[i] !== '\n') continue;
    const pEnd = i;
    // An empty paragraph (blank line) still occupies one visual row.
    if (p0 === pEnd) out.push({ start: p0, end: pEnd });
    let start = p0;
    while (start < pEnd) {
      let end = Math.min(pEnd, start + w);
      if (end < pEnd) {
        const sp = text.lastIndexOf(' ', end);
        if (sp > start) end = sp;
      }
      out.push({ start, end });
      start = end;
      if (text[start] === ' ' && start < pEnd) start++;
    }
    p0 = i + 1;
  }
  return out.length ? out : [{ start: 0, end: 0 }];
}

/** Visual line holding `pos`. A position exactly on a boundary belongs to the
 *  later line, so typing at the end of line N shows on line N+1 only when that
 *  line exists (i.e. the wrap point, not the caret between words). */
export function caretLine(lines: VisualLine[], pos: number): number {
  let at = 0;
  for (let i = 0; i < lines.length; i++) {
    if (pos >= lines[i].start && pos <= lines[i].end) at = i;
  }
  return at;
}

/** ↑/↓: keep the column, clamp to the target line's length. */
export function moveVertical(lines: VisualLine[], pos: number, delta: number): number {
  const cur = caretLine(lines, pos);
  const target = cur + delta;
  if (target < 0 || target >= lines.length) return pos;
  const col = pos - lines[cur].start;
  return Math.min(lines[target].start + col, lines[target].end);
}

/** The line as blessed markup with an inverse caret block at `pos`. */
export function paintCaret(line: VisualLine, text: string, pos: number): string {
  const t = text.slice(line.start, line.end);
  const rel = Math.max(0, Math.min(t.length, pos - line.start));
  const safe = (s: string): string => s.replace(/[{}]/g, '');
  return safe(t.slice(0, rel))
    + '{inverse}' + (rel < t.length ? safe(t[rel]) : ' ') + '{/inverse}'
    + safe(t.slice(rel + 1));
}
