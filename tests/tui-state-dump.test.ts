// THE /state NOTEBOOK, on disk — completeness, not the summary.
//
// The pty funnel drives the LIVE command and asserts the summary rows plus the
// landmark array. That proves the command writes a file; it cannot prove the
// file is the WHOLE notebook, because a terminal can only show what the check
// already knows to look for. Here the payload builder is exercised directly:
// the dump must carry the session's own slots object (identity), so every slot
// SlotData grows later is included by construction — arrays, arrays of objects,
// null entries and nested state included.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freshSession, ChatSession } from '../src/fsm/session';
import { sessionStateDump, sessionStateRows, sessionStateFullRows, STATE_ROW_MAX_WIDTH } from '../src/tui/state';

test('the /state dump is the SESSION ITSELF — every slot, arrays and objects included', () => {
  const s: ChatSession = freshSession('test', 'dump-1');
  s.state = 'presentation';
  // A representative slice of SlotData: scalars, an array of ids, an array of
  // OBJECTS (coords), an array with NULL entries (place_ids), a nested object
  // (nearCenter) and booleans. Any projection would lose some of these.
  s.slots = {
    service: 'rent',
    location: 'Центар',
    budget: '80000',
    anywhere: true,
    house: false,
    propertyId: 79,
    interestedPropertyId: 79,
    presentedIds: [78, 56, 42],
    currentBatch: [56, 42],
    nearbyLandmarks: ['Броз Кафе', 'Геолошки завод', 'Општина Центар'],
    nearbyLandmarkCoords: [{ lat: 41.9981, lon: 21.4312 }, { lat: 42.0004, lon: 21.4295 }],
    nearbyLandmarkPlaceIds: ['cid-1', null],
    nearbyLandmarkEb: 79,
    nearCenter: { stage: 'ring', ring: ['Карпош', 'Аеродром'] },
    feeRejections: 1,
    provisionRejections: 0,
    viewingFeeAgreed: true,
  };

  const dump = sessionStateDump('dump-1', s);

  // IDENTITY: the record reads the session's own object. A future slot on
  // SlotData cannot be forgotten here — that is the completeness guarantee.
  assert.equal(dump.slots, s.slots, 'the dump must read the session slots by identity, never a projection');
  assert.equal(dump.state, 'presentation');
  assert.equal(dump.chatId, 'dump-1');
  assert.ok(!Number.isNaN(Date.parse(dump.at)), 'the dump carries a real timestamp');

  // SERIALIZATION: what lands on disk survives JSON exactly — arrays of ids,
  // arrays of objects, null place_ids and the nested ring object included.
  const onDisk = JSON.parse(JSON.stringify(dump)) as typeof dump;
  assert.deepEqual(onDisk.slots.presentedIds, [78, 56, 42]);
  assert.deepEqual(onDisk.slots.nearbyLandmarkCoords, [{ lat: 41.9981, lon: 21.4312 }, { lat: 42.0004, lon: 21.4295 }]);
  assert.deepEqual(onDisk.slots.nearbyLandmarkPlaceIds, ['cid-1', null]);
  assert.deepEqual(onDisk.slots.nearCenter, { stage: 'ring', ring: ['Карпош', 'Аеродром'] });
  assert.equal(onDisk.slots.viewingFeeAgreed, true, 'a TRUE consent must survive (a dropped one reads as consent never given)');
  assert.equal(onDisk.slots.feeRejections, 1);

  // EVERY key the session holds is present — no key is curated out.
  assert.deepEqual(Object.keys(onDisk.slots).sort(), Object.keys(s.slots).sort());
});

