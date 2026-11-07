/**
 * THE [00:26]–[00:39] CAPTURE — four defects, one conversation.
 *
 *   [00:26] IMAS POSKAPO ?          → «Разбира се — еве нешто поскапо …»
 *     The idiom is impersonal in Macedonian: «Се разбира». The Serbian calque
 *     (`razbira se`) shipped in the seed pool and read as broken language.
 *
 *   [00:31] СОПСТВЕНИК: NEMA DA MOZAM . SLOBODEN SUM OD 6 VO SREDA AKO ODGOVARA
 *     → «Среда, 11.11.2026 — било кое време му одговара.»
 *     «од 6» is a clock («free FROM 18:00»). The owner parser knew во/по/после/
 *     околу but not the from-prefix, so the day read as clock-free AND the
 *     refusal in the same message made it a WHOLE-DAY counter — the hour the
 *     owner named never reached the client.
 *
 *   [00:36] MOZE I DA IZNAJMAM , A MOZE I DA KUPAM ZAVISI
 *           → «1. Кој тип …? 2. Во која населба или дел од градот …?»
 *   [00:37] DUKJAN MI TREBA
 *           → a pair, with NO area ever named by the client.
 *     The ask and the serve disagreed about what answers the LOCATION and the
 *     MARKET question: `buildDiscoveryAsk` refuses a city-level «Скопје» (a
 *     slot the classifier infers, never the client's word) and a market pinned
 *     off a served row, while the serve accepted both. One reader now.
 *
 *   [00:39] NESTO OKOLU BUNJAKOVEC IMA ?
 *           → «Недвижноста се наоѓа во населбата Центар. Точната адреса …»
 *     Two causes: the place extractor's greedy tail swallowed the ask verb
 *     («БУЊАКОВЕЦ ИМА» never resolved to the map's Буњаковец), and the nearby
 *     lane answers any «…има?» about the anchored flat. A place-anchored stock
 *     ask is a SEARCH at that place.
 *
 *   [00:37] also: a complete criteria set answered «Во ред, ги забележав Вашите
 *     критериуми.» — a spec sheet with no property and no question.
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
import { extractPoiWishCandidates, detectOwnerVerdict } from '../src/llm/deterministic';
import { locationCriterionKnown, serviceCriterionKnown } from '../src/llm/prompts';
import { FIXED_SEEDS } from '../src/data/responseBank';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

/** Every row stands in the offline map: a house ~50 m from Буњаковец's pin,
 *  the [00:37] shops in Центар, and a far bird in the same quarter. */
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(p => p.id === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(p => p.eb === eb); }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 50, id: 50, location: 'Центар', price: 250, service: 'rent', sqm: 74, size: '74 м²',
    house: true, lat: 41.9978, lon: 21.4184, details: 'Куќа со двор кај Буњаковец.' } as Property,
  { eb: 56, id: 56, location: 'Центар', price: 500, service: 'rent', sqm: 40, size: '40 м²',
    business: true, lat: 41.9966, lon: 21.4192, details: 'Деловен простор во Центар.' } as Property,
  { eb: 59, id: 59, location: 'Центар', price: 950, service: 'rent', sqm: 105, size: '105 м²',
    business: true, lat: 41.9955, lon: 21.4162, details: 'Деловен простор во Палома Бјанка.' } as Property,
  { eb: 76, id: 76, location: 'Центар', price: 200, service: 'rent', sqm: 24, size: '24 м²',
    studio: true, lat: 41.9955, lon: 21.4182, details: 'Гарсоњера.' } as Property,
];

function makeHandler(chatId = 'cap0039') {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(ROWS),
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  });
  const say = async (m: string): Promise<string> => {
    const before = sent.length;
    await handler.handle('test', chatId, m);
    return sent.slice(before).join('\n');
  };
  return { say, sessions, chatId };
}

// ── [00:26] the idiom ───────────────────────────────────────────────────────

test('[00:26] the upward intro speaks «Се разбира», never the Serbian calque', () => {
  const seeds = FIXED_SEEDS['pricier.search.intro'] ?? [];
  assert.ok(seeds.length >= 2, 'the pricier intro pool is missing');
  for (const v of seeds) {
    assert.ok(!/Разбира се/iu.test(v), `the calque shipped again: ${v}`);
  }
  assert.ok(seeds.some(v => /^\s*Се разбира/iu.test(v)), 'the impersonal form is the seed');
});

// ── [00:31] the owner's from-clock ──────────────────────────────────────────

test('[00:31] «SLOBODEN SUM OD 6 VO SREDA» is a fixed 18:00 counter', () => {
  const v = detectOwnerVerdict('NEMA DA MOZAM . SLOBODEN SUM OD 6 VO SREDA AKO ODGOVARA', 'Понеделник во 17:00');
  assert.ok(v, 'the owner text must parse');
  assert.equal(v.status, 'counter');
  assert.equal(v.canAcceptWholeDay, undefined,
    `a named hour is a FIXED counter, not a whole day: ${JSON.stringify(v)}`);
  assert.match(v.ownerTime ?? '', /18:00/,
    `«од 6» resolves to the 18:00 window: ${JSON.stringify(v)}`);
});

