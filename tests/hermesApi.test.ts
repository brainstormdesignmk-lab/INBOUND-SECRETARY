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
import { OwnerStore } from '../src/store/owners';
import { matchesPoolContract } from '../src/data/responseBank';

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
  /** Everything the CLIENT channel received — the negative assertions ("the
   *  client hears nothing") are the point of the owner-seam tests. */
  sent: string[];
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
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
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
    handler, sessions, db, sent,
    // See relay.test.ts: undici's keep-alive socket makes a bare server.close()
    // wait ~4 s per test. Nothing reuses the socket after the test.
    close: () => new Promise<void>(r => {
      (server as unknown as { closeAllConnections?: () => void }).closeAllConnections?.();
      server.close(() => r());
    }),
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
    // [22:31] contract: bare day+period re-asks the hour first, then proceeds.
    await send('UTRE POPLADNE');
    let s = await send('OKOLU 16');
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
    // [22:31] contract: bare day+period re-asks the hour first, then proceeds.
    await send2('UTRE POPLADNE');
    let s2 = await send2('OKOLU 16');
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
    // [22:31] contract: bare day+period re-asks the hour first, then proceeds.
    await send('UTRE POPLADNE');
    let s = await send('OKOLU 16');
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

// ── THE OWNER TRANSPORT SEAM (the two-machine workflow) ────────────────────
// A channel that holds the OWNER's conversation (Hermes on machine B) must not
// parse his words: it relays them, Lina answers through the SAME seam the
// operator pane uses, and the transport delivers the returned sentence. That is
// what keeps ONE owner grammar and ONE copy source in the appliance — a second
// parser on the other machine is how a client gets booked into a term the owner
// never gave (the [23:41] class), and a second copywriter stops the pool from
// rotating for the one human who reads it most.

async function sendTo(env: ApiEnv, chatId: string, m: string) {
  await env.handler.handle('test', chatId, m);
  return env.sessions.get(chatId)!;
}

/** Interest → availability → fee → contact → a proposed term → owner_checking. */
async function reachOwnerWaiting(env: ApiEnv, chatId: string) {
  await sendTo(env, chatId, 'ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 53');
  await sendTo(env, chatId, 'DALI E SEUSTE DOSTAPEN ?');
  await sendTo(env, chatId, 'DA'); // confirm the owner contact
  await sendTo(env, chatId, 'DA, SE SOGLASUVAM'); // fee
  await sendTo(env, chatId, 'ZORAN 078/914 196'); // contact
  await sendTo(env, chatId, 'UTRE POPLADNE'); // day + part → the hour is re-asked
  const s = await sendTo(env, chatId, 'OKOLU 16');
  assert.equal(s.state, 'owner_checking');
  return s;
}

const settle = () => new Promise<void>(r => setTimeout(r, 150));

