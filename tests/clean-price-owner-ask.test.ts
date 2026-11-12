// THE CLEAN PRICE — the owner's own figure, the final price that follows it,
// and the two client sentences it produces.
//
// The owner's 2026-11-11 brief: the availability ask must ALSO confirm the
// price — "DALI OSTANUVA DOGOVORENATA CISTA CENA …" for a sale, the monthly
// rent for a rental. The clean price lives in its own app field ABOVE the final
// price (owner-only data, never served to a client), and when the owner gives a
// new figure the FINAL price is recomputed with Ana's outbound arithmetic
// (outbound_final/property-intelligence.js):
//
//   commission = round(clean × agency% / 100)      // 2 % default
//   final      = clean + commission
//   client     = roundUpTo500(final)               // 126 001 → 126 500
//
// The client hears both figures at arranging time and decides for himself, and
// a complaint about the difference is answered with the sanctioned line
// (owners may reprice without telling the agency).

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { PriceChangeStore } from '../src/store/priceChanges';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { detectOwnerVerdict } from '../src/llm/deterministic';
import {
  computeFinalFromClean, roundUpTo500, buildOwnerCleanPriceQuestion,
  buildPriceChangeNotice, PRICE_CHANGE_DISCLAIMER, DEFAULT_AGENCY_PERCENT,
} from '../src/pricing/cleanPrice';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// EB 42: clean 80.000, final 81.600 (2 % = 1.600) — the classic mismatch a
// client sees as "the ad said 80.000 … actually 81.600".
const SALE: Property = {
  eb: 42, id: 42, location: 'Центар', address: 'Македонија 12', price: 81600,
  cleanPrice: 80000, bedrooms: 2, sqm: 60, size: '60 м²', service: 'buy',
  lat: 41.9957, lon: 21.4314, geo_source: 'stored', details: '',
} as Property;
const RENT: Property = {
  eb: 77, id: 77, location: 'Карпош', address: 'Партизанска 5', price: 450,
  cleanPrice: 450, bedrooms: 1, sqm: 35, size: '35 м²', service: 'rent',
  lat: 42.0021, lon: 21.4061, geo_source: 'stored', details: '',
} as Property;

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id || r.eb === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(rows: Property[] = [SALE]) {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const properties = new FakeProps(rows);
  const priceChanges = new PriceChangeStore(db);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    priceChanges,
    channels,
  });
  const asks: string[] = [];
  handler.onOwnerAsk = (_c, _eb, q) => asks.push(q);
  const chatId = 'cleanprice';
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  const seed = (eb = 42) => {
    const s = freshSession('test', chatId);
    s.state = 'visit_scheduling';
    s.slots.propertyId = eb;
    s.slots.interestedPropertyId = eb;
    s.slots.presentedIds = [eb];
    s.slots.currentBatch = [eb];
    s.slots.service = rows.find(r => r.eb === eb)?.service === 'rent' ? 'rent' : 'buy';
    s.slots.viewingFeeAgreed = true;
    s.slots.feeDisclosed = true;
    s.slots.name = 'Дејан Узунов';
    s.slots.phone = '076845234';
    sessions.set(s);
    return s;
  };
  const propose = async (term: string) => {
    await say(term);
    assert.equal(sessions.get(chatId)!.state, 'owner_checking', `setup: the owner must be checking (${term})`);
    sent.length = 0;
  };
  const apply = async (v: ReturnType<typeof detectOwnerVerdict>, eb = 42) => {
    sent.length = 0;
    handler.ownerAnswer(chatId, eb, v!);
    await new Promise(r => setTimeout(r, 150));
    return sent.at(-1) ?? '';
  };
  return { handler, sessions, sent, asks, chatId, say, seed, propose, apply, priceChanges, db };
}

// ── Ana's arithmetic, pinned ────────────────────────────────────────────────
test('roundUpTo500 is Ana’s round-UP (126 001 → 126 500, 126 501 → 127 000)', () => {
  assert.equal(roundUpTo500(126001), 126500);
  assert.equal(roundUpTo500(126320), 126500);
  assert.equal(roundUpTo500(126499), 126500);
  assert.equal(roundUpTo500(126500), 126500);
  assert.equal(roundUpTo500(126501), 127000);
});

