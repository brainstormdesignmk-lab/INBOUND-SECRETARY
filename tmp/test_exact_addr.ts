import { detectExactAddressAsk, detectWhereIs } from '../src/llm/deterministic';
const tests: [string, boolean][] = [
  ['te prasav za lokacija na stanot', true],
  ['те прашав за локација на станот', true],
  ['ova e lokacija na parkot', true],
  ['ова е локација на паркот', true],
  ['tochnata lokacija?', true],
  ['точната локација?', true],
  ['kazi mi kade tochno e', true],
  ['кажи ми ја адресата', true],
  ['potocno koja ulica?', true],
  ['kade mu e adresata?', false],
  ['dali e dostapen?', false],
  ['колку чини?', false],
];
let pass = 0, fail = 0;
for (const [t, expected] of tests) {
  const e = detectExactAddressAsk(t);
  if (e === expected) { pass++; console.log('✅ ' + t); }
  else { fail++; console.log('❌ ' + t + ' — expected ' + expected + ' got ' + e); }
}
console.log(pass + ' pass, ' + fail + ' fail');
