// THE REAL-TERMINAL FUNNEL, as a test.
//
// scripts/tui-pty-funnel.ts spawns the SHIPPED entry point (src/tui/run.ts) under
// a real pty via `script(1)`, drives the rent funnel with keystrokes, replays the
// output through the shared terminal emulator and asserts on the screen. This
// test runs exactly that — the same code path the CLI use, no second
// implementation that could drift.
//
// WHY IT BELONGS IN THE SUITE: the headless frame check proves the LAYOUT, and
// the in-process tests prove the FUNNEL LOGIC — but neither touches blessed's
// real startup, the kernel's raw-mode switch, the real winsize, the app's key
// routing, or the ticker writing into a live tty. The field reports
// ("letters vanish while typing", "the frame shifts after a longer chat") live
// exactly in that gap.
//
// It needs no network and no LLM key: the property feed is a local fixture
// server (tests/fixtures/pty-feed.json) and the session switches to the
// LLM-free brain, so every copy it asserts is the DETERMINISTIC path — the
// same one the bank/enrichment work is measured on.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPtyFunnel } from '../scripts/tui-pty-funnel';

// The funnel boots a real TUI, runs seven turns and quits: ~25-40 s on a warm
// box. The test hook is generous because a slow/busy machine must not turn a
// sound check into a flaky one.
test('pty: the real TUI renders the rent funnel end to end', { timeout: 180_000 }, async () => {
  const report = await runPtyFunnel({ cols: 100, rows: 40 });
  assert.deepEqual(report.failures, [], `pty funnel failures\n--- screen ---\n${report.screen}`);
  // The chat pane must have carried the exchange (a failure here means the pane
  // read returned nothing, i.e. the emulator lost the frame, not the funnel).
  assert.ok((report.panes['РАЗГОВОР'] ?? '').length > 0, 'the chat pane came back empty');
});

// A SECOND size matters: blessed lays out differently at 80 columns (the panes
// share the row differently and long copy wraps sooner), and a wrap bug that
// hides at 100×40 can still corrupt the operator's default terminal.
test('pty: the funnel also renders at 80x24 (the classic terminal size)', { timeout: 180_000 }, async () => {
  const report = await runPtyFunnel({ cols: 80, rows: 24 });
  assert.deepEqual(report.failures, [], `pty funnel failures at 80x24\n--- screen ---\n${report.screen}`);
});
