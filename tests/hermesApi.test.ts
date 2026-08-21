import { test } from 'node:test';
import assert from 'node:assert';
import express from 'express';
import * as http from 'node:http';
import { AddressInfo } from 'node:net';
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
import { LlmClient } from '../src/llm/types';
import { registerHermesApi } from '../src/hermes/api';
import { LandmarkService } from '../src/geo/landmarks';
import { detectOwnerVerdict } from '../src/llm/deterministic';

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
  { eb: 78, id: 78, location: 'Капиштец', price: 185000, service: 'buy', bedrooms: 3 },
];

interface ApiEnv {
  base: string;
  token: string;
  handler: InboundHandler;
  sessions: SessionStore;
  db: Db;
  close: () => Promise<void>;
}

async function startApi(): Promise<ApiEnv> {
  const cfg = loadConfig({ hermesToken: 'test-token', ownerBusPollMs: 25 });
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, props);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async () => {} });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  const app = express();
  app.use(express.json());
  registerHermesApi(app, { cfg, db, pipeline: handler, properties: props });
  const server = http.createServer(app);
  await new Promise<void>(r => server.listen(0, r));
  const port = (server.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    token: 'test-token',
    handler, sessions, db,
    close: () => new Promise<void>(r => server.close(() => r())),
  };
}

