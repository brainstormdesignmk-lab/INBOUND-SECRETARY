import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { LandmarkStore, landmarkCacheKey, extractDetailsLandmark } from '../src/geo/landmarks';
import { PropertyService } from '../src/data/properties';

(async () => {
  const cfg = loadConfig();
  const db = new Db(cfg.dbPath);
  const store = new LandmarkStore(db);

  const props = new PropertyService(cfg.feedUrl);
  const all = await props.getAll();
  const p78 = all.find(p => p.eb === 78);
  if (!p78) { console.log('EB 78 not found in feed'); process.exit(0); }

  console.log('=== EB 78 from feed ===');
  console.log('address:', p78.address);
  console.log('location:', p78.location);
  console.log('landmark (stored):', p78.landmark);
  console.log('details (first 500):', p78.details?.substring(0, 500));
  console.log('landmarks:', JSON.stringify((p78 as any).landmarks, null, 2));

  // Check cache
  const key = landmarkCacheKey(p78);
  console.log('\nCache key:', key);
  const cached = store.get(key);
  console.log('Cached:', cached ? cached.landmark + ' [' + cached.source + ']' : 'EMPTY');

  // Check details extraction
  const detailLandmark = extractDetailsLandmark(p78.details);
  console.log('Details extraction:', detailLandmark ?? 'none');

  db.close();
})();
