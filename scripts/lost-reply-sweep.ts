#!/usr/bin/env tsx
/**
 * lost-reply-sweep — report lanes whose assigned reply can be silently
 * overwritten before it is sent.
 *
 *   npm run reply:sweep                  # the whole file
 *   npm run reply:sweep -- --lane 4757   # one assignment, with its block
 *
 * `reply` is a single variable sent ONCE at the end of the turn. A lane that
 * assigns it and then falls through into another lane that also assigns it
 * loses its message — the client gets the later text, while the operator log
 * shows a lane that appears to have served something it never sent. That is the
 * shape the [21:57] cancel branch had (it notified the scheduler, fell through,
 * and a scheduling lane overwrote the farewell).
 *
 * The sweep reads the file's `if / else if / else` ladders: two assignments in
 * different branches of one ladder can never both run, so only a later writer
 * that is NOT exclusive with the current one is reported. Nothing is edited —
 * each hit is a block for a human to read.
 *
 * SCOPE: `reply =` assignments only. Lanes that send directly
 * (`await this.sendRaw(session, …); return;`) are outside its reach by design —
 * their guarantee is dynamic, asserted where their message counts are known:
 * the cancelling turn (tests/visits.test.ts), both queuing turns
 * (tests/fee-nag-ladder.test.ts) and the strike-3 ban turn (tests/stuck.test.ts).
 * tests/lost-reply-sweep.test.ts pins the sweep itself.
 */

import * as fs from 'fs';
import * as path from 'path';

/** The file the sweep reads. It must be the SAME `src/handlers/inbound.ts` the
 *  app is built from, wherever this module is loaded from: run directly under
 *  tsx (scripts/), imported by the tsx suite (tests/), or bundled by
 *  scripts/run-tests-compiled.sh (dist-test/tests/). A fixed `..` path only
 *  works from the first two, so the repo root is found by walking up until
 *  `src/handlers/inbound.ts` appears — and a miss is a loud error, never a
 *  silent read of the wrong file. */
function findSource(): string {
  let dir = __dirname;
  for (let i = 0; i < 8; i++) {
    const hit = path.join(dir, 'src', 'handlers', 'inbound.ts');
    if (fs.existsSync(hit)) return hit;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`lost-reply-sweep: src/handlers/inbound.ts not found above ${__dirname}`);
}
export const SRC = findSource();
const count = (s: string, ch: string): number => s.split(ch).length - 1;

export interface Branch { chain: number; idx: number; start: number; end: number }
export interface Assignment {
  line: number;
  method: string;
  guardLine: number;
  guard: string;
  /** The guard lines on this assignment's path (outermost → innermost). */
  guardChain: string[];
  endLine: number;
  returns: boolean;
  chainPath: Array<{ chain: number; idx: number }>;
  text: string;
}

/** The class's method bodies — each has its own `reply` local, so a reply in one
 *  method can never be overwritten by a reply in another. */
function methodRanges(lines: string[]): Array<{ name: string; start: number; end: number }> {
  const starts: Array<{ name: string; start: number }> = [];
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^ {2}(?:(?:private|public|protected|readonly|static|async)\s+)*(\w+)\s*[(<]/);
    if (m) starts.push({ name: m[1], start: i });
  }
  return starts.map((s, k) => ({ name: s.name, start: s.start, end: k + 1 < starts.length ? starts[k + 1].start - 1 : lines.length - 1 }));
}

/**
 * The block starting at `start`, by brace balance. A `} else` line at the SAME
 * indent closes the branch and opens the next one, so it ends the scan — that
 * is what makes `if (a) {…} else {…}` two branches instead of one block.
 */
