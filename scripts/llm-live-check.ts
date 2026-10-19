#!/usr/bin/env tsx
// LIVE LLM CHECK — proves the keys in ~/.lina/lina.env actually serve every
// TUI brain mode. This is the check that was missing when a report said
// "no LLM keys found": the keys are NOT in the repo (by design — a .env* file
// in the project crashes the Freebuff CLI's --env-file loader on Node 18), they
// live in ~/.lina/lina.env, loaded by src/config.ts.
//
//   npx tsx scripts/llm-live-check.ts            # clients + responder + real TUI
//   npx tsx scripts/llm-live-check.ts --fast     # skip the pty/TUI part
//
// Requires real keys and network. NOT part of `npm test` — a network outage
// must never fail the suite; it fails THIS check, loudly.
//
// What it asserts, in order:
//   1. config: the env file was loaded and the pool is non-empty (gemini + groq)
//   2. every Gemini key in the pool answers INDIVIDUALLY (3 keys = 3 answers)
//   3. Groq answers, and the hybrid brain answers via a labeled leaf backend
//   4. the REAL Responder escalation path, in each TUI brain mode, returns LLM
//      prose (source 'gemini:N' / 'groq') — not a deterministic/fallback line.
//      /brain free keeps the escalation brain real (knowledge-based dispatch).
//   5. the REAL TUI (under a pty, src/tui/run.ts) boots, /status reports the
//      live pool, and /brain hybrid|gemini|groq|free each switches — no
//      "нема конфигуриран клуч" anywhere.

import '../src/compat/node16';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as http from 'http';
import { loadConfig } from '../src/config';
import { createLlm } from '../src/llm/factory';
import { GroqClient } from '../src/llm/groqClient';
import { GeminiClient } from '../src/llm/geminiClient';
import { Responder } from '../src/llm/respond';
import { LlmClient } from '../src/llm/types';
import { freshSession } from '../src/fsm/session';
import { PtySession } from '../src/tui/pty';

const FAST = process.argv.includes('--fast');
const ROOT = path.resolve(__dirname, '..');
const failures: string[] = [];
/** How many Gemini keys actually served a completion in step 2 — a gemini-only
 *  mode CANNOT be judged when every key's free-tier window is spent (429). */
let liveGeminiKeys = 0;
/** Quota (429) notes — a spent free-tier window, not a missing/misconfigured LLM. */
let quotaNotes = 0;
/** True when the gemini-ONLY client (the rotating pool) answered in step 3. */
let geminiClientLive = false;
const ok = (msg: string) => console.log(`  ✅ ${msg}`);
const bad = (msg: string) => { failures.push(msg); console.log(`  ❌ ${msg}`); };

/** The TUI's /brain free client: every direct call throws. */
class NoLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('LLM-free mode'); }
}

function personaProbe(client: LlmClient, label: string): Promise<{ ok: boolean; source: string; text: string; ms: number }> {
  const t0 = Date.now();
  return client.complete({
    role: 'respond',
    messages: [
      { role: 'system', content: 'Ти си Лина, секретарка во агенција за недвижности. Одговори со една кратка македонска реченица.' },
      { role: 'user', content: 'Здраво, дали имате стан за купување во Центар?' },
    ],
    temperature: 0.4, maxTokens: 96, topP: 0.95,
    onProvider: () => { /* captured below */ },
  }).then(text => ({ ok: !!text.trim(), source: label, text, ms: Date.now() - t0 }))
    .catch(e => ({ ok: false, source: label, text: (e as Error).message, ms: Date.now() - t0 }));
}

/** Novel questions the deterministic layer has no answer for — the escalation path. */
const NOVELTY = [
  'Дали нудите попуст за студенти?',
  'Можете ли да ми препорачате добар нотар во Скопје?',
  'Што мислите за купување стан на кредит од странска банка?',
  'Како да проверам дали имотот има товар во катастар?',
];

