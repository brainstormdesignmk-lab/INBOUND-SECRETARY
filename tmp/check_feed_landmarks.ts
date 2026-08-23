import { loadProperties } from '../src/data/properties.js';
import { LandmarkService } from '../src/geo/landmarks.js';
import { OfflineMapStore } from '../src/geo/offlineMap.js';
import { Db } from '../src/store/db.js';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const db = new Db(path.join(process.cwd(), 'data', 'lina.db'));
  const props = await loadProperties(db);
  const eb89 = props.find(p => p.eb === 89);
  if (!eb89) { console.log('EB 89 not found'); process.exit(1); }

  console.log('=== EB 89 property ===');
  console.log('address:', eb89.address);
  console.log('location:', eb89.location);
  console.log('landmarks (feed):', JSON.stringify(eb89.landmarks, null, 2));
  console.log('landmark (single):', eb89.landmark);
  console.log('details:', eb89.details?.substring(0, 200));

  // Now resolve with the offline map
  const offlineMap = new OfflineMapStore(
    process.env.SKOPJE_POIS_DB || path.join(process.cwd(), 'data', 'skopje-pois.db')
  );
  const svc = new LandmarkService(db, {
    offlineMap,
    osm: false,
  });

  const result = await svc.resolve({
    eb: 89,
    address: eb89.address,
    location: eb89.location,
    details: eb89.details,
    landmarks: eb89.landmarks,
  });
  console.log('\n=== Resolve result ===');
  console.log(JSON.stringify(result, null, 2));

  // What the TUI sends
  console.log('\n=== Property card inputs ===');
  console.log(JSON.stringify({
    eb: eb89.eb,
    address: eb89.address,
    location: eb89.location,
    hasFeedLandmarks: !!eb89.landmarks && eb89.landmarks.length > 0,
    feedLandmarkCount: eb89.landmarks?.length ?? 0,
  }, null, 2));
}

main().catch(console.error);
