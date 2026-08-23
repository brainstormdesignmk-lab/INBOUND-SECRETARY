import { classifyOffensive, normalize } from '../src/antiabuse/offensive.js';

const tests = [
  // Original reported
  'PUSI KUR MA TAMU',
  'ZEMI GO NA USTA',
  // User-requested variants
  'ZEMI GO U USTA',
  'lapni go',
  'lizi go',
  'go sakas odpozadi',
  'da ti go turam',
  // Must NOT flag (false positives)
  'turam se kon tebe',
  'odzadi e stanot',
  'gradi se',
  'lapa supa',
  'liza ulica',
];
for (const t of tests) {
  const norm = normalize(t);
  const r = classifyOffensive(t);
  const flag = r.isOffensive ? '🔴' : '🟢';
  console.log(`${flag} "${t}" → norm="${norm}" offensive=${r.isOffensive} sev=${r.severity} reason=${r.reason ?? '—'}`);
}
