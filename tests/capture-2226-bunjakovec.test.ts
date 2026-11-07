/**
 * THE [22:26]–[22:53] CAPTURE — one chat, seven defects, pinned.
 *
 *   [22:26] IMAVTE EDNA GARSONJERA … OKOLU 200E ILI KUKJA … ZA 250
 *            → served the HOUSE only; the гарсоњера he named first vanished
 *   [22:27] A GARSONJERATA ZA 200E DALI E DOSTAPNA USTE ?
 *            → «200 не се наоѓа во моменталната понуда» (a PRICE read as an EB)
 *   [22:27] KOJ BROJ E?
 *            → the card again, never the number he asked for
 *   [22:28] KAKO KE GO KONTAKTIRAS AKO NE ZNAES KOJ BROJ E ?
 *            → «Ќе почекаме соодветен момент…» (the DEFER line, for a challenge)
 *   [22:30] KAZI MI INFORMACII ZA NEJZE
 *            → «Мислам дека сè уште е достапна» instead of the card he asked for
 *   [22:48] A KAZI MI TROSOBNI STANOVI OKOLU KATOLICKA DALI IMATE ?
 *            → a гарсоњера rode a «трисобни» ask
 *   [22:52] OD KOE SELO SI?
 *            → an improvised biography ("Живеам и работам тука во Скопје…")
 *   [22:53] NE NE SAKAM DA MI POPUSIS MALCE
 *            → served as an ordinary question (no strike)
 *
 * The contracts, one per turn, in one file because it is one conversation.
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
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { LlmClient } from '../src/llm/types';
import { classifyOffensive } from '../src/antiabuse/offensive';
import { detectPersonalAsk } from '../src/llm/personal';
import {
  detectAvailabilityAsk, detectDefer, detectWhichPropertyAsk,
  detectContactMechanicsChallenge, detectDescribeAsk, splitRecallCategories,
  extractSlots, detectSeenListingRecall,
} from '../src/llm/deterministic';
import { ebNumbersInText } from '../src/llm/ebNumber';
import { inferPropertyId } from '../src/llm/classify';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

// The map's own pin for the cathedral: Римокатоличка Катедрала Пресвето Срце
// Исусово — 41.9949745, 21.4178397. The captures' rows stand around it.
const CATHEDRAL = { lat: 41.9949745, lon: 21.4178397 };
const BUNJAKOVEC = { lat: 41.9974581, lon: 21.4186442 };

// THE TRAP OF THE [22:48] TURN: the гарсоњера stands ~60 m from the cathedral,
// the three-room flats ~560 m. Distance alone would lead with the гapсоњера on
// a «трисобни» ask — the room count is a LOCK, never a rank.
const GARSONJERA_200: Property = {
  eb: 76, id: 76, location: 'Центар', price: 200, service: 'rent', sqm: 24, size: '24 м²',
  studio: true, lat: 41.9955, lon: 21.4182,
  details: 'Реновирана гарсоњера во строг центар, комплетно наместена.',
} as Property;

const HOUSE_250: Property = {
  eb: 50, id: 50, location: 'Центар', price: 250, service: 'rent', sqm: 74, size: '74 м²',
  house: true, lat: 41.9978, lon: 21.4184,
  details: 'Куќа во вид на двоспратна галерија со двор и тераса.',
} as Property;

const TROSoben_RENT: Property = {
  eb: 42, id: 42, location: 'Центар', price: 1000, service: 'rent', sqm: 126, size: '126 м²',
  bedrooms: 3, lat: 41.9995, lon: 21.4178,
  details: 'Трисобен стан во Центар, близу Католичка црква.',
} as Property;

const TROSoben_BUY: Property = {
  eb: 84, id: 84, location: 'Центар', price: 117000, service: 'buy', sqm: 48, size: '48 м²',
  bedrooms: 3, lat: 41.9953, lon: 21.4190,
  details: 'Дневна и две спални, целосно наместен.',
} as Property;

// Two flats that must NEVER answer a three-room ask, however close they stand.
const GARSONJERA_BUY: Property = {
  eb: 63, id: 63, location: 'Центар', price: 36000, service: 'buy', sqm: 28, size: '28 м²',
  studio: true, lat: 41.9952, lon: 21.4179,
  details: 'Гарсоњера во Центар, греење на струја.',
} as Property;

const DVOSOBEN_BUY: Property = {
  eb: 69, id: 69, location: 'Центар', price: 99000, service: 'buy', sqm: 51, size: '51 м²',
  bedrooms: 2, lat: 41.9951, lon: 21.4176,
  details: 'Двособен стан во Центар.',
} as Property;

const ROWS = [GARSONJERA_200, HOUSE_250, TROSoben_RENT, TROSoben_BUY, GARSONJERA_BUY, DVOSOBEN_BUY];

function makeHandler(id: string) {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, chatId: id, sent };
}

// ── 1. two listings in one recall ───────────────────────────────────────────

test('[22:26] a recall naming TWO categories serves BOTH, each with its own price', async () => {
  const line = 'IMAVTE EDNA GARSONJERA TAMU SO KIRIJA OKOLU 200E ILI KUKJA IMASE ZA 250';
  assert.equal(detectSeenListingRecall(line), true, 'the recall family must claim the line');
  const parts = splitRecallCategories(line);
  assert.equal(parts.length, 2, `two halves expected, got ${JSON.stringify(parts)}`);
  assert.equal(parts[0].garsonjera, true, 'the FIRST half is the гapсоњера');
  assert.equal(parts[0].price, 200, `the first half keeps ITS price: ${parts[0].price}`);
  assert.equal(parts[1].house, true, 'the SECOND half is the куќа');
  assert.equal(parts[1].price, 250, `the second half keeps ITS price: ${parts[1].price}`);

  const { say, sessions, chatId } = makeHandler('dual-recall');
  await say('ZDRAVO, STO IMATE INTERESNO KAJ BUNJAKOVEC ?');
  await say('ZA IZNAJMUVANJE SUM');
  const answer = await say(line);
  assert.match(answer, /Евидентен број 76/u, `the гapсоњера he named first is served: ${answer}`);
  assert.match(answer, /Евидентен број 50/u, `the куќа he named second is served: ${answer}`);
  assert.match(answer, /200/u, `the гapсоњера's price rides its card: ${answer}`);
  assert.match(answer, /250/u, `the куќа's price rides its card: ${answer}`);
  assert.doesNotMatch(answer, /Колку спални|Колкав број на спални/iu,
    `a criteria grill over two described flats: ${answer}`);
  const s = sessions.get(chatId)!;
  assert.deepEqual([...(s.slots.currentBatch ?? [])].sort((a, b) => a - b), [50, 76],
    `both flats are on the table: ${s.slots.currentBatch}`);
});

// ── 2. the availability ask about the flat he points at ─────────────────────

test('[22:27] «GARSONJERATA ZA 200E … DOSTAPNA?» is about EB 76 and NAMES it', async () => {
  // The root cause first: a glued currency is a PRICE, never an Евидентен број.
  for (const t of ['A GARSONJERATA ZA 200E DALI E DOSTAPNA USTE ?', '350e kirija', '200E', 'do 450evra']) {
    assert.deepEqual(ebNumbersInText(t), [], `a price read as an EB: ${t} → ${ebNumbersInText(t)}`);
  }
  // …while the copula idiom keeps its number («63 E TAA» = "63 IS that").
  assert.deepEqual(ebNumbersInText('DA, 63 E TAA'), [63]);
  assert.equal(inferPropertyId('A GARSONJERATA ZA 200E DALI E DOSTAPNA USTE ?'), undefined);

  const { say, sessions, chatId } = makeHandler('avail-described');
  await say('ZDRAVO, STO IMATE INTERESNO KAJ BUNJAKOVEC ?');
  await say('ZA IZNAJMUVANJE SUM');
  await say('IMAVTE EDNA GARSONJERA TAMU SO KIRIJA OKOLU 200E ILI KUKJA IMASE ZA 250');
  const answer = await say('A GARSONJERATA ZA 200E DALI E DOSTAPNA USTE ?');
  assert.match(answer, /Евидентен број 76/u, `the flat he pointed at is named: ${answer}`);
  assert.doesNotMatch(answer, /Евидентен број 50/u, `the house is not the answer: ${answer}`);
  assert.ok(/достап|слободн|располага|база|евиденц/iu.test(answer), `availability ack missing: ${answer}`);
  assert.match(answer, /сопственик/iu, `the owner question is owed: ${answer}`);
  assert.doesNotMatch(answer, /Колку спални|Колкав број на спални|буџет/iu,
    `a fresh questionnaire answered an availability question: ${answer}`);
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.interestedPropertyId, 76, `the flat under discussion: ${s.slots.interestedPropertyId}`);
});

// ── 3./4. the number, and the challenge about it ────────────────────────────

test('[22:27] «KOJ BROJ E?» answers with the number', () => {
  for (const t of ['KOJ BROJ E?', 'koj broj e', 'КОЈ БРОЈ Е?', 'koe e brojot', 'koj e brojot?']) {
    assert.equal(detectWhichPropertyAsk(t), true, `the number ask is not claimed: ${t}`);
  }
  // A BUILDING's number is not a listing number.
  assert.equal(detectWhichPropertyAsk('KOJ BROJ E VLEZOT NA ZGRADATA?'), false);
});

test('[22:27] e2e: «KOJ BROJ E?» names the ЕВИДЕНТЕН БРОЈ, never the card again', async () => {
  const { say } = makeHandler('which-number');
  await say('ZDRAVO, STO IMATE INTERESNO KAJ BUNJAKOVEC ?');
  await say('ZA IZNAJMUVANJE SUM');
  await say('IMAVTE EDNA GARSONJERA TAMU SO KIRIJA OKOLU 200E ILI KUKJA IMASE ZA 250');
  await say('A GARSONJERATA ZA 200E DALI E DOSTAPNA USTE ?');
  const answer = await say('KOJ BROJ E?');
  assert.match(answer, /Евидентен број 76/u, `the number is the answer: ${answer}`);
  assert.doesNotMatch(answer, /м²/u, `a full card answered a number question: ${answer}`);
});

test('[22:28] the competence challenge: the number + the mechanism, never a deferral', async () => {
  const challenge = 'KAKO KE GO KONTAKTIRAS AKO NE ZNAES KOJ BROJ E ?';
  assert.equal(detectContactMechanicsChallenge(challenge), true);
  // THE ROOT CAUSE: the DEFER grammar read «ќе … контактираш» as the client
  // deferring — but that verb's subject is HER. Second person is a question.
  assert.equal(detectDefer(challenge), false, 'a question about her action is not a deferral');
  assert.equal(detectDefer('KE SE JAVAM PODOCNA'), true, 'a real deferral still defers');
  assert.equal(detectDefer('KE GO KONTAKTIRAM SOPSTVENIKOT PODOCNA'), true,
    'the CLIENT contacting the owner later is still a deferral');

  const { say, sessions, chatId } = makeHandler('mechanics');
  await say('ZDRAVO, STO IMATE INTERESNO KAJ BUNJAKOVEC ?');
  await say('ZA IZNAJMUVANJE SUM');
  await say('IMAVTE EDNA GARSONJERA TAMU SO KIRIJA OKOLU 200E ILI KUKJA IMASE ZA 250');
  await say('A GARSONJERATA ZA 200E DALI E DOSTAPNA USTE ?');
  const answer = await say(challenge);
  assert.match(answer, /Евидентен број 76/u, `she names the number she holds: ${answer}`);
  assert.match(answer, /сопственик/iu, `the mechanism is explained: ${answer}`);
  assert.doesNotMatch(answer, /ќе почекаме|Ќе Ве известам штом|штом недвижноста биде/iu,
    `the deferral line answered a challenge: ${answer}`);
  assert.equal(sessions.get(chatId)!.state, 'closing', 'the funnel does not move');
});

// ── 5. the info card, by pronoun, with its confirm question ─────────────────

test('[22:30] «KAZI MI INFORMACII ZA NEJZE» serves the CARD and asks to confirm', async () => {
  assert.equal(detectDescribeAsk('KAZI MI INFORMACII ZA NEJZE'), true);
  assert.equal(detectDescribeAsk('kazi mi informacii za nea'), true);
  assert.equal(detectDescribeAsk('КАЖИ МИ ИНФО ЗА НЕГО'), true);

  const { say, sessions, chatId } = makeHandler('info-pronoun');
  await say('ZDRAVO , STO IMATE INTERESNO KAJ KATOLICKA ?');
  await say('ZA IZNAJMUVANJE SUM');
  await say('MISLAM DEKA BESE 76');
  const answer = await say('KAZI MI INFORMACII ZA NEJZE');
  assert.match(answer, /Евидентен број 76/u, `the card he asked for: ${answer}`);
  assert.match(answer, /200 евра/u, `the card carries the facts: ${answer}`);
  assert.match(answer, /Дали ова е недвижноста што ја баравте/u,
    `the flat must be CONFIRMED as the one he meant: ${answer}`);
  assert.doesNotMatch(answer, /сè уште е достапна|би требало да е слободна/iu,
    `an availability ack answered an info ask: ${answer}`);
  assert.ok(sessions.get(chatId), 'session exists');
});

// ── 6./7. the type (and market) lock on a stock ask ────────────────────────

test('[22:48] a «TROSOBNI» ask serves three-room flats only — however close the гapсоњера stands', async () => {
  const { say } = makeHandler('trosoben-rent');
  await say('ZDRAVO , STO IMATE INTERESNO KAJ KATOLICKA ?');
  await say('ZA IZNAJMUVANJE SUM');
  // The budget completes the search, so the stock ask is a SERVE — that is the
  // turn the capture's mixed pair came out of.
  await say('DO 1500 EVRA');
  const answer = await say('A KAZI MI TROSOBNI STANOVI OKOLU KATOLICKA DALI IMATE ?');
  assert.match(answer, /Евидентен број 42/u, `the three-room flat is served: ${answer}`);
  assert.doesNotMatch(answer, /Евидентен број 76/u,
    `a гapсоњера 60 m away rode a «трисобни» ask: ${answer}`);
  assert.doesNotMatch(answer, /Евидентен број 50/u, `a куќа rode a flat ask: ${answer}`);
});

test('[22:49] «DALI IMA TROSOBNI NA PRODAZBA TAMU?» locks type AND market', async () => {
  const { say } = makeHandler('trosoben-buy');
  await say('ZDRAVO , STO IMATE INTERESNO KAJ KATOLICKA ?');
  await say('ZA KUPUVANJE SUM');
  await say('DO 150000 EVRA');
  const answer = await say('DALI IMA TROSOBNI NA PRODAZBA TAMU ?');
  assert.match(answer, /Евидентен број 84/u, `the three-room FOR-SALE flat is served: ${answer}`);
  assert.doesNotMatch(answer, /Евидентен број 63/u, `a гapсоњера rode the ask: ${answer}`);
  assert.doesNotMatch(answer, /Евидентен број 69/u, `a two-room flat rode a three-room ask: ${answer}`);
});

// ── 8. her origin is nobody's business ─────────────────────────────────────

test('[22:52] «OD KOE SELO SI?» gets the boundary line, never a biography', async () => {
  assert.equal(detectPersonalAsk('OD KOE SELO SI?'), 'origin');
  assert.equal(detectPersonalAsk('od koe mesto si'), 'origin');
  assert.equal(detectPersonalAsk('ОД КАДЕ СИ?'), 'origin');
  // …and a place question about a PROPERTY is not her origin.
  assert.equal(detectPersonalAsk('OD KOE MESTO E STANOT?'), undefined);

  const { say, sessions, chatId } = makeHandler('origin');
  const answer = await say('OD KOE SELO SI?');
  assert.match(answer, /не би требало да Ве интересира/iu, `the boundary is stated: ${answer}`);
  assert.match(answer, /недвижност/iu, `the turn is handed back to business: ${answer}`);
  assert.doesNotMatch(answer, /Живеам и работам|од Скопје сум|родена сум/iu,
    `an improvised biography: ${answer}`);
  assert.equal(sessions.get(chatId)!.state, 'idle', 'the funnel does not move');
});

// ── 9. the sexual demand spends a strike ────────────────────────────────────

test('[22:53] «NE NE SAKAM DA MI POPUSIS MALCE» is a sexual offence', async () => {
  for (const t of ['NE NE SAKAM DA MI POPUSIS MALCE', 'da mi popusis', 'ПОПУШИ МИ', 'popusis mi go']) {
    const verdict = classifyOffensive(t);
    assert.equal(verdict.isOffensive, true, `not caught: ${t}`);
    assert.equal(verdict.category, 'sexual', `wrong category for ${t}: ${verdict.category}`);
  }
  // …and the ordinary words stay clean: a discount, a smoking remark.
  for (const t of ['DALI IMA POPUST ZA KUPUVANJE?', 'MOZE LI POPUST', 'NE PUSI SE VO ZGRADATA']) {
    assert.equal(classifyOffensive(t).isOffensive, false, `innocent words struck: ${t}`);
  }

  const { say } = makeHandler('offence-2253');
  const answer = await say('NE NE SAKAM DA MI POPUSIS MALCE');
  assert.match(answer, /професионал/iu, `the tone warning is served: ${answer}`);
  assert.doesNotMatch(answer, /Евидентен број/u, `a card answered a sexual demand: ${answer}`);
});

// ── the recall parser itself ────────────────────────────────────────────────

test('splitRecallCategories: the two halves keep their own category and price', () => {
  assert.equal(extractSlots('IMAVTE EDNA GARSONJERA TAMU SO KIRIJA OKOLU 200E ILI KUKJA IMASE ZA 250').house, true,
    'the merge this lane exists for: the merged slots keep the LAST category');
  const one = splitRecallCategories('IMAVTE EDNA GARSONJERA TAMU SO KIRIJA OD 200 EVRA');
  assert.deepEqual(one, [], `a single-category recall is not split: ${JSON.stringify(one)}`);
  const two = splitRecallCategories('IMAVTE EDEN STAN SO DVE SPALNI ILI KUKJA');
  assert.equal(two.length, 2, `rooms + house are two halves: ${JSON.stringify(two)}`);
  assert.equal(two[0].bedrooms, 3, `«две спални» is a 3-room flat: ${JSON.stringify(two[0])}`);
  assert.equal(two[1].house, true, JSON.stringify(two[1]));
});
