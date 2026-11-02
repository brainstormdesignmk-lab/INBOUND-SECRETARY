// THE [22:42] CAPTURE — an AREA + SPECS message answered with a feature question.
//
//   [22:42] ЛИНА: За жал … немам … во Аеродром според Вашите барања …
//   [22:42] DEBAR MAALO , DVE SPALNI ?
//   [22:42] ЛИНА: Јас ќе стапам во контакт со сопственикот … Кои
//                  карактеристики Ви се од суштинско значење?            ✗
//
// The client pivots the hunt to Дебар Маало with two bedrooms — the criteria he
// already gave (rent, 350 €) still stand. That is a SEARCH, and the answer is
// the Дебар Маало flats that fit: never the owner-contact / feature script for a
// flat nobody was discussing.
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
import { OfflineMapStore } from '../src/geo/offlineMap';
import { setLearnedBank } from '../src/data/responseBank';
import { detectFeatureAsk, namesAreaWithSize } from '../src/llm/deterministic';

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

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://feed-not-used'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(p => p.eb === eb); }
  get healthy(): boolean { return true; }
}

// The bank: twoДеbar Маало flats (a 2-bedroom and a 1-bedroom) plus an Аеродром
// two-bedroom — the area pivot must pick the Дебар Маало two-bedroom.
const DEBAR2: Property = {
  eb: 41, id: 41, uuid: 'debar-41', address: 'УЛ. А', location: 'Дебар Маало',
  service: 'rent', price: 330, bedrooms: 3, sqm: 68, size: '68 м²', details: 'две спални',
} as Property;
const DEBAR1: Property = {
  eb: 42, id: 42, uuid: 'debar-42', address: 'УЛ. Б', location: 'Дебар Маало',
  service: 'rent', price: 250, bedrooms: 2, sqm: 45, size: '45 м²',
} as Property;
const AERODROM2: Property = {
  eb: 44, id: 44, uuid: 'aerodrom-44', address: 'УЛ. В', location: 'Аеродром',
  service: 'rent', price: 350, bedrooms: 3, sqm: 70, size: '70 м²', details: 'две спални',
} as Property;

function makeHandler(): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps([DEBAR2, DEBAR1, AERODROM2]);
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

// The detector itself: an AREA + a size spec is a search pivot; a genuine
// per-property feature question (no area, or no size number) still fires.
test('detectFeatureAsk: area + size never fires, real feature asks still do', () => {
  for (const text of [
    'DEBAR MAALO , DVE SPALNI ?',
    'debar maalo, dve spalni',
    'Дебар Маало, две спални?',
    'CENTAR 60 M2',
    'A VO KAPISTEC NAD 50 M2 IMA?',
    'карпош, 3 соби?',
  ]) {
    assert.ok(namesAreaWithSize(text), `must read as area+size: ${text}`);
    assert.equal(detectFeatureAsk(text), false, `never a feature ask: ${text}`);
  }
  for (const text of [
    'ima li parking ?',
    'има ли лифт?',
    'KOLKU SPALNI IMA STANOT VO CENTAR ?',   // no number — still a feature ask
    'дали е реновиран?',
  ]) {
    assert.equal(namesAreaWithSize(text), false, `not area+size: ${text}`);
    assert.ok(detectFeatureAsk(text), `stays a feature ask: ${text}`);
  }
});

test('an area + bedrooms message serves that area\'s flats, never a feature/owner script', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'debar-pivot';
  const s = freshSession('test', chatId);
  s.state = 'presentation';
  s.slots = { service: 'rent', budget: '350', bedrooms: 3, location: 'Аеродром' };
  s.history = [
    { role: 'user', text: '350 EVRA IMAM' },
    { role: 'user', text: '2 SPALNI PREPORACLIVO' },
    { role: 'assistant', text: 'За жал, во овој момент немам на располагање слободна недвижност во Аеродром според Вашите барања. Дали би сакале да разгледаме какви опции имаме на други локации?' },
  ];
  sessions.set(s);

  await handler.handle('test', chatId, 'DEBAR MAALO , DVE SPALNI ?');
  const reply = sent.at(-1) ?? '';
  console.log('PIVOT REPLY:', reply);
  console.log('SLOTS:', JSON.stringify(sessions.get(chatId)?.slots));
  assert.ok(!/карактеристики|стапам во контакт|сопственикот за точно да го проверам/iu.test(reply),
    `never the feature/owner script for a search: ${reply}`);
  assert.match(reply, /Евидентен број 41/u, `the Дебар Маало two-bedroom must serve: ${reply}`);
  assert.ok(!/Евидентен број 44/u.test(reply), `the other area must not serve: ${reply}`);
});
