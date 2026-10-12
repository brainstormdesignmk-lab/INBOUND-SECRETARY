// THE [22:46] LINK-TRUNCATION REGRESSION — the TUI chat pane must never split
// a URL across two rendered lines.
//
// The capture: a where-is reply carried
// `https://maps.google.com/?cid=3966389678066766238` (48 chars). At a ~74-col
// terminal the chat pane was the right 67% (49 wide, 47 usable after borders +
// scrollbar), blessed wrapped at ANY character, so the URL broke after its
// 47th character and the last digit landed on the next visual line:
//
//   |https://maps.google.com/?cid=396638967806676623|
//   |8                                               |
//
// Opening/copying the link takes the first visual line only → an 18-digit cid →
// Google answers with an empty, zoomed-out map and no marker (reproduced: that
// URL renders "Најдете место" with no place and no pin). The fix has two parts,
// both pinned here:
//   1. the pane split is 25/75 (was 33/67), so a 48-char link fits from ~68
//      columns up instead of ~78;
//   2. the message is PRE-WRAPPED with wrapMarked(), which never splits a
//      whitespace token — a link that does not fit moves WHOLE to the next
//      line instead of being cut mid-string.
//
// These tests drive the REAL buildLayout() headlessly (same approach as
// scripts/tui-frame-check.ts), so they measure what the terminal actually
// renders, not what the wrapper intended.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'stream';
import { buildLayout, wrapMarked, visibleWidth, paneTextWidth, CHAT_PANE_FRACTION, LEADS_PANE_FRACTION } from '../src/tui/layout';

/** The exact link from the capture, and the failure's width (≈74 cols). */
const CID_URL = 'https://maps.google.com/?cid=3966389678066766238';
const CAPTURE_COLS = 74;
const REPLY = `[22:46] ЛИНА [без LLM]: Тоа се наоѓа во близина на Трговски Центар Буњаковец.\n${CID_URL}`;

/** Render a chat message exactly as renderChat() does, and read the lines back. */
async function renderPane(cols: number, text: string, tagged = false): Promise<string[]> {
  const input = new PassThrough(); (input as any).isTTY = true;
  const output = new PassThrough(); (output as any).isTTY = true;
  (output as any).columns = cols; (output as any).rows = 40;
  const boxes = buildLayout('WRAP-TEST', { input, output });
  const chat: any = boxes.chatBox;
  chat.width = Math.floor(cols * CHAT_PANE_FRACTION);
  const body = tagged ? text.replace(CID_URL, `{white-fg}${CID_URL}{/white-fg}`) : text;
  chat.setContent(wrapMarked(body, paneTextWidth(cols, CHAT_PANE_FRACTION)));
  await new Promise(r => setImmediate(r));
  return chat.getScreenLines().map((l: string) => l.replace(/\s+$/, ''));
}

/** The PRE-FIX renderer: the 33/67 split and blessed's own character-level
 *  wrap, with no pre-wrapping. Used only as the control below. */
async function renderPaneRaw(cols: number, text: string): Promise<string[]> {
  const input = new PassThrough(); (input as any).isTTY = true;
  const output = new PassThrough(); (output as any).isTTY = true;
  (output as any).columns = cols; (output as any).rows = 40;
  const boxes = buildLayout('WRAP-TEST-RAW', { input, output });
  const chat: any = boxes.chatBox;
  chat.width = Math.floor(cols * 0.67); // the old split
  chat.setContent(text);                 // no wrapMarked — blessed wraps where it likes
  await new Promise(r => setImmediate(r));
  return chat.getScreenLines().map((l: string) => l.replace(/\s+$/, ''));
}

// ── Control: the bug is reproducible, so the tests above are not vacuous ─────

test('control: WITHOUT the fix the same reply splits at 74 cols and the last digit falls through', async () => {
  const lines = await renderPaneRaw(CAPTURE_COLS, REPLY);
  assert.equal(lines.some(l => l.includes(CID_URL)), false,
    'the control must show the pre-fix split — otherwise this suite proves nothing');
  // The cut lands at the pane edge, so the remainder is the last digit (or two)
  // of the cid — exactly what the capture showed on its own line.
  const tail = lines.find(l => /^\d{1,3}$/.test(l.trim()));
  assert.equal(tail !== undefined, true,
    `the link's tail must land on its own line (the capture): ${lines.map(l => `|${l}|`).join(' ')}`);
});

// ── The pane must be wide enough at the capture's width ──────────────────────

