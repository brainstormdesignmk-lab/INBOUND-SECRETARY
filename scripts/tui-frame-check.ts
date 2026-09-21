// TUI FRAME CHECK — headless repro for the "TUI messes up after a longer
// chat" corruption (pane borders stamped mid-content, tripled ПОРАКА header).
//
// blessed accepts fake input/output streams: we drive the REAL buildLayout()
// with a growing transcript (the renderChat() protocol), force a flush tick
// after every repaint (blessed buffers writes and flushes on nextTick — one
// flushed chunk per render, exactly the byte sequence a real terminal sees),
// replay the stream through a minimal terminal emulator (CUP/ED/EL/DECSTBM/
// ACS/deferred-wrap/scroll) and assert:
//
//   1. the physical terminal NEVER scrolled — a scroll desyncs blessed's
//      cell-diff model forever (the permanent row-shifted artifact);
//   2. every pane label appears exactly once; panes hold their own content;
//   3. after a mid-session SHRINK (the web-broker re-layout) the orphaned
//      rows are cleared — no stale borders/text under the new layout;
//   4. SELF-HEALING: the final flushed chunk re-addresses EVERY row (the
//      forceFullRedraw contract) — so any write a lossy web broker drops is
//      re-emitted wholesale on the next repaint instead of leaving a hole
//      blessed never repaints (the field bug mechanism).
//
// Run: npx tsx scripts/tui-frame-check.ts   (exit 0 = frames valid)
//   TUI_COLS / TUI_ROWS   terminal size (default 80x24)
//   TUI_ROUNDS            transcript rounds (default 4; ~30 overflows scrollback)
//   TUI_RESIZE_ROWS       shrink to N rows mid-session (0 = no resize)
//   TUI_SKIP_RESIZE_CLEAR=1  simulate the pre-fix resize handler
//   TUI_WIDE_AMB=1        replay treating ambiguous-width runes as wide
//   TUI_DUMP=path         dump the raw ANSI stream

import { PassThrough } from 'stream';
import * as fs from 'fs';
import { buildLayout } from '../src/tui/layout';

const COLS = parseInt(process.env.TUI_COLS ?? '80', 10);
const ROWS = parseInt(process.env.TUI_ROWS ?? '24', 10);
const ROUNDS = parseInt(process.env.TUI_ROUNDS ?? '4', 10);
const RESIZE_ROWS = parseInt(process.env.TUI_RESIZE_ROWS ?? '0', 10);

// ── fake terminal streams ────────────────────────────────────────────────────
const chunks: string[] = [];
const input = new PassThrough();
(input as any).isTTY = true;
const output = new PassThrough();
(output as any).isTTY = true;
(output as any).columns = COLS;
(output as any).rows = ROWS;
output.on('data', (d: Buffer) => chunks.push(d.toString()));
const tick = (): Promise<void> => new Promise(r => setImmediate(r));

// ── the REAL layout, driven headlessly ───────────────────────────────────────
const boxes = buildLayout('FRAME-CHECK', { input, output });

// Mirror of TuiApp.forceFullInputRedraw (src/tui/app.ts): blank ONLY the
// input rows — the full-screen blanking variant was field-tested WORSE (the
// broker mis-positions CUPs, so each extra full row dumped at a stale cursor
// repeated pane headers horizontally).
function forceFullInputRedraw(): void {
  const screen: any = boxes.screen;
  const inputBox: any = boxes.inputBox;
  const lpos = inputBox.lpos;
  const top = lpos ? lpos.yi : inputBox.atop;
  const bottom = lpos ? lpos.yl : inputBox.abottom;
  for (let y = top; y < bottom; y++) {
    const old = screen.olines[y];
    if (!old) continue;
    for (let x = 0; x < old.length; x++) old[x] = [screen.dattr, '\x00'];
  }
}
function repaint(): void {
  forceFullInputRedraw();
  boxes.screen.render();
}

