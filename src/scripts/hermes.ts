// Hermes — syncs owner-dictated corrections to the public app: PRICE and ADDRESS.
//
// Two queues, one pass, one schedule:
//   `price_changes`   — the owner named a new price ("цената е променета на 60.000")
//   `address_changes` — the owner corrected the address at Turn 0 of the visit
//                       protocol ("не е 12, туку 16")
// Both are recorded by Lina (status='pending') and both are applied by this one
// script through the T60 Hub to the private Supabase edge functions Lovable
// builds (`update-property-price`, `update-property-address`), which then report
// back so Lina marks the row resolved.
//
// WHY THEY TRAVEL TOGETHER: the atom runs ONE required scheduled job
// (`*/5 scripts/hermes-price.sh`). The address is the same kind of fact from the
// same conversation with the same owner — giving it a second timer would be a
// second schedule to keep alive, for no reason.
//
// TWO MODES (env-driven):
//   local  — no LINA_API_URL: reads/writes Lina's data/lina.db directly.
//   remote — LINA_API_URL + HERMES_TOKEN set (Hermes on its own machine):
//            pulls pending work from /hermes/v1/work, applies via the same
//            Supabase functions, reports ok/fail to /hermes/v1/{prices,addresses}/:id/result.
//
// Rules:
//  - 2xx from the function → resolved. 5xx → retry with backoff, leave pending.
//    4xx → config/auth problem: log loudly, leave pending, exit 1.
//  - The public feed is fetched best-effort to log the CURRENT published price
//    next to the change — a sanity check, never a blocker. (Addresses have no
//    equivalent read-back: /public-properties does not expose the street.)
//
// Usage:
//   npm run hermes                # one pass over both queues
//   npm run hermes -- --dry-run   # report only, no network writes
//
// Cron-friendly: exit 0 = all pending synced, 1 = something needs attention.

import '../compat/node16';

import { loadConfig } from '../config';
import { Db } from '../store/db';
import { PriceChangeStore } from '../store/priceChanges';
import { AddressChangeStore } from '../store/addressChanges';
import {
  pullWork, reportPriceResult, reportAddressResult, PriceChangeWork, AddressChangeWork,
} from '../hermes/client';

interface SyncResult {
  resolved: number;
  failed: number;
  skipped: number;
}

const MAX_ATTEMPTS = 3;
/** The app's address column is capped at 300 chars (create-property validates it). */
const MAX_ADDRESS_LEN = 300;

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

/** POST one body to a hub endpoint. Returns the HTTP status (0 = network error). */
async function post(cfg: {
  url: string; token: string; authHeader: string;
}, body: Record<string, unknown>): Promise<{ ok: boolean; status: number }> {
  try {
    const res = await fetch(cfg.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        [cfg.authHeader]: cfg.token,
      },
      body: JSON.stringify(body),
    });
    return { ok: res.ok, status: res.status };
  } catch (e) {
    log(`  network error: ${(e as Error).message}`);
    return { ok: false, status: 0 };
  }
}

/**
 * Push with the shared retry contract: 5xx/network → retry with backoff,
 * 4xx and 2xx are final. Returns whether it was applied plus the last status,
 * so the caller can tell "try later" from "fix your config".
 */
async function pushWithRetry(
  cfg: { url: string; token: string; authHeader: string },
  body: Record<string, unknown>,
): Promise<{ applied: boolean; lastStatus: number }> {
  let lastStatus = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    if (attempt > 1) await new Promise(r => setTimeout(r, attempt * 2000));
    const r = await post(cfg, body);
    lastStatus = r.status;
    if (r.ok) return { applied: true, lastStatus };
    if (r.status >= 400 && r.status < 500) break; // auth/validation — retrying won't help
  }
  return { applied: false, lastStatus };
}

