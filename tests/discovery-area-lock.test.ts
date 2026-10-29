/**
 * THE AREA IS A LOCK IN DISCOVERY TOO — the same rule the seen-property funnel
 * enforces (tests/vodno-seen-pair.test.ts), one state earlier.
 *
 *   ZDRAVO → SAKAM DA KUPAM STAN NA VODNO → DVE SPALNI → DO 150000
 *
 * A client who names Водно is not asking to see Центар flats "for choice": the
 * candidates() pool is the area itself, and an area with nothing matching asks
 * about other parts of town BEFORE anything from outside is offered. These pin
 * that behaviour (it existed; nothing pinned it), so a future "pad the pair"
 * shortcut cannot quietly reintroduce the 02:18 answer in discovery.
 */
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
import { EnrichmentStore } from '../src/store/enrichment';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const VODNO: Property[] = [
  { eb: 51, id: 51, location: 'Водно', price: 99000, bedrooms: 3, sqm: 71, size: '71 м²', service: 'buy', lat: 41.9761, lon: 21.4003 },
  { eb: 61, id: 61, location: 'Водно', price: 118000, bedrooms: 3, sqm: 74, size: '74 м²', service: 'buy', lat: 41.9755, lon: 21.4012 },
  { eb: 52, id: 52, location: 'Водно', price: 105000, bedrooms: 3, sqm: 80, size: '80 м²', service: 'buy', lat: 41.9770, lon: 21.3990 },
  { eb: 62, id: 62, location: 'Водно', price: 125000, bedrooms: 3, sqm: 84, size: '84 м²', service: 'buy', lat: 41.9781, lon: 21.3982 },
];
const CENTER: Property[] = [
  { eb: 95, id: 95, location: 'Центар', price: 120000, bedrooms: 3, sqm: 74, size: '74 м²', service: 'buy', lat: 42.0009, lon: 21.4310 },
  { eb: 96, id: 96, location: 'Центар', price: 130000, bedrooms: 3, sqm: 80, size: '80 м²', service: 'buy', lat: 42.0012, lon: 21.4320 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string, rows: Property[]) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(rows)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(rows),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  const chatId = id;
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId };
}

const FLOW = ['ZDRAVO', 'SAKAM DA KUPAM STAN NA VODNO', 'DVE SPALNI', 'DO 150000'];

test('discovery in Водно serves Водно cards only — no Центар padding', async () => {
  const { say, sessions, chatId } = makeHandler('disc-vodno', [...VODNO, ...CENTER]);
  for (const m of FLOW.slice(0, 3)) await say(m);
  const reply = await say(FLOW[3]);

  const batch = sessions.get(chatId)!.slots.currentBatch ?? [];
  assert.equal(batch.length, 2, `expected a pair, got ${JSON.stringify(batch)}`);
  for (const id of batch) {
    const row = [...VODNO, ...CENTER].find(p => p.id === id)!;
    assert.equal(row.location, 'Водно', `out-of-area row served in a Водно search: EB ${row.eb}`);
  }
  assert.match(reply, /Евидентен број (?:51|52|61|62)/);
  assert.doesNotMatch(reply, /Евидентен број (?:95|96)/, `Центар rows must not answer a Водно search: ${reply}`);
});

test('the next batch keeps the area lock as well', async () => {
  const { say, sessions, chatId } = makeHandler('disc-next', [...VODNO, ...CENTER]);
  for (const m of FLOW) await say(m);
  const first = new Set(sessions.get(chatId)!.slots.currentBatch ?? []);
  const reply = await say('DRUGI OPCII');
  const batch = sessions.get(chatId)!.slots.currentBatch ?? [];
  assert.ok(batch.length > 0, `expected fresh options, got ${reply}`);
  for (const id of batch) {
    assert.ok(!first.has(id), `an already-shown row came back: EB ${id}`);
    const row = [...VODNO, ...CENTER].find(p => p.id === id)!;
    assert.equal(row.location, 'Водно', `out-of-area row served on the next batch: EB ${row.eb}`);
  }
});

test('an area with nothing matching ASKS about other parts, never serves them', async () => {
  const { say, sessions, chatId } = makeHandler('disc-empty', CENTER);
  for (const m of FLOW.slice(0, 3)) await say(m);
  const reply = await say(FLOW[3]);

  assert.deepEqual(sessions.get(chatId)!.slots.currentBatch ?? [], [],
    'nothing may be served from outside the area before the client agrees');
  // The bank rotates the wording — the promise, not the phrasing, is pinned:
  // it says Водно has nothing AND asks before offering anything elsewhere.
  assert.match(reply, /Водно/);
  assert.match(reply, /(алтернативи|друга[^.?]*локациј|друг[аоу][^.?]*населб|други\s+(?:делови|населби|локации|блиски)|прошириме|пошироко)/u,
    `the widen is a QUESTION, not a substitution: ${reply}`);
  assert.doesNotMatch(reply, /Евидентен број (?:95|96)/, `no card before the widen: ${reply}`);
});
