import { titleCase, cleanMacedonian } from '../src/data/properties.js';
import { streetKey } from '../src/geo/offlineMap.js';
import { OfflineMapStore } from '../src/geo/offlineMap.js';

const rawAdresa = 'Бул. Асном бр.134';
const feedAddress = 'Бул. АСНОМ Бр.134';

// Simulate what mapRow does
const processed = cleanMacedonian(titleCase(rawAdresa));
console.log('raw adresa:', rawAdresa);
console.log('after titleCase+cleanMacedonian:', processed);
console.log('streetKey:', streetKey(processed));

// What the feed actually sends
const feedProcessed = cleanMacedonian(titleCase(feedAddress));
console.log('\nfeed address:', feedAddress);
console.log('after titleCase+cleanMacedonian:', feedProcessed);
console.log('streetKey:', streetKey(feedProcessed));

// Test the offline map with the PROCESSED address (what the TUI actually uses)
const map = new OfflineMapStore('data/skopje-pois.db');
const geo = map.geocodeAddress(processed);
console.log('\n=== Offline map geocode with PROCESSED address ===');
console.log('geocode:', geo);
if (geo) {
  const pois = map.nearestPois(geo.lat, geo.lon, 1500, 5);
  console.log('nearest POIs:', pois.map(p => `${p.name} (${p.distance_m}m)`));
} else {
  console.log('GEOCODE FAILED — will fall through to OSM live layer!');
}

// Also test with the feed address
const geo2 = map.geocodeAddress(feedAddress);
console.log('\n=== Offline map geocode with FEED address ===');
console.log('geocode:', geo2);
if (geo2) {
  const pois = map.nearestPois(geo2.lat, geo2.lon, 1500, 5);
  console.log('nearest POIs:', pois.map(p => `${p.name} (${p.distance_m}m)`));
}
