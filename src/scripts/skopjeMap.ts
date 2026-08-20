// skopje-map — the offline map pull (Hermes machine, T60 plan).
//
// Downloads Skopje's NAMED POIs + address rows from OSM (Overpass) and builds
// the local SQLite map the resolver reads:
//   data/skopje-pois.db   (few MB — a few tens of thousands of rows)
//
// Usage:
//   npm run map:pull            # pull + rebuild (atomic — a failed pull keeps
//                               # the previous map)
//
// The weekly cron (Sunday 03:17, scripts/skopje-map-weekly.sh) runs this. The
// script logs the EXACT counts and the resulting DB size — the real answer to
// "how much data does the offline map contain?" is printed on every run.

import { loadConfig } from '../config';
import { buildSkopjeDb, OfflineMapStore, SKOPJE_BBOX } from '../geo/offlineMap';

async function main(): Promise<void> {
  const cfg = loadConfig();
  const dbPath = cfg.skopjePoisDb;
  console.log(`[skopje-map] bbox: ${SKOPJE_BBOX.join(', ')} → ${dbPath}`);

  const stats = await buildSkopjeDb(dbPath);
  console.log(`[skopje-map] OK: ${stats.pois} POIs, ${stats.addresses} addresses, ${(stats.bytes / 1024 / 1024).toFixed(2)} MB on disk`);

  // Sanity: reopen read-only and confirm the resolver sees them.
  const store = new OfflineMapStore(dbPath);
  console.log(`[skopje-map] resolver view: available=${store.available} pois=${store.stats()?.pois} addresses=${store.stats()?.addresses}`);
  store.close();
}

main().catch(e => {
  console.error('[skopje-map] fatal:', (e as Error).message);
  process.exit(1);
});
