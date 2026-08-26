// Boot self-check — makes every dependency failure LOUD at startup.
//
// History: missing LLM keys showed as an innocent [без LLM] tag for months; a
// stale/missing POIs DB silently degraded landmarks. This module prints one
// ✅/❌ line per dependency so a zombie component is visible in the first
// second, not discovered weeks later. /status (TUI) re-runs the same checks.

import * as fs from 'fs';
import * as crypto from 'crypto';
import { AppConfig } from './config';

/** Short content hash of a file — printed at boot so map-DB drift between
 *  machines ("production has the old POIs db") is visible instantly. */
export function fileChecksum(path: string, len = 8): string {
  try {
    const h = crypto.createHash('sha256').update(fs.readFileSync(path)).digest('hex');
    return h.slice(0, len);
  } catch {
    return 'unavailable';
  }
}

export interface CheckResult {
  name: string;
  ok: boolean;
  detail: string;
  /** Critical failures mean the system will misbehave, not just degrade. */
  critical: boolean;
}

function geminiKeyCount(cfg: AppConfig): number {
  return [cfg.geminiApiKey, cfg.geminiApiKey2, cfg.geminiApiKey3].filter(Boolean).length;
}

export function bootChecks(cfg: AppConfig): CheckResult[] {
  const out: CheckResult[] = [];

  // 0) Config source — WHERE the secrets came from must be explicit, not
  //    silent (config.ts loads exactly one file: ~/.lina/lina.env).
  const cfgPath = `${process.env.HOME ?? '~'}/.lina/lina.env`;
  const cfgExists = fs.existsSync(cfgPath);
  out.push({ name: 'config', ok: true, critical: false,
    detail: cfgExists
      ? `${cfgPath} (loaded)`
      : `${cfgPath} NOT FOUND — keys must come from real process env (pm2/systemd)` });

  // 1) LLM brains
  const gk = geminiKeyCount(cfg);
  const hasGroq = !!cfg.groqApiKey;
  if (gk > 0 || hasGroq) {
    const parts = [`gemini=${gk} key${gk === 1 ? '' : 's'}`, `groq=${hasGroq ? 'yes' : 'no'}`];
    if (gk === 0) {
      out.push({ name: 'llm', ok: true, critical: false,
        detail: `${parts.join(', ')} — ⚠ hybrid will run Groq-ONLY (add GEMINI_API_KEY* for full quota pool)` });
    } else {
      out.push({ name: 'llm', ok: true, critical: false, detail: parts.join(', ') });
    }
  } else {
    out.push({ name: 'llm', ok: false, critical: true,
      detail: 'NO KEYS — every reply will be deterministic [без LLM]. Set GEMINI_API_KEY / GROQ_API_KEY.' });
  }

  // 2) Offline map
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { OfflineMapStore } = require('./geo/offlineMap') as typeof import('./geo/offlineMap');
    const map = new OfflineMapStore(cfg.skopjePoisDb);
    if (map.available) {
      const s = map.stats();
      const sum = fileChecksum(cfg.skopjePoisDb);
      out.push({ name: 'map', ok: true, critical: false,
        detail: `${s?.pois ?? 0} POIs / ${s?.addresses ?? 0} addresses [db:${sum}] (${cfg.skopjePoisDb})` });
    } else {
      out.push({ name: 'map', ok: false, critical: true,
        detail: `cannot open ${cfg.skopjePoisDb} — landmarks fall back to live OSM (slow, less accurate). Run: npm run map:pull` });
    }
  } catch (e) {
    out.push({ name: 'map', ok: false, critical: true, detail: `error opening map db: ${(e as Error).message}` });
  }

  // 3) Data dir writable (tui.db lives here — sessions, visits, counters)
  try {
    fs.mkdirSync('data', { recursive: true });
    fs.accessSync('data', fs.constants.W_OK);
    out.push({ name: 'data', ok: true, critical: false, detail: 'data/ writable' });
  } catch {
    out.push({ name: 'data', ok: false, critical: true, detail: 'data/ NOT writable — sessions and visits will fail to persist' });
  }

  return out; // feed check is async → see checkFeed()
}

/** Feed reachability — async because it hits the network (8 s timeout). */
export async function checkFeed(url: string): Promise<CheckResult> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json() as { properties?: unknown[] };
    const rows = Array.isArray(body) ? body : (body.properties ?? []);
    return { name: 'feed', ok: true, critical: true, detail: `${rows.length} properties from feed` };
  } catch (e) {
    return { name: 'feed', ok: false, critical: true,
      detail: `UNREACHABLE (${(e as Error).message}) — availability answers will refuse instead of lying. URL: ${url}` };
  } finally {
    clearTimeout(timer);
  }
}

/** Print all checks as ✅/❌ lines. Returns true if no critical failure. */
export function printChecks(checks: CheckResult[]): boolean {
  let allCriticalOk = true;
  for (const c of checks) {
    if (!c.ok && c.critical) allCriticalOk = false;
    const icon = c.ok ? '✅' : '❌';
    console.log(`[boot-check] ${icon} ${c.name}: ${c.detail}`);
  }
  return allCriticalOk;
}
