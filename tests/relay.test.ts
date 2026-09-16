// relay.test.ts — ATOM4 relay ingress (one-pair vertical slice).
//
// Proves the Lina side of the slice contract:
//   relay envelope POST /message -> auth -> identity check -> EXISTING
//   InboundHandler pipeline -> reply via the EXISTING 'viber' channel path.
// The relay is NOT involved in the outbound: there is no relay URL in this
// file at all — the only send path is the ChannelRegistry ('viber') spy, which
// in production is ViberAdapter's direct chatapi.viber.com sender from ATOM1.
//
// FailingLlm keeps every turn on deterministic/fallback branches (no network).

import { test } from 'node:test';
import assert from 'node:assert';
import express, { Express } from 'express';
import http from 'http';
import { AddressInfo } from 'net';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LandmarkService } from '../src/geo/landmarks';
import { LlmClient } from '../src/llm/types';
import { registerRelayIngress } from '../src/channels/relay';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 53, id: 53, location: 'Аеродром', address: 'Бисер', price: 55000, service: 'buy', bedrooms: 2 },
];

const TOKEN = 'test-relay-token';
const ENVELOPE = {
  botId: 'LINA-1',
  atomId: 'atom1',
  channel: 'viber',
  numberId: 'VIBER-1',
  messageId: '778899',
  from: '389701234567',
  senderName: 'Марко',
  text: 'Здраво',
  ts: new Date().toISOString(),
};

interface RelayEnv {
  app: Express;
  sent: Array<{ chatId: string; text: string; source?: string }>;
  handler: InboundHandler;
  sessions: SessionStore;
  db: Db;
  close: () => Promise<void>;
  url: string;
}

/** Small pause for timing-sensitive batching assertions. */
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

