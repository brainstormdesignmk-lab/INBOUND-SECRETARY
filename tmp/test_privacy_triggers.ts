import { detectExactAddressAsk, detectWhereIs } from '../src/llm/deterministic';

// ═══════════════════════════════════════════════════════════════
// SCENARIO MAP: When should the privacy line fire?
// ═══════════════════════════════════════════════════════════════

interface TestCase {
  msg: string;
  expected: 'privacy' | 'where-is' | 'neither';
  scenario: string;
}

const cases: TestCase[] = [
  // ── CATEGORY 1: Explicit exact-address asks ──
  { msg: 'поточно која улица?', expected: 'privacy', scenario: '1a. potocno koja ulica (standard)' },
  { msg: 'точно која адреса?', expected: 'privacy', scenario: '1b. tocno koja adresa' },
  { msg: 'на која адреса е?', expected: 'privacy', scenario: '1c. na koja adresa e' },
  { msg: 'која е точната локација?', expected: 'privacy', scenario: '1d. koja e tocnata lokacija' },
  { msg: 'каде е точната адреса?', expected: 'privacy', scenario: '1e. kade e tocnata adresa' },
  { msg: 'каде точно?', expected: 'privacy', scenario: '1f. kade tocno (short)' },
  { msg: 'kazi mi kade tochno e', expected: 'privacy', scenario: '1g. kazi mi kade tochno e (Latin)' },
  { msg: 'кажи ми ја адресата', expected: 'privacy', scenario: '1h. kazi mi ja adresata' },
  { msg: 'Moram da znam kade e', expected: 'privacy', scenario: '1i. moram da znam kade e' },
  { msg: 'Треба да знам каде е', expected: 'privacy', scenario: '1j. treba da znam kade e' },

  // ── CATEGORY 2: Persistent follow-ups after landmark answer ──
  { msg: 'te prasav za lokacija na stanot', expected: 'privacy', scenario: '2a. te prasav za lokacija (Latin)' },
  { msg: 'те прашав за локација на станот', expected: 'privacy', scenario: '2b. те прашав за локација (Cyrillic)' },
  { msg: 'ova e lokacija na parkot', expected: 'privacy', scenario: '2c. ova e lokacija na parkot (pushback)' },
  { msg: 'ова е локација на паркот', expected: 'privacy', scenario: '2d. ова е локација на паркот' },
  { msg: 'tochnata lokacija?', expected: 'privacy', scenario: '2e. tochnata lokacija (Latin)' },
  { msg: 'точната локација?', expected: 'privacy', scenario: '2f. точната локација (Cyrillic)' },
  { msg: 'te prasam za adresa na stanot', expected: 'privacy', scenario: '2g. te prasam za adresa (present tense)' },
  { msg: 'te prasav za adresata', expected: 'privacy', scenario: '2h. te prasav za adresata' },

  // ── CATEGORY 3: Direct "where is" with location/address word ──
  { msg: 'kade mu e adresata?', expected: 'where-is', scenario: '3a. kade mu e adresata (generic where-is)' },
  { msg: 'кај му е адресата', expected: 'where-is', scenario: '3b. кај му е адресата' },
  { msg: 'kade mu e lokacijata?', expected: 'where-is', scenario: '3c. kade mu e lokacijata' },
  { msg: 'кажи ми каде му е локацијата', expected: 'where-is', scenario: '3d. кажи ми каде му е локацијата' },

  // ── CATEGORY 4: Should NOT trigger privacy (should fall through to classifier/LLM) ──
  { msg: 'kade mu e dostapen?', expected: 'where-is', scenario: '4a. kade mu e dostapen (availability, not address)' },
  { msg: 'kazi mi kade mu e lokacijata?', expected: 'where-is', scenario: '4b. kazi mi kade mu e lokacijata (generic where-is)' },
  { msg: 'dali e dostapen?', expected: 'neither', scenario: '4c. dali e dostapen (availability ask)' },
  { msg: 'колку чини?', expected: 'neither', scenario: '4d. kolku chini (price question)' },
  { msg: 'kako 500 den?', expected: 'neither', scenario: '4e. kako 500 den (fee why)' },
  { msg: 'zdravo', expected: 'neither', scenario: '4f. greeting' },

  // ── CATEGORY 5: Edge cases — should fire privacy ──
  { msg: 'tochna adresa?', expected: 'privacy', scenario: '5a. tochna adresa (without "koja")' },
  { msg: 'precizna lokacija?', expected: 'neither', scenario: '5b. precizna lokacija (not caught — may need fix)' },
  { msg: 'dokade e adresata?', expected: 'where-is', scenario: '5c. dokade e adresata (where-is variant)' },
  { msg: 'tochno kade e stanot?', expected: 'privacy', scenario: '5d. tocno kade e stanot' },
  { msg: 'tochno kade e?', expected: 'privacy', scenario: '5e. tocno kade e (short)' },
  { msg: 'just tell me the address', expected: 'neither', scenario: '5f. English (not supported — falls to LLM)' },
  { msg: ' adressata mi treba', expected: 'neither', scenario: '5g. "adresata mi treba" (not caught — may need fix)' },
  { msg: 'kazi ja adresata', expected: 'privacy', scenario: '5h. kazi ja adresata (short)' },
  { msg: 'кажи ја адресата', expected: 'privacy', scenario: '5i.кажи ја адресата (short Cyrillic)' },
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
  const icon = ok ? '✅' : '❌';

  if (c.expected === 'privacy') {
    if (ok) privacyPass++; else privacyFail++;
  } else if (c.expected === 'where-is') {
    if (ok) whereIsPass++; else whereIsFail++;
  } else {
    if (ok) neitherPass++; else neitherFail++;
  }

  if (!ok) {
    console.log(`${icon} ${c.scenario}`);
    console.log(`   "${c.msg}" → expected ${c.expected}, got ${actual}`);
    console.log(`   exactAddr=${exactAddr}, whereIs=${JSON.stringify(whereIs)}`);
  }
}

console.log(`\n═══ SUMMARY ═══`);
console.log(`Privacy:  ${privacyPass} pass, ${privacyFail} fail`);
console.log(`Where-is: ${whereIsPass} pass, ${whereIsFail} fail`);
console.log(`Neither:  ${neitherPass} pass, ${neitherFail} fail`);
console.log(`Total:    ${privacyPass + whereIsPass + neitherPass} pass, ${privacyFail + whereIsFail + neitherFail} fail`);
