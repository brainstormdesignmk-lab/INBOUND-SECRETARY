// The [17:14] spec, second layer — "POMALO" is a SIZE INTENT, not a show-me.
//
// Transcript: client saw (implicitly big) options, then wrote
// "POMALO NESTO DO 300EVRA". First fix made the ≤300 budget land (the ladder
// stopped serving the 380€ card). This layer adds the OWNER'S SPEC: "помало"
// could mean a GARSONJERA or a small 1-BEDROOM flat — the bedrooms slot alone
// must not decide. So:
//   pomalo + budget known + size unknown → Lina ASKS "Колку спални соби…"
//   (bank-backed), STAYS in discovery, budget already stored;
//   the answer resolves small: "garsonjera" → studio pool (1-bedroom
//   fallback, honest prefix); "edna spalna" → bedrooms 1; "2 spalni" →
//   normal lane (2+ is not "small").
import { test } from 'node:test';
import assert from 'node:assert';
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

class FailingLlm implements LlmClient { async complete(): Promise<string> { throw new Error('429'); } }
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

function makeRows(): Property[] {
  return [
    { eb: 61, id: 61, location: 'Аеродром', price: 380, service: 'rent', bedrooms: 4, size: '78 м²' },
    { eb: 62, id: 62, location: 'Аеродром', price: 250, service: 'rent', bedrooms: 2, size: '32 м²' }, // 1-спална
    { eb: 63, id: 63, location: 'Аеродром', price: 280, service: 'rent', bedrooms: 3, size: '45 м²' }, // 2-спални
    { eb: 64, id: 64, location: 'Аеродром', price: 295, service: 'rent', bedrooms: 4, size: '60 м²' }, // 3-спални
    { eb: 65, id: 65, location: 'Аеродром', price: 420, service: 'rent', bedrooms: 5, size: '95 м²' },
    { eb: 66, id: 66, location: 'Кисела Вода', price: 260, service: 'rent', bedrooms: 2, size: '48 м²' }, // 1-спална
  ] as unknown as Property[];
}

