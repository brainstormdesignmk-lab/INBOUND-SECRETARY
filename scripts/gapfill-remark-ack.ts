#!/usr/bin/env tsx
/**
 * One-off targeted enrichment: grow `remark.ack` with Gemini variants.
 *
 * The remark family ("dobra lokacija ima", "ubavo mesto", "golemo e") is now
 * served BANK-FIRST from the fast path (remark.ack). This pass grows the key's
 * pool so the picker can avoid repeats across a long conversation. Same
 * quality gates as the midnight cron — replyIsClean + dedupe — via the shared
 * enrichQuality module.
 *
 * Run: npx tsx scripts/gapfill-remark-ack.ts [--dry] [--target 8]
 * Targets EVERY Lina DB present (lina.db = production, tui.db = TUI) — same
 * contract as the cron wrapper.
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
const TARGET = targetIdx >= 0 ? parseInt(process.argv[targetIdx + 1], 10) || 8 : 8;

const KEY = 'remark.ack';

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
  while (total < TARGET && attempts < 3) {
    attempts++;
    const samples = [...seed, ...learned].slice(0, 3);
    const text = await llm.complete({
      role: 'generate',
      messages: [
        { role: 'system', content: 'You are a Macedonian text generator for a real-estate assistant. Generate 5 VARIATIONS of the same response, each on a new line prefixed with "- ". Each must be natural Macedonian, professional but warm. Vary the phrasing significantly. Keep the same meaning and tone. Do NOT include numbering, markdown, or any prefix other than "- ".' },
        { role: 'user', content: `Bank key: ${KEY}\n\nExisting response variations:\n${samples.map((s, i) => `Sample ${i + 1}: ${s}`).join('\n')}\n\nGenerate 5 NEW variations (different from the existing ones):` },
      ],
      temperature: 1.2,
      maxTokens: 800,
      topP: 0.95,
    });
    const lines = text.split('\n').filter((l) => l.startsWith('- '));
    const candidates = lines.map((l) => l.slice(2).trim()).filter(replyIsClean);
    const unique = dedupeAgainst(candidates, [...seed, ...learned]);
    for (const v of unique) {
      if (total >= TARGET) break;
      if (dry) { console.log(`[dry] would add: ${v}`); added++; total++; continue; }
      if (bank.addVariant(KEY, v, 'gapfill')) { added++; total++; console.log(`+ ${v}`); }
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
