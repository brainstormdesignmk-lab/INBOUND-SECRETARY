// Boot self-check — makes every dependency failure LOUD at startup.
//
// History: missing LLM keys showed as an innocent [без LLM] tag for months; a
// stale/missing POIs DB silently degraded landmarks. This module prints one
// ✅/❌ line per dependency so a zombie component is visible in the first
// second, not discovered weeks later. /status (TUI) re-runs the same checks.

import './compat/node16';

import * as fs from 'fs';
import * as crypto from 'crypto';
import { AppConfig } from './config';
import { auditRows, pinDriftSummary } from './feed/pinAudit';
import type { OfflineMapStore } from './geo/offlineMap';

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
  return cfg.geminiKeyPool.length; // the open-ended per-atom pool (GEMINI_API_KEY_1..N)
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
        // `map:pull` used to be the remedy here. It rebuilt the map from OSM ONLY
        // — no Google layer — and wrote it over whatever SKOPJE_POIS_DB names,
        // so "fixing" a missing map DESTROYED the authoritative one. The map is
        // an artifact of the maps-realestate repo now (tracked in git, verified
        // by `npm run map:verify` there); this repo never builds one.
        detail: `cannot open ${cfg.skopjePoisDb} — landmarks fall back to live OSM (slow, less accurate). The map is built and shipped by maps-realestate: point SKOPJE_POIS_DB at that checkout's data/skopje-pois.db (verify it there with \`npm run map:verify\`)` });
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

/** One raw feed row as the pin audit reads it. The public edge function emits
 *  the DB columns under their public names (`evidenten_broj`, `naselba`,
 *  `adresa`, `opis`), so the mapping lives here, once. */
function feedRowForAudit(r: Record<string, unknown>): {
  eb: number; location: string; address: string; details: string; lat?: number; lon?: number;
} {
  return {
    eb: Number(r.evidenten_broj ?? r.eb ?? 0),
    location: String(r.naselba ?? r.location ?? ''),
    address: r.adresa === undefined || r.adresa === null ? '' : String(r.adresa),
    details: r.opis === undefined || r.opis === null ? '' : String(r.opis),
    lat: typeof r.lat === 'number' ? r.lat : undefined,
    lon: typeof r.lon === 'number' ? r.lon : undefined,
  };
}

/** Feed reachability — async because it hits the network (8 s timeout).
 *
 *  With the offline map in hand it ALSO answers the pin/location question (is
 *  each row's pin in the quarter the row names?), because drift used to be
 *  invisible until a client heard «во Ново Лисиче… во близина на ТЦ Мавровка»:
 *  the report existed, but only for whoever remembered to run the script. It is
 *  a NON-critical check — a drifted pin degrades an answer, it does not stop the
 *  appliance — so it prints ❌ without aborting the boot. */
export async function checkFeed(url: string, map?: OfflineMapStore): Promise<CheckResult[]> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = await res.json() as { properties?: unknown[] };
    const rows = Array.isArray(body) ? body : (body.properties ?? []);
    const out: CheckResult[] = [
      { name: 'feed', ok: true, critical: true, detail: `${rows.length} properties from feed` },
    ];
    if (map?.available) {
      const findings = auditRows((rows as Array<Record<string, unknown>>).map(feedRowForAudit), map);
      const broken = findings.filter(f => f.contradicts);
      out.push({
        name: 'feed:pin', ok: broken.length === 0, critical: false,
        detail: pinDriftSummary(findings) + (broken.length > 0
          ? ' — repair with `npm run audit:pin-location -- --eb <n> --fix` (report first: `npm run audit:pin-location`)'
          : ''),
      });
    }
    return out;
  } catch (e) {
    return [{ name: 'feed', ok: false, critical: true,
      detail: `UNREACHABLE (${(e as Error).message}) — availability answers will refuse instead of lying. URL: ${url}` }];
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
