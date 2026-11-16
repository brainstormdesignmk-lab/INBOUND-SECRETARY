// THE SINGLE-WRITER MAP, PINNED.
//
// The feed is ONE table (`properties`): price, address, landmarks, geo and the
// place-card identity are all columns on it. So "one writer per table" has to be
// stated per WRITE SURFACE, and the two silent failures this guards against are
// both indistinguishable from success:
//
//   • an atom re-ranking rosters from its own COPY of the map. Two hosts hold a
//     map; they do not hold the same map. Last writer wins, nobody is told, and
//     the client is served landmarks measured from a map the master never
//     approved.
//   • a center or a place-card identity rewritten by a box that was not the one
//     the map pass measured against.
//
// [ ] every surface has exactly ONE owner, and the ids are unique
// [ ] an ATOM is refused the map-derived surfaces (roster / center / place card)
// [ ] an ATOM is allowed the owner-dictated ones (price / address) — those exist
//     only in its conversations
// [ ] the MASTER is refused the owner-dictated ones, and allowed the map ones
// [ ] an UNDECLARED surface throws — a typo must never read as "allowed"
// [ ] the role is DERIVED from evidence (can this host write the map?) and fails
//     closed: no map, or a read-only map, means atom
// [ ] LINA_ROLE overrides the evidence, and a non-role value is an error

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import {
  FEED_WRITE_SURFACES,
  assertFeedWrite,
  declaredRole,
  describeWriters,
  feedWriteSurface,
  resolveHostRole,
  writeRefusal,
  FeedWriteRefused,
} from '../src/feed/writePolicy';

const MAP_DERIVED = ['geo:center', 'landmarks:roster', 'place:card'];
const OWNER_DICTATED = ['price:public', 'address:owner'];

test('every write surface is declared, id-unique, and has exactly one owner', () => {
  const ids = FEED_WRITE_SURFACES.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length, 'no duplicate surface id');
  for (const s of FEED_WRITE_SURFACES) {
    assert.ok(s.owner === 'master' || s.owner === 'atom', `${s.id} names a real role`);
    assert.ok(s.columns.length > 0, `${s.id} names the columns it touches`);
    assert.ok(s.why.length > 20, `${s.id} says WHY that role owns it`);
    assert.equal(feedWriteSurface(s.id)?.owner, s.owner, `${s.id} is resolvable by id`);
  }
});

test('an atom is a READER for everything derived from the map', () => {
  for (const id of MAP_DERIVED) {
    const refusal = writeRefusal(id, 'atom');
    assert.ok(refusal, `${id} must be refused to an atom`);
    assert.match(refusal!, /owned by the master/);
    assert.throws(() => assertFeedWrite(id, 'atom'), FeedWriteRefused);
  }
});

