import { buildPropertyCard } from '../src/llm/prompts.js';
import { LandmarkService } from '../src/geo/landmarks.js';
import { OfflineMapStore } from '../src/geo/offlineMap.js';
import { Db } from '../src/store/db.js';
import * as path from 'path';

async function main() {
  const dbPath = path.join(process.cwd(), 'data', 'lina.db');
  const skopjeDb = path.join(process.cwd(), 'data', 'skopje-pois.db');
  const db = new Db(dbPath);
  const offlineMap = new OfflineMapStore(skopjeDb);
  const svc = new LandmarkService(db, { offlineMap });

  // Clear cache
  db.db.prepare('DELETE FROM landmarks').run();

  const prop = {
    eb: 89,
    address: 'Бул. АСНОМ Бр.134',
    location: 'Аеродром',
    size: '70 м²',
    bedrooms: 2,
    price: 110000,
    features: ['лифт', 'парно', 'јавен паркинг', 'наместен'],
    details: 'Станот е стар и се е функционално. Во него се живееше до пред 2 месеци.. Одлична локација со убав поглед од балконите кон Мерцедес и авиончето.',
  } as any;

  console.log('Before enrich:', prop.landmark);
  await svc.enrich([prop]);
  console.log('After enrich:', prop.landmark);

  const card = buildPropertyCard(prop);
  console.log('\nCard output:\n' + card);
}

main().catch(console.error);
