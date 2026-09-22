#!/usr/bin/env tsx
/**
 * bank:relearn — P2 of the closed-loop bank: your correction becomes the teacher.
 *
 * Until now a correction fixed the TRIGGER (detectors, via loop-a). This
 * fixes the ANSWER: hand Gemini the wrong reply, the correction, and the
 * key's P1 contract — the generalization it returns (5+ variants, all
 * constraint-checked) is STAGED for bank:review. Nothing serves until you
 * promote it. This is "one correction → N correct variants".
 *
 * FROZEN KEYS: fee.* / price.ask etc. are untouchable by the cron — but a
 * human correction unlocks exactly one staged regeneration round (the
 * correction is the key that fits the lock). Data-driven keys stay locked
 * forever: property facts are never prose.
 *
 * Usage:
 *   npm run bank:relearn -- --key fee.ask.buy --correction 12   # from bank_corrections
 *   npm run bank:relearn -- --key fee.ask.buy --text "…"        # ad-hoc correction
 *   npm run bank:relearn -- --list                              # staged candidates
 *   npm run bank:relearn -- --promote 34 35 36                  # approve staged rows
 *   npm run bank:relearn -- --reject 37                          # drop a staged row
 */

import '../src/compat/node16';
import * as fs from 'fs';
import * as path from 'path';

import { Db } from '../src/store/db';
import { BankStore, DATA_DRIVEN_KEYS, FROZEN_BANK_KEYS, MAX_VARIANTS_PER_KEY } from '../src/store/bank';
import { EnrichmentStore } from '../src/store/enrichment';
import { createLlmStrict } from '../src/llm/factory';
import { loadConfig } from '../src/config';
import { RESPONSE_BANK } from '../src/data/responses';
import { renderPromptBlock, validateBatch, constraintsFor } from '../src/llm/bankConstraints';

const dbPath = process.argv.includes('--db') ? path.resolve(fs.realpathSync(process.argv[process.argv.indexOf('--db') + 1])) : loadConfig().dbPath;
const db = new Db(dbPath);
const bank = new BankStore(db);

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function seedVariants(key: string): string[] {
  return [...((RESPONSE_BANK as Record<string, string[]>)[key] ?? []), ...bank.variants(key)];
}

async function relearn(key: string, wrongReply: string, correction: string, correctionMsg: string): Promise<void> {
  const c = constraintsFor(key);
  if (DATA_DRIVEN_KEYS.has(key)) {
    console.error(`✗ ${key} is DATA-DRIVEN — property facts live in the row, never in bank prose. Nothing to relearn.`);
    process.exit(1);
  }
  const existing = seedVariants(key);
  if (existing.length >= MAX_VARIANTS_PER_KEY) {
    console.error(`✗ ${key} already has ${existing.length} variants (max ${MAX_VARIANTS_PER_KEY}). Retire weak ones first (bank:relearn --retire <id>).`);
    process.exit(1);
  }

  console.log(`[relearn] ${key} — frozen: ${FROZEN_BANK_KEYS.has(key) ? 'yes (unlocked by this correction, STAGED only)' : 'no'}`);
  console.log(`[relearn] contract: ${c.note}`);
  console.log(`[relearn] wrong reply: "${wrongReply.slice(0, 80)}…"`);

  const llm = createLlmStrict(loadConfig());
  const res = await llm.complete({
    role: 'generate',
    messages: [
      {
        role: 'system',
        content:
          'You are a Macedonian text generator for the Metropolis real-estate assistant. The assistant gave a WRONG or unhelpful reply; a human supervisor corrected it. Your job is to GENERALIZE the correction: produce 5 alternative phrasings of the CORRECT answer, each on a new line prefixed with "- ". Different sentence structures, same policy and facts. Natural, professional, warm Macedonian. No numbering, no markdown, only the "- " prefix.\n\n' +
          renderPromptBlock(key),
      },
      {
        role: 'user',
        content:
          `Bank key: ${key}\n` +
          `Client message that triggered the wrong reply:\n${correctionMsg || '(not recorded)'}\n\n` +
          `WRONG reply the assistant gave:\n${wrongReply}\n\n` +
          `SUPERVISOR CORRECTION (the policy to express):\n${correction}\n\n` +
          `Correct existing variants for tone reference (do not copy):\n${existing.slice(0, 3).map((s, i) => `Sample ${i + 1}: ${s}`).join('\n')}\n\n` +
          `Generate 5 NEW correct variations:`,
      },
    ],
    temperature: 0.9,
    maxTokens: 900,
    topP: 0.95,
  });

  const lines = res.split('\n').filter(l => l.startsWith('- '));
  const candidates = lines.map(l => l.slice(2).trim()).filter(Boolean);
  const { kept, rejected } = validateBatch(key, candidates);
  for (const r of rejected) console.log(`[relearn] REJECTED — ${r.reasons.join('; ')}\n   "${r.text.slice(0, 90)}"`);

  let staged = 0;
  for (const v of kept) {
    const dup = existing.some(e => e.toLowerCase() === v.toLowerCase());
    if (dup) continue;
    if (bank.addStagedVariant(key, v, `relearn from correction: ${correction.slice(0, 80)}`)) staged++;
  }
  console.log(`[relearn] staged ${staged}/${kept.length} candidates for ${key} — review with: npm run bank:relearn -- --list, promote with --promote <id>`);
}

