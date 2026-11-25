/**
 * FIELD CAPTURE [05:48]/[05:51] — «SHE DOES NOT GO INTO HELPFUL MODE TO FIND THE
 * ALREADY-SEEN PROPERTY WHICH IS ASKED».
 *
 *   [05:48] ИМАШЕ ЕДНА КУЌА ШТО СЕ ИЗДАВАШЕ КАЈ ВАС, ОКОЛУ УНИВЕРЗАЛНА И КАТОЛИЧКА
 *   [05:48] НЕ ГО ЗАПИШАВ БРОЈЧЕТО АМА КИРИЈАТА И БЕЧЕ ЕФТИНА
 *   [05:48] ЛИНА: Извинете, во право сте — вратив се во разговорот. Веќе ги имам
 *           Вашите критериуми. Во кој дел од градот…?
 *   [05:51] ИМАВТЕ ДУЌАН КАЈ КАТОЛИШЧКА ЗА 1000 ЕВРА КИРИЈА, ПОГОЛЕМ
 *   [05:51] ЛИНА: Во кој дел од градот би било најдобро да го побарам…?
 *   [05:51] НЕ МУ ГО ПАМТАМ БРОЈЧЕТО           → the same area question again
 *
 * The client is not starting a search and not complaining: he is RECALLING a
 * listing he saw with us and asking us to find it without its number. Four
 * defects made that impossible:
 *
 *   1. THE TOLD-YOU LANE CLAIMED THE RECALL — and the sentence it read as a nag
 *      («не го запишав бројчето») is the CLIENT's own forgetting.
 *   2. A RECALL WITHOUT «еден» WAS INVISIBLE: «имавте дуќан … за 1000 евра»
 *      names one listing by its category and its money.
 *   3. THE MAP COULD NOT SPELL THE PLACE: «КАТОЛИШЧКА» (one extra ш) missed,
 *      because the map holds three «Католичка црква …» rows that tie.
 *   4. THE NUMBER HE LOST HAD NO LANE: «не му го памтам бројчето» restarted the
 *      funnel, though the description was already on file.
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
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { detectSeenListingRecall, detectToldYouNag, detectForgotNumber } from '../src/llm/deterministic';
import { setLearnedBank } from '../src/data/responseBank';

setLearnedBank({
  variants: () => [], addVariant: () => false, addExample: () => false,
  metric: () => {}, retrieve: () => undefined,
} as any);

const cfg = loadConfig();
let mapStore: OfflineMapStore | undefined;
const map = (): OfflineMapStore => (mapStore ??= new OfflineMapStore(cfg.skopjePoisDb));

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// The stock the live capture describes: two cheap rental houses around
// Универзална, two shops around Католичка.
const ROWS: Property[] = [
  { eb: 79, id: 79, uuid: 'h-79', address: 'УЛ. Ц', location: 'Центар', service: 'rent', price: 300, bedrooms: 2, sqm: 70, size: '70 м²', house: true, type: 'house', lat: 42.0000, lon: 21.4160 } as Property,
  { eb: 50, id: 50, uuid: 'h-50', address: 'УЛ. Д', location: 'Центар', service: 'rent', price: 250, bedrooms: 2, sqm: 74, size: '74 м²', house: true, type: 'house', lat: 42.0005, lon: 21.4170 } as Property,
  { eb: 91, id: 91, uuid: 'b-91', address: 'УЛ. Е', location: 'Центар', service: 'rent', price: 900, sqm: 60, size: '60 м²', business: true, type: 'business', lat: 42.0008, lon: 21.4400 } as Property,
  { eb: 92, id: 92, uuid: 'b-92', address: 'УЛ. Ж', location: 'Центар', service: 'rent', price: 1100, sqm: 80, size: '80 м²', business: true, type: 'business', lat: 42.0010, lon: 21.4405 } as Property,
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://feed-not-used'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(p => p.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(chatId: string) {
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
  const say = async (text: string): Promise<string> => {
    sent.length = 0;
    await handler.handle('test', chatId, text);
    return sent.at(-1) ?? '';
  };
  return { handler, sessions, sent, say, chatId };
}

// ── 1. A recall of a listing is not a nag, and a lost number is the client's ──

test('[05:48] the client\'s recall and his own forgetting are not a told-you nag', () => {
  const recall = 'ИМАШЕ ЕДНА КУЌА ШТО СЕ ИЗДАВАШЕ КАЈ ВАС , ОКОЛУ УНИВЕРЗАЛНА И КАТОЛИЧКА';
  const forgetting = 'НЕ ГО ЗАПИШАВ БРОЈЧЕТО АМА КИРИЈАТА И БЕЧЕ ЕФТИНА';
  assert.equal(detectSeenListingRecall(recall), true, 'the house he saw with us is a recall');
  assert.equal(detectToldYouNag(recall), false, 'a recall is never the nag');
  assert.equal(detectForgotNumber(forgetting), true, '«не го запишав бројчето» is HIS forgetting');
  assert.equal(detectToldYouNag(forgetting), false, '…and never a complaint about us');

  for (const m of [
    'НЕ МУ ГО ПАМТАМ БРОЈЧЕТО',
    'НЕ СЕ СЕЌАВАМ НА БРОЈОТ',
    'ne go zapisav brojceto',
  ]) {
    assert.equal(detectForgotNumber(m), true, `«${m}» is the client forgetting his own note`);
    assert.equal(detectToldYouNag(m), false, `«${m}» is not aimed at us`);
  }
  // A sentence about the number that is NOT a forgetting keeps its own lane.
  assert.equal(detectForgotNumber('НЕ ЗНАМ ШТО ДА ПРАВАМ СО БРОЈОТ'), false);
  // A real nag keeps firing.
  assert.equal(detectToldYouNag('ПА ТИ КАЖАВ ВЕЌЕ ЕДНАШ'), true);
});

test('[05:51] a remembered price is enough to recall a listing without «еден»', () => {
  assert.equal(detectSeenListingRecall('ИМАВТЕ ДУЌАН КАЈ КАТОЛИШЧКА ЗА 1000 ЕВРА КИРИЈА , ПОГОЛЕМ'), true);
  assert.equal(detectSeenListingRecall('IMAVTE LOKAL KAJ KATOLICKA ZA 500 EVRA'), true);
  // A stock question is not a recall (present tense, no money).
  assert.equal(detectSeenListingRecall('имавте ли дуќани во центар'), false);
  assert.equal(detectSeenListingRecall('имавте ли куќа во центар со 1000 евра'), false);
});

// ── 2. The map can spell the place the client misspelled ─────────────────────

test('[05:51] «КАТОЛИШЧКА» resolves to the row «КАТОЛИЧКА» resolves to', () => {
  const m = map();
  const exact = m.findPoiByName('КАТОЛИЧКА');
  assert.ok(exact, 'the map holds the church');
  const typo = m.findPoiByName('КАТОЛИШЧКА');
  assert.ok(typo, 'one extra ш is not a different place');
  assert.equal(typo.name, exact.name);
  // The typo budget is still a budget: an exact name is never "corrected" into
  // a DIFFERENT place, and the ordinary resolution is untouched.
  assert.equal(m.findPoiByName('УНИВЕРЗАЛНА')?.name, 'Универзална Сала');
  assert.ok(m.findPoiByName('Бариста'), 'an exact business name keeps resolving');
  assert.ok(m.findPoiByName('КАРПОШ'), 'an exact neighbourhood keeps resolving');
});

// ── 3. The captures end to end ──────────────────────────────────────────────

test('[05:48] both lines in one message find the house he described', async () => {
  const h = makeHandler('recall-house');
  await h.say('ДОБРО УТРО');
  const reply = await h.say(
    'ИМАШЕ ЕДНА КУЌА ШТО СЕ ИЗДАВАШЕ КАЈ ВАС , ОКОЛУ УНИВЕРЗАЛНА И КАТОЛИЧКА\nНЕ ГО ЗАПИШАВ БРОЈЧЕТО АМА КИРИЈАТА И БЕЧЕ ЕФТИНА');

  assert.doesNotMatch(reply, /во право сте|Веќе ги имам Вашите критериуми/iu,
    `the nag copy never answers a recall: ${reply}`);
  assert.doesNotMatch(reply, /во кој дел од градот/iu,
    `the area question is not the answer to a described listing: ${reply}`);
  assert.match(reply, /Универзална/iu, `the place he named anchors the answer: ${reply}`);
  assert.match(reply, /Евидентен број 79/u, `the house by Универзална is served: ${reply}`);
  const s = h.sessions.get(h.chatId)!;
  assert.equal(s.slots.house, true, 'the category he named is kept');
  assert.equal(s.slots.service, 'rent', 'the deal he named is kept');
});

test('[05:51] the shop at 1000 € rent is found, and the number he lost re-serves it', async () => {
  const h = makeHandler('recall-business');
  await h.say('ЗДРАВО');
  const first = await h.say('ИМАВТЕ ДУЌАН КАЈ КАТОЛИШЧКА ЗА 1000 ЕВРА КИРИЈА , ПОГОЛЕМ');
  assert.match(first, /Католичка/iu, `the misspelled place resolves: ${first}`);
  assert.match(first, /деловен простор/iu, `the category is the one he named: ${first}`);
  assert.match(first, /Евидентен број 9[12]/u, `a shop around 1.000 € is served: ${first}`);
  assert.doesNotMatch(first, /во кој дел од градот|Која локација во градот/iu,
    `no area grill over a described listing: ${first}`);

  const second = await h.say('НЕ МУ ГО ПАМТАМ БРОЈЧЕТО');
  assert.match(second, /бројот не е проблем/iu, `the lost number is answered: ${second}`);
  assert.match(second, /Евидентен број 9[12]/u, `the same candidates come back: ${second}`);
  const s = h.sessions.get(h.chatId)!;
  assert.deepEqual(
    { kind: s.slots.recallQuery?.kind, price: s.slots.recallQuery?.price, service: s.slots.recallQuery?.service },
    { kind: 'деловен простор', price: 1000, service: 'rent' },
    'the description is kept on the notebook');
});
