// THE [19:46] CAPTURE — a flat request answered with a quarter of town.
//
//   [19:45] ДВОСОБЕН МИ ТРЕБА
//   [19:45] ЛИНА: Моментално во системот нема двособни до 300 евра месечно во
//                  Центар. Дали да барам во друга населба, да ја прошириме
//                  цената, или да ги забележам Вашите критериуми…?
//   [19:46] А ВО КОЈА НАСЕЛБА ИМА?
//   [19:46] ЛИНА: Image Plus се наоѓа во Шуто Оризари.                     ✗
//
// Two defects, both fixed at the cause:
//
//  1. THE TRAILING VERB WAS READ AS A PLACE NAME. `AREA_OF_PLACE_RE` captured
//     the tail after «во која населба», and in this sentence the tail IS the
//     verb («има»). The extractor only rejected property nouns / ЕВ numbers, so
//     «има» went to the map as if it were a landmark.
//  2. THE MAP RESOLVED ANY SHORT WORD. Its contains pass compared raw
//     substrings, so «ИМА»→«Image Plus», «НЕМА»→«Cinematheque of Macedonia»,
//     «ИМАТЕ»→«Primatex», «ДА»→«ДАЛЕКС», and the phonetic pass turned
//     «MOZE»→«Mezzo». Grammar words are not names: a partial hit must now start
//     a word (or be a whole word of two letters and up, for real acronyms), and
//     the phonetic/variant/typo last resorts need ≥5 letters.
//
// And the turn itself was uncovered: nobody owned «which neighbourhood HAS
// them», so it fell into the place lane. It is an AREA RELEASE — the client has
// just accepted another quarter — and the answer is the pair plus the
// neighbourhoods that hold it.
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
import { OfflineMapStore, wordAlignedHit } from '../src/geo/offlineMap';
import { setLearnedBank } from '../src/data/responseBank';
import {
  detectAreaHaveAsk, detectWhichAreaHas, extractAreaOfPlaceQuestion,
  extractWhereLandmarkPlace, isAreaOfPlaceQuestion,
} from '../src/llm/deterministic';

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
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(p => p.id === id); }
  get healthy(): boolean { return true; }
}

// The pool: the two-bedroom under 300 € exists only OUTSIDE Центар.
const SUTO2: Property = {
  eb: 51, id: 51, uuid: 'suto-51', address: 'УЛ. А', location: 'Шуто Оризари',
  service: 'rent', price: 280, bedrooms: 2, sqm: 55, size: '55 м²',
} as Property;
const KARPOS2: Property = {
  eb: 52, id: 52, uuid: 'karpos-52', address: 'УЛ. Б', location: 'Карпош',
  service: 'rent', price: 290, bedrooms: 2, sqm: 58, size: '58 м²',
} as Property;
// Центар holds one, but OVER the cap — the release must not invent it as a fit.
const CENTAR2: Property = {
  eb: 53, id: 53, uuid: 'centar-53', address: 'УЛ. В', location: 'Центар',
  service: 'rent', price: 350, bedrooms: 2, sqm: 60, size: '60 м²',
} as Property;
// Not a two-bedroom.
const AERODROM1: Property = {
  eb: 54, id: 54, uuid: 'aerodrom-54', address: 'УЛ. Г', location: 'Аеродром',
  service: 'rent', price: 200, bedrooms: 1, sqm: 35, size: '35 м²',
} as Property;

function makeHandler(): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps([SUTO2, KARPOS2, CENTAR2, AERODROM1]);
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

// ── 1. THE DETECTORS ─────────────────────────────────────────────────────────

test('[19:46] «А ВО КОЈА НАСЕЛБА ИМА?» is an availability ask, not a place ask', () => {
  const text = 'А ВО КОЈА НАСЕЛБА ИМА?';
  assert.equal(detectWhichAreaHas(text), true, 'the which-area-have lane owns it');
  assert.equal(detectAreaHaveAsk(text), true, 'it is an area-availability probe');
  assert.equal(isAreaOfPlaceQuestion(text), false, 'never the place-neighbourhood lane');
  assert.equal(extractAreaOfPlaceQuestion(text), undefined,
    'the trailing verb is a predicate, not a place name');
});

