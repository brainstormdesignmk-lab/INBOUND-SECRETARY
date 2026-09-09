import { OfflineMapStore, streetKey } from '../src/geo/offlineMap';

const map = new OfflineMapStore('data/skopje-pois.db');
console.log('Map available:', map.available);
const stats = map.stats();
console.log('Stats:', stats);

// EB 76: Васил Стефановски 16, Центар
// EB 78: Народен Фронт 23, Капиштец
const props = [
  { eb: 76, address: 'Васил Стефановски 16', location: 'Центар' },
  { eb: 78, address: 'Народен Фронт 23', location: 'Капиштец' },
];

for (const p of props) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`EB ${p.eb}: "${p.address}" (${p.location})`);
  console.log(`streetKey: "${streetKey(p.address)}"`);
  
  const geo = map.geocodeAddress(p.address);
  console.log(`geocodeAddress → ${geo ? `${geo.lat}, ${geo.lon} (${geo.street})` : 'FAILED'}`);
  
  if (geo) {
    console.log(`Google Maps: https://www.google.com/maps/search/?api=1&query=${geo.lat},${geo.lon}`);
    
    // What nearestPois returns with different radii
    for (const radius of [150, 300, 600]) {
      const pois = map.nearestPois(geo.lat, geo.lon, radius, 50);
      console.log(`  radius ${radius}m → ${pois.length} POIs`);
      pois.slice(0, 3).forEach((po, i) => {
        console.log(`    ${i+1}. ${po.name} [${po.type}] ${po.distance_m}m @ ${po.lat},${po.lon}`);
      });
    }
    
    // The 500m guard filter
    const allPois: any[] = [];
    const seenNames = new Set<string>();
    for (const radius of [150, 300, 600]) {
      for (const po of map.nearestPois(geo.lat, geo.lon, radius, 50)) {
        if (seenNames.has(po.name)) continue;
        seenNames.add(po.name);
        if (po.name.length >= 3 && po.lat != null && po.lon != null) allPois.push(po);
      }
    }
    const nearby = allPois.slice(0, 3).filter(po => po.distance_m <= 500);
    console.log(`  AFTER 500m guard → ${nearby.length} landmarks for rotation:`);
    nearby.forEach((po, i) => {
      console.log(`    L${i+1}: ${po.name} @ ${po.lat},${po.lon} (${po.distance_m}m)`);
      console.log(`       Maps: https://www.google.com/maps/search/?api=1&query=${Math.round(po.lat*1000)/1000},${Math.round(po.lon*1000)/1000}`);
    });
  }
}
