// READING THE AD — the two halves of the [01:17]/[01:20] capture, which are one
// bug: Lina held the feed's ROW (naselba, price, rooms) but not the property's
// OWN WORDS, so she could neither find the flat the client described nor tell
// which of the two cards he was pointing at.
//
//   [01:17] „ИМАВТЕ ЕДЕН НОВ СТАН ВО МАЏАР МААЛО СО ДВЕ СПАЛНИ, ОКОЛУ 180 000“
//           → served a Центар PAIR (EB 91 + EB 66). EB 91 IS the Маџар Маало
//           flat — its address says «Гјуро Гјоновиќ Маџар Маало» and its ad
//           says «Нов Никогаш Вселен Стан во Маџар Маало» — but the feed files
//           it under «Центар», so the area slot stayed empty and the search
//           ran city-wide.
//   [01:20] „ОВОЈ КАЈ СЈО ДАЛИ Е ДОСТАПЕН УШТЕ?“
//           → answered about EB 91. The card the client meant is EB 66, whose
//           own ad says «наспроти СЈО»; the mention resolver never saw it
//           because the descriptor it extracted was the whole rest of the
//           sentence («сјо дали е достапен уште»), not the landmark.
//   [01:21] „КОЈА МУ Е ЦЕНАТА?“ → 178.000 (EB 91) for a flat he had just
//           pointed at as EB 66 (137.000).
//
// These are the feed's own rows for the pair (fetched 2026-10-27), so the test
// reads exactly the text the client reads.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PropertyService, Property, adText, inArea, extractPlacePhrases, textNamesPlace } from '../src/data/properties';
import { resolveMention, type MentionCandidate } from '../src/llm/mentionResolve';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession } from '../src/fsm/session';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { LlmClient } from '../src/llm/types';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { EventStore } from '../src/store/events';
import { OwnerStore } from '../src/store/owners';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LandmarkService } from '../src/geo/landmarks';

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  async locations(): Promise<string[]> {
    return [...new Set(this.rows.map(r => (r.location ?? '').trim()).filter(Boolean))];
  }
  get healthy(): boolean { return true; }
}

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('deterministic test — no model'); }
}

const ROWS: Property[] = [
  {
    eb: 91, id: 91, location: 'Центар',
    address: 'Гјуро Гјоновиќ Маџар Маало',
    details: 'Нов Никогаш Вселен Стан во Маџар Маало. Две Спални Соби , Дневна Кујна Трпезарија и тераса. Отворен Поглед. Достапно Подземно Паркинг Место со Доплата од 15000 евра.',
    price: 178000, bedrooms: 3, sqm: 71, size: '71 м²', service: 'buy',
    landmarks: [{ landmark: 'Apart Hotel Solaris' }],
  },
  {
    eb: 66, id: 66, location: 'Центар (населба)',
    address: 'Рузвелтова 51 2-10',
    details: 'Се продава Трособен Стан во центарот на Скопје. Рузвелтова , наспроти СЈО на Прв Кат со Лифт и Парно (исклучено моментално). Две Спални Соби , две тераси , Дневна , Кујна и Трпезарија.',
    price: 137000, bedrooms: 3, sqm: 79, size: '79 м²', service: 'buy',
    landmarks: [{ landmark: 'СЈО - Специјално Јавно Обвинителство' }],
  },
  {
    eb: 43, id: 43, location: 'Маџари', address: 'Кипер Маркет',
    details: 'Се продава стан во Маџари, кај Кипер во нова зграда на 2 кат од вкупно 4. Станот е со површина од 48м2.',
    price: 68300, bedrooms: 2, sqm: 48, size: '48 м²', service: 'buy',
  },
];

// ---- the data layer: the ad is searchable ---------------------------------
test('ad text is the card a client quotes back: address, ad body and landmark names', () => {
  const eb91 = ROWS[0]!;
  assert.match(adText(eb91), /Маџар Маало/);
  assert.match(adText(ROWS[1]!), /СЈО/);
  assert.ok(inArea(eb91, 'Маџар Маало'), 'the address/ad names the micro-area');
  assert.ok(!inArea(eb91, 'Маџари'), 'Маџар Маало is not Маџари');
  assert.ok(inArea(ROWS[2]!, 'Маџари'));
});

