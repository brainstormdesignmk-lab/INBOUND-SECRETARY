#!/usr/bin/env tsx
/**
 * One-off targeted enrichment: grow the remaining THIN PROSE keys.
 *
 *   both.ask.service  (3 seeds) — "{type} — ack? купување или изнајмување?"
 *   both.ask.type     (4 seeds) — "кој тип недвижност… стан/куќа/деловен/плац?"
 *   offtopic.redirect (3 seeds) — polite refocus + service question
 *   vague.time        — the exact-hour re-ask after a day-only term ([12:42])
 *   nearby.exhausted  — the landmark-rotation close
 *
 * None of these are frozen/data-driven — plain addVariant applies (the cron
 * could grow them too, but organic traffic for these intents is rare, so a
 * one-off pass closes the gap immediately). Same quality gates as the
 * midnight cron — replyIsClean + dedupe — via the shared enrichQuality
 * module. every DB present is filled (lina.db + tui.db).
 *
 * Run: npx tsx scripts/gapfill-thin-keys.ts [--dry] [--target 10]
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
const TARGET = targetIdx >= 0 ? parseInt(process.argv[targetIdx + 1], 10) || 10 : 10;

const SYSTEM_PREAMBLE =
  'You are a Macedonian text generator for a real-estate assistant. Generate 5 VARIATIONS of the same response, each on a new line prefixed with "- ". ' +
  'Each must be natural Macedonian (Cyrillic script), professional but warm. Vary the phrasing significantly. Keep the same meaning and tone. ' +
  'NEVER mention specific amounts or numbers. Do NOT include numbering, markdown, or any prefix other than "- ".\n';

const KEYS: Array<{ key: string; instruction: string; keepPlaceholder?: string; dedupeStrip?: string }> = [
  {
    key: 'both.ask.service',
    instruction:
      'Each variation MUST begin with the literal text {type} followed by " — ". Keep the literal {type} EXACTLY as is — never replace or translate it; the system substitutes the property type at runtime. ' +
      'After the dash: a short warm acknowledgment, then ask whether the client wants to BUY (купување) or RENT (изнајмување). ' +
      'Do NOT name any specific property type (no стан/куќа/деловен/плац) — the placeholder carries it. End with a question mark.',
    dedupeStrip: '{type} — ',
  },
  {
    key: 'both.ask.type',
    instruction:
      'Ask which property TYPE the client is interested in, always listing the four options: стан, куќа, деловен простор, плац. ' +
      'Vary the opening (Кој тип… / Разбирам… / Одлично… / За да Ви понудам…) and the phrasing around the list. End with a question mark.',
  },
  {
    key: 'offtopic.redirect',
    instruction:
      'The client went off-topic (weather, jokes, personal questions). Politely redirect: state that you are fully focused on helping find the right property, ' +
      'then ask whether they are looking to buy (купување) or rent (изнајмување). NEVER engage with the off-topic subject itself. End with a question mark.',
  },
  {
    key: 'vague.time',
    instruction:
      'The client gave a visit DAY but no exact hour („во понеделник“, „PONEDELIK 6“ with the hour unclear, „утре“, „попладне“). Acknowledge the day is noted, then ask ONLY for the exact hour so the appointment can be checked with the owner. ' +
      'Vary the opening (Може ли… / Разбирам… / Ќе треба… / Супер, само…). ALWAYS end with a question asking the exact hour („во колку часот?“ family). Never name a specific hour yourself. Never re-ask which DAY — the day is already known.',
  },
  {
    key: 'near.center.ask',
    instruction:
      'The client wants something near the CENTER. Tell them the neighborhoods bordering Центар are Карпош, Аеродром and Кисела Вода — always list exactly those three. ' +
      'Then ask whether they have a SPECIFIC neighborhood in mind, or want everything close to the center. End with a question mark.',
  },
  {
    key: 'near.center.ring',
    instruction:
      'A SHORT intro line announcing that the best options from the neighborhoods closest to the center follow (the property list itself is appended by the system). ' +
      'One or two sentences maximum, ending with a PERIOD (not a colon). Vary the acknowledgment (Одлично / Во ред / Ги одбрав…). Never name specific properties or prices.',
  },
  {
    key: 'presentation.relaxed.category',
    instruction:
      'Honest studio-fallback intro: there is currently NO free garsonjera (studio) in this area, BUT there is a small compact apartment (мало станче) within the client\'s budget. ' +
      'Offer to arrange a visit immediately if they like it. Mention garsonjera/станче, the budget, and the visit. End with a complete sentence (period or question mark).',
  },
  {
    key: 'discovery.ask.budget.house',
    instruction:
      'Ask the client for the UPPER PRICE LIMIT (горната граница на цената) for the HOUSE (куќа) they are looking for. ' +
      'NEVER mention any specific amount or number — only ask for their limit. Vary phrasing significantly. End with a question mark.',
  },
  {
    key: 'discovery.ask.budget.business',
    instruction:
      'Ask the client for the UPPER PRICE LIMIT (горната граница на цената) for the BUSINESS SPACE (деловен простор) they are looking for. ' +
      'NEVER mention any specific amount or number — only ask for their limit. Vary phrasing significantly. End with a question mark.',
  },
  {
    key: 'nearby.exhausted',
    instruction:
      'The nearby-landmark rotation is EXHAUSTED — politely close the location topic: the area is now clear to the client, and the EXACT address is revealed on the day of the visit (agency rule). ' +
      'Vary the opening (Мислам дека… / Сметам дека… / Верувам дека…). Keep the two facts in every variant: (1) the area/region is clear, (2) the exact address comes on visit day. Never apologize, never offer more landmarks.',
  },
];

function dedupeAgainst(newVariants: string[], existing: string[], strip?: string): string[] {
  const norm = (v: string): string => (strip ? v.replace(strip, '') : v);
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
  const llm = createLlm(cfg);

  for (const cfgKey of KEYS) {
    const { key, instruction, dedupeStrip } = cfgKey;
    const seed = RESPONSE_BANK[key] ?? [];
    const learned = bank.variants(key);
    let total = seed.length + learned.length;
    console.log(`\n-- ${key}: seed=${seed.length} learned=${learned.length} (target ${TARGET})`);
    if (total >= TARGET) {
      console.log('   already at target — skipped');
      continue;
    }

    let added = 0;
    let attempts = 0;
    while (total < TARGET && attempts < 4) {
      attempts++;
      const samples = [...seed, ...learned].slice(0, 3);
      const text = await llm.complete({
        role: 'generate',
        messages: [
          { role: 'system', content: SYSTEM_PREAMBLE + instruction },
          { role: 'user', content: `Bank key: ${key}\n\nExisting response variations:\n${samples.map((s, i) => `Sample ${i + 1}: ${s}`).join('\n')}\n\nGenerate 5 NEW variations (different from the existing ones):` },
        ],
        temperature: 1.2,
        maxTokens: 800,
        topP: 0.95,
      });
      const lines = text.split('\n').filter((l) => l.startsWith('- '));
      const candidates = lines.map((l) => l.slice(2).trim()).filter(replyIsClean);
      const unique = dedupeAgainst(candidates, [...seed, ...learned], dedupeStrip);
      for (const v of unique) {
        if (total >= TARGET) break;
        if (dry) { console.log(`[dry] would add: ${v}`); added++; total++; continue; }
        if (bank.addVariant(key, v, 'gapfill')) { added++; total++; console.log(`+ ${v}`); }
      }
    }
    console.log(`   done: +${added} (total ${total})`);
  }
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