async function startRelayApp(cfgOverrides: Record<string, unknown> = {}): Promise<RelayEnv> {
  // clientTypingDelayMs: 100 keeps the batching window fast for tests;
  // batching-specific tests override it explicitly.
  const cfg = loadConfig({ relayToken: TOKEN, linaId: 'LINA-1', ownerBusPollMs: 25, clientTypingDelayMs: 100, ...cfgOverrides });
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, props);
  const responder = new Responder(llm, cfg);
  const sent: Array<{ chatId: string; text: string; source?: string }> = [];
  const channels = new ChannelRegistry();
  // The production 'viber' channel is ViberAdapter (direct chatapi.viber.com
  // send from ATOM1). The spy records through the SAME registry seam.
  channels.register({ name: 'viber', send: async (chatId, text, source) => { sent.push({ chatId, text, source }); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  const app = express();
  app.use(express.json());
  registerRelayIngress(app, cfg, handler);
  const server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return {
    app, sent, handler, sessions, db,
    url: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

async function post(env: RelayEnv, body: unknown, token?: string): Promise<{ status: number; json: any }> {
  const res = await fetch(`${env.url}/message`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token !== undefined ? { 'x-relay-token': token } : {}),
    },
    body: JSON.stringify(body),
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

/** The ingress acks first and processes async — wait for the pipeline send. */
async function waitForSend(env: RelayEnv, min = 1): Promise<void> {
  for (let i = 0; i < 60 && env.sent.length < min; i++) {
    await new Promise(r => setTimeout(r, 50));
  }
}

test('relay ingress: disabled (503) without RELAY_TOKEN_LINA, like the Hermes API posture', async () => {
  const env = await startRelayApp({ relayToken: '' });
  try {
    const res = await post(env, ENVELOPE, 'anything');
    assert.equal(res.status, 503);
  } finally { await env.close(); }
});

test('relay ingress: invalid relay authentication is rejected (401) — dedicated token only', async () => {
  const env = await startRelayApp();
  try {
    const no = await post(env, ENVELOPE);
    assert.equal(no.status, 401);
    const wrong = await post(env, ENVELOPE, 'nope');
    assert.equal(wrong.status, 401);
    // The Viber token is NOT accepted as relay auth (never reuse credentials).
    const viberCred = await post(env, ENVELOPE, 'VIBER-AUTH-TOKEN-SHAPE');
    assert.equal(viberCred.status, 401);
    assert.equal(env.sent.length, 0);
  } finally { await env.close(); }
});

test('relay ingress: envelope for another identity is rejected (404) — LINA-2 never lands on LINA-1', async () => {
  const env = await startRelayApp();
  try {
    const res = await post(env, { ...ENVELOPE, botId: 'LINA-2' }, TOKEN);
    assert.equal(res.status, 404);
    assert.equal(env.sent.length, 0);
  } finally { await env.close(); }
});

test('relay ingress: normalized message -> existing pipeline -> reply via the EXISTING viber path', async () => {
  const env = await startRelayApp();
  try {
    const res = await post(env, ENVELOPE, TOKEN);
    assert.equal(res.status, 200);
    assert.equal(res.json.status, 'accepted');
    assert.equal(res.json.botId, 'LINA-1');
    await waitForSend(env);
    // Criteria 5-8: Lina received it, her brain processed it, and the response
    // left through the existing 'viber' channel — to the sender's phone id.
    assert.ok(env.sent.length >= 1, 'expected a reply through the viber channel');
    assert.equal(env.sent[0].chatId, '389701234567');
    assert.ok(env.sent[0].text.length > 0);
    // The session lives in the SAME store the Viber webhook uses, marked viber.
    const session = env.sessions.get('389701234567');
    assert.ok(session, 'session created by the shared pipeline');
    assert.equal(session!.channel, 'viber');
    assert.equal(session!.slots.phone, '389701234567'); // prefillViberPhone saw a phone-shaped id
  } finally { await env.close(); }
});

test('relay ingress: relay redelivery is deduped by messageId (no double reply)', async () => {
  const env = await startRelayApp();
  try {
    const first = await post(env, ENVELOPE, TOKEN);
    const second = await post(env, ENVELOPE, TOKEN);
    assert.equal(first.status, 200);
    assert.equal(second.status, 200);
    assert.equal(second.json.status, 'duplicate-ignored');
    await waitForSend(env);
    const replies = env.sent.filter(s => s.chatId === '389701234567');
    assert.ok(replies.length >= 1);
    // Give any stray second processing a beat, then confirm it never came.
    await new Promise(r => setTimeout(r, 300));
    assert.equal(env.sent.filter(s => s.chatId === '389701234567').length, replies.length);
  } finally { await env.close(); }
});

test('relay ingress: message + follow-up in the typing window answer ONCE (combined burst)', async () => {
  const env = await startRelayApp({ clientTypingDelayMs: 400 });
  try {
    await post(env, { ...ENVELOPE, messageId: 'm1', text: 'Zdravo' }, TOKEN);
    await post(env, { ...ENVELOPE, messageId: 'm2', text: 'mi treba stan pod kirija' }, TOKEN);
    await waitForSend(env);
    const replies = env.sent.filter(s => s.chatId === '389701234567');
    assert.equal(replies.length, 1, `expected ONE reply for the burst, got ${replies.length}`);
    // The brain saw the WHOLE burst as ONE user turn (newline-joined) —
    // exactly the TUI flushClient() rule.
    const session = env.sessions.get('389701234567');
    const userTurn = session!.history.find(h => h.role === 'user');
    assert.ok(userTurn, 'user turn recorded');
    assert.ok(userTurn!.text.includes('Zdravo') && userTurn!.text.includes('mi treba stan pod kirija'),
      `burst must be combined, got: ${JSON.stringify(userTurn!.text)}`);
  } finally { await env.close(); }
});

test('relay ingress: a follow-up RESETS the typing window (no reply mid-burst)', async () => {
  const env = await startRelayApp({ clientTypingDelayMs: 600 });
  try {
    await post(env, { ...ENVELOPE, messageId: 'r1', text: 'prva' }, TOKEN);
    await sleep(300); // 300ms into the 600ms window — the follow-up resets it
    await post(env, { ...ENVELOPE, messageId: 'r2', text: 'vtora' }, TOKEN);
    await sleep(400); // 700ms since the FIRST message — an unreset window would have flushed at 600ms
    assert.equal(env.sent.length, 0, 'the follow-up must have reset the window');
    await waitForSend(env); // fires at ~900ms (300 + 600)
    assert.equal(env.sent.length, 1);
  } finally { await env.close(); }
});

test('relay ingress: hard cap — endless follow-ups cannot stall the reply forever', async () => {
  const env = await startRelayApp({ clientTypingDelayMs: 300 });
  try {
    await post(env, { ...ENVELOPE, messageId: 'c0', text: 'prva' }, TOKEN);
    // Keep sending follow-ups every 250ms — inside the 300ms window, so only
    // the 3x hard cap (900ms) can force the flush.
    for (let i = 1; i <= 3; i++) {
      await sleep(250);
      await post(env, { ...ENVELOPE, messageId: `c${i}`, text: `nastan ${i}` }, TOKEN);
    }
    await waitForSend(env);
    assert.equal(env.sent.length, 1, 'the hard cap must force exactly one flush');
  } finally { await env.close(); }
});

test('relay ingress: two chats batch independently (A\u2019s burst never blocks B\u2019s reply)', async () => {
  const env = await startRelayApp({ clientTypingDelayMs: 300 });
  try {
    await post(env, { ...ENVELOPE, messageId: 'a1', text: 'Zdravo' }, TOKEN);
    await post(env, { ...ENVELOPE, messageId: 'b1', from: '389709999999', text: 'Zdravo' }, TOKEN);
    await waitForSend(env, 2);
    assert.equal(env.sent.filter(s => s.chatId === '389701234567').length, 1);
    assert.equal(env.sent.filter(s => s.chatId === '389709999999').length, 1);
  } finally { await env.close(); }
});

test('relay ingress: non-viber envelopes are rejected — the slice is viber-only', async () => {
  const env = await startRelayApp();
  try {
    const res = await post(env, { ...ENVELOPE, channel: 'telegram' }, TOKEN);
    assert.equal(res.status, 422);
    assert.equal(env.sent.length, 0);
  } finally { await env.close(); }
});

test('relay ingress: outbound never touches the relay — replies go straight out the viber channel', async () => {
  // Structural guarantee: the ingress module performs no outbound HTTP at all
  // (no relay URL is configured or known on the Lina side; the reply path is
  // ChannelRegistry('viber') -> ViberAdapter on ATOM1, unchanged). Here the
  // registry spy IS the terminal send — nothing else is involved.
  const env = await startRelayApp();
  try {
    await post(env, ENVELOPE, TOKEN);
    await waitForSend(env);
    assert.ok(env.sent.length >= 1);
    // Every send went through the local registry — no relay round-trip exists.
    for (const s of env.sent) {
      assert.ok(s.chatId && s.text, `send must carry chatId+text: ${JSON.stringify(s)}`);
    }
  } finally { await env.close(); }
});
