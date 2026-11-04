// THE [01:05] CAPTURE — A CLASS WORD APPENDED TO A PLACE NAME.
//
//   [01:05] ZDRAVO. MI TREBA STANCE KAJ KAPITOL MOL
//   [01:06] ЛИНА: Повелете. Дали планирате да купите… (the market question)
//   [01:06] KE KUPUVAM
//   [01:07] ЛИНА: На кој дел од градот … стан?          ← the bug
//
// The client named КАПИТОЛ МОЛ, the map holds «ТЦ Капитол», «Трговски центар
// Капитол» and «Shopping Center Capitol Mall» — and NONE of them contains the
// word «мол». So:
//   • the fuzzy lookup returned «Kupi Moment Capitol Mall» (a Flower market
//     inside the mall, whose name happens to carry both words);
//   • the coverage guard correctly refused it (its identity head is «kupi», a
//     word the client never said — `data/place-misses-2026-11-03.jsonl` records
//     exactly this: `{"text":"капитол мол","refused":"Kupi Moment Capitol Mall"}`);
//   • the second-chance `findPoisByName` needs the row to CONTAIN the whole
//     phrase, found nothing, and the place died — the funnel then asked for a
//     neighbourhood the client had just named.
//
// The contract these tests pin:
//   • a CLASS tail («мол», «маркет», «болница»…) may be dropped from the
//     client's run only when the map row DECLARES that same class — «ТЦ
//     Капитол» does («ТЦ»), the military ACADEMY does not, and the shop «Веро 9»
//     declares no mall word for «Веро Центар»;
//   • the identity-head refusal is untouched: «Kupi Moment Capitol Mall» (a
//     flower market) never binds «капитол мол»;
//   • the real pipeline anchors the search on the place and never asks for a
//     neighbourhood, then moves on to the flat's own criteria.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
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

const cfg = loadConfig();
const hasMap = !!cfg.skopjePoisDb && fs.existsSync(cfg.skopjePoisDb);

// ── 1. THE GUARD: a class tail is droppable ONLY when the row declares it ────

test('[01:05] a class tail binds the row that declares the same class', () => {
  // The capture: the mall the client named, in each spelling the map uses.
  assert.equal(poiNameCoversClientWords('капитол мол', 'ТЦ Капитол'), true,
    'the map\'s «ТЦ» IS the client\'s «мол» — same class, and the head is Капитол');
  assert.equal(poiNameCoversClientWords('kapitol mol', 'Трговски центар Капитол'), true,
    '«трговски центар» declares the mall class in Latin input too');
  assert.equal(poiNameCoversClientWords('бисер мол', 'Biser Shopping Center'), true,
    'the same shape for the other Aerodrom mall');
  assert.equal(poiNameCoversClientWords('капитол', 'ТЦ Капитол'), true,
    'the bare name still binds (the class tail adds nothing it removes)');
});

test('[01:05] the row TYPE counts as declaring the class — a brand-only row still binds', () => {
  // The map holds malls whose name carries no class word at all. The OSM type
  // is the row's own statement of what it IS, so the client's «мол» may be
  // dropped against it — as long as the identity head is a word he said.
  assert.equal(poiNameCoversClientWords('олимпико мол', 'Олимпико', 'mall'), true,
    'a mall filed by brand alone still declares the mall class');
  assert.equal(poiNameCoversClientWords('олимпико мол', 'Олимпико', 'Shopping mall'), true,
    'the OSM spelling with a space declares it too');
  assert.equal(poiNameCoversClientWords('бисер маркет', 'Biser', 'Supermarket'), true,
    'the same for a supermarket and «маркет»');
  // The type may never LIFT a different place: a supermarket is not a mall.
  assert.equal(poiNameCoversClientWords('олимпико мол', 'Олимпико', 'Supermarket'), false,
    'a supermarket row does not declare the mall class');
  assert.equal(poiNameCoversClientWords('веро центар', 'Веро 9', 'Supermarket'), false,
    'the shop inside the mall stays refused with its type on file');
  assert.equal(poiNameCoversClientWords('воена болница', 'Воена академија Генерал Михаило Апостолски', 'School'), false,
    'a school does not declare the hospital class');
});