const endCache = new Map<number, number>();
export function blockEnd(lines: string[], start: number): number {
  const cached = endCache.get(start);
  if (cached !== undefined) return cached;
  const headIndent = lines[start].match(/^\s*/)![0].length;
  // A brace-less head (`if (x) doIt();`) owns only its statement — without this
  // the scan runs on into the next line that happens to contain braces and
  // swallows statements that belong to the enclosing block.
  if (!lines[start].includes('{')) {
    let last = start;
    for (let i = start + 1; i < lines.length; i++) {
      const ind = lines[i].match(/^\s*/)![0].length;
      if (ind <= headIndent) break;
      last = i;
      if (lines[i].trim().endsWith(';')) break;
    }
    endCache.set(start, last);
    return last;
  }
  // A `} else {` head closes the PREVIOUS branch with its `}`: that brace is
  // not part of this block, so the balance starts at 1.
  let bal = /^\s*\}\s*else\b/.test(lines[start]) ? 1 : 0;
  let end = lines.length - 1;
  for (let i = start; i < lines.length; i++) {
    const indent = lines[i].match(/^\s*/)![0].length;
    bal += count(lines[i], '{') - count(lines[i], '}');
    if (bal <= 0 && (lines[i].includes('{') || i > start)) { end = i; break; }
    // A sibling branch at the SAME indent ends this one — this is what keeps
    // the 8k-line FSM ladder from being read as one giant block.
    if (i > start && indent === headIndent && /^\s*\}\s*else\b/.test(lines[i])) { end = i; break; }
  }
  endCache.set(start, end);
  return end;
}

const isIf = (l: string) => /^\s*if\s*\(/.test(l);
const isElseIf = (l: string) => /^\s*\}\s*else\s+if\s*\(/.test(l) || /^\s*else\s+if\s*\(/.test(l);
const isElse = (l: string) => /^\s*\}\s*else\s*\{/.test(l) || /^\s*else\s*\{/.test(l);

/** Every branch of every `if / else if / else` ladder in the file. */
export function branches(lines: string[]): Branch[] {
  const out: Branch[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!isIf(lines[i])) continue;
    // The head's line number identifies the ladder; every `} else`/`} else if`
    // sibling belongs to it. No scanning is skipped, so ladders NESTED inside
    // these branches are walked too (the 8k-line FSM ladder swallows half the
    // file otherwise).
    const id = i;
    let start = i;
    let end = blockEnd(lines, start);
    let idx = 0;
    out.push({ chain: id, idx, start, end });
    while (end + 1 < lines.length && (isElseIf(lines[end]) || isElse(lines[end]))) {
      start = end;
      const next = blockEnd(lines, start);
      if (next <= start) break;
      end = next;
      idx += 1;
      out.push({ chain: id, idx, start, end });
    }
  }
  return out;
}

export function scan(lines: string[]): Assignment[] {
  const brs = branches(lines);
  const methods = methodRanges(lines);
  const out: Assignment[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^\s*reply = /.test(lines[i])) continue;
    // Sort by start so `owners[last]` is the INNERMOST branch: ranges of
    // different ladders can overlap (one head's block spans another head's),
    // and push order is head order, not nesting order.
    const owners = brs.filter(b => b.start < i && i <= b.end).sort((x, y) => x.start - y.start);
    const chainPath = owners.map(b => ({ chain: b.chain, idx: b.idx }));
    const innermost = owners[owners.length - 1];
    const guardLine = innermost ? innermost.start : -1;
    const endLine = innermost ? innermost.end : i;
    const guardChain = owners.map(b => lines[b.start])
      .concat(innermost && innermost.start === i ? [] : [lines[i]]);
    out.push({
      line: i + 1,
      method: methods.find(m => m.start <= i && i <= m.end)?.name ?? '(class body)',
      guardChain,
      guardLine: guardLine + 1,
      guard: (guardLine >= 0 ? lines[guardLine].trim() : '(method body)').slice(0, 84),
      endLine: endLine + 1,
      returns: /\breturn\b/.test(lines.slice(Math.max(guardLine, 0), endLine + 1).join('\n')),
      chainPath,
      text: lines.slice(Math.max(guardLine, 0), endLine + 1).join('\n'),
    });
  }
  return out;
}

/**
 * What the writers' guards assert about the turn's discriminants. The late
 * region of this file is a SEQUENCE of standalone `if (next === 'x')` lanes —
 * not an else-if ladder — so branch exclusivity cannot see that only one of
 * them can run. Comparing the literals they assert on the same variable can.
 */
function discriminants(heads: string[]): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  const add = (v: string, lit: string) => {
    if (!out.has(v)) out.set(v, new Set());
    out.get(v)!.add(lit);
  };
  for (const head of heads) {
    for (const m of head.matchAll(/([\w.]+)\s*===\s*'([^']+)'/g)) add(m[1], m[2]);
    // `['closing', 'presentation'].includes(before)` — membership, same idea.
    for (const m of head.matchAll(/\[([^\]]*)\]\.includes\(\s*([\w.]+)\s*\)/g)) {
      for (const lit of m[1].matchAll(/'([^']+)'/g)) add(m[2], lit[1]);
    }
    for (const m of head.matchAll(/([\w.]+)\s*==\s*'([^']+)'/g)) add(m[1], m[2]);
  }
  return out;
}