test('an atom writes the owner-dictated facts — and only those', () => {
  for (const id of OWNER_DICTATED) {
    assert.equal(writeRefusal(id, 'atom'), undefined, `${id} belongs to the atom`);
    assert.doesNotThrow(() => assertFeedWrite(id, 'atom'));
  }
  // The master does NOT get to author them: they only exist in the conversation.
  assert.match(writeRefusal('price:public', 'master')!, /atom\'s/);
  assert.match(writeRefusal('address:owner', 'master')!, /atom\'s/);
});

test('the master owns the map-derived surfaces', () => {
  for (const id of MAP_DERIVED) {
    assert.equal(writeRefusal(id, 'master'), undefined, `${id} belongs to the master`);
    assert.doesNotThrow(() => assertFeedWrite(id, 'master'));
  }
});

test('an UNDECLARED surface throws instead of defaulting to allowed', () => {
  // The real typo class: 'landmarks:rosters' (plural) would otherwise be a
  // silent "no rule, so go ahead".
  assert.throws(() => writeRefusal('landmarks:rosters', 'master'), /not a declared write surface/);
  assert.throws(() => assertFeedWrite('geo:centres', 'master'), /not a declared write surface/);
});

test('the refusal carries the surface, the actual role and the owner', () => {
  try {
    assertFeedWrite('landmarks:roster', 'atom');
    assert.fail('should have thrown');
  } catch (e) {
    assert.ok(e instanceof FeedWriteRefused);
    assert.equal(e.surface, 'landmarks:roster');
    assert.equal(e.role, 'atom');
    assert.equal(e.owner, 'master');
    assert.match(e.message, /REFUSED/);
    assert.match(e.message, /properties\.landmarks/);
  }
});

test('the role is derived from EVIDENCE, and fails closed', () => {
  const writable = () => 'writable' as const;
  const readOnly = () => 'readonly' as const;

  // explicit override wins over the evidence
  assert.equal(resolveHostRole({ env: { LINA_ROLE: 'atom' } as NodeJS.ProcessEnv, mapPath: '/m.db', probe: writable }).role, 'atom');
  assert.equal(resolveHostRole({ env: { LINA_ROLE: 'master' } as NodeJS.ProcessEnv, mapPath: '/m.db', probe: readOnly }).role, 'master');

  // a writable map IS the authority; a read-only one is a shipped copy
  const master = resolveHostRole({ env: {} as NodeJS.ProcessEnv, mapPath: '/m.db', probe: writable });
  assert.equal(master.role, 'master');
  assert.match(master.why, /writable/);
  const atom = resolveHostRole({ env: {} as NodeJS.ProcessEnv, mapPath: '/m.db', probe: readOnly });
  assert.equal(atom.role, 'atom');
  assert.match(atom.why, /read-only/);

  // no map resolved, or a map that is not there: nothing to author from
  assert.equal(resolveHostRole({ env: {} as NodeJS.ProcessEnv, mapPath: undefined }).role, 'atom');
  const missing = resolveHostRole({ env: {} as NodeJS.ProcessEnv, mapPath: '/nonexistent/skopje-pois.db', probe: () => 'missing' as const });
  assert.equal(missing.role, 'atom');
  assert.match(missing.why, /missing/);
});

test('the real probe answers for a real file — read-only ships are atoms', () => {
  // The deploy sets the shipped copy read-only (deploy_map.sh), so this is the
  // exact state an atom is in. Skipped only for root, where W_OK is always true.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'feed-role-'));
  const file = path.join(dir, 'skopje-pois.db');
  fs.writeFileSync(file, 'x');
  try {
    assert.equal(resolveHostRole({ env: {} as NodeJS.ProcessEnv, mapPath: file }).role, 'master');
    if (process.getuid?.() !== 0) {
      fs.chmodSync(file, 0o444);
      const ro = resolveHostRole({ env: {} as NodeJS.ProcessEnv, mapPath: file });
      assert.equal(ro.role, 'atom', 'a read-only map is a copy, not an authority');
      assert.match(ro.why, /read-only/);
    }
    assert.equal(resolveHostRole({ env: {} as NodeJS.ProcessEnv, mapPath: path.join(dir, 'nope.db') }).role, 'atom');
  } finally {
    try { fs.chmodSync(file, 0o644); } catch { /* ignore */ }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('LINA_ROLE is validated — a non-role is an error, not a silent atom', () => {
  assert.equal(declaredRole({ LINA_ROLE: '  ATOM ' } as NodeJS.ProcessEnv), 'atom');
  assert.equal(declaredRole({} as NodeJS.ProcessEnv), undefined);
  assert.throws(() => declaredRole({ LINA_ROLE: 'master-ish' } as NodeJS.ProcessEnv), /not a role/);
});

test('the printable map lists every surface with its owner', () => {
  const text = describeWriters();
  for (const s of FEED_WRITE_SURFACES) {
    assert.ok(text.includes(s.id), `${s.id} appears in the printed map`);
    assert.ok(text.includes(s.owner), `${s.id}'s owner appears`);
  }
});
