#!/usr/bin/env tsx
/** P0 meters — read-only coverage lenses over bank_metrics, zero runtime cost.
 *
 *  npm run bank:meters                      — ranked worst-first per-key hit-rate
 *  npm run bank:meters -- --since 7         — traffic from the last 7 days only
 *  npm run bank:meters -- --daily 14        — key × day serve matrix (hit/total)
 *  npm run bank:meters -- --recent 7        — keys gone quiet (prune candidates)
 *  npm run bank:meters -- --variant         — per-variant health (serves / re-asks)
 *  npm run bank:meters -- --variant --fix   — + auto-retire chronic underperformers
 *  npm run bank:meters -- --report          — + P5 headline + P0 review summary
 *
 *  P5 headline: corrections per 100 bank answers — the one number that says
 *  whether the bank is improving. Auto-retire is CONSERVATIVE: only variants
 *  with ≥4 serves and ≥60% re-ask rate, only with --fix, always reversible
 *  (bank:relearn --promote <id> reactivates; retirement never deletes).
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
const db = new Database(dbPath, { readonly: !has('--fix'), fileMustExist: true });

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

// ---------- P5: per-variant health + auto-retire ----------

/** Trigram similarity — the SAME re-ask signal as answerWorked (enrichQuality). */
function similarity(a: string, b: string): number {
  const tg = (s: string): Set<string> => {
    const t = s.toLowerCase(); const set = new Set<string>();
    for (let i = 0; i <= t.length - 3; i++) set.add(t.slice(i, i + 3));
    return set;
  };
  const ta = tg(a), tb = tg(b);
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

if (has('--variant')) {
  // Per-variant health: serve rows from the enrichment log attributed to
  // bank_variants rows by exact (normalized) text; a deterministic serve
  // with a bankKey that matches no learned variant is a SEED serve (the
  // seed layer lives in code, deliberately not loaded here). Re-ask = a
  // similar client message within 10 min in the same chat — the identical
  // failure definition the midnight cron's quality gate uses.
  const variants = db.prepare(`SELECT id, key, text, lifecycle FROM bank_variants`).all() as
    Array<{ id: number; key: string; text: string; lifecycle: string }>;
  const byText = new Map(variants.filter(v => v.lifecycle !== 'staged').map(v => [v.text.toLowerCase().replace(/\s+/g, ' ').trim(), v]));
  const serves = db.prepare(`
    SELECT id, chatId, userMsg, replyText, bankKey, createdAt FROM (
      SELECT id, chat_id AS chatId, user_msg AS userMsg, reply_text AS replyText,
             bank_key AS bankKey, created_at AS createdAt
      FROM enrichment_queue WHERE reply_source = 'deterministic' AND bank_key IS NOT NULL
      ORDER BY id DESC LIMIT 5000
    ) ORDER BY id ASC
  `).all() as Array<{ id: number; chatId: string; userMsg: string; replyText: string; bankKey: string; createdAt: number }>;

  interface VStat { id: number | null; key: string; label: string; lifecycle: string; serves: number; reasks: number }
  const stats = new Map<string, VStat>();
  const statOf = (v: { id: number | null; key: string; label: string; lifecycle: string }): VStat => {
    const k = `${v.key}::${v.label}`;
    let s = stats.get(k);
    if (!s) { s = { ...v, serves: 0, reasks: 0 }; stats.set(k, s); }
    return s;
  };
  const windowMs = 10 * 60_000;
  for (let i = 0; i < serves.length; i++) {
    const s = serves[i]!;
    const v = byText.get(s.replyText.toLowerCase().replace(/\s+/g, ' ').trim());
    const st = v
      ? statOf({ id: v.id, key: v.key, label: `#${v.id}`, lifecycle: v.lifecycle })
      : statOf({ id: null, key: s.bankKey, label: 'seed', lifecycle: 'seed' });
    st.serves++;
    for (let j = i + 1; j < serves.length; j++) {
      const o = serves[j]!;
      if (o.createdAt > s.createdAt + windowMs) break;
      if (o.chatId !== s.chatId) continue;
      if (similarity(o.userMsg, s.userMsg) > 0.6) { st.reasks++; break; }
    }
  }

  const arr = [...stats.values()].filter(s => s.serves >= 3).sort((a, b) => (b.reasks / b.serves) - (a.reasks / a.serves));
  console.log(`per-variant health — serves ≥3 (${arr.length} variants; re-ask = similar msg ≤10min)\n`);
  console.log(pad('key', 26) + pad('variant', 10) + pad('serves', 8) + pad('re-asks', 9) + pad('rate', 7) + 'lifecycle');
  for (const s of arr) {
    const rate = (100 * s.reasks / s.serves).toFixed(0) + '%';
    console.log(pad(s.key, 26) + pad(s.label, 10) + pad(String(s.serves), 8) + pad(String(s.reasks), 9) + pad(rate, 7) + s.lifecycle);
  }
  if (arr.length === 0) console.log('  (no variant with ≥3 attributed serves yet)');

  if (has('--fix')) {
    // CONSERVATIVE auto-retire: learned variants only, ≥4 serves, ≥60%
    // re-ask rate, reversible (promoteVariant flips it back; nothing deletes).
    const doomed = arr.filter(s => s.id !== null && s.serves >= 4 && s.reasks / s.serves >= 0.6 && s.lifecycle === 'active');
    if (doomed.length === 0) { console.log('\nauto-retire: nothing qualifies (needs ≥4 serves, ≥60% re-ask, active learned variant)'); }
    else {
      const upd = db.prepare(`UPDATE bank_variants SET lifecycle = 'retired', note = ? WHERE id = ?`);
      console.log('\nauto-retire:');
      for (const s of doomed) {
        const note = `auto-retire (P5): ${s.reasks}/${s.serves} re-ask rate — chronic underperformer`;
        upd.run(note, s.id);
        console.log(`  retired ${s.key} #${s.id} (${s.reasks}/${s.serves} re-asks) — reversible via bank:relearn --promote ${s.id}`);
      }
    }
  }
  process.exit(0);
}

// ---------- P5 headline: corrections per 100 bank answers ----------

function headline(): string {
  const windowDays = sinceDays > 0 ? sinceDays : 30;
  const cutoff = Date.now() - windowDays * 86400_000;
  const serves = (db.prepare(
    `SELECT COUNT(*) AS c FROM enrichment_queue WHERE reply_source = 'deterministic' AND bank_key IS NOT NULL AND created_at >= ?`
  ).get(cutoff) as { c: number }).c;
  const corrections = (db.prepare(
    `SELECT COUNT(*) AS c FROM bank_corrections WHERE created_at >= ?`
  ).get(cutoff) as { c: number }).c;
  const rate = serves > 0 ? (100 * corrections / serves) : 0;
  // Trend: the equal-length window immediately before.
  const prevServes = (db.prepare(
    `SELECT COUNT(*) AS c FROM enrichment_queue WHERE reply_source = 'deterministic' AND bank_key IS NOT NULL AND created_at >= ? AND created_at < ?`
  ).get(cutoff - windowDays * 86400_000, cutoff) as { c: number }).c;
  const prevCorr = (db.prepare(
    `SELECT COUNT(*) AS c FROM bank_corrections WHERE created_at >= ? AND created_at < ?`
  ).get(cutoff - windowDays * 86400_000, cutoff) as { c: number }).c;
  const prevRate = prevServes > 0 ? (100 * prevCorr / prevServes) : rate;
  const delta = rate - prevRate;
  const trend = serves === 0 || prevServes === 0 ? '' : delta <= -0.5 ? ` ▼ improving (${delta.toFixed(1)} vs prev ${windowDays}d)` : delta >= 0.5 ? ` ▲ worsening (+${delta.toFixed(1)} vs prev ${windowDays}d)` : ' ≈ flat vs previous window';
  return `P5 HEADLINE: ${rate.toFixed(1)} corrections per 100 bank answers (${corrections} corrections / ${serves} serves, last ${windowDays}d)${trend}`;
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
  console.log(`\n${headline()}`);
  console.log(`\nP0 REVIEW SUMMARY`);
  console.log(`  starved (<50% hit-rate, ${starved.length}): ${starved.slice(0, 8).map(r => r.key).join(', ') || '—'}`);
  console.log(`  dead (≥30 serves, <15%, ${dead.length}): ${dead.slice(0, 8).map(r => r.key).join(', ') || '—'}`);
  console.log(`  coverage: ${scored.filter(r => r.rate >= 0.5).length}/${scored.length} keys ≥50%`);
  process.exit(starved.length > 0 ? 1 : 0);
}
