#!/usr/bin/env tsx
// pty-check — drive the REAL TUI under a REAL pty and verify the rendered screen.
//
//   npx tsx scripts/tui-pty-check.ts              # exits 1 on any failure
//   npx tsx scripts/tui-pty-check.ts --screen     # also dump the final screen
//   PTY_COLS / PTY_ROWS                           # terminal size (default 100x40)
//   PTY_DUMP=path                                 # write the byte-exact pty output
//                                                 # (replay a session offline through
//                                                 #  src/tui/terminal.ts)
//
// This is the layer the headless frame check cannot reach: blessed's real
// startup, termios raw mode, the real winsize, the app's key routing, the
// ticker and the typing waits writing into a live tty. The funnel it drives
// (rent fee ladder + rent commission ladder, offline fixture feed) is shared
// with tests/tui-pty-funnel.test.ts, so the CLI and CI assert the same thing.

import '../src/compat/node16';
import { runPtyFunnel } from './tui-pty-funnel';

const showScreen = process.argv.includes('--screen');
const cols = parseInt(process.env.PTY_COLS ?? '100', 10);
const rows = parseInt(process.env.PTY_ROWS ?? '40', 10);

runPtyFunnel({ cols, rows, rawDumpPath: process.env.PTY_DUMP })
  .then(report => {
    console.log(`pty-check ${cols}x${rows}: ${report.failures.length === 0 ? '✓ the real terminal rendered the funnel' : '✗ failures'}`);
    for (const n of report.notes) console.log(`  note: ${n}`);
    if (showScreen) {
      console.log('--- final screen ---');
      console.log(report.screen.split('\n').map((r, i) => String(i).padStart(2, ' ') + '│' + r.replace(/\s+$/, '')).join('\n'));
    }
    if (report.failures.length) {
      console.error('PTY RENDER FAILURES:');
      for (const f of report.failures) console.error('  ✗ ' + f);
      if (!showScreen) {
        console.error('--- final screen ---');
        console.error(report.screen.split('\n').map((r, i) => String(i).padStart(2, ' ') + '│' + r.replace(/\s+$/, '')).join('\n'));
      }
      process.exit(1);
    }
    process.exit(0);
  })
  .catch(e => {
    console.error('[pty-check] fatal:', e);
    process.exit(1);
  });
