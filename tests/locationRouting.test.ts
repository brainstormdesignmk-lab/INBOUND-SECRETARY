// Location-question routing regression tests — the "same question, different
// phrasing" bug class. Any каде/kade-prefixed question about адреса/локација
// must route to WHERE_IS (landmark rotation); only explicit demands without
// каде ("улица и број", "дај ми ја адресата") get the privacy protocol.
//
// The LANDMARK cases are GENERATED (prefix × fillers × noun matrix) so new
// phrasings are covered by construction, not by remembering to add them.
import { test } from 'node:test';
import assert from 'node:assert';
import { detectWhereIs, detectExactAddressAsk } from '../src/llm/deterministic';

/** The handler's actual routing rule: EXACT_ADDRESS only wins when it is
 *  NOT a where-is. Mirrors inbound.ts line ~250. */
function routesTo(text: string): 'LANDMARK' | 'PROTOCOL' | 'OTHER' {
  const w = detectWhereIs(text);
  const e = detectExactAddressAsk(text);
  if (e && !w) return 'PROTOCOL';
  if (w) return 'LANDMARK';
  return 'OTHER';
}

test('generated каде-matrix: every prefix×filler×noun combo is LANDMARK', () => {
  const prefixes = ['каде', 'kade', 'KADE', 'Каде'];
  const fillers = [
    '', ' точно', ' поточно', ' mu e', ' му е', ' ми е', ' samo e',
    ' се наоѓа', ' se naogja', ' bi bila', ' bi bilo', ' ќе биде',
  ];
  const nouns = ['адресата', 'adresata', 'локацијата', 'lokacijata', 'адреса', 'adresa', 'локација'];
  let checked = 0;
  for (const p of prefixes) {
    for (const f of fillers) {
      for (const n of nouns) {
        const text = `${p}${f} ${n}?`;
        assert.equal(routesTo(text), 'LANDMARK', `expected LANDMARK for ${JSON.stringify(text)}`);
        checked++;
      }
    }
  }
  assert.ok(checked >= 300, `matrix should cover 300+ combos, got ${checked}`);
});

test('explicit demands without каде stay PROTOCOL', () => {
  const demands = [
    'ulica i broj ?', 'улица и број?',
    'daj mi ja adresata', 'дај ми ја адресата',
    'moram da znam adresata', 'морам да знам адресата',
    'prvo adresata', 'прво адресата',
    'koja e tocnata adresa', 'која е точната адреса',
    'molam adresata', 'адресата ве молам',
    'sakam da znam lokacijata',
    'koj katastar?', 'adresa sega',
  ];
  for (const t of demands) {
    assert.equal(routesTo(t), 'PROTOCOL', `expected PROTOCOL for ${JSON.stringify(t)}`);
  }
});

test('named-place queries keep place extraction (not generic)', () => {
  const ramstor = detectWhereIs('kade se naogja Ramstor ?');
  assert.ok(ramstor && !ramstor.generic && /ramstor/i.test(ramstor.place));
  // "каде е улицата Партизанска?" — улица deliberately excluded from the
  // address-noun rule so the street name stays extractable.
  const street = detectWhereIs('каде е улицата Партизанска?');
  assert.ok(street && !street.generic && /Партизанска/i.test(street.place));
});

test('the original bug phrases route to LANDMARK', () => {
  assert.equal(routesTo('KAZI MI SAMO KADE MU E LOKACIJATA ?'), 'LANDMARK');
  assert.equal(routesTo('KADE MU E LOKACIJATA ?'), 'LANDMARK');
  assert.equal(routesTo('kade mu e adresata'), 'LANDMARK');
});
