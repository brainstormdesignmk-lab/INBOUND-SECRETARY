import { LandmarkStore } from '../src/geo/landmarks.js';
import { OfflineMapStore } from '../src/geo/offlineMap.js';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

const dbPath = process.env.SKOPJE_POIS_DB || path.join(process.cwd(), 'data', 'skopje-pois.db');
const offlineMap = new OfflineMapStore(dbPath);

const store = new LandmarkStore({
  dbPath: path.join(process.cwd(), 'data', 'lina.db'),
  offlineMap,
  googleKey: process.env.GOOGLE_MAPS_API_KEY || '',
  hermesLlmBaseUrl: process.env.HERMES_LLM_BASE_URL || '',
  hermesLlmApiKey: process.env.HERMES_LLM_API_KEY || '',
  hermesLlmModel: process.env.HERMES_LLM_MODEL || '',
});

// Force a fresh resolve by clearing cache first
const cacheKey = 'eb89:Bulevard ASNOM 134';
store.clear?.(cacheKey);

const result = store.resolve({
  eb: 89,
  address: 'Бул. Асном бр.134',
  location: 'Аеродром',
  details: 'Стан се продава комплетно наместен',
});

console.log('=== Resolve result ===');
console.log(JSON.stringify(result, null, 2));

// Check DB cache
console.log('\n=== DB cache entries for ASNOM ===');
const cached = store.get(cacheKey);
console.log('Cache hit:', cached);

// Check what each layer would produce
console.log('\n=== Layer-by-layer analysis ===');

// Layer 5: Offline map
const geo = offlineMap.geocodeAddress('Бул. Асном бр.134');
console.log('Offline geocode:', geo);
if (geo) {
  const pois = offlineMap.nearestPois(geo.lat, geo.lon, 1500, 5);
  console.log('Offline POIs:', pois.map(p => `${p.name} (${p.distance_m}m)`));
}

// Layer 7: Deterministic table
console.log('\nGoogle key set:', !!process.env.GOOGLE_MAPS_API_KEY);