async function checkClients(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  console.log('\n1) config');
  const cfgPath = path.join(os.homedir(), '.lina', 'lina.env');
  if (fs.existsSync(cfgPath)) ok(`env file present: ${cfgPath}`);
  else bad(`env file missing: ${cfgPath} — keys must come from process env (pm2/systemd)`);
  if (cfg.geminiKeyPool.length > 0) ok(`gemini pool: ${cfg.geminiKeyPool.length} key(s)`);
  else bad('gemini pool EMPTY (GEMINI_API_KEY / _2 / _3 / _N)');
  if (cfg.groqApiKey) ok('groq key present');
  else bad('GROQ_API_KEY missing');

  console.log('\n2) every Gemini key individually + Groq');
  let quotaBlocked = 0;
  for (let i = 0; i < cfg.geminiKeyPool.length; i++) {
    const r = await personaProbe(new GeminiClient(cfg.geminiKeyPool[i]!, cfg.geminiModel, cfg.geminiModelClassify, undefined, `gemini:${i + 1}`), `gemini:${i + 1}`);
    if (r.ok) { liveGeminiKeys++; ok(`gemini:${i + 1} answered in ${r.ms}ms`); }
    // 429 = the key is ALIVE but its free-tier window is spent. That is normal
    // pool behaviour (rotation skips it for 10 min), not a broken key — only a
    // 401/403/invalid-key answers "the LLM is not connected".
    else if (/HTTP 429/.test(r.text)) { quotaBlocked++; quotaNotes++; console.log(`  ⚠️  gemini:${i + 1} quota window spent (429) — rotation will skip it, key is valid`); }
    else bad(`gemini:${i + 1} FAILED in ${r.ms}ms: ${r.text.slice(0, 160)}`);
  }
  if (cfg.geminiKeyPool.length && quotaBlocked === cfg.geminiKeyPool.length && !cfg.groqApiKey) {
    bad('every Gemini key is quota-blocked and there is no Groq fallback — no live brain right now');
  }
  const g = await personaProbe(new GroqClient(cfg.groqApiKey, cfg.groqModel, cfg.groqModelClassify), 'groq');
  if (g.ok) ok(`groq answered in ${g.ms}ms (${cfg.groqModel})`);
  else bad(`groq FAILED in ${g.ms}ms: ${g.text.slice(0, 160)}`);

  console.log('\n3) the three TUI brain clients');
  for (const provider of ['hybrid', 'gemini', 'groq'] as const) {
    const r = await personaProbe(createLlm({ ...cfg, llmProvider: provider }), provider);
    if (r.ok) {
      if (provider === 'gemini') geminiClientLive = true;
      ok(`${provider} client answered in ${r.ms}ms`);
    }
    else if (/HTTP 429/.test(r.text)) { quotaNotes++; console.log(`  ⚠️  ${provider} client: quota windows spent (429) — no live key for this mode right now`); }
    else bad(`${provider} client FAILED in ${r.ms}ms: ${r.text.slice(0, 160)}`);
  }
}

