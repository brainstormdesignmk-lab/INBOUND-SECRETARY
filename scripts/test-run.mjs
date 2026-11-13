#!/usr/bin/env node
// test-run.mjs — the sharded suite runner: one process, one TAP file per test
// file, merged verdict.
//
// WHY THIS EXISTS
//   `node --test tests/*.test.ts` already runs every file in its own process,
//   but it pipes all children into ONE reporter, so their TAP interleaves. Twice
//   on 2026-11-13 a parallel run printed `# fail 3` with ZERO `not ok` detail
//   lines — the failure blocks were shredded between two files' output. The only
//   trustworthy gate was `--test-concurrency=1`, which costs ~55 min.
//
//   Here each file's TAP goes to its own file (`.bench/tap/<file>.tap`). Nothing
//   can interleave, a failure keeps its `not ok` line and YAML block verbatim,
//   and the files still run in parallel. It is the same execution model as
//   `npm test` (separate process per file, same esbuild define), so assertions
//   and isolation are unchanged — only the REPORTING changes.
//
// LEVELS (see LEVELS below)
//   smoke        fast, dependency-light units: the inner loop (<1 min)
//   integration  everything that builds the real handler / sqlite / geo / net
//   full         all 276 files (= tests/*.test.ts, exactly what `npm test` runs)
//   targeted     only the files you name: `npm run test:t -- tests/a.test.ts`
//
//   `npm test` is deliberately NOT redirected through this script: it stays the
//   original full-regression command, so the safety net has an independent path.
//
// Usage:
//   node scripts/test-run.mjs                       # full, sharded
//   node scripts/test-run.mjs --level smoke
//   node scripts/test-run.mjs --level integration
//   node scripts/test-run.mjs tests/a.test.ts tests/b.test.ts
//   node scripts/test-run.mjs --profile             # + per-file timings table
//   node scripts/test-run.mjs --list --level smoke  # resolve a level, run nothing
//   node scripts/test-run.mjs --match "fee ladder"  # node --test-name-pattern
//
// Knobs:
//   TEST_CONCURRENCY=n    files in flight (default cores*2, i.e. 8 on 4 cores).
//                         MEASURED 2026-11-13: 6,317 s of per-file wall in
//                         831 s — 7.6x of the 8 slots, so the pool is already
//                         near-linear and the rest of the wall is INSIDE the
//                         files (landmark sweeps, ~35 ms per nearestPois call).
//                         Raising it further does not buy much; lowering it
//                         below cores wastes the CPU.
//   TEST_FILE_TIMEOUT=s   per-file watchdog in seconds (default 300): a hung
//                         file is KILLED and reported FAILED, never skipped
//   TEST_NO_BUNDLE=1      run the .ts files through tsx instead of bundling
//
// Exit: 0 only when every selected file passed.

import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const TESTS = path.join(ROOT, 'tests');
const OUT = path.join(ROOT, 'dist-test');
const TAP_DIR = path.join(ROOT, '.bench', 'tap');
const PROFILE = path.join(ROOT, '.bench', 'test-profile.json');

// ── levels ───────────────────────────────────────────────────────────────────
// smoke: pure units — no handler, no SQLite, no feed/geo/network. They type
// check nothing (tsc does) but they cover the grammar/lexicon/normalisation core
// every other file depends on, and together they boot in seconds.
const SMOKE = [
  'normalize.test.ts',
  'classify.test.ts',
  'offlineMap.test.ts',
  'bank-constraints.test.ts',
  'offensive-lexicon-audit.test.ts',
  'route-coverage.test.ts',
  'router.test.ts',
];

const MARKERS_INTEGRATION = [
  /new InboundHandler/,
  /new Db\(/,
  /new OfflineMapStore/,
  /PtySession|script\(1\)/,
  /createServer|http\.request/,
];

const argv = process.argv.slice(2);
const opts = { level: 'full', profile: false, list: false, match: null, skipSlow: false, files: [] };
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--level') opts.level = argv[++i];
  else if (a === '--profile') opts.profile = true;
  else if (a === '--list') opts.list = true;
  else if (a === '--skip-slow') opts.skipSlow = true;
  else if (a === '--match') opts.match = argv[++i];
  else if (a === '-h' || a === '--help') opts.help = true;
  else if (a.startsWith('-')) { console.error(`unknown flag: ${a}`); process.exit(2); }
  else opts.files.push(a);
}

