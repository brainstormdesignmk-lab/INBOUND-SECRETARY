// ROUTE COVERAGE (R1 part 1) — no lane the executor logs may sit outside the
// calibration registry, and no registry row may mirror an intent ROUTING_ORDER
// lacks. Reads the REAL inbound.ts text at test time, so the registry cannot
// go stale against the executor: a future "add one inline if in the middle of
// 7.5k lines" lands RED until its row exists — exactly the audit's rule
// (every lane is either mirrored or explicitly pending).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'fs';
import * as path from 'path';
import { ROUTE_LANES, ROUTING_ORDER, resolveIntent } from '../src/handlers/router';
import { SIMPLE_DETECTORS } from '../src/handlers/router';

// The REAL inbound.ts source is not emitted into dist-test by tsc (only .js
// is), so a plain __dirname join breaks the compiled test run with ENOENT.
// Walk up from this file's directory until the source exists — that finds the
// ROOT source tree under both tsx (tests/) and the compiled tree
// (dist-test/tests).
function findUpward(rel: readonly string[]): string {
  let dir = path.resolve(__dirname);
  for (let i = 0; i < 6 && dir !== path.dirname(dir); i++) {
    const candidate = path.join(dir, ...rel);
    if (existsSync(candidate)) return candidate;
    dir = path.dirname(dir);
  }
  return path.join(__dirname, '..', ...rel); // legacy path — readFileSync throws its own clear ENOENT
}
const inboundSrc = readFileSync(findUpward(['src', 'handlers', 'inbound.ts']), 'utf8');

/** Lane tags logged by the executor: routeLog(chatId…, 'TAG[S][:fast]'). */
const loggedTags = new Set<string>();
for (const m of inboundSrc.matchAll(/routeLog\(chatId,\s*text,\s*'([A-Z_][A-Z_0-9:.]*)'/g)) {
  loggedTags.add(m[1]);
}
// The combined-fee ternary logs FEE_RULES / FEE_WHY / FEE_COMPLAINT on one line.
if (inboundSrc.includes("feeRulesQ ? 'FEE_RULES' : feeWhyFast ? 'FEE_WHY' : 'FEE_COMPLAINT'")) {
  ['FEE_RULES', 'FEE_WHY', 'FEE_COMPLAINT'].forEach(t => loggedTags.add(t));
}
// VARIABLE-intent sites (dispatchSimple, drift tags, PERSONAL:…, LANE_COLLISION:…,
// VISIT_CANCEL:<state>) interpolate instead of quoting — they are excluded from
// the static scan on purpose; their calibration lives in ROUTE_LANES rows like
// OFFTOPIC/DEFER/ESCALATION (the dispatchable intents) and the dynamic suffixes
// carry state context rather than lane identity.
for (const d of SIMPLE_DETECTORS) loggedTags.add(d.intent);

test('every lane tag the executor logs has a calibration row (mirrored or pending)', () => {
  const missing: string[] = [];
  for (const tag of loggedTags) {
    if (!ROUTE_LANES[tag]) missing.push(tag);
  }
  assert.deepEqual(missing, [], `unlabeled lane tags (add the ROUTE_LANES row): ${missing.join(', ')}`);
});

test('every mirrored row points at an intent ROUTING_ORDER actually contains', () => {
  const intents = new Set(ROUTING_ORDER.map(r => r.intent));
  const dangling: string[] = [];
  for (const [tag, row] of Object.entries(ROUTE_LANES)) {
    if (row && row.intent && !intents.has(row.intent)) dangling.push(`${tag}→${row.intent}`);
  }
  assert.deepEqual(dangling, [], `mirrored rows with no ROUTING_ORDER intent: ${dangling.join(', ')}`);
});

test('the pending backlog is explicit and finite (migration fuel, not a graveyard)', () => {
  const pending = Object.entries(ROUTE_LANES).filter(([, r]) => !r || !r.intent);
  assert.ok(pending.length > 0, 'the backlog must exist until the migration ends (keep it honest)');
  // THE CEILING MOVED WITH A REAL LANE, NOT WITH INFLATION: the place ring
  // (PLACE_RING_ASK / PLACE_RING_ROW, the [04:05] capture) used to log to the
  // enrichment table ONLY, so the calibration registry never saw the lane at
  // all — registering both arms is what pushed the count from 59 to 61. The
  // ceiling tracks the lanes that exist; it must keep FALLING as the migration
  // lands rows, so do not raise it again for a lane that is not new.
  // The ceiling tracks the lanes that EXIST: AREA_HAVE_SEARCH is a new lane
  // (the [19:46] capture — «а во која населба има?» had no owner, so the place
  // lane answered it with a landmark), so the ceiling moves by exactly that one
  // row. It must keep falling as those lanes are mirrored; never raise it for a
  // row that is not a new lane.
  assert.ok(pending.length < 63, `backlog too large to be honest: ${pending.length}`);
});

// R1 part 2 — the three lanes that moved from dispatchSimple into the mirror.
test('the newly mirrored lanes resolve through ROUTING_ORDER on canonical texts', () => {
  assert.equal(resolveIntent('I LI SVAKOJA KUKJA I STAN, KOJA E PODOBRA?', 'presentation'), 'COMPARISON');
  assert.equal(resolveIntent('DALI STANOT IMA PARKING?', 'presentation'), 'FEATURE_ASK');
  assert.equal(resolveIntent('NIKOJ NE ZEMA PARI ZA POSETA?', 'closing'), 'FEE_WHY');
  // The same-word collision stays two-directional: provision wording must NOT
  // steal the bare WHY claim, and a genuine provision ask must NOT lose it.
  assert.equal(resolveIntent('KOLKU E PROVIZIJATA?', 'closing'), 'PROVISION_ASK');
});
