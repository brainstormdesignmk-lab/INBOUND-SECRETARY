import { detectExactAddressAsk, detectWhereIs } from '../src/llm/deterministic';

interface TestCase {
  msg: string;
  expected: 'privacy' | 'where-is' | 'neither';
  scenario: string;
}

const cases: TestCase[] = [
  // ── CATEGORY 1: Explicit exact-address asks ──
  { msg: 'поточно која улица?', expected: 'privacy', scenario: '1a' },
  { msg: 'точно која адреса?', expected: 'privacy', scenario: '1b' },
  { msg: 'на која адреса е?', expected: 'privacy', scenario: '1c' },
  { msg: 'која е точната локација?', expected: 'privacy', scenario: '1d' },
  { msg: 'каде е точната адреса?', expected: 'privacy', scenario: '1e' },
  { msg: 'каде точно?', expected: 'privacy', scenario: '1f' },
  { msg: 'kazi mi kade tochno e', expected: 'privacy', scenario: '1g' },
  { msg: 'кажи ми ја адресата', expected: 'privacy', scenario: '1h' },
  { msg: 'Moram da znam kade e', expected: 'privacy', scenario: '1i' },
  { msg: 'Треба да знам каде е', expected: 'privacy', scenario: '1j' },
  { msg: 'tochno kade e stanot?', expected: 'privacy', scenario: '1k' },
  { msg: 'tochno kade e?', expected: 'privacy', scenario: '1l' },

  // ── CATEGORY 2: Persistent follow-ups ──
  { msg: 'te prasav za lokacija na stanot', expected: 'privacy', scenario: '2a' },
  { msg: 'те прашав за локација на станот', expected: 'privacy', scenario: '2b' },
  { msg: 'ova e lokacija na parkot', expected: 'privacy', scenario: '2c' },
  { msg: 'ова е локација на паркот', expected: 'privacy', scenario: '2d' },
  { msg: 'tochnata lokacija?', expected: 'privacy', scenario: '2e' },
  { msg: 'точната локација?', expected: 'privacy', scenario: '2f' },
  { msg: 'te prasam za adresa na stanot', expected: 'privacy', scenario: '2g' },

  // ── CATEGORY 3: Generic where-is (→ landmark answer, NOT privacy) ──
  { msg: 'kade mu e adresata?', expected: 'where-is', scenario: '3a' },
  { msg: 'кај му е адресата', expected: 'where-is', scenario: '3b' },
  { msg: 'kade mu e lokacijata?', expected: 'where-is', scenario: '3c' },
  { msg: 'kazi mi kade mu e lokacijata?', expected: 'where-is', scenario: '3d' },
  { msg: 'dokade e adresata?', expected: 'where-is', scenario: '3e' },

  // ── CATEGORY 4: Neither (fall through to classifier/LLM) ──
  { msg: 'dali e dostapen?', expected: 'neither', scenario: '4a' },
  { msg: 'колку чини?', expected: 'neither', scenario: '4b' },
  { msg: 'kako 500 den?', expected: 'neither', scenario: '4c' },
  { msg: 'zdravo', expected: 'neither', scenario: '4d' },

  // ── CATEGORY 5: Edge cases ──
  { msg: 'tochna adresa?', expected: 'privacy', scenario: '5a' },
  { msg: 'kazi ja adresata', expected: 'privacy', scenario: '5b' },
  { msg: 'кажи ја адресата', expected: 'privacy', scenario: '5c' },
];

let pass = 0, fail = 0;
for (const c of cases) {
  const exactAddr = detectExactAddressAsk(c.msg);
  const whereIs = detectWhereIs(c.msg);
  let actual: 'privacy' | 'where-is' | 'neither';
  if (exactAddr) actual = 'privacy';
  else if (whereIs) actual = 'where-is';
  else actual = 'neither';

  if (actual === c.expected) { pass++; }
  else { fail++; console.log(`❌ ${c.scenario}: "${c.msg}" → expected ${c.expected}, got ${actual}`); }
}
console.log(`\n${pass}/${pass + fail} pass`);
