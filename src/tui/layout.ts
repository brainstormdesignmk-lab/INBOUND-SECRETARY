import blessed from 'blessed';

// blessed ships poor typings (@types/blessed disagrees with its runtime).
// We use `any` for the widget boxes — the runtime API is what matters here.

export interface TuiBoxes {
  screen: any;
  topBar: any;
  leadsBox: any;
  chatBox: any;
  ownerBox: any;
  inputBox: any;
  statusBar: any;
}

export function buildLayout(title: string): TuiBoxes {
  const screen: any = blessed.screen({
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
    parent: screen, top: 1, left: 0, width: '33%', bottom: 1,
    tags: true,
    scrollable: true, alwaysScroll: true,
    scrollbar: { ch: '│', style: { fg: 'cyan' } },
    border: { type: 'line', fg: 'cyan' },
    label: ' КЛИЕНТИ ',
    style: { fg: 'white', border: { fg: 'cyan' } },
  } as any);

  // RIGHT TWO-THIRDS — the active chat (client ↔ Lina)
  const chatBox: any = blessed.box({
    parent: screen, top: 1, left: '33%', right: 0, bottom: 12,
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
    parent: screen, left: '33%', right: 0, bottom: 4, height: 8,
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
    parent: screen, left: '33%', right: 0, bottom: 1, height: 3,
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
