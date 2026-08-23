import { PropertyService } from '../src/data/properties.js';
import { loadConfig } from '../src/config.js';
import * as dotenv from 'dotenv';
dotenv.config();

async function main() {
  const cfg = loadConfig();
  const props = new PropertyService(cfg.propertyDataUrl);
  const all = await props.getAll();
  const eb89 = all.find(p => p.eb === 89);
  if (!eb89) {
    console.log('EB 89 not found in feed');
    console.log('Available EBs:', all.map(p => p.eb).sort((a,b) => a-b).join(', '));
    return;
  }
  console.log('=== EB 89 from feed ===');
  console.log('address:', eb89.address);
  console.log('location:', eb89.location);
  console.log('landmark:', eb89.landmark);
  console.log('landmarks (feed):', JSON.stringify(eb89.landmarks, null, 2));
  console.log('details:', eb89.details?.substring(0, 300));
  console.log('gmaps:', eb89.gmaps);
  console.log('Full:', JSON.stringify(eb89, null, 2));
}

main().catch(console.error);
