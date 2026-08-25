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
  app.start();
}

main().catch(e => {
  console.error('[tui] fatal:', e);
  process.exit(1);
});