test('[01:05] dropping the class tail may never bind a DIFFERENT place', () => {
  // The row the fuzzy ranking returned: a flower market inside the mall. Its
  // identity head is «kupi» — a word the client never said — so the drop must
  // not open it up.
  assert.equal(poiNameCoversClientWords('капитол мол', 'Kupi Moment Capitol Mall'), false,
    'a tenant/odd row whose head the client never named stays refused');
  // The documented refusal this rule must not weaken: «ВОЕНА БОЛНИЦА» is the
  // ГОБ hospital, never the military ACADEMY five kilometres away.
  assert.equal(poiNameCoversClientWords('воена болница', 'Воена академија Генерал Михаило Апостолски'), false,
    'a class the row does not declare is a different place');
  // «Веро Центар» (the mall) and «Веро 9» (the shop inside it) are different
  // places whose brand is identical — the class word is the only separator.
  assert.equal(poiNameCoversClientWords('веро центар', 'Веро 9'), false,
    'a shop declares no mall class');
  // The brand-in-front refusal is untouched.
  assert.equal(poiNameCoversClientWords('vo novo lisice', 'ELS Novo Lisice'), false);
  // …and a class word is not a licence to skip the identity head either.
  assert.equal(poiNameCoversClientWords('капитол мол', 'Ramstore - Kapitol'), false,
    'the supermarket next door is not the mall');
});

// ── 2. THE REAL PIPELINE ────────────────────────────────────────────────────

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 401, id: 401, location: 'Аеродром', price: 88000, bedrooms: 2, sqm: 55, size: '55 м²', service: 'buy', lat: 41.9859, lon: 21.4666 },
  { eb: 402, id: 402, location: 'Аеродром', price: 96000, bedrooms: 2, sqm: 60, size: '60 м²', service: 'buy', lat: 41.9862, lon: 21.4670 },
];

function makeHandler() {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const properties = new FakeProps(ROWS);
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
    await handler.handle('test', 'capitol-mol', m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId: 'capitol-mol' };
}

const AREA_QUESTION = /дел од градот|населба|локациј|градот/iu;

test('[01:05] sweep: a FOUR-letter name keeps its one slip, and a short word never rides the sound key', () => {
  // The captured miss «чаим беут џамија» is the map's «Чазим Беут Џамија»: one
  // inserted letter in a FOUR-letter name, which the old 5-letter floor refused.
  assert.equal(poiNameCoversClientWords('чаим беут џамија', 'Чазим Беут Џамија', 'place_of_worship'), true,
    'the mosque the client named must bind');
  // …and the extractor's second candidate «чаим» must never ride the sound key
  // to the shop «KAM» (both fold to «km»): the funnel anchored a supermarket
  // for a mosque question. A lone short word is only itself.
  assert.equal(poiNameCoversClientWords('чаим', 'KAM', 'supermarket'), false,
    'the sound key folded чаим to KAM — a supermarket is not the mosque');
  assert.equal(poiNameCoversClientWords('кам', 'KAN'), false, 'three-letter names stay exact');
  // The long-word bridges the guard exists for are untouched.
  assert.equal(poiNameCoversClientWords('ДАЈМОНД МОЛ', 'Diamond Mall'), true);
  assert.equal(poiNameCoversClientWords('Бунјаковац', 'Буњаковец'), true);
  assert.equal(poiNameCoversClientWords('city mall', 'Skopje City Mall'), true);
});

test('[01:05] e2e: the mosque by its captured spelling anchors itself, not a shop', { skip: !hasMap }, async () => {
  const { say, sessions, chatId } = makeHandler();
  const reply = await say('ZDRAVO SAKAM DA KUPAM STAN KAJ чаим беут џамија');
  const anchor = sessions.get(chatId)!.slots.poiAnchor;
  assert.match(anchor ?? '', /Чазим|беут|џамија/iu, `the mosque must anchor the search (never «KAM»): ${reply}`);
  assert.ok(!AREA_QUESTION.test(reply), `the place he named must not trigger an area ask: ${reply}`);
});

test('[01:05] e2e: «KAJ KAPITOL MOL» anchors the search — the area is never asked', { skip: !hasMap }, async () => {
  const { say, sessions, chatId } = makeHandler();
  const first = await say('ZDRAVO. MI TREBA STANCE KAJ KAPITOL MOL');
  const s = sessions.get(chatId)!;
  assert.ok(s.slots.poiAnchor, `the named mall must anchor the search: ${first}`);
  assert.match(s.slots.poiAnchor!, /апитол|apitol/iu,
    `the anchor must be the mall the client named: ${s.slots.poiAnchor}`);
  assert.ok(!AREA_QUESTION.test(first), `the area he just named must not be asked: ${first}`);

  // The market answer moves on to the flat's OWN criteria — bedrooms and price
  // — never back to the neighbourhood.
  const second = await say('KE KUPUVAM');
  assert.equal(sessions.get(chatId)!.slots.service, 'buy');
  assert.match(second, /спалн/iu, `bedrooms asked: ${second}`);
  assert.match(second, /цена|буџет/iu, `price asked: ${second}`);
  assert.ok(!AREA_QUESTION.test(second), `the area is on file — never re-asked: ${second}`);
});
