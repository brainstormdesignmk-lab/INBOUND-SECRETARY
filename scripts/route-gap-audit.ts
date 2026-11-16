#!/usr/bin/env tsx
/**
 * route-gap-audit — Phase 4's completion measure, computed from the field logs.
 *
 * `tests/route-coverage.test.ts` proves every tag the executor CAN log is listed
 * (mirrored or pending). This audit asks the complementary question over real
 * traffic: **of the tags that actually served in the last N days, which ones has
 * the mirror never been able to predict?** Those are the gaps — the turns where
 * the plane flew blind — and the P(...) rows are the backlog that closes them.
 *
 * Two failures are possible, and both are real:
 *   • UNLISTED  — a tag served in the field and does not exist in ROUTE_LANES at
 *                 all. Either the tag was renamed and the log is history (the
 *                 audit says which), or a lane is logging silently. Exit 1.
 *   • coverage  — the share of COMPARABLE field turns (mirrored + pending) whose
 *                 tag is mirrored. Reported, and gated by --min-mirrored
 *                 (default 0). Marker (`K(...)`) and retired tags are listed
 *                 separately and kept out of the denominator: they were never a
 *                 prediction the mirror could get right or wrong.
 *
 * Usage:
 *   npm run route:gap-audit                 last 30 days, report
 *   npm run route:gap-audit -- --days 7
 *   npm run route:gap-audit -- --json
 *   npm run route:gap-audit -- --min-mirrored 60 --strict
 */
import '../src/compat/node16';

import * as fs from 'fs';
import * as path from 'path';
import { tagStatus } from '../src/handlers/router';
import { readPlaceMisses, groupPlaceMisses, distinctPlaceMissNames, type PlaceMissGroup } from '../src/store/placeMisses';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { loadConfig } from '../src/config';

/** THE MAP AS IT IS TODAY, for the "does this name bind now?" half of the
 *  digest. A miss row is HISTORY: it says a turn failed on that day. If the
 *  SAME name resolves against today's map (`центар`, `скопје север` — both
 *  NASELBAS — were recorded before the resolver learned them), it is not a gap
 *  the operator can close, and listing it beside `црногорска амбасада` makes
 *  the map-gap list lose its reader.
 *
 *  ONE IMPLEMENTATION, in the geo layer (`OfflineMapStore.todayBinding`): the
 *  audit and the operator CLI used to carry their own copies, and the audit's
 *  copy forgot to strip the extractor's opener, so «KAJ SKOPJE SEVER» was a map
 *  gap in one report and resolved in the other. The binding is the RESOLVER's
 *  answer plus the coverage guard (`mapNameCoversClientWords`), whose word fold
 *  is the resolver's own spelling fold — see the [07:16] «KARPOS» capture. */
function todayBinding(text: string, map?: OfflineMapStore): { name: string; type?: string } | undefined {
  if (!map?.available) return undefined;
  try {
    return map.todayBinding(text);
  } catch { /* a probe may never break the audit */ }
}

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const strict = args.includes('--strict');
const num = (flag: string, dflt: number): number => {
  const i = args.indexOf(flag);
  const v = i >= 0 ? Number(args[i + 1]) : NaN;
  return Number.isFinite(v) ? v : dflt;
};
const days = num('--days', 30);
const minMirrored = num('--min-mirrored', 0);

const dir = 'data';
const cutoff = Date.now() - days * 86_400_000;
const files = fs.existsSync(dir)
  ? fs.readdirSync(dir).filter(n => n.startsWith('route-drift-') && n.endsWith('.jsonl'))
    .map(n => path.join(dir, n))
    .filter(f => fs.statSync(f).mtimeMs >= cutoff)
  : [];

interface Entry { gap: number; drift: number; samples: string[] }
const tags = new Map<string, Entry>();
let damaged = 0;
for (const file of files) {
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let row: { actual?: string; kind?: string; text?: string };
    try { row = JSON.parse(line) as typeof row; } catch { damaged += 1; continue; }
    const tag = String(row.actual ?? '').replace(/:.*$/, '');
    if (!tag || tag.startsWith('ROUTE_UNKNOWN') || tag === 'LANE_COLLISION') continue;
    const e = tags.get(tag) ?? { gap: 0, drift: 0, samples: [] };
    if (row.kind === 'drift') e.drift += 1; else e.gap += 1;
    if (e.samples.length < 2) e.samples.push(String(row.text ?? ''));
    tags.set(tag, e);
  }
}

