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

  const svc = new LandmarkService(db, { offlineMap, osm: false });

  for (const eb of [89, 90] as const) {
    const address = eb === 89 ? 'Бул. АСНОМ Бр.134' : 'Локов 5';
    const location = eb === 89 ? 'Аеродром' : 'Кисела Вода';

    // Clear cache for fresh resolution
    const key = landmarkCacheKey({ address, location });
    try { db.db.prepare('DELETE FROM landmarks WHERE address_key = ?').run(key); } catch {}

    console.log(`\n${'='.repeat(60)}`);
    console.log(`  EB ${eb}: ${address} (${location})`);
    console.log(`${'='.repeat(60)}`);

    // 1. Main resolve (what the card says)
    const main = await svc.resolve({ eb, address, location });
    console.log(`\n  Main landmark: "${main.landmark}" (${main.source})`);
    console.log(`  Card: Се наоѓа во близина на ${main.landmark}.`);

    // 2. Nearby landmarks (rotation for "каде?")
    const nearby = svc.nearbyLandmarks({ eb, address, location });
    console.log(`\n  Nearby landmarks (${nearby.length} for rotation):`);
    for (let i = 0; i < nearby.length; i++) {
      const n = nearby[i];
      const prefix = i === 0 ? '"каде?"' : i === 1 ? '"каде поточно?"' : '"а друго што?"';
      const gmaps = i > 0 ? ` → https://www.google.com/maps/search/?api=1&query=${n.lat},${n.lon}` : '';
      console.log(`    ${i + 1}. ${prefix} → "${n.landmark}" (${n.lat}, ${n.lon})${gmaps}`);
    }

    // 3. Simulate the rotation as the handler would
    console.log(`\n  === Simulating rotation ===`);
    const landmarks = nearby.map(n => n.landmark);
    const coords = nearby.map(n => ({ lat: n.lat, lon: n.lon }));
    let idx = 0;
    for (let turn = 0; turn < 5; turn++) {
      const lm = landmarks[idx] ?? main.landmark;
      const coord = coords[idx];
      const gmapsLine = (idx > 0) && coord
        ? `\n    https://www.google.com/maps/search/?api=1&query=${coord.lat},${coord.lon}`
        : '';
      console.log(`  Turn ${turn + 1}: "во близина на ${lm}.${gmapsLine}"`);
      if (idx < landmarks.length - 1) idx++;
    }
  }
}

main().catch(console.error);
