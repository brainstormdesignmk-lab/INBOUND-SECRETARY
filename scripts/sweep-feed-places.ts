// sweep-feed-places — every LISTED flat must resolve to a real map place.
//
// Where audit-feed-landmarks checks the landmark CONTRACT (first entry inside
// 200 m, a ranked type), this sweep checks the feed's own GEOGRAPHY: the
// address must geocode in the shipped map (or be a map place by name), and
// every stored landmark must BE a map row. A flat that fails either can never
// be honestly located by the funnel — «во близина на X» would name a place the
// bot cannot measure, or the address itself would anchor nothing.
//
// Runs against the LIVE feed, like the landmark audit, so a bad import is
// caught the moment it lands. Stored distances that disagree with the map's
// own pins are printed as DRIFT (the operator's re-rank list) and do not fail
// the run.
//
// Usage: npm run audit:places
// Exit code: 0 = every listed flat resolves, 1 = at least one violation,
//            or the feed/map could not be read (a clean report is never faked).

import '../src/compat/node16';
import { loadConfig } from '../src/config';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { auditFeedPlaces } from '../src/geo/feedPlaceAudit';

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`[sweep-places] feed: ${cfg.propertyDataUrl}`);

  const res = await fetch(cfg.propertyDataUrl);
  if (!res.ok) {
    console.error(`[sweep-places] ✗ feed HTTP ${res.status} — cannot sweep`);
    process.exit(1);
  }
  const body = (await res.json()) as { properties?: Record<string, unknown>[] } | Record<string, unknown>[];
  const rows = Array.isArray(body) ? body : (body.properties ?? []);
  if (rows.length === 0) {
    console.error('[sweep-places] ✗ the feed returned no rows — refusing to report "clean"');
    process.exit(1);
  }

  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) {
    // No map means every check would silently pass. That is the one answer
    // this sweep must never give.
    console.error(`[sweep-places] ✗ the offline map is not at ${cfg.skopjePoisDb} — nothing to check against`);
    process.exit(1);
  }

  try {
    const report = auditFeedPlaces(rows, map);
    for (const i of report.issues) console.log(`  ✗ EB ${i.eb} [${i.kind}] ${i.detail}`);
    for (const w of report.warnings) console.log(`  ! EB ${w.eb} [${w.kind}] ${w.detail}`);
    console.log(
      `[sweep-places] ${report.properties} propert(ies): ${report.addressed} with an address, `
      + `${report.resolved} resolved to a map place (${report.resolvedAsPlace} as a place name), `
      + `${report.landmarkEntries} landmark entr(ies), ${report.landmarksOnMap} on the map; `
      + `${report.issues.length} violation(s), ${report.warnings.length} warning(s).`,
    );
    process.exit(report.issues.length ? 1 : 0);
  } finally {
    map.close();
  }
}

main().catch((e) => {
  console.error('[sweep-places] fatal:', (e as Error).message);
  process.exit(1);
});
