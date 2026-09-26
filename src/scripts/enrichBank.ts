#!/usr/bin/env tsx
/**
 * enrichBank — the midnight cron: the bank's digestive system.
 *
 * Runs daily (cron). Catches up automatically — the queue accumulates if the
 * machine was off. All learned content goes to the SQLITE BANK LAYER
 * (bank_variants / bank_examples via BankStore) — LIVE immediately, no
 * rebuild, no restart. responses.ts stays the untouched SEED layer; only
 * `npm run responses:generate` (human-driven) regenerates the seed.
 *
 * Pipeline:
 *   1. Read pending records from enrichment_queue
 *   2. QUALITY GATE: keep only records whose answer WORKED (no client
 *      re-ask of the same question within 10 min on the same chat).
 *      Failed answers → bank_corrections, never the bank.
 *   3. Group by bankKey (records carry it) or state+event (LLM replies).
 *   4. Known key + frequent group  → generate 5 variants → bank_variants.
 *   5. UNKNOWN group (LLM answered a novel question) → NEW bank key
 *      `learn.<slug>` is created from the Q→A pair: the reply becomes the
 *      first variant, the user messages become retrieval examples. This is
 *      how the bank grows UPWARD (new knowledge), not just sideways.
 *   6. Every generated variant passes guardText-style validation before
 *      storage — the bank cannot store what the guard would reject.
 *   7. Mark processed, purge old, write log.
 *
 * Modes:
 *   npm run enrich:run              — process all pending
 *   npm run enrich:run -- --dry     — preview without writing
 *   npm run enrich:run -- --gapfill — one pass generating variants for the
 *                                     known keys that are missing/thin
 *   npm run enrich:status           — queue + bank stats
 */

import '../compat/node16';

import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../config';
import { Db } from '../store/db';
import { EnrichmentStore } from '../store/enrichment';
import { BankStore, FROZEN_BANK_KEYS, DATA_DRIVEN_KEYS, MAX_VARIANTS_PER_KEY, isExcludedFromEnrichment } from '../store/bank';
import { createLlmStrict } from '../llm/factory';
import { RESPONSE_BANK } from '../data/responses';
import { renderPromptBlock, validateBatch } from '../llm/bankConstraints';

// --- Types ---

interface GroupedPattern {
  state: string;
  eventType: string;
  bankKey: string | null;          // from the record, if set
  sampleMsgs: string[];
  sampleReplies: string[];
  count: number;
}

interface EnrichmentLog {
  timestamp: string;
  processed: number;
  groups: number;
  generated: number;
  accepted: number;
  newKeys: string[];
  enrichedKeys: string[];
  corrections: number;
  errors: string[];
}

// --- Helpers ---

/** Simple string similarity (Jaccard on character 3-grams). */
function similarity(a: string, b: string): number {
  const trigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3));
    return set;
  };
  const ta = trigrams(a.toLowerCase());
  const tb = trigrams(b.toLowerCase());
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/** Group records by state + eventType + message similarity.
 *  Records that carry an explicit bankKey are grouped BY that key (ignoring
 *  state/eventType) — the preferred path since the handler sets bankKey on
 *  every bank-backed deterministic reply. Records without a bankKey (pure
 *  LLM replies) fall back to grouping by state + eventType. */