// ── [00:36] one reader for the criteria ─────────────────────────────────────

test('[00:36] a city-level or inferred criterion never completes the funnel', () => {
  // What the CLIENT said answers. An inferred market or the city name does not.
  assert.equal(locationCriterionKnown({ location: 'Центар' } as any), true);
  assert.equal(locationCriterionKnown({ location: 'Скопје' } as any), false,
    'a city-level slot is not an area answer');
  assert.equal(locationCriterionKnown({ poiAnchor: 'Буњаковец' } as any), true,
    'a named landmark IS the area answer');
  assert.equal(locationCriterionKnown({ anywhere: true } as any), true);
  assert.equal(serviceCriterionKnown({ service: 'rent' } as any), true);
  assert.equal(serviceCriterionKnown({ service: 'rent', serviceInferred: true } as any), false,
    "a market pinned off a served row is not the client's declaration");
  assert.equal(serviceCriterionKnown({ service: 'rent', dualService: true } as any), true,
    'a dual choice answers it');
});

test('[00:36] e2e: the type answer re-asks the AREA, it does not serve blind', async () => {
  const { say } = makeHandler('type-then-area');
  await say('MOZE I DA IZNAJMAM , A MOZE I DA KUPAM ZAVISI');
  // The classifier puts the city itself in the location slot — that is not an answer.
  const answer = await say('DUKJAN MI TREBA');
  // Bank variants rotate («населба», «дел од градот», «локација во градот») —
  // the contract is that the AREA is asked, not one wording of it.
  assert.match(answer, /населба|дел од градот|локација во градот/iu,
    `the area is still owed and must be asked: ${answer}`);
  assert.doesNotMatch(answer, /Евидентен број/iu,
    `a pair served with no area named: ${answer}`);
});

// ── [00:39] the place ask ───────────────────────────────────────────────────

test('[00:39] the ask verb never rides the place name', () => {
  for (const t of ['NESTO OKOLU BUNJAKOVEC IMA ?', 'NESTO KAJ BUNJAKOVEC IMA?',
                   'STO IMATE OKOLU BUNJAKOVEC ?', 'DALI IMATE NESTO KAJ BUNJAKOVEC?']) {
    const wish = extractPoiWishCandidates(t, { withCriteria: true });
    assert.ok(wish.some(w => /буњаковец/i.test(w)),
      `the town's name must survive the tail: ${t} → ${JSON.stringify(wish)}`);
    assert.ok(!wish.some(w => /\bима/i.test(w)),
      `the ask verb is grammar, not a name: ${t} → ${JSON.stringify(wish)}`);
  }
});

test('[00:39] «NESTO OKOLU BUNJAKOVEC IMA ?» searches there, never the flat\'s address', async () => {
  const { say, sessions, chatId } = makeHandler('bunjakovec-ask');
  await say('ZDRAVO , STO IMATE INTERESNO KAJ BUNJAKOVEC ?');
  await say('ZA IZNAJMUVANJE SUM');
  await say('MISLAM DEKA BESE 50'); // the flat under discussion — the trap
  const answer = await say('NESTO OKOLU BUNJAKOVEC IMA ?');
  assert.doesNotMatch(answer, /Точната адреса ќе ја добиете/iu,
    `the where-is line answered a stock ask: ${answer}`);
  const s = sessions.get(chatId)!;
  assert.match(s.slots.poiAnchor ?? '', /Буњаковец/iu,
    `the named place is the anchor: ${s.slots.poiAnchor}`);
  assert.equal(s.slots.propertyId, undefined,
    `the flat on the table is no longer the subject: ${s.slots.propertyId}`);
  assert.match(answer, /деловен|стан|куќа|плац|Евидентен/iu,
    `the answer speaks properties: ${answer}`);
});

// ── [00:37] never a spec sheet ──────────────────────────────────────────────

test('[00:37] a complete criteria set SERVES (or says there is none), never «ги забележав»', async () => {
  const { say, sessions, chatId } = makeHandler('spec-sheet');
  await say('MI TREBA DUKJAN VO CENTAR OKO 80 M2 DO 1000 EVRA');
  const answer = await say('ZA IZNAJMUVANJE'); // the last missing criterion
  assert.ok(!!sessions.get(chatId)!.slots.sqm, 'fixture: the size is in');
  assert.doesNotMatch(answer, /ги забележав Вашите критериуми/iu,
    `the spec sheet shipped as the whole reply: ${answer}`);
  assert.match(answer, /Евидентен број|немам/iu,
    `the pair or the honest no-stock line is owed: ${answer}`);
  assert.match(answer, /Дали/u, `a question keeps the funnel moving: ${answer}`);
});
