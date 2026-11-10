/**
 * THE [23:47]–[23:51] RUN (the 22:47–22:50 capture rows) — six defects in one
 * rent conversation «околу УНИВЕРЗАЛНА и КАТОЛИЧКА, до 300 евра»:
 *
 *   [22:47] ЗА РЕНТАЊЕ СУМ ЗАИНТЕРЕСИРАН ОКОЛУ УНИВЕРЗАЛНА , КАТОЛИЧКА
 *   [22:47] ЛИНА: Дали купувате или изнајмувате …                        ✗ (рентање is rent)
 *   [22:48] ПА ТИ КАЖАВ КАДЕ
 *   [22:48] ЛИНА: Во кој дел од градот?                                  ✗ (the landmarks ARE the area)
 *   [22:49] ЗА ЖИВЕЕЊЕ МИ Е                                             ✗ (a type answer)
 *   [22:49] ЛИНА: Кој тип недвижност — стан, куќа …?                     ✗ (she lives there → residential)
 *   [22:50] БИТНО Е ДА Е ДО 300 ЕВРА                                      ✗ (that answers the size ask)
 *   [22:50] ЛИНА: <flats only, «нема куќи»>                              ✗ (the 250 € house exists)
 *   [22:51] НЕБИТНО                                                      ✗ (re-asked, then pivoted)
 *
 * The owner's rules: apartments AND houses till 300 €, rated by the money and
 * the distance to the named landmarks; a client who wants to LIVE there is
 * never served a плац/дуќан; and when she says «ти кажав каде», read the chat
 * back instead of asking again.
 *
 * Every case is asserted at the level the operator sees: slots + served copy.
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
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { displayPlaceName, displayAreaName } from '../src/llm/prompts';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import {
  detectService, detectResidentialNeed, detectBareCriterionDismissal,
  detectAnywhere, detectToldYouNag,
} from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// Универзална Сала 41.9992211/21.4164767 · Римокатоличка Катедрала
// 41.9949745/21.4178397. The rows mirror the live feed: EB 50 IS the 74 м²
// house for 250 € (the one the presentation dropped), EB 76 the 24 м²
// гарсоњера for 200 €, EB 79 the 35 м² двособен in Водно for 300 €, EB 48 a
// 2.1 km Карпош III flat — the far card the anchored opener must not claim.
const ROWS: Property[] = [
  { eb: 76, id: 76, address: 'Ул. Македонија 12', location: 'Центар', price: 200, sqm: 24,
    size: '24 м²', studio: true, service: 'rent', lat: 41.9985, lon: 21.4175,
    details: 'Гарсоњера во строг центар, целосно наместена.' },
  { eb: 50, id: 50, address: 'Ул. Никола Вапцаров 3', location: 'Центар', price: 250, sqm: 74,
    size: '74 м²', house: true, service: 'rent', lat: 41.9989, lon: 21.4150,
    details: 'Се изнајмува куќа со двор и тераса, двоспратна галерија.' },
  { eb: 79, id: 79, address: 'Водно', location: 'Водно', price: 300, sqm: 35, bedrooms: 2,
    size: '35 м²', service: 'rent', lat: 41.9940, lon: 21.4100,
    details: 'Двособен стан, целосно наместен, подно греење.' },
  { eb: 48, id: 48, address: 'Карпош III', location: 'Карпош', price: 250, sqm: 40, bedrooms: 1,
    size: '40 м²', service: 'rent', lat: 42.0030, lon: 21.3900,
    details: 'Еднособен стан во Карпош III.' },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getAllEbs(): Promise<number[]> { return this.rows.map(r => r.eb); }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  async getById(id: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === id || r.id === id);
  }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string, rows: Property[] = ROWS) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(rows)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(rows),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId: id };
}

// ── 1. «РЕНТАЊЕ» IS RENT ────────────────────────────────────────────────────

test('[22:47] «рентање» and its inflections are the rent service, in both scripts', () => {
  for (const t of ['РЕНТАЊЕ', 'ЗА РЕНТАЊЕ', 'РЕНТАЊЕ НА СТАН', 'БАРАМ ЗА РЕНТАЊЕ',
    'RENTANJE', 'ZA RENTANJE', 'РЕНТИРАЊЕ', 'ИЗНАЈМУВАЊЕ', 'КИРИЈА']) {
    assert.equal(detectService(t), 'rent', `"${t}" is rent`);
  }
  // The noun alone must never read as a BUY request, and the buy words stay buy.
  assert.notEqual(detectService('РЕНТАЊЕ'), 'buy');
  assert.equal(detectService('КУПУВАЊЕ'), 'buy');
  // «РЕНТАБИЛНОСТ» is YIELD, not a lease — the stem may not swallow the
  // adjective (an investor asking about rentability is not a renter).
  for (const t of ['РЕНТАБИЛНОСТА НА СТАНОТ?', 'KOJA E RENTABILNOSTA']) {
    assert.notEqual(detectService(t), 'rent', `"${t}" is not a lease`);
  }
});

// ── 2. «ЗА ЖИВЕЕЊЕ» IS A TYPE ANSWER, NOT A TYPE QUESTION ───────────────────

test('[22:49] «за живеење» / «стан или куќа» means EITHER residential type', () => {
  for (const t of ['ЗА ЖИВЕЕЊЕ МИ Е', 'ЗА ЖИВЕЕЊЕ', 'СТАН ИЛИ КУЌА', 'СТАН ИЛИ КУКЈА',
    'ZA ZIVEENJE MI E', 'STAN ILI KUKJA', 'ДА ЖИВЕАМ ТАМУ']) {
    assert.equal(detectResidentialNeed(t), true, `"${t}" releases the type question`);
  }
  // A single stated type keeps its own meaning — no widening.
  assert.equal(detectResidentialNeed('САКАМ СТАН'), false);
  assert.equal(detectResidentialNeed('САКАМ КУЌА'), false);
  // A business need is not residential: the client who lives there is never
  // served deloven prostor / плац.
  assert.equal(detectResidentialNeed('БАРАМ ДЕЛОВЕН ПРОСТОР'), false);
  assert.equal(detectResidentialNeed('БАРАМ ПЛАЦ ЗА ГРАДЕЊЕ'), false);
});

test('[22:49] the residential widening keeps flats AND houses, drops business/planc', async () => {
  const svc = new FakeProps(ROWS);
  const both = await svc.candidates({ service: 'rent', budget: '300', house: 'both' });
  const ids = both.map(p => p.eb);
  assert.ok(ids.includes(50), `the 250 € house is in the pool: ${ids}`);
  assert.ok(ids.includes(76), `and the гарсоњера: ${ids}`);
  assert.ok(ids.includes(79), `and EB 79: ${ids}`);
  const flatsOnly = await svc.candidates({ service: 'rent', budget: '300', house: false });
  assert.ok(!flatsOnly.some(p => p.eb === 50), 'house:false still excludes it');
  const biz: Property = { eb: 90, id: 90, address: 'Булевар', location: 'Центар',
    price: 250, business: true, service: 'rent', lat: 41.9986, lon: 21.4170 };
  const withBiz = await new FakeProps([...ROWS, biz])
    .candidates({ service: 'rent', budget: '300', house: 'both' });
  assert.ok(!withBiz.some(p => p.eb === 90),
    'a business space never joins a residential batch — the client lives there');
});

// ── 3. «НЕБИТНО» ANSWERS WHAT WAS ASKED ─────────────────────────────────────

test('[23:48] a bare dismissal is an answer shape — the lane decides which', () => {
  for (const t of ['НЕБИТНО', 'NEBITNO', 'BILO KOJA', 'БИЛО КОЈА', 'СЕЕДНО']) {
    assert.equal(detectBareCriterionDismissal(t), true, `"${t}" is a dismissal`);
  }
  // The predicate itself cannot know WHICH criterion — it only knows the shape.
  // That is why the handler decides by the question the client is answering.
  assert.equal(detectBareCriterionDismissal('НЕБИТНО КОЛКУ СОБИ'), true);
  assert.equal(detectBareCriterionDismissal('САКАМ ДВОСОБЕН'), false);
  // The adverb slot of «anywhere» still exists — the handler must not widen it
  // to a SIZE dismissal just because the text says «небитно».
  assert.equal(detectAnywhere('БИЛО КАДЕ'), true);
});

// ── 4. «ПА ТИ КАЖАВ КАДЕ» — READ THE CHAT BACK ─────────────────────────────

test('[22:48] «(па) ти кажав» is a recall complaint, in both scripts, and negation flips it', () => {
  for (const t of ['ПА ТИ КАЖАВ КАДЕ', 'ТИ КАЖАВ КАДЕ', 'ВЕЌЕ ТИ КАЖАВ', 'ТИ ВЕЌЕ КАЖАВ',
    'ПА ТИ РЕКОВ', 'ТИ НАПИШАВ', 'PA TI KAZAV KADE', 'TI KAZAV', 'VEKJE TI KAZAV',
    'JAS TI KAZAV STAN']) {
    assert.equal(detectToldYouNag(t), true, `"${t}" demands a recall`);
  }
  // The opposite claim is not a nag — and neither is a request for information.
  assert.equal(detectToldYouNag('НЕ ТИ КАЖАВ'), false);
  assert.equal(detectToldYouNag('NE TI KAZAV'), false);
  assert.equal(detectToldYouNag('КАЖИ МИ КАДЕ'), false);
  assert.equal(detectToldYouNag('ЗА ЖИВЕЕЊЕ МИ Е'), false);
});

/** The [22:47] intake exactly as the client drove it: rent, the two landmarks,
 *  and the money named inside the batch question. */
