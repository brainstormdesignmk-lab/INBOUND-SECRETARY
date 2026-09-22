#!/usr/bin/env tsx
/**
 * loop-a — the nightly trigger-correction runner.
 *
 * Consumes bank_corrections (status='new'), resolves each wrong-answer msg to
 * its trigger family (the same FAMILIES table the sweep uses — one source of
 * truth), appends it as a GAP row into data/hardening/<family>.json, then
 * (if anything changed) runs the gates: propose-stems --emit → typecheck →
 * replay → full suite. Emit failure ⇒ revert detectorExt.ts, stage the note.
 *
 * Intake paths that feed it: TUI [F9] (manual), bank.correction() (quality
 * gate), enrichment bankKey=null fallback-literal census (later, P4).
 *
 * Usage:
 *   npx tsx scripts/loop-a.ts              # process + gate
 *   npx tsx scripts/loop-a.ts --dry        # resolve only, no writes
 */

import '../src/compat/node16';
import * as fs from 'fs';
import { execSync } from 'child_process';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { EnrichmentStore } from '../src/store/enrichment';
import { FAMILIES } from './sweep-keys';

const run = (cmd: string) => execSync(cmd, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });

function resolveFamily(msg: string): { family: string | null; hits: string[] } {
  const hits = FAMILIES.filter(f => {
    try { return f.target(msg); } catch { return false; }
  }).map(f => f.id);
  if (hits.length === 1) return { family: hits[0], hits };
  if (hits.length === 0) return { family: null, hits };
  // Ambiguous: prefer a family whose corpus already knows the phrase.
  for (const h of hits) {
    const file = `data/hardening/${h}.json`;
    if (!fs.existsSync(file)) continue;
    try {
      const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as { rows?: Array<{ phrase: string }> };
      if (saved.rows?.some(r => r.phrase === msg)) return { family: h, hits };
    } catch { /* ignore */ }
  }
  return { family: null, hits };
}

function appendGap(family: string, phrase: string): boolean {
  const file = `data/hardening/${family}.json`;
  if (!fs.existsSync(file)) return false;
  const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as {
    bankKey?: string; protects?: string; bug?: string; rows: Array<{ phrase: string; verdict: string; target: boolean; cross: string[] }>;
  };
  if (!Array.isArray(saved.rows)) return false;
  if (saved.rows.some(r => r.phrase === phrase)) return false; // already pinned
  // If the detector ALREADY fires on it, this is a regression pin, not a gap
  // to fix (propose-stems would otherwise mine a covered phrase for junk).
  const spec = FAMILIES.find(f => f.id === family);
  const fires = spec ? (() => { try { return spec.target(phrase); } catch { return false; } })() : false;
  saved.rows.push({ phrase, verdict: fires ? 'COVERED' : 'GAP', target: true, cross: [] });
  fs.writeFileSync(file, JSON.stringify(saved, null, 2));
  return true;
}

function main(): void {
  const dry = process.argv.includes('--dry');
  const dbArg = process.argv.includes('--db') ? process.argv[process.argv.indexOf('--db') + 1] : 'data/lina.db';
  const bank = new BankStore(new Db(dbArg));
  // P-runtime NIGHTLY DIGEST: fold bank_dynamic groups (runtime fallback
  // serves) into retrieval examples + ONE staged answer variant per group,
  // then FIFO-purge. Runs before corrections so the whole signal is fresh.
  if (!dry) {
    const groups = bank.dynamicGroups();
    if (groups.length > 0) {
      let examples = 0, staged = 0;
      for (const g of groups) {
        for (const m of g.msgs) if (bank.addExample(g.key, m)) examples++;
        if (bank.addStagedVariant(g.key, g.answer, `dynamic digest from ${g.msgs.length} stored question(s)`)) staged++;
      }
      const purged = bank.purgeDynamic(400);
      console.log(`[loop-a] dynamic digest: ${groups.length} group(s) → +${examples} examples, ${staged} staged answer(s), ${purged} purged`);
    }
    try {
      const marked = new EnrichmentStore(new Db(dbArg)).markDynamicProcessed();
      if (marked > 0) console.log(`[loop-a] marked ${marked} dynamic serve(s) processed`);
    } catch { /* advisory */ }
  }
  const pending = bank.correctionsByStatus('new');
  console.log(`[loop-a] ${pending.length} correction(s) pending`);

  let appended = 0;
  for (const c of pending) {
    const { family, hits } = resolveFamily(c.msg);
    if (dry) { console.log(`[dry] #${c.id} "${c.msg.slice(0, 60)}" → ${family ?? (hits.length ? `AMBIGUOUS(${hits.join('|')})` : 'NO FAMILY')}`); continue; }
    if (hits.length === 0) {
      bank.correctionStage(c.id, 'no family matched — new-family candidate');
      console.log(`[#${c.id}] STAGED new-family candidate: "${c.msg.slice(0, 60)}"`);
      continue;
    }
    if (hits.length > 1 && !family) {
      bank.correctionStage(c.id, `ambiguous: ${hits.join('|')}`);
      console.log(`[#${c.id}] STAGED ambiguous (${hits.join('|')}): "${c.msg.slice(0, 60)}"`);
      continue;
    }
    const fam = family!;
    if (appendGap(fam, c.msg)) appended++;
    bank.correctionResolve(c.id, fam);
    console.log(`[#${c.id}] ${fam} ← "${c.msg.slice(0, 60)}"`);
  }

  if (dry || appended === 0) { console.log('[loop-a] corpus unchanged — done'); return; }

  // ── GATES ──────────────────────────────────────────────────────────
  const gates: Array<[string, () => void]> = [
    ['emit', () => run('npx tsx scripts/propose-stems.ts --emit')],
    ['typecheck', () => run('npx tsc --noEmit')],
    ['replay', () => { const out = run('npx tsx scripts/sweep-keys.ts --replay'); if (/STILL-GAP/.test(out)) throw new Error('replay left STILL-GAPs'); }],
    ['suite', () => run('npx tsx --test tests/*.test.ts')],
  ];
  for (const [name, fn] of gates) {
    try { fn(); console.log(`[gate] ${name} ✓`); }
    catch (e) {
      console.error(`[gate] ${name} ✗ — reverting emit, staged for review`);
      try { run('git checkout src/llm/detectorExt.ts'); } catch { /* not tracked yet */ }
      console.error(String((e as Error).message).slice(0, 400));
      process.exit(1);
    }
  }
  console.log(`[loop-a] ${appended} phrase(s) into corpora, all gates green — review the diff and commit`);
}

main();
