// The V16K11 second capture — two failures in one conversation.
//
//   (1) The client is a BUY searcher: 1-bedroom apartment (1 спална = 2-собен
//       под конвенцијата), до 100.000 евра. Lina exhausted the criteria-matched
//       options, asked the exhausted question („…или претпочитате да погледнеме
//       опции во друг дел од градот?“), and the client answered
//       „moze i drugi opcii“ — Lina served EB 55: a HOUSE in Vlae (240 м²,
//       40.000). The feed row says „Куќа / Повеќе соби“ but house was parsed
//       from the OPIS only („35.000 ЧИСТИ БАРА + 2%“ — no type word), so the
//       row mapped house:false/bedrooms:undefined → a wildcard that matches
//       an apartment search. Two layers fixed:
//         • feed mapper: tip_na_nedviznina / naslov type a row whose opis is
//           silent (EB 55 now maps house:true → excluded from стан searches);
//         • ladder guard: an explicit APARTMENT search (slots.house === false)
//           can never lead a batch with house/business-typed candidates.
//   (2) The client ended with "Se predomisliv / ke si piseme drugoat / moram
//       da prekina" — the burst rode the dynamic fallback into a farewell
//       WITHOUT the one last-chance question. New exit final-check: BEFORE
//       the farewell serve exit.criteria.check („Пред да се поздравиме…“).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InboundHandler } from '../src/handlers/inbound';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { SessionStore } from '../src/fsm/session';
import { PropertyService, Property, mapRow } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { LandmarkService } from '../src/geo/landmarks';
import { Db } from '../src/store/db';
import { loadConfig } from '../src/config';
import { RESPONSE_BANK } from '../src/data/responses';
import { setLearnedBank } from '../src/data/responseBank';
import { detectExitCheck, detectBye, detectSoftRefusal, detectHouse } from '../src/llm/deterministic';
import { EXIT_CRITERIA_CHECK, EXIT_CRITERIA_CHECK_2, EXIT_CRITERIA_CHECK_3 } from '../src/llm/prompts';

setLearnedBank({
  variants: () => [],
  addVariant: () => false,
  addExample: () => false,
  metric: () => {},
  retrieve: () => undefined,
} as any);

class FailingLlm { async complete(): Promise<string> { throw new Error('429 quota exhausted'); } }
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

// The live feed rows, mirrored from the production feed (V16K11 capture day):
// EB 46/54 are the criteria-matched pair (2-собен = 1 спална convention);
// EB 55 is the Vlae HOUSE that leaked into the apartment search.
const ROWS: Property[] = [
  { eb: 46, id: 46, location: 'Кисела Вода', price: 72000, service: 'buy', bedrooms: 2, sqm: 43, size: '43 м²', address: 'ул. 11 Октомври' },
  { eb: 54, id: 54, location: 'Карпош III', price: 69500, service: 'buy', bedrooms: 2, sqm: 35, size: '35 м²', address: 'ул. Јордан Ѓорќовски' },
  { eb: 55, id: 55, location: 'Влае', price: 40000, service: 'buy', sqm: 240, size: '240 м²', address: 'Мраморец 12а', house: true },
] as Property[];

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
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent };
}

const send10 = (handler: InboundHandler, sessions: SessionStore) =>
  async (m: string, chatId: string) => {
    await Promise.race([
      handler.handle('test', chatId, m),
      new Promise<never>((_, rej) => setTimeout(() => rej(new Error(`turn timeout (>10s): ${m.slice(0, 40)}`)), 10_000).unref()),
    ]);
    return sessions.get(chatId)!;
  };

// ── Layer 1: the feed mapper ─────────────────────────────────────────────────

test('mapRow: a house-typed row with a silent opis maps house:true (the EB 55 bug)', () => {
  const p = mapRow({
    evidenten_broj: '55', naslov: 'Куќа Повеќе соби', tip_na_nedviznina: 'Куќа',
    tip_na_sobi: 'Повеќе соби',
    naselba: 'Влае', adresa: 'Мраморец 12А', cena_eur: 40000, povrsina_m2: 240,
    servis: 'Продава', opis: '35.000 ЧИСТИ БАРА + 2%',
  });
  assert.ok(p);
  assert.equal(p!.house, true, 'the feed type fields must win over a detail-less opis');
  assert.equal(p!.business, false);
  // bedroom-less stays bedroom-less (Повеќе соби has no number)
  assert.equal(p!.bedrooms, undefined);
});