test('a clean price becomes the final price with the agency % and the round-up', () => {
  // 80.000 + 2 % (1.600) = 81.600 → 82.000
  const f = computeFinalFromClean(80000)!;
  assert.equal(f.commission, 1600);
  assert.equal(f.finalPrice, 81600);
  assert.equal(f.sellingPrice, 82000);
  assert.equal(f.agencyPercent, DEFAULT_AGENCY_PERCENT);
  // A custom percentage is honoured (3 % on 100.000 = 3.000 → 103.000).
  const g = computeFinalFromClean(100000, 3)!;
  assert.equal(g.commission, 3000);
  assert.equal(g.sellingPrice, 103000);
  // A nonsense clean price never produces a price.
  assert.equal(computeFinalFromClean(0), undefined);
  assert.equal(computeFinalFromClean(Number.NaN), undefined);
});

test('the owner question names HIS figure, and only for the service he has', () => {
  assert.match(buildOwnerCleanPriceQuestion(80000, 'buy'), /чиста цена/u);
  assert.match(buildOwnerCleanPriceQuestion(80000, 'buy'), /80\.000/u);
  assert.match(buildOwnerCleanPriceQuestion(450, 'rent'), /чиста месечна кирија/u);
  assert.match(buildOwnerCleanPriceQuestion(450, 'rent'), /450/u);
  // No figure on file → no question at all (never a made-up amount).
  assert.equal(buildOwnerCleanPriceQuestion(undefined, 'buy'), '');
});

test('the notice names both figures and asks whether he still wants the visit', () => {
  const n = buildPriceChangeNotice(42, 81600, 84000);
  assert.match(n, /42/u);
  assert.match(n, /81\.600/u);
  assert.match(n, /84\.000/u);
  assert.match(n, /\?$/u);
});

// ── The ask on the wire ────────────────────────────────────────────────────
test('the FIRST owner ask carries the clean-price question', async () => {
  const h = makeHandler();
  h.seed();
  await h.propose('ПЕТОК ВО 18:00');
  const ask = h.asks.at(-1) ?? '';
  assert.match(ask, /чиста цена/iu, `the owner is asked about his own price: ${ask}`);
  assert.match(ask, /80\.000/u, ask);
  // The client never sees the clean figure.
  assert.deepEqual(h.sent, []);
});

test('no clean price on file → no price question, the ask is unchanged', async () => {
  const bare = { ...SALE, eb: 43, id: 43, cleanPrice: undefined } as Property;
  const h = makeHandler([bare]);
  h.seed(43);
  await h.say('ПЕТОК ВО 18:00');
  const ask = h.asks.at(-1) ?? '';
  assert.doesNotMatch(ask, /чиста цена/iu, ask);
});

test('the SECOND owner turn does not repeat the price question', async () => {
  const h = makeHandler();
  h.seed();
  await h.propose('ПЕТОК ВО 18:00');
  const first = h.asks.at(-1) ?? '';
  assert.match(first, /чиста цена/iu);
  // The owner counters at 17:00; the client does not take it and proposes
  // another term → the SECOND owner turn must not repeat the price ask.
  h.sent.length = 0;
  await h.apply(detectOwnerVerdict('НЕКА БИДЕ 5', 'ПЕТОК ВО 18:00'));
  h.sent.length = 0;
  await h.say('НЕ, САКАМ ВТОРНИК ВО 18:00');
  assert.equal(h.sessions.get(h.chatId)!.state, 'owner_checking');
  const second = h.asks.at(-1) ?? '';
  assert.match(second, /Клиентот|Предлог/iu, `the follow-up shapes the ask: ${second}`);
  assert.doesNotMatch(second, /чиста цена/iu, `the price is already known — asked once: ${second}`);
});

