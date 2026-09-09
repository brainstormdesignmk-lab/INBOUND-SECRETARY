import { LandmarkService, LandmarkStore, landmarkCacheKey } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { PropertyService, Property } from '../src/data/properties';
import { Db } from '../src/store/db';
import { loadConfig } from '../src/config';

async function main() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const offlineMap = new OfflineMapStore(cfg.skopjePoisDb);
  console.log('offlineMap.available:', offlineMap.available);
  
  const landmarks = new LandmarkService(db, { osm: false, offlineMap });
  
  // EB 78 property
  const hit: Property = {
    eb: 78, id: 78, location: 'Капиштец', address: 'Беверли Хилс',
    price: 185000, service: 'buy', bedrooms: 3, size: '82 м²',
    location_lat: 41.9936865, location_lon: 21.4163227,
  };
  
  // This is what the handler calls
  const nearby = landmarks.nearbyLandmarks(hit);
  console.log('\nnearbyLandmarks returned:', nearby.length, 'landmarks');
  nearby.forEach((n, i) => {
    console.log(`  ${i+1}. ${n.landmark} [${n.source}] ${n.distance_m ?? '?'}m`);
  });
}

main().catch(console.error);
