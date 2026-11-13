// THE OPERATOR'S 2026-11-13 CAPTURE (02:38 → 03:04), six defects in one chat.
//
//   1. «ГЛЕДАВ КУЌИ И ИМАВТЕ ЕДНА ВО СКОПЈЕ СЕВЕР» → «Би сакала да знам дали
//      куќата ја барате за купување или за изнајмување?» and then a bedrooms/
//      price grill: a client describing a house he SAW with us was treated as a
//      brand-new search. The helpful protocol is the recall lane.
//   2. …and the relaxed intro that followed said «нема СТАН … поголеми
//      СТАНОВИ» over a HOUSE card: the copy named a category the client never
//      asked for.
//   3. «SALAM DA IZNAJMAM DUKJAN VO CENTAR» → «STO IMATE VO PONUDA» served a
//      pair while the м² and the price questions were still unanswered: a pair
//      is earned by the criteria, never guessed.
//   4. «KOLKU SE RAZDALECENI OD KATOLICKA ?» about two served дukjan offers got
//      one property's RENT — the distance lane never saw «раздалечени».
//   5. «KOGA MOZE DA SE VIDAT ?» and «UTRE NAKAJ 6» fell to Gemini (three
//      aborted attempts, 38 s) and answered a canned «Направив избор на неколку
//      интересни варијанти…» instead of the owner protocol.
//   6. A painted frame came back as client input and Lina answered her own
//      sentence with the per-property fee.
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
import { OfflineMapStore } from '../src/geo/offlineMap';
import { BankStore } from '../src/store/bank';
import { EnrichmentStore } from '../src/store/enrichment';
import { looksLikeScreenEcho, detectNumberUnknownRecall, detectSeenListingRecall, isDistanceQuestion } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('probe: LLM disabled'); }
}

// The field rows: the house of the recall (Скопје Север / Визбегово) and the
// three business spaces of the cathedral pair.
const ROWS: Property[] = [
  { eb: 44, id: 44, location: 'Скопје Север', address: 'Визбегово', price: 130000,
    bedrooms: 4, sqm: 150, size: '150 м²', service: 'buy', house: true,
    lat: 42.0127, lon: 21.4215, geo_source: 'google_cached', details: 'куќа со двор' } as unknown as Property,
  { eb: 42, id: 42, location: 'Центар', address: 'Улица 42', price: 1000,
    sqm: 115, size: '115 м²', service: 'rent', business: true,
    lat: 41.9949, lon: 21.4183, geo_source: 'google_cached', details: 'деловен простор' } as unknown as Property,
  { eb: 59, id: 59, location: 'Центар', address: 'Улица 59', price: 950,
    sqm: 105, size: '105 м²', service: 'rent', business: true,
    lat: 41.9956, lon: 21.4169, geo_source: 'google_cached', details: 'деловен простор' } as unknown as Property,
  { eb: 56, id: 56, location: 'Центар', address: 'Улица 56', price: 500,
    sqm: 40, size: '40 м²', service: 'rent', business: true,
    lat: 41.9942, lon: 21.4176, geo_source: 'google_cached', details: 'деловен простор' } as unknown as Property,
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id || r.eb === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(chatId: string) {
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
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  } as never);
  const send = async (m: string) => {
    const before = sent.length;
    await handler.handle('test', chatId, m);
    return { session: sessions.get(chatId)!, reply: sent.slice(before).join('\n') };
  };
  return { send, sessions };
}

// ── 1. THE HELPULMODE RECALL (items 1 and its sibling spelling) ──────────────
test('[02:39] «гледав куќи и имавте една во Скопје Север» is a RECALL, not a new search', async () => {
  // The detectors first: both spellings of "the verb after the category" and
  // both spellings of "I cannot remember the number".
  assert.equal(detectSeenListingRecall('ГЛЕДАВ КУЌИ И ИМАВТЕ ЕДНА ВО СКОПЈЕ СЕВЕР'), true);
  assert.equal(detectSeenListingRecall('GLEAV KUKJI I IMAVTE EDNA VO SKOPJE SEVER'), true);
  assert.equal(detectSeenListingRecall('ИМАВТЕ ЕДНА КУЌА НАКАЈ СКОПЈЕ СЕВЕР'), true, 'the old verb-first shape survives');
  assert.equal(detectSeenListingRecall('ИМАТЕ ЛИ СТАН ВО ЦЕНТАР?'), false, 'present tense is still a search');
  assert.equal(detectNumberUnknownRecall('ЗА КУПУВАЊЕ БЕШЕ. НЕ МОЖАМ ДА СЕ СЕТАМ НА БРОЈОТ'), true);
  assert.equal(detectNumberUnknownRecall('NE MOZAM DA SE SETAM NA BROJOT'), true);

  const { send } = makeHandler('helpful-recall');
  const first = await send('ГЛЕДАВ КУЌИ И ИМАВТЕ ЕДНА ВО СКОПЈЕ СЕВЕР');
  // The market is ONE legitimate question — the criteria grill is the defect.
  assert.doesNotMatch(first.reply, /Колку спални/u, `a recall is never a criteria grill: ${first.reply}`);
  assert.equal(first.session.slots.house, true);
  assert.match(String(first.session.slots.location ?? ''), /Скопје/u, 'the area he named is on file');

  // «ЗА КУПУВАЊЕ БЕШЕ. НЕ МОЖАМ ДА СЕ СЕТАМ НА БРОЈОТ» → the house he saw.
  const second = await send('ЗА КУПУВАЊЕ БЕШЕ. НЕ МОЖАМ ДА СЕ СЕТАМ НА БРОЈОТ');
  assert.match(second.reply, /Евидентен број 44/u, `the same listing is recalled: ${second.reply}`);
  assert.doesNotMatch(second.reply, /Колку спални/u, `no grill on the recall: ${second.reply}`);
  assert.doesNotMatch(second.reply, /До која цена/u, `no price grill either: ${second.reply}`);
});

