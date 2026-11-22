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
import { writeMap, OfflineMapStore } from '../src/geo/offlineMap';
import { pinContradictsLocation } from '../src/geo/landmarks';
import { auditRows } from '../scripts/audit-pin-location';

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

test('an annotation in the naselba name does not hide the contradiction', () => {
  const map = buildMap();
  // The feed carries «Ново Лисиче (кај Бранка)» shapes; the parenthetical is an
  // annotation, not part of the area name.
  const flagged = pinContradictsLocation(map, { location: 'Ново Лисиче (кај Бранка)', lat: 41.9993, lon: 21.44 });
  assert.equal(flagged, true, 'the area word is compared, not the note beside it');
});
