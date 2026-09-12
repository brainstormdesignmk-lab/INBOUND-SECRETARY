#!/usr/bin/env tsx
/**
 * One-off targeted enrichment: grow `location.unknown` with Gemini variants.
 *
 * The NO-ADDRESS protocol (EB 58 class): when the agency never learned a
 * property's street ("НЕПОЗНАТА" address), Lina must NOT invent geography —
 * she says the location isn't known to her right now, she'll contact the
 * owner and confirm, then pivots to other options. 4 seed variants repeat
 * visibly; this pass grows the pool to 12.
 *
 * CRITICAL: variants must KEEP the {eb} placeholder (filled at serve time
 * with the Евидентен број) and must NOT contain any street/number/coords —
 * this key exists precisely because we don't know the address.
 *
 * Run: npx tsx scripts/gapfill-location-unknown.ts [--dry] [--target 12]
 * Targets EVERY Lina DB present (lina.db = production, tui.db = TUI). Same
 * quality gates as the midnight cron — replyIsClean + dedupe — via the
 * shared enrichQuality module.
 */
import { accessSync } from 'fs';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { RESPONSE_BANK } from '../src/data/responses';
import { setLearnedBank } from '../src/data/responseBank';
import { replyIsClean, similarity } from '../src/llm/enrichQuality';
import { createLlmStrict } from '../src/llm/factory';

const dry = process.argv.includes('--dry');
const targetIdx = process.argv.indexOf('--target');
const TARGET = targetIdx >= 0 ? parseInt(process.argv[targetIdx + 1], 10) || 12 : 12;

const KEY = 'location.unknown';

const SYSTEM_PROMPT =
  'You are a Macedonian text generator for a real-estate assistant. Generate 5 VARIATIONS of the same response, each on a new line prefixed with "- ". ' +
  'Each must be natural Macedonian (Cyrillic script), professional but warm. Vary the phrasing significantly. Keep the same meaning and tone. ' +
  'EVERY variation must literally contain the placeholder {eb} where the property number goes (example: "Евидентен број {eb}") — it is replaced at send time. ' +
  'Each variation must say exactly three things: (1) the exact location of property {eb} is not known to her right now, ' +
  '(2) she will contact the owner and confirm, (3) ask whether the client would like to look at something else. ' +
  'NEVER invent a street, neighborhood, number or coordinates — the whole point is that the location is unknown. ' +
  'Two sentences each. Do NOT include numbering, markdown, or any prefix other than "- ".';

function dedupeAgainst(newVariants: string[], existing: string[]): string[] {
  const norm = (s: string): string => s.replace(/\{eb\}/g, 'еvidenten').toLowerCase();
  return newVariants.filter((v) => {
    if (existing.some((e) => e.toLowerCase() === v.toLowerCase())) return false;
    if (existing.some((e) => similarity(norm(e), norm(v)) > 0.7)) return false;
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

  // STRICT: Gemini-only. When the keys are 429-exhausted this run FAILS
  // instead of degrading to Groq — a weak backend's output must never reach
  // the bank (the purged-garbage incident: "лошо место", "контаминани").
  const llm = createLlmStrict(cfg);
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
    // Gate order: cleanliness first, then the {eb} placeholder contract —
    // a variant without the placeholder can never be served correctly.
    const candidates = lines.map((l) => l.slice(2).trim()).filter(replyIsClean).filter((v) => v.includes('{eb}'));
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
