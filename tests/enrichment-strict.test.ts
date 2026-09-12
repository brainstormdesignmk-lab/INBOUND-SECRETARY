// The 2026-09-12 enrichment-garbage incident, pinned permanently.
//
// What happened: a one-off gap-fill ran while every Gemini key was
// 429-exhausted. HybridClient degraded to its Groq fallback, whose weaker
// Macedonian produced visibly broken variants — "ќе се договорам со
// сопственикот за ЛОШО МЕСТО" (wrong meaning), "контаминани", "талаш во
// секјата" (gibberish), fused-script tokens ("сеRETURNам", "ponudi") —
// and 16 of them entered the bank before a human read them. All were purged.
//
// Two permanent guards come out of it:
//   1. replyIsClean rejects MIXED-SCRIPT TOKENS (a word fusing Latin and
//      Cyrillic letters) — structurally broken output that previously sailed
//      through the 30%-Cyrillic language guard.
//   2. Enrichment runs on createLlmStrict — Gemini-only, NEVER the fallback
//      brain. Exhausted keys fail the run; the queue re-runs it later.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
import { replyIsClean } from '../src/llm/enrichQuality';
import { loadConfig } from '../src/config';

// ── 1. The mixed-script token guard ──────────────────────────────────────────

test('replyIsClean rejects the fused-script garbage that entered the bank on 2026-09-12', () => {
  // Actual shapes from the purge:
  assert.equal(replyIsClean('Ќе Ви сеRETURNам со потврда утре во ова време, додека да помине денот.'), false, 'Cyrillic+Latin fused token');
  assert.equal(replyIsClean('Можеме да разгледаме и други PONUDI во овој дел од градот, ако сакате веднаш.'), false, 'ALL-CAPS Latin token inside Cyrillic line');
  // KNOWN LIMITATION (deliberate, documented): a single MIXED-CASE Latin word
  // inside a Cyrillic line ("нешто друго за Pregled") is structurally
  // IDENTICAL to legitimate brand names ("Hotel Tourist", "TTK Banka",
  // "Beverly Hills") — no regex can separate them without a brand
  // whitelist that would rot. That class is prevented AT SOURCE instead:
  // createLlmStrict keeps enrichment on Gemini, which does not emit these;
  // the groq fallback that did is no longer reachable from any enrichment
  // path (pinned by the source-level test below).
});

test('replyIsClean still accepts legitimate Cyrillic prose with a rare Latin proper noun', () => {
  // Latin PROPER NOUNS are fine — "TTK Banka" is how the brand is written.
  const ok = 'Гранката на TTK Banka се наоѓа на два минути пеш од зградата, веднаш до влезот.';
  assert.equal(replyIsClean(ok), true, 'Latin proper noun inside a clean token must pass');
});

// ── 2. The strict-generator contract ─────────────────────────────────────────

test('createLlmStrict throws when no Gemini key is configured (enrichment must never degrade)', () => {
  // Imported lazily so the env manipulation below is observed correctly.
  const { createLlmStrict } = require('../src/llm/factory') as typeof import('../src/llm/factory');
  const cfg = loadConfig();
  const saved = [cfg.geminiApiKey, cfg.geminiApiKey2, cfg.geminiApiKey3];
  // Simulate a machine with zero Gemini keys.
  (cfg as unknown as Record<string, unknown>).geminiApiKey = undefined;
  (cfg as unknown as Record<string, unknown>).geminiApiKey2 = undefined;
  (cfg as unknown as Record<string, unknown>).geminiApiKey3 = undefined;
  try {
    assert.throws(() => createLlmStrict(cfg), /enrichment requires the generator-grade model/);
  } finally {
    [cfg.geminiApiKey, cfg.geminiApiKey2, cfg.geminiApiKey3] = saved;
  }
});

test('every enrichment entry point uses the strict generator (source-level pin)', () => {
  // The cron and every gap-fill must build their LLM via createLlmStrict —
  // never via createLlm (whose HybridClient degrades to Groq).
  const sources = [
    { file: 'src/scripts/enrichBank.ts', must: 'createLlmStrict(cfg)' },
    { file: 'scripts/gapfill-location-unknown.ts', must: 'createLlmStrict(cfg)' },
  ];
  for (const { file, must } of sources) {
    const src = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.ok(src.includes(must), `${file} must call ${must}`);
    assert.ok(!/\bcreateLlm\(cfg\)/.test(src), `${file} must never call the degrading createLlm`);
  }
});
