import { buildEvent, extractSlots, detectWidenIntent } from '../src/llm/deterministic';

const text = 'I TOA I TOA';
console.log('=== "I TOA I TOA" ===');
console.log('detectWidenIntent:', detectWidenIntent(text));
console.log('extractSlots:', extractSlots(text));

// Test various "both" expressions
const boths = [
  'I toa i toa', 'KE KUPAM I KIRIJAM', 'I kupam i iznajmuvam',
  'za dvete', 'i za kupuvanje i za iznajmuvanje', 'KE TREBAAT I I I I',
  'I DUKJAN', 'DUKJAN', 'STAN', 'PLAC',
  'KE KUPAM DUKJAN', 'SAKAM DUKJAN',
  'KE TREBA STAN', 'KUKJA MI TREBA',
];
console.log('\n=== Intent detection ===');
for (const t of boths) {
  const w = detectWidenIntent(t);
  const s = extractSlots(t);
  console.log(`"${t}" → widen:${w} intent:${s.intent} type:${s.propertyType} service:${s.service}`);
}
