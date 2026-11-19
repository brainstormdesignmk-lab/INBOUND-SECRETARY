// THE [09:41] CAPTURE — A PAIR THE CLIENT NAMED HIMSELF, ANSWERED IN THE
// SINGULAR:
//
//   [09:41] заинтересиран сум за евидентен број 88 и 89
//   [09:41] дали се достапни уште становите ?
//   [09:41] ЛИНА: Според податокот од агенцијата, СТАНОТ е достапен веднаш.
//                 Дали да го контактирам СОПСТВЕНИКОТ …
//   [09:42] ако се достапни би сакал да ги погледнам лично
//   [09:45] ЛИНА: Посетата е за СТАНОТ со Евидентен број 88 (Аеродром).
//
// One flat of the two he named was answered, the other vanished — and the
// visit he asked for in the plural was written down as a one-flat visit (one
// owner, one fee). The contracts pinned here:
//
//   1. a pair named by number is ON THE TABLE afterwards (the follow-ups
//      «становите», «ги» refer to THOSE two flats);
//   2. a plural availability ask answers EVERY flat of that pair, from its own
//      column, with the per-property arithmetic — never «нема станови» (an
//      absence claim built from a filter, §2i);
//   3. a plural visit wish names BOTH flats in the subject line and states the
//      fee per property — «за станот со Евидентен број 88» is the defect;
//   4. the booking turn asks for the contact in the plural, one owner per flat.

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
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('probe: LLM disabled'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id || r.eb === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

// The two flats of the capture: both in Аеродром, both buy, both „Веднаш“.
const EB88: Property = {
  eb: 88, id: 88, location: 'Аеродром', address: 'Аеродром 8', price: 82000,
  bedrooms: 2, sqm: 58, size: '58 м²', service: 'buy', dostapnoOd: 'Веднаш',
  lat: 41.9935, lon: 21.4557, geo_source: 'google_cached', details: '',
} as Property;
const EB89: Property = {
  eb: 89, id: 89, location: 'Аеродром', address: 'Аеродром 11', price: 88000,
  bedrooms: 2, sqm: 62, size: '62 м²', service: 'buy', dostapnoOd: 'Веднаш',
  lat: 41.9941, lon: 21.4563, geo_source: 'google_cached', details: '',
} as Property;

function makeHandler(rows: Property[] = [EB88, EB89]) {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const properties = new FakeProps(rows);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  const chatId = 'client-2';
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  const seed = () => {
    const s = freshSession('test', chatId);
    s.state = 'presentation';
    s.slots.service = 'buy';
    sessions.set(s);
    return s;
  };
  return { handler, sessions, sent, chatId, say, seed };
}

const PAIR_ASK = 'заинтересиран сум за евидентен број 88 и 89';

test('a pair named by number is on the table afterwards', async () => {
  const h = makeHandler();
  h.seed();
  const first = await h.say(PAIR_ASK);
  // Both flats are named back (the pair-identity lane), never one of them.
  assert.match(first, /88/u, `the first named flat is described: ${first}`);
  assert.match(first, /89/u, `the second named flat is described: ${first}`);
  const s = h.sessions.get(h.chatId)!;
  const table = [...(s.slots.presentedIds ?? []), ...(s.slots.currentBatch ?? [])];
  assert.ok(table.includes(88) && table.includes(89),
    `both named flats are on the table: ${JSON.stringify(s.slots)}`);
});

test('[09:41] «дали се достапни уште становите?» answers BOTH, in the plural', async () => {
  const h = makeHandler();
  h.seed();
  await h.say(PAIR_ASK);
  const answer = await h.say('дали се достапни уште становите ?');
  // never the absence claim (a filtered search answered as "we have none", §2i)
  assert.doesNotMatch(answer, /нема станови|нема недвижности/iu, answer);
  assert.match(answer, /88/u, `the first flat is answered: ${answer}`);
  assert.match(answer, /89/u, `the second flat is answered: ${answer}`);
  // Each flat answers from its own column, and the money is PER PROPERTY —
  // the contract, not a wording: the pair's arithmetic (2 × 500) is stated.
  assert.match(answer, /1\.000|1000/u, `the per-property fee is stated: ${answer}`);
});

test('[09:45] a visit wish over the pair is disclosed for BOTH flats', async () => {
  const h = makeHandler();
  h.seed();
  await h.say(PAIR_ASK);
  const answer = await h.say('ако се достапни би сакал да ги погледнам лично');
  assert.match(answer, /становите/u,
    `the visit is for the flats (plural), not «за станот»: ${answer}`);
  assert.doesNotMatch(answer, /за станот со/iu, `never a one-flat subject: ${answer}`);
  assert.match(answer, /88/u, `the first flat is named: ${answer}`);
  assert.match(answer, /89/u, `the second flat is named: ${answer}`);
  assert.match(answer, /1\.000|1000/u, `the per-property fee is stated: ${answer}`);
  // The wish STICKS (the visit route reads it for the client's own term), and
  // the set itself stays the table pair — a deictic «ги» names nothing new, so
  // `visitEbs` is deliberately not written here (tests/visit-deictic-named.test.ts).
  assert.equal(h.sessions.get(h.chatId)!.slots.visitWanted, true,
    'the plural wish is banked for the route');
});

test('[09:45] the booking turn contacts the owners in the plural', async () => {
  const h = makeHandler();
  h.seed();
  await h.say(PAIR_ASK);
  await h.say('дали се достапни уште становите ?');
  const answer = await h.say('ако се достапни би сакал да ги погледнам лично');
  assert.match(answer, /становите со Евидентни броеви 88 и 89/u,
    `the pair is the subject of the booking: ${answer}`);
  assert.match(answer, /сопствениц(?:ите|и)/iu,
    `one owner per flat — the ask is plural: ${answer}`);
  assert.doesNotMatch(answer, /сопственикот/iu, `never one owner for two visits: ${answer}`);
  assert.equal(h.sessions.get(h.chatId)!.state, 'contact_collection');
});
