import blessed from 'blessed';

// blessed ships poor typings (@types/blessed disagrees with its runtime).
// We use `any` for the widget boxes — the runtime API is what matters here.

// Pane split. The CHAT pane must be wide enough to hold a client-facing map
// link on ONE line: the URL is a single unbreakable token and the console
// wraps it mid-string otherwise (the [22:46] capture — a 48-char
// `https://maps.google.com/?cid=…` wrapped after its 47th character, the last
// digit landed on the next visual line, and the clicked link reached Google
// as an 18-digit cid → a blank zoomed-out map with no marker).
// Usable text columns ≈ floor(cols × fraction) − 3 (2 borders + 1 scrollbar).
// Measured through the REAL renderer (tests/tui-wrap.test.ts), on link lengths
// taken from the live POI table the atom serves:
//   • 48-char link (19-digit cid, 835 POIs) → whole from 68 columns up;
//   • 49-char link (20-digit cid, 792 POIs — the WORST case) → needs 69
//     columns; at 68 columns it still breaks. Never claim 68 as the minimum.
export const LEADS_PANE_FRACTION = 0.25;
export const CHAT_PANE_FRACTION = 0.75;

/** Text columns usable inside a bordered, scrollbarred box of that width. */
export function paneTextWidth(screenCols: number, fraction: number): number {
  return Math.max(8, Math.floor(screenCols * fraction) - 3);
}

/** Visible width of a blessed-marked string: tags render to nothing and the
 *  `{open}`/`{close}` escapes render as one brace each. Counting raw
 *  characters would over-measure every tagged line by the tag text. */
export function visibleWidth(s: string): number {
  let w = 0;
  for (let i = 0; i < s.length; ) {
    if (s.startsWith('{open}', i)) { w += 1; i += 6; continue; }
    if (s.startsWith('{close}', i)) { w += 1; i += 7; continue; }
    if (s[i] === '{') {
      const close = s.indexOf('}', i);
      if (close !== -1) { i = close + 1; continue; } // a tag renders to nothing
    }
    const cp = s.codePointAt(i)!;
    w += 1;
    i += cp > 0xffff ? 2 : 1;
  }
  return w;
}

/**
 * Wrap marked text to `width` VISIBLE columns, never splitting a whitespace
 * token. A URL is one token: if it does not fit on the current line it moves
 * — whole — to the next one, so a link is never cut across two rendered
 * lines. A token longer than the pane still gets its own line (nothing can
 * make it fit; blessed then hard-splits it, and the pane widening is what
 * keeps that case away from real map links).
 *
 * Pre-wrapping is what makes blessed's own `wrap: true` a no-op for links:
 * blessed wraps at any character, including inside a URL.
 */
export function wrapMarked(text: string, width: number): string {
  if (!Number.isFinite(width) || width < 8) return text;
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    // Tokens keep their trailing whitespace so nothing in the message is lost.
    const tokens = raw.match(/\S+\s*|\s+/g) ?? [];
    let line = '';
    let lineW = 0;
    for (const tok of tokens) {
      if (line !== '' && lineW + visibleWidth(tok) > width) {
        out.push(line.replace(/\s+$/, ''));
        line = '';
        lineW = 0;
      }
      line += tok;
      lineW += visibleWidth(tok);
      // A single token wider than the pane: flush it alone so the NEXT token
      // starts on a fresh line instead of being glued to it.
      if (visibleWidth(tok) > width) {
        out.push(line.replace(/\s+$/, ''));
        line = '';
        lineW = 0;
      }
    }
    // Emit the residual line only when something is on it. After an over-wide
    // final token the loop above already flushed it and reset `line`, so this
    // push used to append a spurious blank line to every message whose last
    // token was a link too wide for the pane (the narrow-terminal case).
    if (line !== '' || tokens.length === 0) out.push(line.replace(/\s+$/, ''));
  }
  return out.join('\n');
}

