/**
 * FIELD CAPTURE [22:17] — «НЕМОЖАМ ДА СЕ СЕТАМ НА БРОЈЧЕТО» IS NOT A PLACE.
 *
 *   [22:17] ГЛЕДАВ ЕДЕН СТАН КАЈ ВАС НА САЈТ КАЈ СЈО ТРОСОБЕН
 *   [22:17] НЕМОЖАМ ДА СЕ СЕТАМ НА БРОЈЧЕТО
 *   [22:17] ЛИНА [без LLM]: Разбрав — значи баравте стан во близина на
 *           Бариста Кафе (Центар). Еве ги најблиските недвижности…
 *
 * The client named СЈО. The extractor's tail carried the flat he wants with it
 * («СЈО ТРОСОБЕН»), the coverage guard refused СЈО because «ТРОСОБЕН» is not a
 * word of the map name, and the «на …» reader then handed «БРОЈЧЕТО» («the
 * number» — the word he uses to APOLOGISE) to the map. There the sound skeleton
 * of «БРОЈЧЕТО» is «brst» — exactly «Barista»'s — so the typo pass answered
 * «Barista cafe», the guard signed it off, and the whole serve was built around
 * a café nobody had mentioned: the third shape of the same defect the [23:00]
 * «САЈТ» capture reported.
 *
 * Three layers are pinned here, all of them at the place where the cause lives:
 *   1. THE MAP refuses the client's recall/answer vocabulary outright (both
 *      scripts, the inflected and diminutive forms, and the ordinal family) —
 *      «БРОЈЧЕТО»/«АДРЕСАТА»/«ВЛЕЗОТ»/«ПЕТТИОТ» are not venues.
 *   2. THE COVERAGE GUARD stops trusting a SHORT SOUND KEY as identity: a
 *      four-letter skeleton bridges nothing unless the spellings themselves
 *      agree (or one slip); real names still bind — «BROZ KAFE» → «Broz Cafe»,
 *      «ЦИТИ МОЛ» → «Сити Мол», «КАРОШ» → «Карпош».
 *   3. THE TAIL that carries the place also carries the flat he wants: the
 *      property spec is stripped before the lookup, so «КАЈ СЈО ТРОСОБЕН»
 *      resolves СЈО and the serve names the place he actually said.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { InboundHandler, poiNameCoversClientWords } from '../src/handlers/inbound';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore, refusesGenericNeedle } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';
import { stripTrailingPropertySpec } from '../src/llm/deterministic';
import { setLearnedBank } from '../src/data/responseBank';

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

// The Центар three-room flats the live feed holds — the serve the capture
// should have produced around СЈО.
const ROWS: Property[] = [
  { eb: 66, id: 66, uuid: 'c-66', address: 'УЛ. А', location: 'Центар', service: 'buy', price: 137000, bedrooms: 3, sqm: 79, size: '79 м²', type: 'flat', lat: 42.0005, lon: 21.4150 } as Property,
  { eb: 95, id: 95, uuid: 'c-95', address: 'УЛ. Б', location: 'Центар', service: 'buy', price: 204000, bedrooms: 3, sqm: 74, size: '74 м²', type: 'flat', lat: 41.9990, lon: 21.4100 } as Property,
  { eb: 38, id: 38, uuid: 'k-38', address: 'УЛ. В', location: 'Кисела Вода', service: 'buy', price: 101750, bedrooms: 3, sqm: 57, size: '57 м²', type: 'flat', lat: 41.9760, lon: 21.4350 } as Property,
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://feed-not-used'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(p => p.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(): { handler: InboundHandler; sessions: SessionStore; sent: string[]; chatId: string } {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(llm, cfg, props),
    responder: new Responder(llm, cfg),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: map() }),
  });
  return { handler, sessions, sent, chatId: 'recall-word' };
}

// ── 1. The map never answers a recall word with a venue ─────────────────────

test('[22:17] the client\'s recall/answer words are not places on the map', () => {
  const m = map();
  for (const word of [
    // «НЕМОЖАМ ДА СЕ СЕТАМ НА БРОЈЧЕТО» — the number
    'БРОЈЧЕТО', 'бројчето', 'BROJCETO', 'бројот', 'brojot', 'бројче', 'brojce',
    // the same answer family the sweep measured against the shipped map
    'ЦИФРАТА', 'АДРЕСАТА', 'ВЛЕЗОТ', 'КАТЧЕТО', 'ДЕНОТ', 'СЕТАМ',
    // the ordinal he answers «which one» with — «петтиот»
    'ПЕТТИОТ', 'petiot', 'ВТОРИОТ', 'vtoriot',
  ]) {
    assert.equal(m.findPoiByName(word), undefined,
      `«${word}» must never bind a POI (it named a business before the fix)`);
    assert.equal(refusesGenericNeedle(word), true, `«${word}» is refused as a needle`);
  }
  // …and REAL names of the same shape keep resolving: the veto is word-exact,
  // so it can only refuse the everyday word itself.
  for (const real of ['СЈО', 'Бариста', 'Петар', 'Седмица']) {
    assert.ok(m.findPoiByName(real), `the real name «${real}» still resolves`);
    assert.equal(refusesGenericNeedle(real), false, `«${real}» is not generic vocabulary`);
  }
});

test('[22:17] a short sound skeleton is not identity for the coverage guard', () => {
  // The collision itself: both fold to «brst», and that was enough.
  assert.equal(poiNameCoversClientWords('БРОЈЧЕТО', 'Barista cafe'), false,
    '«the number» never covers a café');
  assert.equal(poiNameCoversClientWords('бројот', 'Паб Беертија'), false);
  assert.equal(poiNameCoversClientWords('цифрата', 'Зафир'), false);
  assert.equal(poiNameCoversClientWords('адресата', 'Спортска сала Енвер Идризи'), false);
  assert.equal(poiNameCoversClientWords('денот', 'Bela Dent'), false);
  // …while the documented bridges stay: the client's own words, one slip, or
  // the script/spelling families this business is written in.
  assert.equal(poiNameCoversClientWords('BROZ KAFE', 'Broz Cafe'), true);
  assert.equal(poiNameCoversClientWords('ЦИТИ МОЛ', 'Сити Мол'), true);
  assert.equal(poiNameCoversClientWords('ДАЈМОНД МОЛ', 'Diamond Mall'), true);
  assert.equal(poiNameCoversClientWords('КАРОШ', 'Карпош'), true);
  assert.equal(poiNameCoversClientWords('ШПАРАСЕ', 'Шпаркасе'), true);
  assert.equal(poiNameCoversClientWords('СЈО', 'СЈО - Специјално Јавно Обвинителство'), true);
});

// ── 2. The property spec rides with the place, not instead of it ─────────────

test('[22:17] the flat the client appends is stripped off the place name', () => {
  assert.equal(stripTrailingPropertySpec('СЈО ТРОСОБЕН'), 'СЈО');
  assert.equal(stripTrailingPropertySpec('КАЈ СЈО ТРОСОБЕН'), 'КАЈ СЈО');
  assert.equal(stripTrailingPropertySpec('БУЊАКОВЕЦ ДВОСОБЕН СТАН'), 'БУЊАКОВЕЦ');
  assert.equal(stripTrailingPropertySpec('СЈО ГАРСОЊЕРА'), 'СЈО');
  assert.equal(stripTrailingPropertySpec('SJO TROSSOBEN'), 'SJO');
  // nothing to strip → no churn for the caller
  assert.equal(stripTrailingPropertySpec('БУЊАКОВЕЦ'), undefined);
  assert.equal(stripTrailingPropertySpec('СТАН'), undefined);
  assert.equal(stripTrailingPropertySpec(''), undefined);
});

// ── 3. The capture, end to end ──────────────────────────────────────────────

test('[22:17] the capture anchors on СЈО — never on the café the recall word folded into', async () => {
  const { handler, sessions, sent, chatId } = makeHandler();
  await handler.handle('test', chatId, 'ГЛЕДАВ ЕДЕН СТАН КАЈ ВАС НА САЈТ КАЈ СЈО ТРОСОБЕН\nНЕМОЖАМ ДА СЕ СЕТАМ НА БРОЈЧЕТО');
  const reply = sent[sent.length - 1] ?? '';
  const s = sessions.get(chatId)!;

  assert.doesNotMatch(reply, /Бариста|Barista/iu, `the café is never the geography: ${reply}`);
  assert.match(reply, /СЈО/u, `the place the client named is the anchor: ${reply}`);
  assert.match(s.slots.poiAnchor ?? '', /СЈО/u, `the slot holds СЈО: ${JSON.stringify(s.slots.poiAnchor)}`);
  // The serve is the three-room Центар stock around it, not a citywide dump.
  assert.match(reply, /Евидентен број 66/u, `EB 66 is served: ${reply}`);
  assert.match(reply, /трисобен/u, `the type the client named is honoured: ${reply}`);
});

test('[22:17] a recall line after a served batch invents no anchor', async () => {
  const { handler, sessions, sent, chatId } = makeHandler();
  await handler.handle('test', chatId, 'BARAM STAN VO CENTAR');
  const before = sessions.get(chatId)!.slots.poiAnchor;
  for (const line of ['НЕМОЖАМ ДА СЕ СЕТАМ НА БРОЈЧЕТО', 'НЕМОЖАМ ДА СЕ СЕТАМ НА АДРЕСАТА', 'НЕ ЗНАМ КОЈ Е ПЕТТИОТ']) {
    await handler.handle('test', chatId, line);
    const reply = sent[sent.length - 1] ?? '';
    const s = sessions.get(chatId)!;
    assert.equal(s.slots.poiAnchor, before, `«${line}» moves no anchor`);
    assert.doesNotMatch(reply, /во близина на (?:Бариста|Barista|Паб Беертија|Зафир|Bela Dent)/iu,
      `«${line}» never names a venue it invented: ${reply}`);
  }
});
