import '../compat/node16';

import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../config';
import { bootChecks, checkFeed, printChecks } from '../boot_check';
import { TuiApp } from './app';

// The LLM clients log every backend failure via console.error — Gemini 429
// bodies are multi-line JSON dumps. On the blessed screen those raw bytes land
// at the cursor (the input box) and corrupt the rendering — the "letters
// vanish in chat mode" bug. All console output goes to a log file instead.
function redirectConsole(): void {
  const logPath = path.join(process.cwd(), 'data', 'tui.log');
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const log = fs.createWriteStream(logPath, { flags: 'a' });
  const tee = (tag: string) => (...args: unknown[]) => {
    log.write(`[${new Date().toISOString()}] ${tag} ` +
      args.map(a => (typeof a === 'string' ? a : JSON.stringify(a))).join(' ') + '\n');
  };
  console.log = tee('log');
  console.warn = tee('warn');
  console.error = tee('error');
  console.log('[tui] starting… (console redirected to data/tui.log)');
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  if (!cfg.groqApiKey && !cfg.geminiApiKey) {
    console.error('[tui] no LLM key in .env (GROQ_API_KEY / GEMINI_API_KEY) — the TUI needs a real brain.');
    process.exit(2);
  }
  redirectConsole();
  // Boot self-check — every dependency failure must be LOUD here, not
  // discovered weeks later as a silent [без LLM] / wrong-landmark symptom.
  const checks = [...bootChecks(cfg), await checkFeed(cfg.propertyDataUrl)];
  printChecks(checks);
  if (!checks.find(c => c.name === 'llm')?.ok) {
    console.error('[tui] no LLM key in .env (GROQ_API_KEY / GEMINI_API_KEY) — the TUI needs a real brain.');
    process.exit(2);
  }
  const app = new TuiApp(cfg);
  // Field diagnostics: TUI_RAW_LOG=1 tees every byte blessed emits to
  // data/tui-raw.log — the exact stream the broker mangles — for offline
  // replay through scripts/tui-frame-check.ts's terminal emulator.
  if (process.env.TUI_RAW_LOG) {
    const raw = fs.createWriteStream(path.join(process.cwd(), 'data', 'tui-raw.log'), { flags: 'a' });
    const out: any = (app as any).box.screen.program.output;
    const origWrite = out.write.bind(out);
    out.write = (data: any, cb?: any) => {
      raw.write(typeof data === 'string' ? data : Buffer.from(data));
      return origWrite(data, cb);
    };
    raw.write(`\n=== session ${new Date().toISOString()} cols=${out.columns} rows=${out.rows} ===\n`);
  }
  app.start();
}

main().catch(e => {
  console.error('[tui] fatal:', e);
  process.exit(1);
});
