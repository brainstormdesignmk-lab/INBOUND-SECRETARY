/**
 * THE [04:48]–[05:23] FIELD SESSION (house EB 50, rent 250 €, Центар).
 *
 * Six turns where the appliance misread an ordinary sentence, all pinned here
 * through the REAL pipeline (InboundHandler + deterministic brain, the LLM
 * forced down so every answer is the code's own):
 *
 *   [04:48] СОПСТВЕНИК: ПОТВРДЕНО , ВЕ ЧЕКАМ
 *           → «Не разбрав. Евидентен број 77 — дали недвижноста е достапна…»
 *   [05:01] КАКВИ ПОДАТОЦИ ИМАШ ЗА НЕЈЗЕ ?
 *           → «Во ред, ќе се обидам да го најдам. Кажете ми — во која населба е…»
 *   [05:05] ЌЕ МОЖЕ ЛИ ОПИС НА КУЌАВА ?
 *           → «Не, тоа е на 3,1 километри од Михаил Чаков 9/А2…» (place-confirm
 *             lane answered a request for the CARD, with a landmark nobody named)
 *   [05:13] КУЌАВА САКАМ ДА ЈА ВИДАМ / ТОА Е ТОА, САКАМ ДА ЈА ВИДАМ
 *           → the locate collector asked him to describe the flat he was reading
 *   [05:17] АДВОКАТ НОТАР ? (after «КОЛКУ ВИ Е ПРОВИЗИЈАТА?»)
 *           → «Се наоѓа во приземје.» (the floor of the house, to a cost question)
 *   [05:23] ПЕТОК ПРЕТПЛАДНЕ НАКАЈ 10
 *           → «10 моментално го нема во нашата понуда» (a clock read as an EB)
 *
 * The owner verdict vocabulary, the info-card ask family, the visit gate in
 * property_locate, the legal-cost echo and the clock/EB separator are each
 * asserted on the served COPY and on the session state, because a sentence can
 * be right while the funnel stands still (and the other way round).
 */
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
import { EnrichmentStore } from '../src/store/enrichment';
import {
  detectOwnerVerdict, detectDescribeAsk, isPoiConfirmQuestion, extractPoiConfirmPlace,
  detectVisitTime, detectProvisionWho,
} from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// EB 50 as the feed serves it (the house in the transcript).
const ROWS: Property[] = [
  {
    eb: 50, id: 50, location: 'Центар', address: 'ул. Никола Карев 12',
    price: 250, bedrooms: 2, sqm: 74, size: '74 м²', service: 'rent', house: true,
    lat: 41.9955, lon: 21.4322, geo_source: 'stored',
    features: ['двор', 'тераса', 'паркинг'],
    details: 'Помеѓу Универзална сала и Треска, куќа во вид на двоспратна галерија. '
      + 'Греењето и ладењето е преку високо ефикасен инвертер. Паркинг пред влез. Опремена кујна.',
  } as Property,
  {
    eb: 77, id: 77, location: 'Центар', address: 'ул. Димитрие Чуповски 3',
    price: 300, bedrooms: 2, sqm: 80, size: '80 м²', service: 'rent', house: true,
    lat: 41.9941, lon: 21.4290, geo_source: 'stored', details: 'Куќа со двор.',
  } as Property,
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

function makeHandler() {
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(ROWS),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
    enrichment: new EnrichmentStore(db),
  });
  const ownerAsks: string[] = [];
  handler.onOwnerAsk = (_c: string, eb: number, q: string) => { ownerAsks.push(`${eb}: ${q}`); };
  /** The chat exactly as the transcript left it at [05:01]: the EB 50 card on
   *  screen, property_locate holding the turn. */
  const seedLocate = (chatId: string, eb = 50) => {
    const s = freshSession('test', chatId);
    s.state = 'property_locate';
    s.slots.service = 'rent';
    s.slots.house = true;
    s.slots.propertyId = eb;
    s.slots.interestedPropertyId = eb;
    s.slots.presentedIds = [eb];
    s.slots.currentBatch = [eb];
    s.slots.describedEbs = [eb];
    sessions.set(s);
    return s;
  };
  const turn = async (chatId: string, text: string) => {
    sent.length = 0;
    await handler.handle('test', chatId, text);
    return { state: sessions.get(chatId)!, answer: sent[sent.length - 1] ?? '' };
  };
  return { handler, sessions, sent, turn, seedLocate, ownerAsks };
}

