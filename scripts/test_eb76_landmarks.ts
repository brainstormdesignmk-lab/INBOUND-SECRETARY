import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import Database from 'better-sqlite3';

async function main() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const pdb = new Database('data/skopje-pois.db', { readonly: true });
  const om = new OfflineMapStore(pdb);
  
  const lm = new LandmarkService(db, { offlineMap: om, osm: false });

  // Test 1: EB 76 with address only (old behavior — should be empty)
  console.log('=== Test 1: address only ===');
  const r1 = lm.nearbyLandmarks({ eb: 76, address: 'Васил Стефановски 16', location: 'Центар' });
  console.log('Result:', r1.length, 'landmarks');
  r1.forEach(l => console.log(`  ${l.landmark} (${l.lat}, ${l.lon})`));

  // Test 2: EB 76 with landmark fallback (new behavior)
  console.log('\n=== Test 2: with landmark fallback ===');
  const r2 = lm.nearbyLandmarks({ eb: 76, address: 'Васил Стефановски 16', location: 'Центар', landmark: 'Католичка црква Свети Јосиф' });
  console.log('Result:', r2.length, 'landmarks');
  r2.forEach(l => console.log(`  ${l.landmark} (${l.lat}, ${l.lon})`));

  // Test 3: EB 78 (Беверли Хилс) — should still work
  console.log('\n=== Test 3: EB 78 Беверли Хилс ===');
  const r3 = lm.nearbyLandmarks({ eb: 78, address: 'Народен Фронт', location: 'Капиштец' });
  console.log('Result:', r3.length, 'landmarks');
  r3.forEach(l => console.log(`  ${l.landmark} (${l.lat}, ${l.lon})`));
}

main().catch(console.error);