// ── 2. THE COPY SPEAKS THE CLIENT'S CATEGORY ────────────────────────────────
test('[02:41] a house ask never hears «стан / станови» from the relaxed intro', async () => {
  const { send } = makeHandler('house-copy');
  await send('SAKAM DA KUPAM KUKJA VO SKOPJE SEVER');
  await send('NAJMALCE DVE SPALNI DA IMA');
  const served = await send('DO 130000');
  assert.equal(served.session.slots.house, true);
  assert.match(served.reply, /Евидентен број 44/u, `the house is served: ${served.reply}`);
  // Only bigger houses are in stock, so the relaxed intro fires — in HOUSES.
  assert.match(served.reply, /куќ[аи]/u, `the intro must name the category asked: ${served.reply}`);
  assert.doesNotMatch(served.reply, /(нема стан|станови|станот|во стан)/u,
    `an apartment noun over a house card is the defect: ${served.reply}`);
});

// ── 3. A PAIR IS EARNED BY THE CRITERIA ─────────────────────────────────────
test('[02:48] «што имате во понуда» asks м² and price before any pair', async () => {
  const { send } = makeHandler('dukjan-order');
  const first = await send('SALAM DA IZNAJMAM DUKJAN VO CENTAR');
  assert.match(first.reply, /(квадрат\p{L}*|м²)/u, `the м² is asked: ${first.reply}`);
  assert.match(first.reply, /(цена|сума)/u, `the price is asked too: ${first.reply}`);
  assert.doesNotMatch(first.reply, /Евидентен број/u, 'no card before the criteria');

  const stock = await send('STO IMATE VO PONUDA');
  assert.doesNotMatch(stock.reply, /Евидентен број/u,
    `a pair served over unanswered criteria is the defect: ${stock.reply}`);
  assert.match(stock.reply, /(квадрат\p{L}*|м²)/u, `the owed м² question comes first: ${stock.reply}`);
  assert.match(stock.reply, /(цена|сума)/u, `and the price question with it: ${stock.reply}`);

  // …and once answered, the pair arrives.
  await send('OKOLU 110 KVADRATI');
  const served = await send('DO 1200 EVRA');
  assert.match(served.reply, /Евидентен број/u, `the criteria buy the pair: ${served.reply}`);
});

