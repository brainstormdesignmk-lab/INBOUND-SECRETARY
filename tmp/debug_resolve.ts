import { LandmarkService, landmarkCacheKey } from '../src/geo/landmarks.js';
import { OfflineMapStore } from '../src/geo/offlineMap.js';
import { PropertyService, mapRow } from '../src/data/properties.js';
import { Db } from '../src/store/db.js';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  // Simulate exactly what the TUI does
  const cfg = {
    propertyDataUrl: process.env.PROPERTY_DATA_URL || process.env.SUPABASE_URL + '/rest/v1/properties?select=*',
  };
  
  // Load properties exactly like the TUI
  const propertyService = new PropertyService(cfg.propertyDataUrl);
  const all = await propertyService.getAll();
  const eb89 = all.find(p => p.eb === 89);
  
  if (!eb89) { console.log('EB 89 not found'); return; }
  
  console.log('=== Property from feed ===');
  console.log('address:', JSON.stringify(eb89.address));
  console.log('landmark:', JSON.stringify(eb89.landmark));
  console.log('landmarks:', JSON.stringify(eb89.landmarks));
  
  // Check what the landmark cache key would be
  const key = landmarkCacheKey(eb89);
  console.log('\n=== Cache key ===');
  console.log(JSON.stringify(key));
  
  // Check what's in the DB for this key
  const db = new Db(path.join(process.cwd(), 'data', 'lina.db'));
  const store = new (await import('../src/geo/landmarks.js')).LandmarkStore(db);
  const cached = store.get(key);
  console.log('DB cache:', cached);
  
  // Now run enrich EXACTLY like the TUI
  const offlineMap = new OfflineMapStore(
    process.env.SKOPJE_POIS_DB || path.join(process.cwd(), 'data', 'skopje-pois.db')
  );
  const svc = new LandmarkService(db, { offlineMap, onHermesRequest: () => {} });
  
  console.log('\n=== Before enrich ===');
  console.log('pr.landmark:', JSON.stringify(eb89.landmark));
  
  await svc.enrich([eb89]);
  
  console.log('\n=== After enrich ===');
  console.log('pr.landmark:', JSON.stringify(eb89.landmark));
  
  // Also test resolve directly
  const result = await svc.resolve({
    eb: eb89.eb,
    address: eb89.address,
    location: eb89.location,
    details: eb89.details,
    landmarks: eb89.landmarks,
  });
  console.log('\n=== Direct resolve ===');
  console.log(JSON.stringify(result, null, 2));
  
  // Check offline map directly
  console.log('\n=== Offline map direct check ===');
  const geo = offlineMap.geocodeAddress(eb89.address ?? '');
  console.log('geocode:', geo);
  if (geo) {
    const pois = offlineMap.nearestPois(geo.lat, geo.lon, 1500, 5);
    console.log('POIs:', pois.map(p => `${p.name} (${p.distance_m}m) ${p.type}`));
  }
}

main().catch(console.error);
