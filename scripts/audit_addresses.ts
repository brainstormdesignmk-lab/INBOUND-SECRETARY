// Address coverage audit — scans every property in the feed, runs the same
// geocodeAddress() path the TUI uses, and buckets every failure so we can fix
// data proactively instead of per-bug.
//
// Buckets:
//   GEOCODED        — address resolves to coordinates
//   POI_MATCHED     — not a street but a known POI name ("Црногорска Амбасада")
//                     — system handles these via findPoiByName, no action needed
//   TYPO_SUSPECTED  — no exact street-key match, but a 1-edit-distance match
//                     exists among known keys (feed misspelling vs OSM name)
//   NUMBER_GAP      — street exists in DB but this house number doesn't
//   GARBAGE         — obviously not an address (test data "Хфгхфгх", "Непозната")
//   STREET_MISSING  — street genuinely absent from the map DB
//
// Output: console summary + tmp/address-audit-report.txt

import { loadConfig } from '../src/config';
import { PropertyService } from '../src/data/properties';
import { OfflineMapStore, streetKey } from '../src/geo/offlineMap';
import Database from 'better-sqlite3';
import * as fs from 'fs';

/** Levenshtein edit distance (small strings only). */
function editDistance(a: string, b: string): number {
  if (Math.abs(a.length - b.length) > 1) return 2;
  const dp: number[] = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const tmp = dp[j];
      dp[j] = Math.min(dp[j] + 1, dp[j - 1] + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = tmp;
    }
  }
  return dp[b.length];
}

interface Row {
  eb: number;
  address: string;
  location?: string;
  bucket: 'GEOCODED' | 'POI_MATCHED' | 'TYPO_SUSPECTED' | 'NUMBER_GAP' | 'GARBAGE' | 'STREET_MISSING';
  detail?: string;
}

async function main() {
  const cfg = loadConfig();
  const om = new OfflineMapStore(cfg.skopjePoisDb ?? 'data/skopje-pois.db');
  if (!om.available) { console.error('offline map unavailable'); process.exit(1); }

  // All distinct street keys for typo detection (loaded once).
  const pdb = new Database(cfg.skopjePoisDb ?? 'data/skopje-pois.db', { readonly: true });
  const knownKeys = (pdb.prepare('SELECT DISTINCT key FROM addresses').all() as Array<{ key: string }>)
    .map(r => r.key);
  const keyIndex = new Map<string, number>(); // key -> row count
  for (const k of knownKeys) keyIndex.set(k, (keyIndex.get(k) ?? 0) + 1);
  const rowCount = pdb.prepare('SELECT key, COUNT(*) AS n FROM addresses GROUP BY key').all() as Array<{ key: string; n: number }>;
  keyIndex.clear();
  for (const r of rowCount) keyIndex.set(r.key, r.n);

  const ps = new PropertyService(cfg.propertyDataUrl);
  const all = await ps.getAll();
  console.log(`Auditing ${all.length} properties…`);

  const rows: Row[] = [];
  for (const p of all) {
    if (!p.address || p.address.trim() === '') {
      rows.push({ eb: p.eb, address: '(empty)', location: p.location, bucket: 'STREET_MISSING', detail: 'no address in feed' });
      continue;
    }
    const geo = om.geocodeAddress(p.address);
    if (geo) { rows.push({ eb: p.eb, address: p.address, location: p.location, bucket: 'GEOCODED' }); continue; }
    // Not a street? Try it as a POI name — resolve() layer 5a does this too.
    const poi = om.findPoiByName(p.address);
    if (poi) { rows.push({ eb: p.eb, address: p.address, location: p.location, bucket: 'POI_MATCHED', detail: `→ ${poi.name} [${poi.type}]` }); continue; }
    // Garbage heuristics: repeated chars / placeholder words.
    const norm = p.address.toLowerCase().replace(/\s+/g, '');
    const uniq = new Set(norm).size;
    if (/^(.)\1+$/.test(norm) || /^([а-яa-z])\1{2,}$/.test(norm) || uniq <= 3
      || ['непозната', 'непознат', 'nepoznata', 'тест', 'test', 'nema'].includes(norm)) {
      rows.push({ eb: p.eb, address: p.address, location: p.location, bucket: 'GARBAGE', detail: 'feed needs a real address' });
      continue;
    }

    const key = streetKey(p.address);
    // Street exists but geocode failed → house-number gap (or BB-less single building).
    if ((keyIndex.get(key) ?? 0) > 0) {
      const n = pdb.prepare('SELECT COUNT(*) AS n FROM addresses WHERE key = ?').get(key) as { n: number };
      rows.push({ eb: p.eb, address: p.address, location: p.location, bucket: 'NUMBER_GAP', detail: `${n.n} buildings mapped on street` });
      continue;
    }
    // Typo hunt: any known key within 1 edit?
    let best: { key: string; d: number } | undefined;
    for (const k of knownKeys) {
      const d = editDistance(key, k);
      if (d <= 1 && (!best || d < best.d)) best = { key: k, d };
      if (best && best.d === 0) break;
    }
    if (best) {
      rows.push({ eb: p.eb, address: p.address, location: p.location, bucket: 'TYPO_SUSPECTED', detail: `did-you-mean "${best.key}" (d=${best.d})` });
    } else {
      rows.push({ eb: p.eb, address: p.address, location: p.location, bucket: 'STREET_MISSING' });
    }
  }

  // Summary
  const count = (b: Row['bucket']) => rows.filter(r => r.bucket === b).length;
  const total = rows.length;
  const lines: string[] = [];
  lines.push('=== ADDRESS COVERAGE AUDIT ===');
  lines.push(`Generated: ${new Date().toISOString()}`);
  lines.push(`Properties audited: ${total}`);
  lines.push('');
  lines.push(`GEOCODED         ${count('GEOCODED')}  (${(100 * count('GEOCODED') / total).toFixed(1)}%)`);
  lines.push(`POI_MATCHED      ${count('POI_MATCHED')}  (${(100 * count('POI_MATCHED') / total).toFixed(1)}%)`);
  lines.push(`TYPO_SUSPECTED   ${count('TYPO_SUSPECTED')}`);
  lines.push(`NUMBER_GAP       ${count('NUMBER_GAP')}`);
  lines.push(`GARBAGE          ${count('GARBAGE')}`);
  lines.push(`STREET_MISSING   ${count('STREET_MISSING')}`);
  lines.push('');

  for (const bucket of ['TYPO_SUSPECTED', 'NUMBER_GAP', 'GARBAGE', 'STREET_MISSING'] as const) {
    const subset = rows.filter(r => r.bucket === bucket);
    if (subset.length === 0) continue;
    lines.push(`--- ${bucket} (${subset.length}) ---`);
    for (const r of subset) {
      lines.push(`EB ${r.eb}\t${JSON.stringify(r.address)}\tloc=${r.location ?? '-'}\t${r.detail ?? ''}`);
    }
    lines.push('');
  }

  const report = lines.join('\n');
  fs.mkdirSync('tmp', { recursive: true });
  fs.writeFileSync('tmp/address-audit-report.txt', report);
  console.log(lines.slice(0, 10).join('\n'));
  console.log(`\nFull report: tmp/address-audit-report.txt`);

  pdb.close();
}
main().catch(e => { console.error(e); process.exit(1); });
