import { detectWhereIs } from '../src/llm/deterministic.js';

const tests = [
  'STO IMA VO BLIZINA ?',
  'shto ima vo blizina',
  'what is nearby',
  'kade se naogja ?',
  'stso ima vo blizina',
  'shto ima okolu',
  'blizina',
  'ima vo blizina nesto',
  'shto imate vo blizina',
  'sto imate vo blizina',
];
for (const t of tests) {
  const r = detectWhereIs(t);
  console.log(`"${t}" → ${r ? JSON.stringify(r) : 'undefined'}`);
}