export interface TuiBoxes {
  screen: any;
  topBar: any;
  leadsBox: any;
  chatBox: any;
  ownerBox: any;
  inputBox: any;
  statusBar: any;
}

export function buildLayout(
  title: string,
  streams?: { input?: any; output?: any },
): TuiBoxes {
  const screen: any = blessed.screen({
    // Headless drivers (scripts/tui-frame-check.ts) pass fake streams; the
    // real TUI leaves them undefined and blessed binds process.stdin/stdout.
    ...(streams?.input ? { input: streams.input } : {}),
    ...(streams?.output ? { output: streams.output } : {}),
    // smartCSR (cursor save/restore around each render) is fragile in web-based
    // terminal brokers — it silently drops incremental repaints there. Explicit
    // cursor positioning keeps every keystroke visible in such terminals.
    smartCSR: false,
    fullUnicode: true, // Cyrillic must render correctly
    autoPadding: true,
    title,
  } as any);

  const topBar: any = blessed.box({
    parent: screen, top: 0, left: 0, height: 1, width: '100%',
    tags: true,
    style: { bg: 'blue', fg: 'white' },
  } as any);

  // LEFT THIRD — the clients that contacted the agency (parallel leads)
  const leadsBox: any = blessed.box({
    parent: screen, top: 1, left: 0, width: `${LEADS_PANE_FRACTION * 100}%`, bottom: 1,
    tags: true,
    scrollable: true, alwaysScroll: true,
    scrollbar: { ch: '│', style: { fg: 'cyan' } },
    border: { type: 'line', fg: 'cyan' },
    label: ' КЛИЕНТИ ',
    style: { fg: 'white', border: { fg: 'cyan' } },
  } as any);

  // RIGHT TWO-THIRDS — the active chat (client ↔ Lina)
  const chatBox: any = blessed.box({
    parent: screen, top: 1, left: `${LEADS_PANE_FRACTION * 100}%`, right: 0, bottom: 12,
    tags: true,
    wrap: true,
    scrollable: true, alwaysScroll: true,
    scrollbar: { ch: '│', style: { fg: 'magenta' } },
    border: { type: 'line', fg: 'magenta' },
    label: ' РАЗГОВОР ',
    style: { fg: 'white', border: { fg: 'magenta' } },
  } as any);

  // OWNER PANEL — Lina's questions to the owner + the owner's answers (the
  // ping-pong that arranges the visit time). [F3] switches the input to the
  // owner's side; the answer is parsed into a verdict and relayed to the client.
  const ownerBox: any = blessed.box({
    parent: screen, left: `${LEADS_PANE_FRACTION * 100}%`, right: 0, bottom: 4, height: 8,
    tags: true,
    wrap: true,
    scrollable: true, alwaysScroll: true,
    scrollbar: { ch: '│', style: { fg: 'yellow' } },
    border: { type: 'line', fg: 'yellow' },
    label: ' СОПСТВЕНИК — [F3] пишувај како сопственик ',
    style: { fg: 'white', border: { fg: 'yellow' } },
  } as any);

  // Input line
  const inputBox: any = blessed.box({
    parent: screen, left: `${LEADS_PANE_FRACTION * 100}%`, right: 0, bottom: 1, height: 3,
    tags: true,
    border: { type: 'line', fg: 'green' },
    label: ' ПОРАКА ',
    style: { fg: 'white', border: { fg: 'green' } },
  } as any);

  // Bottom status bar
  const statusBar: any = blessed.box({
    parent: screen, bottom: 0, left: 0, height: 1, width: '100%',
    tags: true,
    style: { bg: 'black', fg: 'yellow' },
  } as any);

  return { screen, topBar, leadsBox, chatBox, ownerBox, inputBox, statusBar };
}

// Escape blessed tag characters in user/LLM text.
export const esc = (s: string): string =>
  s.replace(/{/g, '{open}').replace(/}/g, '{close}');

export const hhmm = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
