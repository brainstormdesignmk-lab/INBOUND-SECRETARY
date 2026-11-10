// THE [12:22]–[12:33] FIELD BATCH — a flat named by the building it faces, and
// the price level of a corner of town.
//
//   [12:31] «ДОБАР ДЕН. КОЛКУОДАТ СЕГА СТАНОВИТЕ ОКОЛУ БУНЈАКОВЕЦ ?»
//        → «колку одат» typed as ONE token. The market lane's movement verb
//          only knew the fused «какоодат», so the level question missed every
//          arm and the client was asked «купување или изнајмување?» — twice
//          («ПРОДАЖБА ДА», «КОЛКУ ОДАТ КАЖИ МИ ПРВО») before the level was ever
//          quoted. A neighbourhood the feed files under a bigger area (Буњаковец
//          → Центар) must be measured AROUND THE PLACE, not presented as the
//          whole district's spread.
//   [12:22] «ДОБАР ДЕН. ДАЛИ ВИ Е УШТЕ НА ПРОДАЌБА СТАНОТ СПРОТИ ДИМИТАР
//            МИЛАДИНОВ?»
//        → two independent causes: «спроти» was missing from the property-
//          descriptor grammar (the one landmark word the client actually used),
//          and the sale NOUN was typed «ПРОДАЌБА» (ќ for ж) — a phone-keyboard
//          slip the availability family did not know, so the sale question read
//          as a fresh need and got the buy-or-rent intake.
//   [12:24] «ГО БАРАМ СТАНОТ СПРОТИ ДИМИТАР МИЛАДИНОВ»
//        → searching for one flat he can only name by the school across the
//          street; the locate funnel answered «Колку спални соби… / До која
//          цена…». He is not opening a search — the map already places the flat.
//
// A sibling defect from the same run is pinned at the bottom: «НИКОЈ НЕ МИ
// НАПЛАТИЛ ДО СЕГА» (a universal charge objection) was answered with the fee.why
// explanation instead of burning the ladder's next rung.
//
// Distances are real metres from the map rows (69 m for EB 69; 300+ m for the
// others), so the tight-ring rule is what keeps the wrong flats out — not a
// fixture that happens to hold one row.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
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
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import {
  detectAvailabilityAsk, detectFeeNag, detectMarketLevelFollowUp, detectMarketPriceAsk,
  detectPropertyDescription,
} from '../src/llm/deterministic';

class FailingLlm {
  async complete(): Promise<string> { throw new Error('429'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb);
  }
  get healthy(): boolean { return true; }
}

// The field geography, measured: Буњаковец (41.9975, 21.4186) with two sale rows
// inside the one-kilometre ring and one Центар row 1.9 km away (its 2.757 €/m²
// must never be quoted as «околу Буњаковец»). ОУ „Димитар Миладинов“
// (41.9892, 21.4348): EB 69 is the flat across the street (≈65 m); EB 47 and
// EB 38 stand 300 m away — near the school, not ACROSS from it.
const ROWS: Property[] = [
  // Буњаковец
  { eb: 63, id: 63, location: 'Центар', address: 'Црногорска 9', price: 36000, service: 'buy', studio: true, bedrooms: 1, sqm: 28, size: '28 м²', lat: 41.9987, lon: 21.4186 } as Property,
  { eb: 84, id: 84, location: 'Центар', address: 'Роза Луксембург', price: 117000, service: 'buy', bedrooms: 3, sqm: 48, size: '48 м²', lat: 42.0006, lon: 21.4186 } as Property,
  { eb: 95, id: 95, location: 'Центар', address: 'Црвена Вода', price: 204000, service: 'buy', bedrooms: 3, sqm: 74, size: '74 м²', lat: 41.9800, lon: 21.4186 } as Property,
  // Димитар Миладинов
  { eb: 69, id: 69, location: 'Центар', address: 'Спроти Браќа Рибар', price: 99000, service: 'buy', bedrooms: 2, sqm: 51, size: '51 м²', lat: 41.9898, lon: 21.4348 } as Property,
  { eb: 47, id: 47, location: 'Центар', address: 'Железничка 64', price: 150500, service: 'buy', bedrooms: 2, sqm: 59, size: '59 м²', lat: 41.9866, lon: 21.4330 } as Property,
  { eb: 38, id: 38, location: 'Кисела Вода', address: 'Рампа', price: 101750, service: 'buy', bedrooms: 3, sqm: 57, size: '57 м²', lat: 41.9865, lon: 21.4360 } as Property,
  // The fee ladder's rent row (the sibling defect's thread).
  { eb: 79, id: 79, location: 'Капиштец', address: 'Партенија', price: 250, service: 'rent', bedrooms: 2, sqm: 55, size: '55 м²' } as Property,
];

