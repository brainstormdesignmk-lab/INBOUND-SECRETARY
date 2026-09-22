#!/usr/bin/env tsx
/**
 * harden-triggers — the trigger-side hardening pass.
 *
 * FOR EVERY TRANSCRIPT FIX: the code fix covers the phrases we thought of.
 * The client population says it differently — tone, typos, vocabulary.
 * This script asks Gemini for the population, then SIMULATES each phrase
 * through the REAL detectors and classifies:
 *
 *   COVERED — target detector fires (and no forbidden competitor) → corpus
 *   GAP     — target detector silent → today the bug REPRODUCES
 *   CROSS   — target fires but a competing detector also fires / would win
 *             the routing → misroute risk, needs an exclusion or order fix
 *
 * Output: data/hardening/<pass>.json + a printed gap table.
 * REPORT ONLY — it never patches source or banks. Patching is a separate,
 * human-approved step.
 *
 * Usage:
 *   npx tsx scripts/harden-triggers.ts                 # all passes
 *   npx tsx scripts/harden-triggers.ts --pass fee      # one pass
 *   npx tsx scripts/harden-triggers.ts --batches 3     # more phrase batches
 */

import '../src/compat/node16';
import * as fs from 'fs';
import { loadConfig } from '../src/config';
import { createLlmStrict } from '../src/llm/factory';
import {
  detectPropertyInterest, detectPriceFreshness, detectPriceAsk, detectBedrooms,
  detectInvestmentOpinion, detectCheaperSearch, detectFeeComplaint, detectFeeWhy, detectNegotiate,
  detectFeeSurprise, detectBudget, detectService, detectBothServices, detectRemark,
  detectAgreement, detectAvailabilityAsk, detectVisitInterest, detectWhereIs,
  detectFeePaymentAgreement,
} from '../src/llm/deterministic';

interface PassSpec {
  id: string;
  bug: string;              // the transcript bug this protects
  seedLine: string;         // the exact client line from the transcript
  genPrompt: string;        // what Gemini should produce
  batches: number;          // generation calls (varied temperature/angle per batch)
  /** The routing contract: this must hold for the phrase to route correctly. */
  target: (t: string) => boolean;
  /** Competitors that, if they fire too, risk stealing the routing. */
  crossFire: Record<string, (t: string) => boolean>;
  /** Competitors that MAY co-fire — the guards already handle them. */
  benignCross?: Record<string, (t: string) => boolean>;
}

