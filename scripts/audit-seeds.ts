#!/usr/bin/env tsx
/**
 * audit-seeds — run the P1 constraint contracts over the HUMAN SEED bank.
 *
 * The contracts were cut to fit the seeds (audited 2026-09-22, before the
 * numbers were frozen). This script keeps that true over time: when the seed
 * layer is regenerated (npm run responses:generate) or hand-edited, run this
 * to catch drift the moment it happens. Also runs the baseline (promise /
 * superlative / amount-veto) rules over EVERY learned learn.* key the cron
 * grew — a violation there means the stored variant predates P1 and should
 * be retired.
 *
 *   npm run bank:audit-seeds           — report, exit 1 on violation
 *   npm run bank:audit-seeds -- --json — machine-readable (for cron wiring)
 */

import '../src/compat/node16';

import { RESPONSE_BANK } from '../src/data/responses';
import { BankStore } from '../src/store/bank';
import { Db } from '../src/store/db';
import { loadConfig } from '../src/config';
import { violationsFor, constraintsFor } from '../src/llm/bankConstraints';

const json = process.argv.includes('--json');

function auditSet(getVariants: (key: string) => string[], keys: string[], label: string): number {
  let bad = 0;
  for (const key of keys) {
    const variants = getVariants(key);
    if (variants.length === 0) continue;
    const hit: Array<{ idx: number; reasons: string[] }> = [];
    variants.forEach((v, i) => {
      const reasons = violationsFor(v, key);
      if (reasons.length > 0) hit.push({ idx: i, reasons });
    });
    if (hit.length === 0) continue;
    bad += hit.length;
    const c = constraintsFor(key);
    console.log(`\n✗ [${label}] ${key} (${hit.length}/${variants.length} variants) — contract: ${c.note}`);
    for (const v of hit.slice(0, 5)) {
      console.log(`   #${v.idx}: ${v.reasons.join('; ')}`);
      console.log(`      ${variants[v.idx].slice(0, 110)}…`);
    }
  }
  return bad;
}

const bank = new BankStore(new Db(loadConfig().dbPath));

const seedBad = auditSet(
  k => (RESPONSE_BANK as Record<string, string[]>)[k] ?? [],
  Object.keys(RESPONSE_BANK),
  'SEED',
);
const learnedKeys = bank.learnedKeys().filter(k => k.startsWith('learn.'));
const learnedBad = auditSet(k => bank.variants(k), learnedKeys, 'LEARNED');

if (json) {
  // JSON consumers want silence on stdout — re-run compactly.
  const compact = {
    seedViolations: seedBad,
    learnedViolations: learnedBad,
    learnedKeysChecked: learnedKeys.length,
  };
  console.error(JSON.stringify(compact));
  process.exit(seedBad + learnedBad > 0 ? 1 : 0);
}

const total = Object.values(RESPONSE_BANK).reduce((a, v) => a + v.length, 0);
console.log(`\n${seedBad + learnedBad === 0 ? '✓' : '✗'} seed audit: ${seedBad + learnedBad} violations across ${Object.keys(RESPONSE_BANK).length} seed keys / ${total} seed variants, ${learnedKeys.length} learned keys`);
process.exit(seedBad + learnedBad > 0 ? 1 : 0);
