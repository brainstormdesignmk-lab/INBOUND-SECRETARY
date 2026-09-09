import { loadConfig } from '../src/config';
import { PropertyService } from '../src/data/properties';

(async () => {
  const cfg = loadConfig();
  console.log('feedUrl:', cfg.propertyDataUrl);
  const props = new PropertyService(cfg.propertyDataUrl);
  const all = await props.getAll();
  console.log('Total properties:', all.length);
  const p78 = all.find(p => p.eb === 78);
  if (p78) {
    console.log('\nEB 78 from feed:');
    console.log('  address:', p78.address);
    console.log('  location:', p78.location);
    console.log('  landmark:', p78.landmark);
    const landmarks = (p78 as any).landmarks;
    if (landmarks) {
      console.log('  landmarks (' + landmarks.length + '):');
      landmarks.forEach((l: any, i: number) => console.log('    ' + (i+1) + '.', JSON.stringify(l)));
    } else {
      console.log('  landmarks: (none)');
    }
  } else {
    console.log('EB 78 not found');
  }
})();
