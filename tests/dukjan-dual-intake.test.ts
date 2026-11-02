// THE [23:10] CAPTURE — a cold general ask answered with «За кое конкретно
// станува збор? Кажете ми Евидентен број и ѝе Ви ја соопштам цената.»
//
//   [23:10] MI TREBA DUKJAN VO CENTAR
//   [23:11] MOZE DA GO IZNAJMAM , A AKO IMA DOBRA CENA MOZE I DA KUPAM
//   [23:11] ZAVISI
//   [23:11] ЛИНА: «За кое конкретно станува збор? Кажете ми Евидентен број…»  ✗
//
// The client has seen NO property. He is opening a hunt: business space in
// Центар, rent if the rent is right, buy if the price is right. Two rules were
// broken and one was missing:
//
//  1. `detectPriceAsk` claimed «…AKO IMA DOBRA CENA…» — a CONDITION, not a
//     quote request — and the price lane, having no property on the table,
//     asked for an Евидентен број the client cannot give. A message that
//     declares a service is criteria traffic, never a price question.
//  2. «може да изнајмам … може и да купам» was not read as BOTH services:
//     the pattern only knew buy-then-rent order, so one service was pinned
//     from the order he happened to say them in.
//  3. With both declared, the funnel must ask the specs (м², price) and then
//     serve — one of each segment while the flow has not decided yet — and it
//     must never ask «за купување или за изнајмување?» a turn after he said
//     both.
import { test } from 'node:test';
import assert from 'node:assert/strict';
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
import { OfflineMapStore } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';
import { setLearnedBank } from '../src/data/responseBank';
import { detectBothServices } from '../src/llm/deterministic';

setLearnedBank({
  variants: () => [], addVariant: () => false, addExample: () => false,
  metric: () => {}, retrieve: () => undefined,
} as any);

const cfg = loadConfig();
let offlineMap: OfflineMapStore | undefined;
const map = (): OfflineMapStore => (offlineMap ??= new OfflineMapStore(cfg.skopjePoisDb));

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

test('detectBothServices: rent-then-buy and buy-then-rent are the same answer', () => {
  for (const text of [
    'MOZE DA GO IZNAJMAM , A AKO IMA DOBRA CENA MOZE I DA KUPAM',
    'mozam da iznajmam, a moze i da kupam',
    'МОЖЕ ДА ИЗНАЈМАМ , А МОЖЕ И ДА КУПАМ',
    'мозе да го изнајмам , ако има добра цена мозе и да купам',
    'MOZE DA KUPAM , A MOZE I DA IZNAJMAM',
  ]) {
    assert.ok(detectBothServices(text), `both services must be read: ${text}`);
  }
});

// The bank: business space in Центар — rentals only (the feed's own shape:
// every деловен простор row is offered for rent), plus one apartment that must
// never enter a деловен простор serve.
const BIZ59: Property = {
  eb: 59, id: 59, uuid: 'b59', address: 'Палома Бјанка', location: 'Центар',
  service: 'rent', price: 950, business: true, sqm: 105, size: '105 м²',
} as Property;
const BIZ57: Property = {
  eb: 57, id: 57, uuid: 'b57', address: 'Строг Центар', location: 'Центар',
  service: 'rent', price: 1000, business: true, sqm: 80, size: '80 м²',
} as Property;
const FLAT: Property = {
  eb: 66, id: 66, uuid: 'f66', address: 'Рузвелтова 51', location: 'Центар',
  service: 'buy', price: 137000, bedrooms: 3, sqm: 79, size: '79 м²',
} as Property;

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://feed-not-used'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(p => p.eb === eb); }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(p => p.id === id); }
  get healthy(): boolean { return true; }
}

// A business space FOR SALE — the pair leg the live feed does not carry today.
const BIZ80: Property = {
  eb: 80, id: 80, uuid: 'b80', address: 'Македонија', location: 'Центар',
  service: 'buy', price: 150000, business: true, sqm: 80, size: '80 м²',
} as Property;

function makeHandler(rows: Property[] = [BIZ59, BIZ57, FLAT]): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps(rows);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions,
    classifier: new Classifier(llm, cfg, props),
    responder: new Responder(llm, cfg),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: map() }),
  });
  return { handler, sessions, sent };
}

