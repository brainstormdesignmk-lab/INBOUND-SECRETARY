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
//   4. the WAIT WINDOW (send delay / typing countdown) writes at most one
//      frame per visible second, and an unchanged frame writes nothing;
//   5. HEAL REPAIRS A GARBLED TERMINAL: rogue bytes printed into the middle of
//      a pane (what a broker does when it mis-executes a frame) are gone after
//      painter.heal() — every row is re-addressed, including the rows blessed
//      would otherwise skip forever (the [00:32] ghost-row mechanism).
//
// Run: npx tsx scripts/tui-frame-check.ts   (exit 0 = frames valid)
//   TUI_COLS / TUI_ROWS   terminal size (default 80x24)
//   TUI_ROUNDS            transcript rounds (default 4; ~30 overflows scrollback)
//   TUI_RESIZE_ROWS       shrink to N rows mid-session (0 = no resize)
//   TUI_SKIP_RESIZE_CLEAR=1  simulate the pre-fix resize handler
//   TUI_WIDE_AMB=1        replay treating ambiguous-width runes as wide (a
//                         DIAGNOSTIC model: blessed composes rows assuming
//                         those runes are one column, so a terminal that
//                         renders them double-width overflows on any row that
//                         contains them — reported, not enforced)
//   TUI_DUMP=path         dump the raw ANSI stream

import { PassThrough } from 'stream';
import * as fs from 'fs';
import { buildLayout, hasWideGlyph } from '../src/tui/layout';
import { FramePainter } from '../src/tui/paint';
import { Terminal } from '../src/tui/terminal';

const COLS = parseInt(process.env.TUI_COLS ?? '80', 10);
const ROWS = parseInt(process.env.TUI_ROWS ?? '24', 10);
const ROUNDS = parseInt(process.env.TUI_ROUNDS ?? '4', 10);
const RESIZE_ROWS = parseInt(process.env.TUI_RESIZE_ROWS ?? '0', 10);
// Duration of the simulated send-delay / typing WAIT (the [00:32] capture).
const WAIT_SECS = parseInt(process.env.TUI_WAIT_SECS ?? '6', 10);

// ── fake terminal streams ────────────────────────────────────────────────────
const chunks: string[] = [];
// Problems found while driving the scenarios (they are reported with the
// frame-invariant failures at the end).
const setupFailures: string[] = [];
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

