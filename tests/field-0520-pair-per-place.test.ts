/**
 * THE [05:20] BUSINESS PAIR — ONE UNIT PER PLACE THE CLIENT NAMED.
 *
 * The operator's rule, in his own words: «HE SAID PRIMARY CENTAR, RAMPA SECOND
 * OPTION SO SHE MUST GIVE ONE OF EACH — CENTER / RAMPA IN THE PAIR. IN THIS
 * TURN SHE WAS FOCUSED ON RAMPA — WRONG».
 *
 * What happened: «PA CENTAR U GLOBALA AMA MOZE I KISELA VODA OKOLU RAMPA» names
 * TWO places — the client's primary (a district) and his second option (a
 * landmark) — and the serve ranked the whole business pool by distance to the
 * NEAREST anchor, so both rows came from the Рампа side and the primary place
 * was never served. A two-place ask is a comparison BETWEEN PLACES; the pair is
 * one unit each, in the client's own order.
 *
 * The fixture places the two places far apart in the real map (Аеродром vs
 * Рампа) so the assertion is unambiguous: with the old ranking BOTH rows are
 * the Рампа-side ones and the Аеродром row is never shown.
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
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

function makeHandler(rows: Property[], id: string) {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(rows);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent[sent.length - 1] ?? '';
  };
  return { say, sessions, chatId: id };
}

// Coordinates are the SHIPPED map's own anchors (тобако РАМПА 41.9870,21.4369 ·
// Аеродром 41.9840,21.4650 — 2.4 km apart, just outside the 2 km business
// ring), so each place can only be answered by its own cluster: one business
// space at Аеродром, two on the Рампа side. All three carry Центар as the
// feed's area word, which is exactly the trap — the AREA does not decide where
// a unit stands.
const STOCK: Property[] = [
  { eb: 59, id: 59, location: 'Аеродром', address: 'Ул. А 1', price: 950, sqm: 105, size: '105 м²', service: 'rent', business: true, lat: 41.9840, lon: 21.4650 },
  { eb: 42, id: 42, location: 'Центар', address: 'Ул. Б 2', price: 1000, sqm: 126, size: '126 м²', service: 'rent', business: true, lat: 41.9870, lon: 21.4370 },
  { eb: 57, id: 57, location: 'Центар', address: 'Ул. В 3', price: 1000, sqm: 90, size: '90 м²', service: 'rent', business: true, lat: 41.9878, lon: 21.4378 },
];

test('two named places: the business pair is ONE unit per place, in his order', async () => {
  const { say } = makeHandler(STOCK, 'biz-two-places');
  // The business funnel asks its own criterion first (the capture's client had
  // already answered it); the turn under test is the two-place ask.
  await say('SAKAM DA IZNAJMAM DELOVEN PROSTOR');
  await say('OKOLU 100 KVADRATI');
  const reply = await say('PRVO AERODROM AMA MOZE I OKOLU RAMPA');
  // The lead names BOTH places: he asked for a comparison between them. The
  // map's own wording is «тобако РАМПА» (capitals), so the assertion folds case.
  assert.match(reply, /аеродром/iu, `the primary place is named: ${reply}`);
  assert.match(reply, /рампа/iu, `the second option is named: ${reply}`);
  // …and in HIS order: the primary place leads the sentence.
  assert.ok(reply.search(/аеродром/iu) < reply.search(/рампа/iu),
    `the place he named FIRST must lead: ${reply}`);
  // …and the pair holds one of each. The Аеродром unit is the only one that can
  // answer his FIRST place, so it must be on the table.
  assert.match(reply, /Евидентен број 59/u,
    `the primary place's unit must be served — the old ranking served both Рампа-side rows: ${reply}`);
  // The second card is a Рампа-side row (42 or 57), never the same row twice.
  assert.match(reply, /Евидентен број (?:42|57)/u, `the second option's unit is served: ${reply}`);
  assert.equal(new Set(reply.match(/Евидентен број \d+/gu)).size, 2,
    `exactly two cards, and no row served twice: ${reply}`);
});

test('one named place keeps the pair protocol: the two nearest units', async () => {
  // A single place is NOT a comparison between places — the two nearest units
  // are the protocol it always had, and this fix must not narrow it to one.
  const { say } = makeHandler(STOCK, 'biz-one-place');
  await say('SAKAM DA IZNAJMAM DELOVEN PROSTOR');
  await say('OKOLU 100 KVADRATI');
  const reply = await say('OKOLU RAMPA');
  assert.match(reply, /Евидентен број 42/u, `the nearest unit: ${reply}`);
  assert.match(reply, /Евидентен број 57/u, `and the second nearest: ${reply}`);
});

test('the served business pair is MEASURED when the client asks how far it stands', async () => {
  // Defect #2 of the [05:20] capture: the same question was answered with the
  // business-area question ("За кој дел од градот сте најмногу заинтересирани…"),
  // never with a distance, although the pair on the table IS measurable. The
  // lane that owns it is the distance matrix — one measured line per row, the
  // same rule the residential pair already had.
  const { say } = makeHandler(STOCK, 'biz-distance-pair');
  await say('SAKAM DA IZNAJMAM DELOVEN PROSTOR');
  await say('OKOLU 100 KVADRATI');
  await say('PRVO AERODROM AMA MOZE I OKOLU RAMPA');
  const reply = await say('NA KOE RASTOJANIE SE OD RAMPA ?');
  assert.match(reply, /Растојание/u, `the answer is a measured line: ${reply}`);
  for (const eb of ['42', '59']) {
    assert.match(reply, new RegExp(`Евидентен број ${eb}[\\s\\S]{0,40}(?:метри|километар|km)`, 'u'),
      `EB ${eb} is measured, not dropped: ${reply}`);
  }
  // …and it is never the area grill: he named the place, she knows the pair.
  assert.doesNotMatch(reply, /За кој дел од градот/u, `never the business-area question: ${reply}`);
});
