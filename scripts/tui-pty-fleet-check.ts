#!/usr/bin/env tsx
// Real-PTY contract for bank:tui: canonical review master, visible fleet
// selection and stable ENRICHMENT/DYNAMIC tabs after entering/leaving selector.
import '../src/compat/node16';
import { PtySession } from '../src/tui/pty';
import * as path from 'path';

async function main(): Promise<void> {
  const root = path.resolve(__dirname, '..');
  const pty = PtySession.start({
    command: 'npx tsx src/bank/run.ts', cwd: root,
    env: process.env, cols: 120, rows: 40,
  });
  try {
    await pty.waitForScreen(t => t.text().includes('MASTER data/tui.db'), { timeoutMs: 20_000, label: 'master bank screen' });
    if (!pty.screen().includes('ENRICHMENT') || !pty.screen().includes('DYNAMIC')) throw new Error('master screen omitted ENRICHMENT/DYNAMIC');
    await pty.key('m');
    await pty.waitForScreen(t => t.text().includes('SOURCE SELECTOR'), { timeoutMs: 5_000, label: 'fleet source selector' });
    const selector = pty.screen();
    for (const label of ['WORKSTATION1 LINA (TUI)', 'ATOM01 LINA', 'ATOM02 LINA', 'ATOM03 LINA']) {
      if (!selector.includes(label)) throw new Error(`selector omitted ${label}\n${pty.dump()}`);
    }
    if (!selector.includes('pending approval:')) throw new Error(`selector omitted pending counts\n${pty.dump()}`);
    if (!selector.includes('E=export lina.db')) throw new Error(`selector omitted safe appliance export action\n${pty.dump()}`);
    await pty.key('\x1b');
    await pty.waitForScreen(t => t.text().includes('MASTER data/tui.db'), { timeoutMs: 5_000, label: 'return to master' });
    await pty.key('2');
    await pty.waitForScreen(t => t.text().includes('DYNAMIC ('), { timeoutMs: 5_000, label: 'dynamic tab visible' });
    console.log('bank-fleet pty-check: selector, pending counts, master return, ENRICHMENT/DYNAMIC verified');
  } finally {
    await pty.close();
  }
}

main().catch(error => { console.error(error); process.exitCode = 1; });