test('the /state rows carry the audited operator fields (funnel, money, anchor, blockers)', () => {
  const s = freshSession('test', 'rows-1');
  s.state = 'presentation';
  s.slots = {
    service: 'rent', location: 'Центар', budget: '80000', anywhere: true,
    propertyId: 79, presentedIds: [79, 56, 42], lastGhostEb: 57,
    visitTime: '17:00', name: 'Горан',
    feeRejections: 1, provisionRejections: 2, viewingFeeAgreed: true,
    areaExhausted: true, alternativesExhausted: true,
    ownerContactPending: true, queueAfterContact: true, byeServed: true,
  };
  const rows = sessionStateRows(s, 'data/session-state.json');
  const text = rows.join('\n');
  // funnel position + money script / ladders
  assert.match(text, /state=presentation svc=rent/);
  assert.match(text, /fee=1 prov=2 agreed=yes/);
  // search intent
  assert.match(text, /any=true bud=80000 loc=Центар/);
  // the flat on the table, the ghost that explains a not-found answer, and a
  // COUNT of what was served (arrays themselves stay in the dump)
  assert.match(text, /eb=79 ghost=57 shown=3/);
  // appointment + whether contact collection produced a name
  assert.match(text, /visit=17:00 name=y/);
  // the blockers: why she is widening / waiting on the owner / queueing / short goodbye
  assert.match(text, /exh=area\+alt owner=pend queue=y bye=y/);
  // the dump is the LAST row: the pty check reads it as the bottom of the block
  assert.match(rows[rows.length - 1]!, /^\[slots\] dump=data\/session-state\.json$/);
});

test('the /state rows never exceed the narrowest supported chat pane', () => {
  // Worst case: the longest FSM state, a 12-char neighbourhood, an over-long
  // budget/visit/error, big counters and every flag on. The width budget is the
  // 68-column terminal: floor(68 × 0.75) − 3 = 48 text columns.
  const s = freshSession('test', 'rows-2');
  s.state = 'contact_collection';
  s.slots = {
    service: 'rent', location: 'Ѓорче Петров', budget: '1234567890123', anywhere: true,
    propertyId: 123456, interestedPropertyId: 654321, lastGhostEb: 999999,
    presentedIds: Array.from({ length: 1200 }, (_, i) => i),
    visitTime: 'утре на пладне пред 12 часот', name: 'x',
    feeRejections: 4, provisionRejections: 4, viewingFeeAgreed: true,
    areaExhausted: true, alternativesExhausted: true,
    ownerContactPending: true, queueAfterContact: true, byeServed: true,
  };
  const rows = sessionStateRows(s, `error (${'x'.repeat(80)})`);
  for (const row of rows) {
    assert.ok([...row].length <= STATE_ROW_MAX_WIDTH, `row exceeds ${STATE_ROW_MAX_WIDTH} columns (${[...row].length}): ${row}`);
  }
});

test('/state full puts the WHOLE notebook on the pane — no JSON file needed', () => {
  const s = freshSession('test', 'full-1');
  s.state = 'presentation';
  s.slots = {
    service: 'rent', budget: '300', anywhere: true,
    presentedIds: [79], ladderQueue: [], currentBatch: [79],
    feeRejections: 1, viewingFeeAgreed: false,
  };
  const rows = sessionStateFullRows(s, 'data/session-state.json');
  // Header counts the DEFINED slots; `n` is the completeness claim.
  assert.match(rows[0]!, /^\[slots\] full state=presentation svc=rent n=8$/);
  assert.equal(Number(rows[0]!.match(/n=(\d+)/)![1]), 8);
  // Arrays, empty arrays and FALSE booleans all survive as their own rows.
  assert.ok(rows.includes('[slots] presentedIds=[79]'));
  assert.ok(rows.includes('[slots] ladderQueue=[]'));
  assert.ok(rows.includes('[slots] viewingFeeAgreed=false'));
  // Undefined slots are omitted (JSON.stringify would print null-ish noise).
  assert.ok(!rows.some(r => r.includes('location=')), 'undefined slots must not render');
  // Priority order: reach-for-first keys before the alphabetical tail.
  assert.ok(rows.findIndex(r => r.includes('service=')) < rows.findIndex(r => r.includes('presentedIds=')));
  // The dump row stays LAST — the same contract the compact view has.
  assert.match(rows[rows.length - 1]!, /^\[slots\] dump=/);
});

test('the /state rows degrade honestly with no session', () => {
  assert.deepEqual(sessionStateRows(undefined, 'off'), ['[slots] (нема сесија)']);
});

test('the /state dump keeps a slot added AFTER the helper was written (no allow-list)', () => {
  const s = freshSession('test', 'dump-2');
  s.state = 'closing';
  // Simulates SlotData growing: the dump has no schema to fall out of date.
  (s.slots as Record<string, unknown>)['aFutureSlot'] = ['x', { y: 1 }];
  const onDisk = JSON.parse(JSON.stringify(sessionStateDump('dump-2', s))) as { slots: Record<string, unknown> };
  assert.deepEqual(onDisk.slots.aFutureSlot, ['x', { y: 1 }]);
});
