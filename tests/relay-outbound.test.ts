import { test } from 'node:test';
import assert from 'node:assert';
import * as http from 'http';
import { loadConfig } from '../src/config';
import { RelayOutboundChannel } from '../src/channels/relayOutbound';
import { ChannelRegistry } from '../src/channels/types';

// The 2026-09-29 outage contract: in relay mode EVERY reply must reach the
// relay's /outbound queue (client viber<N>) with the relay token — the phone
// bridge is the only thing that can actually deliver to Viber. The atom holds
// no Viber credential, so a silent direct-API fallback is the failure mode
// that killed the bot while inbound kept flowing.

interface Captured { body: any; token: string | undefined; }

async function withCaptureServer(fn: (url: string, captured: Captured[]) => Promise<void>): Promise<void> {
  const captured: Captured[] = [];
  const srv = http.createServer((req, res) => {
    let data = '';
    req.on('data', c => { data += c; });
    req.on('end', () => {
      captured.push({ body: JSON.parse(data), token: req.headers['x-relay-token'] as string | undefined });
      res.statusCode = 202;
      res.end('{"status":"queued"}');
    });
  });
  await new Promise<void>(r => srv.listen(0, '127.0.0.1', r));
  const addr = srv.address() as { port: number };
  try {
    await fn(`http://127.0.0.1:${addr.port}`, captured);
  } finally {
    await new Promise<void>(r => srv.close(() => r()));
  }
}

test('relay outbound: send() queues the reply on the relay /outbound lane with the relay token', async () => {
  await withCaptureServer(async (url, captured) => {
    const prev = {
      RELAY_URL: process.env.RELAY_URL,
      RELAY_TOKEN_LINA: process.env.RELAY_TOKEN_LINA,
      VIBER_CLIENT: process.env.VIBER_CLIENT,
      LINA_ID: process.env.LINA_ID,
    };
    process.env.RELAY_URL = url;
    process.env.RELAY_TOKEN_LINA = 'test-relay-token';
    process.env.VIBER_CLIENT = 'viber9';
    process.env.LINA_ID = 'LINA-1';
    try {
      const cfg = loadConfig();
      const ch = new RelayOutboundChannel(cfg);
      assert.equal(ch.name, 'viber', 'must register as the viber channel (drop-in)');

      await ch.send('V16K11', 'Здраво, како можам да Ви помогнам?');

      assert.equal(captured.length, 1, 'exactly one /outbound POST');
      assert.equal(captured[0].token, 'test-relay-token', 'X-Relay-Token header');
      assert.deepEqual(captured[0].body, {
        client: 'viber9',
        botId: 'LINA-1',
        to: 'V16K11',
        text: 'Здраво, како можам да Ви помогнам?',
      });
    } finally {
      process.env.RELAY_URL = prev.RELAY_URL;
      process.env.RELAY_TOKEN_LINA = prev.RELAY_TOKEN_LINA;
      process.env.VIBER_CLIENT = prev.VIBER_CLIENT;
      process.env.LINA_ID = prev.LINA_ID;
    }
  });
});

test('relay outbound: a relay failure never rejects — the pipeline must not hang', async () => {
  // RELAY_URL pointing at a dead port: send() resolves (with an error log),
  // because InboundHandler must never wedge on a channel outage.
  const prev = { RELAY_URL: process.env.RELAY_URL, RELAY_TOKEN_LINA: process.env.RELAY_TOKEN_LINA };
  process.env.RELAY_URL = 'http://127.0.0.1:1'; // nothing listens here
  process.env.RELAY_TOKEN_LINA = 'test-relay-token';
  try {
    const ch = new RelayOutboundChannel(loadConfig());
    await ch.send('V16K11', 'test'); // must resolve, not throw
  } finally {
    process.env.RELAY_URL = prev.RELAY_URL;
    process.env.RELAY_TOKEN_LINA = prev.RELAY_TOKEN_LINA;
  }
});

test('relay outbound: VIBER_OUTBOUND_MODE=relay selects the relay lane in config', () => {
  const prev = process.env.VIBER_OUTBOUND_MODE;
  process.env.VIBER_OUTBOUND_MODE = 'relay';
  try {
    assert.equal(loadConfig().viberOutboundMode, 'relay');
  } finally {
    if (prev === undefined) delete process.env.VIBER_OUTBOUND_MODE; else process.env.VIBER_OUTBOUND_MODE = prev;
  }
  // anything else (unset, 'direct', garbage) stays direct
  assert.equal(loadConfig().viberOutboundMode, 'direct');
  process.env.VIBER_OUTBOUND_MODE = 'direct';
  assert.equal(loadConfig().viberOutboundMode, 'direct');
  if (prev === undefined) delete process.env.VIBER_OUTBOUND_MODE; else process.env.VIBER_OUTBOUND_MODE = prev;
});

test('relay outbound: the registry drops in the relay lane under the viber name', async () => {
  await withCaptureServer(async (url, captured) => {
    const prev = { RELAY_URL: process.env.RELAY_URL, RELAY_TOKEN_LINA: process.env.RELAY_TOKEN_LINA };
    process.env.RELAY_URL = url;
    process.env.RELAY_TOKEN_LINA = 'tok';
    try {
      const channels = new ChannelRegistry();
      channels.register(new RelayOutboundChannel(loadConfig()));
      await channels.send('viber', '389701234567', 'Здраво');
      assert.equal(captured.length, 1);
      assert.equal(captured[0].body.to, '389701234567');
    } finally {
      process.env.RELAY_URL = prev.RELAY_URL;
      process.env.RELAY_TOKEN_LINA = prev.RELAY_TOKEN_LINA;
    }
  });
});