function makeHandler() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'capture-1222-'));
  const mapPath = path.join(dir, 'map.db');
  writeMap(mapPath, [
    { name: 'Буњаковец', type: 'neighbourhood', lat: 41.9975, lon: 21.4186, source: 'google' },
    { name: 'ОУ „Димитар Миладинов“', type: 'school', lat: 41.989222, lon: 21.4347755, source: 'google' },
  ], []);
  const offlineMap = new OfflineMapStore(mapPath);
  const db = new Db(':memory:');
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const llm = new FailingLlm();
  const properties = new FakeProps(ROWS);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(llm, cfg, properties),
    responder: new Responder(llm, cfg),
    properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap }),
  });
  return { handler, sessions, sent, offlineMap };
}

const CARD = /Евидентен број \d/u;

// ── 1. «КОЛКУОДАТ» is «колку одат» ──────────────────────────────────────────

test('[12:31] the fused «КОЛКУОДАТ» is the price-level idiom, not a funnel opener', () => {
  assert.equal(detectMarketPriceAsk('ДОБАР ДЕН. КОЛКУОДАТ СЕГА СТАНОВИТЕ ОКОЛУ БУНЈАКОВЕЦ ?'), true,
    'the fused ask-word must reach the movement verb');
  assert.equal(detectMarketPriceAsk('KOLKUODAT SEGA STANOVITE OKOLU BUNJAKOVEC ?'), true,
    'the Latin typing folds the same way');
  // …and the different SUBJECT keeps its own lane: a greeting about «работите»
  // carries no property word, so neither the market ask nor the bare follow-up
  // may claim it.
  assert.equal(detectMarketPriceAsk('КОЛКУ ОДАТ РАБОТИТЕ?'), false);
  assert.equal(detectMarketLevelFollowUp('КОЛКУ ОДАТ РАБОТИТЕ?'), false);
  // The bare follow-up is the movement idiom alone («the scope is on screen»).
  assert.equal(detectMarketLevelFollowUp('КОЛКУ ОДАТ КАЖИ МИ ПРВО'), true);
  assert.equal(detectMarketLevelFollowUp('KOLKU ODAT'), true);
});

test('[12:31] the level of «околу Буњаковец» is measured around the place', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const chatId = 'c1222-area';
  await handler.handle('test', chatId, 'ДОБАР ДЕН. КОЛКУОДАТ СЕГА СТАНОВИТЕ ОКОЛУ БУНЈАКОВЕЦ ?');
  const reply = sent[sent.length - 1] ?? '';
  const s = sessions.get(chatId)!;

  assert.match(reply, /^Во Буњаковец и околината, цените варираат од 1\.286 до 2\.438 евра за м²/u, reply);
  assert.ok(!/2\.757/u.test(reply),
    `the Центар row 1.9 km away is NOT «околу Буњаковец»: ${reply}`);
  assert.ok(!/купување или изнајмување|купите или да изнајмите/iu.test(reply),
    `the level question is answered, not bounced to the intake: ${reply}`);
  assert.match(reply, /зависност од местоположбата/iu, 'the dependency line closes the band');
  assert.equal(s.slots.poiAnchor, 'Буњаковец', 'the place is kept for the follow-up');

  // The bare follow-up («КОЛКУ ОДАТ КАЖИ МИ ПРВО») measures the SAME scope — no
  // second intake question, no bedrooms/budget grill.
  await handler.handle('test', chatId, 'ПРОДАЖБА ДА');
  await handler.handle('test', chatId, 'КОЛКУ ОДАТ КАЖИ МИ ПРВО');
  const again = sent[sent.length - 1] ?? '';
  assert.match(again, /^Во Буњаковец и околината, цените варираат од 1\.286 до 2\.438 евра за м²/u, again);
  assert.ok(!/спални|максимална цена/iu.test(again), `no criteria grill on a level follow-up: ${again}`);

  offlineMap.close();
});

