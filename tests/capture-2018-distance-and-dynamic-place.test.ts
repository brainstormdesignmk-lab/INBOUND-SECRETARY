// THE [20:19]–[20:38] CAPTURE — «КОЛКУ ИМА ОД ГРАДСКА ДО СТАНОТ?», three
// times, and the dynamic bank the client was reading while asking.
//
//   1. «КОЛКУ ИМА ОД ГРАДСКА ДО НЕГО ?» → «Ernst & Young се наоѓа на 1,1 км…».
//      The DISTANCE lane read the destination («до него») as the PLACE and the
//      fuzzy lookup turned a pronoun into a consultancy. «ДО СТАНОВ» became
//      «Меѓународна предучилишна установа Скопје» the same way, and «ДО
//      СТАНОТ» — a word the FROM stop list already knew — fell out of the lane
//      entirely and re-served the card / opened a place search (in the field:
//      «три недвижности близу Студентски дом Пелагонија»).
//   2. The bare «ГРАДСКА» the client writes for the city hospital resolved to
//      «Градска кафеана „Идадија“» — a kafana — so even a correct reading of
//      the sentence measured the flat to a restaurant.
//   3. The bank's dynamic recall is a state-agnostic trigram lookup, so a stored
//      sentence about ONE place could be served to a client asking about
//      another: «околу Градска болница имаме повеќе понуди» is a location claim
//      that is false anywhere else.
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
import { BankStore } from '../src/store/bank';
import { EnrichmentStore } from '../src/store/enrichment';
import { extractDistancePlace, isDistanceQuestion } from '../src/llm/deterministic';
import { recallDynamic, shouldTryDynamic, validateDynamicAnswer, dynamicRowViolations } from '../src/llm/dynamicFallback';
import { feedAreasIn } from '../src/llm/placeTemplate';
import type { ChatSession } from '../src/fsm/session';

function fakeSession(): ChatSession {
  return {
    chatId: 'dist-gen', state: 'property_query',
    slots: { service: 'buy' }, history: [],
    createdAt: Date.now(), updatedAt: Date.now(),
  } as unknown as ChatSession;
}


class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// EB 69 is the flat of the capture: Центар, 51 м², 99.000 €, 980 m from
// Градска болница. 94/89/87 are the Кисела Вода / Аеродром / Ново Лисиче rows
// the place-search lane listed near Пелагонија instead of answering.
const ROWS: Property[] = [
  { eb: 69, id: 69, location: 'Центар', address: 'У. Димитар Миладинов', price: 99000,
    bedrooms: 1, sqm: 51, size: '51 м²', service: 'buy', lat: 41.9986, lon: 21.4256 },
  { eb: 94, id: 94, location: 'Кисела Вода', address: 'Студентски дом Пелагонија', price: 92000,
    bedrooms: 1, sqm: 55, size: '55 м²', service: 'buy', lat: 41.9762, lon: 21.4448 },
  { eb: 89, id: 89, location: 'Аеродром', address: 'Парк Авионче', price: 110000,
    bedrooms: 1, sqm: 70, size: '70 м²', service: 'buy', lat: 41.9894, lon: 21.4768 },
  { eb: 87, id: 87, location: 'Ново Лисиче', address: 'Ново Лисиче', price: 95000,
    bedrooms: 2, sqm: 77, size: '77 м²', service: 'buy', lat: 41.9832, lon: 21.4600 },
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
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    bank: new BankStore(db),
    classifier: new Classifier(llm, cfg, properties),
    responder: new Responder(llm, cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, {
      osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb),
    }),
    enrichment: new EnrichmentStore(db),
  } as never);
  const chatId = 'capture-2018';
  const send = async (m: string) => {
    const before = sent.length;
    await handler.handle('test', chatId, m);
    return { session: sessions.get(chatId)!, reply: sent.slice(before).join('\n') };
  };
  return { send };
}

