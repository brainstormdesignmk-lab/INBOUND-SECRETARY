// The [00:12] Kisela Voda spec — the per-м² RATE is the client's anchor.
//
// Transcript: the client got EB 37 (90 м², 117.500 евра = 1.306 евра/м²) and
// wrote "GOLEM MI E NEKAKO" / "POMAL MI TREBA SO TAKVA CENA ZA KVADRAT" /
// "REKOV TAKVA CENA ZA KVADRAT AMA POMAL". Lina answered the SAME flat's
// info doll twice — the INFO block's pricePerSqm facet re-rendered the rate
// and never moved the funnel. The contract: the rate is a SEARCH anchor —
// Lina serves the NEXT-BEST smaller set (same service, strictly smaller м²,
// €/м² at or below the anchor's, same-area first, already-shown excluded);
// nothing left → the honest register line, never a re-render.
import { test } from 'node:test';
import assert from 'node:assert';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession } from '../src/fsm/session';
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

class FailingLlm implements LlmClient { async complete(): Promise<string> { throw new Error('429'); } }
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

// Rates: EB 37 → 1306; EB 41 → 1300 (closest UNDER the rate, same area);
// EB 42 → 1030 (smaller, cheaper rate, but ANOTHER area); EB 44 → 1764
// (smaller but ABOVE the rate — must never serve); EB 45 → 1239 (under the
// rate but BIGGER than 90 м² — must never serve).
function makeRows(): Property[] {
  return [
    { eb: 37, id: 37, location: 'Кисела Вода', price: 117500, service: 'buy', bedrooms: 4, sqm: 90, size: '90 м²' },
    { eb: 41, id: 41, location: 'Кисела Вода', price: 70200, service: 'buy', bedrooms: 3, sqm: 54, size: '54 м²' },
    { eb: 42, id: 42, location: 'Аеродром', price: 61800, service: 'buy', bedrooms: 3, sqm: 60, size: '60 м²' },
    { eb: 44, id: 44, location: 'Кисела Вода', price: 97000, service: 'buy', bedrooms: 3, sqm: 55, size: '55 м²' },
    { eb: 45, id: 45, location: 'Кисела Вода', price: 117750, service: 'buy', bedrooms: 4, sqm: 95, size: '95 м²' },
  ] as unknown as Property[];
}

async function makeHandler(rows: Property[] = makeRows()) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(rows);
  const classifier = new Classifier(new FailingLlm(), cfg, properties);
  const responder = new Responder(new FailingLlm(), cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder,
    properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { sessions, sent,
    send: async (chatId: string, m: string) => { await handler.handle('test', chatId, m); return sent.at(-1) ?? ''; } };
}

/** Seeds the presentation state the transcript had: EB 37 on the table. */
async function seedPresentation(send: (c: string, m: string) => Promise<string>, sessions: SessionStore, chat: string, presentedIds: number[] = [37]) {
  // (session seeded in-line — see seedPresentation) creates the rows the
  // transcript had: EB 37 bound and the funnel mid-presentation.
  let s = sessions.get(chat);
  if (!s) s = freshSession('test', chat);
  s.state = 'presentation';
  s.slots.presentedIds = [...presentedIds];
  sessions.set(s);
}

test('[00:12] "POMAL MI TREBA SO TAKVA CENA ZA KVADRAT" → smaller cards at ≤ the anchor rate, EB 37 never re-served', async () => {
  const { send, sessions } = await makeHandler();
  const chat = 'per-m2-smaller';
  await seedPresentation(send, sessions, chat);
  const r = await send(chat, 'POMAL MI TREBA SO TAKVA CENA ZA KVADRAT');
  const s = sessions.get(chat)!;
  assert.ok(r.includes('Евидентен број 41'), `the closest under-rate smaller card serves first: ${r}`);
  assert.ok(r.includes('Евидентен број 42'), `the second under-rate smaller card serves: ${r}`);
  assert.ok(r.includes('евра за м²'), `the per-м² line renders: ${r}`);
  assert.ok(r.includes('54 м²'), 'the card carries its own м²');
  assert.ok(!r.includes('Евидентен број 37'), 'the anchored flat never re-renders');
  assert.ok(!r.includes('117.500'), 'the anchored flat\'s total never re-renders');
  assert.ok(!r.includes('Евидентен број 44'), 'above-rate rows never serve');
  assert.ok(!r.includes('Евидентен број 45'), 'bigger rows never serve');
  assert.ok(!r.includes('Колку спални'), `no bedrooms ask (the client already priced the size): ${r}`);
  assert.equal(s.state, 'presentation');
  assert.ok((s.slots.currentBatch ?? []).includes(41), 'the smaller batch is the current context');
});