// ── The owner's answer ─────────────────────────────────────────────────────
test('the owner keeping his clean price records nothing', async () => {
  const h = makeHandler();
  h.seed();
  await h.propose('ПЕТОК ВО 18:00');
  const reply = await h.apply(detectOwnerVerdict('DA, OSTANUVA CENATA. MOZE VO 6', 'ПЕТОК ВО 18:00'));
  assert.equal(h.priceChanges.listPending().length, 0, 'no change was dictated');
  assert.doesNotMatch(reply, /81\.600|84\.000/u, `no price notice: ${reply}`);
});

test('a new clean price is recomputed into the FINAL price and queued for Hermes', async () => {
  const h = makeHandler();
  h.seed();
  await h.propose('ПЕТОК ВО 18:00');
  // Owner: accept 18:00 and re-quote his own figure at 82.000 → final 84.000
  // (82.000 + 2 % = 83.640 → round UP to 84.000).
  const v = detectOwnerVerdict('MOZE VO 6, A ZA CENATA 82.000 EVRA', 'ПЕТОК ВО 18:00');
  assert.equal(v?.price, 82000, `the owner's figure parses: ${JSON.stringify(v)}`);
  const reply = await h.apply(v);
  const rows = h.priceChanges.listPending();
  assert.equal(rows.length, 1, `one queued correction: ${JSON.stringify(rows)}`);
  assert.equal(rows[0].newPrice, 84000, `the QUEUED price is the final one: ${JSON.stringify(rows[0])}`);
  assert.equal(rows[0].source, 'owner-clean');
  const raw = h.db.db.prepare(
    `SELECT clean_old as cleanOld, clean_new as cleanNew, agency_percent as pct FROM price_changes`).get() as
    { cleanOld: number; cleanNew: number; pct: number };
  assert.deepEqual(raw, { cleanOld: 80000, cleanNew: 82000, pct: 2 });
  // The client hears BOTH figures and decides, and never the clean price.
  assert.match(reply, /81\.600/u, `the ad price is named: ${reply}`);
  assert.match(reply, /84\.000/u, `the current price is named: ${reply}`);
  assert.match(reply, /Дали сè уште сакате посета/u, reply);
  assert.doesNotMatch(reply, /82\.000/u, `the owner's clean figure never reaches the client: ${reply}`);
  // A moved price means the visit is NOT booked on the owner's yes: the client
  // decides first (his own yes runs the booking seam).
  assert.equal(h.sessions.get(h.chatId)!.state, 'time_confirm', 'the client closes the visit');
  assert.doesNotMatch(reply, /Договорена посета/u, `nothing locked behind his back: ${reply}`);
  // …and his yes books it at the owner's term.
  h.sent.length = 0;
  const booked = await h.say('ДА, САКАМ ПОСЕТА');
  assert.match(booked, /Договорена посета/u, `the client's yes books the visit: ${booked}`);
});

// THE PUBLISHED-PRICE SIBLING (the [09:54] field capture). A row WITHOUT a
// clean price is asked about the figure the client is looking at, and the owner
// answered: «СЛОБОДНА Е ДА , АМА КИРИЈАТА Е 300 ЕВРА. ПРВА КИРИЈА + ЕДНА
// ДЕПОЗИТ КИРИЈА БАРАМ». Lina relayed the change — and booked the visit in the
// SAME turn («Договорена посета … Петок, 13.11.2026 во 18:00»), so the client
// never had his own turn on the new money. The clean-price branch armed the
// gate (`priceChangePending`); this one forgot to, and the gate is the only
// thing between an owner's new figure and a locked appointment.
const RENT_NO_CLEAN: Property = {
  eb: 50, id: 50, location: 'Центар', address: 'Партизанска 7', price: 250,
  bedrooms: 1, sqm: 40, size: '40 м²', service: 'rent',
  lat: 42.0004, lon: 21.4321, geo_source: 'stored', details: '',
} as Property;