function groupRecords(records: Array<{ state: string; eventType: string; bankKey: string | null; userMsg: string; replyText: string }>): GroupedPattern[] {
  const groups: GroupedPattern[] = [];

  for (const rec of records) {
    let matched = false;

    // Records with an explicit bankKey group by that key.
    if (rec.bankKey) {
      const keyGroup = groups.find(g => g.bankKey === rec.bankKey);
      if (keyGroup) {
        const isSimilar = keyGroup.sampleMsgs.some(m => similarity(m, rec.userMsg) > 0.4);
        if (isSimilar) {
          keyGroup.count++;
          keyGroup.sampleMsgs.push(rec.userMsg);
          keyGroup.sampleReplies.push(rec.replyText);
          matched = true;
        }
      } else {
        groups.push({
          state: rec.state, eventType: rec.eventType, bankKey: rec.bankKey,
          sampleMsgs: [rec.userMsg], sampleReplies: [rec.replyText], count: 1,
        });
        matched = true;
      }
    }

    if (matched) continue;

    // No bankKey — fall back to state + eventType grouping (LLM replies).
    for (const g of groups) {
      if (g.bankKey === null && g.state === rec.state && g.eventType === rec.eventType) {
        const isSimilar = g.sampleMsgs.some(m => similarity(m, rec.userMsg) > 0.4);
        if (isSimilar) {
          g.count++;
          g.sampleMsgs.push(rec.userMsg);
          g.sampleReplies.push(rec.replyText);
          matched = true;
          break;
        }
      }
    }
    if (!matched) {
      groups.push({
        state: rec.state, eventType: rec.eventType, bankKey: rec.bankKey,
        sampleMsgs: [rec.userMsg], sampleReplies: [rec.replyText], count: 1,
      });
    }
  }

  return groups;
}

/**
 * QUALITY GATES — outcome check (answerWorked) and reply hygiene (replyIsClean)
 * now live in src/llm/enrichQuality.ts, shared with targeted one-off gap-fill
 * scripts so every bank write passes the same rules. Imported here; the
 * re-export keeps the historical module surface.
 */
import { answerWorked, replyIsClean } from '../llm/enrichQuality';
export { answerWorked, replyIsClean };

function deduplicate(newVariants: string[], existing: string[]): string[] {
  return newVariants.filter(v => {
    const vLow = v.toLowerCase();
    if (existing.some(e => e.toLowerCase() === vLow)) return false;
    if (existing.some(e => similarity(e, v) > 0.7)) return false;
    return true;
  });
}

/** slug for a learned key from the sample user messages. */
function learnKeySlug(msgs: string[]): string {
  const stop = new Set(['dali', 'ili', 'za', 'na', 'vo', 'od', 'do', 'kako', 'sto', 'shto', 'kade', 'moze', 'mozam', 'imas', 'imate', 'li']);
  const words = msgs.join(' ')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(w => w.length > 2 && !stop.has(w));
  const slug = words.slice(0, 3).join('-').replace(/\s+/g, '-') || 'misc';
  return `learn.${slug}`;
}

// --- Main ---

