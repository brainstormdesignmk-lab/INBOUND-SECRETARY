// THE FEED AUDIT FOR THE PIN/AREA CONTRADICTION (the [05:32] EB 85 capture).
//
// The card-side guard drops the landmark line, which stops the contradiction
// from reaching a client — but the FEED row stays broken, and every other reader
// (the public page, where-is, availability) still sees a flat labelled Ново
// Лисиче with a pin in Пајко Маало. `scripts/audit-pin-location.ts` is the
// report (and, on a master, the repair) for that class.
//
// What is pinned here is the AUDIT's judgement, not its printing: one predicate
// answers "does this pin contradict this naselba", the card guard uses it, and
// the audit must agree with the guard forever. A row the audit cannot judge is
// reported as `skipped` with a reason — never as healthy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import os from 'node:os';
import { writeMap, OfflineMapStore, cleanPoiName } from '../src/geo/offlineMap';
import { pinContradictsLocation } from '../src/geo/landmarks';
import { auditRows, pinSide } from '../src/feed/pinAudit';

function buildMap(): OfflineMapStore {
  const dbPath = path.join(os.tmpdir(), `lina-pin-audit-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeMap(dbPath, [
    { name: 'Пајко Маало', type: 'suburb', lat: 41.9977663, lon: 21.4365615 },
    { name: 'Ново Лисиче', type: 'suburb', lat: 41.9840, lon: 21.4700 },
    { name: 'Центар', type: 'suburb', lat: 41.9955, lon: 21.4310 },
  ], []);
  return new OfflineMapStore(dbPath);
}

test('the audit names the [05:32] row and leaves a healthy row alone', () => {
  const findings = auditRows([
    // EB 85 exactly as the feed carried it: naselba Ново Лисиче, pin beside the
    // town-centre mall (331 m from Пајко Маало, 3.468 km from Ново Лисиче).
    { eb: 85, location: 'Ново Лисиче', address: 'Кај Бранка', lat: 41.9993, lon: 21.44 },
    // A flat at home in its own naselba — the audit must not cry wolf, or the
    // operator stops reading the report.
    { eb: 91, location: 'Центар', address: 'Улица 91', lat: 41.9960, lon: 21.4320 },
  ], buildMap());

  const byEb = new Map(findings.map(f => [f.eb, f]));
  const broken = byEb.get(85)!;
  assert.equal(broken.contradicts, true, 'the Ново Лисиче row with a Пајко Маало pin is a contradiction');
  assert.equal(broken.pinQuarter?.name, 'Пајко Маало', `the pin's own quarter is named: ${JSON.stringify(broken.pinQuarter)}`);
  assert.ok((broken.namedAt?.distance_m ?? 0) > 3000, 'and the distance to the named naselba is reported');
  assert.equal(byEb.get(91)!.contradicts, false, 'a row at home is not flagged');
});

test('a row the audit cannot judge is SKIPPED with a reason, never called healthy', () => {
  const findings = auditRows([
    { eb: 200, location: 'Центар', address: 'без пин' },                        // no coordinates
    { eb: 201, lat: 41.9955, lon: 21.4310 },                                   // no naselba
    { eb: 202, location: 'Непозната населба', lat: 41.9955, lon: 21.4310 },    // not on the map
  ], buildMap());

  assert.equal(findings.length, 3);
  assert.deepEqual(findings.map(f => f.contradicts), [false, false, false], 'none is claimed broken…');
  assert.deepEqual(findings.map(f => f.skipped), [
    'no pin', 'no location', 'the map has no row for that naselba',
  ], '…and each says why it was not judged');
});

test('the audit and the card guard answer with ONE predicate', () => {
  const map = buildMap();
  const rows = [
    { eb: 85, location: 'Ново Лисиче', lat: 41.9993, lon: 21.44 },
    { eb: 91, location: 'Центар', lat: 41.9960, lon: 21.4320 },
    { eb: 92, location: 'Центар (населба)', lat: 41.9960, lon: 21.4320, address: 'Улица 92' },
  ];
  for (const f of auditRows(rows, map)) {
    assert.equal(f.contradicts, pinContradictsLocation(map, f),
      `EB ${f.eb}: the report and the served card must never disagree`);
  }
});

