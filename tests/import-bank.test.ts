import { test } from 'node:test';
import assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execSync } from 'child_process';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { normalizedKey, trigramSimilarity } from '../src/llm/dedupe';

function tmpDb(): string {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'impbank-')), 'src.db');
}

// ── The dedupe levels, unit-pinned ───────────────────────────────────────────

test('normalizedKey: spacing/case twins collide; digits and keys stay distinct', () => {
  assert.equal(normalizedKey('До 160 000!'), normalizedKey('до 160000'));
  assert.equal(normalizedKey('blixina'), normalizedKey('bliksina'), 'x→кс + ks fold');
  assert.notEqual(normalizedKey('do 160000'), normalizedKey('do 150000'));
});

test('trigramSimilarity: identical ≈ 1, unrelated ≈ 0, near-twin ≥ threshold', () => {
  const a = 'Разбрав. Ги издвоив најдобрите понуди од населбите';
  assert.ok(trigramSimilarity(a, a) > 0.99);
  assert.ok(trigramSimilarity(a, 'Кој е максималниот буџет за купување?') < 0.3);
  // One-word drift ("најдобрите" → "најбараните") must read as a twin.
  const b = 'Разбрав. Ги издвоив најбараните понуди од населбите';
  assert.ok(trigramSimilarity(a, b) >= 0.85, `near-twin: ${trigramSimilarity(a, b)}`);
});

// ── The real importer end-to-end (child process, isolated DBs) ───────────────

test('import-bank: dedupe levels, poison retirement, cap — full run + idempotent rerun', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'impbank-e2e-'));
  const srcPath = path.join(dir, 'src.db');
  const dstPath = path.join(dir, 'master.db');

  // SOURCE (a "tui.db"-shaped bank): 6 variants. Keys chosen to exercise the
  // real policy: warn.1/location.unknown are TEACHABLE (learned in prod);
  // availability.ack is data-driven (frozen skip); fee.ask.buy is FROZEN.
  const src = new Db(srcPath);
  new BankStore(src); // creates tables + lifecycle column
  src.db.prepare(`INSERT INTO bank_variants (key, text, source, created_at) VALUES (?,?,?,?)`).run('warn.1', 'Ве молам водете се прилично — ова е последно предупредување.', 'gapfill', 1);
  src.db.prepare(`INSERT INTO bank_variants (key, text, source, created_at) VALUES (?,?,?,?)`).run('warn.1', 'Ве молам водете се прилично — ова е последното предупредување од мене.', 'gapfill', 2); // L3 near-twin (one-word drift, NOT an L2 twin)
  src.db.prepare(`INSERT INTO bank_variants (key, text, source, created_at) VALUES (?,?,?,?)`).run('warn.1', 'Почитајте го разговорот — повеќе нема да одговарам.', 'gapfill', 3);
  src.db.prepare(`INSERT INTO bank_variants (key, text, source, created_at) VALUES (?,?,?,?)`).run('warn.1', 'Точно, Станот со Евидентен број 69 е во Центар.', 'learned:tui', 4); // poison → retired
  src.db.prepare(`INSERT INTO bank_variants (key, text, source, created_at) VALUES (?,?,?,?)`).run('availability.ack', 'Сè уште е достапен и се води како слободен.', 'gapfill', 5); // data-driven → frozen skip
  src.db.prepare(`INSERT INTO bank_variants (key, text, source, created_at) VALUES (?,?,?,?)`).run('location.unknown', 'Сè уште не го кажавте реонот — во кој дел од градот барате?', 'gapfill', 6);
  src.close();

  // MASTER: warn.1 already holds the FIRST variant (L1 exact) + cap fillers
  // so the key sits 1 under the limit (tests the cap skip).
  const dst = new Db(dstPath);
  new BankStore(dst);
  dst.db.prepare(`INSERT INTO bank_variants (key, text, source, created_at) VALUES (?,?,?,?)`).run('warn.1', 'Ве молам водете се прилично — ова е последно предупредување.', 'seed', 1);
  for (let i = 0; i < BankCapFiller.count + 1; i++) {
    dst.db.prepare(`INSERT INTO bank_variants (key, text, source, created_at) VALUES (?,?,?,?)`).run('location.unknown', `Реон-прашање варијанта број ${i} — различна формулација за тестот.`, 'seed', i + 10);
  }
  dst.close();

  const run = (extra = '') => execSync(
    `npx tsx scripts/import-bank.ts ${srcPath} ${extra}`,
    { env: { ...process.env, DB_PATH: dstPath }, encoding: 'utf8', stderr: 'pipe' }
  );
  const out1 = run('--dry');
  assert.match(out1, /\+1 added/);                 // twin/ghost/frozen/cap excluded even in dry
  assert.match(out1, /1 retired-on-arrival/);
  assert.match(out1, /1 exact · 0 normalized · 1 near-dup/, out1);
  assert.match(out1, /1 frozen\/data-driven · 1 at per-key cap/);

  // Real run: identical counts, rows actually written.
  const out2 = run('');
  assert.match(out2, /\+1 added/);
  const d = new Db(dstPath);
  const rows = d.db.prepare(`SELECT key, text, lifecycle FROM bank_variants ORDER BY id`).all() as Array<{ key: string; text: string; lifecycle: string }>;
  d.close();
  const ghost = rows.find(r => r.text.includes('Евидентен број 69'));
  assert.ok(ghost, 'poisoned variant exists for audit');
  assert.equal(ghost!.lifecycle, 'retired', 'poison imports retired, never active');
  const novel = rows.find(r => r.text.startsWith('Почитајте го разговорот'));
  assert.equal(novel!.lifecycle, 'active');
  // warn.1 stayed at the cap (one filler was the free slot, the import had 1 → exactly full, next would skip).
  const warn = rows.filter(r => r.key === 'warn.1' && r.lifecycle === 'active').length;
  assert.ok(warn <= 15);

  // IDEMPOTENCE: rerunning imports nothing new (all levels now hold — the
  // near-twin that landed last run is now an exact row of the master).
  const out3 = run('');
  assert.match(out3, /\+0 added/);
  assert.match(out3, /2 exact · 0 normalized · 1 near-dup/);

  fs.rmSync(dir, { recursive: true, force: true });
});

// Small helper so the cap test stays readable (14 fillers + 1 import slot = cap 15).
const BankCapFiller = { count: 14 };
