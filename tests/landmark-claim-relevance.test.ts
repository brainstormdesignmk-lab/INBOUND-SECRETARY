// WHO MAY BE CALLED «ВО БЛИЗИНА НА» — the relevance rule behind the [10:24]
// field capture:
//   «Тоа се наоѓа во близина на ПЗУ Аптека Линцура 2.» + a pin on the pharmacy
// The pharmacy stood 1 m from the flat's own building, so distance-first
// ranking (and the feed roster, ranked by distance at import) put it in the
// first slot ahead of everything the client actually knows. The owner's rule:
// a pharmacy is NOT a well-known place and it can be closed tomorrow — a
// landmark line is a direction, so it must name a place that will still be
// there and that people name.
//
// The rule (admitsLandmarkClaim, src/geo/offlineMap.ts):
//   • a DURABLE class (school, kindergarten, church, park, square, market,
//     mall, hospital, embassy, hall …) qualifies with no evidence at all —
//     Google holds 0 reviews on most municipal kindergartens;
//   • a TRANSIENT business (pharmacy, bank, hotel, cafe, clinic, gym …) needs
//     KNOWN_PLACE_MIN_REVIEWS Google reviews — evidence that people name it;
//   • a place the map cannot judge (a curated name with no map row) is not
//     refused — only a measured row can be refused for what it is.
//
// Every claim site applies it: the feed roster (feedRosterSlots), the map-scan
// rotation (nearbyLandmarks) and the import-time resolver (resolve → the pass
// that MINTS a roster).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Db } from '../src/store/db';
import { LandmarkService } from '../src/geo/landmarks';
import {
  OfflineMapStore, writeMap, admitsLandmarkClaim, KNOWN_PLACE_MIN_REVIEWS,
} from '../src/geo/offlineMap';

function tmpMapDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'claim-rule-')), 'map.db');
}

/** EB 50's block: the flat at (41.9962, 21.4147). The pharmacy is 94 m away
 *  and leads every distance-first ranking; the kindergarten is 174 m and is
 *  the place the neighbourhood actually names. */
const PROP = { id: 50, eb: 50, address: 'Ул. Тест 50', location: 'Центар',
  lat: 41.9962, lon: 21.4147, geo_source: 'stored' } as const;

const PHARMACY = {
  name: 'ПЗУ Аптека Линцура 2', type: 'Pharmacy', lat: 41.99560, lon: 21.41518,
  source: 'google', review_count: 0, closed: 0,
};
const KINDERGARTEN = {
  name: 'Kindergarten "Kocho Racin" - Naum N. Borche', type: 'Kindergarten',
  lat: 41.99727, lon: 21.41594, source: 'google', review_count: 6, closed: 0,
};

describe('the claim rule itself', () => {
  it('a durable public class needs no Google evidence', () => {
    for (const type of ['school', 'Kindergarten', 'cathedral', 'park', 'square',
      'market', 'Shopping mall', 'hospital', 'Embassy', 'hall', 'university']) {
      assert.equal(admitsLandmarkClaim({ type, review_count: 0 }), true, `${type} is a place people name`);
    }
  });

  it('a transient business needs the reviews that prove people know it', () => {
    for (const type of ['Pharmacy', 'bank', 'Hotel', 'cafe', 'clinic', 'fitness_centre', 'fuel']) {
      assert.equal(admitsLandmarkClaim({ type, review_count: 0 }), false, `${type} at 0 reviews is a storefront`);
      assert.equal(admitsLandmarkClaim({ type, review_count: KNOWN_PLACE_MIN_REVIEWS }), true,
        `${type} with ${KNOWN_PLACE_MIN_REVIEWS} reviews is a place people name`);
    }
  });

  it('a geographic label is never a landmark («во близина на Центар» says nothing)', () => {
    for (const type of ['suburb', 'neighbourhood', 'locality']) {
      assert.equal(admitsLandmarkClaim({ type, review_count: 500 }), false, `${type} is a label`);
    }
  });
});

describe('the [10:24] capture: the pharmacy never anchors the answer', () => {
  it('the map-scan rotation names the durable place, never the closer pharmacy', () => {
    const db = new Db(':memory:');
    const dbPath = tmpMapDb();
    writeMap(dbPath, [PHARMACY, KINDERGARTEN] as never, []);
    const map = new OfflineMapStore(dbPath);
    const svc = new LandmarkService(db, { osm: false, offlineMap: map });

    const rotation = svc.nearbyLandmarks({ ...PROP } as never);
    assert.deepEqual(rotation.map(r => r.landmark), [KINDERGARTEN.name],
      `only the place people name may be served: ${JSON.stringify(rotation.map(r => r.landmark))}`);
    map.close();
  });

  it('the FEED roster is judged too — the distance-ranked pharmacy slot is dropped', () => {
    const db = new Db(':memory:');
    const dbPath = tmpMapDb();
    writeMap(dbPath, [PHARMACY, KINDERGARTEN] as never, []);
    const map = new OfflineMapStore(dbPath);
    const svc = new LandmarkService(db, { osm: false, offlineMap: map });

    // Exactly the live roster: Ана's import ranked by distance, pharmacy first.
    const rotation = svc.nearbyLandmarks({
      ...PROP,
      landmarks: [
        { landmark: PHARMACY.name, type: 'Pharmacy', distance_m: 94,
          maps_url: `https://maps.google.com/?q=${PHARMACY.lat},${PHARMACY.lon}` },
        { landmark: KINDERGARTEN.name, type: 'Kindergarten', distance_m: 174,
          maps_url: `https://maps.google.com/?q=${KINDERGARTEN.lat},${KINDERGARTEN.lon}` },
      ],
    } as never);
    assert.deepEqual(rotation.map(r => r.landmark), [KINDERGARTEN.name],
      `the roster must not serve a storefront: ${JSON.stringify(rotation.map(r => r.landmark))}`);
    map.close();
  });

  it('a pharmacy the map KNOWS (20+ reviews) still earns its slot', () => {
    // The rule refuses a nameless branch, not the class: the 4.7★ pharmacy
    // with hundreds of reviews IS the corner people give directions by.
    const known = { ...PHARMACY, name: 'Аптека Влае', review_count: 340, rating: 4.7 };
    const db = new Db(':memory:');
    const dbPath = tmpMapDb();
    writeMap(dbPath, [known, KINDERGARTEN] as never, []);
    const map = new OfflineMapStore(dbPath);
    const svc = new LandmarkService(db, { osm: false, offlineMap: map });

    const rotation = svc.nearbyLandmarks({ ...PROP } as never);
    const names = rotation.map(r => r.landmark);
    assert.ok(names.includes('Аптека Влае'), `an evidenced pharmacy is a landmark: ${JSON.stringify(names)}`);
    map.close();
  });

  it('the import-time resolver mints NO landmark when only a storefront is in reach', async () => {
    const db = new Db(':memory:');
    const dbPath = tmpMapDb();
    writeMap(dbPath, [PHARMACY] as never, []);
    const map = new OfflineMapStore(dbPath);
    const svc = new LandmarkService(db, { osm: false, offlineMap: map });

    const l = await svc.resolve({ ...PROP, details: 'Стан во Центар.' } as never);
    assert.equal(l.source, 'none',
      `a pharmacy-only block must fall back to the honest neighbourhood line, not to the pharmacy: ${l.landmark}`);
    // …and the rotation agrees (no roster was minted for it either).
    assert.deepEqual(svc.nearbyLandmarks({ ...PROP } as never), []);
    map.close();
  });
});
