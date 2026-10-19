// THE GLYPH-WIDTH GUARD (src/tui/layout.ts) — the [00:32] root cause.
//
// blessed measures every emoji as ONE column (unicode.charWidth('⏳') === 1),
// but terminals draw the emoji-presentation runes two cells wide. A row holding
// one is therefore a column wider than blessed composed it: the terminal wraps
// that row, and a wrap on the BOTTOM row scrolls the whole screen — from then
// on blessed's cell model no longer matches the terminal and its diffs land in
// the wrong places (duplicated panes, ghost rows).
//
// The waiting status line ("⏳ клиентот пишува… 5s") sat on the bottom row for
// the whole send/typing wait, which is why the TUI came apart exactly while
// waiting and snapped back the moment the line went away.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'stream';
import { buildLayout, narrowGlyphs, hasWideGlyph } from '../src/tui/layout';

function makeScreen(cols = 80, rows = 24) {
  const input = new PassThrough(); (input as any).isTTY = true;
  const output = new PassThrough(); (output as any).isTTY = true;
  (output as any).columns = cols; (output as any).rows = rows;
  const chunks: string[] = [];
  output.on('data', (d: Buffer) => chunks.push(d.toString()));
  return { boxes: buildLayout('GLYPH-TEST', { input, output }), chunks };
}
const tick = (): Promise<void> => new Promise(r => setImmediate(r));

test('narrowGlyphs() removes exactly the runes terminals draw two cells wide', () => {
  assert.equal(narrowGlyphs('⏳ клиентот пишува'), '» клиентот пишува');
  assert.equal(narrowGlyphs('⚑2'), '✗2');
  assert.equal(narrowGlyphs('⌨ СОПСТВЕНИК'), ' СОПСТВЕНИК');
  assert.equal(narrowGlyphs('✅ да'), '[ok] да');
  // Emoji outside the mapping are dropped rather than rendered one column too wide.
  assert.equal(narrowGlyphs('стан 🎯 55м²'), 'стан  55м²');
  // A variation selector alone can force the wide presentation — it goes too.
  assert.equal(narrowGlyphs('стан\uFE0F'), 'стан');
  // Cyrillic, the box drawing, the narrow symbols and links are untouched.
  const keep = 'МЕТРОПОЛИС · ЛИНА ▸ [F3] ✗ — … │ ┌ ┐ 5 м² https://maps.google.com/?cid=123';
  assert.equal(narrowGlyphs(keep), keep, 'narrow text must survive untouched');
  assert.equal(hasWideGlyph(keep), false);
});

test('every box strips wide runes — the waiting status line the app renders', async () => {
  const { boxes, chunks } = makeScreen();
  // The strings src/tui/app.ts renders during a wait, verbatim.
  boxes.statusBar.setContent('{white-bg}{black-fg} ⏳ клиентот пишува… 30s — [Enter] инстант {/black-fg}{/white-bg} · antiban: 9/s бакет');
  boxes.inputBox.setLabel(' ПОРАКА ');
  boxes.inputBox.setContent('{green-fg}› {/green-fg}█');
  boxes.topBar.setContent(' MEТРОПОЛИС · Лина ');
  boxes.chatBox.setContent('{cyan-fg}[00:32] ⏳ чека порака{/cyan-fg}');
  boxes.chatBox.setContent('{cyan-fg}[00:32] клиент ⏳ чека порака{/cyan-fg}');
  boxes.screen.render();
  await tick(); await tick();

  for (const b of [boxes.statusBar, boxes.inputBox, boxes.topBar, boxes.chatBox]) {
    const content = String(b.getContent());
    assert.equal(hasWideGlyph(content), false, `box content must be width-safe, got ${JSON.stringify(content.slice(0, 40))}`);
  }
  assert.ok(String(boxes.statusBar.getContent()).includes('» клиентот пишува'),
    'the hourglass becomes the narrow marker, the text stays readable');

  // …and the same holds for what the terminal actually receives.
  const stream = chunks.join('');
  for (const ch of stream) {
    assert.equal(hasWideGlyph(ch), false, `a wide rune reached the terminal: ${JSON.stringify(ch)}`);
  }
  assert.ok(stream.includes('клиентот пишува'), 'the status text is still rendered');
});

test('the static layout labels are width-safe by construction', () => {
  const { boxes } = makeScreen();
  // blessed applies the `label` option inside the constructor, before
  // guardGlyphs() can wrap setLabel — so the layout's own labels must be safe
  // as written (they are static text in src/tui/layout.ts).
  for (const box of [boxes.leadsBox, boxes.chatBox, boxes.ownerBox, boxes.inputBox]) {
    const shown = String((box as any)._label?.getContent() ?? '');
    assert.ok(shown.length > 0, 'every pane carries a label');
    assert.equal(hasWideGlyph(shown), false, `label must be width-safe: ${JSON.stringify(shown)}`);
  }
});

test('the guard is installed on every pane, not just the one that broke', () => {
  const { boxes } = makeScreen();
  boxes.leadsBox.setContent('▸ Клиент-1 ⚑3 · closing');
  boxes.ownerBox.setLabel(' СОПСТВЕНИК — [F3] ⏳ ');
  assert.equal(hasWideGlyph(String(boxes.leadsBox.getContent())), false);
  // blessed keeps the label in a child box (`_label`), so that is what the
  // terminal ends up showing.
  assert.equal(String((boxes.ownerBox as any)._label?.getContent()), ' СОПСТВЕНИК — [F3] » ');
  assert.equal(hasWideGlyph(String((boxes.ownerBox as any)._label?.getContent())), false);
});
