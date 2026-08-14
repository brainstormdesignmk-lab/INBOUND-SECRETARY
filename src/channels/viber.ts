import type { Express } from 'express';
import { AppConfig } from '../config';
import { TokenBucket } from '../antiabuse/rateLimiter';
import { Channel } from './types';
import { LINA_AVATAR_URL } from '../data/landlords';
import type { InboundHandler } from '../handlers/inbound';

interface ViberPayload {
  event: string;
  timestamp?: number;
  message_token?: number;
  sender?: { id: string; name?: string };
  user?: { id: string; name?: string };
  message?: { type?: string; text?: string };
}

interface QueueItem {
  chatId: string;
  text: string;
  resolve: () => void;
  reject: (e: Error) => void;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class ViberAdapter implements Channel {
  readonly name = 'viber';
  private bucket: TokenBucket;
  private queue: QueueItem[] = [];
  private pumping = false;
  private seen = new Map<number, number>();
  private api = 'https://chatapi.viber.com/pa/send_message';

  constructor(private cfg: AppConfig, private pipeline: InboundHandler) {
    this.bucket = new TokenBucket(9, 9); // Viber: <=9 requests/sec per client
  }

  registerWebhook(app: Express): void {
    app.get('/health', (_req, res) => {
      res.status(200).json({ status: 0, ok: true });
    });

    app.post('/viber/webhook', (req, res) => {
      // Ack immediately, then process async — never let Viber see a slow response.
      res.status(200).json({ status: 0 });
      const body = req.body as ViberPayload;
      void this.dispatch(body).catch(e => console.error('[viber] dispatch error:', (e as Error).message));
    });
  }

  private async dispatch(body: ViberPayload): Promise<void> {
    switch (body.event) {
      case 'webhook':
      case 'delivered':
      case 'seen':
      case 'failed':
      case 'subscribed':
        return; // informational — ack already sent
      case 'unsubscribed':
        return;
      case 'conversation_started': {
        // User opened the chat / pressed start: send the welcome greeting (user-initiated).
        if (!body.user?.id) return;
        await this.pipeline.startConversation('viber', body.user.id, body.user.name);
        return;
      }
      case 'message': {
        const token = body.message_token ?? 0;
        if (token) {
          if (this.isDuplicate(token)) return; // Viber may redeliver — dedupe
          this.markSeen(token);
        }
        const senderId = body.sender?.id;
        if (!senderId) return;
        const kind = body.message?.type === 'text' ? 'text' : 'other';
        const text = body.message?.text?.trim() ?? '';
        await this.pipeline.handle('viber', senderId, text, { kind, senderName: body.sender?.name });
        return;
      }
      default:
        return;
    }
  }

  private isDuplicate(token: number): boolean {
    const now = Date.now();
    for (const [t, exp] of this.seen) if (exp < now) this.seen.delete(t);
    return this.seen.has(token);
  }

  private markSeen(token: number): void {
    this.seen.set(token, Date.now() + 60_000);
    if (this.seen.size > 5000) {
      const now = Date.now();
      for (const [t, exp] of this.seen) if (exp < now) this.seen.delete(t);
      if (this.seen.size > 5000) this.seen.clear();
    }
  }

  send(chatId: string, text: string): Promise<void> {
    return new Promise((resolve, reject) => {
      this.queue.push({ chatId, text, resolve, reject });
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.queue.length) {
        const item = this.queue.shift()!;
        try {
          await this.bucket.take(1); // global <=9 req/s
          await sleep(rand(this.cfg.minDelayMs, this.cfg.maxDelayMs)); // human pacing
          await this.postWithRetry(item.chatId, item.text);
          item.resolve();
        } catch (e) {
          console.error('[viber] send failed:', (e as Error).message);
          item.resolve(); // never hang the pipeline on a channel error
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async postWithRetry(chatId: string, text: string): Promise<void> {
    const payload = {
      receiver: chatId,
      type: 'text',
      text,
      sender: {
        name: this.cfg.viberSenderName || 'Lina',
        avatar: this.cfg.viberSenderAvatar || LINA_AVATAR_URL,
      },
    };
    let backoff = 1000;
    for (let attempt = 1; attempt <= 4; attempt++) {
      try {
        const res = await fetch(this.api, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Viber-Auth-Token': this.cfg.viberToken,
          },
          body: JSON.stringify(payload),
        });
        if (res.status === 429) { // rate limit
          await sleep(backoff);
          backoff *= 2;
          continue;
        }
        const data = (await res.json().catch(() => ({}))) as { status?: number; status_message?: string };
        if (data.status !== 0) {
          if (data.status === 12) { // "Too many requests" (100/hr per chat)
            await sleep(backoff);
            backoff *= 2;
            continue;
          }
          throw new Error(`status ${data.status}: ${data.status_message ?? 'unknown'}`);
        }
        return;
      } catch (e) {
        if (attempt === 4) throw e;
        await sleep(backoff);
        backoff *= 2;
      }
    }
  }
}
