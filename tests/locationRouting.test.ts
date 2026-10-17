// Location-question routing regression tests — the "same question, different
// phrasing" bug class. Any каде/kade-prefixed question about адреса/локација
// routes to WHERE_IS; explicit demands without каде use EXACT_ADDRESS. Both
// handler paths share the location ladder: landmark first, protocol second.
//
// The LANDMARK cases are GENERATED (prefix × fillers × noun matrix) so new
// phrasings are covered by construction, not by remembering to add them.
import { test } from 'node:test';
import assert from 'node:assert';
import { detectWhereIs, detectExactAddressAsk } from '../src/llm/deterministic';

/** Detector precedence only. These labels do not select the response stage;
 *  the handler applies the shared ladder after routing. */
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
    // DATIVE-CLITIC fillers (the [23:50] capture): "каде ви се наоѓа …" /
    // "каде ви е …" — the clitic sits between каде and the verb and defeated
    // both the "се" slot and the address-noun filler list, so the whole matrix
    // above silently excluded the ви/ти/ни/им/си persons.
    ' ви е', ' vi e', ' ти е', ' ti e', ' ни е', ' ni e', ' им е', ' im e', ' си е',
    ' ви се наоѓа', ' vi se naogja', ' ми се наоѓа', ' mi se naogja',
    ' ти се наоѓа', ' ни се наоѓа', ' им се наоѓа',
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

test('explicit demands without каде stay in EXACT_ADDRESS', () => {
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

test('[23:50] the dative clitic is TRANSPARENT — "kade vi se naogja 77" == "kade se naogja 77"', () => {
  // The capture: "kade vi se naogja 77?" was matched by NO detector, so the
  // pipeline answered the generic service prompt ("Може ли да ми кажете дали
  // Ве интересира купување или изнајмување на имот?"). The clitic must behave
  // exactly like its absence — same place, same generic flag.
  const pairs: Array<[string, string]> = [
    ['kade vi se naogja 77?', 'kade se naogja 77?'],
    ['каде ви се наоѓа 77?', 'каде се наоѓа 77?'],
    ['kade vi e 77?', 'kade e 77?'],
    ['kade mi se naogja 41?', 'kade se naogja 41?'],
    ['kade ni se naogja 41?', 'kade se naogja 41?'],
    ['каде ви е локацијата?', 'каде е локацијата?'],
    ['каде ви е адресата?', 'каде е адресата?'],
  ];
  for (const [withClitic, without] of pairs) {
    assert.deepEqual(detectWhereIs(withClitic), detectWhereIs(without),
      `${withClitic} must classify exactly like ${without}`);
  }
  // The heard phrase itself: the Евидентен број is the PLACE, not the clitic.
  const heard = detectWhereIs('kade vi se naogja 77?');
  assert.ok(heard && !heard.generic && heard.place === '77',
    `expected place 77, got ${JSON.stringify(heard)}`);
  const heardCy = detectWhereIs('каде ви се наоѓа 77?');
  assert.ok(heardCy && !heardCy.generic && heardCy.place === '77',
    `expected place 77 (Cyrillic), got ${JSON.stringify(heardCy)}`);
  // …and an address/location NOUN after a clitic stays generic (never a place
  // name — "каде ви е локацијата" must not resolve the word "локацијата").
  for (const t of ['каде ви е локацијата?', 'каде ви е адресата?', 'kade vi e lokacijata?']) {
    const r = detectWhereIs(t);
    assert.ok(r && r.generic && r.place === '', `expected generic for ${t}, got ${JSON.stringify(r)}`);
  }
});

test('the dative clitic adds no false positives — search intents stay out, and every verdict is parity', () => {
  // Pure SEARCH intents must stay undetected, with or without the clitic.
  for (const t of [
    'kade ima nekoe stance do 250',
    'каде има станови до 250 евра',
    'kade moze da se najde parking',
    'kade vi ima nekoe stance do 250',
  ]) {
    assert.equal(detectWhereIs(t), undefined, `${t} must not become a where-is ask`);
  }
  // For everything else the ONLY correct behaviour is parity: the clitic may
  // not invent, drop or change a verdict. This includes phrases that already
  // read as where-is BEFORE this change and extract the rest as a place name
  // ("kade se naogjaat najevtinite stanovi", a pre-existing characteristic of
  // the tolerant verb+rest extraction — recorded here so a future change has
  // to make the same verdict with and without the clitic).
  const parity: Array<[string, string]> = [
    ['kade vi se naogjaat najevtinite stanovi', 'kade se naogjaat najevtinite stanovi'],
    ['kade vi e vleznata vrata na zgradata', 'kade e vleznata vrata na zgradata'],
    ['kade vi se naogja 77?', 'kade se naogja 77?'],
  ];
  for (const [withClitic, without] of parity) {
    assert.deepEqual(detectWhereIs(withClitic), detectWhereIs(without),
      `${withClitic} must classify exactly like ${without}`);
  }
});

test('the original bug phrases route to LANDMARK', () => {
  assert.equal(routesTo('KAZI MI SAMO KADE MU E LOKACIJATA ?'), 'LANDMARK');
  assert.equal(routesTo('KADE MU E LOKACIJATA ?'), 'LANDMARK');
  assert.equal(routesTo('kade mu e adresata'), 'LANDMARK');
});

test('13:37: the која-family with a dative rotates landmarks; bare точната-адреса keeps the protocol', () => {
  // "која му е локацијата …" — no каде-verb, but it asks where THE property
  // is → the landmark rotation, exactly like its каде sibling.
  const wheres = [
    'koja mu e lokacijata na ovoj kaj ujp',
    'KOJA MU E LOKACIJATA NA STANOT KAJ DIMITAR MILADINOV ?',
    'која му е локацијата?',
    'koja mu e adresata?',
    'која ми е локацијата',
    'koje mu e lokacijata',
  ];
  for (const t of wheres) {
    assert.equal(routesTo(t), 'LANDMARK', `expected LANDMARK for ${JSON.stringify(t)}`);
  }
  // The dative is the tell: bare demands and точната-адреса asks stay on the
  // privacy protocol (the client asked PAST the neighborhood).
  const protocols = [
    'koja e tocnata adresa',
    'која е точната адреса',
    'koja e adresa na stanot',
    'која е адресата?',
    'koja e lokacijata?',
  ];
  for (const t of protocols) {
    assert.equal(routesTo(t), 'PROTOCOL', `expected PROTOCOL for ${JSON.stringify(t)}`);
  }
});

test('"something else well-known?" family advances the rotation (LANDMARK)', () => {
  const cases = [
    'DRUGO NESTO POZNATO ?', 'nesto poznato?',
    'dali ima nesto poznato', 'друго нешто познато?', 'нешто познато?',
    'познато место?',
  ];
  for (const t of cases) {
    assert.equal(routesTo(t), 'LANDMARK', `expected LANDMARK for ${JSON.stringify(t)}`);
  }
  // "запознаен" contains "познат" — must NOT trigger.
  assert.notEqual(routesTo('ne sum zapoznaen so gradot'), 'LANDMARK');
});
