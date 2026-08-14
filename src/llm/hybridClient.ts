import { CompleteOpts, LlmClient } from './types';

/**
 * Gemini primary, Groq fallback. ANY failure from the primary (network, auth,
 * rate limit, empty completion) falls through to the fallback — a dead primary
 * must never silence the bot.
 */
export class HybridClient implements LlmClient {
  constructor(private primary: LlmClient, private fallback: LlmClient) {}

  async complete(o: CompleteOpts): Promise<string> {
    try {
      return await this.primary.complete(o);
    } catch (e) {
      console.error('[hybrid] primary LLM failed — falling back to Groq:', (e as Error).message);
      return this.fallback.complete(o);
    }
  }
}
