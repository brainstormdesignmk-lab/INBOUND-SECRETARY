import '../src/compat/node16';

import { loadConfig } from '../src/config';

async function main() {
  const cfg = loadConfig();
  const resp = await fetch(cfg.propertyDataUrl);
  const raw = await resp.json() as any;
  const data = raw.properties;
  
  console.log(`Found ${data.length} properties`);
  
  // Find EB 76
  const eb76 = data.find((p: any) => String(p.evidenten_broj) === '76');
  if (eb76) {
    console.log('\nEB 76 from feed:');
    console.log(JSON.stringify(eb76, null, 2));
  } else {
    console.log('EB 76 not found by evidenten_broj');
    // Try other fields
    const found = data.filter((p: any) => {
      const str = JSON.stringify(p).toLowerCase();
      return str.includes('васил') || str.includes('crnogorska') || str.includes('црногорска');
    });
    console.log(`Found ${found.length} matching Васил/Црногорска`);
    found.forEach((f: any) => console.log(JSON.stringify(f, null, 2)));
  }
}

main().catch(console.error);
