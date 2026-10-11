#!/usr/bin/env node
/*
 * link-geo.js — make maps-realestate the SINGLE source of the geo engine.
 *
 * WHY: LINA used to carry its own copy of src/geo (4.2k lines). Two copies of
 * the same engine drifted apart silently — LINA's landmarks.ts gained the pin
 * fix while maps-realestate's gained the semantic lexicon, and nothing could
 * detect it. LINA now links to the maps project's tree instead, so the engine
 * has exactly one owner and GEO_VERSION.txt means something again.
 *
 * LINA does not embed geo code: src/geo is a link (gitignored, machine-local),
 * while LINA still compiles it into its own dist/ via `preserveSymlinks`.
 * That keeps every one of the 53 import sites unchanged and needs no network,
 * no package registry and no service running at request time.
 *
 * Idempotent: safe to run from `npm install`, the deploy, or by hand.
 * Fails loudly (exit 1) rather than leaving a half-created link, because a
 * stale link would build against the wrong tree.
 *
 * Usage: node scripts/link-geo.js
 *   MAPS_ROOT=/abs/path/to/maps-realestate  overrides auto-detection.
 */
'use strict';

const fs = require('fs');
const path = require('path');

const LINA_ROOT = path.resolve(__dirname, '..');
const LINK_PATH = path.join(LINA_ROOT, 'src', 'geo');

/** Candidate roots, tried in order. The list covers both known layouts:
 *  workstation  Documents/real-estate-atoms/secretaries/inbound_final/scripts
 *              → ../../../../maps-realestate
 *  atom        PROJECTS/LINA/scripts → ../../maps-realestate          */
const CANDIDATES = [
  process.env.MAPS_ROOT,
  path.resolve(__dirname, '../../../../maps-realestate'),
  path.resolve(__dirname, '../../maps-realestate'),
  path.resolve(LINA_ROOT, '../maps-realestate'),
].filter(Boolean);

function fail(msg) {
  console.error(`[link-geo] ✗ ${msg}`);
  process.exit(1);
}

// Locate the maps project by a file that only exists there.
const root = CANDIDATES.find((r) =>
  fs.existsSync(path.join(r, 'src', 'geo', 'offlineMap.ts'))
);
if (!root) {
  fail(
    'could not find maps-realestate.\n' +
    '  Set MAPS_ROOT=/abs/path/to/maps-realestate and re-run.\n' +
    '  Tried:\n' +
    CANDIDATES.map((c) => `    ${c}`).join('\n')
  );
}

const target = path.join(root, 'src', 'geo');

// ── geo-only TESTS are linked too ───────────────────────────────────────────
// The same drift hit the test suite: 12 of these files were byte-identical
// copies of maps-realestate's, edited by hand on both sides until they silently
// disagreed about what the engine guarantees (the "expectation drift" failures
// in LINA and phase13-whereis-live). A copy has no owner, so these become links
// exactly like src/geo: the engine and its spec travel together, and a change
// to the ranking is only mergeable together with the test that pins it.
//
// Only PURE geo tests are linked. Anything importing ../src/store/db is an atom
// integration test (import-geo, map-learn, nearby-landmarks, poison-sweep,
// queue-drain) — it exercises the atom's own store and stays a real file here.
const GEO_ONLY_TESTS = [
  'bbox-prune', 'dedupe-suspects', 'dedupe', 'details-extract', 'landmark-tiers',
  'offlineMap', 'place-identity', 'resolve-offline', 'serp-capture',
  'street-census', 'tile-coverage', 'type-normalize',
];

/** Link one file. A real file is replaced ONLY when it is byte-identical to
 *  the maps project's copy — that proves there is nothing local to lose. Any
 *  difference is refused loudly, because it may hold local edits; the operator
 *  reconciles it deliberately instead of losing it to a symlink. */
