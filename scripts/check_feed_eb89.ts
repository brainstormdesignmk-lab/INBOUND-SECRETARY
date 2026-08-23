import { PropertyService } from '../src/data/properties.ts';
import { loadConfig } from '../src/config.ts';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const cfg = loadConfig();
  const props = new PropertyService(cfg.propertyDataUrl);
  const all = await props.getAll();
  const eb89 = all.find(p => p.eb === 89);
  if (!eb89) { console.log('EB 89 not found'); return; }
  console.log('=== EB 89 from feed ===');
  console.log('address:', eb89.address);
  console.log('location:', eb89.location);
  console.log('landmark:', eb89.landmark);
  console.log('landmarks (feed):', JSON.stringify(eb89.landmarks, null, 2));
  console.log('details:', eb89.details?.substring(0, 300));
}
main().catch(console.error);