/** The TUI's real serving path: Responder, per brain mode, on a novelty the bank cannot answer. */
async function checkResponderModes(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  console.log('\n4) Responder escalation in each brain mode');
  // Mirrors TuiApp's constructor + /brain handling EXACTLY: the boot brain is
  // hybrid, free swaps the serving brain to NoLlm but KEEPS hybrid as the
  // escalation brain (knowledge-based dispatch), and every other mode pins its
  // own client as the escalation brain.
  const boot = createLlm(cfg);
  const geminiBrain = createLlm({ ...cfg, llmProvider: 'gemini' });
  const groqBrain = createLlm({ ...cfg, llmProvider: 'groq' });
  const modes: { mode: string; llm: LlmClient; escalation: LlmClient; expect: (src: string) => boolean; why: string }[] = [
    { mode: 'hybrid', llm: boot, escalation: boot, expect: s => /^gemini:\d+$/.test(s) || s === 'groq', why: 'gemini:N or groq' },
    { mode: 'gemini', llm: geminiBrain, escalation: geminiBrain, expect: s => /^gemini:\d+$/.test(s), why: 'gemini:N' },
    { mode: 'groq', llm: groqBrain, escalation: groqBrain, expect: s => s === 'groq', why: 'groq' },
    { mode: 'free', llm: new NoLlm(), escalation: boot, expect: s => /^gemini:\d+$/.test(s) || s === 'groq', why: 'real escalation brain (gemini:N/groq)' },
  ];
  for (const m of modes) {
    const responder = new Responder(m.llm, cfg);
    responder.setEscalationLlm(m.escalation);
    let result: { text: string; source: string; escalated?: boolean } | null = null;
    let last: { text: string; source: string; escalated?: boolean } | null = null;
    for (const q of NOVELTY) {
      const s = freshSession('viber', `live-${m.mode}`);
      s.state = 'presentation';
      s.slots.service = 'buy';
      const r = await responder.respond(s, [], q);
      last = r;
      if (r.escalated) { result = r; break; }
    }
    // NO key of the pool is live right now (all 429): the mode is untestable,
    // not broken. Never turn a spent free-tier window into "the LLM is gone".
    if (m.mode === 'gemini' && (!geminiClientLive || liveGeminiKeys === 0)) {
      quotaNotes++;
      console.log(`  ⚠️  gemini: skipped — the pool's quota windows are spent (429); no live key to serve this mode`);
      continue;
    }
    if (!result) {
      // respond() catches every backend failure and returns source 'fallback'
      // WITHOUT escalated=true — so a fallback here means "reached the LLM, all
      // backends failed", never "deterministic answered".
      if (last && last.source === 'fallback') {
        bad(`${m.mode}: the escalation path was reached but every backend failed — served the fallback line`);
      } else {
        bad(`${m.mode}: no novelty question reached the escalation path (the deterministic layer swallowed all ${NOVELTY.length})`);
      }
      continue;
    }
    if (m.expect(result.source)) ok(`${m.mode}: escalated reply from ${result.source} (${m.why})`);
    else bad(`${m.mode}: escalated reply came from ${result.source}, expected ${m.why} — "${result.text.slice(0, 120)}"`);
  }
}