// WHICH SIDE IS WRONG (the 2026-11-23 sweep of five live rows). The audit used
// to assume the PIN was always the broken side; EB 44 proved otherwise — «куќа
// во Визбегово» whose pin stands 518 m from Визбегово village and 2,4 km from
// the «Скопје Север» row. Moving that pin would have destroyed the coordinate
// the owner's own words confirm.
function buildVerdictMap(): OfflineMapStore {
  const dbPath = path.join(os.tmpdir(), `lina-pin-side-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeMap(dbPath, [
    { name: 'Скопје Север', type: 'suburb', lat: 42.02344, lon: 21.43941 },
    { name: 'Визбегово', type: 'village', lat: 42.03678, lon: 21.40944 },
    { name: 'Шуто Оризари', type: 'suburb', lat: 42.03825, lon: 21.42274 },
    { name: 'Кисела Вода', type: 'suburb', lat: 41.97835, lon: 21.43993 },
    { name: 'Чаир', type: 'suburb', lat: 42.02380, lon: 21.43740 },
    // A SHOP, not a settlement: the same name exists all over town, so a chain
    // can never be evidence about which quarter a row is in.
    { name: 'Кипер Маркет', type: 'supermarket', lat: 42.02363, lon: 21.43720 },
  ], []);
  return new OfflineMapStore(dbPath);
}

test('the LABEL is named as the wrong side when the row’s own words place it at the pin', () => {
  const map = buildVerdictMap();
  // EB 44 exactly as the feed carried it (2026-11-23).
  const [f] = auditRows([{
    eb: 44, location: 'Скопје Север', address: 'ВИЗБЕГОВО',
    details: 'Се продава куќа во Визбегово, со површина од 150м2.',
    lat: 42.0345, lon: 21.4149,
  }], map);
  assert.equal(f!.contradicts, true, 'the row is a contradiction either way');
  assert.equal(f!.side, 'naselba', `the pin is the trustworthy half: ${JSON.stringify(f)}`);
  assert.equal(f!.naselbaAt?.name, 'Визбегово', 'and the settlement it names is the value to write');
  assert.ok((f!.naselbaAt?.distance_m ?? 9999) < 1000, 'measured from the pin, not assumed');
});

test('a SHOP name in the address never flips the verdict — the pin stays the wrong side', () => {
  const map = buildVerdictMap();
  // EB 46 exactly as the feed carried it: a Кисела Вода row whose pin was
  // resolved to a Кипер branch by NAME, 5 km north. The address names that
  // chain, and a chain is not a quarter.
  const [f] = auditRows([{
    eb: 46, location: 'Кисела Вода', address: 'ШАМПИОНЧЕ КАК КИПЕР МАРКЕТ',
    details: '', lat: 42.0235, lon: 21.437,
  }], map);
  assert.equal(f!.contradicts, true);
  assert.equal(f!.side, 'pin', `a chain with branches proves nothing about the quarter: ${JSON.stringify(f)}`);
  assert.equal(f!.naselbaAt, undefined);
});

test('the verdict needs the settlement to be DECISIVELY nearer than the typed naselba', () => {
  const map = buildVerdictMap();
  // The row's words name Визбегово, but its pin is right between the two
  // quarters — a straddle is not evidence, and the label stays (side: 'pin').
  const near = pinSide(map, { location: 'Визбегово', address: 'кај Визбегово', lat: 42.0368, lon: 21.4095 } as never,
    { distance_m: 20 });
  assert.equal(near.side, 'pin', `no contradiction to attribute, so nothing flips: ${JSON.stringify(near)}`);
  const straddle = pinSide(map, { location: 'Скопје Север', address: 'во Визбегово', lat: 42.0330, lon: 21.4150 } as never,
    { distance_m: 1200 });
  assert.equal(straddle.side, 'pin', `1200 m is not decisively far: ${JSON.stringify(straddle)}`);
});

test('«Карпош III» and «Карпош 3» are ONE naselba for every reader', () => {
  // Two live rows (EB 48, 54) were unjudgeable — “the map has no row for that
  // naselba” — because the feed writes the quarter as a Roman numeral. The fold
  // is symmetric, so the map's «Карпош 3» row answers either spelling.
  const dbPath = path.join(os.tmpdir(), `lina-roman-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeMap(dbPath, [{ name: 'Карпош 3', type: 'suburb', lat: 42.0074, lon: 21.3987 }], []);
  const map = new OfflineMapStore(dbPath);
  const roman = map.findPoiByName('Карпош III', { lat: 42.0062, lon: 21.4 });
  const arabic = map.findPoiByName('Карпош 3', { lat: 42.0062, lon: 21.4 });
  assert.equal(roman?.name, 'Карпош 3', 'the Roman numeral quarter finds the map row');
  assert.deepEqual(roman, arabic, 'and answers exactly as the Arabic spelling does');
  assert.equal(cleanPoiName('Карпош IV'), 'Карпош 4', 'IV→4, the same fold on the other side');
  // NOT a numeral: an English name's Latin token is left alone.
  assert.equal(cleanPoiName('C Lounge'), 'C Lounge', 'a single-letter name is not a quarter');
  assert.equal(cleanPoiName('VX Bar'), 'VX Bar', 'and a non-canonical numeral is a word');
});

test('an annotation in the naselba name does not hide the contradiction', () => {
  const map = buildMap();
  // The feed carries «Ново Лисиче (кај Бранка)» shapes; the parenthetical is an
  // annotation, not part of the area name.
  const flagged = pinContradictsLocation(map, { location: 'Ново Лисиче (кај Бранка)', lat: 41.9993, lon: 21.44 });
  assert.equal(flagged, true, 'the area word is compared, not the note beside it');
});