function explainFailure(lastStatus: number): string {
  return lastStatus >= 400 && lastStatus < 500
    ? 'Check HERMES_TOKEN / the function URL.'
    : 'Will retry on the next run.';
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const dryRun = process.argv.includes('--dry-run');
  const remote = !!(cfg.linaApiUrl && cfg.hermesToken);

  let db: Db | null = null;
  let priceStore: PriceChangeStore | null = null;
  let addressStore: AddressChangeStore | null = null;
  let pendingPrices: PriceChangeWork[] = [];
  let pendingAddresses: AddressChangeWork[] = [];

  if (remote) {
    log(`REMOTE mode → ${cfg.linaApiUrl}`);
    if (!dryRun) {
      const work = await pullWork(cfg.linaApiUrl, cfg.hermesToken);
      pendingPrices = work.price_changes ?? [];
      pendingAddresses = work.address_changes ?? [];
    }
  } else {
    log('LOCAL mode (reads Lina DB directly)');
    db = new Db(cfg.dbPath);
    priceStore = new PriceChangeStore(db);
    addressStore = new AddressChangeStore(db);
    pendingPrices = priceStore.listPending()
      .map(r => ({ id: r.id, eb: r.eb, old_price: r.oldPrice, new_price: r.newPrice }));
    pendingAddresses = addressStore.listPending()
      .map(r => ({ id: r.id, eb: r.eb, old_address: r.oldAddress, new_address: r.newAddress }));
  }

  if (pendingPrices.length === 0 && pendingAddresses.length === 0) {
    log('no pending price or address changes — nothing to sync.');
    db?.close();
    return;
  }

  log(`pending: ${pendingPrices.length} price, ${pendingAddresses.length} address`);

  const writeCfg = { url: cfg.hermesWriteUrl, token: cfg.hermesToken, authHeader: cfg.hermesAuthHeader };
  const addrCfg = { url: cfg.hermesAddressWriteUrl, token: cfg.hermesToken, authHeader: cfg.hermesAuthHeader };
  const priceReady = !!(writeCfg.url && writeCfg.token);
  const addrReady = !!(addrCfg.url && addrCfg.token);
  if (!priceReady && pendingPrices.length > 0) {
    log('HERMES_WRITE_URL / HERMES_TOKEN not set — REPORT MODE (prices not sent, not resolved).');
  }
  if (!addrReady && pendingAddresses.length > 0) {
    log('HERMES_ADDRESS_WRITE_URL (or HERMES_WRITE_URL to derive it) / HERMES_TOKEN not set — ' +
      'REPORT MODE (addresses not sent, not resolved).');
  }
  if (dryRun) log('--dry-run: reporting what WOULD be sent, nothing sent, nothing resolved.');

  const out: SyncResult = { resolved: 0, failed: 0, skipped: 0 };

  // ── PRICE ─────────────────────────────────────────────────────────────────
  for (const row of pendingPrices) {
    const published = await currentPublishedPrice(cfg.propertyDataUrl, row.eb);
    const oldLabel = published !== undefined ? String(published) : (row.old_price ?? '?');
    log(`EB ${row.eb}: ${oldLabel} → ${row.new_price}`);

    if (!priceReady || dryRun) {
      out.skipped++;
      continue;
    }

    const { applied, lastStatus } = await pushWithRetry(writeCfg, {
      property_number: String(row.eb), price: row.new_price,
    });

    if (applied) {
      if (remote) {
        await reportPriceResult(cfg.linaApiUrl, cfg.hermesToken, row.id, true)
          .catch(e => log(`  ⚠ result report failed: ${(e as Error).message}`));
        log('  ✅ applied (HTTP 2xx) — reported resolved to Lina.');
      } else {
        priceStore?.resolve(row.id);
        log(`  ✅ applied (HTTP 2xx) — price_changes #${row.id} resolved.`);
      }
      out.resolved++;
    } else {
      if (remote) {
        await reportPriceResult(cfg.linaApiUrl, cfg.hermesToken, row.id, false)
          .catch(e => log(`  ⚠ result report failed: ${(e as Error).message}`));
      }
      out.failed++;
      log(`  ❌ price NOT applied (last HTTP ${lastStatus || 'network error'}) — stays pending. ` +
        explainFailure(lastStatus));
    }
  }

  // ── ADDRESS ───────────────────────────────────────────────────────────────
  for (const row of pendingAddresses) {
    const next = String(row.new_address ?? '').trim();
    log(`EB ${row.eb}: address "${row.old_address ?? '?'}" → "${next}"`);

    if (!next || next.length > MAX_ADDRESS_LEN) {
      // A row that can never be applied must not be retried forever, and it must
      // not be silently reported as synced either.
      out.failed++;
      log(`  ❌ address NOT applied — ${!next ? 'empty' : `longer than ${MAX_ADDRESS_LEN} chars`}. ` +
        'Fix the queue row or re-confirm with the owner.');
      continue;
    }

    if (!addrReady || dryRun) {
      out.skipped++;
      continue;
    }

    const { applied, lastStatus } = await pushWithRetry(addrCfg, {
      property_number: String(row.eb), address: next,
    });

    if (applied) {
      if (remote) {
        await reportAddressResult(cfg.linaApiUrl, cfg.hermesToken, row.id, true)
          .catch(e => log(`  ⚠ result report failed: ${(e as Error).message}`));
        log('  ✅ applied (HTTP 2xx) — reported resolved to Lina.');
      } else {
        addressStore?.resolve(row.id);
        log(`  ✅ applied (HTTP 2xx) — address_changes #${row.id} resolved.`);
      }
      out.resolved++;
    } else {
      if (remote) {
        await reportAddressResult(cfg.linaApiUrl, cfg.hermesToken, row.id, false)
          .catch(e => log(`  ⚠ result report failed: ${(e as Error).message}`));
      }
      out.failed++;
      log(`  ❌ address NOT applied (last HTTP ${lastStatus || 'network error'}) — stays pending. ` +
        explainFailure(lastStatus));
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