const allFiles = fs.readdirSync(TESTS)
  .filter(f => f.endsWith('.test.ts'))
  .sort()
  .map(f => path.join(TESTS, f));

function select() {
  if (opts.files.length) return opts.files.map(f => path.resolve(ROOT, f));
  if (opts.level === 'full') return allFiles;
  if (opts.level === 'smoke') {
    const want = new Set(SMOKE);
    const picked = allFiles.filter(f => want.has(path.basename(f)));
    const missing = SMOKE.filter(n => !picked.some(f => path.basename(f) === n));
    // A level that silently loses a file is a check that stops checking.
    if (missing.length) { console.error(`smoke level names missing files: ${missing.join(', ')}`); process.exit(2); }
    return picked;
  }
  if (opts.level === 'targeted') {
    // Named files only. `npm run test:t` with no argument must NOT quietly
    // become the 14-minute full suite — that is how a fast loop stops being one.
    if (!opts.files.length) {
      console.error('targeted needs files: npm run test:t -- tests/a.test.ts [tests/b.test.ts …]');
      process.exit(2);
    }
    return opts.files.map(f => path.resolve(ROOT, f));
  }
  if (opts.level === 'integration') {
    return allFiles.filter(f => {
      const src = fs.readFileSync(f, 'utf8');
      return MARKERS_INTEGRATION.some(re => re.test(src));
    });
  }
  console.error(`unknown --level ${opts.level} (smoke|targeted|integration|full)`);
  process.exit(2);
}

if (opts.help) {
  // Print the header comment, from Usage: to the end of the comment block —
  // sliced by MARKER, not by line numbers, so editing the header cannot make
  // `--help` print half a sentence.
  const lines = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n');
  const start = lines.findIndex(l => /^\/\/ Usage:/.test(l));
  const end = lines.findIndex((l, i) => i > start && !/^\/\//.test(l));
  console.log(lines.slice(start, end === -1 ? start + 20 : end).join('\n'));
  process.exit(0);
}

let files = select();
// --skip-slow: the PTY funnel boots the real TUI twice (~25 s of wall) — it is
// the pre-deploy check, not the inner loop. It is the ONLY file this drops.
if (opts.skipSlow) files = files.filter(f => !/tui-pty-funnel/.test(f));
if (!files.length) { console.error('no test files selected'); process.exit(2); }

// EVERY selected file must exist: a typo in a path must not pass as "green".
const absent = files.filter(f => !fs.existsSync(f));
if (absent.length) { console.error(`no such test file:\n  ${absent.join('\n  ')}`); process.exit(2); }

if (opts.list) { for (const f of files) console.log(path.relative(ROOT, f)); process.exit(0); }

const CONCURRENCY = Number(process.env.TEST_CONCURRENCY || Math.max(2, os.cpus().length * 2));
const FILE_TIMEOUT_MS = Number(process.env.TEST_FILE_TIMEOUT || 300) * 1000;
const NO_BUNDLE = process.env.TEST_NO_BUNDLE === '1';

// ── bundle (one esbuild invocation, exact same contract as the old script) ───
async function bundle() {
  fs.rmSync(OUT, { recursive: true, force: true });
  const rel = files.map(f => path.relative(ROOT, f));
  // --define:require.main=undefined — hermesLandmarks.ts & co. guard their CLI
  // body with `require.main === module`; inside a bundle that is TRUE and the
  // whole CLI (live LLM calls, a hang) runs whenever a test imports a helper.
  // This define is what keeps the suite hermetic. Do not drop it.
  const args = [
    '--bundle', '--platform=node', '--format=cjs', '--packages=external',
    '--define:require.main=undefined',
    '--outbase=.', `--outdir=${OUT}`, '--log-level=error',
    ...rel,
  ];
  const esbuild = path.join(ROOT, 'node_modules', '.bin', 'esbuild');
  const t0 = Date.now();
  await new Promise((resolve, reject) => {
    const child = spawn(esbuild, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('exit', code => (code === 0 ? resolve() : reject(new Error(`esbuild exit ${code}`))));
    child.on('error', reject);
  });
  // Fixtures are read relative to __dirname by some tests.
  const fixtures = path.join(TESTS, 'fixtures');
  if (fs.existsSync(fixtures)) fs.cpSync(fixtures, path.join(OUT, 'tests', 'fixtures'), { recursive: true });
  return Date.now() - t0;
}

function toBundle(f) {
  const rel = path.relative(ROOT, f).replace(/\.ts$/, '.js');
  return path.join(OUT, rel);
}

// ── run one file, own TAP file, watchdog ─────────────────────────────────────
// Every live child, so ONE signal handler can reap them all: a per-file
// listener would mean N listeners (and a MaxListeners warning) at high
// concurrency, and an orphaned child after Ctrl-C is a test process nobody sees.
const live = new Set();
for (const sig of ['SIGINT', 'SIGTERM']) {
  process.once(sig, () => {
    for (const c of live) { try { c.kill('SIGKILL'); } catch { /* already gone */ } }
    process.exit(sig === 'SIGINT' ? 130 : 143);
  });
}

function runFile(file, bundleRuntime) {
  const rel = path.relative(ROOT, file);
  const tapPath = path.join(TAP_DIR, rel.replace(/[\/]/g, '_') + '.tap');
  const t0 = Date.now();
  return new Promise(resolve => {
    const nodeArgs = [];
    if (!bundleRuntime) nodeArgs.push('--import', 'tsx');
    nodeArgs.push('--test', '--test-reporter=tap');
    if (opts.match) nodeArgs.push(`--test-name-pattern=${opts.match}`);
    nodeArgs.push(bundleRuntime ? toBundle(file) : file);

    const out = fs.openSync(tapPath, 'w');
    const child = spawn(process.execPath, nodeArgs, { cwd: ROOT, stdio: ['ignore', out, out] });
    live.add(child);
    let killed = false;
    let settled = false;
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch { /* already gone */ } }, FILE_TIMEOUT_MS);
    // One settle per child: a spawn error emits 'error' and 'close' (not
    // 'exit'), and closing the same fd twice throws.
    const settle = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { fs.closeSync(out); } catch { /* already closed */ }
      live.delete(child);
      resolve({ file: rel, ms: Date.now() - t0, code, killed, tapPath, error });
    };
    child.on('error', err => settle(-1, String(err)));
    child.on('close', code => settle(code ?? -1));
  });
}

