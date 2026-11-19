// THE [03:52] V16K11 CAPTURE — a NEW ASK answered as if it were a SEEN listing.
//
//   [03:52] SAKAM DA IZNAJMAM DUKJAN VO BLIZINA NA BUNJAKOVEC ILI CITI MOL
//   ЛИНА: Да, имаме деловен простор за издавање кај Буњаковец (Центар). Еве ги:
//         Евидентен број 42 — деловен простор, во Центар, 126 м², 1.000 евра.
//         Евидентен број 59 — деловен простор, во Центар, 105 м², 950 евра.
//         Дали некој од овие е тој што го видовте? Ако е, кажете ми „првиот“…
//         Ако се сеќавате и по којa цена беше деловниот простор, кажете ми…
//
// The client has seen NOTHING: he stated a wish (сакам да изнајмам) with a place
// and no м²/price. The owner's rule: «IT'S NOT A SEEN PROPERTY, IT'S A NEW ASK —
// BEFORE GIVING HIM THE PAIRS: M2, PRICE, THEN A PAIR AFTER PAIR.» The
// anchored-entry serve fired because the place was named into an empty chat, and
// its closer presumes a unit he already picked out.
//
// The line between the two shapes is the ASK, not the place: a STOCK ask
// («ИМАТЕ ОБЈАВЕНО ЕДНА КУЌА … КАЈ ОЛИМПИКО», the [11:07] capture) is answered
// at once with the seen-property closer — that one is pinned in
// tests/locate-landmark.test.ts and must stay untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
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
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';
import { setLearnedBank } from '../src/data/responseBank';

setLearnedBank({
  variants: () => [], addVariant: () => false, addExample: () => false,
  metric: () => {}, retrieve: () => undefined,
} as any);

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://feed-not-used'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(p => p.eb === eb); }
  get healthy(): boolean { return true; }
}

// Both places sit INSIDE the serve ring, so the pre-fix code served a pair on
// the first message — the fixture would not catch the defect from further away.
const PLACES = [
  { name: 'Буњаковец', type: 'neighbourhood', lat: 41.9960, lon: 21.4350, source: 'survey' },
  { name: 'Сити Мол', type: 'mall', lat: 41.9930, lon: 21.4375, source: 'survey' },
];

const ROWS: Property[] = [
  { eb: 42, id: 42, uuid: 'biz-42', address: 'Буњаковец 5', location: 'Центар',
    lat: 41.9962, lon: 21.4352, geo_source: 'stored',
    service: 'rent', price: 1000, business: true, sqm: 126, size: '126 м²' } as Property,
  { eb: 59, id: 59, uuid: 'biz-59', address: 'Строг Центар', location: 'Центар',
    lat: 41.9932, lon: 21.4376, geo_source: 'stored',
    service: 'rent', price: 950, business: true, sqm: 105, size: '105 м²' } as Property,
];

function makeHandler(): { send: (m: string) => Promise<string>; sessions: SessionStore; chatId: string } {
  const dbPath = path.join(os.tmpdir(), `cin352-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
  writeMap(dbPath, PLACES, []);
  const offlineMap = new OfflineMapStore(dbPath);
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions,
    classifier: new Classifier(llm, cfg, props),
    responder: new Responder(llm, cfg),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, google: false, offlineMap }),
  });
  const chatId = 'capture-0352';
  return {
    chatId,
    sessions,
    send: async (m: string) => { await handler.handle('test', chatId, m); return sent[sent.length - 1]!; },
  };
}

const CARD = /Евидентен број/u;
const SEEN_CLOSER = /тој што го видовте|што го видовте|Дали некој од овие е/iu;

test('[03:52] a NEW business ask owes м² + price before any pair — never the seen-property closer', async () => {
  const { send, sessions, chatId } = makeHandler();

  const first = await send('SAKAM DA IZNAJMAM DUKJAN VO BLIZINA NA BUNJAKOVEC ILI CITI MOL');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.business, true, 'the category the client named is on file');
  assert.equal(s.slots.service, 'rent', 'the market he named is on file');
  assert.ok(!CARD.test(first), `no listing may be shown before the criteria: ${first}`);
  assert.ok(!SEEN_CLOSER.test(first),
    `a wish is not a recall — the seen-property question is never asked: ${first}`);
  // The funnel's own questions, type-aware for a деловен простор: м² and price.
  assert.match(first, /квадрат|м²|површина/iu, `the business size question: ${first}`);
  assert.match(first, /цена|кирија|износ/iu, `the price question: ${first}`);
  assert.ok(!/спални/iu.test(first), `a business space has no bedrooms: ${first}`);
  assert.equal(s.state, 'discovery', 'the chat is still in discovery, not presentation');

  // …and once the criteria are in, the pair serves (pair after pair).
  const pair = await send('80 KVADRATI DO 1000 EVRA');
  assert.match(pair, CARD, `the criteria serve the business pair: ${pair}`);
  assert.ok(!SEEN_CLOSER.test(pair), `still no seen-property question: ${pair}`);
  assert.equal(sessions.get(chatId)!.state, 'presentation', 'cards put the chat in presentation');
});

test('[03:52] the STOCK ask at a place keeps its immediate serve and its seen-property closer', async () => {
  // The [11:07] shape, on the same fixture: «имате објавено» refers to a
  // listing we published — that turn is answered at once, and the closer is
  // right there (its own full pin lives in tests/locate-landmark.test.ts).
  const { send } = makeHandler();
  const reply = await send('ZDRAVO, IMATЕ OBJAVENO EDNA KUKJA ZA IZDAVANJE KAJ BUNJAKOVEC ?');
  // No house in this fixture, so nothing near serves — the point of this leg is
  // that the turn is NOT held for criteria: it answers instead of asking м².
  assert.ok(!/колку квадрат|површина/iu.test(reply), `a stock ask is not grilled: ${reply}`);
});
