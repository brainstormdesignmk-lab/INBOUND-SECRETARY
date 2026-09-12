#!/usr/bin/env tsx
/**
 * One-off targeted enrichment: grow `fee.why` with Gemini variants.
 *
 * fee.why is the most-pressured key in the funnel: every why-question, bare
 * pushback ("NAPLAKJATE ZA POSETA"), fee complaint and fee surprise ("AUUU
 * OVA E NESTO NOVO") lands here. 11 seed variants repeat visibly across a
 * week of traffic — this pass grows the pool to 20 so the picker can rotate.
 *
 * CRITICAL: variants must NOT contain amounts ("300 денари") — the amount
 * differs by service (buy/rent) and belongs to fee.ask.*, never to the
 * rationale. The replyIsClean price-digit gate enforces this mechanically.
 *
 * Run: npx tsx scripts/gapfill-fee-why.ts [--dry] [--target 20]
 * Targets EVERY Lina DB present (lina.db = production, tui.db = TUI) — same
 * contract as the cron wrapper. Same quality gates as the midnight cron —
 * replyIsClean + dedupe — via the shared enrichQuality module.
 */
import { accessSync } from 'fs';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { RESPONSE_BANK } from '../src/data/responses';
import { setLearnedBank } from '../src/data/responseBank';
import { replyIsClean, similarity } from '../src/llm/enrichQuality';
import { createLlm } from '../src/llm/factory';

const dry = process.argv.includes('--dry');
const targetIdx = process.argv.indexOf('--target');
const TARGET = targetIdx >= 0 ? parseInt(process.argv[targetIdx + 1], 10) || 20 : 20;

const KEY = 'fee.why';

const SYSTEM_PROMPT =
  'You are a Macedonian text generator for a real-estate assistant. Generate 5 VARIATIONS of the same response, each on a new line prefixed with "- ". ' +
  'Each must be natural Macedonian (Cyrillic script), professional but warm. Vary the phrasing significantly. Keep the same meaning and tone. ' +
  'NEVER mention specific amounts or numbers (no "300", no "денари" with a number) — the fee amount is stated elsewhere. ' +
  'Each variation must: (1) explain that the viewing fee is a symbolic filter that selects serious clients and keeps the service high-quality, ' +
  '(2) end by asking the client whether they accept the condition, so the conversation can continue. ' +
  'Two to three sentences each. Do NOT include numbering, markdown, or any prefix other than "- ".';

function dedupeAgainst(newVariants: string[], existing: string[]): string[] {
  return newVariants.filter((v) => {
    if (existing.some((e) => e.toLowerCase() === v.toLowerCase())) return false;
    if (existing.some((e) => similarity(e, v) > 0.7)) return false;
    return true;
  });
}

async function fillDb(dbPath: string): Promise<void> {
  console.log(`\n=== ${dbPath} ===`);
  const cfg = loadConfig({ dbPath });
  const db = new Db(cfg.dbPath);
  const bank = new BankStore(db);
  setLearnedBank(bank);
  const seed = RESPONSE_BANK[KEY] ?? [];
  const learned = bank.variants(KEY);
  let total = seed.length + learned.length;
  console.log(`${KEY}: seed=${seed.length} learned=${learned.length} (target ${TARGET})`);
  if (total >= TARGET) {
    console.log('already at target — nothing to do');
    db.close();
    return;
  }

  const llm = createLlm(cfg);
  let added = 0;
  let attempts = 0;
  while (total < TARGET && attempts < 4) {
    attempts++;
    const samples = [...seed, ...learned].slice(0, 3);
    const text = await llm.complete({
      role: 'generate',
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: `Bank key: ${KEY}\n\nExisting response variations:\n${samples.map((s, i) => `Sample ${i + 1}: ${s}`).join('\n')}\n\nGenerate 5 NEW variations (different from the existing ones):` },
      ],
      temperature: 1.2,
      maxTokens: 900,
      topP: 0.95,
    });
    const lines = text.split('\n').filter((l) => l.startsWith('- '));
    const candidates = lines.map((l) => l.slice(2).trim()).filter(replyIsClean);
    const unique = dedupeAgainst(candidates, [...seed, ...learned]);
    for (const v of unique) {
      if (total >= TARGET) break;
      if (dry) { console.log(`[dry] would add: ${v}`); added++; total++; continue; }
      // forceAddVariant: fee.why is a FROZEN key (protocol wording). This
      // one-off is the human-directed carve-out the freeze was designed for
      // — the cron/learning loop still cannot touch frozen keys.
      if (bank.forceAddVariant(KEY, v, 'gapfill')) { added++; total++; console.log(`+ ${v}`); }
    }
  }
  console.log(`done: +${added} (total ${total})`);
  db.close();
}

function main(): void {
  const dbPaths = ['data/lina.db', 'data/tui.db'].filter((p) => {
    try { accessSync(p); return true; } catch { return false; }
  });
  if (dbPaths.length === 0) {
    console.error('no Lina DB found (expected data/lina.db and/or data/tui.db)');
    process.exit(1);
  }
  const run = async (): Promise<void> => {
    for (const p of dbPaths) await fillDb(p);
  };
  run().catch((e) => { console.error('fatal:', e); process.exit(1); });
}

main();
