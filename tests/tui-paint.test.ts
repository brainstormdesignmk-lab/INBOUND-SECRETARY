// THE REPAINT CONTRACT (src/tui/paint.ts) — pinned against the REAL layout on
// fake streams, because the failures it fixes only exist in the byte stream the
// terminal actually receives.
//
// The [00:32] "TUI is acting strangely" capture: while Lina's antiban send
// delay (and the client's typing window) ran, the ticker repainted every 100 ms
// and each repaint was a blessed CELL DIFF — a cursor jump plus the countdown's
// changing digit. Rows blessed considered unchanged (or blank) were never
// re-emitted at all, so a scrolled or re-wrapped pane left the previous frame's
// lines on screen: duplicated headers, half-written panes, ghost text that only
// disappeared when some later redraw happened to touch those rows ("while I
// wait the seconds before the message sending … then goes back to normal").
//
// Four rules now hold, all measured here on the raw bytes:
//   1. nothing visible changed → NOTHING is written (the idle gate);
//   2. only the surfaces that changed are rewritten — the clock line, the
//      input box, the status line and each pane independently;
//   3. each of them is rewritten WHOLE (first row to last), so a shifted line
//      can never leave the previous frame's tail behind, and no write is ever
//      a scatter of single-character diffs;
//   4. heal() re-addresses EVERY row of the screen, including the rows blessed
//      would otherwise skip forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'stream';
import { buildLayout } from '../src/tui/layout';
import { FramePainter, boxRows, markRowsWhole, screenRows, surfaceRows } from '../src/tui/paint';

function makeScreen(cols = 80, rows = 24) {
  const input = new PassThrough(); (input as any).isTTY = true;
  const output = new PassThrough(); (output as any).isTTY = true;
  (output as any).columns = cols; (output as any).rows = rows;
  const chunks: string[] = [];
  output.on('data', (d: Buffer) => chunks.push(d.toString()));
  const boxes = buildLayout('PAINT-TEST', { input, output });
  return { boxes, chunks, stream: () => chunks.join('') };
}
const tick = (): Promise<void> => new Promise(r => setImmediate(r));

/** Cursor jumps (CUP) in a stream, each with the printable text that follows it
 *  before the next jump — exactly what a broker has to execute. */
function cupWrites(stream: string): Array<{ row: number; col: number; text: string; raw: string }> {
  const out: Array<{ row: number; col: number; text: string; raw: string }> = [];
  const re = /\x1b\[(\d+);(\d+)H/g;
  const hits: Array<{ i: number; row: number; col: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(stream))) hits.push({ i: m.index, row: parseInt(m[1], 10), col: parseInt(m[2], 10) });
  for (let k = 0; k < hits.length; k++) {
    const from = hits[k].i + `\x1b[${hits[k].row};${hits[k].col}H`.length;
    const to = k + 1 < hits.length ? hits[k + 1].i : stream.length;
    const raw = stream.slice(from, to);
    const text = raw.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
    out.push({ row: hits[k].row, col: hits[k].col, text, raw });
  }
  return out;
}
/** Rows addressed by a stream, 1-based as on the wire, de-duplicated. */
const addressedRows = (stream: string): number[] =>
  [...new Set(cupWrites(stream).map(w => w.row))].sort((a, b) => a - b);

/** Paint one change and return only the bytes that frame wrote. */
async function frameFor(
  painter: FramePainter, chunks: string[], mutate: () => void,
): Promise<string> {
  const before = chunks.join('').length;
  mutate();
  painter.paint();
  await tick(); await tick();
  return chunks.join('').slice(before);
}

test('idle gate: a repaint with nothing changed writes ZERO bytes', async () => {
  const { boxes, chunks } = makeScreen();
  const painter = new FramePainter(boxes);
  boxes.topBar.setContent(' top');
  boxes.chatBox.setContent('chat line');
  boxes.inputBox.setContent('› █');
  boxes.statusBar.setContent('status');
  assert.equal(painter.paint(), true, 'the first paint writes');
  await tick(); await tick();
  const bytesBefore = chunks.join('').length;
  const framesBefore = painter.frames;
  for (let i = 0; i < 4; i++) {
    painter.paint();
    painter.paint({ force: false });
  }
  await tick(); await tick();
  assert.equal(painter.frames, framesBefore, 'no frame may be written for identical content');
  assert.equal(chunks.join('').length, bytesBefore, 'not a single byte may reach the terminal');
  assert.equal(painter.skipped, 8, 'every redundant paint is counted as skipped');
});

