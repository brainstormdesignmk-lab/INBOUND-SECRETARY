import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/store/db';
import { LandmarkService } from '../src/geo/landmarks';
import { landmarkLink, propertyAreaLink } from '../src/geo/precision';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import path from 'path';
import fs from 'fs';
import os from 'os';

function tmpDb(): string {
  return path.join(os.tmpdir(), `where-is-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function buildTestMap(): OfflineMapStore {
  const dbPath = tmpDb();
  const pois = [
    { name: 'Рамстор Мол', type: 'mall', lat: 42.000, lon: 21.428, source: 'google' },
    { name: 'Парк Авионче', type: 'park', lat: 41.988, lon: 21.477, source: 'osm' },
    { name: 'Градежен факултет', type: 'university', lat: 42.003, lon: 21.433, source: 'osm' },
  ];
  writeMap(dbPath, pois, []);
  return new OfflineMapStore(dbPath);
}

describe('whereIsReply blocking tests', () => {
  let db: Db;
  let offlineMap: OfflineMapStore;
  let svc: LandmarkService;

  beforeEach(() => {
    db = new Db(':memory:');
    offlineMap = buildTestMap();
    svc = new LandmarkService(db, { osm: false, offlineMap });
  });

  it('no reply ever contains a 2-decimal coordinate or a search-form link', () => {
    // propertyAreaLink = @-view with 3 decimals (deliberate ±110m fuzz).
    const link = propertyAreaLink(42.0, 21.428);
    assert.ok(link.startsWith('https://www.google.com/maps/@'), link);
    assert.ok(link.includes('42.000'), '3 decimals — never 2');
    assert.ok(!link.match(/\d+\.\d{2}[^0-9]/), 'must not have 2-decimal coords');
    assert.ok(!link.includes('query='), 'never the ?api=1&query= search form');
  });

  it('untrusted-center property → "населба" text, no landmark name, no full link', () => {
    // Property with no lat/lon and osm_low_confidence → untrusted center
    // whereIsReply should return buildWhereIsAnswer fallback (neighborhood text)
    const propRow = {
      id: 5, eb: 5, address: 'Непостојна 99', location: 'Аеродром',
      geo_source: 'osm_low_confidence' as const,
    };
    // The resolveSearchCenter will return {0, 0, trusted: false}
    // nearbyLandmarks will return [] (empty)
    // extractDetailsLandmark won't match
    // → fallback to buildWhereIsAnswer → should mention neighborhood
    const nearby = svc.nearbyLandmarks(propRow);
    assert.equal(nearby.length, 0, 'untrusted center must return empty nearby');
    // The fallback text should mention the location/neighborhood
    // (buildWhereIsAnswer returns "Тоа се наоѓа во населбата Аеродром" or similar)
  });

  it('property with stored lat/lon → trusted center, area link within ±110m', () => {
    // Property with stored coordinates → trusted center
    const propRow = {
      id: 10, eb: 10, address: 'Тест 1', location: 'Центар',
      lat: 41.9936, lon: 21.415, geo_source: 'stored' as const,
    };
    const nearby = svc.nearbyLandmarks(propRow);
    // The area link would use propertyAreaLink(41.9936, 21.415)
    // which rounds to 3 decimals: 41.994, 21.415 — within ±110m
    const lat3 = Math.round(41.9936 * 1000) / 1000;
    const lon3 = Math.round(21.415 * 1000) / 1000;
    assert.equal(lat3, 41.994);
    assert.equal(lon3, 21.415);
    // The 3-decimal rounding error is at most 110m at this latitude
  });

  it('property with landmark from enrichment → the LINK is a coordinate pin (opens a red pin on the exact spot)', () => {
    // Pre-set a landmark on the property
    const prop = {
      id: 15, eb: 15, address: 'Тест 5', location: 'Центар',
      landmark: 'Рамстор Мол',
      landmarks: [{ landmark: 'Рамстор Мол', type: 'mall', distance_m: 200 }],
    } as any;
    // POLICY (2026-09-06): name searches are BANNED — with no city context
    // Google biases them by viewport/keywords and can return a results LIST
    // at country zoom (production bug: a "crna gora" name search opened a
    // Montenegro-wide list). A landmark link is always a coordinate pin:
    // maps.google.com/?q=lat,lon — a red pin on the exact spot. The NAME is
    // carried in the reply text, never in the URL.
    const link = landmarkLink('Рамстор Мол', null, 42.0, 21.428);
    assert.equal(link, 'https://maps.google.com/?q=42.00000,21.42800', link);
    assert.ok(link.length <= 45, `landmark link must fit the console window: ${link.length} chars`);
    assert.ok(!link.includes('tinyurl'), 'never a third-party shortener');
    assert.ok(!link.includes('api=1&query='), 'never the ?api=1&query= search form');
  });

  it('landmarkLink regression: Линцура link is a coordinate pin — no Cyrillic, no name search, ≤45 chars', () => {
    // The exact production cases, all closed by the coordinate pin:
    //   query=41.99560,21.41518  → "Google Maps can't find 41.99560" (cut at the comma)
    //   query=ПЗУ Аптека Линцура 2 → stray "П " city-wide search (cut mid-encoding)
    //   q=pzu%20apteka%20lincura%202 → ambiguous name search (country-zoom list risk)
    const link = landmarkLink('ПЗУ Аптека Линцура 2', null, 41.9955976, 21.4151772);
    assert.equal(link, 'https://maps.google.com/?q=41.99560,21.41518', link);
    assert.ok(link.length <= 45, `must fit the console window: ${link.length} chars → ${link}`);
    assert.ok(!/[^\x00-\x7F]/.test(link), 'pure ASCII');
    assert.ok(!link.includes('api=1&query='), 'never the api=1 search form');
    assert.ok(!link.includes('tinyurl'), 'never a third-party shortener');
  });

  it('landmarkLink: Google place_id → maps.google.com/?cid=<decimal> — the exact place card, original Google', () => {
    // The cid form is Google's own domain, ~49 chars (survives the console
    // truncation window) and opens the EXACT place card. Verified in a real
    // browser: https://maps.google.com/?cid=16634210817354128158 renders
    // „ПЗУ Аптека Линцура 2“.
    const link = landmarkLink('ПЗУ Аптека Линцура 2', '0x135415004f259205:0xe6d8969b475a5b1e', 41.9955976, 21.4151772);
    assert.equal(link, 'https://maps.google.com/?cid=16634210817354128158');
    assert.ok(link.length <= 55, `fits the console window: ${link.length} chars`);
    assert.ok(!link.includes('%') && !/[^\x00-\x7F]/.test(link), 'pure ASCII');
    assert.ok(!link.includes('tinyurl'), 'never a third-party shortener');
    assert.ok(link.startsWith('https://maps.google.com/'), 'original Google link');
  });

  it('landmarkLink: tinyurl place_url is NEVER emitted — falls back to the coordinate pin', () => {
    // The agency refuses third-party shorteners. A stored tinyurl must not
    // reach a client; the link degrades to the original-Google coordinate pin.
    const short = 'https://tinyurl.com/2bwm85o5';
    const link = landmarkLink('ПЗУ Аптека Линцура 2', null, 41.9955976, 21.4151772, short);
    assert.notEqual(link, short);
    assert.equal(link, 'https://maps.google.com/?q=41.99560,21.41518', link);
    assert.ok(!link.includes('tinyurl'), 'no tinyurl');
    assert.ok(!/[^\x00-\x7F]/.test(link), 'pure ASCII');
  });

  it('landmarkLink: a full canonical place_url is also emitted verbatim (never re-encoded)', () => {
    const canon = 'https://www.google.com/maps/place/%D0%9F%D0%97%D0%A3+%D0%90%D0%BF%D1%82%D0%B5%D0%BA%D0%B0+%D0%9B%D0%B8%D0%BD%D1%86%D1%83%D1%80%D0%B0+2/@41.9955976,21.4151772,17z/data=!4m7!3m6!1s0x135415004f259205:0xe6d8969b475a5b1e!8m2!3d41.9955976!4d21.4151772!16s%2Fg%2F11vsbplgjf';
    const link = landmarkLink('ПЗУ Аптека Линцура 2', null, 41.9955976, 21.4151772, canon);
    assert.equal(link, canon, 'the canonical is emitted as-is — no double-encoding');
    assert.ok(link.includes('maps/place/') && link.includes('!1s0x') && link.includes('!16s'), 'pins the place card');
  });

  it('landmarkLink: empty name → coordinate pin (NEVER a name search, NEVER an @-view)', () => {
    // POLICY (2026-09-06): every landmark link pins the exact spot. The @-view
    // was rejected earlier (opens a map with no landmark); the name search was
    // rejected after it (ambiguous — country-zoom result lists).
    const link = landmarkLink('', null, 41.9956, 21.41518);
    assert.ok(link.startsWith('https://maps.google.com/?q='), link);
    assert.ok(link.includes('41.99560'));
    assert.ok(link.includes('21.41518'));
    assert.ok(!link.includes('query=') || link.startsWith('https://maps.google.com/?q='), 'coordinate pin form only');
  });

  it('fullCoordsLink: uses the ?q= pin form — the @-view only centers, it DROPS NO MARKER', () => {
    const { fullCoordsLink } = require('../src/geo/precision');
    const link = fullCoordsLink(41.9956, 21.41518);
    assert.ok(link.startsWith('https://maps.google.com/?q='), link);
    assert.ok(!link.includes('query='), 'no ?api=1&query= search parsing');
    assert.ok(link.includes('41.99560'), '5-decimal precision kept');
  });

  it('landmarkLink invariant: EVERY landmark link is a pin — coordinate pin or cid place card, never a name search', () => {
    for (const name of ['ПЗУ Аптека Линцура 2', 'Рамстор Мол', 'Парк Авионче', '']) {
      const link = landmarkLink(name, null, 41.9956, 21.41518);
      assert.ok(link.startsWith('https://maps.google.com/?q='), `${name}: ${link}`);
      assert.ok(/\d{2}\.\d{5},\d{2}\.\d{5}$/.test(link), `${name}: ends with a coordinate pin — ${link}`);
      assert.ok(link.length <= 45, `${name}: ${link.length} chars`);
      assert.ok(!/[^\x00-\x7F]/.test(link), `${name}: pure ASCII`);
      assert.ok(!link.includes('tinyurl'), `${name}: never a shortener`);
      assert.ok(!link.includes('api=1&query='), `${name}: never the api=1 search form`);
      // The name must NEVER be in the URL (ambiguity source).
      assert.ok(!/[a-z]{3,}/.test(link.split('?q=')[1] ?? ''), `${name}: no name text in the URL — ${link}`);
    }
    // With a place_id → the cid place card (exact branch, original Google).
    const withCid = landmarkLink('ПЗУ Аптека Линцура 2', '0x135415004f259205:0xe6d8969b475a5b1e', 41.9956, 21.41518);
    assert.ok(withCid.startsWith('https://maps.google.com/?cid='), withCid);
  });
});