test('[20:29] the flat\'s own word is never the place: НЕГО / СТАНОВ / СТАНОТ', () => {
  for (const msg of [
    'КОЛКУ ИМА ОД ГРАДСКА ДО НЕГО ?',
    'КОЛКУ ИМА ОД ГРАДСКА ДО СТАНОВ ?',
    'КОЛКУ ИМА ОД ГРАДСКА ДО СТАНОТ ?',
    'КОЛКУ ИМА ОД ГРАДСКА ДО СТАНОВИТЕ ?',
  ]) {
    assert.equal(isDistanceQuestion(msg), true, msg);
    assert.equal(extractDistancePlace(msg), 'ГРАДСКА',
      `the only place in «${msg}» is the origin — the flat is the subject: ${extractDistancePlace(msg)}`);
  }
  // A real destination still wins over the origin.
  assert.equal(extractDistancePlace('КОЛКУ ИМА ОД СТАНОТ ДО СИТИ МОЛ ?'), 'СИТИ МОЛ');
  assert.equal(extractDistancePlace('КОЛКУ ИМА ОД ГРАДСКА БОЛНИЦА ДО СТАНОТ ?'), 'ГРАДСКА БОЛНИЦА');
  // A destination the client really named after the flat word is kept.
  assert.equal(extractDistancePlace('КОЛКУ ИМА ОД СТАНОТ ДО ГРАДСКА БОЛНИЦА ?'), 'ГРАДСКА БОЛНИЦА');
});

test('[20:29] «ОД ГРАДСКА ДО СТАНОТ» measures the flat to the hospital, not to a POI', async () => {
  const { send } = makeHandler();
  await send('INFOMI ZA 69');
  for (const msg of [
    'КОЛКУ ИМА ОД ГРАДСКА ДО НЕГО ?',
    'КОЛКУ ИМА ОД ГРАДСКА ДО СТАНОВ ?',
    'КОЛКУ ИМА ОД ГРАДСКА ДО СТАНОТ ?',
  ]) {
    const { reply, session } = await send(msg);
    assert.match(reply, /Градска болница/u, `«${msg}» must name the hospital: ${reply}`);
    assert.match(reply, /\d+\s*метри/u, `«${msg}» must state a measured distance: ${reply}`);
    // The flat under discussion is the one measured, and it stays the subject.
    // (One card has been shown, so the sentence needs no EB — the contract is
    // "name it when more than one has been presented"; the SLOT is what pins
    // the measurement, and the reply must not carry the 2,4 km kindergarten's
    // or the consultancy's number at all.)
    assert.equal(session.slots.propertyId, 69);
    assert.equal(session.slots.lastDistanceEb, 69, `«${msg}» must measure THIS flat`);
    assert.doesNotMatch(reply, /2,4 километри|1,1 километри/u, reply);
    // The old mis-reads: a consultancy, a kindergarten, a Pelagonija list.
    assert.doesNotMatch(reply, /Ernst\s*&\s*Young|предучилишна|Пелагонија/u, reply);
  }
});

test('[20:30] the bare «ГРАДСКА» is the hospital, and a kafana keeps its own row', async () => {
  const { send } = makeHandler();
  await send('INFOMI ZA 69');
  const kafana = await send('КОЛКУ ИМА ОД ГРАДСКА КАФЕАНА ИДАДИЈА ДО СТАНОТ ?');
  assert.match(kafana.reply, /кафеана/u, `an explicitly named POI keeps its row: ${kafana.reply}`);
  assert.doesNotMatch(kafana.reply, /Градска болница/u, kafana.reply);
});

test('[20:19] a distance is measured, never generated or banked', () => {
  const session = fakeSession();
  for (const msg of [
    'КОЛКУ ИМА ОД ГРАДСКА ДО СТАНОТ ?',
    'NA KOLKU METRA E STANOT OD GRADSKA ?',
    'КОЛКУ ИМА ОД ГРАДСКА ДО НЕГО ?',
  ]) {
    assert.equal(shouldTryDynamic(session, msg), false, `«${msg}» must never reach generate+store`);
  }
  // The stored row the capture produced: a metre figure is a property datum.
  const stored = 'Станот се наоѓа на само 410 метри од Градска болница, што е навистина одлична и практична локација. Дали сакате да го контактирам сопственикот и да организираме посета за да го видите во живо?';
  assert.ok(validateDynamicAnswer(stored, 'КОЛКУ ИМА ОД ГРАДСКА ДО СТАНОТ ?').length > 0,
    'a stored distance answer must be refused at recall');
  assert.equal(recallDynamic({ retrieveDynamic: () => ({ key: 'dynamic:x', answer: stored, msg: 'КОЛКУ ИМА ОД ГРАДСКА ДО СТАНОТ ?' }) },
    'КОЛКУ ИМА ОД ГРАДСКА ДО СТАНОТ ?'), undefined);
});

