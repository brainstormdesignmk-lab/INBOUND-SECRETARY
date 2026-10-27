/**
 * E2E Gjorce-area tests (the [13:48] wine capture).
 *
 * Mirrors tests/widen-flow.test.ts: local FailingLlm + FakeProps + send helper.
 * The deterministic path never touches the LLM, so a throwing stub is a
 * faithful stand-in.
 *
 * Capture under test ([13:47–13:49] client transcript):
 *   VO KOJA NASELBA SE NAJEFTINI STANOVITE   ← naselba-comparison aggregate
 *   NESTO VO GJORCE IMA?                     ← the AREA ask
 *   → answered with a Влае house (EB 55!) and a Кисела Вода studio: the
 *     latinization "gjorce" had NO alias in LAT_ALIASES, so the ask never
 *     resolved the area and the type-less funnel served a CITY-WIDE pool.
 *
 * Contracts pinned here:
 *   (1) "gjorce" resolves to Ѓорче Петров (detectLocation + LAT_ALIASES).
 *   (2) HISTORY-TYPE MEMORY: an area ask that names no property type follows
 *       the conversation — the [13:47] talk was STANOVITE, so the serve stays
 *       inside apartments (no house card in an apartments talk), and a house
 *       conversation serves the Gjorce house.
 *   (3) None-in-area protocol: when the wanted naselba has nothing of that
 *       type, she says so — naming Ѓорче Петров — and asks about other
 *       neighborhoods; she never silently serves other areas.
 */
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
import { detectLocation } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  // The Gjorce apartment the apartments talk must elevate (garsoņera-style row).
  { eb: 80, id: 80, location: 'Ѓорче Петров', address: 'ул. Јандрињска 1', city: 'Скопје',
    price: 46000, service: 'buy', sqm: 24, size: '24 м²', house: false, studio: true, bedrooms: undefined,
    details: 'Гарсоњера во Ѓорче Петров, наместена, лифт.' },
  // The Gjorce HOUSE — forbidden in an apartments talk, required in a house talk.
  { eb: 90, id: 90, location: 'Ѓорче Петров', address: 'ул. Мишевска 4', city: 'Скопје',
    price: 90000, service: 'buy', sqm: 120, size: '120 м²', house: true, bedrooms: undefined,
    details: 'куќа со двор' },
  // The Влае house from the real capture — the [13:48] wrong-category card.
  { eb: 55, id: 55, location: 'Влае', address: 'Мраморец 12а', city: 'Скопје',
    price: 40000, service: 'buy', sqm: 240, size: '240 м²', house: true, bedrooms: undefined,
    details: 'куќа со двор и гаража' },
  // A city-pool apartment decoy in Маџари — the OTHER wrong-area card shape.
  { eb: 33, id: 33, location: 'Маџари', address: 'ул. nowhere 3', city: 'Скопје',
    price: 68300, service: 'buy', sqm: 48, size: '48 м²', house: false, bedrooms: 2,
    details: 'двособен стан' },
];

function makeHandler(rows: Property[]): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(rows);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels, landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent };
}

test('detector: "gjorce" resolves to Ѓорче Петров', () => {
  assert.equal(detectLocation('NESTO VO GJORCE IMA?', []), 'Ѓорче Петров');
  assert.equal(detectLocation('nesto vo gjorce petrov ima?', []), 'Ѓорче Петров');
});

/** The capture's chat was ALREADY past the funnel when [13:48] landed: the
 *  talk above it had settled buy + presentation (criteria consumed earlier).
 *  Seed exactly that established context after the aggregate turn. */
async function seedEstablished(
  handler: InboundHandler, sessions: SessionStore, chatId: string,
): Promise<void> {
  const session = sessions.get(chatId)!;
  session.slots.service = 'buy';
  session.state = 'presentation';
  sessions.set(session);
}

test('A: apartments talk serves a Gjorce APARTMENT — never the Влае house', async () => {
  const { handler, sessions, sent } = makeHandler(ROWS);
  const chatId = 'gjorce-A';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('VO KOJA NASELBA SE NAJEFTINI STANOVITE');
  assert.match(sent[0], /НАЈЕФТИНА/, 'the [13:47] aggregate lane must fire on the naselba comparison ask');
  await seedEstablished(handler, sessions, chatId);

  await send('NESTO VO GJORCE IMA?');
  assert.match(sent[1], /Евидентен број 80/, `Gjorce apartment must serve, got: ${sent[1]}`);
  for (const eb of [55, 90, 33]) {
    assert.ok(!sent[1].includes(`Евидентен број ${eb}`),
      `the Gjorce apartment ask must never show EB ${eb}; got: ${sent[1]}`);
  }
});

test('B: empty Gjorce (apartments) → say none in Ѓорче Петров + offer other neighborhoods', async () => {
  // Only the Gjorce HOUSE exists — the apartments talk has nothing in the called area.
  const { handler, sessions, sent } = makeHandler(ROWS.filter(r => r.id !== 80));
  const chatId = 'gjorce-B';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('VO KOJA NASELBA SE NAJEFTINI STANOVITE');
  await seedEstablished(handler, sessions, chatId);
  await send('NESTO VO GJORCE IMA?');
  assert.match(sent[1], /Ѓорче Петров/, `the miss must name the wanted naselba, got: ${sent[1]}`);
  assert.match(sent[1], /друг(и|а)/i, 'the miss must ASK about checking another naselba');
  // The none-in-area protocol never spills the other areas' rows.
  for (const eb of [55, 90, 33]) {
    assert.ok(!sent[1].includes(`Евидентен број ${eb}`),
      `the miss must not silently serve EB ${eb}; got: ${sent[1]}`);
  }
});

test('C: houses talk serves the Gjorce HOUSE — not the Gjorce apartment', async () => {
  const { handler, sessions, sent } = makeHandler(ROWS);
  const chatId = 'gjorce-C';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('VO KOJA NASELBA SE NAJEFTINI KUKJITE'); // history: houses
  await seedEstablished(handler, sessions, chatId);
  await send('NESTO VO GJORCE IMA?');
  assert.match(sent[1], /Евидентен број 90/, `Gjorce house must serve, got: ${sent[1]}`);
  for (const eb of [80, 55, 33]) {
    assert.ok(!sent[1].includes(`Евидентен број ${eb}`),
      `the house talk must never show EB ${eb}; got: ${sent[1]}`);
  }
});
