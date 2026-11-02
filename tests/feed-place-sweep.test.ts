/**
 * THE FEED'S OWN GEOGRAPHY — every listed flat must resolve to a map place.
 *
 * The sweep exists because a flat that does not resolve can never be located
 * honestly: «во близина на X» names a place the bot cannot measure, or the
 * address anchors nothing at all. The four failure classes, each pinned here
 * against a tiny fixture map:
 *   • no address                     → violation
 *   • address on no street / no place→ violation
 *   • landmark the map does not hold → violation (containment is not identity:
 *     «Скопјанка» must not pass for «ТЦ Скопјанка»)
 *   • a row without a pin            → warning, never a violation
 * and the happy path (address resolves, landmark IS a map row) is silent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { auditFeedPlaces, foldPlaceName, samePlace } from '../src/geo/feedPlaceAudit';

function fixtureMap(): { map: OfflineMapStore; close: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-places-'));
  const db = path.join(dir, 'map.db');
  writeMap(db,
    [
      { name: 'Училиште Гоце Делчев', type: 'school', lat: 41.98820, lon: 21.47590 },
      { name: 'ТЦ Скопјанка', type: 'mall', lat: 41.9891272, lon: 21.4506228 },
      // THE CHAIN FAMILY: one name, two branches — the near one is the truth.
      { name: 'Зегин Аптека', type: 'pharmacy', lat: 41.98815, lon: 21.47585 },
      { name: 'Зегин Аптека', type: 'pharmacy', lat: 41.95050, lon: 21.55000 },
    ],
    [
      { street: 'Ул. Димитар Миладинов', housenumber: '12', lat: 41.98810, lon: 21.47580 },
    ]);
  const map = new OfflineMapStore(db);
  return { map, close: () => map.close() };
}

test('one name, one spelling — punctuation and case never split a place', () => {
  assert.equal(foldPlaceName('ТЦ  Скопјанка'), foldPlaceName('тц скопјанка'));
  assert.equal(foldPlaceName('ОУ „Блаже Конески“'), 'оу блаже конески');
});

test('a stored landmark IS the map row across scripts and dropped qualifiers — never across a brand', () => {
  // The live feed is Cyrillic, the map is largely Latin: same bank, one place.
  assert.equal(samePlace('Комерцијална банка', 'Komercijalna Banka AD Skopje'), true);
  assert.equal(samePlace('Комерцијална банка', 'Комерцијална банка'), true);
  // A qualifier at either end may be dropped; a word SUBSTITUTED may not.
  assert.equal(samePlace('Зегин', 'Зегин Аптека'), true);
  assert.equal(samePlace('Училиште Гоце Делчев', 'ОУ Гоце Делчев'), false,
    '«училиште» vs «ОУ» is a substituted word, not a qualifier');
  // A BRAND IN FRONT is a different place — the «Скопјанка» / «ТЦ Скопјанка» case.
  assert.equal(samePlace('Скопјанка', 'ТЦ Скопјанка'), false);
  assert.equal(samePlace('Novo Lisice', 'ELS Novo Lisice'), false);
});

test('each failure class is reported, and a resolvable flat is silent', () => {
  const { map, close } = fixtureMap();
  try {
    const rows: Array<Record<string, unknown>> = [
      // RESOLVES: street + number on the map, landmark is a map row, pin agrees.
      { evidenten_broj: 1, address: 'Ул. Димитар Миладинов 12', lat: 41.98810, lon: 21.47580,
        landmarks: [{ landmark: 'Училиште Гоце Делчев', distance_m: 15 }] },
      // RESOLVES AS A PLACE, under the LIVE feed's own field name (`adresa`).
      { evidenten_broj: 2, adresa: 'ТЦ Скопјанка', lat: 41.98913, lon: 21.45062,
        landmarks: [{ landmark: 'ТЦ Скопјанка', distance_m: 5 }] },
      // NO ADDRESS.
      { evidenten_broj: 3, lat: 41.99, lon: 21.45, landmarks: [] },
      // ADDRESS ON NO STREET.
      { evidenten_broj: 4, address: 'Непозната улица 5', lat: 41.99, lon: 21.45, landmarks: [] },
      // LANDMARK THE MAP DOES NOT HOLD, and a contained but different name.
      { evidenten_broj: 5, address: 'Ул. Димитар Миладинов 12', lat: 41.98810, lon: 21.47580,
        landmarks: [
          { landmark: 'Кафе Непостоечко', distance_m: 40 },
          { landmark: 'Скопјанка', distance_m: 300 },
        ] },
      // NO PIN — the distances cannot be confirmed, but the flat still resolves.
      { evidenten_broj: 6, address: 'Ул. Димитар Миладинов 12',
        landmarks: [{ landmark: 'Училиште Гоце Делчев', distance_m: 15 }] },
    ];

    const report = auditFeedPlaces(rows, map);
    const kinds = report.issues.map(i => `${i.eb}:${i.kind}`).sort();
    assert.deepEqual(kinds, [
      '3:no-address',
      '4:address-unresolved',
      '5:landmark-not-on-map',
      '5:landmark-not-on-map',
    ], `the four violation classes, nothing invented: ${JSON.stringify(report.issues)}`);

    assert.equal(report.properties, 6);
    assert.equal(report.addressed, 5, 'five rows carry an address');
    assert.equal(report.resolved, 4, '1, 2, 5 and 6 resolve; 4 does not');
    assert.equal(report.resolvedAsPlace, 1, 'EB 2 is the place-name form');
    assert.equal(report.landmarkEntries, 5);
    assert.equal(report.landmarksOnMap, 3, 'the school twice + the mall; the café and «Скопјанка» never');

    // Rows 3 and 4 DO carry pins (a bad address is not a missing one), so the
    // only pinless row is 6.
    const warnings = report.warnings.map(w => `${w.eb}:${w.kind}`).sort();
    assert.deepEqual(warnings, ['6:no-pin'],
      `only the pinless row is a warning: ${JSON.stringify(report.warnings)}`);

    assert.deepEqual(report.issues.filter(i => i.eb === '1'), [], 'the good flat is silent');
    assert.deepEqual(report.warnings.filter(w => w.eb === '1'), [], 'and it needs no warning');
  } finally { close(); }
});

test('a chain landmark is measured at its NEAREST branch, so a far branch is not "drift"', () => {
  const { map, close } = fixtureMap();
  try {
    const rows: Array<Record<string, unknown>> = [
      // «Зегин» has a branch ~7 m away and another 6 km away; the feed stored
      // the near one's distance.
      { evidenten_broj: 8, address: 'Ул. Димитар Миладинов 12', lat: 41.98810, lon: 21.47580,
        landmarks: [{ landmark: 'Зегин', distance_m: 12 }] },
    ];
    const report = auditFeedPlaces(rows, map);
    assert.deepEqual(report.issues, []);
    assert.deepEqual(report.warnings, [],
      `the nearest branch confirms the claim: ${JSON.stringify(report.warnings)}`);
  } finally { close(); }
});

test('a stored distance that disagrees with the map is drift, not a violation', () => {
  const { map, close } = fixtureMap();
  try {
    const rows: Array<Record<string, unknown>> = [
      // The school sits ~20 m from this pin, but the feed claims 900 m.
      { evidenten_broj: 7, address: 'Ул. Димитар Миладинов 12', lat: 41.98810, lon: 21.47580,
        landmarks: [{ landmark: 'Училиште Гоце Делчев', distance_m: 900 }] },
    ];
    const report = auditFeedPlaces(rows, map);
    assert.deepEqual(report.issues, [], 'drift never fails the sweep');
    assert.deepEqual(report.warnings.map(w => `${w.eb}:${w.kind}`), ['7:distance-drift']);
    assert.match(report.warnings[0]!.detail, /stored 900 m, map says \d+ m/);
  } finally { close(); }
});