// A NEAR-CLAIM AND A MALL'S NAME ARE NOT A DISTRICT (the live feed's own words):
// EB 75 (Аеродром) says «во близина на Центар» and answered every «во Центар»
// search; EB 46 (Кисела Вода) carries «Трговски Центар Бутел» as a LANDMARK —
// the mall 150 m away — and matched «Центар» through it. A Центар pool full of
// Аеродром flats is how an anchored pair reached 1,4 km for its second card.
test('«во близина на Центар» and «Трговски центар» do not put a row IN Центар', () => {
  const mall: Property = {
    eb: 401, id: 401, location: 'Кисела Вода', address: 'Шампионче Как Кипер Маркет',
    price: 72000, bedrooms: 2, service: 'buy',
    landmarks: [{ landmark: 'Трговски Центар Бутел' }, { landmark: 'Општина Бутел' }],
  };
  const nearClaim: Property = {
    eb: 402, id: 402, location: 'Аеродром', address: 'Кузман Јосифовски Питу 19/5',
    details: 'Скопјанка Аеродром. Прекрасна локација во близина на Центар и маркети градинки училишта.',
    price: 154000, bedrooms: 3, service: 'buy',
  };
  const atCentre: Property = {
    eb: 403, id: 403, location: 'Центар (населба)', address: 'Спроти Браќа Рибар',
    details: 'Се продава стан во Центар. Стан со една спална соба.',
    price: 99000, bedrooms: 2, service: 'buy',
  };
  assert.ok(!inArea(mall, 'Центар'), 'the mall\'s name is not a district');
  assert.ok(inArea(mall, 'Бутел'), 'its landmarks still place it in Бутел');
  assert.ok(!inArea(nearClaim, 'Центар'), 'a near-claim says where the flat is NOT');
  assert.ok(inArea(nearClaim, 'Аеродром'));
  assert.ok(inArea(atCentre, 'Центар'), 'a real «во Центар» claim still counts');
});

test('textNamesPlace is token-aligned and script-neutral, and never matches a short fragment', () => {
  assert.ok(textNamesPlace('Гјуро Гјоновиќ Маџар Маало', 'madjar maalo'));
  assert.ok(textNamesPlace('Гјуро Гјоновиќ Маџар Маало', 'MADJAR MAALO'), 'caps are the [01:17] capture');
  assert.ok(!textNamesPlace('Кисела Вода', 'вода'), 'a 4-letter word is not a place match');
  assert.ok(!textNamesPlace('Маџар Маало', 'маало нова'), 'word order matters');
  // A 3-letter ACRONYM is a landmark hint, not a place: the mention resolver
  // carries those (below), with its own weaker evidence weight.
  assert.ok(!textNamesPlace('наспроти СЈО на Прв Кат', 'сјо'));
});

test('the place phrase the client names is cut at the first function word', () => {
  assert.deepEqual(
    extractPlacePhrases('ИМАВТЕ ЕДЕН НОВ СТАН ВО МАЏАР МААЛО СО ДВЕ СПАЛНИ . ОКОЛУ 180 000'),
    ['маџар маало', 'маџар'],
  );
  assert.deepEqual(extractPlacePhrases('ОВОЈ КАЈ СЈО ДАЛИ Е ДОСТАПЕН УШТЕ ?'), ['сјо']);
});

test('a micro-area only the ads name becomes a place the funnel can hear', async () => {
  const props = new FakeProps(ROWS);
  assert.deepEqual(
    await props.placesNamedIn('ИМАВТЕ ЕДЕН НОВ СТАН ВО МАЏАР МААЛО СО ДВЕ СПАЛНИ . ОКОЛУ 180 000'),
    ['Маџар Маало'],
  );
  // A place the feed already files rows under is a naselba, not a micro-area.
  assert.deepEqual(await props.placesNamedIn('ima li nesto vo Madjari'), []);
  // …and one nothing names is never invented.
  assert.deepEqual(await props.placesNamedIn('ima li nesto vo Nepostoecko Maalo'), []);
});

test('the search pool for «Маџар Маало, 2 спални, ~180.000» is EB 91 — not the Центар pair', async () => {
  const props = new FakeProps(ROWS);
  const pool = await props.candidates({ location: 'Маџар Маало', bedrooms: 3, budget: '180000' });
  assert.deepEqual(pool.map(p => p.eb), [91]);
});

// ---- the reference: a card hint binds the card that says it ---------------
test('«овој кај СЈО» binds EB 66 — the landmark in the card, not the pair order', () => {
  const cands: MentionCandidate[] = ROWS.map(p => ({
    eb: p.eb, price: p.price, bedrooms: p.bedrooms, sqm: p.sqm,
    location: p.location, details: p.details, landmark: p.landmark, landmarks: p.landmarks,
  }));
  const m = resolveMention('ОВОЈ КАЈ СЈО ДАЛИ Е ДОСТАПЕН УШТЕ ?', cands);
  assert.equal(m?.kind, 'unique', `a landmark hint must bind: ${JSON.stringify(m)}`);
  assert.equal(m?.eb, 66);
  // A hint the cards do not carry never hijacks the conversation.
  assert.equal(resolveMention('OVOJ KAJ NEPOSTOECKI LANDMARK?', cands), undefined);
});