// ── render pipeline (mirrors src/tui/app.ts) ─────────────────────────────────
interface Msg { role: 'user' | 'assistant'; at: number; text: string; }
const msgs: Msg[] = [];
let clock = Date.UTC(2026, 8, 20, 0, 5, 0);
const hhmm = (at: number): string => {
  const d = new Date(at);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};
const esc = (s: string): string => s.replace(/{/g, '{open}').replace(/}/g, '{close}');

function renderChat(): void {
  const lines = msgs.map(m =>
    m.role === 'user'
      ? `{cyan-fg}[${hhmm(m.at)}] ${esc(m.text)}{/cyan-fg}`
      : `[${hhmm(m.at)}] {white-fg}ЛИНА{/white-fg} [без LLM]: ${esc(m.text)}`);
  boxes.chatBox.setContent(lines.join('\n\n'));
  boxes.chatBox.setScrollPerc(100);
}
function renderOwner(): void {
  boxes.ownerBox.setContent('{gray-fg}Тука Лина ќе го праша сопственикот дали имотот е достапен и дали го прифаќа терминот за посета. Одговорете со [F3].{/gray-fg}');
}
function renderInput(): void {
  boxes.inputBox.setLabel(' ПОРАКА ');
  boxes.inputBox.setContent(`{green-fg}› {/green-fg}█`);
}
function renderStatus(): void {
  boxes.statusBar.setContent(` presentation · 0/100 · мозок: deterministic · ${msgs.length} пораки `);
}
function renderTop(): void {
  boxes.topBar.setContent(` METROPOLIS · ЛИНА · TUI   клиенти: 1   активен: Клиент-1   испратено: ${msgs.length}   мозок: deterministic`);
}
function renderLeads(): void {
  const row = `▸ Клиент-1\n   client-1 · presentation · 0/100 · мозок: deterministic`;
  boxes.leadsBox.setContent(`{inverse}${esc(row)}{/inverse}\n`);
  boxes.leadsBox.setScrollPerc(100);
}
function renderAll(): void {
  renderTop(); renderLeads(); renderChat(); renderOwner(); renderInput(); renderStatus();
  repaint();
}

// A realistic long presentation card (the 00:05–00:06 transcript style).
const card = (eb: number, loc: string, price: number, body: string): string =>
  `Станот под Евидентен број ${eb} е двособен стан во ${loc}. Има 55 м² станбена површина. Цената е ${price} евра. ${body}`;

const SCRIPT: Array<[string, string]> = [
  ['AKO IMAS DO 250 E NESTO, MOZNO E DA RAZMISLAM',
    'За Вас подготвив неколку предлози кои во целост ги исполнуваа Вашите барања. ' + card(41, 'Ѓорче Петров', 250, 'Комфорен стан. Станот има 2 тоалета, кујна дневна и трпезарија, со посебна спална соба, паркинг обезбеден пред објект. Со подрум и лифт. Реновиран стан на прв кат. Греење инвертери.')],
  ['DRUGO ?',
    'Во моментов нема стан со една спална во оваа населба во Вашата цена, но има слични опции кои би можеле да Ви се допаднат. ' + card(76, 'Центар', 200, 'Реновирана Ефтина Гарсоњера во Строг Центар. Во потегот меѓу Универзална Сала и Католичка Црква, на 100м од Црногорска Амбасада. Гарсоњерата е во Сутерен на објект од 2015 г. Комплетно реновирана бања и нов душек. Состојбата е одлична.')],
  ['DRUGI STANOVI IMATE ?',
    'Сите имоти што соодветствуваат на Вашите критериуми ги искористивме и ги прегледавме. Дали да ги сочувам Вашите податоци и барања за да Ве контактирам кога ќе добиеме нов соодветен имот, или сакате да го прошириме опсегот?'],
  ['GARSONJERAVA KAJ CRNOGORSKA AMBASADA MI E INTERESNA',
    'Драго ми е за Вашиот интерес. Прво би сакала да Ве известам за нашата политика во Метрополис, односно дека организирањето разглед на имотот чини симболични 300 денари (5 евра). Дали се согласувате со ова за да можам да се слушнам со сопственикот?'],
  ['DA SE SOGLASUVAM',
    'Одлично! Ќе организирам посета — последниве информации и закажуваме. Кога би биле слободни во наредните денови?'],
  ['UTRE OKO 18 CASOT',
    'Одлично, ќе го прашам сопственикот дали терминот му одговара и веднаш ќе Ве потврдам.'],
  ['SUPER, BLAGODARAM',
    'Поздрав, ќе ви пишувам штом ќе добијам одговор од сопственикот. ' + card(48, 'Карпош III', 250, 'Трособен стан во Карпош 3. Купатилото и кујната се комплет изреновирани, малку постар намештај. Парно греење.')],
];

