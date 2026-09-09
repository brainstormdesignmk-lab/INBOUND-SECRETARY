import { OfflineMapStore } from '../src/geo/offlineMap';

const offlineMap = new OfflineMapStore('/home/metropolis3/Documents/real-estate-atoms/secretaries/inbound_final/data/skopje-pois.db');
console.log('available:', offlineMap.available);

if (offlineMap.available) {
  const stats = offlineMap.stats();
  console.log('stats:', stats);
  
  const lat = 41.9936865;
  const lon = 21.4163227;
  
  // What nearestPois returns (limit=5, this is what nearbyLandmarks calls)
  const pois = offlineMap.nearestPois(lat, lon, 1500, 5);
  console.log('\nnearestPois (limit=5):', pois.length, 'POIs');
  pois.forEach((p, i) => {
    console.log(`  ${i+1}. ${p.name} [${p.type}] ${p.distance_m}m`);
  });
  
  // Try with higher limit
  const pois10 = offlineMap.nearestPois(lat, lon, 1500, 10);
  console.log('\nnearestPois (limit=10):', pois10.length, 'POIs');
  pois10.forEach((p, i) => {
    console.log(`  ${i+1}. ${p.name} [${p.type}] ${p.distance_m}m`);
  });
}
