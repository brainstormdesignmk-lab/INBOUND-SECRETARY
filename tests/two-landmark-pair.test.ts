/**
 * THE [23:12] CAPTURE — TWO LANDMARKS IN ONE SEARCH ARE TWO PLACES TO ANSWER.
 *
 *   [23:12] SAKAM DA KUPAM TROSOBEN STAN KAJ BEVERLI HILS ILI BUNJAKOVEC
 *   [23:12] STO BI MI PONUDILE?
 *   [23:13] ЛИНА [без LLM]: Разбрав — значи баравте стан во близина на
 *           Беверли Хилс (Капиштец). … Евидентен број 78 … во Капиштец …
 *           Евидентен број 84 — трисобен стан, во Центар, 48 м²
 *
 * Two defects met on that turn:
 *
 * 1. THE LANE. The message is a NEW SEARCH («Sakam da kupam» + «trosoben» +
 *    two places), but `detectSeenListingRecall` read it as a RECALLED LISTING:
 *    its narration pattern carried the open stems `bes/bev`, and «bev» is a
 *    prefix of **BEV**ERLI — so the sighting arm (type noun … narration) fired
 *    on the landmark's own name. The router then ran the archive lane, which
 *    knows ONE anchor and no criteria: the pair came from the two nearest rows
 *    to Беверли Хилс, the second landmark never entered the search, and the
 *    «трисобен» was never stored (EB 84 is 48 м² and ranked second only by
 *    distance).
 * 2. THE PAIR. Even with the lane right, a two-place ask must serve ONE CARD
 *    PER PLACE (`placePairQueue`), the client's own order, each card stating
 *    its distance to BOTH places — never two cards around whichever place was
 *    walked first.
 *
 * The lexicon half is swept by tests/memory-lexicon-place-sweep.test.ts; this
 * file pins the turn end to end through the real handler.
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
import { detectSeenListingRecall } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const ASK = 'SAKAM DA KUPAM TROSOBEN STAN KAJ BEVERLI HILS ILI BUNJAKOVEC';

/** The narration stems must never fire on a place name (the «bev» → BEVERLI
 *  collision): a sentence naming a landmark is not a memory of a listing. */
test('a place name never reads as a narrated listing', () => {
  assert.equal(detectSeenListingRecall(ASK), false,
    'a new search at two landmarks is not a recall of a listing the client saw');
  assert.equal(detectSeenListingRecall('STAN KAJ BEVERLI HILS'), false,
    'the landmark BEVERLI HILS must not satisfy the narration pattern');
  // The narration lane still owns its own wording — the fix is precision, not
  // a disabled detector.
  assert.equal(detectSeenListingRecall('IMAVTE EDNA KUKJA BEVERLI HILS BESE 130 000'), true,
    'a real narration («besе» + type noun) is still a recall');
});

function makeHandler(rows: Property[]) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const props = new FakeProps(rows);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  return { handler, sessions, sent, chat: 'capture-2312' };
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

test('[23:12] two landmarks are two places: one flat near each, in the client order', async () => {
  const cfg = loadConfig();
  const map = new OfflineMapStore(cfg.skopjePoisDb);
  if (!map.available) return; // no shipped map here — the lexicon sweep pins the rest
  const lm = new LandmarkService(new Db(':memory:'), { osm: false, offlineMap: map });
  const bev = lm.findPlace('Беверли Хилс');
  const bun = lm.findPlace('Буњаковец');
  if (!bev || !bun) return; // a map without these names is not this capture

  const ROWS: Property[] = [
    // AT the first landmark (the flat the client's pair must answer with).
    { eb: 78, id: 78, location: 'Капиштец', address: 'Ул. Беверли Хилс 4', price: 185000,
      bedrooms: 3, sqm: 82, size: '82 м²', service: 'buy', lat: bev.lat + 0.0006, lon: bev.lon + 0.0003 },
    // AT the second landmark — the card the live serve never reached.
    { eb: 79, id: 79, location: 'Центар', address: 'Ул. Буњаковец 12', price: 190000,
      bedrooms: 3, sqm: 78, size: '78 м²', service: 'buy', lat: bun.lat + 0.0005, lon: bun.lon + 0.0004 },
    // In the same city, ~2 km away, and CHEAPER: distance must beat price here.
    { eb: 84, id: 84, location: 'Центар', address: 'Ул. Македонија 30', price: 117000,
      bedrooms: 3, sqm: 48, size: '48 м²', service: 'buy', lat: bev.lat - 0.0110, lon: bev.lon + 0.0220 },
  ];

  const { handler, sessions, sent, chat } = makeHandler(ROWS);
  await handler.handle('test', chat, ASK);
  const s1 = sessions.get(chat)!;
  assert.equal(s1.state, 'discovery',
    'a new search runs the funnel — never the archive/locate lane');
  assert.equal(s1.slots.service, 'buy');
  assert.equal(s1.slots.bedrooms, 3, '«трисобен» is a criterion of the search, so it is stored');
  assert.deepEqual(
    (s1.slots.poiPlaces ?? []).map(p => p.name),
    ['Беверли Хилс', 'Буњаковец'],
    'BOTH landmarks the message named are kept, in the client\'s order');

  const asked = sent.at(-1)!;
  assert.doesNotMatch(asked, /спалн|spaln/iu,
    `bedrooms were already given — never re-ask them: ${asked}`);
  assert.doesNotMatch(asked, /дел од градот|населба/iu,
    `the places ARE the geography — never re-ask the area: ${asked}`);
  assert.match(asked, /цен|price/iu, `the missing criterion is the budget: ${asked}`);

  await handler.handle('test', chat, 'DO 250000 EVRA');
  const s2 = sessions.get(chat)!;
  assert.equal(s2.state, 'presentation', 'the criteria are complete — she serves');
  assert.deepEqual(s2.slots.presentedIds, [78, 79],
    'ONE CARD PER PLACE: the flat at each landmark, not the two nearest to the first');
  assert.equal(s2.slots.pairAnchorOf?.['78']?.name, 'Беверли Хилс');
  assert.equal(s2.slots.pairAnchorOf?.['79']?.name, 'Буњаковец');

  const served = sent.at(-1)!;
  assert.match(served, /по една опција/iu, `the pair is introduced as one per place: ${served}`);
  assert.match(served, /Беверли Хилс/u, `the first place is named: ${served}`);
  assert.match(served, /Буњаковец/u, `the second place is named: ${served}`);
  assert.match(served, /Евидентен број 78/u);
  assert.match(served, /Евидентен број 79/u);
});
