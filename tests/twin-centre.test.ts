// THE TWIN-CENTRE REGRESSION — what the CLIENT actually receives.
//
// 2026-10-08, the reported bug: at the Embassy of Montenegro centre the
// rotation served the SAME building twice, once per script —
//   „…во близина на Embassy of Montenegro" + maps.google.com/?cid=…
//   „…во близина на Амбасада на Црна Гора"  + maps.google.com/?q=…
// Both rows exist in the map (Google's English anchor + the OSM Macedonian
// one). The runtime's own merge must collapse them into ONE slot: the
// Macedonian name (what the client reads) carrying Google's identity.
//
// LINK FORM (revised 2026-10-13, the [23:50] capture): the customer link is the
// coordinate PIN (maps.google.com/?q=lat,lon) — a cid place card NAMES the place
// but shows no pin, so the client cannot see WHERE it is. Google's identity is
// still merged onto the served row: it is what serves the exact place card when
// the row has no usable coordinate (the cid fallback).
//
// The same test pins down the Turkey centre, the harder twin: there the Google
// anchor is typed "Corporate office", so it ranks BELOW the OSM diplomatic row
// and is never the served name — yet its place_id must still transfer onto the
// ranked row, otherwise the no-coordinate fallback links a name search instead
// of the building.
//
// These are the LINA-side gate for the maps-side fixes: the georgia rules in
// tests/place-identity.test.ts prove the pure logic, this file proves the
// SERVICE (LandmarkService.nearbyLandmarks) serves one slot at a real twin
// centre.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Db } from '../src/store/db';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { landmarkLink } from '../src/geo/precision';

type PoiSeed = Parameters<typeof writeMap>[1][number];

function buildMap(pois: PoiSeed[]): OfflineMapStore {
  const dbPath = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'twin-centre-')),
    'map.db',
  );
  writeMap(dbPath, pois, []);
  return new OfflineMapStore(dbPath);
}

/** The served rotation at a centre — the list the reply text is built from. */
function serveAt(
  lat: number,
  lon: number,
  pois: PoiSeed[],
  id: number,
): Array<{ landmark: string; lat: number; lon: number; place_url?: string; place_id?: string }> {
  const offlineMap = buildMap(pois);
  const db = new Db(':memory:');
  const svc = new LandmarkService(db, { osm: false, offlineMap });
  const out = svc.nearbyLandmarks({
    id, eb: id, address: 'Тоне Томшиќ 25', location: 'Центар',
    lat, lon, geo_source: 'stored',
  });
  offlineMap.close();
  db.close();
  return out;
}

test('Montenegro twin centre: one slot, Macedonian name, Google place card', () => {
  // The exact pair from the live map (English Google anchor + OSM Macedonian).
  const lat = 41.9959869;
  const lon = 21.418169;
  const out = serveAt(lat, lon, [
    { name: 'Амбасада на Црна Гора', type: 'diplomatic', lat: 41.9959869, lon: 21.418169, source: 'osm' },
    {
      name: 'Embassy of Montenegro', type: 'Embassy', lat: 41.9959461, lon: 21.4181322, source: 'google',
      place_id: '0x135415e4b98e6f4f:0x9f0ae0f4b0b7d0a1', rating: 4.3, review_count: 24,
    },
  ], 501);

  const slots = out.filter(l => /Црна Гора|Montenegro/i.test(l.landmark));
  assert.equal(slots.length, 1, `the same embassy took ${slots.length} rotation slots: ${JSON.stringify(out)}`);
  assert.equal(slots[0].landmark, 'Амбасада на Црна Гора', 'the client reads the local-script name');
  const link = landmarkLink(slots[0].landmark, slots[0].place_id ?? null, slots[0].lat, slots[0].lon, slots[0].place_url);
  assert.match(link, /^https:\/\/maps\.google\.com\/\?q=\d+\.\d{5},\d+\.\d{5}$/,
    `the served link must be the coordinate pin, got ${link}`);
  // The merged identity still has to pay off: with NO coordinate the same slot
  // falls back to Google's exact place card instead of a name search.
  const noCoords = landmarkLink(slots[0].landmark, slots[0].place_id ?? null, NaN, NaN);
  assert.match(noCoords, /cid=\d+/, `without coordinates the place card is the fallback, got ${noCoords}`);
});