// THE EXECUTOR LOGS SUFFIXED TAGS (`FEE_PUSH:fast`, `WAITING:fast`, `REMARK:bank`)
// and the registry may key either form — the same alias rule that made
// `WAITING:fast` a gap on every correct patience line. Resolve the tag through
// every spelling the registry knows before calling it unlisted.
// ONE RESOLVER, TWO READERS: `laneForTag` is the same function `routeLog` uses
// to compare a served tag with the prediction, so the audit's day file and the
// live drift log can never disagree about which lane a suffixed tag belongs to
// (`VISIT_CANCEL:visit_scheduling`, `PROPERTY_CHOICE:fast`, `FEE_WHY:fast`).
// A MARKER IS NOT BACKLOG. `K(...)` rows (CHAIN_READY, PRICE_EVAL_EXPENSIVE_UNWIRED,
// EXIT_CHECK_REPEAT) are log-only: they answer nothing and `routeLog` refuses to
// write a drift row for one, so a marker tag in a day file was written BEFORE the
// marker rule and is history. Counting them as pending reported 200+ "unmirrored
// turns" a day on lanes that can never produce one, and hid the real backlog in
// the noise. `tagStatus` is the same classification `routeLog` uses.

// A tag that no longer exists in `src` cannot be logged again: it is HISTORY
// (renamed, retired, or a test artifact), not a silent lane. Only a tag that is
// still producible and missing from the registry is a defect.
const srcText = (() => {
  const out: string[] = [];
  const walk = (d: string): void => {
    for (const e of fs.readdirSync(d)) {
      const p = path.join(d, e);
      if (fs.statSync(p).isDirectory()) walk(p);
      else if (p.endsWith('.ts')) out.push(fs.readFileSync(p, 'utf8'));
    }
  };
  walk('src');
  return out.join('\n');
})();
const stillProducible = (tag: string): boolean => srcText.includes(`'${tag}`) || srcText.includes(`"${tag}`);

const rows = [...tags.entries()].map(([tag, e]) => {
  const status = tagStatus(tag, stillProducible(tag));
  return {
    tag,
    gap: e.gap,
    drift: e.drift,
    status,
    samples: e.samples,
  };
}).sort((a, b) => (b.gap + b.drift) - (a.gap + a.drift));

const turnsOf = (rs: typeof rows): number => rs.reduce((n, r) => n + r.gap + r.drift, 0);
const sum = (status: string): number => turnsOf(rows.filter(r => r.status === status));
const logged = rows.reduce((n, r) => n + r.gap + r.drift, 0);
const mirrored = sum('mirrored');
const pending = sum('pending');
const residual = sum('residual');
const historyTurns = sum('history');
// THE DENOMINATOR IS WHAT THE MIRROR COULD HAVE SAID: a turn whose tag is a
// marker or a retired name was never a prediction to get right or wrong, so it
// must not dilute the share (it was 183 residual rows + 191 alias rows doing
// exactly that).
const compared = mirrored + pending;
const unlisted = rows.filter(r => r.status === 'unlisted');
const mirroredPct = compared === 0 ? 0 : Math.round((mirrored / compared) * 1000) / 10;

