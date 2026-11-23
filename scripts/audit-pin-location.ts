#!/usr/bin/env tsx
/**
 * audit-pin-location.ts — report (and, on a master, repair) feed rows whose PIN
 * sits in another quarter than the naselba the row itself names.
 *
 *   npm run audit:pin-location                        # read-only report
 *   npm run audit:pin-location -- --eb 85             # one row
 *   npm run audit:pin-location -- --eb 85 --fix       # rewrite THAT row's centre
 *   npm run audit:pin-location -- --all --fix         # rewrite every finding
 *   npm run audit:pin-location -- --json              # machine-readable
 *
 * A repair is TARGETED by default: `--fix` needs `--eb` (or the explicit
 * `--all`), because the sweep finds rows where the naselba may be the wrong side
 * (a row labelled Кисела Вода whose address names a market 5 km north). Those
 * need a human decision; only the row the operator has confirmed is rewritten.
 *
 * WHY THIS EXISTS. The [05:32] capture served «Станот под Евидентен број 85 е
 * трисобен стан во Ново Лисиче. Се наоѓа во близина на ТЦ Мавровка.» — Ново
 * Лисиче is 3,4 km from that pin, and ТЦ Мавровка is 54 m from it. The card-side
 * guard (LandmarkService.enrich) now drops the landmark, which stops the
 * contradiction from reaching a client, but it cannot repair the FEED row: every
 * other reader (the public page, where-is, availability) still sees a flat
 * labelled Ново Лисиче with a pin in Пајко Маало. This script is the repair, and
 * the monthly sweep keeps the class from coming back.
 *
 * WHICH SIDE IS WRONG is attributed per row, never assumed (see
 * `pinSide` in src/feed/pinAudit.ts): a settlement the row's OWN words name that
 * stands at the pin means the LABEL is the wrong side (EB 44 «куќа во
 * Визбегово»), and only then does `--fix` rewrite `neighborhood` instead of the
 * centre. Moving that pin would have destroyed a coordinate the owner's own
 * description confirms. Every repair is listed with both sides, so the operator
 * sees the decision.
 *
 * THE WRITE is `geo:center` (src/feed/writePolicy.ts): lat/lon/geo_source belong
 * to the MASTER, the host whose map file is writable. An atom prints the report
 * and refuses to write, which is the intended behaviour — run it on the box that
 * authored the map.
 *
 * THE REPAIRED CENTRE IS THE NASELBA CENTROID with geo_source
 * `osm_low_confidence`. That is deliberately the honest value: a centroid is not
 * a building point, the read side already refuses to mint a landmark claim from
 * a low-confidence centre, and a wrong street anchor (what the row had) is worse
 * than an imprecise one in the RIGHT quarter. A later address geocode upgrades
 * it like any other row.
 */

import '../src/compat/node16';

import { loadConfig } from '../src/config';
import { PropertyService } from '../src/data/properties';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { auditRows, pinDriftSummary, type PinLocationFinding } from '../src/feed/pinAudit';
import { assertFeedWrite, resolveHostRole, FeedWriteRefused } from '../src/feed/writePolicy';

export { auditRows, pinDriftSummary };
export type { PinLocationFinding };

const SUPABASE_URL = process.env.SUPABASE_URL ?? 'https://qkgioqotxjxffiaufgwd.supabase.co';
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY
  ?? 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFrZ2lvcW90eGp4ZmZpYXVmZ3dkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxMTU0NjUsImV4cCI6MjA3MDY5MTQ2NX0.WVno6c6_rvFqFwj1fN8UWHYmlit0C-6J_h57P8d5eOI';