// ── TAP parsing (per file, so nothing can interleave) ────────────────────────
function parseTap(tapPath) {
  let text = '';
  try { text = fs.readFileSync(tapPath, 'utf8'); } catch { return { pass: 0, fail: 0, failures: [], shown: 0 }; }
  const lines = text.split('\n');
  let pass = 0, fail = 0, shown = 0;
  const failures = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^# Subtest: /.test(line)) shown++;
    // Leading whitespace allowed: a failure inside describe()/suite() is
    // INDENTED, and an unindented-only match would report `# fail 1` while
    // printing no detail at all — the very failure mode this runner exists for.
    const ok = /^\s*ok \d+ - /.test(line);
    const notOk = /^\s*not ok \d+ - /.test(line);
    if (ok) pass++;
    if (notOk) {
      fail++;
      // Keep the failure line plus its YAML diagnostic block (--- … ...), which
      // is where the assertion message actually lives.
      const block = [line.trimStart()];
      for (let j = i + 1; j < lines.length && j < i + 40; j++) {
        block.push(lines[j]);
        if (/^\s*\.\.\.\s*$/.test(lines[j])) break;
      }
      failures.push(block.join('\n'));
    }
  }
  const passSummary = /^# pass (\d+)/m.exec(text);
  const failSummary = /^# fail (\d+)/m.exec(text);
  return {
    pass: passSummary ? Number(passSummary[1]) : pass,
    fail: failSummary ? Number(failSummary[1]) : fail,
    failures,
    shown,
    canceled: /^# cancelled/m.test(text),
  };
}

// ── pool ─────────────────────────────────────────────────────────────────────
const t0 = Date.now();
let bundleMs = 0;
if (!NO_BUNDLE) {
  try { bundleMs = await bundle(); }
  catch (err) { console.error(`bundle failed: ${err.message}`); process.exit(1); }
}
console.log(`[test] ${files.length} file(s), concurrency ${CONCURRENCY}, ` +
  (NO_BUNDLE ? 'tsx (no bundle)' : `bundled in ${(bundleMs / 1000).toFixed(1)}s`));