test('mapRow: opis still owns the type when it names one (no behavior change)', () => {
  // „стан во куќа" in the opis — the LEGACY rule (house from opis) stands.
  const flat = mapRow({
    evidenten_broj: '91', naslov: 'Објект', tip_na_nedviznina: 'Објект',
    naselba: 'Центар', cena_eur: 60000, povrsina_m2: 60,
    servis: 'Продава', opis: 'Се продава стан во куќа, реновиран.',
  });
  assert.ok(flat);
  // LEGACY BEHAVIOR PIN: the opis rule runs FIRST and its куќ stem matches
  // inside "стан во куќа" — such rows have always mapped house:true and keep
  // doing so (only rows whose opis names NO type fall through to the
  // structured columns). The live feed has no such row; if one ever appears
  // and mis-serves, that is a separate opis-stem fix, not a silent change.
  assert.equal(flat!.house, true, 'legacy opis rule (куќ stem) wins verbatim — стан во куќа stays house:true');
  // opis names the house explicitly → house:true exactly as before
  const hut = mapRow({
    evidenten_broj: '92', naslov: 'Објект', tip_na_nedviznina: 'Објект',
    naselba: 'Центар', cena_eur: 60000, povrsina_m2: 90,
    servis: 'Продава', opis: 'Се продава куќа со двор.',
  });
  assert.ok(hut);
  assert.equal(hut!.house, true);
});

// ── Layer 2: the ladder criteria-type guard ──────────────────────────────────

test('e2e: apartment buyer "moze i drugi opcii" NEVER gets the Vlae house, gets the criteria pair', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'v16k11-vlae';
  const send = send10(handler, sessions);

  // Open the funnel: service → buy/rent, then the location gap → "anywhere".
  // Search: 1 спална → bedrooms 2 (rooms convention), стан (→ house=false), buy, ≤100k.
  await send('BARAM STAN SO EDNA SPALNA DO 100000 EVRA', chatId);
  await send('DA, ZA KUPUVANJE', chatId);
  await send('otvoren sum', chatId);
  let reply = sent[sent.length - 1] ?? '';
  assert.ok(reply.includes('Евидентен број 46') || reply.includes('Евидентен број 54'),
    `first batch must be criteria-matched: ${reply.slice(0, 200)}`);
  assert.ok(!reply.includes('Евидентен број 55'), `the house must never ride an apartment batch: ${reply.slice(0, 200)}`);

  // Take the whole ladder down → the exhausted ask fires.
  for (let i = 0; i < 6; i++) await send('NE, DAJ DRUGO', chatId);
  const s = await send('moze i drugi opcii', chatId);
  reply = sent[sent.length - 1] ?? '';
  assert.ok(!/Евидентен број 55|куќа/iu.test(reply),
    `the widen/next serve must stay apartment-typed: ${reply.slice(0, 240)}`);
  if (/Евидентен број/.test(reply)) {
    assert.ok(/Евидентен број (46|54)/.test(reply), `cards must be the criteria pair: ${reply.slice(0, 240)}`);
  }
  void s;
});

// ── The exit final-check family ──────────────────────────────────────────────

test('exit detector: the live bursts owned, offer traffic and farewell lanes are not', () => {
  // the live capture, relay-burst and single-line shapes
  assert.equal(detectExitCheck('Se predomisliv\nke si piseme drugoat\nmoram da prekina'), true, 'the live relay burst');
  assert.equal(detectExitCheck('se predomisliv'), true);
  assert.equal(detectExitCheck('moram da prekina'), true);
  assert.equal(detectExitCheck('ke si piseme drugoat'), true);
  assert.equal(detectExitCheck('ke se cueme'), true, 'client spelling cueme');
  assert.equal(detectExitCheck('МОРАМ ДА ПРЕКИНАМ'), true, 'Cyrillic caps');
  assert.equal(detectExitCheck('mora da pauziram'), true);
  // keep their lanes
  assert.equal(detectExitCheck('cao'), false, 'pure bye keeps its lane');
  assert.equal(detectExitCheck('ne fala'), false, 'soft refusal keeps its lane');
  assert.equal(detectExitCheck('predomisliv sum, gi sakam drugite ponudi'), false, 'offer/choice veto');
  assert.equal(detectExitCheck('se predomisliv, sakam go prviot stan'), false, 'stan veto');
  assert.equal(detectExitCheck('koga moze poseta?'), false, 'question traffic');
  // the pure-exit detector still owns the simple farewells (no overlap drift)
  assert.equal(detectBye('cao'), true);
  assert.equal(detectSoftRefusal('ne fala'), true);
  assert.equal(detectHouse('predomisliv sum'), undefined, 'no type pollution');
});