// ── 1. THE OWNER'S OWN CLOSING WORDS ────────────────────────────────────────
test('an owner confirms with потврдено/договорено/средено/запишано — and откажано still refuses', () => {
  const proposed = 'Петок, 13.11.2026 во 18:00';
  for (const yes of [
    'ПОТВРДЕНО , ВЕ ЧЕКАМ',
    'ДОГОВОРЕНО',
    'СРЕДЕНО',
    'ЗАПИШАНО',
    'ЗАКАЖАНО',
    'ВАЖИ',
    'ПОТВРДУВАМ',
    'DOGOVORENO',
    'POTVRDENO',
    'SE GLEDAME',
  ]) {
    const v = detectOwnerVerdict(yes, proposed);
    assert.ok(v, `the owner's confirmation must parse: ${yes}`);
    assert.equal(v.status, 'ok', `confirmation is consent, got ${JSON.stringify(v)}: ${yes}`);
  }
  // A CANCELLATION is the appointment falling through — never an «ok».
  for (const no of ['ОТКАЖАНО', 'ОТКАЖАНО Е', 'СЕ ОТКАЖУВАМ', 'НЕ ВАЖИ', 'ОТКАЖАНО, НЕ ДОАЃАМ']) {
    const v = detectOwnerVerdict(no, proposed);
    assert.ok(v, `a cancellation must parse: ${no}`);
    assert.equal(v.status, 'counter', `a cancellation is never consent, got ${JSON.stringify(v)}: ${no}`);
  }
  // A NEGATED confirmation carries the same tokens — it must not read as yes.
  for (const no of ['НЕ Е ПОТВРДЕНО', 'НЕ ПОТВРДУВАМ', 'НЕ Е ДОГОВОРЕНО', 'НЕ Е СРЕДЕНО']) {
    const v = detectOwnerVerdict(no, proposed);
    assert.ok(v, `a negated confirmation is a refusal and must parse: ${no}`);
    assert.notEqual(v.status, 'ok', `a negated confirmation is never consent: ${no}`);
  }
  // The plain yes family is untouched.
  assert.equal(detectOwnerVerdict('DA', proposed)?.status, 'ok');
  assert.equal(detectOwnerVerdict('NE MOZAM', proposed)?.status, 'counter');
});

test('[04:48] «ПОТВРДЕНО, ВЕ ЧЕКАМ» resolves the owner check and the client gets the visit', async () => {
  const { handler, sessions, sent, turn, seedLocate, ownerAsks } = makeHandler();
  const s = seedLocate('owner-yes');
  s.state = 'visit_scheduling';
  s.slots.viewingFeeAgreed = true;
  s.slots.ownerContactPending = true;
  s.slots.contactName = 'ЗОРАН';
  s.slots.contactPhone = '078914196';
  sessions.set(s);

  // The client's term opens the owner check…
  const proposed = await turn('owner-yes', 'ПЕТОК ПРЕТПЛАДНЕ НАКАЈ 10');
  assert.equal(proposed.state.state, 'owner_checking', 'the term must open the owner check');
  assert.ok(ownerAsks.length >= 1, `the owner must be asked: ${JSON.stringify(ownerAsks)}`);

  // …and the owner's own words settle it.
  const verdict = detectOwnerVerdict('ПОТВРДЕНО , ВЕ ЧЕКАМ', proposed.state.slots.ownerAskTime ?? '');
  assert.ok(verdict && verdict.status === 'ok', `the owner sentence must parse: ${JSON.stringify(verdict)}`);
  handler.ownerAnswer('owner-yes', 50, verdict!);
  await new Promise(r => setTimeout(r, 60));
  const after = sessions.get('owner-yes')!;
  assert.notEqual(after.state, 'owner_checking', `the check must resolve, still ${after.state}`);
  const relay = sent[sent.length - 1] ?? '';
  assert.ok(relay.trim().length > 0, 'the client must hear the confirmation');
  assert.ok(!/Не разбрав/iu.test(relay), `never «Не разбрав» for a confirmation: ${relay}`);
});

