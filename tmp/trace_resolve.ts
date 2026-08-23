// Patch buildPropertyCard to trace the landmark source
import { buildPropertyCard } from '../src/llm/prompts.js';
import * as fs from 'fs';

const originalBPC = buildPropertyCard;
// Monkey-patch won't work on exports. Instead, let's just trace the enrich function.

// Alternative: add a log inside the TUI's property card rendering
const logFile = '/tmp/landmark-trace.log';

// Let's create a simple script that calls the same pipeline as the TUI
import { LandmarkService, landmarkCacheKey } from '../src/geo/landmarks.js';
import { OfflineMapStore } from '../src/geo/offlineMap.js';
import { Db } from '../src/store/db.js';
import * as path from 'path';

const db = new Db(path.join(process.cwd(), 'data', 'lina.db'));
const offlineMap = new OfflineMapStore(path.join(process.cwd(), 'data/skopje-pois.db'));
const svc = new LandmarkService(db, { offlineMap });

// Read the property exactly as the TUI would
const allData = db.db.prepare('SELECT * FROM landmarks').all();
console.log('Current DB landmarks:', JSON.stringify(allData));

// Clear and test
db.db.prepare('DELETE FROM landmarks').run();

const prop = {
  eb: 89,
  address: 'Бул. АСНОМ Бр.134', // exact address from feed
  location: 'Аеродром',
};

console.log('\n=== Step-by-step resolve ===');
console.log('1. Feed landmarks:', prop.landmarks);

const key = landmarkCacheKey(prop);
console.log('2. Cache key:', key);
console.log('3. DB cache:', db.db.prepare('SELECT * FROM landmarks WHERE address_key = ?').get(key));

// Call resolve directly
const result = await svc.resolve(prop);
console.log('4. Resolve result:', JSON.stringify(result));

// Check DB cache after
console.log('5. DB cache after:', db.db.prepare('SELECT * FROM landmarks WHERE address_key = ?').get(key));