async function turn(user: string, assistant: string): Promise<void> {
  msgs.push({ role: 'user', at: clock += 60_000, text: user });
  msgs.push({ role: 'assistant', at: clock += 60_000, text: assistant });
  renderAll();
  await tick();
}

// ── mini terminal emulator ───────────────────────────────────────────────────
// DEC special graphics (ACS): blessed draws borders in this charset.
const ACS: Record<string, string> = {
  l: '┌', q: '─', k: '┐', x: '│', m: '└', j: '┘',
  t: '├', u: '┤', n: '┼', v: '┴', w: '┬', '~': '·', '0': '█', a: '▒', '`': '◆',
};
// East-Asian AMBIGUOUS-width runes used in the TUI chrome (informational).
const AMBIGUOUS = new Set(['·', '▸', '⚑', '…', '✗', '—', '–', '•', '→', '←']);

interface TermState {
  grid: string[][]; cx: number; cy: number; pendingWrap: boolean;
  scrolled: boolean; overflowCup: boolean;
  regionTop: number; regionBot: number;
  tinyRuns: number; maxRun: number; ed2Count: number;
}

function replay(stream: string): TermState {
  const grid: string[][] = Array.from({ length: ROWS }, () => Array<string>(COLS).fill(' '));
  const t: TermState = {
    grid, cx: 0, cy: 0, pendingWrap: false, scrolled: false, overflowCup: false,
    regionTop: 0, regionBot: ROWS - 1, tinyRuns: 0, maxRun: 0, ed2Count: 0,
  };
  let g0: 'ascii' | 'acs' = 'ascii';
  let runLen = 0;
  let saved: { cx: number; cy: number } | null = null;
  const wideAmb = process.env.TUI_WIDE_AMB === '1';
  const scrollUp = () => {
    for (let r = t.regionTop; r < t.regionBot; r++) grid[r] = grid[r + 1];
    grid[t.regionBot] = Array<string>(COLS).fill(' ');
    t.scrolled = true;
  };
  const put = (ch: string) => {
    runLen++;
    if (t.pendingWrap) {
      t.cx = 0; t.cy++; t.pendingWrap = false;
      if (t.cy >= ROWS) { t.cy = ROWS - 1; scrollUp(); }
    }
    grid[t.cy][t.cx] = g0 === 'acs' ? (ACS[ch] ?? ch) : ch;
    const w = wideAmb && AMBIGUOUS.has(ch) ? 2 : 1;
    if (w === 2 && t.cx + 1 < COLS) grid[t.cy][t.cx + 1] = '';
    if (t.cx + w >= COLS) t.pendingWrap = true; else t.cx += w;
  };
  let i = 0;
  while (i < stream.length) {
    const ch = stream[i];
    if (ch === '\x1b') {
      if (runLen > 0) { if (runLen <= 2) t.tinyRuns++; if (runLen > t.maxRun) t.maxRun = runLen; runLen = 0; }
      if (stream[i + 1] === '[') {
        let j = i + 2;
        while (j < stream.length && stream[j].charCodeAt(0) < 0x40) j++;
        if (j >= stream.length) break;
        const final = stream[j];
        const params = stream.slice(i + 2, j);
        const priv = params.startsWith('?');
        const nums = params.replace(/^\?/, '').split(';').map(p => parseInt(p || '1', 10));
        if (!priv && (final === 'H' || final === 'f')) {
          const row = nums[0] || 1, col = nums[1] || 1;
          if (row > ROWS || col > COLS) t.overflowCup = true;
          t.cy = Math.min(Math.max(row - 1, 0), ROWS - 1);
          t.cx = Math.min(Math.max(col - 1, 0), COLS - 1);
          t.pendingWrap = false;
        } else if (!priv && final === 'J') {
          const mode = nums[0] ?? 0;
          const clearRow = (r: number, from: number, to: number) => { for (let c = from; c < to; c++) grid[r][c] = ' '; };
          if (mode === 0) { clearRow(t.cy, t.cx, COLS); for (let r = t.cy + 1; r < ROWS; r++) clearRow(r, 0, COLS); }
          else if (mode === 1) { for (let r = 0; r < t.cy; r++) clearRow(r, 0, COLS); clearRow(t.cy, 0, t.cx + 1); }
          else { t.ed2Count++; for (let r = 0; r < ROWS; r++) clearRow(r, 0, COLS); }
        } else if (!priv && final === 'K') {
          const mode = nums[0] ?? 0;
          if (mode === 0) for (let c = t.cx; c < COLS; c++) grid[t.cy][c] = ' ';
          else if (mode === 1) for (let c = 0; c <= t.cx; c++) grid[t.cy][c] = ' ';
          else for (let c = 0; c < COLS; c++) grid[t.cy][c] = ' ';
        } else if (!priv && 'ABCD'.includes(final)) {
          const n = nums[0] || 1;
          if (final === 'A') t.cy = Math.max(0, t.cy - n);
          else if (final === 'B') t.cy = Math.min(ROWS - 1, t.cy + n);
          else if (final === 'C') t.cx = Math.min(COLS - 1, t.cx + n);
          else t.cx = Math.max(0, t.cx - n);
          t.pendingWrap = false;
        } else if (final === 'r' && !priv) {
          t.regionTop = Math.max(0, (nums[0] || 1) - 1);
          t.regionBot = Math.min(ROWS - 1, (nums[1] || ROWS) - 1);
        } else if (final === 'h' && params.includes('1049')) {
          for (let r = 0; r < ROWS; r++) grid[r] = Array<string>(COLS).fill(' ');
          t.cx = 0; t.cy = 0; t.pendingWrap = false;
        }
        i = j + 1;
        continue;
      } else if (stream[i + 1] === ']') {
        let j = i + 2;
        while (j < stream.length && stream[j] !== '\x07' && !(stream[j] === '\x1b' && stream[j + 1] === '\\')) j++;
        i = stream[j] === '\x07' ? j + 1 : j + 2;
        continue;
      } else if (stream[i + 1] === '(') {
        g0 = stream[i + 2] === '0' ? 'acs' : 'ascii';
        i += 3; continue;
      } else if ('#%'.includes(stream[i + 1] ?? '')) { i += 3; continue; }
      else if (stream[i + 1] === '7') { saved = { cx: t.cx, cy: t.cy }; i += 2; continue; }
      else if (stream[i + 1] === '8') { if (saved) { t.cx = saved.cx; t.cy = saved.cy; t.pendingWrap = false; } i += 2; continue; }
      else { i += 2; continue; }
    } else if (ch === '\r') { t.cx = 0; t.pendingWrap = false; i++; }
    else if (ch === '\n') { t.pendingWrap = false; t.cy++; if (t.cy >= ROWS) { t.cy = ROWS - 1; scrollUp(); } i++; }
    else if (ch === '\x08') { t.cx = Math.max(0, t.cx - 1); i++; }
    else if (ch === '\x07' || ch === '\x0e' || ch === '\x0f') { i++; }
    else { put(ch); i++; }
  }
  if (runLen > 0) { if (runLen <= 2) t.tinyRuns++; if (runLen > t.maxRun) t.maxRun = runLen; }
  return t;
}

