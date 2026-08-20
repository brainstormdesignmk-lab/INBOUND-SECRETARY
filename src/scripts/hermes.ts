// Hermes — syncs owner-dictated price changes to the public app.
//
// Lina records every owner price correction in the local `price_changes` table
// (status = 'pending'). This script applies each pending change to the private
// Supabase edge function Lovable builds (`update-property-price` — see
// supabase/functions/update-property-price/), then reports back so Lina marks
// it resolved.
//
// TWO MODES (env-driven):
//   local  — no LINA_API_URL: reads/writes Lina's data/lina.db directly.
//   remote — LINA_API_URL + HERMES_TOKEN set (Hermes on its own machine):
//            pulls pending changes from /hermes/v1/work, applies via the same
//            Supabase function, reports ok/fail to /hermes/v1/prices/:id/result.
//
// Rules:
//  - 2xx from the function → resolved. 5xx → retry with backoff, leave pending.
//    4xx → config/auth problem: log loudly, leave pending, exit 1.
//  - The public feed is fetched best-effort to log the CURRENT published price
//    next to the change — a sanity check, never a blocker.
//
// Usage:
//   npm run hermes            # one pass over pending rows
//   npm run hermes -- --dry-run   # report only, no network writes
//
// Cron-friendly: exit 0 = all pending synced, 1 = something needs attention.

import { loadConfig } from '../config';
import { Db } from '../store/db';
import { PriceChangeStore } from '../store/priceChanges';
import { pullWork, reportPriceResult, PriceChangeWork } from '../hermes/client';

interface SyncResult {
  resolved: number;
  failed: number;
  skipped: number;
}

function log(...args: unknown[]): void {
  console.log(`[hermes ${new Date().toISOString()}]`, ...args);
}

async function currentPublishedPrice(url: string, eb: number): Promise<number | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 10_000);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const body = (await res.json()) as { properties?: Record<string, unknown>[] };
    const rows = Array.isArray(body) ? body : (body.properties ?? []);
    const row = rows.find(r => String(r.evidenten_broj) === String(eb));
    const v = row?.cena_eur;
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  } catch (e) {
    log(`[verify] feed check skipped for EB ${eb}: ${(e as Error).message}`);
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

/** POST one change to the edge function. Returns true on 2xx (applied). */
async function pushChange(cfg: {
  writeUrl: string; token: string; authHeader: string;
}, eb: number, newPrice: number): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(cfg.writeUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      [cfg.authHeader]: cfg.token,
    },
    body: JSON.stringify({ property_number: String(eb), price: newPrice }),
  });
  return { ok: res.ok, status: res.status };
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const dryRun = process.argv.includes('--dry-run');
  const remote = !!(cfg.linaApiUrl && cfg.hermesToken);

  let db: Db | null = null;
  let store: PriceChangeStore | null = null;
  let pending: PriceChangeWork[] = [];

  if (remote) {
    log(`REMOTE mode → ${cfg.linaApiUrl}`);
    if (!dryRun) {
      pending = (await pullWork(cfg.linaApiUrl, cfg.hermesToken)).price_changes;
    }
  } else {
    log('LOCAL mode (reads Lina DB directly)');
    db = new Db(cfg.dbPath);
    store = new PriceChangeStore(db);
    pending = store.listPending().map(r => ({ id: r.id, eb: r.eb, old_price: r.oldPrice, new_price: r.newPrice }));
  }

  if (pending.length === 0) {
    log('no pending price changes — nothing to sync.');
    db?.close();
    return;
  }

  const configured = !!(cfg.hermesWriteUrl && cfg.hermesToken);
  if (!configured) {
    log('HERMES_WRITE_URL / HERMES_TOKEN not set — REPORT MODE (nothing sent, nothing resolved).');
  } else if (dryRun) {
    log('--dry-run: reporting what WOULD be sent, nothing sent, nothing resolved.');
  }

  const out: SyncResult = { resolved: 0, failed: 0, skipped: 0 };
  for (const row of pending) {
    const published = await currentPublishedPrice(cfg.propertyDataUrl, row.eb);
    const oldLabel = published !== undefined ? String(published) : (row.old_price ?? '?');
    log(`EB ${row.eb}: ${oldLabel} → ${row.new_price}`);

    if (!configured || dryRun) {
      out.skipped++;
      continue;
    }

    // 5xx → retry a few times with backoff; 4xx and 2xx are final.
    let applied = false;
    let lastStatus = 0;
    for (let attempt = 1; attempt <= 3 && !applied; attempt++) {
      if (attempt > 1) await new Promise(r => setTimeout(r, attempt * 2000));
      try {
        const r = await pushChange({
          writeUrl: cfg.hermesWriteUrl, token: cfg.hermesToken, authHeader: cfg.hermesAuthHeader,
        }, row.eb, row.new_price);
        lastStatus = r.status;
        if (r.ok) {
          applied = true;
        } else if (r.status >= 400 && r.status < 500) {
          break; // auth/validation problem — retrying won't help
        }
      } catch (e) {
        log(`  attempt ${attempt} failed: ${(e as Error).message}`);
      }
    }

    if (applied) {
      if (remote) {
        await reportPriceResult(cfg.linaApiUrl, cfg.hermesToken, row.id, true);
        log(`  ✅ applied (HTTP 2xx) — reported resolved to Lina.`);
      } else {
        store?.resolve(row.id);
        log(`  ✅ applied (HTTP 2xx) — price_changes #${row.id} resolved.`);
      }
      out.resolved++;
    } else {
      if (remote) {
        await reportPriceResult(cfg.linaApiUrl, cfg.hermesToken, row.id, false).catch(e =>
          log(`  ⚠ result report failed: ${(e as Error).message}`));
      }
      out.failed++;
      log(`  ❌ NOT applied (last HTTP ${lastStatus || 'network error'}) — stays pending. ` +
        (lastStatus >= 400 && lastStatus < 500
          ? 'Check HERMES_TOKEN / the function URL.'
          : 'Will retry on the next run.'));
    }
  }

  db?.close();
  log(`done: ${out.resolved} resolved, ${out.failed} failed, ${out.skipped} skipped (dry-run/report).`);
  if (out.failed > 0) process.exitCode = 1;
}

main().catch(e => {
  console.error('[hermes] fatal:', e);
  process.exit(1);
});
