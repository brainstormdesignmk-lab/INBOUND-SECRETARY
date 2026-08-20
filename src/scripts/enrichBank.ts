#!/usr/bin/env tsx
/**
 * enrichBank — the midnight cron job that enriches the response bank.
 *
 * Runs at 24:00 via system cron (pm2/systemd). If the machine was off or cron
 * missed, it catches up tomorrow — the queue accumulates across days.
 *
 * Pipeline:
 *   1. Read pending records from enrichment_queue
 *   2. Group by state + event_type + user message similarity
 *   3. For groups with >=2 instances (frequent patterns):
 *      a. Check if bank already has variants for this key
 *      b. Generate 3-5 new variants using Gemini
 *      c. Validate against required/banned tokens
 *      d. Deduplicate against existing variants
 *      e. Append to responses.ts
 *   4. Mark processed records as enriched
 *   5. Purge old enriched records (>30 days)
 *   6. Log all additions to enrichment-log.json
 *
 * Usage:
 *   npm run enrich:run          — process all pending
 *   npm run enrich:run -- --dry — preview without writing
 *   npm run enrich:status       — show queue stats
 */

import * as fs from 'fs';
import * as path from 'path';
import { loadConfig } from '../config';
import { Db } from '../store/db';
import { EnrichmentStore } from '../store/enrichment';
import { createLlm } from '../llm/factory';
import { Classifier } from '../llm/classify';

// --- Types ---

interface GroupedPattern {
  state: string;
  eventType: string;
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
  keys: string[];
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

/** Group records by state + eventType + message similarity. */
function groupRecords(records: Array<{ state: string; eventType: string; userMsg: string; replyText: string }>): GroupedPattern[] {
  const groups: GroupedPattern[] = [];

  for (const rec of records) {
    let matched = false;
    for (const g of groups) {
      if (g.state === rec.state && g.eventType === rec.eventType) {
        // Check if this message is similar to existing messages in the group
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
        state: rec.state,
        eventType: rec.eventType,
        sampleMsgs: [rec.userMsg],
        sampleReplies: [rec.replyText],
        count: 1,
      });
    }
  }

  return groups;
}

/** Map FSM state + event to a bank key. */
function stateToBankKey(state: string, eventType: string): string | null {
  // Direct mappings for common patterns
  const map: Record<string, string> = {
    'discovery:DETAILS_PROVIDED': 'discovery.intro.house.business', // generic
    'discovery:SEARCH_REQUESTED': 'presentation.open',
    'presentation:STAY': 'fallback.presentation',
    'presentation:REJECTED': 'exhausted.plain',
    'closing:STAY': 'fallback.presentation',
    'property_query:STAY': 'fallback.presentation',
    'intent:INTENT_DECLARED': 'greeting',
    'idle:STAY': 'greeting',
  };
  return map[`${state}:${eventType}`] ?? null;
}

/** Load the current bank file and parse it. */
function loadBank(): Record<string, string[]> {
  try {
    const content = fs.readFileSync(path.join(process.cwd(), 'src/data/responses.ts'), 'utf-8');
    // Extract the RESPONSE_BANK object
    const match = content.match(/export const RESPONSE_BANK\s*:\s*Record<string,\s*string\[\]>\s*=\s*(\{[\s\S]*?\n\});/);
    if (!match) return {};
    // Parse with eval (safe — controlled file)
    const bank = (new Function(`return ${match[1]}`))() as Record<string, string[]>;
    return bank;
  } catch {
    return {};
  }
}

/** Deduplicate: remove variants too similar to existing ones. */
function deduplicate(newVariants: string[], existing: string[]): string[] {
  return newVariants.filter(v => {
    const vLow = v.toLowerCase();
    // Exact match
    if (existing.some(e => e.toLowerCase() === vLow)) return false;
    // High similarity (>0.7 = too close)
    if (existing.some(e => similarity(e, v) > 0.7)) return false;
    return true;
  });
}

/** Validate a variant against required/banned tokens. */
function validateVariant(variant: string, required: string[], banned: string[]): boolean {
  for (const r of required) {
    if (!variant.toLowerCase().includes(r.toLowerCase())) return false;
  }
  for (const b of banned) {
    if (variant.toLowerCase().includes(b.toLowerCase())) return false;
  }
  return true;
}

// --- Main ---