// ── 2/3. THE INFO-CARD ASK, AND THE PLACE LANE THAT STOLE IT ────────────────
test('the info-card ask family covers податоци/детали/карактеристики/опис на X', () => {
  for (const ask of [
    'КАКВИ ПОДАТОЦИ ИМАШ ЗА НЕЈЗЕ ?',
    'КАКВИ ДЕТАЛИ ИМАШ ЗА НЕА?',
    'КАРАКТЕРИСТИКИ НА КУЌАВА ?',
    'ЌЕ МОЖЕ ЛИ ОПИС НА КУЌАВА ?',
    'ШТО ЗНАЕШ ЗА СТАНОТ',
  ]) {
    assert.equal(detectDescribeAsk(ask), true, `describe-ask expected: ${ask}`);
    // …and the flat is never a PLACE: «на куќава» is the property, not a pin.
    assert.equal(isPoiConfirmQuestion(ask), false, `the place lane must stand down: ${ask}`);
    assert.equal(extractPoiConfirmPlace(ask), undefined, `the flat is not a place: ${ask}`);
  }
  // A genuine place confirm still answers. The candidate keeps the client's
  // OWN spelling (the map lookup is transliteration-aware) — the contract here
  // is that a place survives, not that it is re-cased.
  assert.equal(isPoiConfirmQuestion('DA NE E VO SKOPJANKA ?'), true);
  assert.match(extractPoiConfirmPlace('DA NE E VO SKOPJANKA ?') ?? '', /^skopjanka$/iu);
});

test('[05:01–05:05] both info asks serve the EB 50 card, never a distance or a locate grill', async () => {
  for (const ask of [
    'КАКВИ ПОДАТОЦИ ИМАШ ЗА НЕЈЗЕ ?',
    'ЌЕ МОЖЕ ЛИ ОПИС НА КУЌАВА ?',
    'ШТО МОЖЕШ ДА МИ КАЖЕШ ЗА НЕЈЗЕ ?',
  ]) {
    const { turn, seedLocate } = makeHandler();
    seedLocate('card');
    const { answer } = await turn('card', ask);
    assert.match(answer, /Евидентен број 50/u, `the card names the flat (${ask}): ${answer}`);
    assert.match(answer, /74 м²/u, `the card carries the size (${ask}): ${answer}`);
    assert.match(answer, /250 евра/u, `the card carries the price (${ask}): ${answer}`);
    assert.match(answer, /инвертер/u, `the card carries the ad's facts (${ask}): ${answer}`);
    assert.ok(!/километри/u.test(answer), `never a landmark distance (${ask}): ${answer}`);
    assert.ok(!/ќе се обидам да го најдам/u.test(answer), `never the locate grill (${ask}): ${answer}`);
  }
});

// ── 4/5. A WISH TO SEE, FROM THE CARD ──────────────────────────────────────
test('[05:09–05:11] «сакам да ја видам» on the card opens the visit lane (fee → contact)', async () => {
  for (const ask of ['КУЌАВА САКАМ ДА ЈА ВИДАМ', 'ТОА Е ТОА , САКАМ ДА ЈА ВИДАМ']) {
    const { turn, seedLocate } = makeHandler();
    seedLocate('see');
    const first = await turn('see', ask);
    assert.equal(first.state.state, 'closing', `the visit lane owns the turn (${ask}): ${first.state.state}`);
    assert.equal(first.state.slots.interestedPropertyId, 50, `the flat he pointed at is the subject (${ask})`);
    assert.match(first.answer, /300 денари|5 евра/u, `the viewing fee is disclosed (${ask}): ${first.answer}`);
    assert.ok(!/ќе се обидам да го најдам/u.test(first.answer),
      `never the locate collector for a visit wish (${ask}): ${first.answer}`);
    assert.ok(!/Немам|не се појавува/u.test(first.answer),
      `the flat is on the table — never a not-found line (${ask}): ${first.answer}`);

    // Consent moves the funnel to contact collection, not to another card.
    const second = await turn('see', 'ЗВУЧИ ДОБРО');
    assert.equal(second.state.state, 'contact_collection', `agreement opens contact collection: ${second.state.state}`);
    assert.match(second.answer, /име|телефон/u, `and asks for the contact: ${second.answer}`);
  }
});

test('a wish to see with NO flat bound asks which flat — it never charges for nothing', async () => {
  const { turn } = makeHandler();
  const { answer, state } = await turn('nobody', 'САКАМ ДА ЈА ВИДАМ');
  assert.ok(!/300 денари|5 евра|симболичн/iu.test(answer), `no viewing fee without a flat: ${answer}`);
  // Any identifying question is the right turn here — the entry service ask
  // («купување или изнајмување?», several pool variants) or the locate ask
  // (EB/населба). The stems cover every wording the rotation ships.
  assert.match(answer, /Евидентен број|населба|куп|изнајм/iu, `the flat is the question: ${answer}`);
  assert.equal(state.state, 'idle', `the funnel must not move on a flatless visit wish: ${state.state}`);
  assert.equal(state.slots.interestedPropertyId, undefined, 'no flat may be invented');
});