// ---- end to end: the two turns of the capture ------------------------------
async function makeHandler(rows: Property[]) {
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const props = new FakeProps(rows);
  const sessions = new SessionStore(db);
  const sent: string[] = [];
  const channels = new ChannelRegistry();
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props, appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { db, sessions, sent, handler };
}

test('e2e [01:17]: the Маџар Маало ask is answered with EB 91, and EB 66 is not served', async () => {
  const { db, sessions, sent, handler } = await makeHandler(ROWS);
  const chatId = 'madjar-maalo';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'ZDRAVO . IMAVTE EDEN NOV STAN VO MADJAR MAALO SO DVE SPALNI . OKOLU 180 000');
  assert.equal(sessions.get(chatId)!.slots.location, 'Маџар Маало',
    'the ad-named micro-area is the area slot');

  await handler.handle('test', chatId, 'ZA PRODAZBA BESE');
  await handler.handle('test', chatId, '180 000 ODPRILIKA');

  const cards = sent.filter(m => /Евидентен број/.test(m)).join('\n');
  assert.match(cards, /Евидентен број 91/, `EB 91 is the flat asked for: ${cards.slice(0, 400)}`);
  assert.doesNotMatch(cards, /Евидентен број 66/, 'the distractor is not in the offer');
  db.close();
});

test('e2e: a hint for a flat she never showed binds it from the FEED, not the table', async () => {
  const { db, sessions, sent, handler } = await makeHandler(ROWS);
  const chatId = 'kaj-sjo-feed';
  const s = freshSession('test', chatId);
  s.state = 'presentation';
  s.slots.service = 'buy';
  s.slots.bedrooms = 3;
  s.slots.propertyId = 91;                  // EB 66 was NEVER presented
  s.slots.interestedPropertyId = 91;
  s.slots.presentedIds = [91];
  sessions.set(s);

  await handler.handle('test', chatId, 'OVOJ KAJ SJO DALI E DOSTAPEN USHTE ?');
  assert.equal(sessions.get(chatId)!.slots.interestedPropertyId, 66,
    `the hint is read off the feed's own ad text: ${sent.join(' | ')}`);

  sent.length = 0;
  await handler.handle('test', chatId, 'KOJA MU E CENATA ?');
  assert.match(sent.join('\n'), /137[.,]?000/, `EB 66's price: ${sent.join(' | ')}`);
  db.close();
});

test('e2e [04:04]: a cold «гарсоњера кај Црногорска амбасада, дали се продава уште?» is READ and answered', async () => {
  // The live capture: the first message of a new chat named the category, the
  // landmark AND the service («DALI SE PRODVA USTE?»), and the reply was
  // „Дали барате купување или изнајмување?“ — none of it was read. The feed
  // holds BOTH a sold and a rented garsonjera at that embassy, so the service
  // word is what tells them apart: 63 is for sale, 76 is a rental.
  const embassy = [
    {
      eb: 63, id: 63, location: 'Центар (населба)', address: 'Црногорска',
      details: 'Се Продава Гарсоњера во Сутерен на Зграда. Гарсоњерата е комплетно реновирана и е на Одлична Локација , во близина на Црногорска Амбасада. Поседува Посебна Спална Соба која не е во имотен лист.',
      price: 36000, sqm: 28, size: '28 м²', service: 'buy', studio: true,
      landmarks: [{ landmark: 'Амбасада на Црна Гора' }],
    },
    {
      eb: 76, id: 76, location: 'Центар', address: 'Строг Центар',
      details: 'Се Издава Реновирана Ефтина Гарсоњера во Строг Центар. Во потегот меѓу Универзална Сала и Католичка Црква, на 100м од Црногорска Амбасада.',
      price: 200, sqm: 24, size: '24 м²', service: 'rent', studio: true,
      landmarks: [{ landmark: 'Амбасада на Црна Гора' }],
    },
  ] as Property[];
  const { db, sessions, sent, handler } = await makeHandler(embassy);
  const chatId = 'cold-embassy';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'ZDRAVO, IMAVTE EDNA GARXONJERA KAJ CRNOGORSKA AMBASADA. DALI SE PRODVA USTE ?');
  const reply = sent.join(' | ');
  assert.doesNotMatch(reply, /купување или изнајмување|купите стан или/iu,
    `the named service is read, not asked back: ${reply}`);
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.service, 'buy', '«SE PRODVA» is the sale');
  assert.equal(s.slots.interestedPropertyId, 63,
    `the FOR-SALE garsonjera at that embassy: ${reply}`);
  assert.equal(s.state, 'closing', `the availability ack opens the owner lane: ${s.state}`);
  assert.ok(!/Евидентен број 76/.test(reply), `never the rental: ${reply}`);
  // …and the answer NAMES the flat it found: a client who never saw a card
  // cannot act on «сè уште е достапна» alone (the [04:04] complaint was that
  // she answers without reading anything about the property).
  assert.match(reply, /Евидентен број 63 · гарсоњера, 28 м² · 36[.,]?000 евра/u,
    `the flat is named — EB, type, м², price: ${reply}`);
  db.close();
});