test('[19:46] the which-area-have family fires in every word order, raw and Latin', () => {
  for (const text of [
    'А ВО КОЈА НАСЕЛБА ИМА?',
    'во која населба има',
    'А ВО КОИ НАСЕЛБИ ИМА ?',
    'ВО КОЈ ДЕЛ ИМА ДВОСОБЕН?',
    'A VO KOI NASELBI IMA ?',
    'ima vo koja naselba?',
    'ИМА ВО КОЈА НАСЕЛБА?',
  ]) {
    assert.equal(detectWhichAreaHas(text), true, `must fire: ${text}`);
    assert.equal(isAreaOfPlaceQuestion(text), false, `never a place ask: ${text}`);
    assert.equal(extractAreaOfPlaceQuestion(text), undefined, `no place name: ${text}`);
  }
});

test('[V16K11 06:31] the SHORT «a kade ima?» is the same area-availability ask', () => {
  // The exhausted line had just offered «во друга населба»; the client answered
  // with the short form of the [19:46] question and the funnel repeated its
  // dead end. Same class, shorter phrasing — it must own the same lane.
  for (const text of [
    'a kade ima?', 'kade ima?', 'КАДЕ ИМА?', 'kade ima', 'gde ima?',
    'a kaj ima?', 'a kade ima uste?', 'kade ima stanovi?', 'КАДЕ ИМА НЕШТО ?',
  ]) {
    assert.equal(detectWhichAreaHas(text), true, `the stock probe: ${text}`);
    assert.equal(detectAreaHaveAsk(text), true, `an area-availability probe: ${text}`);
  }
  // …while a question about a PLACE keeps its own lane: the end anchor is the
  // guard, so anything the client names after «каде има» is not stock talk.
  for (const text of [
    'kade ima park?', 'каде има аптека?', 'kade ima TC Leptokarija?',
    'kade e stanot?', 'kade se naogja EB 88?',
  ]) {
    assert.equal(detectWhichAreaHas(text), false, `not the stock probe: ${text}`);
  }
});

test('a genuine place-neighbourhood ask keeps its lane', () => {
  for (const text of [
    'ВО КОЈА НАСЕЛБА Е ТЦ ЛЕПТОКАРИЈА?',
    'TE PRASUVAM VO KOJA NASELBA E TC LEPTOKARIJA',
  ]) {
    assert.equal(detectWhichAreaHas(text), false, `not availability: ${text}`);
    assert.equal(isAreaOfPlaceQuestion(text), true, `stays the place lane: ${text}`);
  }
  // A bare «каде има?» ends in the same verb: no place name may be extracted.
  assert.equal(extractWhereLandmarkPlace('КАДЕ ИМА?'), undefined);
});

// ── 2. THE MAP ───────────────────────────────────────────────────────────────

test('a grammar word never resolves to a POI, a real name still does', () => {
  const m = map();
  for (const word of ['ИМА', 'има', 'НЕМА', 'ИМАТЕ', 'ДА', 'MOZE']) {
    assert.equal(m.findPoiByName(word), undefined,
      `«${word}» is grammar, not a place — it must MISS`);
  }
  assert.ok(m.findPoiByName('Image Plus'), 'the real venue still resolves');
  assert.ok(m.findPoiByName('Лептокарија'), 'a word-prefix name still resolves');
  // The alignment rule itself, independent of this map snapshot: acronyms and
  // word starts stay reachable, fragments inside longer words never do.
  assert.equal(wordAlignedHit('градски трговски центар (гтц)', 'гтц'), true);
  assert.equal(wordAlignedHit('тц скопјанка', 'тц'), false,
    'two letters are never a name — a real «ТЦ Скопјанка» query carries both words');
  assert.equal(wordAlignedHit('ми-да гранд моторс', 'да'), false,
    'a whole word of two letters inside a hyphenated brand is still not the brand');
  assert.equal(wordAlignedHit('лептокарија мол', 'лепто'), true);
  assert.equal(wordAlignedHit('image plus', 'има'), false);
  assert.equal(wordAlignedHit('image plus', 'ima'), false);
  assert.equal(wordAlignedHit('cinematheque of macedonia', 'нема'), false);
  assert.equal(wordAlignedHit('primatex', 'имате'), false);
  assert.equal(wordAlignedHit('далекс', 'да'), false);
});

// ── 3. THE TURN ──────────────────────────────────────────────────────────────

