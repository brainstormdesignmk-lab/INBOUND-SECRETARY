// BARE BUDGET-UP direction split (the [25:2x] queue, three same-day misroutes):
// "DAJ NESTO POSKAPO TOGAS", "a nesto poskapo vo Centar?" (#251/#252) reached
// the NEGOTIATE fast lane — the old NEGOTIATE_RE carried the bare comparatives
// — and served the fixed-prices owner-contact pitch at a client asking for a
// WIDER, pricier selection. Direction split contract, pinned here:
//   price DOWN (namali / pomala cena / korekcija …)   → detectNegotiate
//   bare price UP (poskapo, no cap word, no copula)   → detectBudgetUpAsk
//   price UP with a cap ("i poskapo, nad 300")        → detectExplicitWiden RAISE
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectBudgetUpAsk, detectNegotiate, fsmRequired, detectExplicitWiden,
} from '../src/llm/deterministic';
import { FIXED_SEEDS } from '../src/data/responseBank';

// ── detector layer ───────────────────────────────────────────────────────────
test('detector: the bare upward ask family routes BUDGET UP in both scripts', () => {
  for (const t of [
    'DAJ NESTO POSKAPO TOGAS',                            // #251, the queue capture
    'daj nesto poskapo togas',
    'a nesto poskapo vo centar?',                         // #252 shape
    'nesto poskapo nesto vo centar',                      // area slot, both word orders
    'nesto poskapo vo centar',
    'POSKAPO NESTO VO CENTAR',                            // Cyrillic caps
    'име нешто поскапо?',                                 // full Cyrillic question
    'nesto poskapo?',
  ] as string[]) {
    assert.equal(detectBudgetUpAsk(t), true, `bare upward ask lost: ${t}`);
    assert.equal(detectNegotiate(t), false, `negotiate still claims an upward ask: ${t}`);
  }
});

test('detector: price-DOWN traffic keeps the negotiate lane (the direction split is one-way)', () => {
  for (const t of [
    'BI SAKAL DA SE NAMALI MALKU',                        // the 22:10 transcript family
    'moze li pomala cena',
    'може ли помала цена',
    'dali e vozmozna korekcija na cenata?',
    'moze li da se dogovorime za cena',
  ]) {
    assert.equal(detectNegotiate(t), true, `downward ask lost: ${t}`);
  }
});

test('detector: remark shapes never become budget-up searches', () => {
  for (const t of [
    'поскапо е овој',                                     // copula after
    'ovoj е poskapo',                                     // copula before
    'ovoj e poskapo',                                     // latin copula
    'поскапо од онаа',                                    // comparison
  ]) {
    assert.equal(detectBudgetUpAsk(t), false, `remark routed up: ${t}`);
  }
});

test('detector: with-number forms keep the RAISE-THE-CAP class, never the bare lane', () => {
  for (const t of [
    'A NESTO POSKAPO DO 1000 EVRA',                       // the stuck.h discovery row
    'i poskapo moze, nad 300',
    'i do 300 da bide',
  ]) {
    assert.equal(detectBudgetUpAsk(t), false, `bare lane stole a with-number form: ${t}`);
  }
  assert.equal(detectExplicitWiden('i poskapo moze, nad 300'), true, 'RAISE-THE-CAP lost');
  assert.equal(detectExplicitWiden('a nesto poskapo vo centar'), true,
    'bare upward family did not reach the widen family');
});

test('detector: the bare upward ask must reach the classifier when nothing is bound', () => {
  assert.equal(fsmRequired('a nesto poskapo vo centar?'), true);
});

test('bank: the upward intro key exists and names no amount', () => {
  const seeds = FIXED_SEEDS['pricier.search.intro'];
  assert.ok(Array.isArray(seeds) && seeds.length >= 2, 'pricier.search.intro seed pool too thin');
  for (const v of seeds) {
    assert.ok(!/\d/.test(v), `seed must not name an amount: ${v}`);
    assert.ok(/поскап|поголем буџет/i.test(v), `seed must name the upward direction: ${v}`);
    // Macedonian is impersonal here: «Се разбира». The Serbian calque
    // «Разбира се» shipped once and the [00:26] capture read it as broken.
    assert.ok(!/Разбира се/i.test(v), `seed must say «Се разбира», not «Разбира се»: ${v}`);
  }
});

// ── e2e: the handler serves a PRICIER batch, never the negotiate copy ────────
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

const ROWS: Property[] = [
  { eb: 80, id: 80, location: 'Кисела Вода', price: 46000, service: 'buy' },
  { eb: 46, id: 46, location: 'Кисела Вода', price: 72300, service: 'buy' },
  { eb: 91, id: 91, location: 'Кисела Вода', price: 85000, service: 'buy' },
  { eb: 92, id: 92, location: 'Кисела Вода', price: 95000, service: 'buy' },
  { eb: 55, id: 55, location: 'Влае', price: 40000, service: 'buy' },
];

function makeHandler(): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent };
}

test('e2e [25:2x]: "DAJ NESTO POSKAPO TOGAS" after a presentation serves the pricier batch — never price.negotiate', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'budget-up';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // 1) the search builds the funnel (Кисела Вода, до 50.000 → rows around it)
  await send('SAKAM DA KUPAM STAN VO KISELA VODA, 2 SPALNI, DO 50000 EVRA');
  assert.ok(sent[0].includes('Евидентен број'), 'presentation never fired: ' + sent[0]);

  // 2) the BARE upward ask: same characteristics, prices strictly ABOVE the
  //    shown ones, priciest-first, already-shown rows excluded.
  const s = await send('DAJ NESTO POSKAPO TOGAS');
  const reply = sent[sent.length - 1];
  assert.equal(s.state, 'presentation', 'state regressed: ' + s.state);
  assert.ok(!/фиксна|сопственикот/.test(reply), `the negotiate copy served an upward ask: ${reply}`);
  assert.ok(/Евидентен број 9[12]/.test(reply), `no pricier batch served: ${reply}`);
  // The anchor (already-shown 46/80) is excluded — a re-served cheaper row
  // would be the same loop the lane exists to break.
  assert.ok(!reply.includes('Евидентен број 80') && !reply.includes('Евидентен број 46'), reply);

  // 3) the REMARK shape ("поскапо е овој") stays with the eval lanes — no new
  //    batch, no funnel churn.
  const before = sent.length;
  await send('ПОСКАПО Е ОВОЈ');
  const remark = sent.slice(before).join(' ');
  assert.ok(!/Евидентен број 9[12]/.test(remark), `pricier batch stolen by the remark veto: ${remark}`);
});
