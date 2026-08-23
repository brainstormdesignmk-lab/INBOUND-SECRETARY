import { OfflineMapStore } from '../src/geo/offlineMap.ts';
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

const offlineMap = new OfflineMapStore(
  process.env.SKOPJE_POIS_DB || path.join(process.cwd(), 'data', 'skopje-pois.db')
);

// EB 89: ASNOM 134, Aerodrom
const geo = offlineMap.geocodeAddress('Бул. АСНОМ Бр.134');
if (!geo) { console.log('Geocode failed'); process.exit(1); }
console.log(`EB 89 geocode: ${geo.lat}, ${geo.lon}`);

const pois = offlineMap.nearestPois(geo.lat, geo.lon, 2000, 15);
console.log('\nEB 89 nearestPois (with permanence multiplier):');
for (let i = 0; i < pois.length; i++) {
  const p = pois[i];
  console.log(`  ${String(i+1).padStart(2)}. ${String(p.distance_m).padStart(5)}m  ${p.name.padEnd(40)} (${p.type})`);
}
console.log(`\n→ PICK: "${pois[0]?.name}" (${pois[0]?.type}, ${pois[0]?.distance_m}m)`);

// Also verify EB 90 unchanged
const geo90 = offlineMap.geocodeAddress('Локов 5');
if (geo90) {
  const pois90 = offlineMap.nearestPois(geo90.lat, geo90.lon, 2000, 5);
  console.log(`\nEB 90 nearestPois:`);
  for (let i = 0; i < pois90.length; i++) {
    const p = pois90[i];
    console.log(`  ${String(i+1).padStart(2)}. ${String(p.distance_m).padStart(5)}m  ${p.name.padEnd(40)} (${p.type})`);
  }
  console.log(`\n→ PICK: "${pois90[0]?.name}" (${pois90[0]?.type}, ${pois90[0]?.distance_m}m)`);
}