// ── 2. «спроти X» names a property; «ПРОДАЌБА» is the sale noun ─────────────

test('[12:22] «спроти» is a property anchor and «ПРОДАЌБА» is the sale question', () => {
  const availability = 'ДОБАР ДЕН. ДАЛИ ВИ Е УШТЕ НА ПРОДАЌБА СТАНОТ СПРОТИ ДИМИТАР МИЛАДИНОВ?';
  assert.equal(detectPropertyDescription(availability), true,
    '«станот спроти <place>» is a specific property');
  assert.equal(detectAvailabilityAsk(availability), true,
    '«на продаќба» is the sale noun the client typed');
  assert.equal(detectAvailabilityAsk('ЗДРАВО ДАЛИ УШТЕ СЕ ПРОДАВА ГАРСОЊЕРАТА ?'), true,
    'the correct spelling keeps working');
  // The SURROUNDINGS question keeps its veto — the nearby ask is not availability.
  assert.equal(detectAvailabilityAsk('ШТО ИМА ВО БЛИЗИНА НА СТАНОТ ?'), false);
});

test('[12:22] the availability ask binds the flat ACROSS the school, not the near ones', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const chatId = 'c1222-avail';
  await handler.handle('test', chatId,
    'ДОБАР ДЕН. ДАЛИ ВИ Е УШТЕ НА ПРОДАЌБА СТАНОТ СПРОТИ ДИМИТАР МИЛАДИНОВ?');
  const reply = sent[sent.length - 1] ?? '';
  const s = sessions.get(chatId)!;

  assert.ok(CARD.test(reply), `the flat at the place is named: ${reply}`);
  assert.ok(reply.includes('Евидентен број 69'), `the flat across the street leads: ${reply}`);
  assert.ok(!reply.includes('Евидентен број 47'), `a flat 300 m away is not «спроти»: ${reply}`);
  assert.ok(!reply.includes('Евидентен број 38'), `another district's flat is not «спроти»: ${reply}`);
  assert.ok(!/купување или изнајмување|купите или да изнајмите/iu.test(reply),
    `the sale question is answered, not re-asked: ${reply}`);
  assert.equal(s.state, 'closing', `the availability answer is the visit funnel: ${s.state}`);
  assert.equal(s.slots.interestedPropertyId, 69);
  // EXPECTATION FIXED (the bank rotates variants): the stem `активн` never
  // matches the shipped «Сè уште се води како активен во нашата евиденција»
  // (the «е» breaks the stem), so the full-suite run failed on that variant
  // while the short one passed. Stems take inflections (AGENTS.md §4c).
  assert.ok(/достап|слободн|продажб|актив/iu.test(reply), `availability copy expected: ${reply}`);

  offlineMap.close();
});

test('[12:24] «ГО БАРАМ СТАНОТ СПРОТИ …» serves that flat and asks the pick question', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const chatId = 'c1222-search';
  await handler.handle('test', chatId, 'ДОБАР ДЕН. ГО БАРАМ СТАНОТ СПРОТИ ДИМИТАР МИЛАДИНОВ');
  const reply = sent[sent.length - 1] ?? '';
  const s = sessions.get(chatId)!;

  assert.ok(reply.includes('Евидентен број 69'), `the flat at the place is served: ${reply}`);
  assert.ok(!reply.includes('Евидентен број 47') && !reply.includes('Евидентен број 38'),
    `the tight ring holds only the flat at the place: ${reply}`);
  assert.match(reply, /Дали ова е станот што го видовте/u, `the pick question closes the serve: ${reply}`);
  assert.ok(!/Колку спални|максимална цена/iu.test(reply),
    `no criteria grill over a flat the map already places: ${reply}`);
  assert.equal(s.state, 'property_locate');
  assert.deepEqual(s.slots.currentBatch, [69]);

  offlineMap.close();
});