test('hermes API /work: an open owner check carries the ask to deliver and the owner contact', async () => {
  const env = await startApi();
  try {
    new OwnerStore(env.db).upsert({ eb: 53, name: 'Петар', phone: '070123456' });
    const chatId = 'work-owner';
    await reachOwnerWaiting(env, chatId);

    const work = await apiCall(env, '/hermes/v1/work', {}, env.token);
    assert.equal(work.status, 200);
    const check = (work.body.owner_checks as Array<Record<string, any>>).find(c => c.chat_id === chatId);
    assert.ok(check, `the open check is work: ${JSON.stringify(work.body.owner_checks)}`);
    assert.equal(check.eb, 53);
    assert.ok(check.proposed_time, JSON.stringify(check));
    // LINA'S OWN SENTENCE — composed by the handler, bank-served, deliverable
    // as-is. The transport never writes owner copy.
    assert.equal(typeof check.deliver_text, 'string', JSON.stringify(check));
    assert.match(check.deliver_text, /број 53/u, check.deliver_text);
    assert.ok(check.deliver_text.trim().endsWith('?'), check.deliver_text);
    assert.equal(check.owner_phone, '070123456');
    assert.equal(check.owner_name, 'Петар');

    // The check stops being work the moment the verdict lands.
    const asked = (env.handler.ownerAgent as any).pendingProposedTime?.(chatId);
    assert.ok(asked, 'the setup leaves a term on the table');
    const ans = await apiCall(env, `/hermes/v1/owners/${chatId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ eb: 53, status: 'ok', confirm_time: asked }),
    }, env.token);
    assert.equal(ans.body.applied, true, JSON.stringify(ans.body));
    await settle();
    const after = await apiCall(env, '/hermes/v1/work', {}, env.token);
    assert.ok(!(after.body.owner_checks as any[]).some(c => c.chat_id === chatId),
      `/work still lists the answered check: ${JSON.stringify(after.body.owner_checks)}`);
  } finally {
    await env.close();
  }
});

test('hermes API /reply: the availability half is answered, never taken for the term', async () => {
  const env = await startApi();
  try {
    const chatId = 'reply-avail';
    await reachOwnerWaiting(env, chatId);
    const before = env.sent.length;

    const r = await apiCall(env, `/hermes/v1/owners/${chatId}/reply`, {
      method: 'POST',
      body: JSON.stringify({ eb: 53, text: 'DOSTAPNA E DA', message_id: 'm-avail-1' }),
    }, env.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.effect, 'answered', JSON.stringify(r.body));
    assert.equal(typeof r.body.reply_text, 'string', JSON.stringify(r.body));
    // The pooled ack + the OPEN term question: asserted as a CONTRACT, because
    // the pool rotates (the fields trial is the same one the operator sees).
    assert.equal(matchesPoolContract('owner.availability.ack.term', r.body.reply_text), true, r.body.reply_text);
    assert.match(r.body.reply_text, /Евидентен број 53/u, r.body.reply_text);

    const s = env.sessions.get(chatId)!;
    assert.equal(s.state, 'owner_checking', 'the check stays open');
    assert.equal(s.slots.agentPhone, undefined, 'no agent is assigned on a half answer');
    assert.equal(env.sent.length, before, `the client hears nothing: ${JSON.stringify(env.sent.slice(before))}`);
    // …and the check is still ARMED, so his next message is accepted.
    assert.equal((env.handler.ownerAgent as any).pendingEb?.(chatId), 53);
  } finally {
    await env.close();
  }
});

test('hermes API /reply: a retried message answers with the SAME sentence, not a second turn', async () => {
  const env = await startApi();
  try {
    const chatId = 'reply-dup';
    await reachOwnerWaiting(env, chatId);
    const before = env.sent.length;
    const body = JSON.stringify({ eb: 53, text: 'DOSTAPNA E DA', message_id: 'dup-1' });

    const first = await apiCall(env, `/hermes/v1/owners/${chatId}/reply`, { method: 'POST', body }, env.token);
    const second = await apiCall(env, `/hermes/v1/owners/${chatId}/reply`, { method: 'POST', body }, env.token);
    assert.equal(first.status, 200, JSON.stringify(first.body));
    assert.equal(second.status, 200, JSON.stringify(second.body));
    assert.equal(second.body.replay, true, JSON.stringify(second.body));
    assert.equal(second.body.reply_text, first.body.reply_text, 'a retry must not compose a new sentence');
    assert.equal(env.sent.length, before, 'and neither call reaches the client');
  } finally {
    await env.close();
  }
});

test('hermes API /reply: a proposal is a verdict — the funnel relays it, the owner gets nothing to send back', async () => {
  const env = await startApi();
  try {
    const chatId = 'reply-verdict';
    await reachOwnerWaiting(env, chatId);
    const before = env.sent.length;

    const r = await apiCall(env, `/hermes/v1/owners/${chatId}/reply`, {
      method: 'POST',
      body: JSON.stringify({ eb: 53, text: 'NE MOZAM VO 6 VO PETOK', message_id: 'v-1' }),
    }, env.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.effect, 'verdict_applied', JSON.stringify(r.body));
    await settle();
    assert.ok(env.sent.length > before, 'the client is told about the owner\'s answer');
    assert.ok(['time_confirm', 'visit_scheduling'].includes(env.sessions.get(chatId)!.state),
      env.sessions.get(chatId)!.state);
  } finally {
    await env.close();
  }
});

test('hermes API /reply: a day-only counter re-asks the OWNER for the hour — and that text comes back', async () => {
  const env = await startApi();
  try {
    const chatId = 'reply-vague';
    await reachOwnerWaiting(env, chatId);
    const before = env.sent.length;

    const r = await apiCall(env, `/hermes/v1/owners/${chatId}/reply`, {
      method: 'POST',
      body: JSON.stringify({ eb: 53, text: 'MOZE VO SABOTA', message_id: 'vague-1' }),
    }, env.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // The exact-hour question is OWNER-facing copy: it used to reach only the
    // operator pane, so a remote owner channel would have gone silent here.
    assert.equal(typeof r.body.reply_text, 'string', JSON.stringify(r.body));
    assert.equal(matchesPoolContract('vague.time.owner', r.body.reply_text), true, r.body.reply_text);
    assert.equal(env.sessions.get(chatId)!.state, 'owner_checking');
    assert.equal(env.sent.length, before, `the client hears nothing yet: ${JSON.stringify(env.sent.slice(before))}`);
    assert.equal((env.handler.ownerAgent as any).pendingEb?.(chatId), 53, 'the check is re-armed for his hour');
  } finally {
    await env.close();
  }
});

test('hermes API /answer: an ok with no term cannot book the client\'s slot', async () => {
  const env = await startApi();
  try {
    const chatId = 'answer-no-term';
    await reachOwnerWaiting(env, chatId);
    const before = env.sent.length;

    const r = await apiCall(env, `/hermes/v1/owners/${chatId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ eb: 53, status: 'ok' }),
    }, env.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.applied, true, JSON.stringify(r.body));
    await settle();
    const s = env.sessions.get(chatId)!;
    assert.equal(s.state, 'owner_checking', 'an ambiguous ok is the availability lane');
    assert.equal(s.slots.agentPhone, undefined, 'nothing was booked');
    assert.equal(env.sent.length, before, `the client hears nothing: ${JSON.stringify(env.sent.slice(before))}`);
    // The consumed check is RE-ARMED: his term answer is still expected.
    assert.equal((env.handler.ownerAgent as any).pendingEb?.(chatId), 53);
  } finally {
    await env.close();
  }
});