async function apiCall(env: ApiEnv, path: string, opts: RequestInit = {}, token?: string): Promise<{ status: number; body: any }> {
  const res = await fetch(`${env.base}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { 'x-admin-token': token } : {}),
      ...(opts.headers as Record<string, string> | undefined),
    },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

test('hermes API: token guard — 401 without/with a wrong token, 200 with it', async () => {
  const env = await startApi();
  try {
    const no = await apiCall(env, '/hermes/v1/work');
    assert.equal(no.status, 401);
    const wrong = await apiCall(env, '/hermes/v1/work', {}, 'nope');
    assert.equal(wrong.status, 401);
    const ok = await apiCall(env, '/hermes/v1/work', {}, env.token);
    assert.equal(ok.status, 200);
  } finally {
    await env.close();
  }
});

test('hermes API: work pull lists landmark candidates; pushing names removes them; the street is rejected', async () => {
  const env = await startApi();
  try {
    const work = await apiCall(env, '/hermes/v1/work', {}, env.token);
    assert.equal(work.status, 200);
    // EB 53 (Бисер/Аеродром) is an unresolved candidate; EB 78 (no address) is not.
    const cands = work.body.landmarks as Array<{ address?: string; location?: string }>;
    assert.ok(cands.some(c => c.address === 'Бисер' && c.location === 'Аеродром'), JSON.stringify(cands));

    // Push a valid landmark -> accepted; the address leaves the queue.
    const push = await apiCall(env, '/hermes/v1/landmarks', {
      method: 'POST',
      body: JSON.stringify([{ address: 'Бисер', location: 'Аеродром', landmark: 'Кафе бар Ван Гог', type: 'llm' }]),
    }, env.token);
    assert.equal(push.status, 200);
    assert.equal(push.body.accepted, 1);

    const work2 = await apiCall(env, '/hermes/v1/work', {}, env.token);
    assert.ok(!(work2.body.landmarks as any[]).some(c => c.address === 'Бисер'), 'resolved address no longer a candidate');

    // Street leakage is rejected at the API too (defense in depth).
    const leak = await apiCall(env, '/hermes/v1/landmarks', {
      method: 'POST',
      body: JSON.stringify([{ address: 'Бисер', location: 'Аеродром', landmark: 'до Бисер 12' }]),
    }, env.token);
    assert.equal(leak.body.accepted, 0);
    assert.equal(leak.body.rejected.length, 1);
  } finally {
    await env.close();
  }
});

test('hermes API: price-change result resolves (or keeps) the pending row', async () => {
  const env = await startApi();
  try {
    const id = env.handler.priceChanges.insert({ eb: 53, oldPrice: 55000, newPrice: 60000, chatId: 'c1' });
    const id2 = env.handler.priceChanges.insert({ eb: 78, oldPrice: 185000, newPrice: 200000, chatId: 'c2' });

    const ok = await apiCall(env, `/hermes/v1/prices/${id}/result`, { method: 'POST', body: JSON.stringify({ ok: true }) }, env.token);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.resolved, true);

    const fail = await apiCall(env, `/hermes/v1/prices/${id2}/result`, { method: 'POST', body: JSON.stringify({ ok: false }) }, env.token);
    assert.equal(fail.body.resolved, false);

    const pending = env.handler.priceChanges.listPending();
    assert.equal(pending.length, 1);
    assert.equal(pending[0].id, id2);
  } finally {
    await env.close();
  }
});

test('hermes API: owner answer via the events BUS resolves the pending check (cross-process path)', async () => {
  const env = await startApi();
  try {
    const chatId = 'bus-owner';
    const send = async (m: string) => { await env.handler.handle('test', chatId, m); return env.sessions.get(chatId)!; };
    await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 53');
    await send('DALI E SEUSTE DOSTAPEN ?');
    await send('DA'); // confirm owner contact
    await send('DA, SE SOGLASUVAM');
    await send('ZORAN 078/914 196');
    let s = await send('UTRE POPLADNE');
    assert.equal(s.state, 'owner_checking');

    // The same-process fast path through the API endpoint.
    const ans = await apiCall(env, `/hermes/v1/owners/${chatId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ eb: 53, status: 'ok', owner_time: 'утре попладне' }),
    }, env.token);
    assert.equal(ans.body.applied, true);
    await new Promise(r => setTimeout(r, 80));
    s = env.sessions.get(chatId)!;
    assert.equal(s.state, 'pending'); // visit confirmed

    // The CROSS-PROCESS path: another process writes the result event directly
    // (as its API would) — the agent's bus poll picks it up.
    const chatId2 = 'bus-owner2';
    const send2 = async (m: string) => { await env.handler.handle('test', chatId2, m); return env.sessions.get(chatId2)!; };
    await send2('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 53');
    await send2('DALI E SEUSTE DOSTAPEN ?');
    await send2('DA'); // confirm owner contact
    await send2('DA, SE SOGLASUVAM');
    await send2('ZORAN 078/914 196');
    let s2 = await send2('UTRE POPLADNE');
    assert.equal(s2.state, 'owner_checking');
    env.handler.events.insert('owner_check_result', chatId2, 53, { status: 'ok', ownerTime: 'утре попладне', source: 'api' });
    await new Promise(r => setTimeout(r, 150)); // poll every 25ms
    s2 = env.sessions.get(chatId2)!;
    assert.equal(s2.state, 'pending');
  } finally {
    await env.close();
  }
});

test('hermes API: the API endpoint matches the deterministic owner verdict flow', async () => {
  const env = await startApi();
  try {
    const chatId = 'api-owner3';
    const send = async (m: string) => { await env.handler.handle('test', chatId, m); return env.sessions.get(chatId)!; };
    await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 53');
    await send('DALI E SEUSTE DOSTAPEN ?');
    await send('DA'); // confirm owner contact
    await send('DA, SE SOGLASUVAM');
    await send('ZORAN 078/914 196');
    let s = await send('UTRE POPLADNE');
    assert.equal(s.state, 'owner_checking');

    // counter -> time_confirm
    const counter = await apiCall(env, `/hermes/v1/owners/${chatId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ eb: 53, status: 'counter', owner_time: 'петок во 17:00' }),
    }, env.token);
    assert.equal(counter.body.applied, true);
    await new Promise(r => setTimeout(r, 80));
    s = env.sessions.get(chatId)!;
    assert.equal(s.state, 'time_confirm');
    assert.ok(s.slots.ownerTime?.includes('петок'), JSON.stringify(s.slots));
  } finally {
    await env.close();
  }
});