function linkFile(from, to, label) {
  const fromRel = path.relative(LINA_ROOT, from);
  try {
    const st = fs.lstatSync(to);
    if (st.isSymbolicLink()) {
      if (fs.realpathSync(to) === fs.realpathSync(from)) return 'ok';
      fs.unlinkSync(to);                       // stale link — repair it
    } else if (st.isDirectory()) {
      fail(`${label} is a directory, not a file — refusing to touch it`);
    } else {
      // A real file. Identical → safe to replace (nothing is lost). Different →
      // refuse, and say exactly which file to reconcile.
      if (fs.readFileSync(to, 'utf8') !== fs.readFileSync(from, 'utf8')) {
        fail(
          `${label} differs from ${fromRel}.\n` +
          `  It may hold local edits, so it will NOT be replaced by a link.\n` +
          `  Reconcile it, then re-run:\n` +
          `    diff ${fromRel} ${label}\n` +
          `  (If the difference is intentional, move it out of GEO_ONLY_TESTS.)`
        );
      }
      fs.unlinkSync(to);                       // provably identical — no loss
    }
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
  const rel = path.relative(path.dirname(to), from) || '.';
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.symlinkSync(rel, to);
  return 'linked';
}

// ── src/geo ─────────────────────────────────────────────────────────────────
// NOTE: no early exit on "already linked" — the tests below must link on every
// run too. An early return here is exactly how the test copies survived a
// deploy that reported success.
try {
  const st = fs.lstatSync(LINK_PATH);
  if (st.isSymbolicLink()) {
    const resolved = fs.realpathSync(LINK_PATH);
    if (resolved === fs.realpathSync(target)) {
      console.log(`[link-geo] ok — src/geo already links to ${target}`);
    } else {
      // Stale link (moved checkout, or the wrong project) → repair it.
      fs.unlinkSync(LINK_PATH);
      const rel0 = path.relative(path.dirname(LINK_PATH), target) || '.';
      fs.symlinkSync(rel0, LINK_PATH, 'dir');
      console.log(`[link-geo] ok — src/geo relinked → ${rel0}  (maps-realestate at ${root})`);
    }
  } else if (st.isDirectory()) {
    // A real directory means an un-migrated checkout. Never delete it: it may
    // be the only copy of local edits.
    fail(
      `src/geo is a real directory, not a link.\n` +
      `  Refusing to delete it — it may hold local edits.\n` +
      `  If it is the old embedded copy, move it aside first:\n` +
      `    mv src/geo src/geo.embedded-<date> && node scripts/link-geo.js`
    );
  } else {
    fail(`src/geo exists but is neither a directory nor a symlink`);
  }
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  // Nothing there — create it.
  fs.mkdirSync(path.dirname(LINK_PATH), { recursive: true });
  const rel = path.relative(path.dirname(LINK_PATH), target) || '.';
  fs.symlinkSync(rel, LINK_PATH, 'dir');
  console.log(`[link-geo] ok — src/geo → ${rel}  (maps-realestate at ${root})`);
}

// ── geo-only tests ───────────────────────────────────────────────────────────
// Same single-owner rule as src/geo: the engine's spec lives with the engine.
const testsDir = path.join(LINA_ROOT, 'tests');
let linked = 0;
let alreadyOk = 0;
for (const name of GEO_ONLY_TESTS) {
  const from = path.join(root, 'tests', `${name}.test.ts`);
  const to = path.join(testsDir, `${name}.test.ts`);
  // The maps project owns the spec — if the file is not there, this checkout
  // predates the split and there is nothing to link against.
  if (!fs.existsSync(from)) continue;
  const result = linkFile(from, to, `tests/${name}.test.ts`);
  if (result === 'linked') linked++;
  else alreadyOk++;
}
if (linked > 0) {
  console.log(`[link-geo] ok — ${linked} geo test(s) linked, ${alreadyOk} already linked`);
} else if (alreadyOk > 0) {
  console.log(`[link-geo] ok — all ${alreadyOk} geo tests already link to maps-realestate`);
}

// ── drift guard ──────────────────────────────────────────────────────────────
// The integration tests that MUST stay real files here (they import the atom's
// own store/db) can still silently disagree with the engine they pin. Compare
// them against the maps project and fail loudly, so "expectation drift" shows
// up as a build error instead of a mystery test failure months later.
const INTEGRATION_TESTS = [
  'import-geo', 'map-learn', 'nearby-landmarks', 'poison-sweep', 'queue-drain',
];
const drifted = [];
for (const name of INTEGRATION_TESTS) {
  const mine = path.join(testsDir, `${name}.test.ts`);
  const theirs = path.join(root, 'tests', `${name}.test.ts`);
  if (!fs.existsSync(mine) || !fs.existsSync(theirs)) continue;
  if (fs.readFileSync(mine, 'utf8') !== fs.readFileSync(theirs, 'utf8')) drifted.push(name);
}
if (drifted.length > 0) {
  console.error(
    `[link-geo] ✗ ${drifted.length} integration test(s) differ from maps-realestate:\n` +
    drifted.map((n) => `      tests/${n}.test.ts`).join('\n') +
    `\n  These pin the geo engine's behaviour but live here because they use\n` +
    `  the atom's own store. Reconcile them with maps-realestate/tests/ —\n` +
    `  a silent difference is the exact "expectation drift" this guard exists\n` +
    `  to catch. (Run: diff maps-realestate/tests/<name>.test.ts tests/<name>.test.ts)`
  );
  process.exit(1);
}
