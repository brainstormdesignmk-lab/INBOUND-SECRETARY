import { PropertyService } from '../src/data/properties.ts';
import { loadConfig } from '../src/config.ts';
async function main() {
const cfg = loadConfig();
const ps = new PropertyService(cfg.propertyDataUrl);
const all = await ps.getAll();
const p = all.find(p => p.eb === 89);
console.log('EB 89 feed landmark:', JSON.stringify(p?.landmark));
console.log('EB 89 feed landmarks:', JSON.stringify(p?.landmarks));
console.log('EB 89 address:', JSON.stringify(p?.address));
}
main();
