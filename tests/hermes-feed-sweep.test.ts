import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sameFeedList, storedLandmarkList } from '../src/scripts/hermesLandmarks';
import { mapRow } from '../src/data/properties';

// WHAT WENT WRONG (2026-10-11, the "8 legacy rows"):
//
// properties.parseFeedLandmarks drops any claim beyond FEED_LANDMARK_MAX_M at
// READ time. That is the right contract for a client — a 1.2km "во близина на"
// is simply false. But the nightly sweep compared p.landmarks (the FILTERED
// list) against what the map would produce today, so a row whose only defect
// was an over-cap entry compared equal to a short in-ring list and was never
// rewritten. The reader's guard hid the very rows the writer was supposed to
// heal, and the dirty JSON stayed live in the DB indefinitely.
//
// The sweep must compare the AS-STORED list. The reader's cap stays exactly
// where it is — it protects clients — but it must never decide what the writer
// believes is already correct.

test('a raw over-cap entry makes the row differ from the map — the sweep rewrites it', () => {
  // What the row looks like in the DB: an in-ring place plus a 1.2km claim.
  const storedRaw = [
    { landmark: 'Парк Авионче', type: 'park', distance_m: 174 },
    { landmark: 'Diamond Mall', type: 'mall', distance_m: 1200 },
  ];
  // What the map would produce today: the in-ring park only. parseFeedLandmarks
  // always emits every key, so `maps_url` is present-but-undefined — match that
  // shape or deepStrictEqual reports a difference that is only key presence.
  const desired = [{ landmark: 'Парк Авионче', type: 'park', distance_m: 174, maps_url: undefined }];

  // The reader drops the 1.2km claim, so the FILTERED list looks identical to
  // `desired`. That is the client contract, and it is correct.
  const row = mapRow({ evidenten_broj: '89', adresa: 'Бул. АСНОМ Бр.134', landmarks: storedRaw });
  assert.ok(row, 'the fixture row maps');
  const filtered = row.landmarks ?? [];
  assert.deepEqual(filtered, desired, 'reader-side cap drops the over-cap entry');

  // …but the sweep must NOT be fooled by it. Comparing the parsed list would
  // report this row "already matches the map" and leave the 1.2km claim live.
  assert.equal(sameFeedList(filtered, desired), true, 'the trap: filtered equals desired');
  // `row` is exactly what the sweep iterates — its `.raw` is the untouched
  // feed row, so this asserts the real object, not a hand-built stand-in.
  assert.equal(
    sameFeedList(storedLandmarkList(row), desired),
    false,
    'the as-stored list still carries the 1.2km claim, so the sweep must rewrite it',
  );
});

test('a genuinely current row is still left alone (no needless rewrite)', () => {
  const list = [{ landmark: 'ТЦ Мавровка', type: 'mall', distance_m: 54 }];
  const raw = { landmarks: list };
  assert.equal(sameFeedList(storedLandmarkList({ landmarks: list, raw }), list), true);
});

test('no raw column at all falls back to the parsed list', () => {
  const list = [{ landmark: 'Рептил', type: 'supermarket', distance_m: 53 }];
  assert.deepEqual(storedLandmarkList({ landmarks: list }), list);
  assert.deepEqual(storedLandmarkList({}), []);
});
