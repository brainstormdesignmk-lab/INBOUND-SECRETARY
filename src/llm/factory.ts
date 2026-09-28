import { AppConfig } from '../config';
import { LlmClient } from './types';
import { GroqClient } from './groqClient';
import { GeminiClient } from './geminiClient';
import { HybridClient } from './hybridClient';
import { RotatingClient } from './rotatingClient';

/**
 * Builds the LLM client from config:
 * - 'hybrid' (default) → Gemini primary (round-robin across the WHOLE
 *   cfg.geminiKeyPool — GEMINI_API_KEY, GEMINI_API_KEY_2, GEMINI_API_KEY_3,
 *   plus any GEMINI_API_KEY_4..N; each project key has its own quota),
 *   Groq fallback
 * - 'gemini'           → Gemini only (Groq only if no Gemini key is set)
 * - 'groq'             → Groq only
 */
/**
 * STRICT generator client — for BANK ENRICHMENT ONLY (gap-fills, the midnight
 * cron). Unlike createLlm, it NEVER falls back to a weaker brain: when the
 * Gemini keys are 429-exhausted it fails the run instead of degrading to
 * Groq, whose weaker Macedonian produced banked garbage ("лошо место",
 * "контаминани", fused "сеRETURNам" tokens) that passed the structural
 * gates and had to be purged by hand. Enrichment quality > enrichment
 * convenience: the queue catch-up semantics mean the cron simply re-runs
 * tomorrow — no bad line ever enters the bank.
 */
export function createLlmStrict(cfg: AppConfig): LlmClient {
  // strict=true either THROWS (empty pool) or returns a client — never null.
  return buildGeminiPool(cfg, true)!;
}

export function createLlm(cfg: AppConfig): LlmClient {
  const groq = new GroqClient(cfg.groqApiKey, cfg.groqModel, cfg.groqModelClassify, 'groq');

  // Each Gemini key is labeled 'gemini:N' (its position in the pool) so the
  // TUI can show WHICH key served every reply — each project key has its own
  // quota, and with the open-ended pool the label now scales to pool size.
  const primary = buildGeminiPool(cfg, false, groq);

  switch (cfg.llmProvider) {
    case 'gemini':
      if (primary) return primary;
      console.warn('[llm] LLM_PROVIDER=gemini but no GEMINI_API_KEY set — falling back to Groq');
      return groq;
    case 'groq':
      return groq;
    case 'hybrid':
    default:
      if (primary && cfg.groqApiKey) return new HybridClient(primary, groq);
      if (primary) {
        console.warn('[llm] hybrid: GROQ_API_KEY missing — Gemini only (no fallback)');
        return primary;
      }
      console.warn('[llm] hybrid: no GEMINI_API_KEY — Groq only (no Gemini)');
      return groq;
  }
}

/** Builds the Gemini round-robin pool from cfg.geminiKeyPool.
 *  - strict=true: pool empty → THROW (enrichment must never degrade — the
 *    2026-09-12 contract, pinned by tests/enrichment-strict.test.ts).
 *  - strict=false: pool empty → return the Groq fallback (or null when the
 *    caller prefers to decide — mode 'hybrid' warns explicitly). */
function buildGeminiPool(cfg: AppConfig, strict: boolean, fallbackIfEmpty?: LlmClient): LlmClient | null {
  const pool: LlmClient[] = cfg.geminiKeyPool.map((key, i) =>
    new GeminiClient(key, cfg.geminiModel, cfg.geminiModelClassify, undefined, `gemini:${i + 1}`),
  );
  if (pool.length === 0) {
    if (strict) {
      throw new Error('[llm-strict] no GEMINI_API_KEY set — enrichment requires the generator-grade model and must never run on a fallback backend');
    }
    return fallbackIfEmpty ?? null;
  }
  return pool.length > 1 ? new RotatingClient(pool) : pool[0]!;
}