/** The five fixes from this session — the bug classes worth a family. */
const PASSES: PassSpec[] = [
  {
    id: 'interest-bind',
    bug: '00:09 — interest in a NAMED shown property re-fired the search engine instead of binding EB 76',
    seedLine: 'GARSONJERAVA KAJ CRNOGORSKA AMBASADA MI E INTERESNA',
    batches: 2,
    genPrompt: `A client is shown specific properties in a chat and reacts with INTEREST in one of them (a property is on the table). The phrase states interest/liking in the property: "mi e interesna", "mi se svigja", "go sakam toj stan", "toj mi e interesen"... Vary: verbs, adjectives, tone (polite/colloquial/excited), Latin and Cyrillic scripts, common typos. 2-8 words. ONE intent per line: expressing interest in the property discussed. NOT a question, NOT availability, NOT a visit request, NOT a price question.`,
    target: t => detectPropertyInterest(t),
    crossFire: {
      priceAsk: detectPriceAsk, freshness: detectPriceFreshness, budget: detectBudget,
      service: detectService, remark: detectRemark, availability: detectAvailabilityAsk,
      visit: detectVisitInterest, whereIs: detectWhereIs,
    },
  },
  {
    id: 'price-freshness',
    bug: '08:50 — "is this price still current?" got a flat re-quote instead of the owner-relay disclaimer',
    seedLine: 'a dali mu e uste taa cena ?',
    batches: 2,
    genPrompt: `A client was ALREADY told a property's price in the chat and now asks whether that price is STILL VALID / current / unchanged, or whether it may have changed (the price on the ad/website). Vary: "uste taa cena?", "vazi li?", "nepromeneta?", "istata li e?", "dali ima izmeni?", "taa od oglasot?" — Latin and Cyrillic, typos, colloquial tone, 2-10 words, one line each. It must be about the CURRENCY of a known price, NOT a first-time "how much does it cost".`,
    target: t => detectPriceFreshness(t),
    crossFire: { budget: detectBudget, service: detectService, remark: detectRemark },
    benignCross: { priceAsk: detectPriceAsk, agreement: detectAgreement },
  },
  {
    id: 'bare-bedrooms',
    bug: '13:44 — the bare answer "EDNA" to the bedrooms question was swallowed twice, funnel looped',
    seedLine: 'EDNA',
    batches: 2,
    genPrompt: `The assistant asked the client "Колку спални соби би биле идеални?" (how many bedrooms). The client answers with JUST the number word, no noun. Generate variants of the answer "one bedroom" (една/edna/1) and "two bedrooms" (две/dve/2): different number words, typos like "edn", "dvie", "ednaa", stray punctuation, maybe with a filler word like "edm milos", "edna bazno". 1-4 words. Do NOT include the word stan/garsonjera/spalna/cena, no other numbers.`,
    target: t => detectBedrooms(t) !== undefined,
    crossFire: { budget: detectBudget, service: detectService, freshness: detectPriceFreshness },
  },
  {
    id: 'investment-verb',
    bug: '09:41 — "MNOGU SE POSKAPEA STANOVIVE" fell through the market-opinion detector into the fee pitch',
    seedLine: 'MNOGU SE POSKAPEA STANOVIVE',
    batches: 2,
    genPrompt: `A client COMPLAINS that real-estate prices have become very expensive (a general market complaint, past tense). Vary the verb and vocabulary: "poskapea", "skoknaa", "udrija", "pominua site granici", "stanovi se preskapi sega"... Include typos ("poskapeja", "poskapie", "skoknae"), both scripts, exclamations ("boze", "lele"), 2-9 words, one line each. NOT a request for cheaper options (no "najdi/prikazi poevtino"), NOT a budget statement with a number limit.`,
    target: t => detectInvestmentOpinion(t),
    crossFire: { budget: detectBudget, service: detectService, cheaper: detectCheaperSearch, freshness: detectPriceFreshness },
    benignCross: { feeComplaint: detectFeeComplaint },
  },
  {
    id: 'fee-counter',
    bug: '10:18 — the fee counter-offer ("1 EVRO E SIMBOLICNA CENA ?") got the PROPERTY price quote',
    seedLine: '10 EVRA NE E BAS SIMBOLICNA CENA . 1 EVRO E SIMBOLICNA CENA ?',
    batches: 2,
    genPrompt: `The client disputes the small viewing fee the assistant just proposed (500 denari / 10 evra), calling it NOT symbolic, too much for what it is, joking it buys coffee instead. Vary: "ne e simbolichna", "skapo e za poseta", "za tie pari si kupuvam...", "1 evro togash?", "mnogu e za edna poseta"... Typos ("simvolichna", "evrata", "den"), both scripts, sarcasm and politeness mixed, 2-12 words, one line each. It must reference the fee/visit/amount — NOT the property's price, NOT a negotiation of the property price.`,
    target: t => detectFeeComplaint(t),
    crossFire: { freshness: detectPriceFreshness, feeWhy: detectFeeWhy, surprise: detectFeeSurprise },
    benignCross: { priceAsk: detectPriceAsk, budget: detectBudget, service: detectService },
  },
  {
    id: 'fee-payment',
    bug: 'no corpus for detectFeePaymentAgreement — the "vo red, ke platam" gate that unblocks visit scheduling had zero regression coverage',
    seedLine: 'DOBRO KE PLATAM',
    batches: 2,
    genPrompt: `The assistant already disclosed the small viewing fee (500 denari / 10 evra) and the client AGREES to pay it, moving the deal forward. Variants: "vo red ke platam", "dobre ke ja platam", "ok ke platam 500 denari", "soglasen sum so nadomestokot", "dogovoreno", "nema problem, ke platam", "se slozhuvam za posetata". Typos ("platam"->"platemm", "vo red"->"vo red"), both scripts, 1-9 words, one line each. It must be CONSENT to pay the fee — NOT a question about the fee (no zosto/kolku/zashto), NOT a complaint it is expensive, NOT about the property's price, NOT a scheduling request with a time.`,
    target: t => detectFeePaymentAgreement(t),
    crossFire: {
      feeWhy: detectFeeWhy, feeComplaint: detectFeeComplaint,
      invest: detectInvestmentOpinion, negotiate: detectNegotiate,
    },
    benignCross: {
      agreement: detectAgreement, priceAsk: detectPriceAsk,
      budget: detectBudget, service: detectService, visit: detectVisitInterest,
      freshness: detectPriceFreshness,
    },
  },
  {
    id: 'counter-offer',
    bug: "08:20 — 'dali moze za 150 e' fired nothing and got the closing fee disclosure instead of the owner-fixes-price answer",
    seedLine: 'dali moze za 150 e',
    batches: 2,
    genPrompt: `The client was just told a property's price and pushes back with a LOWER counter-offer. Vary: "dali moze za 150 e", "moze li na 150 evra", "ke dadam 500 evra", "150000 moze?", "bi platil 130000", "mozam li da dadam 120000", "500 den togash?"... Numbers can be 2-6 digits, with or without currency suffix (e/evra/evr/den/denari/eur). Both scripts, typos ("moza", "platam"->"platemm"), casual tone, 2-9 words, one line each. It must be an OFFER of a specific amount for the property — NOT a budget search (no do/pod/okolu before the amount), NOT a question about the fee (no 500 denari/deset evra viewing-fee consent or refusal), NOT a criteria request (no spalni/sobi/m2 after the amount), NOT asking the price.`,
    target: t => detectNegotiate(t),
    crossFire: {
      feeWhy: detectFeeWhy, feeComplaint: detectFeeComplaint, freshness: detectPriceFreshness,
      agreement: detectAgreement, invest: detectInvestmentOpinion,
    },
    benignCross: {
      feePay: detectFeePaymentAgreement, budget: detectBudget,
      service: detectService, priceAsk: detectPriceAsk,
    },
  },
];