async function enrich(): Promise<void> {
  const dryRun = process.argv.includes('--dry');
  const gapFill = process.argv.includes('--gapfill');
  const cfg = loadConfig();
  const db = new Db(cfg.dbPath);
  const enrichment = new EnrichmentStore(db);
  const bank = new BankStore(db);
  // STRICT: the midnight cron enriches the BANK — a degraded backend's weak
  // Macedonian must never be banked (Groq-garbage purge, 2026-09-12). When
  // the Gemini keys are exhausted, the run fails and the queue catch-up
  // re-runs it later. Quality > convenience.
  const llm = createLlmStrict(cfg);

  const log: EnrichmentLog = {
    timestamp: new Date().toISOString(),
    processed: 0,
    groups: 0,
    generated: 0,
    accepted: 0,
    newKeys: [],
    enrichedKeys: [],
    corrections: 0,
    errors: [],
  };

  // ---- POISON SWEEP (the [09:25] transcript): learned prose that names an
  // Евидентен број is a location-confirm TEMPLATE about one property — the
  // deterministic layer builds those live from the property row, and a stored
  // copy serves the WRONG EB verbatim when a later message trigram-matches
  // its example ("dogovori mi" → "Станот со Евидентен број 69…"). Retire
  // every violating learned variant + its retrieval examples at startup,
  // BEFORE any new banking — the cron self-heals the bank every night.
  if (!dryRun) {
    let quarantined = 0;
    for (const key of bank.learnedKeys()) {
      for (const v of bank.variantsWithLifecycle(key)) {
        if (v.lifecycle === 'active' && !replyIsClean(v.text)) {
          bank.retireVariant(v.id, 'EB-template/poison sweep (replyIsClean)');
          quarantined++;
        }
      }
    }
    const badExamples = bank.purgeExamplesIf((msg) =>
      /Евидентен\s+број/i.test(msg)
      || /\b(?:стан|stan|куќ|kukj|имот|imot)[а-яa-z]{0,3}\s+(?:со|so|број|broj)\s*\d/iu.test(msg));
    if (quarantined > 0 || badExamples > 0) {
      console.log(`[enrich] poison sweep: ${quarantined} variant(s) retired, ${badExamples} example(s) purged`);
    }
  }

  // ---- GAPFILL MODE: fill known keys that are missing or thin ----
  if (gapFill) {
    console.log('[enrich] GAPFILL — generating variants for missing/thin keys');
    const thin: Array<[string, number]> = [];
    for (const [key, vars] of Object.entries(RESPONSE_BANK)) {
      if (isExcludedFromEnrichment(key)) continue;
      const existing = [...vars, ...bank.variants(key)];
      if (existing.length < 5) thin.push([key, existing.length]);
    }
    console.log(`[enrich] ${thin.length} keys below 5 variants`);
    for (const [key, n] of thin) {
      try {
        const samples = RESPONSE_BANK[key].slice(0, 3);
        const genRes = await llm.complete({
          role: 'generate',
          messages: [
            { role: 'system', content: 'You are a Macedonian text generator for a real-estate assistant. Generate 5 VARIATIONS of the same response, each on a new line prefixed with "- ". Each must be natural Macedonian, professional but warm. Vary the phrasing significantly. Keep the same meaning and tone. Do NOT include numbering, markdown, or any prefix other than "- ".\n\n' + renderPromptBlock(key) },
            { role: 'user', content: `Bank key: ${key}\n\nExisting response variations:\n${samples.map((s, i) => `Sample ${i + 1}: ${s}`).join('\n')}\n\nGenerate 5 NEW variations (different from the existing ones):` },
          ],
          temperature: 1.2,
          maxTokens: 800,
          topP: 0.95,
        });
        const lines = genRes.split('\n').filter(l => l.startsWith('- '));
        // P1: constraint gate — a candidate that violates the key's contract
        // is rejected before storage (and the rejection is logged, so the
        // cron's own mistakes are visible instead of silently banked).
        const passed = validateBatch(key, lines.map(l => l.slice(2).trim()).filter(replyIsClean));
        for (const r of passed.rejected) console.log(`[enrich] ${key}: REJECTED — ${r.reasons.join('; ')}`);
        const candidates = passed.kept;
        const unique = deduplicate(candidates, RESPONSE_BANK[key]);
        let added = 0;
        for (const v of unique) {
          if (bank.addVariant(key, v, 'gapfill')) added++;
          if (RESPONSE_BANK[key].length + bank.variants(key).length - n >= 5) break;
        }
        log.generated += lines.length;
        log.accepted += added;
        if (added > 0) log.enrichedKeys.push(key);
        console.log(`[enrich] ${key}: +${added}`);
      } catch (e) {
        const err = `gapfill failed for ${key}: ${(e as Error).message}`;
        console.error(`[enrich] ${err}`);
        log.errors.push(err);
      }
    }
    if (!dryRun) writeLog(log);
    console.log(`[enrich] gapfill done: ${log.accepted} variants added, ${log.errors.length} errors`);
    db.close();
    return;
  }

  // ---- NORMAL MODE: process the pending queue ----
  console.log(`[enrich] starting${dryRun ? ' (DRY RUN)' : ''} — ${enrichment.pendingCount()} pending records`);

  // 1. Read pending records. EXCLUDED: dynamic-fallback serves (replySource
  // 'dynamic'/'dynamic-recall') — the nightly digest in loop-a owns those;
  // here they would double-learn the same answer as learn.* prose.
  const records = enrichment.listPending().filter(r => r.replySource !== 'dynamic' && r.replySource !== 'dynamic-recall');
  if (records.length === 0) {
    console.log('[enrich] no pending records — nothing to do');
    db.close();
    return;
  }
  console.log(`[enrich] processing ${records.length} records`);

  // 2. QUALITY GATE — split worked vs failed answers
  const good = records.filter(r => answerWorked(r, records));
  const failed = records.filter(r => !good.includes(r));
  if (!dryRun) {
    for (const f of failed) {
      bank.correction(f.bankKey, f.userMsg, f.replyText, 'client-re-asked-within-10min');
    }
    log.corrections = failed.length;
  }
  console.log(`[enrich] quality gate: ${good.length} worked, ${failed.length} failed (→ corrections)`);

  // 3. Group by pattern
  const groups = groupRecords(good.map(r => ({
    state: r.state, eventType: r.eventType, bankKey: r.bankKey,
    userMsg: r.userMsg, replyText: r.replyText,
  })));
  console.log(`[enrich] ${groups.length} groups`);

  // 4/5. Known keys → variants; UNKNOWN groups → NEW learned keys
  for (const group of groups) {
    log.groups++;
    const knownKey = group.bankKey ?? null;

    if (knownKey && RESPONSE_BANK[knownKey]) {
      // ---- EXISTING KEY: add variants (sideways growth) ----
      if (FROZEN_BANK_KEYS.has(knownKey)) {
        console.log(`[enrich] skipping ${knownKey} — FROZEN (funnel invariant)`);
        continue;
      }
      if (DATA_DRIVEN_KEYS.has(knownKey)) {
        console.log(`[enrich] skipping ${knownKey} — DATA-DRIVEN (facts live in the property row, not prose)`);
        continue;
      }
      const existing = [...RESPONSE_BANK[knownKey], ...bank.variants(knownKey)];
      if (existing.length >= MAX_VARIANTS_PER_KEY) {
        console.log(`[enrich] skipping ${knownKey} — ${existing.length} variants (max)`);
        continue;
      }
      // Require ≥2 instances for variant generation (frequent pattern).
      if (group.count < 2) continue;

      const added = await generateVariants(llm, knownKey, group, existing, dryRun, log);
      if (!dryRun) {
        for (const v of added) bank.addVariant(knownKey, v, 'learned');
        for (const m of group.sampleMsgs) bank.addExample(knownKey, m);
      }
      if (added.length > 0) log.enrichedKeys.push(knownKey);
    } else {
      // ---- UNKNOWN: LLM answered a novel question — create a NEW key ----
      // (upward growth). The reply becomes the first variant; the user
      // messages become retrieval examples so the NEXT client asking the
      // same thing gets served free by the retrieval layer.
      // EXCLUSION: groups whose source records carry a data-driven or frozen
      // bankKey are skipped entirely — price/availability/address answers are
      // property-row data, never bank prose (never learn.koja-cenata again).
      if (isExcludedFromEnrichment(group.bankKey)) {
        console.log(`[enrich] skipping group ${group.bankKey} — excluded from enrichment pool`);
        continue;
      }
      if (group.count < 1 || !group.sampleReplies[0]) continue;
      const newKey = learnKeySlug(group.sampleMsgs);
      // P1: learned keys inherit the BASELINE contract — a learned answer
      // containing promises or unsanctioned amounts never reaches the bank.
      const learnPassed = validateBatch(newKey, group.sampleReplies);
      if (learnPassed.rejected.length > 0) {
        const why = learnPassed.rejected[0].reasons.join('; ');
        console.log(`[enrich] rejected learn key ${newKey} — ${why}`);
        if (!dryRun) bank.correction(null, group.sampleMsgs[0], group.sampleReplies[0], `learn-violates-contract: ${why}`);
        continue;
      }
      if (!group.sampleReplies.every(replyIsClean)) {
        if (!dryRun) bank.correction(null, group.sampleMsgs[0], group.sampleReplies[0], 'reply-failed-hygiene');
        continue;
      }
      if (dryRun) {
        console.log(`[enrich] (DRY) would create new key ${newKey} (${group.count} instances)`);
        continue;
      }
      let first = true;
      for (const r of group.sampleReplies.slice(0, 3)) {
        if (bank.addVariant(newKey, r, first ? 'learned-origin' : 'learned')) first = false;
      }
      for (const m of group.sampleMsgs) bank.addExample(newKey, m);
      log.newKeys.push(newKey);
      console.log(`[enrich] NEW KEY ${newKey}: ${group.sampleReplies.length} variants, ${group.sampleMsgs.length} examples`);
    }
  }

  // 6. Mark records as enriched
  if (!dryRun) {
    enrichment.markEnriched(good.map(r => r.id));
    enrichment.markEnriched(failed.map(r => r.id));
    console.log(`[enrich] marked ${records.length} records as processed`);
  }

  // 7. Purge old enriched records
  if (!dryRun) {
    const purged = enrichment.purgeOld(30);
    if (purged > 0) console.log(`[enrich] purged ${purged} old enriched records`);
  }

  log.processed = records.length;
  if (!dryRun) writeLog(log);
  console.log(`[enrich] done: ${log.processed} processed, ${log.groups} groups, ${log.accepted} variants accepted, ${log.newKeys.length} new keys, ${log.corrections} corrections, ${log.errors.length} errors`);

  db.close();
}