async function captureDrive(id: string) {
  const h = makeHandler(id);
  await h.say('ЗА РЕНТАЊЕ СУМ ЗАИНТЕРЕСИРАН ОКОЛУ УНИВЕРЗАЛНА , КАТОЛИЧКА');
  await h.say('ШТО ИМАТЕ ВО ТОЈ РЕОН ДО 300 ЕВРА');
  await h.say('ЗА ЖИВЕЕЊЕ МИ Е');
  return h;
}

test('[22:48] e2e: the recall names the landmarks and asks only what is missing', async () => {
  const { say, sessions, chatId } = await captureDrive('toldyou-2347');
  let s = sessions.get(chatId)!;
  assert.equal(s.slots.service, 'rent', 'рентaње is rent');
  assert.equal(s.slots.poiPlaces?.length, 2, 'both landmarks are on file');
  assert.equal(s.slots.location, 'Центар', 'and they resolve to the area');
  assert.equal(s.slots.residential, true, 'живеење releases the type question');
  const names = (s.slots.poiPlaces ?? []).map(p => displayPlaceName(p.name));

  const recall = await say('ПА ТИ КАЖАВ КАДЕ');
  for (const n of names) {
    assert.ok(recall.includes(n), `the named landmark «${n}» is read back: ${recall}`);
  }
  assert.ok(recall.includes(displayAreaName(s.slots.location!)), `and the area: ${recall}`);
  assert.ok(!/во кој дел од градот|која населба/u.test(recall),
    `the same question must not be asked again: ${recall}`);
  // It is an ANSWER, not a blank: it ends on a criterion still missing.
  assert.match(recall.trim(), /\?$/u, `a question follows the recall: ${recall}`);
  // And it burns nothing: a recall complaint is not fee traffic.
  s = sessions.get(chatId)!;
  assert.equal(s.slots.feeRejections ?? 0, 0);
  assert.equal(s.slots.provisionRejections ?? 0, 0);
});

