// BANK:TUI EDITOR MODEL — visual lines and caret arithmetic.
//
// blessed's textarea has `// TODO: Handle directional keys`, so the review
// screen owns its own buffer. These tests pin the part that is easy to get
// wrong and expensive to notice: source offsets through word-wrap, and where
// ↑/↓ and Home/End put the caret.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caretLine, editLayout, moveVertical, paintCaret } from '../src/bank/editModel';

const TEXT = 'Ова е подолг одговор што се пренесува во неколку реда за да се провери преломот.';

test('wrap keeps exact source offsets and never exceeds the width', () => {
  const width = 24;
  const lines = editLayout(TEXT, width);
  assert.ok(lines.length > 1, 'the sample must actually wrap');
  assert.equal(lines[0].start, 0);
  assert.equal(lines[lines.length - 1].end, TEXT.length);
  for (const l of lines) {
    assert.ok(l.end - l.start <= width, `line wider than ${width}: ${l.end - l.start}`);
    assert.ok(l.end >= l.start);
  }
  // Contiguous: the next line starts at the previous end, or one past it when
  // a wrap space was skipped.
  for (let i = 1; i < lines.length; i++) {
    const gap = lines[i].start - lines[i - 1].end;
    assert.ok(gap === 0 || gap === 1, `unexpected gap ${gap} before line ${i}`);
  }
  // The wrap skipped exactly the space it broke on.
  assert.equal(TEXT[lines[0].end], ' ');
  assert.equal(lines[1].start, lines[0].end + 1);
});

test('newlines start a visual line, blank lines included', () => {
  const t = 'прв ред\n\nвтор ред';
  const lines = editLayout(t, 40);
  assert.equal(lines.length, 3);
  assert.equal(lines[0].start, 0);
  assert.equal(lines[1].start, lines[1].end, 'the blank line is empty');
  assert.equal(lines[2].start, t.indexOf('втор'));
  assert.equal(lines[2].end, t.length);
});

test('the caret at the end sits on the last visual line', () => {
  const lines = editLayout(TEXT, 24);
  assert.equal(caretLine(lines, 0), 0);
  assert.equal(caretLine(lines, TEXT.length), lines.length - 1);
});

test('up/down keep the column, clamp to a shorter line and stop at the edges', () => {
  const lines = editLayout(TEXT, 24);
  const last = lines.length - 1;
  for (let i = 0; i <= last; i++) {
    const pos = lines[i].start + 3;
    const up = moveVertical(lines, pos, -1);
    const down = moveVertical(lines, pos, 1);
    if (i > 0) assert.ok(up >= lines[i - 1].start && up <= lines[i - 1].end);
    if (i < last) assert.ok(down >= lines[i + 1].start && down <= lines[i + 1].end);
  }
  assert.equal(moveVertical(lines, 0, -1), 0, 'up on the first line is a no-op');
  assert.equal(moveVertical(lines, TEXT.length, 1), TEXT.length, 'down on the last line is a no-op');
});

test('paintCaret inverts exactly the character under the caret', () => {
  const line = { start: 0, end: 8 };
  assert.equal(paintCaret(line, 'Се викам', 3), 'Се {inverse}в{/inverse}икам');
  assert.equal(paintCaret(line, 'Се викам', 8), 'Се викам{inverse} {/inverse}');
  // A caret on a wrapped line is relative to that line's start.
  const wrapped = { start: 10, end: 18 };
  assert.equal(paintCaret(wrapped, '0000000000Се викам', 13), 'Се {inverse}в{/inverse}икам');
});