function list(): void {
  const rows = bank.stagedVariants();
  if (rows.length === 0) { console.log('(no staged candidates)'); return; }
  const byKey = new Map<string, typeof rows>();
  for (const r of rows) {
    const arr = byKey.get(r.key) ?? [];
    arr.push(r);
    byKey.set(r.key, arr);
  }
  for (const [key, arr] of byKey) {
    console.log(`\n${key} (${arr.length} staged):`);
    for (const r of arr) console.log(`  #${r.id}  ${r.text.slice(0, 100)}${r.text.length > 100 ? '…' : ''}`);
  }
  console.log(`\npromote: npm run bank:relearn -- --promote <id>…   reject: npm run bank:relearn -- --reject <id>`);
}

/**
 * NIGHTLY DIGEST (P-runtime): fold bank_dynamic groups into deterministic
 * coverage. Trigger side: client messages become retrieval examples for the
 * dynamic key. Answer side: the stored answer becomes ONE staged variant
 * (bank:review promotes it — nothing auto-serves into the response bank).
 * FIFO purge keeps the dynamic store a fresh signal, not an archive.
 */
function digestDynamic(): void {
  const groups = bank.dynamicGroups();
  let examples = 0, staged = 0;
  for (const g of groups) {
    for (const m of g.msgs) {
      if (bank.addExample(g.key, m)) examples++;
    }
    if (bank.addStagedVariant(g.key, g.answer, `dynamic digest from ${g.msgs.length} stored question(s)`)) staged++;
  }
  const purged = bank.purgeDynamic(400);
  // Mark the corresponding serve rows processed — keeps listPending clean.
  let marked = 0;
  try { marked = new EnrichmentStore(db).markDynamicProcessed(); } catch { /* advisory */ }
  console.log(`[digest] ${groups.length} dynamic group(s): +${examples} retrieval examples, ${staged} answer variant(s) staged for review, ${purged} purged, ${marked} serve row(s) marked`);
}

async function main(): Promise<void> {
  if (process.argv.includes('--digest-dynamic')) { digestDynamic(); return; }
  if (process.argv.includes('--list')) { list(); return; }
  const promote = process.argv.includes('--promote');
  const reject = process.argv.includes('--reject');
  if (promote || reject) {
    const ids = process.argv.slice(process.argv.indexOf(promote ? '--promote' : '--reject') + 1)
      .filter(a => /^\d+$/.test(a)).map(Number);
    let n = 0;
    for (const id of ids) n += (promote ? bank.promoteVariant(id) : bank.deleteStagedVariant(id)) ? 1 : 0;
    console.log(`${promote ? 'promoted' : 'rejected'} ${n}/${ids.length} staged variant(s)`);
    return;
  }
  const key = arg('--key');
  if (!key) {
    console.error('usage: npm run bank:relearn -- --key <key> (--correction <id> | --text "...") [--msg "..."]');
    console.error('       npm run bank:relearn -- --list | --promote <id>… | --reject <id>…');
    process.exit(1);
  }
  let wrongReply = '';
  let correction = '';
  let msg = '';
  const corrId = arg('--correction');
  if (corrId) {
    const rows = [...bank.correctionsByStatus('new'), ...bank.correctionsByStatus('staged'), ...bank.correctionsByStatus('processed')];
    const r = rows.find(x => x.id === Number(corrId));
    if (!r) { console.error(`correction #${corrId} not found`); process.exit(1); }
    wrongReply = r.reply;
    msg = r.msg;
    correction = arg('--text') ?? `See the supervisor's intent: the served reply was wrong for this situation. Key policy: ${constraintsFor(key).note ?? 'answer the client correctly'}.`;
  } else {
    wrongReply = arg('--wrong') ?? '(unrecorded)';
    correction = arg('--text');
    msg = arg('--msg') ?? '';
    if (!correction) { console.error('--text <correction> is required (or use --correction <id>)'); process.exit(1); }
  }
  await relearn(key, wrongReply, correction, msg);
}

main().catch(e => { console.error('[relearn] fatal:', e); process.exit(1); });
