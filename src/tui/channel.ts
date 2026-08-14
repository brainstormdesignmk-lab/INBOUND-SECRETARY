import { AppConfig } from '../config';
import { TokenBucket } from '../antiabuse/rateLimiter';
import { Channel } from '../channels/types';

const rand = (a: number, b: number) => a + Math.random() * (b - a);

export interface TypingInfo {
  chatId: string;
  until: number;
}

// Registers as channel "viber" so the pipeline is byte-for-byte identical to
// the production adapter — only the delivery medium differs (screen vs API).
export class TuiChannel implements Channel {
  readonly name = 'viber';
  sends = 0;

  private bucket = new TokenBucket(9, 9); // same global 9 req/s rule as production
  private pending: { chatId: string; resolve: () => void; timer: NodeJS.Timeout; until: number } | null = null;

  onTyping?: (chatId: string, remainingMs: number) => void;
  onMessage?: (chatId: string, text: string) => void;

  constructor(private cfg: AppConfig) {}

  get typing(): TypingInfo | null {
    if (!this.pending) return null;
    return { chatId: this.pending.chatId, until: this.pending.until };
  }

  async send(chatId: string, text: string): Promise<void> {
    await this.bucket.take(1); // antiban: <=9 sends/sec even with parallel chats
    const delay = rand(this.cfg.minDelayMs, this.cfg.maxDelayMs);
    this.onTyping?.(chatId, delay);
    await new Promise<void>(resolve => {
      const until = Date.now() + delay;
      const timer = setTimeout(() => {
        if (this.pending?.timer === timer) this.pending = null;
        resolve();
      }, delay);
      this.pending = { chatId, resolve, timer, until };
    });
    this.onTyping?.(chatId, 0);
    this.sends += 1;
    this.onMessage?.(chatId, text);
  }

  bypass(): boolean {
    if (!this.pending) return false;
    clearTimeout(this.pending.timer);
    const r = this.pending.resolve;
    this.pending = null;
    r();
    return true;
  }
}