fs.rmSync(TAP_DIR, { recursive: true, force: true });
fs.mkdirSync(TAP_DIR, { recursive: true });

const results = [];
let next = 0;
async function worker() {
  while (next < files.length) {
    const file = files[next++];
    const r = await runFile(file, !NO_BUNDLE);
    const tap = parseTap(r.tapPath);
    // `pass === 0` is a failure, never a pass: a file that tests nothing (or
    // crashed before the reporter ran) must not read as green. The ONE exception
    // is a deliberate --match filter, where a file with no matching name is not
    // a failure — but then the TOTAL match count is checked below, so a typo'd
    // pattern cannot pass as a green run either.
    const emptyIsBad = !opts.match;
    const bad = r.code !== 0 || r.killed || tap.fail > 0 || (emptyIsBad && tap.pass === 0);
    const rec = { ...r, ...tap, ok: !bad, total: tap.pass + tap.fail };
    if (r.killed) rec.failReason = `watchdog killed after ${FILE_TIMEOUT_MS / 1000}s (hang)`;
    else if (r.code !== 0 && tap.fail === 0) rec.failReason = `process exit ${r.code}`;
    else if (bad && tap.pass === 0 && tap.fail === 0) rec.failReason = 'zero passing subtests';
    results.push(rec);
    const status = rec.ok ? 'ok  ' : 'FAIL';
    console.log(`[test] ${status} ${(rec.ms / 1000).toFixed(1).padStart(6)}s ${rec.pass}p/${rec.fail}f ${rec.file}` +
      (rec.failReason ? `  ← ${rec.failReason}` : ''));
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, files.length) }, worker));

const wallMs = Date.now() - t0;
// A --match run that matched NOTHING is an error (exit 2), not a green pass.
if (opts.match && results.every(r => r.pass === 0)) {
  console.error(`[test] --match ${JSON.stringify(opts.match)} matched no test in ${results.length} file(s)`);
  process.exit(2);
}

const failed = results.filter(r => !r.ok);
const sumPass = results.reduce((n, r) => n + r.pass, 0);
const sumFail = results.reduce((n, r) => n + r.fail, 0);
const slowest = [...results].sort((a, b) => b.ms - a.ms);

if (failed.length) {
  console.log(`\n${'='.repeat(72)}\nFAILURES (isolated TAP per file — detail cannot interleave)\n${'='.repeat(72)}`);
  for (const r of failed) {
    console.log(`\n── ${r.file} (${r.pass}p/${r.fail}f, ${(r.ms / 1000).toFixed(1)}s)` +
      (r.failReason ? ` — ${r.failReason}` : ''));
    const text = fs.existsSync(r.tapPath) ? fs.readFileSync(r.tapPath, 'utf8') : '';
    if (r.failures.length) console.log(r.failures.join('\n\n'));
    else {
      // No `not ok` at all: the process died before/after the reporter. Show the
      // tail, which is the stack that killed it.
      console.log(text.split('\n').filter(l => !/^\s*(#|TAP version)/.test(l)).slice(-25).join('\n'));
    }
  }
}

console.log(`\n[test] files ${results.length}, pass ${sumPass}, fail ${sumFail}, ` +
  `failed files ${failed.length}`);
console.log(`[test] wall ${(wallMs / 1000).toFixed(1)}s ` +
  `(bundle ${(bundleMs / 1000).toFixed(1)}s, concurrency ${CONCURRENCY})`);
console.log(`[test] slowest: ` + slowest.slice(0, 8)
  .map(r => `${path.basename(r.file, '.test.ts')} ${(r.ms / 1000).toFixed(1)}s`).join(', '));

if (opts.profile) {
  fs.mkdirSync(path.dirname(PROFILE), { recursive: true });
  fs.writeFileSync(PROFILE, JSON.stringify({
    when: new Date().toISOString(), wallMs, bundleMs, concurrency: CONCURRENCY,
    files: results.map(r => ({ file: r.file, ms: r.ms, pass: r.pass, fail: r.fail, ok: r.ok })),
  }, null, 2));
  console.log(`[test] profile → ${path.relative(ROOT, PROFILE)}`);
}

process.exit(failed.length ? 1 : 0);
