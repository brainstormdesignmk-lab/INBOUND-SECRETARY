import { detectExactAddressAsk, detectWhereIs } from '../src/llm/deterministic';

interface TestCase {
  msg: string;
  expected: 'privacy' | 'where-is' | 'neither';
  scenario: string;
}

const cases: TestCase[] = [
  // ── CATEGORY 1: Explicit exact-address asks ──
  { msg: 'поточно која улица?', expected: 'privacy', scenario: '1a. potocno koja ulica' },
  { msg: 'точно која адреса?', expected: 'privacy', scenario: '1b. tocno koja adresa' },
  { msg: 'на која адреса е?', expected: 'privacy', scenario: '1c. na koja adresa e' },
  { msg: 'која е точната локација?', expected: 'privacy', scenario: '1d. koja e tocnata lokacija' },
  { msg: 'каде е точната адреса?', expected: 'privacy', scenario: '1e. kade e tocnata adresa' },
  { msg: 'каде точно?', expected: 'privacy', scenario: '1f. kade tocno' },
  { msg: 'kazi mi kade tochno e', expected: 'privacy', scenario: '1g. kazi mi kade tochno e' },
  { msg: 'кажи ми ја адресата', expected: 'privacy', scenario: '1h. kazi mi ja adresata' },
  { msg: 'Moram da znam kade e', expected: 'privacy', scenario: '1i. moram da znam kade e' },
  { msg: 'Треба да знам каде е', expected: 'privacy', scenario: '1j. treba da znam kade e' },
  { msg: 'tochno kade e stanot?', expected: 'privacy', scenario: '1k. tochno kade e stanot' },
  { msg: 'tochno kade e?', expected: 'privacy', scenario: '1l. tochno kade e (short)' },

  // ── CATEGORY 2: Persistent follow-ups ──
  { msg: 'te prasav za lokacija na stanot', expected: 'privacy', scenario: '2a. te prasav za lokacija' },
  { msg: 'те прашав за локација на станот', expected: 'privacy', scenario: '2b. те прашав за локација' },
  { msg: 'ova e lokacija na parkot', expected: 'privacy', scenario: '2c. ova e lokacija na parkot' },
  { msg: 'ова е локација на паркот', expected: 'privacy', scenario: '2d. ова е локација на паркот' },
  { msg: 'tochnata lokacija?', expected: 'privacy', scenario: '2e. tochnata lokacija' },
  { msg: 'точната локација?', expected: 'privacy', scenario: '2f. точната локација' },
  { msg: 'te prasam za adresa na stanot', expected: 'privacy', scenario: '2g. te prasam za adresa (present tense)' },

  // ── CATEGORY 3: Generic where-is ──
  { msg: 'kade mu e adresata?', expected: 'where-is', scenario: '3a. kade mu e adresata' },
  { msg: 'кај му е адресата', expected: 'where-is', scenario: '3b. кај му е адресата' },
  { msg: 'kade mu e lokacijata?', expected: 'where-is', scenario: '3c. kade mu e lokacijata' },
  { msg: 'kazi mi kade mu e lokacijata?', expected: 'where-is', scenario: '3d. kazi mi kade mu e lokacijata' },
  { msg: 'kade mu e dostapen?', expected: 'where-is', scenario: '3e. kade mu e dostapen (where-is, dostapen NOT blacklisted in this context)' },

  // ── CATEGORY 4: Should NOT trigger privacy ──
  { msg: 'dali e dostapen?', expected: 'neither', scenario: '4a. dali e dostapen (availability)' },
  { msg: 'колку чини?', expected: 'neither', scenario: '4b. kolku chini (price)' },
  { msg: 'kako 500 den?', expected: 'neither', scenario: '4c. kako 500 den (fee why)' },
  { msg: 'zdravo', expected: 'neither', scenario: '4d. greeting' },

  // ── CATEGORY 5: Edge cases ──
  { msg: 'tochna adresa?', expected: 'privacy', scenario: '5a. tochna adresa (short, no koja)' },
  { msg: 'dokade e adresata?', expected: 'where-is', scenario: '5b. dokade e adresata (dokade variant)' },
  { msg: 'kazi ja adresata', expected: 'privacy', scenario: '5c. kazi ja adresata (short Latin)' },
  { msg: 'кажи ја адресата', expected: 'privacy', scenario: '5d.кажи ја адресата (short Cyrillic)' },
];

let privacyPass = 0, privacyFail = 0;
let whereIsPass = 0, whereIsFail = 0;
let neitherPass = 0, neitherFail = 0;

for (const c of cases) {
  const exactAddr = detectExactAddressAsk(c.msg);
  const whereIs = detectWhereIs(c.msg);

  let actual: 'privacy' | 'where-is' | 'neither';
  if (exactAddr) actual = 'privacy';
  else if (whereIs) actual = 'where-is';
  else actual = 'neither';

  const ok = actual === c.expected;

  if (c.expected === 'privacy') { if (ok) privacyPass++; else privacyFail++; }
  else if (c.expected === 'where-is') { if (ok) whereIsPass++; else whereIsFail++; }
  else { if (ok) neitherPass++; else neitherFail++; }

  if (!ok) {
    console.log(`❌ ${c.scenario}`);
    console.log(`   "${c.msg}" → expected ${c.expected}, got ${actual}`);
    console.log(`   exactAddr=${exactAddr}, whereIs=${JSON.stringify(whereIs)}`);
  }
}

console.log(`\n═══ SUMMARY ═══`);
console.log(`Privacy:  ${privacyPass} pass, ${privacyFail} fail`);
console.log(`Where-is: ${whereIsPass} pass, ${whereIsFail} fail`);
console.log(`Neither:  ${neitherPass} pass, ${neitherFail} fail`);
console.log(`Total:    ${privacyPass + whereIsPass + neitherPass} pass, ${privacyFail + whereIsFail + neitherFail} fail`);
