// audit-feed-landmarks — the feed-level guard for the landmark contract.
//
// The FIRST stored landmark is the one name a client actually hears
// („во близина на …“), so it must be:
//   • MEASURABLE — a real distance inside the 200 m "во близина" ring
//   • RECOGNIZABLE — a type the map engine ranks (LANDMARK_PREFERENCE)
// and no entry in the list may be an over-cap or unranked claim.
//
// This runs against the LIVE public-properties feed (the same JSON the bot and
// the web page read), so it catches data regressions the moment they land —
// exactly the EB 94 class, where `dormitory` was unranked and the 63 m dorm
// lost the first slot to a 257 m mall / the 7 m supermarket at the door.
//
// A property with an empty list is reported as "no claim" (address unknown or
// unmappable) and is NOT a violation — the client gets the honest neighborhood
// line instead.
//
// Usage: npm run audit:landmarks
// Exit code: 0 = every claim is inside the contract, 1 = at least one violation.

import '../src/compat/node16';
import { loadConfig } from '../src/config';
import { firstLandmarkProblem, FEED_LANDMARK_MAX_M } from '../src/geo/landmarks';
import { typeRank } from '../src/geo/types';
import { FeedLandmark } from '../src/data/properties';

async function main(): Promise<void> {
  const cfg = loadConfig();
  console.log(`[audit-landmarks] feed: ${cfg.propertyDataUrl}`);
  const res = await fetch(cfg.propertyDataUrl);
  if (!res.ok) {
    console.error(`[audit-landmarks] ✗ feed HTTP ${res.status} — cannot audit`);
    process.exit(1);
  }
  const body = (await res.json()) as { properties?: Record<string, unknown>[] } | Record<string, unknown>[];
  const rows = Array.isArray(body) ? body : (body.properties ?? []);
  if (rows.length === 0) {
    console.error('[audit-landmarks] ✗ the feed returned no rows — refusing to report "clean"');
    process.exit(1);
  }

  let violations = 0;
  let empty = 0;
  let checked = 0;

  for (const r of rows) {
    const eb = r.evidenten_broj ?? r.eb ?? '?';
    const list = (Array.isArray(r.landmarks) ? r.landmarks : []) as FeedLandmark[];
    if (list.length === 0) {
      empty++;
      continue;
    }
    checked++;
    const issues: string[] = [];
    const first = firstLandmarkProblem(list);
    if (first) issues.push(`first: ${first}`);
    // Entry 0 is already fully covered by firstLandmarkProblem (distance AND
    // type), so only the tail is enumerated here — no duplicate lines.
    list.slice(1).forEach((l, j) => {
      const i = j + 1;
      const d = l.distance_m;
      if (typeof d !== 'number' || !Number.isFinite(d)) {
        issues.push(`#${i + 1} „${l.landmark}“ has no measured distance`);
      } else if (d > FEED_LANDMARK_MAX_M) {
        issues.push(`#${i + 1} „${l.landmark}“ is ${Math.round(d)} m (cap ${FEED_LANDMARK_MAX_M} m)`);
      }
      if (typeRank(l.type ?? '') === 0) {
        issues.push(`#${i + 1} „${l.landmark}“ has an unranked type „${l.type ?? ''}“`);
      }
    });
    if (issues.length) {
      violations++;
      console.log(`  ✗ EB ${eb}:`);
      for (const i of issues) console.log(`      ${i}`);
    }
  }

  console.log(
    `[audit-landmarks] ${rows.length} propert(ies): ${checked} with a landmark claim, `
    + `${empty} with no claim (address unknown/unmappable), ${violations} violation(s).`,
  );
  process.exit(violations ? 1 : 0);
}

main().catch((e) => {
  console.error('[audit-landmarks] fatal:', (e as Error).message);
  process.exit(1);
});