test('exit.criteria.check bank: the two owner wordings present, amount/EB-free, ONE question', () => {
  const pool = RESPONSE_BANK['exit.criteria.check'] ?? [];
  const joined = pool.join('\n');
  // Both owner-dictated wordings must be reachable in the seed bank.
  assert.ok(pool.some(v => v.includes('Пред да се поздравиме')), `owner wording 1 missing: ${joined.slice(0, 200)}`);
  assert.ok(pool.some(v => v.includes('Пред да прекинеме')), `owner wording 2 missing: ${joined.slice(0, 200)}`);
  assert.ok(pool.length >= 3, `expected the 3 anchors at minimum, got ${pool.length}`);
  for (const v of pool) {
    assert.ok(v.length >= 20, `bank hygiene: ${v}`);
    assert.ok(/\?\s*$/u.test(v), `must END with the one question: ${v}`);
    assert.ok(!/\d|евр|денар|denar|evr/iu.test(v), `amount-free: ${v}`);
    // ИД/ID as a whole TOKEN — "Имајќи го предвид…" contains the substring.
    assert.ok(!/(?:^|[^\p{L}])и?d(?:$|[^\p{L}])/iu.test(v), `EB-free: ${v}`);
    // Farewell ban WITHOUT the поздравиме/поздравам false positive: the owner
    // wording says „Пред да се поздравиме…“ — a verb, not a farewell. Ban the
    // greeting only when поздрав is NOT verb-suffixed (име/ам/уваам…).
    assert.ok(!/(?:пријатно|чао|се\s+гледаме|поздрав(?![иау]))/iu.test(v), `no farewell inside: ${v}`);
  }
  assert.ok(/\?\s*$/u.test(EXIT_CRITERIA_CHECK), 'anchor 1 ends with the ask');
  assert.ok(/\?\s*$/u.test(EXIT_CRITERIA_CHECK_2), 'anchor 2 ends with the ask');
  assert.ok(/\?\s*$/u.test(EXIT_CRITERIA_CHECK_3), 'anchor 3 ends with the ask');
});

test('e2e: "moram da prekina" gets the exit-check QUESTION first — never a farewell, never a re-offer', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'v16k11-exit';
  const send = send10(handler, sessions);

  // A light funnel so the session is warm (not required by the lane — it is
  // state-free — but mirrors the live capture shape).
  await send('ZDRAVO', chatId);

  const s = await send('moram da prekina', chatId);
  const reply = sent[sent.length - 1] ?? '';
  assert.ok(/пред да (се поздравиме|прекинеме)|шанса|критериум/iu.test(reply),
    `not the exit check: ${reply.slice(0, 200)}`);
  assert.ok(/\?\s*$/u.test(reply), `must END with the question: ${reply.slice(0, 200)}`);
  assert.ok(!/најдобро!/iu.test(reply), `no farewell inside the check: ${reply.slice(0, 200)}`);
  assert.ok(!/Евидентен број/iu.test(reply), `no property cards in the check: ${reply.slice(0, 200)}`);
  assert.equal(s.slots.exitCheckServed, true, 'the check must flag once-per-session');

  // The client declines → the next turn keeps the PURE-exit farewell lane
  // (no repeated check).
  await send('ne', chatId);
  const bye = sent[sent.length - 1] ?? '';
  assert.ok(/најдобро!|Пријатно|Поздрав/iu.test(bye), `after the decline a farewell must come: ${bye.slice(0, 200)}`);
  assert.ok(!/шанса|критериум/iu.test(bye), `no repeated check: ${bye.slice(0, 200)}`);

  // A second exit-shaped burst → straight to the farewell lanes, no loop.
  await send('se predomisliv', chatId);
  const again = sent[sent.length - 1] ?? '';
  assert.ok(!/шанса|критериум/iu.test(again), `the check must fire once per session: ${again.slice(0, 200)}`);
});
