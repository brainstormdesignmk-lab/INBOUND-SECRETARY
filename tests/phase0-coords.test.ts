import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
import { PropertyService } from '../src/data/properties';
import { resolveSearchCenter, type PropertyRow } from '../src/geo/landmarks';

/**
 * PHASE 0.1 — the runtime must carry property coordinates.
 *
 * public-properties now SELECTs + emits lat/lon/geo_source/geocoded_at, mapRow
 * copies them onto Property, and whereIsReply() builds the PropertyRow from the
 * real feed data. resolveSearchCenter() must therefore return a TRUSTED center
 * from stored coords — never the geocodeAddress fallback.
 */

// Exactly the shape public-properties?format=json now returns (formatted JSON
// with Macedonian keys + the geo columns added by Task 0.1b).
const FEED_ROW = {
  id: 'uuid-69',
  evidenten_broj: '69',
  naslov: 'Двособен стан Центар',
  naselba: 'Центар',
  adresa: 'У. Димитар Миладинов',
  cena_eur: 99000,
  povrsina_m2: 51,
  opis: 'Реновиран во 2013.',
  lat: 41.99514,
  lon: 21.42111,
  geo_source: 'google_cached',
  geocoded_at: '2026-08-24T10:00:00.000Z',
};

function startServer(payload: unknown): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(payload));
  });
  return new Promise(resolve => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ url: `http://127.0.0.1:${port}`, close: () => new Promise(r => server.close(() => r())) });
    });
  });
}

test('0.1 integration: feed property with google_cached coords → PropertyRow populated, resolveSearchCenter trusted', async () => {
  const { url, close } = await startServer({ properties: [FEED_ROW], count: 1 });
  try {
    const ps = new PropertyService(url);
    const all = await ps.getAll();
    assert.equal(all.length, 1);
    const prop = all[0];

    // mapRow copied the geo columns onto Property
    assert.equal(prop.eb, 69);
    assert.equal(prop.lat, 41.99514);
    assert.equal(prop.lon, 21.42111);
    assert.equal(prop.geo_source, 'google_cached');
    assert.equal(prop.geocoded_at, '2026-08-24T10:00:00.000Z');

    // whereIsReply() builds its PropertyRow from the real feed data now
    const propRow: PropertyRow = {
      id: prop.id, eb: prop.eb, address: prop.address,
      landmark_name: prop.landmark,
      lat: prop.lat, lon: prop.lon,
      geo_source: prop.geo_source ?? null,
    };

    // resolveSearchCenter returns the STORED coords as trusted — not the
    // geocodeAddress fallback (no offlineMap is registered in this test, so a
    // fallback would return 0,0 untrusted).
    const center = resolveSearchCenter(propRow);
    assert.equal(center.lat, 41.99514);
    assert.equal(center.lon, 21.42111);
    assert.equal(center.trusted, true);
  } finally {
    await close();
  }
});

test('0.1 unit: PropertyRow from a row with null lat/lon → resolveSearchCenter trusted:false → honest fallback (never fabricates)', () => {
  // The same row minus coordinates — public-properties emits null when the
  // property was never geocoded (osm_low_confidence / no geocode).
  const noCoords = { ...FEED_ROW, lat: null, lon: null, geo_source: null };
  const propRow: PropertyRow = {
    id: 70, eb: 70, address: 'Непостојна 99',
    landmark_name: undefined,
    lat: undefined, lon: undefined,
    geo_source: null,
  };
  // mapRow must NOT fabricate coords from a null row
  assert.equal(resolveSearchCenter(propRow).trusted, false);
  // And a PropertyRow that still carries nulls must be untrusted too
  assert.equal(resolveSearchCenter({ ...propRow, lat: null, lon: null }).trusted, false);
  // The honest fallback path is what the handler serves — never a guessed point
  const center = resolveSearchCenter(propRow);
  assert.ok(Number.isFinite(center.lat));
  assert.ok(Number.isFinite(center.lon));
  assert.equal(center.trusted, false);
});

test('0.1 unit: mapRow keeps coords off when the feed sends garbage coords', async () => {
  const { url, close } = await startServer({
    properties: [{ ...FEED_ROW, lat: 'NaN', lon: null, geo_source: 'osm_low_confidence' }],
    count: 1,
  });
  try {
    const ps = new PropertyService(url);
    const prop = (await ps.getAll())[0];
    assert.equal(prop.lat, undefined);
    assert.equal(prop.lon, undefined);
    assert.equal(prop.geo_source, undefined);
  } finally {
    await close();
  }
});