// ── 4. DISTANCE FOR BOTH SERVED OFFERS ──────────────────────────────────────
test('[02:51] «колку се раздалечени од Католичка» measures BOTH offers', async () => {
  assert.equal(isDistanceQuestion('KOLKU SE RAZDALECENI OD KATOLICKA ?'), true,
    'раздалечени is the same ask as оддалечени');
  assert.equal(isDistanceQuestion('КОЛКУ СЕ РАЗДАЛЕЧЕНИ ОД КАТОЛИЧКА?'), true);

  const { send, sessions } = makeHandler('distance-both');
  // THE PAIR THE FIELD CHAT HAD: both дukjan offers served, the cathedral the
  // client named as the anchor (EB 56 is the third row of stock, never shown).
  // Seeded through the store because this test is about the DISTANCE answer,
  // not about how the pair was drawn (that is the [02:48] test above).
  const seeded = freshSession('test', 'distance-both');
  seeded.state = 'presentation';
  seeded.slots.service = 'rent';
  seeded.slots.business = true;
  seeded.slots.sqm = 110;
  seeded.slots.budget = '1200';
  seeded.slots.location = 'Центар (населба)';
  seeded.slots.poiAnchor = 'Римокатоличка';
  seeded.slots.currentBatch = [42, 59];
  seeded.slots.presentedIds = [42, 59];
  seeded.history = [
    { role: 'user', text: 'SALAM DA IZNAJMAM DUKJAN KAJ KATOLICKA' },
    { role: 'assistant', text: 'Евидентен број 42 — деловен простор, во Центар, 115 м², 1.000 евра.' },
    { role: 'user', text: 'OKOLU 110 KVADRATI' },
    { role: 'assistant', text: 'Евидентен број 59 — деловен простор, во Центар, 105 м², 950 евра.' },
  ];
  sessions.set(seeded);
  const asked = await send('KOLKU SE RAZDALECENI OD KATOLICKA ?');
  // BOTH measured: the question covers the whole batch (the [22:25] rule).
  assert.match(asked.reply, /Евидентен број 42/u, `the first offer measured: ${asked.reply}`);
  assert.match(asked.reply, /Евидентен број 59/u, `the second offer measured: ${asked.reply}`);
  assert.match(asked.reply, /(метри|km|км)/u, `a measurement, not a rent: ${asked.reply}`);
  assert.doesNotMatch(asked.reply, /киријата изнесува/u, `the rent is not the answer: ${asked.reply}`);
});

// ── 5. THE VISIT PROTOCOL OWNS A TIME, NEVER THE LLM ────────────────────────
test('[03:01] a timing question and a proposed hour stay deterministic', async () => {
  const { send, sessions } = makeHandler('visit-time');
  // Same pair on the table as the field chat (see the distance test above).
  const seeded = freshSession('test', 'visit-time');
  seeded.state = 'presentation';
  seeded.slots.service = 'rent';
  seeded.slots.business = true;
  seeded.slots.sqm = 110;
  seeded.slots.budget = '1200';
  seeded.slots.location = 'Центар (населба)';
  seeded.slots.poiAnchor = 'Римокатоличка';
  seeded.slots.currentBatch = [42, 59];
  seeded.slots.presentedIds = [42, 59];
  seeded.history = [
    { role: 'user', text: 'SALAM DA IZNAJMAM DUKJAN KAJ KATOLICKA' },
    { role: 'assistant', text: 'Евидентен број 42 — деловен простор, во Центар, 115 м², 1.000 евра.' },
    { role: 'user', text: 'OKOLU 110 KVADRATI' },
    { role: 'assistant', text: 'Евидентен број 59 — деловен простор, во Центар, 105 м², 950 евра.' },
  ];
  sessions.set(seeded);

  const timing = await send('KOGA MOZE DA SE VIDAT ?');
  assert.match(timing.reply, /сопственик/u, `a timing ask is the owner-contact confirm: ${timing.reply}`);
  assert.doesNotMatch(timing.reply, /исцрпивме|немаме други опции/u,
    `never the drained line: ${timing.reply}`);

  const hour = await send('UTRE NAKAJ 6');
  const sess = hour.session;
  // The slot carries the client's own shape (the [00:49] contract); the
  // renderers name it when they speak to the owner.
  assert.equal(sess.slots.visitTime, 'UTRE NAKAJ 6', 'the client\'s own hour is kept for the owner ping');
  assert.match(hour.reply, /Евидентен број/u, `the offer he is booking is named: ${hour.reply}`);
  assert.match(hour.reply, /300 денари/u, `the visit fee is the protocol's next step: ${hour.reply}`);
  assert.doesNotMatch(hour.reply, /Направив избор на неколку интересни/u,
    'the canned variants line is never the answer to a proposed hour');
});

// ── 6. A REFLECTED FRAME IS NOT A CLIENT ────────────────────────────────────
test('[02:04] the app refuses its own painted frame as input', async () => {
  const echo = '[02:50] ЛИНА [без LLM]: Да, имаме деловни простори во близина   │\n│             ';
  assert.equal(looksLikeScreenEcho(echo), true);
  assert.equal(looksLikeScreenEcho('│  Евидентен број 42 — деловен простор │'), true);
  assert.equal(looksLikeScreenEcho('ЗДРАВО, МЕ ИНТЕРЕСИРА СТАН ВО ЦЕНТАР'), false);
  assert.equal(looksLikeScreenEcho('KOLKU E KIRIJATA ZA EV 42 ?'), false);

  const { send } = makeHandler('echo');
  const clean = await send('ZDRAVO');
  assert.ok(clean.reply.length > 0, 'a real greeting is answered');
  const refused = await send(echo);
  assert.equal(refused.reply, '', `an echoed frame earns NO reply: ${refused.reply}`);
  assert.equal(refused.session.history.length, 2,
    'the echo is not written to the history either (user + assistant only)');
});
