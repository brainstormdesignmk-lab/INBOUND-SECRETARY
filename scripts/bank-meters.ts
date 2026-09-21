#!/usr/bin/env tsx
/** P0 meters — read-only coverage lenses over bank_metrics, zero runtime cost.
 *
 *  npm run bank:meters                      — ranked worst-first per-key hit-rate
 *  npm run bank:meters -- --since 7         — traffic from the last 7 days only
 *  npm run bank:meters -- --daily 14        — key × day serve matrix (hit/total)
 *  npm run bank:meters -- --recent 7        — keys gone quiet (prune candidates)
 *  npm run bank:meters -- --report          — + P0 review summary, exit 1 if starved
 *
 *  Reads the real DB (data/lina.db, override with --db PATH or --test for the
 *  scratch DB). All computed in SQL over bank_metrics — no corpus or detector
 *  load, no runtime dependency added.
 */
import Database from 'better-sqlite3';

const args = process.argv.slice(2);
const opt = (name: string): string | undefined => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const has = (name: string): boolean => args.includes(name);

const dbPath = has('--test') ? '/tmp/p0-meters-test.db'
  : has('--db') ? opt('--db')!
  : 'data/lina.db';
const sinceDays = Number(opt('--since') ?? '0');
const recentDays = Number(opt('--recent') ?? '0');
const db = new Database(dbPath, { readonly: true, fileMustExist: true });

interface Row { key: string; hits: number; misses: number; updated_at: number }

function rowsSince(days: number): Row[] {
  if (days <= 0) {
    return db.prepare('SELECT key, hits, misses, updated_at FROM bank_metrics').all() as Row[];
  }
  const cutoff = Date.now() - days * 86400_000;
  return db.prepare('SELECT key, hits, misses, updated_at FROM bank_metrics WHERE updated_at >= ?')
    .all(cutoff) as Row[];
}

const rows = rowsSince(sinceDays);
const minTraffic = 10;
const pad = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - s.length));

if (has('--daily')) {
  // Per-day buckets straight from the row's updated_at timestamp.
  const days = Number(opt('--daily') ?? '14');
  const cutoff = Date.now() - days * 86400_000;
  const live = rows.filter(r => r.hits + r.misses > 0 && r.updated_at >= cutoff);
  const dayOf = (ts: number): string => new Date(ts).toISOString().slice(0, 10);
  const daySet = [...new Set(live.map(r => dayOf(r.updated_at)))].sort();
  console.log(pad('key', 28) + daySet.map(d => d.slice(5)).map(d => pad(d, 6)).join(''));
  for (const r of live.sort((a, b) => (b.hits + b.misses) - (a.hits + a.misses))) {
    const cells = daySet.map(d => {
      const v = (dayOf(r.updated_at) === d) ? `${r.hits}/${r.hits + r.misses}` : '·';
      return pad(v, 6);
    }).join('');
    console.log(pad(r.key, 28) + cells);
  }
  process.exit(0);
}

if (has('--recent')) {
  const cutoff = Date.now() - recentDays * 86400_000;
  const stale = rows.filter(r => r.updated_at < cutoff && r.hits + r.misses >= minTraffic);
  if (stale.length === 0) { console.log(`no stale keys (all traffic within ${recentDays}d)`); process.exit(0); }
  console.log(`STALE — zero traffic in ${recentDays}d (had ≥${minTraffic} lifetime):`);
  for (const r of stale.sort((a, b) => a.updated_at - b.updated_at)) {
    console.log(`  ${pad(r.key, 26)} last ${(Math.round((Date.now() - r.updated_at) / 86400_000))}d ago  ${r.hits}/${r.hits + r.misses}`);
  }
  process.exit(0);
}

// Default / --report view.
console.log(`bank coverage meters — ${sinceDays > 0 ? `last ${sinceDays}d` : 'all-time'} (${rows.length} keys with traffic)\n`);
console.log(pad('key', 28) + pad('hits', 7) + pad('misses', 8) + pad('rate', 7) + pad('last-serve', 12));
const scored = rows.map(r => {
  const t = r.hits + r.misses;
  return { ...r, total: t, rate: t > 0 ? r.hits / t : 0 };
}).filter(r => r.total >= minTraffic);
for (const r of scored.sort((a, b) => a.rate - b.rate)) {
  const ago = r.updated_at > 0 ? `${Math.max(1, Math.round((Date.now() - r.updated_at) / 3600_000))}h` : '—';
  console.log(pad(r.key, 28) + pad(String(r.hits), 7) + pad(String(r.misses), 8) + pad((r.rate * 100).toFixed(0) + '%', 7) + pad(ago, 12));
}
if (scored.length === 0) console.log('  (no keys with ≥10 serves yet)');

if (has('--report')) {
  const starved = scored.filter(r => r.rate < 0.5);
  const dead = scored.filter(r => r.total >= 30 && r.rate < 0.15);
  console.log(`\nP0 REVIEW SUMMARY`);
  console.log(`  starved (<50% hit-rate, ${starved.length}): ${starved.slice(0, 8).map(r => r.key).join(', ') || '—'}`);
  console.log(`  dead (≥30 serves, <15%, ${dead.length}): ${dead.slice(0, 8).map(r => r.key).join(', ') || '—'}`);
  console.log(`  coverage: ${scored.filter(r => r.rate >= 0.5).length}/${scored.length} keys ≥50%`);
  process.exit(starved.length > 0 ? 1 : 0);
}
