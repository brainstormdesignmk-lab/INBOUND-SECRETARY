// THE [08:26] TRANSCRIPT — the client typed:
//   "zdravo 73 kade se naogja tocno
//    sakam da go vidam"
// Lina answered "Тоа место не ми е познато во нашата база…" for EB 73, a
// property that IS published in the feed.
//
// ROOT CAUSE (parser, not data): detectWhereIs() reads what FOLLOWS the verb
// ("… kade se naogja" → rest = "tocno"), and the pre-verbal-EB recovery only
// ran when that rest was EMPTY. So the EB the client named BEFORE the verb was
// dropped, the placeholder word "tocno" became the "place", the handler looked
// up a property called "tocno", found nothing and served the honest-miss line.
//
// THE CONTRACT this file pins:
//   1. A precision adverb after the verb is a QUALIFIER, never a place — the
//      same rule the pre-verbal position already had ('kade tocno se naogja ?'
//      was always generic).
//   2. An EB named before the verb survives a trailing qualifier AND a
//      following sentence on the next line.
//   3. A bare precision ask ("kade e tocno?") is a question about the CURRENT
//      property (generic) — not a lookup for a place named "tocno".
//   4. End-to-end: the exact production message resolves EB 73 and answers
//      with its landmark — never the not-found line.
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
import { detectWhereIs } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// EB 73 EXACTLY as the live feed serves it — neighbourhood, the address, and
// the ranked landmark list ANA resolved at import. (Its stored lat/lon are the
// geocoder's bad fallback point; that is a separate, tracked data defect and it
// is deliberately NOT massaged here — the assertion is only that the property
// is FOUND and answered with its own landmark.)
const ROWS: Property[] = [
  {
    eb: 73, id: 73, address: 'АСНОМ 156', location: 'Ново Лисиче',
    price: 140000, service: 'buy', sqm: 72, size: '72 м²',
    lat: 41.9981, lon: 21.4254, geo_source: 'google_cached',
    landmark: 'ООУ Лазо Ангеловски',
    landmarks: [
      { type: 'school', landmark: 'ООУ Лазо Ангеловски', distance_m: 359 },
      { type: 'police', landmark: 'Полициска Станица - Аеродром', distance_m: 403 },
      { type: 'park', landmark: 'Парк Авионче', distance_m: 427 },
    ],
  },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

function makeHandler() {
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
  const handler = new InboundHandler({
    cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  const chatId = 'eb73-whereis';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };
  return { send, sent };
}

const PROD_MESSAGE = 'zdravo 73 kade se naogja tocno\nsakam da go vidam';

test('parser: a precision adverb after the verb never becomes the place', () => {
  // The exact production message: the EB before the verb survives both the
  // qualifier "tocno" and the next-line sentence.
  assert.deepEqual(detectWhereIs(PROD_MESSAGE), { place: '73', generic: false });
  assert.deepEqual(detectWhereIs('zdravo 73 kade se naogja tocno'), { place: '73', generic: false });
  assert.deepEqual(detectWhereIs('73 kade se naogja tocno'), { place: '73', generic: false });
  assert.deepEqual(detectWhereIs('kade se naogja 73 tocno'), { place: '73', generic: false });

  // A BARE precision ask is about the current property — never a place "tocno".
  // (The regression that produced the not-found line for a bare "kade e tocno?".)
  for (const bare of ['kade tocno se naogja ?', 'kade e tocno ?', 'каде е точно?', 'kade se naogja potocno?']) {
    assert.deepEqual(detectWhereIs(bare), { place: '', generic: true }, `bare precision ask: ${bare}`);
  }

  // The next-line place / next-line EB shapes must keep working.
  assert.deepEqual(detectWhereIs('STANOT SO BROJ KADE SE NAOGJA?\n94'), { place: '94', generic: false });
  assert.deepEqual(detectWhereIs('каде се наоѓа\nРамстор?'), { place: 'Рамстор', generic: false });

  // Real place names are untouched.
  assert.deepEqual(detectWhereIs('kade se naogja Рамстор?'), { place: 'Рамстор', generic: false });
  assert.deepEqual(detectWhereIs('каде е Палома Бјанка?'), { place: 'Палома Бјанка', generic: false });
});

test('e2e: the [08:26] message locates EB 73 instead of claiming it is unknown', async () => {
  const { send, sent } = makeHandler();
  const s = await send(PROD_MESSAGE);
  const answer = sent[sent.length - 1] ?? '';

  assert.equal(s.slots.propertyId, 73, `the EB named before the verb must win, got ${s.slots.propertyId}`);
  assert.ok(!/не ми е познато|непознат/iu.test(answer), `must not claim ignorance of a published property: ${answer}`);
  assert.ok(/во близина на/iu.test(answer), `a landmark answer expected: ${answer}`);
  // …and it must be one of EB 73's OWN resolved landmarks (all in Аеродром /
  // Ново Лисиче), never a landmark from the wrong part of the city.
  assert.ok(/Лазо Ангеловски|Полициска Станица|Парк Авионче/iu.test(answer),
    `EB 73's own landmark expected: ${answer}`);
});

test('e2e: a bare "kade e tocno?" continues the EB 73 thread', async () => {
  const { send, sent } = makeHandler();
  await send(PROD_MESSAGE);
  const s = await send('kade e tocno ?');
  const answer = sent[sent.length - 1] ?? '';

  assert.equal(s.slots.propertyId, 73, `still EB 73, got ${s.slots.propertyId}`);
  assert.ok(!/не ми е познато/iu.test(answer), `bare precision ask must not miss: ${answer}`);
  assert.ok(!/\btocno\b/iu.test(answer), `the qualifier word must never reach the client: ${answer}`);
});
