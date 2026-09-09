import Database from 'better-sqlite3';

const poiPath = '/home/metropolis3/Documents/real-estate-atoms/secretaries/inbound_final/data/skopje-pois.db';
const poiDb = new Database(poiPath);

// EB 78 coords from TUI (Google Maps link)
const lat = 41.9936865;
const lon = 21.4163227;

console.log('=== POIs near EB 78 (Капиштец) ===');
console.log(`Lat: ${lat}, Lon: ${lon}`);
console.log('');

// Check what columns exist
const cols = poiDb.prepare("PRAGMA table_info(pois)").all() as any[];
console.log('Columns:', cols.map((c: any) => c.name).join(', '));
console.log('');

// Count total POIs
const total = poiDb.prepare("SELECT COUNT(*) as c FROM pois").get() as any;
console.log(`Total POIs in DB: ${total.c}`);
console.log('');

// Find POIs at various radii using Haversine
function haversine(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// Get ALL POIs and filter by distance
const allPois = poiDb.prepare("SELECT * FROM pois").all() as any[];
console.log(`Loaded ${allPois.length} POIs into memory`);

for (const radius of [300, 500, 750, 1000, 1500, 2000]) {
  const nearby = allPois
    .map(p => ({ ...p, dist: haversine(lat, lon, p.lat, p.lon) }))
    .filter(p => p.dist <= radius)
    .sort((a, b) => a.dist - b.dist);
  
  console.log(`\n=== Radius ${radius}m: ${nearby.length} POIs ===`);
  nearby.slice(0, 15).forEach((p, i) => {
    console.log(`  ${i+1}. ${p.name} [${p.type}] ${Math.round(p.dist)}m`);
  });
}

poiDb.close();