/** Ask the LLM for 5 variants of the group's answer, validate + dedupe. */
async function generateVariants(llm: ReturnType<typeof createLlmStrict>, key: string, group: GroupedPattern, existing: string[], dryRun: boolean, log: EnrichmentLog): Promise<string[]> {
  console.log(`[enrich] generating for ${key} (${group.count} instances, ${existing.length} existing)`);
  const samples = group.sampleReplies.slice(0, 3).map((r, i) => `Sample ${i + 1}: ${r}`).join('\n');
  const msgs = group.sampleMsgs.slice(0, 3).map((m, i) => `User ${i + 1}: ${m}`).join('\n');
  try {
    const genRes = await llm.complete({
      role: 'generate',
      messages: [
        { role: 'system', content: 'You are a Macedonian text generator for a real-estate assistant. Generate 5 VARIATIONS of the same response, each on a new line prefixed with "- ". Each must be natural Macedonian, professional but warm. Vary the phrasing significantly — different sentence structures, different word choices. Keep the same meaning and tone. Do NOT include numbering, markdown, or any prefix other than "- ".\n\n' + renderPromptBlock(key) },
        { role: 'user', content: `Bank key: ${key}\n\nUser messages that trigger this response:\n${msgs}\n\nExisting response variations:\n${samples}\n\nGenerate 5 NEW variations (different from the existing ones):` },
      ],
      temperature: 1.2,
      maxTokens: 800,
      topP: 0.95,
    });
    const lines = genRes.split('\n').filter(l => l.startsWith('- '));
    // P1: constraint gate — same as gapfill path.
    const passed = validateBatch(key, lines.map(l => l.slice(2).trim()).filter(replyIsClean));
    for (const r of passed.rejected) console.log(`[enrich] ${key}: REJECTED — ${r.reasons.join('; ')}`);
    const candidates = passed.kept;
    const unique = deduplicate(candidates, existing);
    log.generated += lines.length;
    log.accepted += dryRun ? unique.length : unique.length;
    console.log(`[enrich] ${key}: ${unique.length} validated variants`);
    return unique;
  } catch (e) {
    const err = `generation failed for ${key}: ${(e as Error).message}`;
    console.error(`[enrich] ${err}`);
    log.errors.push(err);
    return [];
  }
}

function writeLog(log: EnrichmentLog): void {
  const logPath = path.join(process.cwd(), 'data/enrichment-log.json');
  const logs: EnrichmentLog[] = [];
  try {
    logs.push(...JSON.parse(fs.readFileSync(logPath, 'utf-8')));
  } catch { /* first run */ }
  logs.push(log);
  while (logs.length > 90) logs.shift();
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, JSON.stringify(logs, null, 2), 'utf-8');
}

// --- CLI ---

if (process.argv.includes('--status')) {
  const cfg = loadConfig();
  const db = new Db(cfg.dbPath);
  const enrichment = new EnrichmentStore(db);
  const bank = new BankStore(db);
  const s = bank.stats();
  console.log(`[enrich] pending: ${enrichment.pendingCount()}`);
  console.log(`[enrich] bank: ${s.totalVariants} learned variants across ${s.keys} keys, ${s.examples} examples, ${s.corrections} corrections, hit-rate ${s.hitRate === null ? 'n/a' : (s.hitRate * 100).toFixed(1) + '%'}`);
  db.close();
} else {
  enrich().catch(e => {
    console.error('[enrich] fatal:', e);
    process.exit(1);
  });
}