test('e2e: a cold SEARCH with an area is not mistaken for one named ad', async () => {
  // The other half of the cold feed read: „имате нешто во Центар?“ also carries
  // a place word, and binding the first Центар row to it would answer a search
  // with one wrong ad. Searches keep going to the funnel.
  const { db, sessions, sent, handler } = await makeHandler(ROWS);
  const chatId = 'cold-search';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'ZDRAVO IMAVTE NESTO VO CENTAR ?');
  const reply = sent.join(' | ');
  assert.doesNotMatch(reply, /Која од нив/u, `a search is not a which-one ask: ${reply}`);
  assert.doesNotMatch(reply, /Евидентен број/u, `no single card bound to a search: ${reply}`);
  assert.equal(sessions.get(chatId)!.slots.interestedPropertyId, undefined);
  db.close();
});

test('e2e: TWO feed rows near the named place — she asks which one, never picks', async () => {
  // The feed's own geometry puts a second Центар flat within 200 m of СЈО.
  // Neither was presented, so nothing on the table matches the hint: the old
  // path silently kept the current pointer and answered about THAT flat.
  const twin = {
    eb: 95, id: 95, location: 'Центар', address: 'Дебар маало',
    details: 'Се продава трособен стан во Дебар маало, близу до Броз кафе.',
    price: 204000, bedrooms: 3, sqm: 74, size: '74 м²', service: 'buy',
    landmarks: [{ landmark: 'СЈО - Специјално Јавно Обвинителство' }],
  } as Property;
  const { db, sessions, sent, handler } = await makeHandler([...ROWS, twin]);
  const chatId = 'kaj-sjo-ambiguous';
  const s = freshSession('test', chatId);
  s.state = 'presentation';
  s.slots.service = 'buy';
  s.slots.bedrooms = 3;
  s.slots.propertyId = 91;
  s.slots.interestedPropertyId = 91;
  s.slots.presentedIds = [91];
  sessions.set(s);

  await handler.handle('test', chatId, 'OVOJ KAJ SJO DALI E DOSTAPEN USHTE ?');
  const reply = sent.join(' | ');
  assert.match(reply, /Ако не, продолжувам да барам/u, `the ambiguity must be asked: ${reply}`);
  assert.match(reply, /Евидентен број 66 · трисобен стан, 79 м²/u, `each option is described: ${reply}`);
  assert.match(reply, /Евидентен број 95 · трисобен стан, 74 м²/u, `each option is described: ${reply}`);
  assert.equal(sessions.get(chatId)!.slots.interestedPropertyId, 91,
    'no silent swap to one of the two guesses');
  db.close();
});

test('e2e [01:20]/[01:21]: «овој кај СЈО» is EB 66, and its price is 137.000', async () => {
  const { db, sessions, sent, handler } = await makeHandler(ROWS);
  const chatId = 'kaj-sjo';
  const s = freshSession('test', chatId);
  s.state = 'presentation';
  s.slots.service = 'buy';
  s.slots.bedrooms = 3;
  s.slots.propertyId = 91;                 // the card the OLD code answered about
  s.slots.interestedPropertyId = 91;
  s.slots.presentedIds = [91, 66];
  sessions.set(s);

  await handler.handle('test', chatId, 'OVOJ KAJ SJO DALI E DOSTAPEN USHTE ?');
  assert.equal(sessions.get(chatId)!.slots.interestedPropertyId, 66,
    `the availability answer must be about the flat the client named: ${sent.join(' | ')}`);

  sent.length = 0;
  await handler.handle('test', chatId, 'KOJA MU E CENATA ?');
  const price = sent.join('\n');
  assert.match(price, /137[.,]?000/, `EB 66's price: ${price}`);
  assert.doesNotMatch(price, /178[.,]?000/, `never the pair's first card: ${price}`);
  db.close();
});
