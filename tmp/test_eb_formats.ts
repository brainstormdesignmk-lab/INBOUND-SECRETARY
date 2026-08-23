import { detectWhereIs } from '../src/llm/deterministic';

const tests = [
  'каде се наоѓа 89',
  'каде е 89',
  'каде се наоѓа 89?',
  'каде е број 89',
  'КАДЕ Е 89',
  'каде е евидентен број 89',
  'kade e 89',
  'kade se naogja 89',
  'каде се наоѓа евидентен број 89',
  'каде е станот',
  'каде?',
  'kade e broj 89',
  'каде е еб 89',
];

for (const t of tests) {
  const r = detectWhereIs(t);
  console.log(`"${t}" → ${JSON.stringify(r)}`);
}