test('[05:13] the visit wish in closing (fee not yet disclosed) serves the fee, never a search', async () => {
  const { turn, seedLocate, sessions } = makeHandler();
  const s = seedLocate('closing-wish');
  s.state = 'closing';
  s.slots.budget = '250';
  s.slots.location = 'Центар';
  sessions.set(s);

  const { answer, state } = await turn('closing-wish', 'КУЌАВА САКАМ ДА ЈА ВИДАМ');
  assert.match(answer, /300 денари|5 евра/u, `the fee is disclosed: ${answer}`);
  assert.ok(!/во системот нема/u.test(answer), `never a stock denial about the card on screen: ${answer}`);
  assert.equal(state.state, 'closing', `the fee lane owns the turn: ${state.state}`);
  assert.equal(state.slots.interestedPropertyId, 50, 'the house he pointed at is the subject');
});

// ── 5b. AN EMPTY POOL IS NOT AN EMPTY SYSTEM ──────────────────────────────
// The field turn was «КУЌАВА САКАМ ДА ЈА ВИДАМ» answered with «Моментално во
// системот нема куќи до 250 евра месечно во Центар» — about the house card on
// the screen. Two siblings share the cause: the roomless categories had no
// notebook at all, and the geography-scoped notebook was retired by an area
// change. Both are swept here over the REAL pipeline (serving the card first).
async function serveHouse(chatId: string, turn: (id: string, t: string) => Promise<{ answer: string; state: any }>) {
  const search = await turn(chatId, 'БАРАМ КУЌА ЗА ИЗНАЈМУВАЊЕ ДО 250 ЕВРА ВО ЦЕНТАР');
  // The funnel may ask for the room count first — a house answers it with a
  // waive («небитно»), which is how the field chat got to the card.
  const served = /Евидентен број/iu.test(search.answer)
    ? search
    : await turn(chatId, 'НЕБИТНО КОЛКУ СОБИ');
  assert.match(served.answer, /Евидентен број 50/u, `the EB 50 card must be served: ${served.answer}`);
  return served;
}

test('a repeat HOUSE search over the shown card never claims the system has none', async () => {
  const { turn } = makeHandler();
  await serveHouse('drained-house', turn);

  // Same area named again: this is the DRAINED shape.
  const here = await turn('drained-house', 'имаш ли уште куќи во Центар до 250 евра');
  assert.ok(!/во системот нема|нема\s+куќи\s+до/iu.test(here.answer),
    `a served category is never announced as absent from the system: ${here.answer}`);
  assert.match(here.answer, /прошириме|друг\p{L}*(?:\s+\p{L}+){0,2}\s+(?:населб|локаци|дел)|исцрпивме/iu,
    `the honest widen ask: ${here.answer}`);
  assert.ok(/\?\s*$/.test(here.answer), `the turn asks the client: ${here.answer}`);
});

test('an AREA CHANGE does not reopen the system claim about a category already served', async () => {
  const { turn, sessions } = makeHandler();
  await serveHouse('drained-wide', turn);

  // No area named: the widen lane clears `location`, which retires the
  // geography-scoped notebook. The «во системот нема» sentence is a claim about
  // the whole system, so the chat-wide note must still refuse it.
  const city = await turn('drained-wide', 'имаш ли уште куќи до 250 евра');
  const st = sessions.get('drained-wide')!;
  assert.equal(st.slots.location, undefined, 'the widen cleared the area (the premise)');
  assert.ok(!/во системот нема/iu.test(city.answer),
    `the system claim needs an EMPTY history, not an empty geography: ${city.answer}`);
  assert.deepEqual(st.slots.categoriesEverKinds, ['house'],
    'the chat-wide notebook survives the area change');
});