async function makeHandler(rows: Property[]) {
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

test('[17:14] "POMALO NESTO DO 300EVRA" → bedrooms ask with budget stored, stays in discovery', async () => {
  const { send, sessions, sent } = await makeHandler(makeRows());
  const chat = 'pomalo-ask';
  await send(chat, 'SAKAM DA IZNAJMAM STAN');
  await send(chat, 'PA AERODROM ILI KISELA VODA BI ODGOVARALO NAJMNOGU');
  const r = await send(chat, 'POMALO NESTO DO 300EVRA');
  const s = sessions.get(chat)!;
  assert.ok(r.includes('спални'), `the reply must ask bedrooms: ${r}`);
  assert.equal(s.state, 'discovery', 'stays in discovery — no card guess');
  assert.equal(s.slots.budget, '300', 'the budget from the same message is stored');
  assert.equal(s.slots.pomaloSize, true, 'the pomalo intent is armed');
  assert.ok(!(s.slots.currentBatch ?? []).length, 'no cards presented');
  assert.ok(!sent.at(-1)!.includes('Евидентен број'), 'no EB card in the reply');
});

test('pomalo answered with "garsonjera" → studio ask (≤35 м²), 1-bedroom fallback when none, honest prefix', async () => {
  // Pool has NO garsonjera (35 м² tagged small units) — the ladder must fall
  // to one-bedroom flats and say so honestly.
  const { send, sessions, sent } = await makeHandler(makeRows());
  const chat = 'pomalo-garsonjera';
  await send(chat, 'SAKAM DA IZNAJMAM STAN');
  await send(chat, 'PA AERODROM ILI KISELA VODA BI ODGOVARALO NAJMNOGU');
  await send(chat, 'POMALO NESTO DO 300EVRA');
  const r2 = await send(chat, 'GARSONJERA');
  const s = sessions.get(chat)!;
  assert.equal(s.slots.garsonjera, true);
  assert.equal(s.slots.pomaloSize, undefined, 'the pomalo flag retires on the studio answer');
  // No studio in the seeded pool → the honest relaxed line + 1-спална cards.
  assert.ok(/гарсоњер|станче|помал/i.test(r2), `honest prefix: ${r2}`);
  assert.ok(r2.includes('Евидентен број 62') || r2.includes('Евидентен број 66'), `1-спална fallback cards serve: ${r2}`);
  assert.ok(!r2.includes('61') && !r2.includes('65'), 'big units never serve');
});

test('pomalo answered with "edna spalna" → bedrooms 1, in-budget small cards, never the 380€', async () => {
  const { send, sessions } = await makeHandler(makeRows());
  const chat = 'pomalo-1bed';
  await send(chat, 'SAKAM DA IZNAJMAM STAN');
  await send(chat, 'PA AERODROM ILI KISELA VODA BI ODGOVARALO NAJMNOGU');
  await send(chat, 'POMALO NESTO DO 300EVRA');
  await send(chat, 'EDNA SPALNA');
  const s = sessions.get(chat)!;
  assert.equal(s.slots.bedrooms, 2, 'feed convention: 1 спална = 2-rooms');
  assert.equal(s.slots.pomaloSize, undefined, 'pomalo retires on the size answer');
  for (const id of s.slots.currentBatch ?? []) {
    const row = makeRows().find(p => p.id === id)!;
    assert.ok((row.price as number) <= 300, `EB ${id} at ${row.price}€ exceeds ≤300`);
    assert.ok((row.bedrooms as number) <= 3, `EB ${id} is not a small unit`);
  }
});

test('pomalo answered with "dve spalni" → normal lane (2+ bedrooms is not "small")', async () => {
  const { send, sessions } = await makeHandler(makeRows());
  const chat = 'pomalo-2bed';
  await send(chat, 'SAKAM DA IZNAJMAM STAN');
  await send(chat, 'PA AERODROM ILI KISELA VODA BI ODGOVARALO NAJMNOGU');
  await send(chat, 'POMALO NESTO DO 300EVRA');
  const r = await send(chat, 'DVE SPALNI');
  const s = sessions.get(chat)!;
  assert.equal(s.slots.bedrooms, 3, 'feed convention: 2 спални = 3-rooms');
  assert.equal(s.slots.pomaloSize, undefined, '2+ bedrooms clears the pomalo intent');
  assert.ok(r.includes('Евидентен број'), `normal presentation serves: ${r}`);
});

test('bare "nesto pomalo" with no criteria at all still asks bedrooms (never crashes, never presents)', async () => {
  const { send, sessions } = await makeHandler(makeRows());
  const chat = 'pomalo-bare';
  await send(chat, 'SAKAM DA IZNAJMAM STAN');
  const r = await send(chat, 'NESTO POMALO');
  const s = sessions.get(chat)!;
  assert.ok(r.includes('спални'), `bedrooms ask: ${r}`);
  assert.equal(s.state, 'discovery');
  assert.equal(s.slots.budget, undefined);
  assert.equal(s.slots.pomaloSize, true);
});

test('pomalo ask fires ONCE — the follow-up answer never re-asks', async () => {
  const { send, sent } = await makeHandler(makeRows());
  const chat = 'pomalo-once';
  await send(chat, 'SAKAM DA IZNAJMAM STAN');
  await send(chat, 'POMALO NESTO DO 300EVRA');
  const ask1 = sent.at(-1)!;
  await send(chat, 'EDNA SPALNA');
  const ask2 = sent.at(-1)!;
  assert.ok(ask1.includes('спални'));
  assert.ok(!ask2.includes('Колку спални соби би сакале'), `no re-ask after the answer: ${ask2}`);
});

// ── the grammar-based family (owner enrichment spec) ────────────────────
// Stem + declension (gender/number/definiteness), comparative по-/po-,
// superlative нај-/naj-, diminutive малецок/малечок, the kompakt/мини
// families — in BOTH scripts. Excluded structurally: bare quantity (малку),
// money modifiers ("помала цена" belongs to the price lanes).

test('detectPomaloAsk: the small-adjective family across declension, both scripts, both transliterations', async () => {
  const { detectPomaloAsk } = await import('../src/llm/deterministic');
  const positives = [
    'NESTO POMALO', 'POMALO NESTO DO 300EVRA', 'pomalo', 'nesto malo', 'MALO',
    'pomala', 'pomali', 'najmala', 'najmalo mozno', 'nesto malecko', 'МАЛЕЦОК',
    'мало', 'помала', 'најмал', 'малиот', 'mali', 'stanot e mal',
    'edno malo stanče', 'mala soba', 'baram kompakten stan', 'kompaktno',
    'КОМПАКТНО', 'kompaktni', 'malo malecko', 'minimalno', 'MINIMALNA',
    'minimalen', 'pomalo pomalo',
  ];
  for (const t of positives) {
    assert.equal(detectPomaloAsk(t), true, `must fire: ${t}`);
  }
});

test('detectPomaloAsk: money modifiers and bare quantity never fire', async () => {
  const { detectPomaloAsk } = await import('../src/llm/deterministic');
  const negatives = [
    'pomala cena', 'ПОМАЛА ЦЕНА', 'mala kirija', 'cenata da e pomala',
    'najmala cena?', 'kirija mala', 'minimalna cena', 'kompaktna kirija',
    'malku', 'malku poveke', 'МАЛКУ',
    'neznam', 'odobrenie', 'shto imate vo ponuda',
  ];
  for (const t of negatives) {
    assert.equal(detectPomaloAsk(t), false, `must NOT fire: ${t}`);
  }
});
