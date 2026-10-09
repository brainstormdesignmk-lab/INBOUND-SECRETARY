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

// Already linked correctly → nothing to do.
try {
  const st = fs.lstatSync(LINK_PATH);
  if (st.isSymbolicLink()) {
    const resolved = fs.realpathSync(LINK_PATH);
    if (resolved === fs.realpathSync(target)) {
      console.log(`[link-geo] ok — src/geo already links to ${target}`);
      process.exit(0);
    }
    // Stale link (moved checkout, or the wrong project) → repair it.
    fs.unlinkSync(LINK_PATH);
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
  // Nothing there — fall through and create it.
}

fs.mkdirSync(path.dirname(LINK_PATH), { recursive: true });
const rel = path.relative(path.dirname(LINK_PATH), target) || '.';
fs.symlinkSync(rel, LINK_PATH, 'dir');
console.log(`[link-geo] ok — src/geo → ${rel}  (maps-realestate at ${root})`);
