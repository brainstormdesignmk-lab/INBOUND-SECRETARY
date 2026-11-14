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
 *   • coverage  — the share of field turns whose tag is mirrored (not pending).
 *                 Reported, and gated by --min-mirrored (default 0).
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
import { ROUTE_LANES } from '../src/handlers/router';

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
const laneFor = (tag: string): { intent: string | null; note: string } | undefined =>
  ROUTE_LANES[tag] ?? ROUTE_LANES[`${tag}:fast`] ?? ROUTE_LANES[`${tag}:bank`];

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
  const lane = laneFor(tag);
  const status = lane
    ? (lane.intent ? 'mirrored' : 'pending')
    : (stillProducible(tag) ? 'unlisted' : 'history');
  return {
    tag,
    gap: e.gap,
    drift: e.drift,
    status,
    samples: e.samples,
  };
}).sort((a, b) => (b.gap + b.drift) - (a.gap + a.drift));

const total = rows.reduce((n, r) => n + r.gap + r.drift, 0);
const mirrored = rows.filter(r => r.status === 'mirrored').reduce((n, r) => n + r.gap + r.drift, 0);
const pending = rows.filter(r => r.status === 'pending').reduce((n, r) => n + r.gap + r.drift, 0);
const unlisted = rows.filter(r => r.status === 'unlisted');
const mirroredPct = total === 0 ? 0 : Math.round((mirrored / total) * 1000) / 10;

const history = rows.filter(r => r.status === 'history');
const report = { days, files: files.length, damagedLines: damaged, turns: total, mirroredPct,
  pendingTurns: pending, unlisted: unlisted.map(u => ({ tag: u.tag, turns: u.gap + u.drift })),
  history: history.map(h => ({ tag: h.tag, turns: h.gap + h.drift })),
  pending: rows.filter(r => r.status === 'pending').map(r => ({ tag: r.tag, turns: r.gap + r.drift, samples: r.samples })) };

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  console.log(`[route:gap-audit] ${files.length} log files, last ${days} days · ${total} compared turns`);
  if (damaged > 0) console.log(`  damaged log lines skipped: ${damaged}`);
  console.log(`  mirrored (the mirror could have predicted it): ${mirroredPct}%`);
  console.log(`  pending  (a P(...) row — the backlog)          : ${total === 0 ? 0 : Math.round((pending / total) * 1000) / 10}%`);
  for (const u of unlisted) console.log(`  UNLISTED ${u.tag} — ${u.gap + u.drift} turns (still logged by src, missing from ROUTE_LANES)`);
  if (history.length > 0) {
    console.log(`  history (tag no longer logged by src): ${history.map(h => h.tag).join(', ')}`);
  }
  console.log('  pending backlog, by field volume:');
  for (const r of rows.filter(r => r.status === 'pending').slice(0, 20)) {
    console.log(`    ${String(r.gap + r.drift).padStart(6)}  ${r.tag} :: ${r.samples[0] ?? ''}`);
  }
}

const fail = unlisted.length > 0 || (strict && mirroredPct < minMirrored) || (strict && damaged > 0);
if (fail) console.log('[route:gap-audit] FAIL');
process.exit(fail ? 1 : 0);