// ── 5. THE MONEY ANSWER WAIVES THE SIZE, AND THE HOUSE IS SERVED ────────────

test('[22:50] a budget answer to the bedrooms ask waives the size — house AND flat served', async () => {
  const { say, sessions, chatId } = await captureDrive('budget-2347');
  const reply = await say('БИТНО Е ДА Е ДО 300 ЕВРА');

  const s = sessions.get(chatId)!;
  assert.equal(s.slots.budget, '300');
  assert.equal(s.slots.sizeWaived, true, 'the money answer releases the size question');
  assert.equal(s.slots.residential, true);
  assert.ok((s.slots.presentedIds ?? []).includes(50),
    `the 250 € house must be served: ${JSON.stringify(s.slots.presentedIds)}`);
  assert.ok((s.slots.presentedIds ?? []).includes(76),
    `and the гарсоњера: ${JSON.stringify(s.slots.presentedIds)}`);
  assert.match(reply, /Евидентен број 50/u, `the house card is in the reply: ${reply}`);
  // The owner's absolute: the funnel never claims there are no houses when one
  // is on the table.
  assert.ok(!/нема (куќи|кукји)|не поседуваме куќи/u.test(reply),
    `no false «нема куќи» claim: ${reply}`);
});

// ── 6. A BARE «НЕБИТНО» AFTER THE BATCH ────────────────────────────────────

