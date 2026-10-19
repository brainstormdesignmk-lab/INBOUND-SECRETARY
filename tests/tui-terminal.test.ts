// The shared terminal emulator (src/tui/terminal.ts) is the measuring device
// behind BOTH render verifications — the headless frame check and the real-pty
// TUI harness. A measuring device that is wrong makes every check meaningless
// (a missed scroll is exactly the "letters vanish / rows shift" field bug), so
// its own semantics are pinned here, term by term.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Terminal, replayScreen, ACS, AMBIGUOUS_WIDTH } from '../src/tui/terminal';

const term = (cols = 10, rows = 4): Terminal => new Terminal({ cols, rows });

test('printing, CR/LF and the deferred wrap at the last column', () => {
  const t = term(6, 3);
  t.write('abcd');
  assert.equal(t.row(0), 'abcd  ');
  // The cursor sits in the last cell after the 6th character and only wraps
  // when the NEXT one arrives (xterm's deferred wrap) — blessed relies on it.
  t.write('ef');
  assert.equal(t.row(0), 'abcdef');
  assert.equal(t.row(1), '      ');
  t.write('g');
  assert.equal(t.row(0), 'abcdef');
  assert.equal(t.row(1), 'g     ');
  // CR/LF moves to the start of the next row.
  t.write('\r\nX');
  assert.equal(t.row(2), 'X     ');
});

test('writing past the bottom row SCROLLS and sets the flag', () => {
  const t = term(6, 2);
  t.write('a\r\nb\r\nc');
  assert.equal(t.scrolled, true, 'the physical screen scrolled — the desync hazard');
  assert.deepEqual(t.rowsText(), ['b     ', 'c     ']);
});

test('CUP positions the cursor; an off-screen address sets overflowCup', () => {
  const t = term(10, 4);
  t.write('\x1b[3;4HX');
  assert.equal(t.row(2), '   X      ');
  t.write('\x1b[9;9HY');
  assert.equal(t.overflowCup, true, 'row 9 of a 4-row screen must be reported');
  assert.equal(t.row(3).trim(), 'Y', 'the position is clamped, not dropped');
});

test('EL (0/1/2) and ED (0/1/2) clear exactly what they claim', () => {
  const t = term(5, 3);
  t.write('abcde\r\nfghij\r\nklmno');
  t.write('\x1b[1;3H\x1b[0K');            // erase to end of line
  assert.equal(t.row(0), 'ab   ');
  t.write('\x1b[2;3H\x1b[1K');            // erase from the start of the line THROUGH the cursor
  assert.equal(t.row(1), '   ij');
  t.write('\x1b[3;1H\x1b[2K');            // erase the whole line
  assert.equal(t.row(2), '     ');
  t.write('\x1b[2J');
  assert.deepEqual(t.rowsText(), ['     ', '     ', '     ']);
  assert.equal(t.ed2Count, 1);
  // ED 0 from the cursor clears the cursor row rightwards + everything below.
  t.write('aa\r\nbb\r\ncc\x1b[2;1H\x1b[0J');
  assert.deepEqual(t.rowsText(), ['aa   ', '     ', '     ']);
});

test('DEC graphics (ACS) draw box characters, and the charset resets', () => {
  const t = term(6, 2);
  t.write('\x1b(0lqqk\x1b(Bx');
  assert.equal(t.row(0), '┌──┐x ');
  assert.equal(ACS['x'], '│');
});

test('OSC strings are skipped without printing their payload', () => {
  const t = term(20, 2);
  t.write('\x1b]0;a title\x07ok');
  assert.equal(t.row(0).startsWith('ok'), true, `got ${JSON.stringify(t.row(0))}`);
  const t2 = term(20, 2);
  t2.write('\x1b]52;c;ZW5jb2RlZA==\x1b\\ok');   // ST-terminated variant
  assert.equal(t2.row(0).startsWith('ok'), true);
});

test('alt-screen entry (1049) starts from a blank screen', () => {
  const t = term(8, 3);
  t.write('dirty');
  t.write('\x1b[?1049h');
  assert.deepEqual(t.rowsText(), ['        ', '        ', '        ']);
});

test('cursor save/restore (ESC 7 / ESC 8)', () => {
  const t = term(10, 3);
  t.write('ab\x1b7');
  t.write('\x1b[3;5Hcd\x1b8e');
  assert.equal(t.row(0), 'abe       ');
  assert.equal(t.row(2), '    cd    ');
});

test('DECSTBM scroll region bounds what scrolls', () => {
  const t = term(4, 4);
  t.write('a\r\nb\r\nc\r\nd');
  t.write('\x1b[2;3r');           // region = rows 2..3
  t.write('\x1b[3;1H\r\n');       // LF inside the region scrolls only it
  assert.equal(t.scrolled, true);
  assert.equal(t.row(0), 'a   ', 'row 1 is outside the region and must not move');
  assert.equal(t.row(1), 'c   ');
  assert.equal(t.row(2), '    ');
  assert.equal(t.row(3), 'd   ');
});