test('[20:18] a stored answer never travels to another place on recall', () => {
  const db = new Db(':memory:');
  const bank = new BankStore(db);
  const answer = 'Здраво! Во тој дел околу Градска болница имаме повеќе актуелни понуди. За да можам да ги одберам вистинските опции за Вас, дали Ве интересира купување или изнајмување на недвижност?';
  bank.addDynamic('dynamic:idle:sto-bi-mi', 'idle',
    'ШТО БИ МИ ПОНУДИЛЕ ОКОЛУ ГРАДСКА БОЛНИЦА', answer);
  // The phrasing it was taught still serves.
  assert.ok(recallDynamic(bank, 'ШТО БИ МИ ПОНУДИЛЕ ОКОЛУ ГРАДСКА БОЛНИЦА'));
  // The SAME shape at another place does not: the sentence names its own place.
  assert.equal(recallDynamic(bank, 'ШТО ИМА КАЈ ГРАДСКА КАФЕАНА ИДАДИЈА ИНТЕРЕСНО'), undefined,
    'a place-bound sentence must not answer a question about a different place');
  // A row with no place at all keeps the fuzzy recall.
  bank.addDynamic('dynamic:idle:kako-da', 'idle', 'КАКО ДА ЗАКАЖАМ ПОСЕТА ВО САБОТА',
    'Во ред. Ќе проверам кај сопственикот и ќе Ви се јавам.');
  assert.ok(recallDynamic(bank, 'КАКО ДА ЗАКАЖАМ ПОСЕТА ВО САБОТА'));
});

test('[20:18] the EXACT recall door enforces the borrowed place too', () => {
  // The exact/containment door runs BEFORE the fuzzy one, and it used to check
  // only the fact/hygiene contracts — the same stored sentence could reach a
  // client asking about another place by a containment match (stored
  // «ШТО ИМА КАЈ ГРАДСКА БОЛНИЦА» inside «ШТО ИМА КАЈ ГРАДСКА БОЛНИЦА И ПАРК?»).
  const db = new Db(':memory:');
  const bank = new BankStore(db);
  const answer = 'Здраво! Во тој дел околу Градска болница имаме повеќе актуелни понуди. Ве интересира купување или изнајмување на недвижност?';
  bank.addDynamic('dynamic:idle:sto-ima-kaj', 'idle', 'ШТО ИМА КАЈ ГРАДСКА БОЛНИЦА', answer);

  const hit = bank.retrieveDynamicExact('ШТО ИМА КАЈ ГРАДСКА БОЛНИЦА', 'idle');
  assert.ok(hit, 'the exact door still returns the row for its own phrasing');
  assert.equal(hit!.msg, 'ШТО ИМА КАЈ ГРАДСКА БОЛНИЦА', 'the row\'s own question travels with the hit');
  assert.deepEqual(validateDynamicAnswer(hit!.answer, 'ШТО ИМА КАЈ ГРАДСКА БОЛНИЦА', { storedMsg: hit!.msg }), [],
    'the taught phrasing still serves');

  // Containment means the stored phrasing sits INSIDE the new message, so the
  // only way the places can differ is a longer place phrase: the client asked
  // about two locations, the stored sentence speaks to one. The exact door must
  // refuse it exactly like the fuzzy one (the extractor reads the fuller phrase
  // «ГРАДСКА БОЛНИЦА И КАПИТОЛ МОЛ», the row's question only «ГРАДСКА БОЛНИЦА»).
  const other = bank.retrieveDynamicExact('ШТО ИМА КАЈ ГРАДСКА БОЛНИЦА И КАПИТОЛ МОЛ', 'idle');
  assert.ok(other, 'containment still matches the shared phrasing');
  assert.ok(validateDynamicAnswer(other!.answer, 'ШТО ИМА КАЈ ГРАДСКА БОЛНИЦА И КАПИТОЛ МОЛ', { storedMsg: other!.msg }).length > 0,
    'a stored sentence for one place must not answer a question that names a different place');
});