test('[22:51] a dismissal after a served batch never arms «anywhere» nor re-asks', async () => {
  const { say, sessions, chatId } = await captureDrive('nebitno-2347');
  await say('БИТНО Е ДА Е ДО 300 ЕВРА');
  const presentedBefore = [...(sessions.get(chatId)!.slots.presentedIds ?? [])];
  assert.ok(presentedBefore.length > 0, 'the first batch is served');

  const reply = await say('НЕБИТНО');
  const s = sessions.get(chatId)!;
  assert.deepEqual(s.slots.presentedIds?.slice(0, presentedBefore.length), presentedBefore,
    'the served cards stay served');
  assert.notEqual(s.slots.anywhere, true, 'a size/unknown dismissal is not a location release');
  assert.ok((s.slots.presentedIds?.length ?? 0) > presentedBefore.length,
    `the dismissal is answered with more options: ${JSON.stringify(s.slots.presentedIds)}`);
  // The second batch spans further (the far Карпош card), so the opener must
  // never introduce it as «најблиските опции до …» — that was the [22:47]
  // sentence for a batch whose second card stood 2.1 km away.
  assert.ok(!/најблиск/u.test(reply),
    `an unanchored card blocks the «најблиски» opener: ${reply}`);
});

// ── 7. THE DISMISSAL READS THE QUESTION, NEVER THE WORDING ──────────────────

test('[23:48] any «на која локација» wording still makes «НЕБИТНО КАДЕ» an area release', async () => {
  // THE ROTATION THAT BROKE IT: the dismissal used to match the ask's WORDS
  // («населб|дел од градот|каде»), and this bank variant carries none of them —
  // so an AREA dismissal waived the SIZE and the funnel asked for the area
  // again (the [23:48] loop; the pty funnel failed only on the rotations whose
  // wording happened to miss the tokens). The question now comes from the
  // funnel's own criteria list, so no variant can change the answer.
  const { say, sessions, chatId } = makeHandler('dismiss-wording');
  // A flat search, so the type is on file and the area is the only thing the
  // seeded ask can be about.
  await say('SAKAM STAN POD KIRIJA');
  const seeded = sessions.get(chatId)!;
  seeded.history.push({
    role: 'assistant',
    text: 'На која локација во градот би сакале да биде сместен имотот што го барате?',
  });
  sessions.set(seeded);

  const reply = await say('НЕБИТНО КАДЕ');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.anywhere, true, 'the area was the question, so the area is released');
  assert.equal(s.slots.sizeWaived, undefined, 'and the size was never waived');
  assert.equal(s.slots.location, undefined, 'no area was invented from the dismissal');
  assert.match(reply, /кирија|буџет/iu, `the funnel moves on to the money: ${reply}`);
  assert.ok(!/(?:населб|дел од градот|локациј)/iu.test(reply),
    `the area is never re-asked after its release: ${reply}`);
});
