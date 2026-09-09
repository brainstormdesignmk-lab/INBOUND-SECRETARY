import { PropertyService } from '../src/data/properties.ts';
import { loadConfig } from '../src/config.ts';
import { OfflineMapStore } from '../src/geo/offlineMap.ts';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const cfg = loadConfig();
  const props = new PropertyService(cfg.propertyDataUrl);
  const all = await props.getAll();
  const p = all.find(x => x.eb === 80);
  if (!p) { console.log('EB 80 not found'); return; }
  console.log('=== EB 80 from feed ===');
  console.log('address:', JSON.stringify(p.address));
  console.log('location:', JSON.stringify(p.location));
  console.log('landmark:', JSON.stringify(p.landmark));
  console.log('\n=== details ===');
  console.log(p.details ?? p.description ?? '(none)');

  const om = new OfflineMapStore(cfg.skopjePoisDb);
  console.log('\n=== Geocoding ===');
  const geo = om.available ? om.geocodeAddress(p.address ?? '') : undefined;
  console.log('geocodeAddress:', geo);

  console.log('\n=== findPoiByName checks ===');
  for (const name of [p.address ?? '', p.location ?? '', 'Борис Трајковски', 'Стадион Борис Трајковски'].filter(Boolean)) {
    const poi = om.findPoiByName(name);
    console.log(`findPoiByName(${JSON.stringify(name)}):`, poi ? `${poi.name} (${poi.type}) @ ${poi.lat},${poi.lon}` : undefined);
  }

  if (geo) {
    console.log('\n=== nearestPois(geo, 150m) ===');
    for (const po of om.nearestPois(geo!.lat, geo!.lon, 150, 10)) {
      console.log(`  ${po.name} [${po.type}] ${po.distance_m}m`);
    }
  }
}
main().catch(console.error);
