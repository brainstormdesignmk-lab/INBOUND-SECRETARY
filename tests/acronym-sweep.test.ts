// ACRONYM SWEEP — every initialism the map holds, through the real handler.
//
// The [23:00] СЈО capture was not one place going wrong: the wish tail floor
// was four characters, so NO institution written as an initialism could be
// captured at all (СЈО, ГОБ, МВР, ТТК, НЛБ, КАМ, ТЦ, СП). With the floor at
// three, the sweep is the contract: for every acronym the map carries, the
// phrasings clients actually type must lock that place as the hunt's anchor —
// «кај СЈО», «kaj GOB», «стан до ТТК», «стан кај НЛБ» — and the everyday words
// that merely LOOK like short names («сајт», «стан») must still resolve to
// nothing.
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
import { InboundHandler, poiNameCoversClientWords } from '../src/handlers/inbound';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';
import { setLearnedBank } from '../src/data/responseBank';
import { extractPoiWishCandidates } from '../src/llm/deterministic';

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

class EmptyProps extends PropertyService {
  constructor() { super('http://feed-not-used'); }
  async getAll(): Promise<Property[]> { return []; }
  async getByEb(): Promise<Property | undefined> { return undefined; }
  async getById(): Promise<Property | undefined> { return undefined; }
  get healthy(): boolean { return true; }
}

function makeHandler(): { handler: InboundHandler; sessions: SessionStore } {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new EmptyProps();
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async () => {} });
  const handler = new InboundHandler({ cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: map() }),
  });
  return { handler, sessions };
}

// The acronym, its map name, and the phrasings clients type. Every one of these
// rows exists in data/skopje-pois.db — the sweep is grounded in the real map,
// not in a fixture.
const SWEEP: Array<{ text: string; want: RegExp }> = [
  { text: 'GLEDAV EDEN STAN KAJ SJO', want: /^СЈО/u },
  { text: 'КАЈ СЈО', want: /^СЈО/u },
  { text: 'kaj SJO', want: /^СЈО/u },
  { text: 'stan do СЈО', want: /^СЈО/u },
  { text: 'kaj GOB', want: /^ГОБ/u },
  { text: 'СТАН КАЈ ГОБ', want: /^ГОБ/u },
  { text: 'stan blizu GOB', want: /^ГОБ/u },
  { text: 'kaj MVR', want: /^МВР/u },
  { text: 'СТАН КАЈ МВР', want: /^МВР/u },
  { text: 'kaj TTK', want: /^TTK|^ТТК/u },
  { text: 'stan do TTK', want: /^TTK|^ТТК/u },
  { text: 'kaj NLB', want: /^NLB|^НЛБ/u },
  { text: 'kaj KAM MARKET', want: /^КАМ/u },
  { text: 'kaj TC Ramstor', want: /^ТЦ/u },
  { text: 'стан до ТЦ Мавровка', want: /^ТЦ/u },
];

test('every acronym the map holds locks as the hunt anchor, in every phrasing', async () => {
  const { handler, sessions } = makeHandler();
  let n = 0;
  for (const { text, want } of SWEEP) {
    const chatId = `acr-${n++}`;
    await handler.handle('test', chatId, text);
    const anchor = sessions.get(chatId)?.slots.poiAnchor;
    assert.ok(anchor, `${text} → no anchor at all`);
    assert.match(anchor!, want, `${text} → locked «${anchor}», wanted ${want}`);
  }
});

test('the extractor sees the acronym in both scripts, three letters included', () => {
  for (const [text, want] of [
    ['KAJ SJO', 'сјо'],
    ['КАЈ СЈО', 'СЈО'],
    ['kaj GOB', 'гоб'],
    ['stan do TTK', 'TTK'],
    ['stan blizu GOB', 'гоб'],
  ] as const) {
    const c = extractPoiWishCandidates(text, { withCriteria: true });
    assert.ok(c.includes(want), `${text} → ${JSON.stringify(c)} must carry ${want}`);
  }
});

test('the map still refuses everyday words and the coverage guard still signs off', () => {
  const m = map();
  for (const junk of ['сајт', 'стан', 'страницата', 'оглас', 'евра']) {
    assert.equal(m.findPoiByName(junk), undefined, `«${junk}» is never a venue`);
    assert.equal(m.findPoiByNameLoose(junk), undefined, `«${junk}» never resolves by typo either`);
  }
  // The guard every acronym anchor passes: the map's own name must OPEN with
  // the client's word, so a fuzzy neighbour can never stand in for it.
  assert.ok(poiNameCoversClientWords('СЈО', 'СЈО - Специјално Јавно Обвинителство'));
  assert.ok(poiNameCoversClientWords('ГОБ', 'ГОБ 8-ми Септември'));
  assert.ok(poiNameCoversClientWords('ТЦ Мавровка', 'ТЦ Мавровка'));
  assert.ok(!poiNameCoversClientWords('СЈО', 'Јавно обвинителство на Македонија'));
});