test('a visible change writes exactly ONE frame; repeating it writes nothing', async () => {
  const { boxes, chunks } = makeScreen();
  const painter = new FramePainter(boxes);
  boxes.statusBar.setContent('status A');
  painter.paint();
  await tick(); await tick();
  const before = chunks.join('').length;

  boxes.statusBar.setContent('status B');
  assert.equal(painter.paint(), true, 'the changed status writes');
  await tick(); await tick();
  const afterChange = chunks.join('').length;
  assert.ok(afterChange > before, 'the status change reached the terminal');

  assert.equal(painter.paint(), false, 'the same status again is a no-op');
  await tick(); await tick();
  assert.equal(chunks.join('').length, afterChange, 'no repeat write');
});

test('the wait countdown costs ONE write per second, not ten', async () => {
  const { boxes, chunks } = makeScreen();
  const painter = new FramePainter(boxes);
  const countdown = (s: number) => boxes.statusBar.setContent(`» клиентот пишува… ${s}s — [Enter] инстант`);
  countdown(6);
  painter.paint();
  await tick();
  const before = chunks.join('').length;
  let writes = 0;
  // One second of the 100 ms ticker: the rendered value is unchanged inside the
  // second, so only the first tick may write.
  for (let t = 0; t < 10; t++) { countdown(6); if (painter.paint()) writes++; await tick(); }
  assert.equal(writes, 0, 'nine of the ten ticks must be free (the value did not change)');
  countdown(5); // the next second
  assert.equal(painter.paint(), true, 'the next second writes once');
  await tick();
  assert.ok(chunks.join('').length > before, 'the second tick reached the terminal');
});

test('each surface is rewritten on its own: a countdown touches ONLY the status row', async () => {
  const { boxes, chunks } = makeScreen(80, 24);
  const painter = new FramePainter(boxes);
  boxes.topBar.setContent(' top');
  boxes.leadsBox.setContent('▸ Клиент-1');
  boxes.chatBox.setContent('chat content');
  boxes.ownerBox.setContent('owner');
  boxes.inputBox.setContent('› █');
  boxes.statusBar.setContent('status');
  painter.paint();
  await tick(); await tick();

  assert.deepEqual(addressedRows(await frameFor(painter, chunks, () => boxes.statusBar.setContent('status 2'))), [24],
    'a status change rewrites the status row and nothing else');
  assert.deepEqual(addressedRows(await frameFor(painter, chunks, () => boxes.topBar.setContent(' top 2'))), [1],
    'a clock change rewrites the top row and nothing else');
  assert.deepEqual(addressedRows(await frameFor(painter, chunks, () => boxes.inputBox.setContent('› ME'))), [21, 22, 23],
    'a keystroke rewrites the three input rows');
  assert.deepEqual(addressedRows(await frameFor(painter, chunks, () => boxes.ownerBox.setContent('owner 2'))),
    [13, 14, 15, 16, 17, 18, 19, 20], 'the owner pane rewrites its own rows');
});