async function patchCenter(eb: number, lat: number, lon: number, source: string): Promise<void> {
  const url = `${SUPABASE_URL}/rest/v1/properties?property_number=eq.${encodeURIComponent(String(eb))}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ lat, lon, geo_source: source, geocoded_at: new Date().toISOString() }),
  });
  if (!res.ok) throw new Error(`patch EB ${eb}: ${res.status} ${await res.text()}`);
}

/** The OTHER repair: the pin is right and the LABEL is the wrong side. Same
 *  surface (`geo:center` owns `neighborhood` too — a naselba is a map fact), but
 *  the coordinate is left exactly as the map measured it. */
async function patchNeighborhood(eb: number, neighborhood: string): Promise<void> {
  const url = `${SUPABASE_URL}/rest/v1/properties?property_number=eq.${encodeURIComponent(String(eb))}`;
  const res = await fetch(url, {
    method: 'PATCH',
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify({ neighborhood }),
  });
  if (!res.ok) throw new Error(`patch EB ${eb}: ${res.status} ${await res.text()}`);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const fix = argv.includes('--fix');
  const json = argv.includes('--json');
  const ebIdx = argv.indexOf('--eb');
  const onlyEb = ebIdx >= 0 ? Number(argv[ebIdx + 1]) : undefined;

  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) {
    console.error(`map unavailable at ${cfg.skopjePoisDb} — the audit needs the authoritative map`);
    process.exitCode = 1;
    return;
  }

  const ps = new PropertyService(cfg.propertyDataUrl);
  let rows = await ps.getAll();
  if (!ps.healthy && rows.length === 0) {
    console.error('the feed could not be read — refusing to report "no contradictions" on an empty hand');
    process.exitCode = 1;
    return;
  }
  if (onlyEb !== undefined) rows = rows.filter(r => r.eb === onlyEb);

  const findings = auditRows(rows, map);
  const broken = findings.filter(f => f.contradicts);
  const skipped = findings.filter(f => f.skipped);

  if (json) {
    console.log(JSON.stringify({ checked: findings.length, broken, skipped }, null, 2));
  } else {
    console.log(pinDriftSummary(findings) + '\n');
    for (const f of broken) {
      const pin = f.pinQuarter ? `pin stands in «${f.pinQuarter.name}» (${f.pinQuarter.distance_m} m)` : 'pin quarter unknown';
      const named = f.namedAt ? `${f.namedAt.distance_m} m from the «${f.location}» row` : `«${f.location}» not on the map`;
      console.log(`  EB ${f.eb}  ${f.location}  ·  ${pin}  ·  ${named}`);
      if (f.address) console.log(`         address: ${f.address}`);
      // THE VERDICT, on its own line: which side a repair rewrites, and why.
      console.log(f.side === 'naselba'
        ? `         verdict: the LABEL is the wrong side — the row's own words name «${f.naselbaAt?.name}» (${f.naselbaAt?.distance_m} m from the pin)`
        : `         verdict: the PIN is the wrong side — nothing in the row names the quarter it stands in`);
    }
    if (skipped.length > 0) {
      console.log(`\n  ${skipped.length} row(s) not judged:`);
      const byReason = new Map<string, number>();
      for (const f of skipped) byReason.set(f.skipped!, (byReason.get(f.skipped!) ?? 0) + 1);
      for (const [why, n] of byReason) console.log(`    ${n} × ${why}`);
    }
  }

  if (!fix || broken.length === 0) {
    if (broken.length > 0 && !fix) console.log('\n(read-only: re-run with --fix --eb <n> on the master to rewrite a broken centre)');
    if (broken.length > 0) process.exitCode = 1;
    return;
  }
  if (onlyEb === undefined && !argv.includes('--all')) {
    console.error('\nrefusing a bulk rewrite: name the confirmed row with --eb <n>, or pass --all to repair every finding.');
    console.error('a finding the operator has not seen yet is not a repair decision.');
    process.exitCode = 1;
    return;
  }

  // THE SINGLE-WRITER GATE — same surface as backfill-geo, because this is the
  // same fact (the property centre, measured against the authored map).
  const host = resolveHostRole({ mapPath: process.env.SKOPJE_POIS_DB || cfg.skopjePoisDb });
  try {
    assertFeedWrite('geo:center', host.role);
  } catch (e) {
    if (!(e instanceof FeedWriteRefused)) throw e;
    console.error(`\n${e.message}`);
    process.exitCode = 1;
    return;
  }
  console.log(`\nfeed writer: role=${host.role} (${host.why})`);
  for (const f of broken) {
    if (f.side === 'naselba') {
      // THE LABEL MOVES, THE PIN STAYS: the row's own words place it at the
      // settlement its pin already stands in, so the coordinate is the trustworthy
      // half and only the naselba the agency typed is wrong.
      if (!f.naselbaAt) continue;
      await patchNeighborhood(f.eb, f.naselbaAt.name);
      console.log(`  EB ${f.eb}: naselba → «${f.naselbaAt.name}» (pin kept at ${f.lat},${f.lon})`);
      continue;
    }
    if (!f.namedAt) continue;
    // THE PIN MOVES TO THE QUARTER THE ROW NAMES, honestly labelled. The
    // landmark line is dropped at the same time: a roster measured from the OLD
    // pin is about another part of town.
    await patchCenter(f.eb, f.namedAt.lat, f.namedAt.lon, 'osm_low_confidence');
    console.log(`  EB ${f.eb}: centre → ${f.namedAt.lat},${f.namedAt.lon} («${f.location}» centroid, osm_low_confidence)`);
  }
  console.log('\nrepairs written. The landmark rosters rebuild on the next master pass;');
  console.log('verify with: npx tsx scripts/audit-pin-location.ts');
}

if (require.main === module) {
  void main().catch(e => { console.error(e); process.exitCode = 1; });
}