test('[22:46] the 25/75 split fits a 48-char cid link at 74 cols — the old 33/67 split did not', () => {
  // Documented arithmetic: usable ≈ floor(cols × fraction) − 3 (borders + scrollbar).
  assert.equal(paneTextWidth(CAPTURE_COLS, 0.67) < CID_URL.length, true,
    `the OLD split could not fit the link (${paneTextWidth(CAPTURE_COLS, 0.67)} usable) — hence the wrap`);
  assert.equal(paneTextWidth(CAPTURE_COLS, CHAT_PANE_FRACTION) >= CID_URL.length, true,
    `the NEW split must fit it (${paneTextWidth(CAPTURE_COLS, CHAT_PANE_FRACTION)} usable)`);
  assert.equal(LEADS_PANE_FRACTION + CHAT_PANE_FRACTION, 1, 'the split must partition the terminal');
});

test('[22:46] the cid link renders INTACT on one line at the capture width (real blessed pane)', async () => {
  const lines = await renderPane(CAPTURE_COLS, REPLY);
  assert.equal(lines.some(l => l.includes(CID_URL)), true,
    `the URL was split by the pane again:\n${lines.filter(l => l.includes('https')).map(l => `  |${l}|`).join('\n')}`);
  // The digit that used to fall through must be on the same line as the rest.
  const urlLine = lines.find(l => l.includes('https://'))!;
  assert.equal(urlLine.trimEnd().endsWith(CID_URL), true, `line must END with the whole link: |${urlLine}|`);
});

test('[22:46] the link keeps working with blessed tags around it (width counts VISIBLE chars)', async () => {
  // renderChat() emits `[hh:mm] {white-fg}ЛИНА{/white-fg}…{esc(text)}` — tags
  // render to nothing, so measuring raw characters would wrap too early.
  const lines = await renderPane(CAPTURE_COLS, REPLY, true);
  assert.equal(lines.some(l => l.includes(CID_URL)), true,
    `the URL split despite fitting: ${lines.filter(l => l.includes('https')).map(l => `|${l}|`).join(' ')}`);
});

test('the link is intact on one line at every common terminal width ≥ 68', async () => {
  for (const cols of [68, 72, 74, 76, 80, 100, 120]) {
    const lines = await renderPane(cols, REPLY);
    assert.equal(lines.some(l => l.includes(CID_URL)), true, `${cols} cols split the link`);
  }
});

// ── The wrapper itself ───────────────────────────────────────────────────────

test('wrapMarked never splits a token — a link that does not fit moves whole to the next line', () => {
  const text = `Тоа се наоѓа во близина на Трговски Центар Буњаковец. ${CID_URL}`;
  // A pane wide enough for the link but not for link + text on one line.
  const out = wrapMarked(text, 60).split('\n');
  // Every line fits, and the URL is untouched on its own line.
  for (const l of out) assert.equal(visibleWidth(l) <= 60, true, `overflowing line: |${l}|`);
  assert.equal(out.includes(CID_URL), true, `the link must move whole, got:\n${out.map(l => `  |${l}|`).join('\n')}`);
  assert.equal(out.join(' ').replace(/\s+/g, ' ').trim(), text.replace(/\s+/g, ' ').trim(),
    'wrapping must not lose or duplicate any text');
});

test('wrapMarked leaves a token longer than the pane on its OWN line (nothing else glued to it)', () => {
  const text = `пред ${CID_URL} потоа`;
  const out = wrapMarked(text, 20).split('\n');
  const urlIdx = out.findIndex(l => l.includes('https://'));
  assert.equal(urlIdx >= 0, true, `the link must be present: ${out.join(' | ')}`);
  assert.equal(/пред/.test(out[urlIdx]!), false,
    `the over-long token must not share its line with preceding text: |${out[urlIdx]}|`);
  assert.equal(/потоа/.test(out[urlIdx]!), false,
    `nothing may be glued after a too-long token: |${out[urlIdx]}|`);
});

test('visibleWidth ignores blessed tags and counts the {open}/{close} escapes as one brace', () => {
  assert.equal(visibleWidth('{white-fg}abc{/white-fg}'), 3);
  assert.equal(visibleWidth('{open}{close}'), 2);
  assert.equal(visibleWidth('plain'), 5);
  assert.equal(visibleWidth('https://maps.google.com/?cid=3966389678066766238'), CID_URL.length);
});

test('wrapMarked is a no-op for a pane too narrow to wrap sensibly, and preserves blank lines', () => {
  assert.equal(wrapMarked('abc def', 3), 'abc def', 'below the minimum width the text is left alone');
  assert.equal(wrapMarked('a\n\nb', 40), 'a\n\nb', 'blank lines survive');
  assert.equal(wrapMarked('', 40), '');
});