test('[V16K11 06:31] «a kade ima?» after a drained area answers with the areas that hold stock', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'where-has';
  const s = freshSession('test', chatId);
  s.state = 'presentation';
  // The live notebook: a size-waived rent search in Центар — no room tier at
  // all — with the Центар card already on the screen.
  s.slots = {
    service: 'rent', budget: '350', location: 'Центар (населба)', sizeWaived: true,
    presentedIds: [53], currentBatch: [53], categoriesServedGeo: 'Центар (населба)|',
  };
  s.history = [
    { role: 'user', text: 'mi treba stan pod kirija / centar' },
    { role: 'assistant', text: 'Станот под Евидентен број 53 е двособен стан во Центар. Цената е 350 евра месечно.' },
  ];
  sessions.set(s);

  await handler.handle('test', chatId, 'a kade ima?');
  const reply = sent.at(-1) ?? '';
  const opener = reply.split('\n')[0] ?? '';
  // THE LIVE DEFECT: the turn claimed «Моментално во системот нема станови до
  // 300 евра месечно во Центар» while the card it had just served sat above.
  assert.ok(!/во системот нема/iu.test(reply),
    `a batch on the table is never an empty system: ${reply}`);
  // AND IT ANSWERS THE QUESTION: the areas that DO hold it, then the cards.
  assert.match(reply, /Евидентен број 51/u, `the Шуто Оризари flat serves: ${reply}`);
  assert.match(opener, /Шуто Оризари/u, `the opener names the area: ${opener}`);
  const after = sessions.get(chatId);
  assert.equal(after?.slots.anywhere, true, 'the area criterion is released');
  assert.equal(after?.slots.location, undefined, 'the drained area lock is dropped');
});

test('a search whose stock is DRAINED talks about its own stock, never about the system', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'drained-not-empty';
  const s = freshSession('test', chatId);
  s.state = 'presentation';
  // Every in-budget row of the city has been shown already: the pool is empty
  // only because of `presentedIds`, so «нема во системот» would deny stock the
  // client is looking at.
  s.slots = {
    service: 'rent', budget: '350', location: 'Шуто Оризари', sizeWaived: true,
    presentedIds: [51], currentBatch: [51],
  };
  sessions.set(s);

  await handler.handle('test', chatId, 'a ima uste?');
  const reply = sent.at(-1) ?? '';
  assert.ok(!/во системот нема/iu.test(reply),
    `the drained sentence, not a system claim: ${reply}`);
});


test('[19:46] the which-area ask releases the area and serves the pair', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'which-area';
  const s = freshSession('test', chatId);
  s.state = 'presentation';
  s.slots = { service: 'rent', budget: '300', bedrooms: 2, location: 'Центар' };
  s.history = [
    { role: 'user', text: 'ДОБАР ДЕН. ДАЛИ ИМАТЕ СЛОБОДНИ СТАНОВИ ЗА ИЗНАЈМУВАЊЕ ВО ЦЕНТАР ДО 300 ЕВРА' },
    { role: 'user', text: 'ДВОСОБЕН МИ ТРЕБА' },
    { role: 'assistant', text: 'Моментално во системот нема двособни до 300 евра месечно во Центар. Дали да барам во друга населба, да ја прошириме цената, или да ги забележам Вашите критериуми и да Ве известам штом се појави соодветна опција?' },
  ];
  sessions.set(s);

  await handler.handle('test', chatId, 'А ВО КОЈА НАСЕЛБА ИМА?');
  const reply = sent.at(-1) ?? '';
  console.log('WHICH-AREA REPLY:', reply);
  console.log('SLOTS:', JSON.stringify(sessions.get(chatId)?.slots));

  // The AREA names in the opener ARE the answer; only the landmark phrasing is
  // the defect. (The first draft here forbade «Шуто Оризари.» and failed on
  // the CORRECT reply — the sentence legitimately ends with the area it names.)
  const opener = reply.split('\n')[0] ?? '';
  assert.ok(!/Image Plus|се наоѓа во/iu.test(opener),
    `never a landmark answer: ${reply}`);
  assert.match(reply, /Евидентен број 51/u, `the Шуто Оризари flat must serve: ${reply}`);
  assert.match(reply, /Евидентен број 52/u, `the Карпош flat must serve: ${reply}`);
  assert.ok(!/Евидентен број 53/u.test(reply), `over-budget Центар must not serve: ${reply}`);
  assert.ok(!/Евидентен број 54/u.test(reply), `a one-room flat must not serve: ${reply}`);
  // The neighbourhoods named in the opener are the batch's own, not invented.
  assert.match(opener, /Шуто Оризари/u, `names the area it serves: ${opener}`);
  assert.match(opener, /Карпош/u, `names the area it serves: ${opener}`);

  const after = sessions.get(chatId);
  assert.equal(after?.slots.anywhere, true, 'the area criterion is released');
  assert.equal(after?.slots.location, undefined, 'the old area lock is dropped');
});