test('Turkey twin centre: the rank-0 Google row still donates its place_id', () => {
  // "Corporate office" ranks 0, so the OSM "diplomatic" row is the served one —
  // and it used to be served WITHOUT an identity, i.e. a raw ?q= name search.
  const lat = 42.0035575;
  const lon = 21.434606;
  const out = serveAt(lat, lon, [
    { name: 'Амбасада на Турција', type: 'diplomatic', lat: 42.0035575, lon: 21.434606, source: 'osm' },
    {
      name: 'Embassy of Republic of Turkey', type: 'Corporate office', lat: 42.0035575, lon: 21.434606, source: 'google',
      place_id: '0x135415ae91924109:0x1605863f0c240a04', rating: 4.4, review_count: 70,
    },
  ], 502);

  const slots = out.filter(l => /Турција|Turkey/i.test(l.landmark));
  assert.equal(slots.length, 1, `one building, one slot — got ${JSON.stringify(out)}`);
  assert.equal(slots[0].landmark, 'Амбасада на Турција');
  assert.equal(slots[0].place_id, '0x135415ae91924109:0x1605863f0c240a04', 'identity transferred onto the ranked row');
  const link = landmarkLink(slots[0].landmark, slots[0].place_id ?? null, slots[0].lat, slots[0].lon, slots[0].place_url);
  assert.match(link, /^https:\/\/maps\.google\.com\/\?q=42\.00356,21\.43461$/,
    `the pin must carry the SERVED row's coordinates, got ${link}`);
  // The transferred identity is what serves the card when coordinates are
  // missing — the original reason this test exists: never a name search.
  const noCoords = landmarkLink(slots[0].landmark, slots[0].place_id ?? null, NaN, NaN);
  assert.match(noCoords, /cid=\d+/, `the transferred place_id must still serve a card, got ${noCoords}`);
});

test('Czech twin centre: bureaucratic padding is not a second building', () => {
  const lat = 41.9848371;
  const lon = 21.417664;
  const out = serveAt(lat, lon, [
    { name: 'Амбасада на Република Чешка', type: 'diplomatic', lat: 41.9848371, lon: 21.417664, source: 'osm' },
    {
      name: 'Embassy of the Czech Republic', type: 'Embassy', lat: 41.9848430, lon: 21.4176701, source: 'google',
      place_id: '0x13541492a1b8ee75:0x2b1f5b0a0e4e5a3c', rating: 4.6, review_count: 41,
    },
  ], 503);

  const slots = out.filter(l => /Чешка|Czech/i.test(l.landmark));
  assert.equal(slots.length, 1, `"of the Republic of" must not duplicate the embassy — got ${JSON.stringify(out)}`);
  assert.equal(slots[0].landmark, 'Амбасада на Република Чешка');
  assert.ok(slots[0].place_id, 'the surviving slot carries an identity');
});

test('nearby twins: a residence/consular section is NOT the embassy', () => {
  const lat = 42.0035575;
  const lon = 21.434606;
  const out = serveAt(lat, lon, [
    { name: 'Амбасада на Турција', type: 'diplomatic', lat, lon, source: 'osm' },
    {
      name: 'Turkish Embassy (Residence)', type: 'Embassy',
      lat: lat + 0.0003, lon, source: 'google',
      place_id: '0x135415ae91924109:0xdeadbeefdeadbeef',
    },
  ], 504);

  const names = out.map(l => l.landmark);
  assert.ok(names.includes('Амбасада на Турција'), `the embassy stays: ${JSON.stringify(names)}`);
  assert.ok(
    names.includes('Turkish Embassy (Residence)'),
    `the residence is a different building and keeps its own slot: ${JSON.stringify(names)}`,
  );
  assert.notEqual(
    out.find(l => l.landmark === 'Амбасада на Турција')?.place_id,
    '0x135415ae91924109:0xdeadbeefdeadbeef',
    'the embassy must not adopt the residence\'s place card',
  );
});