interface Row {
  phrase: string;
  verdict: 'COVERED' | 'GAP' | 'CROSS';
  target: boolean;
  cross: string[];
  benign: string[];
}

async function generateBatch(llm: ReturnType<typeof createLlmStrict>, spec: PassSpec, i: number): Promise<string[]> {
  const r = await llm.complete({
    role: 'generate',
    messages: [
      { role: 'system', content: 'You generate realistic Macedonian client chat lines for a real-estate assistant. Output ONLY lines, each prefixed "- ". No numbering, no explanations. Real clients make typos, mix scripts, are brief.' },
      { role: 'user', content: `${spec.genPrompt}\n\nExample of the intent (do NOT copy it): ${spec.seedLine}\n\nGenerate 15 distinct lines${i > 0 ? `, variation angle #${i + 1} (different vocabulary than typical)` : ''}:` },
    ],
    temperature: 1.0 + i * 0.15,
    maxTokens: 600,
    topP: 0.95,
  });
  return r.split('\n').map(l => l.trim()).filter(l => l.startsWith('- ')).map(l => l.slice(2).trim()).filter(l => l.length > 1);
}

async function runPass(llm: ReturnType<typeof createLlmStrict>, spec: PassSpec, batchCount: number): Promise<Row[]> {
  // CUMULATIVE corpora: previous phrases are re-classified with the CURRENT
  // detectors; the new batch adds on top (mirrors sweep-keys.runFamily).
  const existing = loadCorpus(spec.id);
  const phrases = new Set<string>([spec.seedLine, ...existing.map(r => r.phrase)]);
  for (let i = 0; i < batchCount; i++) {
    try {
      for (const p of await generateBatch(llm, spec, i)) phrases.add(p);
    } catch (e) {
      console.error(`  [${spec.id}] batch ${i} failed: ${(e as Error).message}`);
    }
  }
  const rows: Row[] = [];
  for (const phrase of phrases) {
    const target = spec.target(phrase);
    const cross = Object.entries(spec.crossFire).filter(([, fn]) => fn(phrase)).map(([k]) => k);
    const benign = Object.entries(spec.benignCross ?? {}).filter(([, fn]) => fn(phrase)).map(([k]) => k);
    // The transcript seed itself is always included as a sanity anchor.
    const isSeed = phrase === spec.seedLine;
    let verdict: Row['verdict'];
    if (target && cross.length === 0) verdict = 'COVERED';
    else if (target && cross.length > 0) verdict = 'CROSS';
    else verdict = isSeed ? 'COVERED' : 'GAP'; // seed covered by definition (we fixed it)
    rows.push({ phrase, verdict, target, cross, benign });
  }
  return rows;
}

function loadCorpus(id: string): Row[] {
  const file = `data/hardening/${id}.json`;
  if (!fs.existsSync(file)) return [];
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as { rows?: Row[] };
    return Array.isArray(saved.rows) ? saved.rows : [];
  } catch { return []; }
}

/** REPLAY: re-classify a saved corpus against the CURRENT detectors and
 *  print the before/after delta — no Gemini calls. The measurement half of
 *  the hardening loop. */
