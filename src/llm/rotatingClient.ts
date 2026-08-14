import { CompleteOpts, LlmClient } from './types';

/**
 * Round-robins requests across several clients — e.g. Gemini API keys from
 * different Google Cloud projects, each of which has its own independent quota.
 * On failure of the selected backend it fails over to the next; if ALL backends
 * fail it throws, so an outer HybridClient can fall back to another provider.
 */
export class RotatingClient implements LlmClient {
  private idx = 0;
  /** Per-backend success counts (1-based index) — handy for verifying rotation. */
  readonly stats: number[];

  constructor(private clients: LlmClient[]) {
    this.stats = new Array(clients.length).fill(0);
  }

  async complete(o: CompleteOpts): Promise<string> {
    if (this.clients.length === 0) throw new Error('rotating client has no backends');
    const blocked = (c: LlmClient): boolean => (c as { quotaBlocked?: boolean }).quotaBlocked === true;
    const start = this.idx;
    let lastErr: unknown;
    // Pass 1: healthy backends only — skip keys on a 429 quota cooldown so an
    // exhausted key costs ZERO attempts (no wasted rejected requests, no latency).
    for (let i = 0; i < this.clients.length; i++) {
      const pos = (start + i) % this.clients.length;
      if (blocked(this.clients[pos])) continue;
      this.idx = (pos + 1) % this.clients.length; // next request starts on the next backend
      try {
        const text = await this.clients[pos].complete(o);
        this.stats[pos]++;
        return text;
      } catch (e) {
        lastErr = e;
        console.error(`[rotate] backend #${pos + 1} failed — trying next:`, (e as Error).message);
      }
    }
    // Pass 2: ALL backends are on cooldown — probe them anyway (one request
    // each; the 429 refreshes the cooldown) so failover to the fallback is honest.
    for (let i = 0; i < this.clients.length; i++) {
      const pos = (start + i) % this.clients.length;
      if (!blocked(this.clients[pos])) continue;
      this.idx = (pos + 1) % this.clients.length;
      try {
        const text = await this.clients[pos].complete(o);
        this.stats[pos]++;
        return text;
      } catch (e) {
        lastErr = e;
        console.error(`[rotate] backend #${pos + 1} (quota) failed — trying next:`, (e as Error).message);
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error('all rotating backends failed');
  }
}
