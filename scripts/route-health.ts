#!/usr/bin/env tsx
/**
 * route:health — the collision report over every Lina DB on this machine.
 *
 * READ-ONLY. It never writes to a bank, never calls an LLM and never serves.
 * It answers: are frozen keys collecting property-price talk (a misroute), is
 * the same phrase reaching two keys (a collision), and are there turns with no
 * home (orphans)?
 *
 * Usage:
 *   npx tsx scripts/route-health.ts                # every data/*.db
 *   npx tsx scripts/route-health.ts --db data/tui.db
 *   npx tsx scripts/route-health.ts --days 7       # only the last 7 days
 *   npx tsx scripts/route-health.ts --strict       # exit 1 on misroutes/collisions
 *   npx tsx scripts/route-health.ts --json         # machine-readable findings
 *
 * Run it in CI/pre-deploy, not on a timer — this repo's no-cron policy stands.
 */
import '../src/compat/node16';
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';
import { analyzeRows, healthLine, healthRatesLine, HealthRow, Finding } from '../src/scripts/routeHealth';

function argValues(name: string): string[] {
  const out: string[] = [];
  process.argv.forEach((a, i) => { if (a === name && process.argv[i + 1]) out.push(process.argv[i + 1]); });
  return out;
}

const strict = process.argv.includes('--strict');
const json = process.argv.includes('--json');

function dbPaths(): string[] {
  const explicit = argValues('--db');
  if (explicit.length) return explicit;
  const dir = path.resolve('data');
  try {
    return fs.readdirSync(dir)
      .filter(n => n.endsWith('.db'))
      .map(n => path.join(dir, n));
  } catch {
    return [];
  }
}

const daysArg = argValues('--days')[0];
const days = daysArg ? Number(daysArg) : undefined;

function readRows(file: string): HealthRow[] | undefined {
  let db: Database.Database | null = null;
  try {
    db = new Database(file, { readonly: true, fileMustExist: true });
    const has = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='enrichment_queue'").get();
    if (!has) return undefined;
    return db.prepare(
      `SELECT id, state, event_type AS eventType, bank_key AS bankKey, user_msg AS userMsg,
              review_key AS reviewKey, created_at AS createdAt
         FROM enrichment_queue ORDER BY id DESC LIMIT 5000`,
    ).all() as HealthRow[];
  } catch {
    return undefined; // locked / not a bank DB — skip, never fatal
  } finally {
    try { db?.close(); } catch { /* already closed */ }
  }
}

const all: Array<{ db: string; rows: number; findings: Finding[]; counts: Record<string, number>;
  rates: import('../src/scripts/routeHealth').HealthRates }> = [];
for (const file of dbPaths()) {
  let rows = readRows(file);
  if (!rows) continue;
  if (days !== undefined && Number.isFinite(days) && days > 0) {
    const cutoff = Date.now() - days * 86_400_000;
    rows = rows.filter(r => typeof r.createdAt === 'number' && r.createdAt >= cutoff);
  }
  const { findings, counts, rates } = analyzeRows(rows);
  all.push({ db: path.basename(file), rows: rows.length, findings, counts, rates });
}

if (json) {
  console.log(JSON.stringify(all, null, 2));
} else {
  for (const r of all) {
    console.log(`\n${r.db} — ${r.rows} turns · ${healthLine(r.counts as never)}`);
    console.log(`  rates: ${healthRatesLine(r.rates)}`);
    for (const f of r.findings.slice(0, 40)) {
      const where = f.id !== undefined ? `#${f.id} ${f.key ?? '(no key)'}` : 'phrase';
      console.log(`  [${f.kind}] ${where} · "${f.phrase.slice(0, 80)}"\n      ${f.detail}`);
    }
    if (r.findings.length > 40) console.log(`  … ${r.findings.length - 40} more`);
  }
  if (all.length === 0) console.log('route:health — no enrichment_queue found (nothing to check)');
}

const blocking = all.reduce((n, r) => n + r.counts['frozen-misroute'] + r.counts.collision, 0);
if (strict && blocking > 0) {
  console.error(`\nroute:health — FAIL: ${blocking} blocking finding(s)`);
  process.exit(1);
}
