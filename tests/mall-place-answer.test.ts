// Mall / shop landmark rules — LINA-ONLY coverage, split out of the SHARED spec.
//
// `tests/nearby-landmarks.test.ts` is BYTE-IDENTICAL with
// maps-realestate/tests/nearby-landmarks.test.ts, and scripts/link-geo.js
// enforces that (the drift guard runs on postinstall, so any difference breaks
// `npm install` on every atom). These assertions pin LINA's own card builder
// (buildPropertyCard) plus the roster service on the same fixtures — they cannot
// live in the maps project, which has no card builder — so they belong in a LINA
// file of their own rather than inside the shared spec.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import path from 'path';
import os from 'os';
import { Db } from '../src/store/db';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { buildPropertyCard } from '../src/llm/prompts';
import type { Property } from '../src/data/properties';

function tmpDb(): string {
  return path.join(os.tmpdir(), `mall-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

// ── A SHOP IS NOT A PLACE, AND A SHOP INSIDE A MALL IS THE MALL ────────────
// The owner's rule, from the EB 53 card:
//   «Станот под Евидентен број 53 … Се наоѓа во близина на Butik Galion.»
// Butik Galion is a boutique INSIDE ТЦ Бисер — a tenant nobody navigates by —
// yet the feed had typed it «Shopping mall», so every type-rank treated it as
// a first-class complex and it took the first rotation slot. ТЦ Бисер (55 m
// from that flat) is the place a client knows.
describe('a shop is never a nearby landmark', () => {
  const BOUTIQUE = { name: 'Butik Galion', type: 'Shopping mall', lat: 42.001, lon: 21.4305 };
  const COMPLEX = { name: 'ТЦ Бисер', type: 'mall', lat: 42.0011, lon: 21.4306 };
  const TENANT_OF_COMPLEX = { name: 'Кисми - Бисер', type: 'Shopping mall', lat: 42.001, lon: 21.4304 };
  const MARKET = { name: 'Deni Market', type: 'Supermarket', lat: 42.0005, lon: 21.4300 };

  function mapWithShops(): OfflineMapStore {
    const dbPath = tmpDb();
    writeMap(dbPath, [BOUTIQUE, COMPLEX, TENANT_OF_COMPLEX, MARKET] as never, []);
    return new OfflineMapStore(dbPath);
  }

  it('names the COMPLEX holding the boutique, never the boutique', () => {
    const db = new Db(':memory:');
    const map = mapWithShops();
    const svc = new LandmarkService(db, { osm: false, offlineMap: map });
    const roster = svc.nearbyLandmarks({
      id: 53, eb: 53, address: 'Тест 1', location: 'Аеродром',
      lat: 42.0, lon: 21.43, geo_source: 'stored',
      landmarks: [{ landmark: 'Butik Galion', type: 'Shopping mall', distance_m: 35 }],
    });
    assert.equal(roster[0].landmark, 'ТЦ Бисер', `the complex must lead: ${JSON.stringify(roster)}`);
    assert.ok(!roster.some(r => /Butik Galion|Кисми/.test(r.landmark)),
      `no tenant may be served: ${JSON.stringify(roster)}`);
    map.close();
  });

  it('resolves the card landmark to the complex too (feed list, first slot)', async () => {
    const db = new Db(':memory:');
    const map = mapWithShops();
    const svc = new LandmarkService(db, { osm: false, offlineMap: map });
    const l = await svc.resolve({
      eb: 53, address: 'Тест 1', location: 'Аеродром',
      lat: 42.0, lon: 21.43, geo_source: 'stored',
      landmarks: [{ landmark: 'Butik Galion', type: 'Shopping mall', distance_m: 35 }],
    });
    assert.equal(l.source, 'feed');
    assert.equal(l.landmark, 'ТЦ Бисер');
    map.close();
  });

  it('a shop with NO complex around it is dropped — never served as the place', () => {
    const db = new Db(':memory:');
    const dbPath = tmpDb();
    writeMap(dbPath, [BOUTIQUE, MARKET] as never, []);
    const map = new OfflineMapStore(dbPath);
    const svc = new LandmarkService(db, { osm: false, offlineMap: map });
    const roster = svc.nearbyLandmarks({
      id: 54, eb: 54, address: 'Тест 1', location: 'Аеродром',
      lat: 42.0, lon: 21.43, geo_source: 'stored',
      landmarks: [{ landmark: 'Butik Galion', type: 'Shopping mall', distance_m: 35 }],
    });
    assert.ok(!roster.some(r => r.landmark === 'Butik Galion'),
      `the boutique carries no claim: ${JSON.stringify(roster)}`);
    map.close();
  });

  it('the CARD names the complex too (the owner\'s EB 53 line)', async () => {
    const db = new Db(':memory:');
    const map = mapWithShops();
    const svc = new LandmarkService(db, { osm: false, offlineMap: map });
    const row = {
      eb: 53, id: 53, address: 'Тц Болница', location: 'Аеродром',
      price: 55000, bedrooms: 2, sqm: 44, size: '44 м²', service: 'buy',
      lat: 42.0, lon: 21.43, geo_source: 'stored',
      details: 'Комплетно наместен стан.',
      landmarks: [{ landmark: 'Butik Galion', type: 'Shopping mall', distance_m: 35 }],
    } as unknown as Property;
    await svc.enrich([row]);
    const card = buildPropertyCard(row);
    assert.match(card, /во близина на ТЦ Бисер/, card);
    assert.doesNotMatch(card, /Butik Galion/, card);
    map.close();
  });

  it('a MARKET/supermarket stays usable as a landmark („кај Тинекс“ is how people give directions)', () => {
    const db = new Db(':memory:');
    const map = mapWithShops();
    const svc = new LandmarkService(db, { osm: false, offlineMap: map });
    const roster = svc.nearbyLandmarks({
      id: 55, eb: 55, address: 'Тест 1', location: 'Аеродром',
      lat: 42.0, lon: 21.43, geo_source: 'stored',
      landmarks: [{ landmark: 'Deni Market', type: 'Supermarket', distance_m: 60 }],
    });
    assert.ok(roster.some(r => r.landmark === 'Deni Market'),
      `a supermarket is not a tenant: ${JSON.stringify(roster)}`);
    map.close();
  });
});
