import { OfflineMapStore, streetKey } from '../src/geo/offlineMap.js';

const dbPath = process.env.SKOPJE_POIS_DB || 'data/skopje-pois.db';
const map = new OfflineMapStore(dbPath);

// The exact address from the feed after titleCase processing
// Feed raw: "Бул. Асном бр.134" → titleCase → ??? 
const addrs = [
  'Бул. Асном бр.134',     // raw
  'Бул. АСНОМ Бр.134',      // what the feed returns as address
  'Бул. Асном БР.134',     // titleCase on raw
  'Бул. Асном Бр.134',     // titleCase on raw
];

for (const addr of addrs) {
  const key = streetKey(addr);
  const geo = map.geocodeAddress(addr);
  console.log(`"${addr}" → key="${key}" geo=${geo ? `${geo.lat},${geo.lon}` : 'FAIL'}`);
  if (geo) {
    const pois = map.nearestPois(geo.lat, geo.lon, 500, 3);
    console.log(`  nearest: ${pois.map(p => p.name + '(' + p.distance_m + 'm)').join(', ')}`);
  }
}