async function enrich(): Promise<void> {
  const dryRun = process.argv.includes('--dry');
  const cfg = loadConfig();
  const db = new Db(cfg.dbPath);
  const enrichment = new EnrichmentStore(db);
  const llm = createLlm(cfg);
  const classifier = new Classifier(llm, cfg);

  const log: EnrichmentLog = {
    timestamp: new Date().toISOString(),
    processed: 0,
    groups: 0,
    generated: 0,
    accepted: 0,
    keys: [],
    errors: [],
  };

  console.log(`[enrich] starting${dryRun ? ' (DRY RUN)' : ''} — ${enrichment.pendingCount()} pending records`);

  // 1. Read pending records
  const records = enrichment.listPending();
  if (records.length === 0) {
    console.log('[enrich] no pending records — nothing to do');
    db.close();
    return;
  }
  console.log(`[enrich] processing ${records.length} records`);

  // 2. Group by pattern
  const groups = groupRecords(records);
  const freqGroups = groups.filter(g => g.count >= 2);
  console.log(`[enrich] ${groups.length} total groups, ${freqGroups.length} with >=2 instances`);

  // 3. Load existing bank
  const bank = dryRun ? {} : loadBank();

  // 4. Process each frequent group
  for (const group of freqGroups) {
    log.groups++;
    const bankKey = stateToBankKey(group.state, group.eventType);
    if (!bankKey) {
      console.log(`[enrich] skipping group (${group.state}/${group.eventType}) — no bank key mapping`);
      continue;
    }

    const existing = bank[bankKey] ?? [];
    if (existing.length >= 15) {
      console.log(`[enrich] skipping ${bankKey} — already has ${existing.length} variants (max 15)`);
      continue;
    }

    console.log(`[enrich] generating for ${bankKey} (${group.count} instances, ${existing.length} existing)`);

    // Build a generation prompt from the sample messages/replies
    const samples = group.sampleReplies.slice(0, 3).map((r, i) => `Sample ${i + 1}: ${r}`).join('\n');
    const msgs = group.sampleMsgs.slice(0, 3).map((m, i) => `User ${i + 1}: ${m}`).join('\n');

    try {
      const genRes = await llm.complete({
        role: 'generate',
        messages: [
          {
            role: 'system',
            content: `You are a Macedonian text generator for a real-estate assistant. Generate 5 VARIATIONS of the same response, each on a new line prefixed with "- ". Each must be natural Macedonian, professional but warm. Vary the phrasing significantly — different sentence structures, different word choices. Keep the same meaning and tone. Do NOT include numbering, markdown, or any prefix other than "- ".`,
          },
          {
            role: 'user',
            content: `Bank key: ${bankKey}\n\nUser messages that trigger this response:\n${msgs}\n\nExisting response variations:\n${samples}\n\nGenerate 5 NEW variations (different from the existing ones):`,
          },
        ],
        temperature: 1.2,
        maxTokens: 800,
        topP: 0.95,
      });

      // Parse the generated variants
      const lines = genRes.split('\n').filter(l => l.startsWith('- '));
      const newVariants = lines.map(l => l.slice(2).trim()).filter(v => v.length > 10);

      // Deduplicate
      const unique = deduplicate(newVariants, existing);

      // Append to bank
      if (unique.length > 0 && !dryRun) {
        bank[bankKey] = [...existing, ...unique];
        log.generated += newVariants.length;
        log.accepted += unique.length;
        log.keys.push(bankKey);
        console.log(`[enrich] ${bankKey}: +${unique.length} new variants (${existing.length} → ${bank[bankKey].length})`);
      } else if (unique.length > 0) {
        log.generated += newVariants.length;
        log.accepted += unique.length;
        console.log(`[enrich] ${bankKey}: ${unique.length} new variants (DRY RUN)`);
      } else {
        console.log(`[enrich] ${bankKey}: 0 new unique variants (all duplicates)`);
      }
    } catch (e) {
      const err = `generation failed for ${bankKey}: ${(e as Error).message}`;
      console.error(`[enrich] ${err}`);
      log.errors.push(err);
    }
  }

  // 5. Mark records as enriched
  if (!dryRun) {
    const ids = records.map(r => r.id);
    enrichment.markEnriched(ids);
    console.log(`[enrich] marked ${ids.length} records as enriched`);
  }

  // 6. Write updated bank (only if we added variants)
  if (!dryRun && log.accepted > 0) {
    try {
      // Read the full file and replace the RESPONSE_BANK object
      const filePath = path.join(process.cwd(), 'src/data/responses.ts');
      const content = fs.readFileSync(filePath, 'utf-8');

      // Build the new bank string
      const bankEntries = Object.entries(bank)
        .map(([key, variants]) => {
          const escaped = variants.map(v => `    '${v.replace(/'/g, "\\'")}'`).join(',\n');
          return `  '${key}': [\n${escaped},\n  ]`;
        })
        .join(',\n');

      const newContent = content.replace(
        /export const RESPONSE_BANK\s*:\s*Record<string,\s*string\[\]>\s*=\s*\{[\s\S]*?\n\};/,
        `export const RESPONSE_BANK: Record<string, string[]> = {\n${bankEntries},\n};`,
      );

      fs.writeFileSync(filePath, newContent, 'utf-8');
      console.log(`[enrich] bank updated: ${filePath}`);
    } catch (e) {
      console.error(`[enrich] bank write failed: ${(e as Error).message}`);
      log.errors.push(`bank write: ${(e as Error).message}`);
    }
  }

  // 7. Purge old enriched records
  if (!dryRun) {
    const purged = enrichment.purgeOld(30);
    if (purged > 0) console.log(`[enrich] purged ${purged} old enriched records`);
  }

  // 8. Write log
  if (!dryRun) {
    const logPath = path.join(process.cwd(), 'data/enrichment-log.json');
    const logs: EnrichmentLog[] = [];
    try {
      logs.push(...JSON.parse(fs.readFileSync(logPath, 'utf-8')));
    } catch { /* first run */ }
    logs.push(log);
    // Keep last 90 days of logs
    while (logs.length > 90) logs.shift();
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, JSON.stringify(logs, null, 2), 'utf-8');
  }

  log.processed = records.length;
  console.log(`[enrich] done: ${log.processed} processed, ${log.groups} groups, ${log.accepted} variants accepted, ${log.errors.length} errors`);

  db.close();
}

// --- CLI ---

if (process.argv.includes('--status')) {
  const cfg = loadConfig();
  const db = new Db(cfg.dbPath);
  const enrichment = new EnrichmentStore(db);
  console.log(`[enrich] pending: ${enrichment.pendingCount()}`);
  db.close();
} else {
  enrich().catch(e => {
    console.error('[enrich] fatal:', e);
    process.exit(1);
  });
}