// ── run ──────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  renderAll(); await tick();

  for (let round = 0; round < ROUNDS; round++) {
    for (const [u, a] of SCRIPT) await turn(u, a);      // the 00:05–00:09 exchange
    for (let i = 0; i < 12; i++) {                       // the operator typing over it
      renderInput(); renderStatus();
      repaint();
      await tick();
    }
  }

  let resized = false;
  if (RESIZE_ROWS > 0 && RESIZE_ROWS < ROWS) {
    (output as any).rows = RESIZE_ROWS;
    (output as any).emit('resize');                      // blessed reallocates
    if (process.env.TUI_SKIP_RESIZE_CLEAR !== '1') {
      (boxes.screen as any).program.write('\x1b[H\x1b[2J');
    }
    renderAll();
    await tick();
    resized = true;
    for (const [u, a] of SCRIPT.slice(0, 3)) await turn(u, a); // work continues
  }

  renderAll(); await tick();                             // the final frame

  const stream = chunks.join('');
  const t = replay(stream);
  const rows = t.grid.map(r => r.join(''));
  const failures: string[] = [];

  if (t.scrolled) failures.push('the physical terminal SCROLLED — blessed\'s cell-diff model is desynced from here on');
  if (t.overflowCup) failures.push('blessed addressed a cursor position OUTSIDE the screen');

  for (const l of ['┌─ ПОРАКА', '┌─ РАЗГОВОР', '┌─ СОПСТВЕНИК']) {
    const n = rows.filter(r => r.includes(l)).length;
    if (n !== 1) failures.push(`label "${l}" appears ${n}× (must be exactly 1)`);
  }

  const ownerRow = rows.findIndex(r => r.includes('┌─ СОПСТВЕНИК'));
  if (ownerRow >= 0) {
    for (let r = ownerRow + 1; r < ownerRow + 7 && r < ROWS; r++) {
      if (/\[\d\d:\d\d\]/.test(rows[r])) failures.push(`chat content leaked into the owner pane at row ${r}: ${rows[r].trim().slice(0, 60)}`);
    }
  }
  rows.forEach((r, idx) => {
    const trimmed = r.trim();
    if (trimmed && !/^[│┌└ ]/.test(trimmed) && /[└┐]/.test(trimmed.slice(1, -1))) {
      failures.push(`stray corner mid-content at row ${idx}: ${trimmed.slice(0, 70)}`);
    }
  });

  if (resized) {
    for (let r = RESIZE_ROWS; r < ROWS; r++) {
      if (rows[r].trim() !== '') {
        failures.push(`STALE content remains in the orphaned row ${r} after the shrink: ${rows[r].trim().slice(0, 50)}`);
      }
    }
  }

  // SELF-HEALING (informational): with input-row-only blanking the final
  // frame re-addresses only the input rows + changed cells — that is the
  // intended small-diff profile, not a failure. Report coverage instead.
  const lastChunk = chunks[chunks.length - 1] ?? '';
  const addressed = new Set<number>();
  for (const m of lastChunk.matchAll(/\x1b\[(\d+);\d+H/g)) addressed.add(parseInt(m[1], 10));
  console.log(`  final frame re-addresses ${addressed.size} row(s)`);

  if (process.env.TUI_DUMP) fs.writeFileSync(process.env.TUI_DUMP, stream, 'utf8');

  console.log(`frame-check ${COLS}x${ROWS} rounds=${ROUNDS}${resized ? ` shrink→${RESIZE_ROWS}` : ''}${process.env.TUI_WIDE_AMB === '1' ? ' wide-amb' : ''}: ${chunks.length} flushed frames, ${stream.length} bytes`);
  console.log(`  write runs: ${t.tinyRuns} tiny (≤2 chars, info only — healed by the full repaint), longest ${t.maxRun}, ED2×${t.ed2Count}`);
  if (failures.length) {
    console.error('FRAME CORRUPTION REPRODUCED:');
    for (const f of failures) console.error('  ✗ ' + f);
    console.error('--- final screen ---');
    rows.forEach((r, i) => console.error(String(i).padStart(2) + '│' + r.replace(/\s+$/, '')));
    process.exit(1);
  }
  console.log('✓ frame invariants hold (no scroll, panes intact, no stale rows, self-healing repaint)');
}

main().catch(e => { console.error('[frame-check] fatal:', e); process.exit(1); });