test('wide-ambiguous model marks the overflow the field terminals show', () => {
  const narrow = replayScreen('a·b', { cols: 6, rows: 1 });
  assert.equal(narrow.row(0), 'a·b   ');
  // The wide model spends TWO columns on the ambiguous rune — that extra column
  // is exactly what overflows a blessed-composed row on a real terminal.
  const wide = replayScreen('a·b', { cols: 6, rows: 1, wideAmbiguous: true });
  assert.equal(wide.row(0), 'a·b  ');
  assert.ok(AMBIGUOUS_WIDTH.has('…'));
});

// The pane reader scans the LIVE screen (border label → its content rows), not
// the escape stream — which is why the funnel assertions can keep working while
// blessed word-wraps, scrolls the pane, or redraws only the changed rows.
test('paneText reads a labelled box the way a reader does', () => {
  const t = term(20, 5);
  const acs = (ch: string) => `\x1b(0${ch}\x1b(B`;
  t.write('\x1b[1;1H' + acs('l') + acs('q'.repeat(18)) + acs('k'));
  t.write('\x1b[1;3H РАЗГОВОР');   // "┌" + "─" + " РАЗГОВОР" = the drawn label
  t.write('\x1b[2;1H' + acs('x') + '\x1b[2;2Hhello' + '\x1b[2;20H' + acs('x'));
  t.write('\x1b[3;1H' + acs('x') + '\x1b[3;2Hworld' + '\x1b[3;20H' + acs('x'));
  t.write('\x1b[4;1H' + acs('m') + acs('q'.repeat(18)) + acs('j'));
  assert.equal(t.paneText('РАЗГОВОР'), 'hello\nworld');
  assert.equal(t.paneCollapsed('РАЗГОВОР'), 'helloworld');
  assert.equal(t.paneText('НЕМА'), undefined);
});

// THE CHUNK-BOUNDARY CONTRACT. A pty delivers bytes in arbitrary chunks, so an
// escape sequence or a multi-byte rune WILL be split across write() calls. A
// parser without a carry buffer prints the tail of `\x1b(B` as literal text,
// fills the row, wraps into the next one and reports a bogus SCROLL — which is
// exactly how this check lied (85 phantom scrolls) before the carry buffer.
// Both feedings must produce the SAME screen.
test('escape sequences and runes split across chunk boundaries parse identically', () => {
  const stream = '\x1b[?1049h\x1b[2J\x1b[1;1H\x1b(0lqqk\x1b(B ab\x1b(0x\x1b(B\x1b[1;3HЖИВЕЕ\x1b[2;1H\x1b[32mok\x1b[0m\x1b[?25l';
  const whole = replayScreen(stream, { cols: 12, rows: 3 });
  for (const size of [1, 2, 3, 5, 7]) {
    const chunked = new Terminal({ cols: 12, rows: 3 });
    const bytes = Buffer.from(stream, 'utf8');
    for (let i = 0; i < bytes.length; i += size) chunked.write(bytes.subarray(i, i + size));
    assert.equal(chunked.text(), whole.text(), `chunk size ${size} produced a different screen`);
    assert.equal(chunked.scrolls, 0, `chunk size ${size} reported a phantom scroll`);
  }
  assert.equal(whole.row(0), '┌─ЖИВЕЕ│    ');   // 'ЖИВЕЕ' overwrote the drawn corner
  assert.equal(whole.row(1).startsWith('ok'), true);
});

test('a scrollbar stamped in the pane’s last column is chrome, not content', () => {
  const t = term(14, 4);
  const acs = (ch: string) => `\x1b(0${ch}\x1b(B`;
  t.write('\x1b[1;1H' + acs('l') + acs('q'.repeat(12)) + acs('k') + '\x1b[1;3H РАЗГОВОР');
  t.write('\x1b[2;1H' + acs('x') + '\x1b[2;2Hhi?' + '\x1b[2;14H' + acs('x'));
  t.write('\x1b[3;1H' + acs('x') + '\x1b[3;2Hlow' + '\x1b[3;13H' + acs('x') + acs('x'));
  t.write('\x1b[4;1H' + acs('m') + acs('q'.repeat(12)) + acs('j'));
  // Row 3 carries the scrollbar bone in the last interior column (the real
  // blessed artifact): it must not end up inside the extracted text.
  assert.equal(t.paneText('РАЗГОВОР'), 'hi?\nlow');
});

test('incomplete escape sequences are carried, never printed as text', () => {
  const t = term(10, 2);
  t.write('ok\x1b[');
  assert.equal(t.row(0), 'ok        ', 'a half-received CSI must not reach the grid');
  t.write('2J');
  assert.deepEqual(t.rowsText(), ['          ', '          '], 'the completed CSI must then act');
  t.write('\x1b]0;a title');
  assert.equal(t.row(0).includes('title'), false, 'an unterminated OSC must not print its payload');
  t.write('\x07done');
  assert.equal(t.row(0).includes('done'), true, 'the completion of the OSC must resume normal parsing');
  t.write('\x1b');
  assert.equal(t.row(0).includes('done'), true, 'a bare ESC at a chunk end is carried too');
});