/** The shipped TUI on a real pty: does it FIND the keys and switch every mode? */
async function checkTui(cfg: ReturnType<typeof loadConfig>): Promise<void> {
  console.log('\n5) the real TUI under a pty');
  const feed = path.join(ROOT, 'tests', 'fixtures', 'pty-feed.json');
  const body = fs.readFileSync(feed, 'utf8');
  const server = http.createServer((_q, r) => { r.writeHead(200, { 'content-type': 'application/json' }); r.end(body); });
  await new Promise<void>(res => server.listen(0, '127.0.0.1', res));
  const port = (server.address() as { port: number }).port;
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-live-'));
  fs.mkdirSync(path.join(workDir, 'data'), { recursive: true });

  const tsx = path.join(ROOT, 'node_modules', '.bin', 'tsx');
  const app = path.join(ROOT, 'src', 'tui', 'run.ts');
  const s = PtySession.start({
    command: `${tsx} ${app} 2>${path.join(workDir, 'stderr.log')}`,
    cwd: workDir, cols: 110, rows: 44,
    env: {
      ...process.env,
      // REAL keys: config.ts loads ~/.lina/lina.env no matter the cwd. Never
      // overwrite them here — that is exactly how a "missing keys" report is born.
      CLIENT_TYPING_DELAY_MS: '0', OWNER_TYPING_DELAY_MS: '0',
      MIN_DELAY_MS: '1', MAX_DELAY_MS: '2',
      TUI_LEARN: '0', GOOGLE_MAPS_ENABLED: 'false', OSM_ENABLED: 'false',
      PROPERTY_DATA_URL: `http://127.0.0.1:${port}/properties`,
    },
  });

  const pane = () => (s.terminal.paneText('РАЗГОВОР') ?? '').replace(/\s+/g, ' ');
  const waitReply = async (before: number): Promise<boolean> => {
    for (let i = 0; i < 200; i++) {
      await new Promise(r => setTimeout(r, 100));
      if ((pane().match(/ЛИНА/g) ?? []).length > before) { await s.waitQuiet(500); return true; }
    }
    return false;
  };
  const say = async (line: string): Promise<void> => {
    const before = (pane().match(/ЛИНА/g) ?? []).length;
    await s.typeLine(line);
    await waitReply(before);
  };

  try {
    await s.waitForPaneText('ПОРАКА', '›', { timeoutMs: 60_000, label: 'the TUI boot frame' });
    await s.key(' ');
    await s.typeLine('Live-Check');
    await say('/status');
    const status = pane();
    if (/config: .*lina\.env \(loaded\)/.test(status)) ok('/status: ~/.lina/lina.env loaded');
    else bad(`/status does not report the loaded env file: ${status.slice(-200)}`);
    const m = status.match(/llm: ([^—[]+)/);
    if (m && /gemini=\d+ key/.test(m[1]!) && /groq=yes/.test(m[1]!)) ok(`/status: ${m[1]!.trim()}`);
    else bad(`/status LLM line missing/blank: ${status.slice(-200)}`);

    for (const mode of ['gemini', 'groq', 'hybrid', 'free'] as const) {
      await say(`/brain ${mode}`);
      const p = pane();
      if (p.includes(`мозок: ${mode} (`) || p.includes(`мозок: ${mode} ·`)) ok(`/brain ${mode}: switched`);
      else bad(`/brain ${mode}: not switched — ${p.slice(-180)}`);
      if (p.includes('нема конфигуриран клуч')) bad(`/brain ${mode}: the TUI says NO KEY CONFIGURED`);
    }

    // A live LLM turn through the TUI itself: put the session past discovery so
    // a novelty question reaches the responder, then read the source tag.
    await say('/brain hybrid');
    await say('Здраво, сакам да купам стан во Центар со две спални, буџет 90000 евра.');
    await say('Можете ли да ми препорачате добар нотар во Скопје?');
    await s.waitQuiet(1500);
    const tail = pane().slice(-600);
    if (/ЛИНА \[(gemini:\d+|groq)\]/.test(tail)) ok('a live LLM-tagged reply reached the TUI chat pane');
    else console.log(`  note: no LLM-tagged reply in the last turn (deterministic served) — last: ${tail.slice(-200)}`);
  } catch (e) {
    bad(`TUI pty: ${(e as Error).message.split('\n')[0]}`);
  } finally {
    const code = await s.close();
    if (code !== 0) bad(`TUI did not exit cleanly (code ${code})`);
    server.close();
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`[llm-live] provider=${cfg.llmProvider} geminiPool=${cfg.geminiKeyPool.length} groq=${cfg.groqApiKey ? 'yes' : 'NO'}`);
  console.log(`[llm-live] models: groq=${cfg.groqModel} · gemini=${cfg.geminiModel}`);
  await checkClients(cfg);
  await checkResponderModes(cfg);
  if (!FAST) await checkTui(cfg);
  console.log('');
  if (failures.length) {
    console.error(`[llm-live] ✗ ${failures.length} failure(s):`);
    for (const f of failures) console.error(`  - ${f}`);
    process.exit(1);
  }
  console.log(quotaNotes === 0
    ? '[llm-live] ✓ every live brain answered (keys in ~/.lina/lina.env)'
    : `[llm-live] ✓ live backends answered; ${quotaNotes} quota window(s) spent (429) — valid keys, rotation skips them until reset`);
  process.exit(0);
}

main().catch(e => { console.error('[llm-live] fatal:', e); process.exit(1); });