test('[23:09] an area that lives only in the ANSWER is a borrowed place', () => {
  // The three stored rows of this capture. Each names a Skopje AREA its own
  // trigger never mentioned: «A NESTO MALKU POSKAPO ?» → «…во Центар…»,
  // «KOJ E TOJ STAN ?» → «…тој стан во Аеродром…», and «OD KOE SELO SI?» →
  // «…трисобни станови … во Центар». The old guard compared the two MESSAGES,
  // so an area that existed only in the answer was invisible and the sentence
  // was banked as prose true for any client.
  const said = 'Ќе ги проверам достапните станови за купување во Центар со малку повисок буџет. До која максимална сума би сакале да ја прошириме потрагата?';
  const q = 'A NESTO MALKU POSKAPO ?';
  assert.ok(validateDynamicAnswer(said, q).some(v => v.includes('borrowed area')),
    'an area the trigger never named is a violation');
  assert.ok(dynamicRowViolations({ msg: q, answer: said }).length > 0, 'the row audit sees it too');
  assert.ok(dynamicRowViolations({ msg: 'KOJ E TOJ STAN ?',
    answer: 'Точните детали за тој стан во Аеродром ги немам во евиденцијата. Дали да го контактирам сопственикот?' }).length > 0);
  assert.ok(dynamicRowViolations({ msg: 'OD KOE SELO SI?',
    answer: 'Живеам и работам тука во Скопје. Дали сакале да проверам кај сопствениците за трисобни станови во Центар?' }).length > 0);

  // The client naming the area (either script) makes the sentence correct.
  assert.deepEqual(validateDynamicAnswer(said, 'A NESTO MALKU POSKAPO VO CENTAR ?'), []);
  // …and so does the SESSION having established it — the live turn may use it.
  assert.deepEqual(validateDynamicAnswer(said, q, { allowedPlaces: ['Центар'] }), []);
  // A different area is never covered by the allowance.
  assert.ok(validateDynamicAnswer(said, q, { allowedPlaces: ['Аеродром'] }).some(v => v.includes('borrowed area')));

  // RECALL: the stored row stops serving whoever asks its trigger without the
  // area, and resumes only inside a session that did establish the area.
  const db = new Db(':memory:');
  const bank = new BankStore(db);
  bank.addDynamic('dynamic:presentation:nesto-malku-poskapo', 'presentation', q, said);
  assert.equal(recallDynamic(bank, q), undefined, 'a banked borrowed area never serves bare');
  assert.ok(recallDynamic(bank, q, undefined, ['Центар']), 'the session that named Центар may be served');
  assert.equal(recallDynamic(bank, q, undefined, ['Аеродром']), undefined, 'another area may not');
});

test('[23:09] the area scan is script-folded and phrase-exact', () => {
  assert.deepEqual(feedAreasIn('Ќе проверам во Центар.'), ['Центар']);
  assert.deepEqual(feedAreasIn('ke proveram vo CENTAR'), ['Центар'], 'Latin typing is the same place');
  assert.deepEqual(feedAreasIn('kisela voda e blisku'), ['Кисела Вода']);
  assert.deepEqual(feedAreasIn('vo Novo Lisice'), ['Ново Лисиче'], 'a multi-word area matches as a phrase');
  assert.deepEqual(feedAreasIn('vo Lisice'), ['Лисиче'], '…and the bare settlement never matches the sibling');
  assert.deepEqual(feedAreasIn('Ќе проверам кај сопственикот.'), [], 'no area, no violation');
});