// ── 6. WHO PAYS THE LAWYER AND THE NOTARY ──────────────────────────────────
test('[05:17] a bare «АДВОКАТ НОТАР ?» is the legal-cost question, not the flat', async () => {
  // The detector: the cost item is the subject — a pay verb is not required.
  assert.equal(detectProvisionWho('АДВОКАТ НОТАР ?'), true);
  assert.equal(detectProvisionWho('advokat notar?'), true);
  assert.equal(detectProvisionWho('а нотар?'), true);
  // …but a notary OFFICE beside the flat is not a cost question.
  assert.equal(detectProvisionWho('ИМА ЛИ НОТАР ВО ЗГРАДАТА?'), false);
  // …and the property's own criteria keep the property lane.
  assert.equal(detectProvisionWho('СТАН 50 СО НОТАР?'), false);

  const { turn, seedLocate } = makeHandler();
  seedLocate('notary');
  await turn('notary', 'КОЛКУ ВИ Е ПРОВИЗИЈАТА ?');
  const { answer, state } = await turn('notary', 'АДВОКАТ НОТАР ?');
  // CASE-INSENSITIVE: the bank variants open some sentences with the word
  // («Адвокатот и нотарот при издавање…»), and a case-sensitive pin made this
  // assertion depend on WHICH variant the rotation drew.
  assert.match(answer, /адвокат/iu, `the answer names the lawyer: ${answer}`);
  assert.match(answer, /нотар/iu, `the answer names the notary: ${answer}`);
  assert.match(answer, /50\s*\/\s*50|по договор/iu, `the rent practice is stated: ${answer}`);
  assert.ok(!/приземје/iu.test(answer), `never the flat's floor: ${answer}`);
  assert.ok(!/немам информација/iu.test(answer), `never «немам информација» for a policy question: ${answer}`);
  assert.equal(state.state, 'property_locate', 'the money answer does not move the funnel');
});

// ── 7. A CLOCK IS NOT AN EB ────────────────────────────────────────────────
test('[05:23] «ПЕТОК ПРЕТПЛАДНЕ НАКАЈ 10» is a term, never EB 10', async () => {
  assert.equal(detectVisitTime('ПЕТОК ПРЕТПЛАДНЕ НАКАЈ 10'), 'ПЕТОК ПРЕТПЛАДНЕ НАКАЈ 10');
  const { turn, seedLocate, ownerAsks, sessions } = makeHandler();
  const s = seedLocate('clock');
  s.state = 'visit_scheduling';
  s.slots.viewingFeeAgreed = true;
  s.slots.ownerContactPending = true;
  s.slots.contactName = 'ЗОРАН';
  s.slots.contactPhone = '078914196';
  sessions.set(s);

  const { answer, state } = await turn('clock', 'ПЕТОК ПРЕТПЛАДНЕ НАКАЈ 10');
  assert.ok(!/го нема|не се појавува|не се наоѓа/iu.test(answer),
    `a clock must never become an EB not-found: ${answer}`);
  assert.equal(state.state, 'owner_checking', `the term opens the owner ping-pong: ${state.state}`);
  assert.equal(ownerAsks.length, 1, `the owner is asked exactly once: ${JSON.stringify(ownerAsks)}`);
  assert.match(ownerAsks[0]!, /10:00/u, `the owner is asked about the parsed term: ${ownerAsks[0]}`);
});

// ── 7b. THE CHECK NEVER PROMISES WITHOUT ASKING ────────────────────────────
test('owner_checking resolves the EB from the batch: the client is never told «ќе Ве известам» with nobody asked', async () => {
  const { turn, sessions, ownerAsks } = makeHandler();
  // A chat whose only record of the flat is the presented BATCH (the field
  // shape: the cards are on screen, neither propertyId nor interestedPropertyId
  // was ever set).
  const s = freshSession('test', 'batch-eb');
  s.state = 'visit_scheduling';
  s.slots.service = 'rent';
  s.slots.viewingFeeAgreed = true;
  s.slots.ownerContactPending = true;
  s.slots.presentedIds = [50];
  s.slots.currentBatch = [50];
  s.slots.contactName = 'ЗОРАН';
  s.slots.contactPhone = '078914196';
  sessions.set(s);

  const { state, answer } = await turn('batch-eb', 'ПЕТОК ПРЕТПЛАДНЕ НАКАЈ 10');
  assert.equal(state.state, 'owner_checking', `the term opens the check: ${state.state}`);
  assert.equal(ownerAsks.length, 1,
    `the owner must be asked for the batch flat (the client was promised an answer): ${JSON.stringify(ownerAsks)}`);
  assert.match(ownerAsks[0]!, /^50:/u, `the ask names EB 50: ${ownerAsks[0]}`);
  assert.equal(state.slots.interestedPropertyId, 50, 'the batch tail is pinned as the subject');
  assert.ok(!/Не разбрав/u.test(answer), `never «Не разбрав»: ${answer}`);
});
