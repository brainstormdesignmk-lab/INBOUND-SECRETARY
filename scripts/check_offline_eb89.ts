import { OfflineMapStore, streetKey } from '../src/geo/offlineMap.ts';
import path from 'path';

const dbPath = process.env.SKOPJE_POIS_DB || path.join(process.cwd(), 'data', 'skopje-pois.db');
const map = new OfflineMapStore(dbPath);
console.log('Available:', map.available);
if (map.available) {
  const stats = map.stats();
  console.log('Stats:', JSON.stringify(stats));
}

const addr = 'Бул. АСНОМ Бр.134';
console.log('\n=== streetKey:', streetKey(addr), '===');
const geo = map.geocodeAddress(addr);
if (geo) {
  console.log('Coords:', geo.lat.toFixed(6), geo.lon.toFixed(6), 'street:', geo.street);
  const pois = map.nearestPois(geo.lat, geo.lon, 2000, 15);
  console.log('\nNearest POIs (2km radius):');
  for (const p of pois) {
    console.log(`  ${String(p.distance_m).padStart(4)}m  ${p.name}  (${p.type})`);
  }
} else {
  console.log('Geocode FAILED — trying alternative addresses');
  for (const a of ['Бул. АСНОМ 134', 'Bulevard ASNOM 134', 'АСНОМ 134', 'Бул. Асном', 'ASNOM']) {
    const g2 = map.geocodeAddress(a);
    if (g2) {
      console.log(`  "${a}" -> ${g2.lat.toFixed(6)},${g2.lon.toFixed(6)} street="${g2.street}"`);
      const pois2 = map.nearestPois(g2.lat, g2.lon, 2000, 15);
      console.log('  POIs:');
      for (const p of pois2) {
        console.log(`    ${String(p.distance_m).padStart(4)}m  ${p.name}  (${p.type})`);
      }
      break;
    } else {
      console.log(`  "${a}" -> FAILED`);
    }
  }
}

// Also check where Златна Вилушка is in the POI DB
console.log('\n=== Златна Вилушка in POI DB ===');
const zlPoi = map.findPoiByName('Златна Вилушка');
if (zlPoi) {
  console.log('Found:', zlPoi.name, `(${zlPoi.lat.toFixed(6)}, ${zlPoi.lon.toFixed(6)})`);
  if (geo) {
    const d = Math.round(haversine(geo.lat, geo.lon, zlPoi.lat, zlPoi.lon));
    console.log(`Distance from ASNOM 134: ${d}m`);
  }
} else {
  console.log('NOT found in POI DB');
  // try partial
  const zlPartial = map.findPoiByName('Вилушка');
  if (zlPartial) console.log('Partial "Вилушка":', zlPartial.name);
  const zlFork = map.findPoiByName('Golden Fork');
  if (zlFork) console.log('Partial "Golden Fork":', zlFork.name);
}

function haversine(a: {lat:number,lon:number}|number, b?: {lat:number,lon:number}, c?:number, d?:number): number {
  const lat1 = typeof a === 'number' ? a : a.lat;
  const lon1 = typeof a === 'number' ? c! : (a as any).lon;
  const lat2 = b!.lat;
  const lon2 = b!.lon;
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const s = Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