test('[09:54] a changed PUBLISHED price is the client’s decision, never a booking on the owner’s yes', async () => {
  const h = makeHandler([RENT_NO_CLEAN]);
  h.seed(50);
  await h.propose('ПЕТОК ВО 18:00');
  // The ask confirms the figure the client is looking at (there is no clean one).
  assert.match(h.asks.at(-1) ?? '', /250/u, `the owner is asked about the published rent: ${h.asks.at(-1)}`);

  const v = detectOwnerVerdict('СЛОБОДНА Е ДА , АМА КИРИЈАТА Е 300 ЕВРА. ПРВА КИРИЈА + ЕДНА ДЕПОЗИТ КИРИЈА БАРАМ', 'ПЕТОК ВО 18:00');
  assert.equal(v?.status, 'ok', `the owner confirmed the flat is free: ${JSON.stringify(v)}`);
  assert.equal(v?.price, 300, `his new rent parses: ${JSON.stringify(v)}`);
  const reply = await h.apply(v, 50);

  // The client hears the change…
  assert.match(reply, /300/u, `the new rent reaches him: ${reply}`);
  assert.match(reply, /\?\s*$/u, `and he is asked, never told: ${reply}`);
  // …and NOTHING is booked behind his back.
  assert.doesNotMatch(reply, /Договорена посета/u, `no appointment yet: ${reply}`);
  assert.equal(h.sessions.get(h.chatId)!.state, 'time_confirm', 'the client closes the visit himself');
  assert.equal(h.sessions.get(h.chatId)!.slots.priceChangePending, true, 'the gate is armed');
  const finalized = (h.db.db.prepare(
    `SELECT COUNT(*) as c FROM appointments WHERE status = 'finalized'`).get() as { c: number }).c;
  assert.equal(finalized, 0, 'no finalized appointment on the owner’s word alone');
  const queued = h.priceChanges.listPending();
  assert.equal(queued.length, 1, `the change is queued for Hermes: ${JSON.stringify(queued)}`);
  assert.equal(queued[0]!.newPrice, 300, 'a rent carries no markup — the clean rent IS the monthly rent');

  // His own yes runs the booking seam, at the owner's term.
  h.sent.length = 0;
  const booked = await h.say('ДА, САКАМ ПОСЕТА');
  assert.match(booked, /Договорена посета/u, `his yes books it: ${booked}`);
});

test('a complaint about the moved price gets the owners-may-reprice line', async () => {
  const h = makeHandler();
  h.seed();
  await h.propose('ПЕТОК ВО 18:00');
  await h.apply(detectOwnerVerdict('MOZE VO 6, A ZA CENATA 82.000 EVRA', 'ПЕТОК ВО 18:00'));
  const complaint = await h.say('ЗОШТО Е ПОСКАПА ОД ОГЛАСОТ?');
  assert.equal(complaint, PRICE_CHANGE_DISCLAIMER, `the sanctioned text, verbatim: ${complaint}`);
});

test('a plain price question is not a complaint and keeps its lane', async () => {
  const h = makeHandler();
  h.seed();
  await h.propose('ПЕТОК ВО 18:00');
  await h.apply(detectOwnerVerdict('MOZE VO 6, A ZA CENATA 82.000 EVRA', 'ПЕТОК ВО 18:00'));
  const answer = await h.say('КОЛКУ Е ЦЕНАТА?');
  assert.notEqual(answer, PRICE_CHANGE_DISCLAIMER, `not the disclaimer: ${answer}`);
});

test('a corrected clean rent becomes the rent itself (no markup on rent)', async () => {
  const h = makeHandler([RENT]);
  h.seed(77);
  await h.say('ПЕТОК ВО 18:00');
  const ask = h.asks.at(-1) ?? '';
  assert.match(ask, /чиста месечна кирија/iu, ask);
  const v = detectOwnerVerdict('MOZE VO 6, A KIRIJATA E 500 EVRA', 'ПЕТОК ВО 18:00');
  assert.equal(v?.price, 500, JSON.stringify(v));
  h.sent.length = 0;
  h.handler.ownerAnswer(h.chatId, 77, v!);
  await new Promise(r => setTimeout(r, 150));
  const rows = h.priceChanges.listPending();
  assert.equal(rows.at(-1)?.newPrice, 500, `the rent is the price: ${JSON.stringify(rows)}`);
  assert.match(h.sent.at(-1) ?? '', /500/u, h.sent.at(-1) ?? '');
});
