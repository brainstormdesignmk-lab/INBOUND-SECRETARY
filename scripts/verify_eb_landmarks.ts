import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { PropertyService } from '../src/data/properties';

async function main() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const om = new OfflineMapStore(cfg.skopjePoisDb ?? 'data/skopje-pois.db');
  console.log('offlineMap available:', om.available);
  const lm = new LandmarkService(db, { offlineMap: om, osm: false });

  const ps = new PropertyService(cfg.propertyDataUrl);
  const all = await ps.getAll();

  for (const eb of [80, 78, 76]) {
    const p = all.find(x => x.eb === eb);
    if (!p) { console.log(`EB ${eb}: NOT FOUND`); continue; }
    console.log(`\n=== EB ${eb}: address=${JSON.stringify(p.address)} location=${JSON.stringify(p.location)} ===`);

    // Full resolve (what enrich() does)
    const l = await lm.resolve(p);
    console.log('resolve:', l.landmark ? `${l.landmark} [${l.source}]` : '(none)');
    p.landmark = l.landmark || undefined;

    // Rotation
    const near = lm.nearbyLandmarks({ eb, address: p.address, location: p.location, landmark: l.landmark || undefined });
    near.forEach((n, i) => console.log(`  #${i + 1} ${n.landmark} @ ${n.lat},${n.lon}`));
  }
}
main().catch(console.error);
