/**
 * THE [20:50]–[21:05] FIELD BATCH — four defects on one real run (chat
 * «client-1», data/tui.db). The rows below are the live feed's own columns.
 *
 *   1. «А ЕДНА КУЌА ТУКА ИСТО ОКОЛУ УНИВЕРЗАЛНА БЕШЊ?» then «НЕ И ГО ПАМТАМ
 *      БРОЈОТ, АМА ЗНАМ ДЕКА ИМАШЕ ДОБРА ЦЕНА» → «Совршен избор! Можам ли да
 *      Ве запишам за термин за разгледување?» The client was HELPING us find a
 *      house he had seen (no number, no consent for any visit) and got a visit
 *      offer. He must get the closest houses of the category he named, by the
 *      place he named, plus the seen-property closer.
 *   2. «ЗА КОЈА НЕДВИЖНОСТ ПЛАНИРАШ ДА МИ ЗАКАЖЕШ ?» → «Договорената посета е
 *      за станот со Евидентен број 79 (Четврток, 12.11.2026 во 17:00)» — a visit
 *      booked in an EARLIER conversation, replayed into a chat that had arranged
 *      nothing. A present-tense planning question is answered from the live
 *      session only; the booking table belongs to explicit PAST recall.
 *   3. «САКАМ ДА ИЗНАЈМАМ ДУЌАНЧЕ» → «ОКОЛУ КАТОЛИЧКА И БЕВЕРЛИ ХИЛС МОЖЕ» →
 *      ONE unit (EB 59) + «Дали ова е деловниот простор што го видовте?», a
 *      presumption of a prior viewing the client never mentioned. The business
 *      protocol is m² + price, a PAIR near the named places (or an honest
 *      «нема» + alternatives).
 *      ROOT CAUSE FOUND IN THE FEED: EB 42 КАЈ КАТОЛИЧКА (126 м², 1.000 €)
 *      carries tip_na_nedviznina «Деловен простор» but tip_na_sobi «3-собен»,
 *      so the mapper — which called a row commercial only when the BEDROOM
 *      column was empty — filed it as a 3-bedroom flat. It was missing from the
 *      business pool entirely and could be offered to a family.
 *   4. «НАКАЈ АЕРОДРОМ ИМАШ НЕШТО СЛИЧНО ?» → «Евидентен број 57 се наоѓа во
 *      близина на Министерство за правда» + the CENTRE pin: «накај» read as a
 *      side word and the surroundings lane answered about the property on the
 *      table instead of searching Аеродром.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService, Property, mapRow } from '../src/data/properties';
import { resolveIntent, ROUTE_LANES } from '../src/handlers/router';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { EnrichmentStore } from '../src/store/enrichment';
import { BankStore } from '../src/store/bank';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// The live feed's rows for this run (coords and columns copied verbatim).
const ROWS: Property[] = [
  // The stale booking the planning question replayed: a Водно 2-bedroom flat.
  {
    eb: 79, id: 79, uuid: 'eb79', location: 'Водно', address: 'Владимир Назор бр.26-2',
    price: 300, bedrooms: 2, sqm: 35, size: '35 м²', service: 'rent',
    lat: 41.9905, lon: 21.4181, geo_source: 'osm_building',
  },
  {
    eb: 72, id: 72, uuid: 'eb72', location: 'Чаир', address: 'ЧАИР',
    price: 250000, bedrooms: 3, sqm: 265, size: '265 м²', service: 'buy',
    house: true, lat: 42.014, lon: 21.4458, geo_source: 'osm_low_confidence',
  },
  {
    eb: 55, id: 55, uuid: 'eb55', location: 'Влае', address: 'Мраморец 12А',
    price: 40000, bedrooms: 3, sqm: 240, size: '240 м²', service: 'buy',
    house: true, lat: 42.0064, lon: 21.3718, geo_source: 'google_cached',
  },
  {
    eb: 62, id: 62, uuid: 'eb62', location: 'Тафталиџе', address: 'ТЦ ОЛИМПИКО',
    price: 450, bedrooms: 3, sqm: 100, size: '100 м²', service: 'rent',
    house: true, lat: 41.9983, lon: 21.3919, geo_source: 'google_cached',
  },
  {
    eb: 50, id: 50, uuid: 'eb50', location: 'Центар', address: 'Христо Смирненски 41',
    price: 250, bedrooms: 2, sqm: 74, size: '74 м²', service: 'rent',
    house: true, lat: 41.9962, lon: 21.4147, geo_source: 'google_cached',
  },
  // Business spaces, both shapes the feed uses: measured and unmeasured.
  {
    eb: 42, id: 42, uuid: 'eb42', location: 'Центар', address: 'КАЈ КАТОЛИЧКА',
    price: 1000, sqm: 126, size: '126 м²', service: 'rent',
    business: true, lat: 41.9954, lon: 21.4246, geo_source: 'osm_low_confidence',
  },
  {
    eb: 59, id: 59, uuid: 'eb59', location: 'Центар', address: 'ПАЛОМА БЈАНКА',
    price: 950, sqm: 105, size: '105 м²', service: 'rent',
    business: true, lat: 41.9948, lon: 21.4283, geo_source: 'google_cached',
  },
  {
    eb: 57, id: 57, uuid: 'eb57', location: 'Центар', address: 'Ѓуро Стругар',
    price: 1000, service: 'rent',
    business: true, lat: 41.9942, lon: 21.4297, geo_source: 'osm_low_confidence',
  },
  {
    eb: 58, id: 58, uuid: 'eb58', location: 'Центар', address: 'НЕПОЗНАТА',
    price: 1200, service: 'rent',
    business: true, lat: 42.022, lon: 21.4368, geo_source: 'osm_low_confidence',
  },
  {
    eb: 56, id: 56, uuid: 'eb56', location: 'Центар', address: 'НЕПОЗНАТА',
    price: 500, sqm: 40, size: '40 м²', service: 'rent',
    business: true, lat: 42.022, lon: 21.4368, geo_source: 'osm_low_confidence',
  },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getAllEbs(): Promise<Set<number>> { return new Set(this.rows.map(r => r.eb)); }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string, opts: { bookedFor?: number } = {}) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const appointments = new AppointmentStore(db);
  if (opts.bookedFor !== undefined) {
    // EXACTLY the row the [20:54] reply replayed: an earlier conversation's
    // booking, still in the table of this chat.
    appointments.insert({
      chatId: id, clientName: 'CLIENT', clientPhone: '070123456',
      propertyId: opts.bookedFor, service: 'rent', viewingFee: '300',
      time: 'Четврток, 12.11.2026 во 17:00', agentPhone: null,
    });
  }
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions, bank: new BankStore(db),
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(ROWS), appointments,
    escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, appointments, chatId: id, sent };
}

// ── 1. HELP HIM FIND THE HOUSE HE SAW — never a visit offer ────────────────

test('[20:50] «куќа околу Универзална» is a search, not a visit: no term, no appointment', async () => {
  const h = makeHandler('house-recall');
  await h.say('БАРАМ СТАН ЗА КУПУВАЊЕ ДО 60 000 ВО ЦЕНТАР СО 4 СПАЛНИ');
  const ring = await h.say('А ЕДНА КУЌА ТУКА ИСТО ОКОЛУ УНИВЕРЗАЛНА БЕШЊ?');
  assert.match(ring, /Универзална/u, `the place the client named is echoed: ${ring}`);
  assert.doesNotMatch(ring, /запишам|термин|разгледување во живо/u,
    `nothing was agreed — the turn must not offer a viewing: ${ring}`);
  assert.equal(h.sessions.get('house-recall')!.state, 'presentation',
    'still in the funnel, not in a visit flow');
  assert.equal(h.appointments.listByChat('house-recall').length, 0,
    'and nothing was stored');
});

test('[20:51] «НЕ И ГО ПАМТАМ БРОЈОТ…» HELPS: closest houses of the category, seen-property closer', async () => {
  const h = makeHandler('house-help');
  await h.say('БАРАМ СТАН ЗА КУПУВАЊЕ ДО 60 000 ВО ЦЕНТАР СО 4 СПАЛНИ');
  await h.say('А ЕДНА КУЌА ТУКА ИСТО ОКОЛУ УНИВЕРЗАЛНА БЕШЊ?');
  const reply = await h.say('НЕ И ГО ПАМТАМ БРОЈОТ , АМА ЗНАМ ДЕКА ИМАШЕ ДОБРА ЦЕНА');
  // The category he named (куќа) is what we search — not flats.
  assert.match(reply, /куќа/u, `the answer stays on HOUSES: ${reply}`);
  assert.match(reply, /72|55/u, `the closest houses are on the table: ${reply}`);
  // THE CLOSER names the seen-property frame, so he can confirm which it was.
  assert.match(reply, /го видовте/u, `the seen-property closer is the point of the turn: ${reply}`);
  // …and it is STILL not a visit offer (defect 1 is exactly this).
  assert.doesNotMatch(reply, /запишам|за термин|термин за разгледување/u,
    `no visit consent was given — never offer a term: ${reply}`);
  assert.equal(h.sessions.get('house-help')!.state, 'presentation',
    'the funnel keeps its state');
  assert.equal(h.appointments.listByChat('house-help').length, 0, 'nothing was booked');
});

// THE SAME SENTENCE IN A FLAT CHAT (the sibling found while probing this
// batch): the first cut of the recall lane admitted only houses/land/business,
// so a flat client's number-forget fell through to the cheap-price lane and
// heard «Токму затоа и Ви ја предложив — … Дали продолжуваме со разгледување?»
// about a flat he had never judged, then a visit offer.
test('[20:51 sibling] a flat chat HELPS too: no cheap-price praise, no visit offer', async () => {
  const h = makeHandler('flat-help');
  await h.say('БАРАМ ДВОСОБЕН СТАН ВО ВОДНО ДО 400 ЕВРА');
  const reply = await h.say('НЕ И ГО ПАМТАМ БРОЈОТ , АМА ЗНАМ ДЕКА ИМАШЕ ДОБРА ЦЕНА');
  assert.match(reply, /Водно/u, `the place the chat holds anchors the answer: ${reply}`);
  assert.match(reply, /Евидентен број/u, `the closest flats are served: ${reply}`);
  assert.match(reply, /го видовте/u, `the seen-property closer is what he needs: ${reply}`);
  // The value remark is HIS MEMORY of an unidentified listing, never a verdict
  // on the card on the table (detectPriceEval refuses the number-forget).
  assert.doesNotMatch(reply, /Токму затоа|цената е навистина поволна|Одличен вкус/u,
    `a remembered price is not praise for the shown flat: ${reply}`);
  assert.doesNotMatch(reply, /запишам|за термин|организирам посета|разгледување во живо/u,
    `no visit was agreed — never offer one: ${reply}`);
  // THE FUNNEL KEEPS ITS OWN STATE: this chat's first turn was still asking
  // buy-or-rent, and the recall serve answers the client's question without
  // pretending the discovery is finished (the expectation here used to be
  // 'presentation', which was simply what the house chat happened to hold).
  assert.ok(!['visit_scheduling', 'owner_checking', 'time_confirm', 'pending', 'queued',
    'contact_collection'].includes(h.sessions.get('flat-help')!.state),
  `still in the search, not a visit flow: ${h.sessions.get('flat-help')!.state}`);
  assert.equal(h.appointments.listByChat('flat-help').length, 0, 'nothing was booked');
});

// …AND WITH NO CARD ON THE TABLE the value remark is still not praise. The
// cheap-price lane used to read «добра цена» in an EMPTY chat and answer «Токму
// затоа и Ви ја предложив» about a property that did not exist; with nothing to
// judge, the valence axis does not exist (detectPriceEval refuses the
// number-forget) and the funnel keeps the turn.
test('[20:51 sibling] with no card on the table the value remark is not praise', async () => {
  const h = makeHandler('flat-blind');
  const reply = await h.say('НЕ И ГО ПАМТАМ БРОЈОТ , АМА ЗНАМ ДЕКА ИМАШЕ ДОБРА ЦЕНА');
  assert.doesNotMatch(reply, /Токму затоа|цената е навистина поволна|Одличен вкус/u,
    `no praise of a card that is not on the table: ${reply}`);
  assert.doesNotMatch(reply, /организирам посета|термин за разгледување|запишам/u,
    `and no visit: ${reply}`);
  assert.match(reply.trim(), /\?$/u, `the turn still asks something, so it keeps moving: ${reply}`);
  assert.equal(h.appointments.listByChat('flat-blind').length, 0, 'nothing was booked');
});

// ── 2. A PLANNING QUESTION IS ANSWERED FROM THIS CONVERSATION ──────────────

test('[20:54] planning ask never replays an earlier booking', async () => {
  const h = makeHandler('plan-live', { bookedFor: 79 });
  const greeting = await h.say('ДОБАР ДЕН , БАРАМ СТАН ЗА КУПУВАЊЕ');
  assert.ok(greeting.length > 0);
  const reply = await h.say('ЗА КОЈА НЕДВИЖНОСТ ПЛАНИРАШ ДА МИ ЗАКАЖЕШ ?');
  assert.doesNotMatch(reply, /79/u,
    `the chat arranged nothing — the OLD flat must not be served: ${reply}`);
  assert.doesNotMatch(reply, /12\.11\.2026|17:00/u,
    `nor its stored date and time: ${reply}`);
  assert.match(reply, /немаме закажана посета/u,
    `the honest live-session answer: ${reply}`);
  assert.match(reply, /\?/u, `and it asks which property he means: ${reply}`);
  const s = h.sessions.get('plan-live')!;
  assert.notEqual(s.slots.interestedPropertyId, 79,
    'the stale booking must not bind EB 79 as the property on the table');
});

test('[01:2x] an EXPLICIT past recall still reads the booking table', async () => {
  const h = makeHandler('plan-past', { bookedFor: 79 });
  await h.say('ДОБАР ДЕН , БАРАМ СТАН ЗА КУПУВАЊЕ');
  const reply = await h.say('ЗА КОЈ СТАН ТИ КАЖАВ ДА ДОГОВОРИШ ПРЕЕСКА ?');
  assert.match(reply, /79/u, `«прееска» IS a question about the earlier booking: ${reply}`);
  assert.match(reply, /12\.11\.2026/u, `the booked date belongs to that answer: ${reply}`);
  assert.equal(h.sessions.get('plan-past')!.slots.interestedPropertyId, 79,
    'the past recall binds the flat it names (unchanged behaviour)');
});

// ── 3. THE BUSINESS PROTOCOL: m² + price, a PAIR, no viewing presumption ───

test('[20:58] «САКАМ ДА ИЗНАЈМАМ ДУЌАНЧЕ» asks for the area — it presents nothing', async () => {
  const h = makeHandler('biz-ask');
  const reply = await h.say('САКАМ ДА ИЗНАЈМАМ ДУЌАНЧЕ');
  // CONTRACT-LEVEL, not one wording: the bank rotates its variants for
  // discovery.ask.area.business — «во кој дел од градот» and «имате ли
  // одредена населба во градот» are the same question, and pinning the first
  // one made a false failure the moment the rotation moved.
  assert.match(reply, /населба|дел од градот|локација/u, `it asks where: ${reply}`);
  assert.match(reply.trim(), /\?$/u, `and it is a question: ${reply}`);
  assert.doesNotMatch(reply, /Евидентен број/u, `no unit before the place is known: ${reply}`);
  assert.equal(h.sessions.get('biz-ask')!.state, 'discovery');
});

test('[20:59] the pair near Католичка/Беверли Хилс quotes €/м² and presumes no viewing', async () => {
  const h = makeHandler('biz-pair');
  await h.say('САКАМ ДА ИЗНАЈМАМ ДУЌАНЧЕ');
  const reply = await h.say('ОКОЛУ КАТОЛИЧКА И БЕВЕРЛИ ХИЛС МОЖЕ');
  assert.match(reply, /42/u, `EB 42 (126 м², 1.000 €) stands 709 m from Католичка: ${reply}`);
  assert.match(reply, /59/u, `and EB 59 is the second of the PAIR: ${reply}`);
  assert.match(reply, /€\/м²|евра\/м²|[0-9]\s*€\/м²|€\s*\/\s*м²/u,
    `the operator's protocol is price per m²: ${reply}`);
  assert.match(reply, /8\s*€|8\s*евра/u, `EB 42's rate (1.000 / 126 ≈ 8 €/м²): ${reply}`);
  assert.doesNotMatch(reply, /деловниот простор што го видовте/u,
    `he asked to rent a shop — he never said he had seen one: ${reply}`);
  assert.doesNotMatch(reply, /Евидентен број на недвижноста, кажете ми го/u,
    `no «give me the number» detour on a business search: ${reply}`);
});

test('a business row whose bedroom column carries a layout is STILL business (EB 42)', () => {
  const row = mapRow({
    evidenten_broj: '42', naslov: 'Деловен простор 3-собен',
    tip_na_nedviznina: 'Деловен простор', tip_na_sobi: '3-собен',
    servis: 'Издава', naselba: 'Центар (населба)', adresa: 'КАЈ КАТОЛИЧКА',
    cena_eur: 1000, povrsina_m2: 126, lat: 41.9954, lon: 21.4246,
  });
  assert.ok(row, 'the row maps');
  assert.equal(row!.business, true,
    'tip_na_nedviznina «Деловен простор» wins over the layout in tip_na_sobi');
  assert.equal(row!.bedrooms, undefined,
    'a business space has no bedroom count — it must never answer a 3-bedroom flat search');
});

// ── THE MIRROR KNOWS BOTH LANES, AND SEES THE SESSION ────────────────────────
// The shadow router compared its prediction with the served lane, and the
// Аеродром turn came back `predicted=SURROUNDINGS actual=BUSINESS_PLACE_SERVE`
// — the drift log blaming the lane that was right. Both rows are registered
// now, in the executor's own position (above PRICE_EVAL_CHEAP and
// SURROUNDINGS), AND the mirror is handed the session slots: the two lanes are
// gated on what the chat HOLDS (a business space, a category + a place), so a
// text-only prediction is a coin toss — the business place turn was predicted
// FALLTHROUGH and a RESIDENTIAL similarity ask was predicted as business.

test('[20:51]/[21:05] the route mirror predicts the two new lanes, not their neighbours', () => {
  assert.ok(ROUTE_LANES.SEEN_RECALL_HELP?.intent, 'the recall help lane has a calibration row');
  assert.ok(ROUTE_LANES.BUSINESS_PLACE_SERVE?.intent, 'the business place serve has a row');
  const forget = 'НЕ И ГО ПАМТАМ БРОЈОТ, АМА ЗНАМ ДЕКА ИМАШЕ ДОБРА ЦЕНА';
  // THE VALUE REMARK INSIDE THE FORGET IS NOT A PRICE OPINION — and the lane is
  // only predictable with the notebook: a flat category plus the area it holds.
  assert.equal(resolveIntent(forget, 'presentation', { bedrooms: 2, location: 'Водно' } as never),
    'SEEN_RECALL_HELP');
  // WITHOUT that memory the executor stands down (property_locate owns the
  // «which one did you see?» turn), and the mirror says so.
  assert.notEqual(resolveIntent(forget, 'discovery'), 'SEEN_RECALL_HELP',
    'no category and no place on file: the locate funnel keeps the turn');

  // «накај» is the client's own search direction here, not a side word.
  const similar = 'НАКАЈ АЕРОДРОМ ИМАШ НЕШТО СЛИЧНО ?';
  assert.equal(resolveIntent(similar, 'discovery', { business: true, service: 'rent' } as never),
    'BUSINESS_PLACE_SERVE', 'business traffic: the place in this turn is the anchor');
  // THE SAME SENTENCE IN A RESIDENTIAL CHAT IS NOT THE BUSINESS LANE (the
  // limitation this test used to document). With the flat memory the business
  // row cannot fire, and the ring row does not either until the pool speaks.
  assert.notEqual(resolveIntent(similar, 'presentation', { bedrooms: 2, service: 'buy' } as never),
    'BUSINESS_PLACE_SERVE');
  assert.notEqual(resolveIntent(similar, 'presentation', { bedrooms: 2, service: 'buy' } as never),
    'SURROUNDINGS', 'a similarity ask is a SEARCH, never a which-side question');
  // …AND WHEN THE POOL SAYS NOTHING IS INSIDE THE RING, the refined prediction
  // names the lane the executor is about to serve (inbound.ts re-predicts right
  // after loadProps, so the drift log stays clean).
  assert.equal(
    resolveIntent(similar, 'presentation', { bedrooms: 2, service: 'buy', poiTooFarAsk: true } as never),
    'PLACE_RING_ASK');
});

// ── 4. «НАКАЈ АЕРОДРОМ ИМАШ НЕШТО СЛИЧНО?» IS A SEARCH ─────────────────────

test('[21:05] a similar-ask near Аеродром answers Аеродром, never a centre landmark', async () => {
  const h = makeHandler('biz-aerodrom');
  await h.say('САКАМ ДА ИЗНАЈМАМ ДУЌАНЧЕ');
  await h.say('ОКОЛУ КАТОЛИЧКА И БЕВЕРЛИ ХИЛС МОЖЕ');
  const reply = await h.say('НАКАЈ АЕРОДРОМ ИМАШ НЕШТО СЛИЧНО ?');
  assert.match(reply, /Аеродром/u, `the place he asked about is the subject: ${reply}`);
  assert.match(reply, /немам/u, `nothing within the business ring — say so honestly: ${reply}`);
  assert.doesNotMatch(reply, /Министерство за правда/u,
    `EB 57's centre landmark is not an answer about Аеродром: ${reply}`);
  assert.doesNotMatch(reply, /maps\.google/u,
    `and no pin from the property on the table: ${reply}`);
  assert.match(reply, /Евидентен број/u, `other options are offered instead: ${reply}`);
  assert.match(reply, /€\/м²|евра\/м²|€\s*\/\s*м²/u,
    `the alternatives carry the rate, so he can compare: ${reply}`);
});