// THE BOUNDARY OF THE TIGHT RING (the [20:24]/[22:03] Broz Cafe pins): «спроти»
// is one address, «кај» is a vicinity. Distance cannot tell them apart — 95 at
// 123 m and 77 at 303 m are both «кај Броз кафе» — so the predicate decides, and
// a vicinity ask must never collapse into a single-card serve.
test('[20:24] «кај X» keeps the batch: a vicinity is a choice, not one address', async () => {
  const { handler, sessions, sent, offlineMap } = makeHandler();
  const chatId = 'c1222-kaj';
  await handler.handle('test', chatId, 'ГО БАРАМ СТАНОТ КАЈ ДИМИТАР МИЛАДИНОВ');
  const reply = sent[sent.length - 1] ?? '';
  const s = sessions.get(chatId)!;

  assert.equal(s.slots.interestedPropertyId, undefined,
    `«кај» may not bind one flat: ${reply}`);
  assert.ok(!/Дали ова е станот што го видовте/u.test(reply),
    `no single-flat serve for a vicinity ask: ${reply}`);

  offlineMap.close();
});

// ── 3. Sibling from the same run: the universal charge objection is a nag ────

test('[12:27] «НИКОЈ НЕ МИ НАПЛАТИЛ ДО СЕГА» burns the next rung, never fee.why', async () => {
  assert.equal(detectFeeNag('НИКОЈ НЕ МИ НАПЛАТИЛ ДО СЕГА'), true,
    'the perfective charge verb is the fee referent of a universal objection');
  // The GENERIC claim is the why-family argument the [22:26] pin answers with
  // the rationale — only the PERSONAL claim (ми/ме/до сега) is fee resistance.
  assert.equal(detectFeeNag('NIKOJ NE NAPLAKJA'), false,
    'the generic «nobody charges» stays the reason, not a rung');
  assert.equal(detectFeeNag('КОЛКУ Е ЗА ПОСЕТА?'), false,
    'a neutral how-much question is still not a nag');

  const { handler, sessions, sent, offlineMap } = makeHandler();
  const chatId = 'c1222-fee';
  const send = async (m: string) => {
    await handler.handle('test', chatId, m);
    return sessions.get(chatId)!;
  };
  await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 79');
  await send('DALI E SEUSTE DOSTAPEN ?');
  let s = await send('KONTAKTIRAJTE GO I KAZETE MI');
  assert.ok(/300\s*денари/u.test(sent[sent.length - 1] ?? ''),
    `the rent disclosure opens the ladder: ${(sent[sent.length - 1] ?? '').slice(0, 120)}`);

  s = await send('МАЛЦЕ ВИ Е ГЛУПО ОВА СО НАПЛАТА ЗА ПОСЕТА');
  assert.equal(s.slots.feeRejections, 1, 'the complaint is rung 1');

  s = await send('НИКОЈ НЕ МИ НАПЛАТИЛ ДО СЕГА');
  const reply = sent[sent.length - 1] ?? '';
  assert.equal(s.slots.feeRejections, 2, `the universal objection is rung 2, got ${s.slots.feeRejections}`);
  assert.ok(/правил|ценовник/iu.test(reply), `the rules copy is rung 2: ${reply}`);
  assert.ok(!/зошто|затоа што трошокот|објаснување/iu.test(reply),
    `the why-explanation must not replace the rung: ${reply}`);
  assert.equal(s.state, 'closing', 'rung 2 stays at the fee question');

  offlineMap.close();
});
