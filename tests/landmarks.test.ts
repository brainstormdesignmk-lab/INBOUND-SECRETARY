import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/store/db';
import { LandmarkService, googleMapsLink } from '../src/geo/landmarks';
import { mapsLinkFor } from '../src/visits/messages';
import { PropertyService, FeedLandmark } from '../src/data/properties';

test('feed: the landmarks JSONB column is parsed into the ranked list', async () => {
  const orig = globalThis.fetch;
  globalThis.fetch = (async () => ({
    ok: true,
    json: async () => ({
      properties: [
        {
          evidenten_broj: 48, adresa: 'ул. Пример 5', naselba: 'Карпош III', servis: 'Издава',
          landmarks: [
            { landmark: 'Кафе бар Ван Гог', type: 'cafe', distance_m: 120, maps_url: 'https://x' },
            { landmark: 'Градежен факултет', type: 'university', distance_m: 340, maps_url: 'https://x' },
            { landmark: 'Улица Македонија', type: 'road', distance_m: 50 }, // parses; the pick guard rejects it
            { garbage: true },                 // no landmark string — dropped
            { landmark: '' },                  // empty — dropped
            { landmark: 'Х'.repeat(200) },     // too long — dropped
          ],
        },
        { evidenten_broj: 50, adresa: 'ул. Пример 6' }, // no landmarks at all
      ],
    }),
  })) as unknown as typeof fetch;
  try {
    const svc = new PropertyService('http://fake-feed');
    const all = await svc.getAll();
    const p48 = all.find(p => p.eb === 48)!;
    assert.equal(p48.landmarks?.length, 3);
    assert.equal(p48.landmarks![0].landmark, 'Кафе бар Ван Гог');
    assert.equal(p48.landmarks![1].distance_m, 340);
    assert.equal(p48.landmarks![2].landmark, 'Улица Македонија');
    const p50 = all.find(p => p.eb === 50)!;
    assert.equal(p50.landmarks, undefined);
  } finally {
    globalThis.fetch = orig;
  }
});

test('LandmarkService: the FEED ranked list wins — nearest valid, street names rejected, EB-hash variety', async () => {
  const db = new Db(':memory:');
  const svc = new LandmarkService(db, { osm: false });
  const list: FeedLandmark[] = [
    { landmark: 'Улица Македонија', type: 'road', distance_m: 50 },    // a street — must never be served
    { landmark: 'Кафе бар Ван Гог', type: 'cafe', distance_m: 120 },
    { landmark: 'Градежен факултет', type: 'university', distance_m: 340 },
  ];
  const a = await svc.resolve({ eb: 48, address: 'ул. Пример 5', location: 'Карпош III', landmarks: list });
  const b = await svc.resolve({ eb: 49, address: 'ул. Пример 5', location: 'Карпош III', landmarks: list });
  assert.equal(a.source, 'feed');
  assert.ok(a.landmark.length > 0);
  assert.notEqual(a.landmark, 'Улица Македонија'); // the street is filtered out
  assert.ok(['Кафе бар Ван Гог', 'Градежен факултет'].includes(a.landmark), a.landmark);
  // different EBs rotate for variety — both still come from the valid list
  assert.ok(['Кафе бар Ван Гог', 'Градежен факултет'].includes(b.landmark), b.landmark);
});

test('LandmarkService: no feed list → the deterministic table fallback still works', async () => {
  const db = new Db(':memory:');
  const svc = new LandmarkService(db, { osm: false });
  const l = await svc.resolve({ eb: 48, location: 'Карпош III' });
  assert.equal(l.source, 'table');
  assert.ok(l.landmark.length > 0);
});

test('googleMapsLink: the only link format is Google Maps — never OSM', () => {
  const l = googleMapsLink('Кафе бар Ван Гог');
  assert.ok(l.startsWith('https://www.google.com/maps/search/?api=1&query='), l);
  assert.ok(l.includes(encodeURIComponent('Кафе бар Ван Гог')), l);
  assert.ok(!l.includes('openstreetmap'), l);
});

test('mapsLinkFor: the REAL address is sent as a Google Maps link on the visit day', () => {
  const l = mapsLinkFor('Бисер', 'Аеродром');
  assert.ok(l.startsWith('https://www.google.com/maps/search/?api=1&query='), l);
  assert.ok(decodeURIComponent(l).includes('Бисер'), l); // the exact street
  assert.ok(decodeURIComponent(l).includes('Скопје'), l);
  assert.ok(!l.includes('openstreetmap'), l);
});

test('LandmarkService.enrich: stamps the feed-picked landmark onto the property', async () => {
  const db = new Db(':memory:');
  const svc = new LandmarkService(db, { osm: false });
  const prop = {
    eb: 48, address: 'ул. Пример 5', location: 'Карпош III',
    landmarks: [{ landmark: 'Кафе бар Ван Гог', type: 'cafe', distance_m: 120 }] as FeedLandmark[],
  };
  await svc.enrich([prop]);
  assert.equal(prop.landmark, 'Кафе бар Ван Гог');
});
