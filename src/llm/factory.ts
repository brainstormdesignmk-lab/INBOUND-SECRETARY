import { AppConfig } from '../config';
import { LlmClient } from './types';
import { GroqClient } from './groqClient';
import { GeminiClient } from './geminiClient';
import { HybridClient } from './hybridClient';
import { RotatingClient } from './rotatingClient';

/**
 * Builds the LLM client from config:
 * - 'hybrid' (default) → Gemini primary (round-robin across GEMINI_API_KEY,
 *   GEMINI_API_KEY_2 and GEMINI_API_KEY_3 — each project key has its own quota),
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
  const pool: LlmClient[] = [];
  if (cfg.geminiApiKey) {
    pool.push(new GeminiClient(cfg.geminiApiKey, cfg.geminiModel, cfg.geminiModelClassify, undefined, 'gemini:1'));
  }
  if (cfg.geminiApiKey2) {
    pool.push(new GeminiClient(cfg.geminiApiKey2, cfg.geminiModel, cfg.geminiModelClassify, undefined, 'gemini:2'));
  }
  if (cfg.geminiApiKey3) {
    pool.push(new GeminiClient(cfg.geminiApiKey3, cfg.geminiModel, cfg.geminiModelClassify, undefined, 'gemini:3'));
  }
  if (pool.length === 0) {
    throw new Error('[llm-strict] no GEMINI_API_KEY set — enrichment requires the generator-grade model and must never run on a fallback backend');
  }
  return pool.length > 1 ? new RotatingClient(pool) : pool[0]!;
}

export function createLlm(cfg: AppConfig): LlmClient {
  const groq = new GroqClient(cfg.groqApiKey, cfg.groqModel, cfg.groqModelClassify, 'groq');

  // Each Gemini key is labeled 'gemini:N' so the TUI can show WHICH key served
  // every reply (each project key has its own quota — useful for measuring).
  const pool: LlmClient[] = [];
  if (cfg.geminiApiKey) {
    pool.push(new GeminiClient(cfg.geminiApiKey, cfg.geminiModel, cfg.geminiModelClassify, undefined, 'gemini:1'));
  }
  if (cfg.geminiApiKey2) {
    pool.push(new GeminiClient(cfg.geminiApiKey2, cfg.geminiModel, cfg.geminiModelClassify, undefined, 'gemini:2'));
  }
  if (cfg.geminiApiKey3) {
    pool.push(new GeminiClient(cfg.geminiApiKey3, cfg.geminiModel, cfg.geminiModelClassify, undefined, 'gemini:3'));
  }
  const primary = pool.length > 1 ? new RotatingClient(pool) : (pool[0] ?? null);

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