test('a cold business ask with rent-or-buy intent asks the specs, never for an EB', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'dukjan';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  let s = await send('MI TREBA DUKJAN VO CENTAR');
  assert.equal(s.slots.business, true, 'the category is on file');
  assert.equal(s.slots.service, undefined, 'the service is still open');

  const beforeDual = sent.length;
  s = await send('MOZE DA GO IZNAJMAM , A AKO IMA DOBRA CENA MOZE I DA KUPAM');
  const reply = sent.slice(beforeDual).join('\n');
  assert.ok(!/Евидентен број/u.test(reply), `never the EB invite on a cold general ask: ${reply}`);
  assert.ok(!/конкретно станува збор/u.test(reply), `never the price clarify: ${reply}`);
  assert.equal(s.slots.dualService, true, `both segments stay alive: ${JSON.stringify(s.slots)}`);
  assert.equal(s.slots.service, undefined, 'no single service is pinned from word order');
  assert.match(reply, /м²|површина|квадрат/u, `the missing spec is asked: ${reply}`);
  assert.ok(!/купите или да го изнајмите|купување или за изнајмување/u.test(reply),
    `he just said both — never re-ask the service: ${reply}`);

  // The m² answer completes the funnel: business rows are served, no apartment.
  const beforeServe = sent.length;
  s = await send('PA OKO 80 M2');
  const served = sent.slice(beforeServe).join('\n');
  assert.equal(s.state, 'presentation', `the hunt is served: ${served}`);
  assert.match(served, /Евидентен број 5[79]/u, `business space serves: ${served}`);
  assert.ok(!/Евидентен број 66/u.test(served), `a flat never rides a business ask: ${served}`);
  assert.match(served, /деловен|деловниот|деловна/iu, `the cards speak the category: ${served}`);
});

test('an empty segment is NAMED, never silently replaced by the other leg', async () => {
  // The live feed's own shape: business space for rent only, nothing for sale.
  const { handler, sessions, sent } = makeHandler([BIZ59, BIZ57, FLAT]);
  const chatId = 'dukjan-empty'
  ;
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('MI TREBA DUKJAN VO CENTAR');
  await send('MOZE DA GO IZNAJMAM , A AKO IMA DOBRA CENA MOZE I DA KUPAM');
  const beforeServe = sent.length;
  const s = await send('PA OKO 80 M2');
  const served = sent.slice(beforeServe).join('\n');
  assert.equal(s.slots.dualService, true);
  assert.equal(s.slots.dualEmptyLeg, 'buy', 'the empty leg is recorded');
  assert.match(served, /немам[^.]*за купување/iu, `the missing segment is said out loud: ${served}`);
  assert.match(served, /за изнајмување/iu, `the served segment is named with it: ${served}`);
  assert.match(served, /Евидентен број 59/u, `the rent leg still serves: ${served}`);
  assert.ok(!/Евидентен број 66/u.test(served), `a flat never rides a business ask: ${served}`);

  // Said once per search: the next batch of the same search does not repeat it.
  const beforeNext = sent.length;
  await send('USTE EDNO');
  const next = sent.slice(beforeNext).join('\n');
  assert.ok(!/немам[^.]*за купување/iu.test(next), `the honesty line is not re-spoken: ${next}`);
});

test('a fully drained dual search says «ги покажав сите», never re-serves seen cards', async () => {
  // Two rentals, nothing for sale — both cards go out on the first batch, so the
  // next ask has NOTHING new in either leg.
  const { handler, sessions, sent } = makeHandler([BIZ59, BIZ57, FLAT]);
  const chatId = 'dukjan-drained';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('MI TREBA DUKJAN VO CENTAR');
  await send('MOZE DA GO IZNAJMAM , A AKO IMA DOBRA CENA MOZE I DA KUPAM');
  await send('PA OKO 80 M2');
  const before = sent.length;
  const s = await send('USTE EDNO');
  const reply = sent.slice(before).join('\n');
  assert.match(reply, /ги покажав сите/iu, `the drained search says so: ${reply}`);
  assert.ok(!/Евидентен број 5[79]/u.test(reply), `a seen card is never presented as new: ${reply}`);
  assert.ok(!/Евидентен број 66/u.test(reply), `no off-category refill either: ${reply}`);
  assert.equal(s.slots.dualService, true, 'the dual search stays on file');
  assert.equal(s.slots.dualDrained, false, 'the drained fact is spoken once');
});

test('rent-and-buy intent pairs one card per segment when both have stock', async () => {
  const { handler, sessions, sent } = makeHandler([BIZ59, BIZ80, FLAT]);
  const chatId = 'dukjan-pair';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('MI TREBA DUKJAN VO CENTAR');
  await send('MOZE DA GO IZNAJMAM , A AKO IMA DOBRA CENA MOZE I DA KUPAM');
  const beforeServe = sent.length;
  const s = await send('PA OKO 80 M2');
  const served = sent.slice(beforeServe).join('\n');
  assert.equal(s.slots.dualService, true);
  assert.equal(s.slots.dualEmptyLeg, undefined, 'no segment is empty');
  assert.match(served, /Евидентен број 59/u, `the RENT leg serves: ${served}`);
  assert.match(served, /Евидентен број 80/u, `the BUY leg serves in the same batch: ${served}`);
  assert.ok(!/немам[^.]*за (купување|изнајмување)/iu.test(served), `nothing to apologise for: ${served}`);
  assert.ok(!/Евидентен број 66/u.test(served), `a flat never rides a business ask: ${served}`);
});
