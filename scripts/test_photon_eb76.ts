import { LandmarkService, LandmarkStore, landmarkCacheKey } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { Db } from '../src/store/db';
import path from 'path';

async function main() {
  const db = new Db(path.join(process.cwd(), 'data', 'lina.db'));
  const offlineMap = new OfflineMapStore(path.join(process.cwd(), 'data', 'skopje-pois.db'));
  
  console.log('Offline map:', offlineMap.available, offlineMap.stats());
  
  const svc = new LandmarkService(db, {
    offlineMap,
    osm: false, // disable live OSM to avoid network
  });

  // Clear cache for EB76 so it re-resolves
  const key76 = landmarkCacheKey({ address: 'Васил Стефановски 16', location: 'Центар' });
  try { db.db.prepare('DELETE FROM landmarks WHERE address_key = ?').run(key76); } catch {}
  
  // Test EB76 with Photon geocoder
  console.log('\n=== EB76: Васил Стефановски 16, Центар ===');
  console.log('Real location (Google Maps): 41.9960056, 21.4172468');
  
  const r76 = svc.nearbyLandmarks({ eb: 76, address: 'Васил Стефановски 16', location: 'Центар' });
  console.log('nearbyLandmarks result:', r76.length, 'landmarks');
  r76.forEach((l, i) => {
    console.log(`  L${i+1}: ${l.landmark} @ ${l.lat},${l.lon}`);
  });
  
  // Also check what the cached result looks like now
  const store = new LandmarkStore(db);
  const cached76 = store.getNearby(key76);
  console.log('Cache:', cached76 ? JSON.stringify(cached76) : 'EMPTY');
  
  // Test EB78 as well
  const key78 = landmarkCacheKey({ address: 'Народен Фронт 23', location: 'Капиштец' });
  try { db.db.prepare('DELETE FROM landmarks WHERE address_key = ?').run(key78); } catch {}
  
  console.log('\n=== EB78: Народен Фронт 23, Капиштец ===');
  const r78 = svc.nearbyLandmarks({ eb: 78, address: 'Народен Фронт 23', location: 'Капиштец' });
  console.log('nearbyLandmarks result:', r78.length, 'landmarks');
  r78.forEach((l, i) => {
    console.log(`  L${i+1}: ${l.landmark} @ ${l.lat},${l.lon}`);
  });
  
  offlineMap.close();
  db.close();
}

main().catch(console.error);
