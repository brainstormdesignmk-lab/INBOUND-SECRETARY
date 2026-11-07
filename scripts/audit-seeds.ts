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
import { FIXED_SEEDS } from '../src/data/responseBank';
import { BankStore } from '../src/store/bank';
import { Db } from '../src/store/db';
import { loadConfig } from '../src/config';
import { violationsFor, constraintsFor } from '../src/llm/bankConstraints';
import { classifyOffensive } from '../src/antiabuse/offensive';

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
// THE HAND-WRITTEN POLICY SEEDS ARE BANK MATERIAL TOO. FIXED_SEEDS holds the
// frozen copy a model must never author (persona, money clarification, owner
// availability ack…) and pickVariant serves it exactly like the generated
// layer. Sweeping only RESPONSE_BANK left that half outside the P1 contracts
// and the P5 offensive sweep — a hand-written line could carry an unsanctioned
// amount or trip a lexicon stem and the audit would still print ✓.
const fixedKeys = Object.keys(FIXED_SEEDS);
const fixedBad = auditSet(k => FIXED_SEEDS[k] ?? [], fixedKeys, 'SEED/fixed');
const learnedKeys = bank.learnedKeys().filter(k => k.startsWith('learn.'));
const learnedBad = auditSet(k => bank.variants(k), learnedKeys, 'LEARNED');

/**
 * P5 — THE OFFENSIVE-FALSE-POSITIVE SWEEP.
 *
 * classifyOffensive runs on every INBOUND message before routing, and a hit
 * spends a strike and serves the professional-tone warning. The bank's SEED
 * variants are also inputs of that scan whenever they are fed back through the
 * TUI/bank tooling, and the lexicon's own stems are what the client's words are
 * matched against — so any variant the lexicon flags is proof that a stem is
 * over-broad. Two live bugs came out of exactly this sweep: 'fakj' firing on
 * "прифаќам" (prifakjam) and 'erot' firing on "менаџерот" (menadzerot).
 * Runs over the seeds AND every learned variant the cron grew.
 */
function auditOffensive(variants: string[], label: string): number {
  let bad = 0;
  for (const v of variants) {
    const d = classifyOffensive(v);
    if (!d.isOffensive) continue;
    bad++;
    if (bad <= 5) console.log(`\n✗ [${label}] offensive-lexicon false positive (${d.reason}): ${v.slice(0, 110)}…`);
  }
  return bad;
}

const seedOffensive = auditOffensive(
  Object.values(RESPONSE_BANK).flat().filter((v): v is string => typeof v === 'string'),
  'SEED',
);
const fixedOffensive = auditOffensive(Object.values(FIXED_SEEDS).flat(), 'SEED/fixed');
const learnedOffensive = auditOffensive(
  learnedKeys.flatMap(k => bank.variants(k)),
  'LEARNED',
);

const contractBad = seedBad + fixedBad + learnedBad;
const offensiveBad = seedOffensive + fixedOffensive + learnedOffensive;

if (json) {
  // JSON consumers want silence on stdout — re-run compactly.
  const compact = {
    seedViolations: seedBad,
    fixedSeedViolations: fixedBad,
    learnedViolations: learnedBad,
    offensiveFalsePositives: offensiveBad,
    learnedKeysChecked: learnedKeys.length,
  };
  console.error(JSON.stringify(compact));
  process.exit(contractBad + offensiveBad > 0 ? 1 : 0);
}

const total = Object.values(RESPONSE_BANK).reduce((a, v) => a + v.length, 0)
  + Object.values(FIXED_SEEDS).reduce((a, v) => a + v.length, 0);
console.log(`\n${offensiveBad === 0 ? '✓' : '✗'} offensive sweep: ${offensiveBad} lexicon false positives across ${total} seed variants (the classifier must never strike on the agency's own copy)`);
console.log(`${contractBad + offensiveBad === 0 ? '✓' : '✗'} seed audit: ${contractBad} contract violations · ${offensiveBad} offensive false positives, across ${Object.keys(RESPONSE_BANK).length + fixedKeys.length} seed keys / ${total} seed variants, ${learnedKeys.length} learned keys`);
process.exit(contractBad + offensiveBad > 0 ? 1 : 0);
