// relay.ts — ATOM4 relay ingress for THIS Lina instance (one-pair slice).
//
// The relay (ATOM4) owns public webhook ingress and routes per-identity:
//   /webhook/viber/lina1 (ATOM4) -> POST /message (here) -> existing pipeline.
// LINA-1 answers 200 fast (mirrors the Viber webhook ack-then-process pattern:
// the relay's delivery times out at 5s while a persona turn can take longer),
// then hands the message to InboundHandler.handle('viber', ...) UNCHANGED.
//
// Replies are NOT sent here: InboundHandler.sendRaw already goes out through
// the EXISTING Viber sender (session.channel === 'viber'), directly from this
// machine. The relay never sends Viber messages and holds no Viber tokens.
//
// Auth: dedicated relay token (RELAY_TOKEN_LINA) via X-Relay-Token — never a
// Viber credential. Unconfigured token -> the endpoint 503s (same posture as
// the Hermes API), a wrong token -> 401. A payload addressed to a different
// LINA_ID is rejected 404 so a mis-routed relay can never feed this brain.

import '../compat/node16';

import type { Express, Request, Response } from 'express';
import { AppConfig } from '../config';
import type { InboundHandler } from '../handlers/inbound';

/** The subset of the relay contract envelope Lina actually consumes. */
interface RelayEnvelope {
  botId?: string;
  atomId?: string;
  channel?: string;
  numberId?: string;
  messageId?: string;
  from?: string;
  chatId?: string;
  senderId?: string;
  senderName?: string;
  text?: string;
  kind?: string;
  ts?: string;
}

export function registerRelayIngress(app: Express, cfg: AppConfig, pipeline: InboundHandler): void {
  if (!cfg.relayToken) {
    app.post('/message', (_req: Request, res: Response) => {
      res.status(503).json({ error: 'relay ingress disabled — set RELAY_TOKEN_LINA' });
    });
    console.log('[boot] relayIngress=DISABLED — set RELAY_TOKEN_LINA');
    return;
  }

  // Viber-style dedup on the platform message token, with a deterministic
  // fallback (the relay may redeliver while LINA-1 is restarting).
  const seen = new Map<string, number>();
  const isDuplicate = (key: string): boolean => {
    const now = Date.now();
    for (const [k, exp] of seen) if (exp < now) seen.delete(k);
    return seen.has(key);
  };
  const markSeen = (key: string): void => {
    seen.set(key, Date.now() + 60_000);
    if (seen.size > 5000) {
      const now = Date.now();
      for (const [k, exp] of seen) if (exp < now) seen.delete(k);
      if (seen.size > 5000) seen.clear();
    }
  };

  app.post('/message', (req: Request, res: Response) => {
    if (req.headers['x-relay-token'] !== cfg.relayToken) {
      res.status(401).json({ error: 'missing or invalid X-Relay-Token' });
      return;
    }
    const env = req.body as RelayEnvelope | undefined;
    if (!env || typeof env !== 'object') {
      res.status(422).json({ error: 'invalid envelope' });
      return;
    }
    if (env.botId && env.botId !== cfg.linaId) {
      res.status(404).json({ error: `wrong destination: ${env.botId}` });
      return;
    }
    // The slice routes Viber only; a mis-routed non-viber envelope must never
    // reach the brain (it would reply through the wrong channel adapter).
    if (env.channel && env.channel !== 'viber') {
      res.status(422).json({ error: `unsupported channel: ${env.channel}` });
      return;
    }
    const chatId = String(env.from ?? env.chatId ?? env.senderId ?? '');
    const text = typeof env.text === 'string' ? env.text : '';
    if (!chatId) {
      res.status(422).json({ error: 'envelope has no sender identity' });
      return;
    }
    const key = String(env.messageId ?? `${chatId}|${env.ts ?? ''}|${text}`);
    if (isDuplicate(key)) {
      res.status(200).json({ status: 'duplicate-ignored' });
      return;
    }
    markSeen(key);

    // Ack FIRST, process async — the relay's delivery timeout is 5s and a
    // persona turn can take longer; a slow 200 would make the relay retry.
    res.status(200).json({ status: 'accepted', botId: cfg.linaId });

    const kind = env.kind === 'other' ? 'other' : 'text';
    // CLIENT TYPING WINDOW (mirrors the TUI, user-approved): a customer who
    // sends a message + follow-up is saying ONE thing — Lina must answer ONCE
    // with the full context, not fire a reply per message (the first would
    // mis-read the conversation and the second would fight it). The window
    // RESETS on every follow-up so the customer can comfortably finish; the
    // queued burst then flushes as ONE combined turn through the pipeline.
    enqueueForChat(chatId, text, kind, env.senderName ?? '');
  });

  // ---- per-chat batching -----------------------------------------------
  const CLIENT_WINDOW_MS = Math.max(cfg.clientTypingDelayMs, 1_000);
  const WINDOW_HARD_CAP_MS = CLIENT_WINDOW_MS * 3; // a chatter can't stall forever
  interface PendingWindow {
    texts: string[];
    kinds: string[];
    senderName: string;
    timer: NodeJS.Timeout;
    firstAt: number;
  }
  const pending = new Map<string, PendingWindow>();

  function flushChat(chatId: string): void {
    const w = pending.get(chatId);
    if (!w) return;
    pending.delete(chatId);
    clearTimeout(w.timer);
    // Join the burst into ONE message — exactly the TUI flushClient() rule:
    // "ZDRAVO / MI TREBA STAN POD KIRIJA / DO 250 EVRA" is one intent.
    const combined = w.texts.join('\n');
    const kind = w.kinds.some(k => k !== 'text') ? 'other' : 'text';
    void pipeline
      .handle('viber', chatId, combined, { kind, senderName: w.senderName })
      .catch((e: Error) => console.error('[relay] dispatch error:', e.message));
  }

  function enqueueForChat(chatId: string, text: string, kind: string, senderName: string): void {
    const existing = pending.get(chatId);
    if (existing) {
      existing.texts.push(text);
      existing.kinds.push(kind);
      if (senderName) existing.senderName = senderName;
      // FOLLOW-UP RESETS the timer — the customer may comfortably send a
      // follow-up; but never past the hard cap (first message + 3 windows).
      clearTimeout(existing.timer);
      const remainingCap = existing.firstAt + WINDOW_HARD_CAP_MS - Date.now();
      const delay = Math.max(Math.min(CLIENT_WINDOW_MS, remainingCap), 0);
      existing.timer = setTimeout(() => flushChat(chatId), delay);
      return;
    }
    const timer = setTimeout(() => flushChat(chatId), CLIENT_WINDOW_MS);
    pending.set(chatId, { texts: [text], kinds: [kind], senderName, timer, firstAt: Date.now() });
  }

  console.log(`[boot] relayIngress=on (botId=${cfg.linaId}) — replies stay on the direct Viber path`);
}
