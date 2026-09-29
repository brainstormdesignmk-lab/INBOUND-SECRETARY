import '../compat/node16';

import type { AppConfig } from '../config';
import { Channel } from './types';

// relayOutbound.ts — reply lane through the ATOM4 relay's outbound queue.
//
// Selected only when VIBER_OUTBOUND_MODE=relay. The default ViberAdapter
// (Bot API, chatapi.viber.com) stays untouched and remains the fallback.
//
//   send(chatId, text) -> POST http://RELAY_URL/outbound
//     headers: X-Relay-Token: <RELAY_TOKEN_LINA>
//     body:    { client: "viber1", botId: <LINA_ID>, to: chatId, text }
//
// The relay spools the reply into the per-client queue (viber1); the phone's
// bridge claims it and delivers through the REAL Viber app, then acks. The
// per-instance VIBER_CLIENT env var (viber1|viber2|viber3) selects the queue —
// it names which phone/account serves this Lina instance.
//
// WHY THIS LANE EXISTS (the 2026-09-29 outage): the atom's ~/.lina/lina.env
// deliberately holds NO Viber credential — the bot token lives with the phone
// bridge (relay client viber1), and the machine may have no outbound internet
// route to chatapi.viber.com at all. The lane was an untracked experiment
// (only its dist/ artifact survived) and was silently lost with a rebuild:
// inbound kept flowing (relay -> /message -> pipeline -> sessions), but every
// reply died in ViberAdapter.postWithRetry with "VIBER_TOKEN" empty. Errors
// are swallowed by design ("never hang the pipeline"), so the outage was
// invisible. The lane is now SOURCE — a rebuild can never lose it again.

export class RelayOutboundChannel implements Channel {
  readonly name = 'viber';
  private baseUrl: string;
  private token: string;
  private client: string;
  private botId: string;

  constructor(cfg: AppConfig) {
    this.baseUrl = (process.env.RELAY_URL || 'http://192.168.1.14:8400').replace(/\/+$/, '');
    this.token = cfg.relayToken || '';
    this.client = (process.env.VIBER_CLIENT || 'viber1').toLowerCase();
    this.botId = cfg.linaId || 'LINA-1';
    if (!this.token) {
      console.error('[relay-outbound] RELAY_TOKEN_LINA is empty — replies will be rejected by the relay');
    }
  }

  send(chatId: string, text: string, _source?: string): Promise<void> {
    const body = JSON.stringify({
      client: this.client,
      botId: this.botId,
      to: String(chatId),
      text: String(text),
    });
    return new Promise<void>((resolve) => {
      let u: URL;
      try {
        u = new URL(this.baseUrl + '/outbound');
      } catch {
        console.error(`[relay-outbound] bad RELAY_URL "${this.baseUrl}" — reply dropped`);
        resolve();
        return;
      }
      const req = require('http').request({
        hostname: u.hostname,
        port: u.port || 80,
        path: u.pathname,
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(body),
          'x-relay-token': this.token,
        },
        timeout: 8000,
      }, (res: { statusCode?: number; resume: () => void }) => {
        res.resume();
        if (res.statusCode === 202 || res.statusCode === 200) {
          resolve();
        } else {
          console.error(`[relay-outbound] /outbound HTTP ${res.statusCode} for ${chatId}`);
          resolve(); // never hang the pipeline on a channel error
        }
      });
      req.on('timeout', () => req.destroy(new Error('relay /outbound timeout')));
      req.on('error', (e: Error) => {
        console.error('[relay-outbound] error:', e.message);
        resolve();
      });
      req.end(body);
    });
  }
}