test('a pane whose content changed is rewritten WHOLE — no stale tail, no fragment', async () => {
  const { boxes, chunks } = makeScreen(80, 24);
  const painter = new FramePainter(boxes);
  const many = Array.from({ length: 9 }, (_, i) => `ghost line ${i}`).join('\n');
  boxes.chatBox.setContent(many);
  painter.paint();
  await tick(); await tick();
  assert.deepEqual(addressedRows(chunks.join('')), Array.from({ length: 24 }, (_, i) => i + 1),
    'the first frame draws every surface it has never drawn before');

  // The pane SHRINKS to one line: every chat row must be addressed again,
  // otherwise the eight removed lines stay on screen.
  const frame = await frameFor(painter, chunks, () => boxes.chatBox.setContent('short'));
  assert.deepEqual(addressedRows(frame), [2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
    'the whole chat pane is re-emitted, from its first row to its last');
  for (const w of cupWrites(frame)) {
    if (w.row >= 2 && w.row <= 4) assert.ok(w.text.length > 40, `row ${w.row} is written as one line, not a fragment`);
  }
});

test('a keystroke re-emits the input row as ONE whole line, never a fragment', async () => {
  const { boxes, chunks } = makeScreen();
  const painter = new FramePainter(boxes);
  boxes.inputBox.setContent('› █');
  painter.paint();
  await tick(); await tick();

  const typed = '› ZDRAVO█';
  const frame = await frameFor(painter, chunks, () => boxes.inputBox.setContent(typed));

  // The input content row (the box's second row) must arrive after ONE cursor
  // jump, carrying the WHOLE line — this is what keeps letters visible behind a
  // broker that mis-executes small writes.
  const inputRows = boxRows(boxes.inputBox, [20, 23], 24);
  const inputRow = inputRows[1] + 1; // 0-based content row → 1-based CUP row
  const writes = cupWrites(frame);
  const contentRow = writes.filter(w => w.row === inputRow);
  assert.ok(contentRow.length >= 1, `the input row must be addressed: rows seen ${addressedRows(frame).join(',')}`);
  const last = contentRow[contentRow.length - 1];
  assert.ok(last.text.includes('› ZDRAVO█'),
    `the whole typed line must ride one cursor jump, got: ${JSON.stringify(last.text.slice(0, 60))}`);
  const fragments = writes.filter(w => /ZDRAVO/.test(w.text) && w.text.trim().length <= 2);
  assert.equal(fragments.length, 0, 'the typed line must never arrive as a small fragment');
});

test('heal() re-addresses EVERY row — the whole-frame contract that repairs a garbled screen', async () => {
  const { boxes, chunks } = makeScreen(80, 24);
  const painter = new FramePainter(boxes);
  boxes.chatBox.setContent('chat');
  painter.paint();
  await tick(); await tick();

  const before = chunks.join('').length;
  painter.heal();
  await tick(); await tick();
  const healed = chunks.join('').slice(before);
  const rows = addressedRows(healed);
  for (let r = 1; r <= 24; r++) {
    assert.ok(rows.includes(r), `row ${r} must be re-addressed by the heal (got ${rows.join(',')})`);
  }
});

test('surface fallbacks and clamping hold before the first render', () => {
  const { boxes } = makeScreen(80, 24);
  const byKey = new Map(surfaceRows(boxes).map(s => [s.key, s.fallback]));
  assert.deepEqual(byKey.get('top'), [0, 1]);
  assert.deepEqual(byKey.get('status'), [23, 24], 'the status row is the last line');
  assert.deepEqual(byKey.get('input'), [20, 23], 'the input box is three rows above the status bar');
  assert.deepEqual(byKey.get('chat'), [1, 12], 'the chat pane starts under the top bar');
  // lpos wins once blessed has rendered (rows 1..11 for an 80x24 screen).
  boxes.chatBox.setContent('x');
  boxes.screen.render();
  assert.deepEqual(boxRows(boxes.chatBox, [0, 0], 24), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
    'the painted position is used when there is one');
  assert.equal(screenRows(boxes.screen), 24);
  const clamped = boxRows(boxes.chatBox, [1, 99], 24);
  assert.ok(clamped.every(r => r >= 0 && r < 24), 'fallback rows are clamped, never emitted out of range');
});

test('markRowsWhole flags exactly the rows it is given, and out-of-range rows are safe', () => {
  const { boxes } = makeScreen(80, 24);
  const screen: any = boxes.screen;
  screen.alloc?.(true);
  screen.render();
  markRowsWhole(screen, [0]);
  assert.equal(screen.lines[0].dirty, true, 'row 0 is flagged for a whole-row write');
  assert.equal(screen.olines[1].some((c: any) => c && c[1] !== '\u0000'), true, 'other rows stay untouched');
  assert.doesNotThrow(() => markRowsWhole(screen, [99]), 'out-of-range rows are ignored');
});
