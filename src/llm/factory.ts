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