// THE PAINTER IS THE REAL ONE (src/tui/paint.ts) — the app and this check must
// never drift apart again. It owns the change gate (nothing changed → no write)
// and re-emits the volatile rows (clock, input, status) WHOLE.
const painter = new FramePainter(boxes);
function repaint(force = false): void { painter.paint({ force }); }

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
// The WAIT status line, exactly as TuiApp.renderStatus renders it during the
// send delay / typing window: a WHOLE-SECOND countdown (the old one-decimal
// countdown changed ten times a second and forced a frame each time).
function renderWaitStatus(secondsLeft: number): void {
  boxes.statusBar.setContent(`{white-bg}{black-fg} ⏳ клиентот пишува… ${secondsLeft}s — [Enter] инстант {/black-fg}{/white-bg} · antiban: 9/s бакет · мозок: deterministic `);
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

// ── the terminal emulator ────────────────────────────────────────────────────
// The screen model lives in src/tui/terminal.ts, SHARED with the pty harness
// (scripts/tui-pty-check.ts): the headless check and the real-terminal check
// must never disagree about what a frame looks like.

function replay(stream: string): Terminal {
  const t = new Terminal({ cols: COLS, rows: ROWS, wideAmbiguous: process.env.TUI_WIDE_AMB === '1' });
  t.write(stream);
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

  // ── THE WAIT WINDOW (the [00:32] "acting strangely" capture) ─────────────
  // While Lina's send delay / the client's typing window runs, the status line
  // carries a countdown. Before the fix that countdown had one decimal AND the
  // ticker repainted every 100 ms, so a 30 s wait emitted ~300 partial frames
  // (cursor jump + a digit or two) — the tiny-write class web terminal brokers
  // mis-execute. Contract now: at most ONE frame per visible second, each one
  // a whole-row write.
  let waitFrames = 0, waitChunks = 0, waitTiny = 0, waitMaxRun = 0, waitBytes = 0;
  if (WAIT_SECS > 0) {
    const framesBefore = painter.frames;
    const chunksBefore = chunks.length;
    const bytesBefore = chunks.join('').length;
    for (let s = WAIT_SECS; s > 0; s--) {
      for (let t = 0; t < 10; t++) { // the 100 ms ticker, ten ticks per second
        renderWaitStatus(s);         // the countdown advances once per SECOND
        repaint();
        await tick();
      }
    }
    waitFrames = painter.frames - framesBefore;
    waitChunks = chunks.length - chunksBefore;
    const waitStream = chunks.join('').slice(bytesBefore);
    const wr = replay(waitStream);
    waitTiny = wr.tinyRuns;
    waitMaxRun = wr.maxRun;
    waitBytes = waitStream.length;
  }
  // The status line goes back to normal — one last write, then the gate closes.
  renderAll(); await tick(); await tick(); // let every buffered write flush

  // ── A BROKER GARBLES THE FRAME, THEN THE HEAL REPAIRS IT ─────────────────
  // The [00:32] capture ended with rows of a previous frame still on screen.
  // Emulate the cause (a broker printing a frame's bytes at the cursor as
  // literal text inside a pane) and require the heal to wipe it: every row is
  // marked dirty AND poisoned, so blessed re-emits the whole screen — a row it
  // would otherwise skip can never survive as a ghost.
  {
    const garbled = 'GHOST-GARBLE-MARK';
    const preGrid = replay(chunks.join('') + `\x1b[5;25H${garbled}`).rowsText();
    if (!preGrid.some(r => r.includes(garbled))) {
      setupFailures.push('the injected garble never reached the emulated screen (test setup is broken)');
    }
    painter.heal();
    await tick(); await tick();
    const postGrid = replay(chunks.join('')).rowsText();
    const ghost = postGrid.map((r, i) => (r.includes(garbled) ? i : -1)).filter(i => i >= 0);
    for (const row of ghost) {
      failures.push(`a HEAL did not erase the garbled row ${row}: ${postGrid[row].trim().slice(0, 50)}`);
    }
  }

  // ── NOTHING CHANGED → NOTHING WRITTEN ────────────────────────────────────
  // The change gate must make idle repaints free: three full render passes over
  // identical content may not emit a single byte (this is what keeps a broker
  // from ever seeing a redundant write).
  const noopFramesBefore = painter.frames;
  const noopBytesBefore = chunks.join('').length;
  renderAll(); renderAll(); renderAll();
  await tick(); await tick();
  const noopFrames = painter.frames - noopFramesBefore;
  const noopBytes = chunks.join('').length - noopBytesBefore;

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
  const rows = t.rowsText();
  const failures: string[] = [...setupFailures];
  let wideAmbNote = '';

  // No rune the terminal draws wider than blessed measures it may ever reach
  // the screen: such a row is one column wider than composed, so the terminal
  // wraps it — and a wrap on the BOTTOM row scrolls the whole frame out of
  // sync. The waiting status line ('⏳ клиентот пишува…') was exactly that bug;
  // this pins the narrowGlyphs() guard (src/tui/layout.ts) end to end.
  {
    const wide: string[] = [];
    for (const ch of stream) if (hasWideGlyph(ch)) wide.push(ch);
    if (wide.length) {
      failures.push(`${wide.length} wide-glyph rune(s) reached the terminal (e.g. ${JSON.stringify(wide.slice(0, 3).join(''))}) — the row they sit in will wrap`);
    }
  }

  if (t.scrolled) {
    const why = 'the physical terminal SCROLLED — blessed\'s cell-diff model is desynced from here on';
    // In the AMBIGUOUS-WIDTH model every row carrying '·' / '…' overflows the
    // margin, because blessed composed it for width 1 — that is a property of
    // the layout, not of the writes. Report it; enforce no-scroll only under
    // the width model the terminal actually uses (the default replay).
    if (process.env.TUI_WIDE_AMB === '1') wideAmbNote = why;
    else failures.push(why);
  }
  if (t.overflowCup) failures.push('blessed addressed a cursor position OUTSIDE the screen');

  // The wait-window contract (one write per visible second, whole rows only)
  // and the idle gate (a redundant render writes nothing).
  if (WAIT_SECS > 0) {
    if (waitFrames > WAIT_SECS + 1) {
      failures.push(`the ${WAIT_SECS}s wait wrote ${waitFrames} frames (max ${WAIT_SECS + 1} — one per visible second)`);
    }
    if (waitChunks > WAIT_SECS + 1) {
      failures.push(`the ${WAIT_SECS}s wait flushed ${waitChunks} chunks (max ${WAIT_SECS + 1})`);
    }
    // NOTE: per-run granularity is informational here. A whole-row write is
    // still made of attribute-separated runs (borders, colours), so short runs
    // can appear inside ONE cursor-addressed write; the hazard is the NUMBER
    // of writes, which is what the frame/chunk bounds above pin. The
    // whole-row property itself is pinned in tests/tui-paint.test.ts.
  }
  if (noopFrames !== 0 || noopBytes !== 0) {
    failures.push(`an unchanged frame was still written: ${noopFrames} frame(s) / ${noopBytes} bytes for three identical renders`);
  }

  // Labels: each pane's label must appear EXACTLY once — except when the pane
  // is too short to hold a labeled border at all (a 14-row terminal leaves the
  // chat pane a single row, so blessed legitimately omits its label there).
  const panes: Array<[string, any]> = [
    ['┌─ ПОРАКА', boxes.inputBox],
    ['┌─ РАЗГОВОР', boxes.chatBox],
    ['┌─ СОПСТВЕНИК', boxes.ownerBox],
  ];
  for (const [l, box] of panes) {
    const n = rows.filter(r => r.includes(l)).length;
    if (n === 1) continue;
    const height = Number(box?.lpos?.height ?? 0);
    if (n === 0 && height < 2) {
      console.log(`  note: pane "${l}" is ${height} row(s) tall at ${ROWS} rows — its label cannot be drawn`);
      continue;
    }
    failures.push(`label "${l}" appears ${n}× (must be exactly 1)`);
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
  console.log(`  wait window: ${waitFrames} frames / ${waitChunks} chunks / ${waitBytes} bytes for ${WAIT_SECS}s (limit ${WAIT_SECS + 1} frames), ${waitTiny} tiny runs (info), longest ${waitMaxRun}`);
  console.log(`  idle gate: ${noopFrames} frames / ${noopBytes} bytes for 3 redundant renders (must be 0)`);
  if (wideAmbNote) console.log(`  wide-amb diagnostic: ${wideAmbNote}`);
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