const history = rows.filter(r => r.status === 'history');
const residualRows = rows.filter(r => r.status === 'residual');
// PLACE MISSES — THE OTHER HALF OF FLYING BLIND. The route audit says which
// LANE the plane could not predict; a place miss says the lane was right and the
// MAP could not place the word the client typed (`extractPoiWishCandidates`
// heard it, the geo lookup refused). Those rows are the weekly "which words did
// we not know" list, and they used to live in a separate CLI (place-misses.ts)
// that nobody ran with the audit — so a week of unplaceable neighbourhoods sat in
// `data/` while the route report said 100% mirrored. Grouping and triage live
// in the store (`groupPlaceMisses`/`looksPlaceShaped`) so the CLI and the audit
// cannot disagree about what one gap is. Informational on purpose — a miss is a data gap, not a
// code defect.
// The read side is async, the script is CJS: one promise, one then, no
// top-level await (tsx refuses it in the cjs output format).
void readPlaceMisses({ days }).then((misses) => {
const placeMissTop: PlaceMissGroup[] = groupPlaceMisses(misses);
// The name the map binds TODAY for each place-shaped group (see todayBinding).
let placeMap: OfflineMapStore | undefined;
try { placeMap = new OfflineMapStore(loadConfig().skopjePoisDb); } catch { placeMap = undefined; }
// ONE NAME IS ONE FINDING (`distinctPlaceMissNames`): the group key carries the
// refused row as well, so «ујп» sat in TWO groups — one unknown, one resolving —
// and the digest counted the same name on both sides of the ledger.
const placeNames = distinctPlaceMissNames(placeMissTop.filter(m => m.lane === 'place'));
// …and every lane is counted by NAME, or the lanes do not add up to `unique`.
const uniqueNames = distinctPlaceMissNames(placeMissTop);
const bound = new Map<string, { name: string; type?: string }>();
for (const m of placeNames) {
  const hit = todayBinding(m.text, placeMap);
  if (hit) bound.set(m.text, hit);
}
const stillUnknown = placeNames.filter(m => !bound.has(m.text));
const resolvesNow = placeNames
  .filter(m => bound.has(m.text))
  .map(m => ({ ...m, resolvesAs: bound.get(m.text)!.name, resolvesType: bound.get(m.text)!.type }));
placeMap?.close();

const report = { days, files: files.length, damagedLines: damaged, turns: logged,
  comparedTurns: compared, mirroredPct,
  pendingTurns: pending, residualTurns: residual, historyTurns,
  unlisted: unlisted.map(u => ({ tag: u.tag, turns: u.gap + u.drift })),
  history: history.map(h => ({ tag: h.tag, turns: h.gap + h.drift })),
  residual: residualRows.map(r => ({ tag: r.tag, turns: r.gap + r.drift, samples: r.samples })),
  pending: rows.filter(r => r.status === 'pending').map(r => ({ tag: r.tag, turns: r.gap + r.drift, samples: r.samples })),
  placeMisses: {
    total: misses.length,
    unique: uniqueNames.length,
    // The JSON carries the FULL lists (the text digest truncates and points
    // here); a truncated machine view is a false "that was all of it".
    placeShaped: stillUnknown,
    // A name the map binds today — nothing for the operator to add. The TYPE is
    // carried because a settlement row (`suburb`) is a NASELBA: an area the
    // funnel asks about, never a landmark or an alias target.
    resolvesNow,
    noise: uniqueNames.filter(m => m.lane === 'intent'),
    // PROBE ROWS ARE NOT RESOLVER FACTS (see PLACE_MISS_PROBE_WORDS): the sweep
    // scripts write «NEPOSTOECHKO MESTO XYZ» on purpose. They are reported in
    // their own list so an operator never reads them as places to learn.
    probes: uniqueNames.filter(m => m.lane === 'probe'),
  } };

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[route:gap-audit] ${files.length} log files, last ${days} days · ${logged} logged turns, ${compared} compared`);
  if (damaged > 0) console.log(`  damaged log lines skipped: ${damaged}`);
  console.log(`  mirrored (the mirror could have predicted it): ${mirroredPct}%`);
  console.log(`  pending  (a P(...) row — the backlog)          : ${compared === 0 ? 0 : Math.round((pending / compared) * 1000) / 10}%`);
  for (const u of unlisted) console.log(`  UNLISTED ${u.tag} — ${u.gap + u.drift} turns (still logged by src, missing from ROUTE_LANES)`);
  if (history.length > 0) {
    console.log(`  history (tag no longer logged by src): ${history.map(h => h.tag).join(', ')}`);
  }
  if (residualRows.length > 0) {
    console.log('  residual (a K(...) marker — logs and falls through, never a gap; rows written before the marker rule):');
    for (const r of residualRows) console.log(`    ${String(r.gap + r.drift).padStart(6)}  ${r.tag} :: ${r.samples[0] ?? ''}`);
  }
  console.log('  pending backlog, by field volume:');
  for (const r of rows.filter(r => r.status === 'pending').slice(0, 20)) {
    console.log(`    ${String(r.gap + r.drift).padStart(6)}  ${r.tag} :: ${r.samples[0] ?? ''}`);
  }
  if (misses.length > 0) {
    const shaped = stillUnknown;
    // LANES BY NAME, like the header and the operator CLI: a name logged with and
    // without a refused row is ONE finding, and the four lanes must add up to it.
    const noise = uniqueNames.filter(m => m.lane === 'intent');
    const probes = uniqueNames.filter(m => m.lane === 'probe');
    const noiseRows = noise.reduce((n, m) => n + m.turns, 0);
    console.log(`  place misses (the extractor heard it, the map could not place it — ${misses.length} rows, ${uniqueNames.length} distinct names):`);
    console.log(`    place-shaped (a name the map does NOT know today — THE map-gap list): ${shaped.length} distinct`);
    for (const m of shaped.slice(0, 20)) {
      // `refused` in the row is what the MAP OFFERED and the guard turned down
      // (placeMisses.ts) — not a refusal by the map. Saying "refused" here read
      // as the opposite, and the offered name is the useful half: it names the
      // POI row that needs the alias.
      const refused = m.refused ? `  ← map offered: ${m.refused}` : '';
      console.log(`    ${String(m.turns).padStart(6)}  ${m.text}${refused}`);
      // THE LINE IT CAME FROM (PlaceMiss.said). A phrase cannot be triaged on
      // its own: «зулуфтар» ranked as the top map gap for three weeks and was a
      // HARNESS FIXTURE — the message around it is what tells a place from a
      // word, so the digest prints it beside every name it still calls unknown.
      if (m.said) console.log(`            heard in: «${m.said}»`);
    }
    if (shaped.length > 20) console.log(`    … ${shaped.length - 20} more (--json for the full list)`);
    if (resolvesNow.length > 0) {
      // HISTORY, NOT A GAP: the row was logged on a day the resolver could not
      // place the name; today's map binds it. A settlement row is called out as
      // the NASELBA it is, so nobody adds an alias for a neighbourhood.
      console.log(`    resolves NOW (the map binds these today — historical rows, nothing to add): ${resolvesNow.length} distinct`);
      for (const m of resolvesNow.slice(0, 12)) {
        const kind = String(m.resolvesType ?? '').toLowerCase();
        const isArea = ['suburb', 'neighbourhood', 'neighborhood', 'quarter', 'hamlet', 'village', 'locality'].includes(kind);
        console.log(`    ${String(m.turns).padStart(6)}  ${m.text}  → ${m.resolvesAs} [${m.resolvesType ?? '?'}]`
          + (isArea ? '  — a NASELBA (an area, not a landmark)' : ''));
      }
      if (resolvesNow.length > 12) console.log(`    … ${resolvesNow.length - 12} more (--json for the full list)`);
    }
    // The recorder logs every candidate the place-wish extractor produced, so
    // intent vocabulary («sakam da kupam stan», «dve sobi») is in the same file.
    // Named, never ranked: presenting those as map gaps is how a digest loses
    // its reader.
    console.log(`    NOT place-shaped (intent/quantity vocabulary — an instrument noise row, not a map gap): ${noise.length} distinct, ${noiseRows} rows`);
    for (const m of noise.slice(0, 5)) console.log(`    ${String(m.turns).padStart(6)}  ${m.text}`);
    if (probes.length > 0) {
      // Not a gap either: the sweeps ask for a place they know does not exist.
      const probeRows = probes.reduce((n, m) => n + m.turns, 0);
      console.log(`    PROBE rows (a sweeps' own «nepostoechko» name — excluded from the map-gap list): ${probes.length} distinct, ${probeRows} rows`);
      for (const m of probes.slice(0, 5)) console.log(`    ${String(m.turns).padStart(6)}  ${m.text}`);
    }
  } else {
    console.log(`  place misses: none in the last ${days} days`);
  }
}

const fail = unlisted.length > 0 || (strict && mirroredPct < minMirrored) || (strict && damaged > 0);
if (fail) console.log('[route:gap-audit] FAIL');
process.exit(fail ? 1 : 0);
}).catch((err) => {
  // A telemetry read that throws is a broken instrument, not a clean audit: say
  // so and fail, so a cron job cannot mistake an unread corpus for zero misses.
  console.error('[route:gap-audit] place-miss read failed:', err);
  process.exit(1);
});
