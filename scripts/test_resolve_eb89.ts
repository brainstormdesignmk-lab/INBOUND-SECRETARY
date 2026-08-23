import { LandmarkService, LandmarkStore, landmarkCacheKey } from '../src/geo/landmarks.ts';
import { OfflineMapStore } from '../src/geo/offlineMap.ts';
import { Db } from '../src/store/db.ts';
import path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const db = new Db(path.join(process.cwd(), 'data', 'lina.db'));
  const offlineMap = new OfflineMapStore(
    process.env.SKOPJE_POIS_DB || path.join(process.cwd(), 'data', 'skopje-pois.db')
  );

  const key = landmarkCacheKey({ address: 'Бул. АСНОМ Бр.134', location: 'Аеродром' });

  // Test 1: Fresh resolve (no cache)
  console.log('=== TEST 1: Fresh resolve (no cache) ===');
  db.db.prepare('DELETE FROM landmarks WHERE address_key = ?').run(key);
  const svc1 = new LandmarkService(db, { offlineMap, osm: true });
  const r1 = await svc1.resolve({ eb: 89, address: 'Бул. АСНОМ Бр.134', location: 'Аеродром' });
  console.log(`  Result: "${r1.landmark}" (${r1.source})`);

  // Test 2: Cached OSM result — should be SKIPPED when offline map available
  console.log('\n=== TEST 2: Cache has OSM result → should skip ===');
  db.db.prepare('DELETE FROM landmarks WHERE address_key = ?').run(key);
  db.db.prepare("INSERT INTO landmarks (address_key, landmark, source, resolved_at) VALUES (?, ?, ?, datetime('now'))").run(key, 'Златна вилушка', 'osm');
  console.log('  Cache set to: "Златна вилушка" [osm]');
  const svc2 = new LandmarkService(db, { offlineMap, osm: true });
  const r2 = await svc2.resolve({ eb: 89, address: 'Бул. АСНОМ Бр.134', location: 'Аеродром' });
  console.log(`  Result: "${r2.landmark}" (${r2.source})`);
  console.log(`  ${r2.landmark !== 'Златна вилушка' ? '✅ PASS — OSM cache skipped!' : '❌ FAIL — still using stale OSM cache'}`);

  // Test 3: Cached offline result — should be SERVED immediately
  console.log('\n=== TEST 3: Cache has offline result → should serve ===');
  db.db.prepare('DELETE FROM landmarks WHERE address_key = ?').run(key);
  db.db.prepare("INSERT INTO landmarks (address_key, landmark, source, resolved_at) VALUES (?, ?, ?, datetime('now'))").run(key, 'Парк Авионче', 'offline');
  console.log('  Cache set to: "Парк Авионче" [offline]');
  const svc3 = new LandmarkService(db, { offlineMap, osm: true });
  const r3 = await svc3.resolve({ eb: 89, address: 'Бул. АСНОМ Бр.134', location: 'Аеродром' });
  console.log(`  Result: "${r3.landmark}" (${r3.source})`);
  console.log(`  ${r3.landmark === 'Парк Авионче' ? '✅ PASS — offline cache served' : '❌ FAIL'}`);

  // Clean up
  db.db.prepare('DELETE FROM landmarks WHERE address_key = ?').run(key);
  console.log('\nCache cleaned up.');
}

main().catch(console.error);