test('"REKOV TAKVA CENA ZA KVADRAT AMA POMAL" (small word AFTER the rate phrase) hits the same lane', async () => {
  const { send, sessions } = await makeHandler();
  const chat = 'per-m2-inverted';
  await seedPresentation(send, sessions, chat);
  const r = await send(chat, 'REKOV TAKVA CENA ZA KVADRAT AMA POMAL');
  assert.ok(r.includes('Евидентен број 41'), `same ladder serves: ${r}`);
  assert.ok(r.includes('Евидентен број 42'), `second card serves: ${r}`);
  assert.ok(!r.includes('Евидентен број 37'), 'no info re-render');
  assert.equal(sessions.get(chat)!.state, 'presentation');
});

test('second smaller ask after the batch served → honest no-match line, no card, no re-render', async () => {
  const { send, sessions } = await makeHandler();
  const chat = 'per-m2-drained';
  await seedPresentation(send, sessions, chat);
  await send(chat, 'POMAL MI TREBA SO TAKVA CENA ZA KVADRAT'); // [41, 42] presented
  const r2 = await send(chat, 'REKOV TAKVA CENA ZA KVADRAT AMA POMAL');
  assert.ok(/немам|известам/.test(r2), `the honest register line serves: ${r2}`);
  assert.ok(!r2.includes('Евидентен број'), `no card re-render: ${r2}`);
  assert.ok(!r2.includes('1.306'), 'the anchor rate never re-renders');
});

test('no smaller <= rate anywhere → honest line on the FIRST ask (never an info re-render, never a card)', async () => {
  const rows: Property[] = [
    { eb: 37, id: 37, location: 'Кисела Вода', price: 117500, service: 'buy', bedrooms: 4, sqm: 90, size: '90 м²' },
    { eb: 44, id: 44, location: 'Кисела Вода', price: 97000, service: 'buy', bedrooms: 3, sqm: 55, size: '55 м²' }, // rate 1764 — above
  ] as unknown as Property[];
  const { send, sessions } = await makeHandler(rows);
  const chat = 'per-m2-none';
  await seedPresentation(send, sessions, chat);
  const r = await send(chat, 'POMAL MI TREBA SO TAKVA CENA ZA KVADRAT');
  assert.ok(/немам/.test(r), `honest no-match: ${r}`);
  assert.ok(!r.includes('Евидентен број 44'), 'the above-rate row never sneaks in');
  assert.ok(!/односно/.test(r), 'no info-doll re-render of the rate pair');
  const s = sessions.get(chat)!;
  assert.ok(!(s.slots.currentBatch ?? []).length, 'no batch on the empty pool');
});

test('detector: the per-м² anchored small family (both scripts, any word order), pure price/size asks never fire', async () => {
  const { detectSmallerPerM2Ask } = await import('../src/llm/deterministic');
  const positives = [
    'POMAL MI TREBA SO TAKVA CENA ZA KVADRAT',
    'REKOV TAKVA CENA ZA KVADRAT AMA POMAL',
    'pomala cena za m2',
    'nesto pomalo so takva cena po m2',
    'ПОМАЛО СО ТАКВА ЦЕНА ЗА КВАДРАТ',
    'pomalo od 1306 evra za m2',
    'golem mi e, baram pomalo so ista cena za kvadrat',
  ];
  for (const t of positives) {
    assert.equal(detectSmallerPerM2Ask(t), true, `must fire: ${t}`);
  }
  const negatives = [
    'pomala cena',                    // cheaper-TOTAL ask — the price lanes own it
    'cenata da e pomala',
    'nesto pomalo do 300EVRA',        // discovery pomalo — bedrooms ask owns it
    'POMALO',
    'kolku e cena za kvadrat na 37?', // pure rate ask — the INFO facet owns it
    'takva cena za kvadrat',          // rate anchor with no small word — same
    'stan od 90 м²',                  // bare sqm — a size fact, not a rate
  ];
  for (const t of negatives) {
    assert.equal(detectSmallerPerM2Ask(t), false, `must NOT fire: ${t}`);
  }
});