test('hermes API /answer: consent must name its object — a wrong confirm_time is refused', async () => {
  const env = await startApi();
  try {
    const chatId = 'answer-confirm';
    await reachOwnerWaiting(env, chatId);
    const asked = (env.handler.ownerAgent as any).pendingProposedTime?.(chatId) as string;
    assert.ok(asked, 'the setup leaves a term on the table');
    const before = env.sent.length;

    const wrong = await apiCall(env, `/hermes/v1/owners/${chatId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ eb: 53, status: 'ok', confirm_time: 'петок во 17:00' }),
    }, env.token);
    assert.equal(wrong.status, 409, JSON.stringify(wrong.body));
    await settle();
    assert.equal(env.sessions.get(chatId)!.state, 'owner_checking');
    assert.equal(env.sent.length, before, 'nothing was booked on the wrong term');

    const right = await apiCall(env, `/hermes/v1/owners/${chatId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ eb: 53, status: 'ok', confirm_time: asked }),
    }, env.token);
    assert.equal(right.body.applied, true, JSON.stringify(right.body));
    await settle();
    assert.equal(env.sessions.get(chatId)!.state, 'pending');
    assert.ok(env.sent.length > before, 'the client gets the confirmation');
  } finally {
    await env.close();
  }
});

test('hermes API /answer: the available status confirms availability and keeps the check open', async () => {
  const env = await startApi();
  try {
    const chatId = 'answer-available';
    await reachOwnerWaiting(env, chatId);
    const before = env.sent.length;

    const r = await apiCall(env, `/hermes/v1/owners/${chatId}/answer`, {
      method: 'POST',
      body: JSON.stringify({ eb: 53, status: 'available' }),
    }, env.token);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.applied, true, JSON.stringify(r.body));
    assert.equal(r.body.reply_text, null, 'the ack goes out on the owner channel');
    await settle();
    const s = env.sessions.get(chatId)!;
    assert.equal(s.state, 'owner_checking');
    assert.equal(s.slots.agentPhone, undefined);
    assert.equal(env.sent.length, before, `the client hears nothing: ${JSON.stringify(env.sent.slice(before))}`);
  } finally {
    await env.close();
  }
});

test('hermes API: a stray verdict is a 409 and leaves NO pending bus event', async () => {
  const env = await startApi();
  try {
    const ans = await apiCall(env, '/hermes/v1/owners/ghost-chat/answer', {
      method: 'POST',
      body: JSON.stringify({ eb: 53, status: 'ok', owner_time: 'сабота во 12:00' }),
    }, env.token);
    assert.equal(ans.status, 409, JSON.stringify(ans.body));
    assert.deepEqual(
      env.handler.events.listPending('owner_check_result').filter(e => e.chatId === 'ghost-chat'),
      [], 'a verdict for a check nobody holds must not sit in the bus forever',
    );

    const reply = await apiCall(env, '/hermes/v1/owners/ghost-chat/reply', {
      method: 'POST',
      body: JSON.stringify({ text: 'ZDRAVO' }),
    }, env.token);
    assert.equal(reply.status, 404, JSON.stringify(reply.body));
  } finally {
    await env.close();
  }
});
