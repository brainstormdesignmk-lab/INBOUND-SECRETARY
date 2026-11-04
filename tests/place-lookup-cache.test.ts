/**
 * THE LANDMARK LOOKUP IS PAID ONCE — the regression for the 18 s turn.
 *
 * Measured on this repo before the fix: one `findPoiByName(«Капитол Мол»)` cost
 * 2.2 s and a single «STO IMATE KAJ KAPITOL MOL» turn 18.5 s, EVERY time. Two
 * causes, both fixed in `src/geo/offlineMap.ts`:
 *
 *  1. every name pass re-ran `SELECT … FROM pois` and re-derived the same
 *     per-row facts (healed name, transliteration, category, shop/transit
 *     flags, token/phonetic/canonical/typo keys) for all 5.992 rows on every
 *     call;
 *  2. the ranking scored `matchRank`/`partOfVenue` INSIDE the sort comparator,
 *     re-tokenizing and re-transliterating every candidate O(n log n) times.
 *
 * The contract this file pins: the per-row facts are derived once per store and
 * reused, the same question asked twice is answered from that cache, and the
 * ANSWERS do not change (a hit stays its hit, a miss stays a miss, and a caller
 * cannot corrupt the cache by mutating what it was handed).
 *
 * The timing ceiling is deliberately generous (the old behaviour was ~44 s for
 * these 20 calls, the fixed one is ~1 ms): it is a guard against re-introducing
 * the per-call scan, not a benchmark.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../src/config';
import { OfflineMapStore } from '../src/geo/offlineMap';

function findProjectRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) return dir;
    const parent = path.resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`cannot find project root from ${from}`);
}
const ROOT = findProjectRoot(__dirname);
const SOURCE = fs.readFileSync(path.join(ROOT, 'src/geo/offlineMap.ts'), 'utf8');

/** The body of one method, from its `private name(`/`name(` line to the next
 *  method boundary (a blank line followed by an indented `/**` or `private`/
 *  `public` declaration). Deliberately crude: this is a source CONTRACT, and a
 *  crude scan fails loudly rather than silently matching nothing. */
function bodyOf(marker: string): string {
  const at = SOURCE.indexOf(marker);
  assert.ok(at >= 0, `offlineMap.ts no longer contains ${marker}`);
  const rest = SOURCE.slice(at);
  const end = rest.slice(marker.length).search(/\n\n  (?:\/\*\*|private |public |[a-zA-Z]+\()/);
  return end < 0 ? rest : rest.slice(0, marker.length + end);
}

test('the name passes read the cached index, never the table', () => {
  // THE ONE row-set read. Every name pass must go through it. (Other places
  // legitimately touch `pois`: the schema probe, stats(), the LIKE lookup and
  // the normed-name cache — but only poiRows() loads the row set the passes
  // derive from, and it must stay the only one.)
  const rowSetReads = SOURCE.split('\n')
    .map(l => l.trim())
    .filter(l => l.includes("SELECT name, type, lat, lon, place_url, place_id FROM pois"));
  assert.equal(rowSetReads.length, 1,
    `the POI row set may be read in exactly one place (poiRows), found ${rowSetReads.length}:\n${rowSetReads.join('\n')}`);
  assert.ok(SOURCE.includes('private poiRows(): PoiIndexRow[]'), 'the POI index builder is gone');
  // …and it is assigned in exactly one place, so the index cannot be rebuilt
  // per call by a second code path.
  assert.equal(SOURCE.split('this.poiIndex = (').length - 1, 1, 'the POI index is built in more than one place');
  for (const marker of ['private findPoiByNameCore(', 'findPoisByName(', 'private typoBest(']) {
    const body = bodyOf(marker);
    assert.ok(!body.includes('FROM pois'),
      `${marker} reads the table on every call again — it must use poiRows()/the row accessors`);
  }
});

test('a repeated lookup is answered from the cache, and the answers do not move', () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return; // no live map on this machine — offlineMap.test.ts pins the DB

  // Warm: the index build is the expensive, one-time part.
  const first = map.findPoiByName('Капитол Мол');
  const firstZebra = map.findPoiByName('Зебра');

  const started = process.hrtime.bigint();
  for (let i = 0; i < 20; i++) {
    assert.deepEqual(map.findPoiByName('Капитол Мол'), first, 'a cached lookup changed its answer');
    assert.deepEqual(map.findPoiByName('Зебра'), firstZebra);
  }
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  assert.ok(ms < 2000,
    `20 cached lookups took ${ms.toFixed(0)} ms — the per-call table scan/derivation is back`);

  // A remembered MISS stays a miss (the cache stores it, never invents a row).
  assert.equal(map.findPoiByName('Непознато Место'), undefined);
  assert.equal(map.findPoiByName('Непознато Место'), undefined);
  assert.equal(map.findPoiByName(''), undefined);

  // The cache hands out COPIES: one caller's edit is not the next caller's hit.
  const mutable = map.findPoiByName('Зебра');
  assert.ok(mutable);
  mutable.name = 'Оштетено';
  assert.equal(map.findPoiByName('Зебра')?.name, firstZebra?.name);

  // The place answers themselves are unchanged by the caching layer.
  assert.ok(firstZebra, 'the live map no longer answers a place it holds');
  assert.equal(firstZebra!.name, 'Зебра');
  assert.ok(first, '«Капитол Мол» must still bind to the mall family');
  assert.match(first!.name, /Capitol/i);
});

test('the same row set answers the same way through findPoisByName', () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return;
  const once = map.findPoisByName('Капитол');
  assert.ok(once.length > 0, 'findPoisByName lost a family it used to answer');
  assert.deepEqual(map.findPoisByName('Капитол'), once);
  // Every returned row is a real map row with coordinates, not a synthesised one.
  for (const r of once) {
    assert.ok(Number.isFinite(r.lat) && Number.isFinite(r.lon), `${r.name} carries no coordinates`);
    assert.ok(r.name.length > 0);
  }
});