// ── GOLEM variant — the TOO-BIG complaint with NO rate anchor ───────────
// "GOLEM MI E NEKAKO" anchors on SIZE: the closest-smaller м² ranks first and
// any rate serves (the per-m² ceiling is not the client's spec here).

test('[00:12] "GOLEM MI E NEKAKO" → closest-smaller cards serve (even above-rate rows, bank-backed intro)', async () => {
  const { send, sessions } = await makeHandler();
  const chat = 'golem-complaint';
  await seedPresentation(send, sessions, chat);
  const r = await send(chat, 'GOLEM MI E NEKAKO');
  // Area-first, then biggest smaller м²: EB 44 (55 м², rate ABOVE the
  // anchor's — no ceiling in golem mode) and EB 41 (54 м²) both in Кисела
  // Вода rank ahead of out-of-area EB 42 (area integrity). 44's rate serving
  // proves the size anchor.
  assert.ok(r.includes('Евидентен број 44'), `above-rate smaller row serves on the size anchor: ${r}`);
  assert.ok(r.includes('Евидентен број 41'), `second in-area smaller card serves: ${r}`);
  assert.ok(!r.includes('Евидентен број 42'), 'out-of-area rows stay out while the area has candidates');
  assert.ok(!r.includes('Евидентен број 45'), 'bigger rows never serve');
  assert.ok(!r.includes('Евидентен број 37'), 'no info re-render of the anchored flat');
  assert.equal(sessions.get(chat)!.state, 'presentation');
});

test('"GOLEM MI E NEKAKO" with nothing smaller → honest line, no card, no rate doll', async () => {
  const rows: Property[] = [
    { eb: 37, id: 37, location: 'Кисела Вода', price: 117500, service: 'buy', bedrooms: 4, sqm: 90, size: '90 м²' },
    { eb: 45, id: 45, location: 'Кисела Вода', price: 117750, service: 'buy', bedrooms: 4, sqm: 95, size: '95 м²' },
  ] as unknown as Property[];
  const { send, sessions } = await makeHandler(rows);
  const chat = 'golem-none';
  await seedPresentation(send, sessions, chat);
  const r = await send(chat, 'GOLEM MI E NEKAKO');
  assert.ok(/немам/.test(r), `honest no-match: ${r}`);
  assert.ok(!/односно/.test(r), 'no info-doll re-render');
  const s = sessions.get(chat)!;
  assert.ok(!(s.slots.currentBatch ?? []).length, 'no batch on the empty pool');
});

test('golem detector: the complaint family fires; bigger-wishes, raise verbs and size questions never do', async () => {
  const { detectGolemComplaint } = await import('../src/llm/deterministic');
  const positives = [
    'GOLEM MI E NEKAKO',
    'golemo mi izgleda',
    'ми е голем',
    'stanot e golem',
    'ГОЛЕМА МИ Е КУќата',   // no '?' — a statement
  ];
  for (const t of positives) {
    assert.equal(detectGolemComplaint(t), true, `must fire: ${t}`);
  }
  const negatives = [
    'a nesto pogolem',     // wants bigger — the size-direction pivot owns it
    'najgolema marka',     // superlative morphology
    'zgolemete go limitot', // raise verb
    'golemina na stanot',  // the word is a noun (size QUESTION) — snippet form
  ];
  for (const t of negatives) {
    assert.equal(detectGolemComplaint(t), false, `must NOT fire: ${t}`);
  }
});

test('the bank seeds exist for all four smaller-lane keys', async () => {
  const { pickVariant } = await import('../src/data/responseBank');
  for (const key of ['smaller.perM2.intro', 'smaller.perM2.empty', 'golem.smaller.intro', 'golem.smaller.empty']) {
    const v = pickVariant(key);
    assert.ok(v && v.length > 0, `seed variant for ${key} serves`);
    assert.ok(!/为您|bispo|barley|vivid/.test(v), `seed for ${key} carries no draft junk`);
  }
});