/** Two assignments can both run unless their guards contradict each other. */
export function exclusive(a: Assignment, b: Assignment): boolean {
  if (a.chainPath.some(x => b.chainPath.some(y => y.chain === x.chain && y.idx !== x.idx))) return true;
  const da = discriminants(a.guardChain);
  const db = discriminants(b.guardChain);
  for (const [v, lits] of da) {
    const other = db.get(v);
    if (!other) continue;
    if ([...lits].every(l => !other.has(l))) return true; // no shared value for that var
  }
  return false;
}

/** The pairs a human has to read: a writer a later one is not provably exclusive with. */
export function candidates(lines: string[]): Array<{ a: Assignment; b: Assignment }> {
  const list = scan(lines);
  const out: Array<{ a: Assignment; b: Assignment }> = [];
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i];
    const b = list[i + 1];
    if (a.returns) continue;                    // the turn ends; nothing later runs
    if (b.method !== a.method) continue;        // another method's own `reply`
    if (exclusive(a, b)) continue;              // one ladder, two branches
    out.push({ a, b });
  }
  return out;
}

function main(): void {
  const lines = fs.readFileSync(SRC, 'utf8').split('\n');
  const list = scan(lines);
  const laneIdx = process.argv.indexOf('--lane');
  if (laneIdx >= 0) {
    const want = Number(process.argv[laneIdx + 1]);
    const hit = list.find(a => a.line === want);
    if (!hit) { console.error(`no reply assignment at line ${want}`); process.exit(2); }
    console.log(`reply = @${hit.line} in ${hit.method}() — guard @${hit.guardLine}: ${hit.guard}`);
    console.log(`block @${hit.guardLine}..${hit.endLine}, returns=${hit.returns}`);
    console.log(`ladder path: ${JSON.stringify(hit.chainPath)}\n`);
    console.log(hit.text);
    return;
  }

  console.log(`reply assignments in ${path.relative(path.join(__dirname, '..'), SRC)}: ${list.length}\n`);
  const risky = candidates(lines);
  console.log(`overwritable candidates: ${risky.length} of ${list.length}`);
  for (const { a, b } of risky) {
    console.log(`  @${a.line} in ${a.method}()  guard @${a.guardLine}: ${a.guard}`);
    console.log(`        next writer @${b.line}  guard @${b.guardLine}: ${b.guard}`);
  }
  if (risky.length === 0) console.log('  (none — every reply assignment is either final or ladder-exclusive)');
  console.log('\nUse --lane <n> to print the block of any hit.');
}

// Only when run as a CLI — importing this module (the pinning test does) must
// not sweep, print, or need a live file at load time.
if (require.main === module) main();
