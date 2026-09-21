// Integration pin: REAL SQLite session persistence (file-backed, better-sqlite3)
// across a simulated process restart. Pins the two audit behaviors end-to-end:
//
//   1. SERVICE BACKFILL — binding interest on a rental without any explicit
//      service mention records slots.service=rent on the REAL store, and the
//      persisted session drives the correct rent fee after a restart.
//   2. PRICE-LESS RENTAL — the price-ask fallback serves the RENT fee (the
//      hardcoded buy-fee audit fix), also across a restart.
//
// Plus the TTL lifecycle on a real store: an expired session RESETS (greeting),
// and the post-reset visit command re-pins the service backfill on a fresh
// session. The LLM is DOWN in every phase — everything shown is deterministic.
import { test } from 'node:test';
import assert from 'node:assert';
import { rmSync } from 'fs';
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
import { LandmarkService } from '../src/geo/landmarks';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

// Minimal feed: one price-less RENTAL (the fallback trigger) and one buy row
// (so service mixing is observable — a buy leak would be caught by the 300-денари asserts).
const ROWS: Property[] = [
  { eb: 90, id: 90, location: 'Центар', price: undefined, service: 'rent' },
  { eb: 80, id: 80, location: 'Кисела Вода', price: 46000, service: 'buy' },
];

// One "process": fresh Db/SessionStore/handler instances on the SAME file.
// Wiring mirrors tests/stuck.test.ts (proven shape); everything shares the
// file so the next instance sees the persisted sessions.
function boot(file: string, sent: string[]): { handler: InboundHandler; sessions: SessionStore } {
  const cfg = loadConfig();
  const db = new Db(file);
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const classifier = new Classifier(new FailingLlm(), cfg, properties);
  const responder = new Responder(new FailingLlm(), cfg);
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions };
}

const FILE = 'tmp/integration-pin/test-sessions.sqlite';
const CHAT = 'pin-1';

test('persistence pin: price-less rental + service backfill survive a restart on real SQLite', async () => {
  rmSync('tmp/integration-pin', { recursive: true, force: true });

  // ---------- Phase 1: fresh process ----------
  {
    const sent: string[] = [];
    const { handler, sessions } = boot(FILE, sent);
    const send = async (m: string) => { await handler.handle('test', CHAT, m); };

    // Price ask on the price-less RENTAL (EB 90) — fallback territory.
    await send('KOLKU E CENATA ZA STAN SO BROJ 90');
    const p1 = sent[sent.length - 1];
    assert.ok(/300\s*денари/i.test(p1), `rent fee expected on a price-less rental: ${p1}`);
    assert.ok(!p1.includes('500 денари'), p1);

    // The visit command binds interest; the backfill records service=rent.
    await send('ORGANIZIRAJ MI POSETA ZA 90');
    const s1 = sessions.get(CHAT)!;
    assert.equal(s1.state, 'closing');
    assert.equal(s1.slots.interestedPropertyId, 90);
    assert.equal(s1.slots.service, 'rent', 'service backfilled from the property');
  }

  // ---------- Phase 2: RESTART (new instances, same file) ----------
  {
    const sent: string[] = [];
    const { handler, sessions } = boot(FILE, sent);
    const send = async (m: string) => { await handler.handle('test', CHAT, m); };

    // The persisted session is intact — the fee was already disclosed, so the
    // agreement closes to contact collection WITH THE RENT derivation intact
    // (the backfilled service read back from SQLite drives this).
    const pre = sessions.get(CHAT)!;
    assert.equal(pre.state, 'closing', 'session survived the restart');
    assert.equal(pre.slots.service, 'rent', 'backfilled service persisted');
    assert.equal(pre.slots.interestedPropertyId, 90, 'interest persisted');

    await send('DA, SE SOGLASUVAM');
    const s2 = sessions.get(CHAT)!;
    assert.equal(s2.state, 'contact_collection');
    assert.ok(/име и презиме/i.test(sent[sent.length - 1]), sent[sent.length - 1]);

    // Expire the session AND drop it to idle (simulates a client who went
    // quiet after the funnel closed and the conversation ended): both the
    // TTL gate's reset branch and real-world long-absence behavior.
    const aged = sessions.get(CHAT)!;
    aged.state = 'idle';
    aged.slots = {};
    aged.lastInboundAt = Date.now() - 73 * 60_000;
    sessions.set(aged);
  }

  // ---------- Phase 3: RESTART — expired session resets, then re-pins backfill ----------
  {
    const sent: string[] = [];
    const { handler, sessions } = boot(FILE, sent);
    const send = async (m: string) => { await handler.handle('test', CHAT, m); };

    // Expired + idle → the greeting path: the funnel restarts from scratch.
    await send('ZDRAVO');
    const greeting = sent[sent.length - 1];
    assert.ok(/(?:Здраво|Добредојдовте|Добар ден|Повелете)/iu.test(greeting), `fresh greeting expected: ${greeting}`);
    assert.ok(!/денари|посета/i.test(greeting), `greeting must carry no funnel traffic: ${greeting}`);

    // Post-reset visit command on the rental — the backfill works on the fresh
    // session too (service derived from the property, rent fee served).
    await send('ORGANIZIRAJ MI POSETA ZA 90');
    const s3 = sessions.get(CHAT)!;
    assert.equal(s3.state, 'closing');
    assert.equal(s3.slots.service, 'rent', 'backfill on a fresh session');
    assert.ok(/300\s*денари/i.test(sent[sent.length - 1]), `rent fee after reset: ${sent[sent.length - 1]}`);
    assert.ok(!sent[sent.length - 1].includes('500 денари'), sent[sent.length - 1]);
  }

  rmSync('tmp/integration-pin', { recursive: true, force: true });
});