function replay(only?: string): void {
  const passIds = only ? PASSES.filter(p => p.id.includes(only)).map(p => p.id) : PASSES.map(p => p.id);
  for (const id of passIds) {
    const file = `data/hardening/${id}.json`;
    if (!fs.existsSync(file)) { console.log(`[replay] ${id}: no saved corpus — run the live sweep first`); continue; }
    const spec = PASSES.find(p => p.id === id)!;
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as { rows: Row[] };
    const rows: Row[] = saved.rows.map(r => {
      const target = spec.target(r.phrase);
      const cross = Object.entries(spec.crossFire).filter(([, fn]) => fn(r.phrase)).map(([k]) => k);
      const benign = Object.entries(spec.benignCross ?? {}).filter(([, fn]) => fn(r.phrase)).map(([k]) => k);
      const isSeed = r.phrase === spec.seedLine;
      let verdict: Row['verdict'];
      if (target && cross.length === 0) verdict = 'COVERED';
      else if (target && cross.length > 0) verdict = 'CROSS';
      else verdict = isSeed ? 'COVERED' : 'GAP';
      return { phrase: r.phrase, verdict, target, cross, benign };
    });
    const covered = rows.filter(r => r.verdict === 'COVERED').length;
    const gap = rows.filter(r => r.verdict === 'GAP');
    const cross = rows.filter(r => r.verdict === 'CROSS').length;
    const wasCovered = saved.rows.filter(r => r.verdict === 'COVERED').length;
    const wasGap = saved.rows.filter(r => r.verdict === 'GAP').length;
    const fixed = saved.rows.filter(r => r.verdict === 'GAP' && rows.find(n => n.phrase === r.phrase)?.verdict !== 'GAP');
    console.log(`[replay] ${id}: COVERED ${wasCovered}→${covered}, GAP ${wasGap}→${gap.length}, CROSS ${saved.rows.filter(r => r.verdict === 'CROSS').length}→${cross}`);
    for (const f of fixed) console.log(`    FIXED  "${f.phrase}"`);
    for (const g of gap.slice(0, 10)) console.log(`    STILL-GAP "${g.phrase}"`);
    // Corpora are the fixed regression asset — persist only with --save
    // (otherwise a post-patch emit would see 'no GAPs' and gut the corpora).
    if (process.argv.includes('--save')) fs.writeFileSync(file, JSON.stringify({ bug: spec.bug, rows }, null, 2));
  }
}

async function main() {
  const cfg = loadConfig();
  const replayArg = process.argv.includes('--replay');
  const passArg = process.argv.indexOf('--pass');
  const only = passArg > -1 ? process.argv[passArg + 1] : undefined;
  const bArg = process.argv.indexOf('--batches');
  const batchCount = bArg > -1 ? parseInt(process.argv[bArg + 1], 10) : 2;
  if (replayArg) { replay(only); return; }
  const llm = createLlmStrict(cfg);

  fs.mkdirSync('data/hardening', { recursive: true });
  const report: Array<{ id: string; bug: string; total: number; covered: number; gap: number; cross: number; rows: Row[] }> = [];

  for (const spec of PASSES) {
    if (only && !spec.id.includes(only)) continue;
    process.stdout.write(`[harden] ${spec.id} — generating…\n`);
    const rows = await runPass(llm, spec, batchCount);
    const covered = rows.filter(r => r.verdict === 'COVERED').length;
    const gap = rows.filter(r => r.verdict === 'GAP');
    const cross = rows.filter(r => r.verdict === 'CROSS');
    report.push({ id: spec.id, bug: spec.bug, total: rows.length, covered, gap: gap.length, cross: cross.length, rows });
    fs.writeFileSync(`data/hardening/${spec.id}.json`, JSON.stringify({ bug: spec.bug, rows }, null, 2));
    console.log(`[harden] ${spec.id}: ${rows.length} phrases — COVERED ${covered}, GAP ${gap.length}, CROSS ${cross.length}`);
    for (const g of gap.slice(0, 12)) console.log(`    GAP  "${g.phrase}"`);
    for (const c of cross.slice(0, 6)) console.log(`    CROSS "${c.phrase}" → ${c.cross.join(',')}`);
  }

  fs.writeFileSync('data/hardening/gap-report.json', JSON.stringify(report.map(({ rows, ...r }) => r), null, 2));
  console.log('\n[harden] full corpora in data/hardening/*.json — REPORT ONLY, nothing patched');
}

main().catch(e => { console.error('[harden] fatal:', e); process.exit(1); });
