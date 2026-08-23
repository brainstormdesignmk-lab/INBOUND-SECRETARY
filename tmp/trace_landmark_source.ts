import { LandmarkService, extractDetailsLandmark } from '../src/geo/landmarks.js';
import { OfflineMapStore } from '../src/geo/offlineMap.js';
import { Db } from '../src/store/db.js';
import * as path from 'path';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const offlineMap = new OfflineMapStore(
    process.env.SKOPJE_POIS_DB || path.join(process.cwd(), 'data', 'skopje-pois.db')
  );
  const db = new Db(path.join(process.cwd(), 'data', 'lina.db'));

  // The EXACT description from Supabase for EB 89
  const details = 'Станот е стар и се е функционално. Во него се живееше до пред 2 месеци.. Одлична локација со убав поглед од балконите кон Мерцедес и авиончето. Многу простор пред зградата. Чист имотен лист..58м2 + 12м2 балкони +4м2 подиум..';

  // Check: does extractDetailsLandmark pick up anything?
  console.log('=== Details extraction ===');
  console.log('Input:', details);
  console.log('Extracted:', extractDetailsLandmark(details));

  // Also check with a "кај" prefix test
  const testDetails = 'кај Златна Вилушка во Аеродром';
  console.log('\n=== Test with кај prefix ===');
  console.log('Input:', testDetails);
  console.log('Extracted:', extractDetailsLandmark(testDetails));

  // Resolve from scratch
  const svc = new LandmarkService(db, { offlineMap, osm: false });
  const result = await svc.resolve({
    eb: 89,
    address: 'Бул. АСНОМ Бр.134',
    location: 'Аеродром',
    details,
  });
  console.log('\n=== Resolve result ===');
  console.log(JSON.stringify(result, null, 2));
}

main().catch(console.error);
