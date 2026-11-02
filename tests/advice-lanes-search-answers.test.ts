/**
 * THE ADVICE-LANE FAMILY — a SEARCH is never answered by an advice script.
 *
 * The [22:34] capture (see tests/area-named-in-search.test.ts) had the
 * neighborhood-advice lane claim a completed search because the bare word
 * «реон» appeared in it. The same shape lived in three more lanes, found by
 * sweeping every early-funnel advice detector with search answers:
 *
 *   MORTGAGE_ASK   «sakam stan so kredit do 90000 vo aerodrom»   → the financing script
 *                  «baram stan vo blizina na banka do 80000»     → a bank BRANCH is a place
 *   DOCUMENTS_ASK  «sakam kukja do 150000, dokumentite ke gi gledame podocna» → the paperwork lecture
 *                  «sakam stan vo aerodrom, ne mi treba dokumenti sega»      → a NEGATED mention
 *   OFFTOPIC       «sakam stan do 100000 vo aerodrom, koj e podobro da znam»  → the small-talk redirect
 *
 * The contract pinned here: a message that carries search specs (rooms, м²,
 * money, category) and asks no question belongs to the FUNNEL. An actual
 * question about financing/paperwork/areas keeps its lane, and a negated
 * mention never flips a lane on.
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
import { EnrichmentStore } from '../src/store/enrichment';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { dispatchSimple, resolveIntent, SIMPLE_DETECTORS } from '../src/handlers/router';
import {
  detectMortgageAsk, detectDocumentsAsk, detectOfftopic, detectNeighborhoodAsk,
  detectComparison, detectDefer, detectNegotiate, detectFeatureAsk,
  detectPriceEval, detectSeeOffers,
  ADVICE_GATES, adviceLaneAdmits,
} from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

test('search answers are never claimed by an advice lane', () => {
  // Financing mentions inside a search: the client wants flats.
  assert.equal(detectMortgageAsk('SAKAM STAN SO KREDIT DO 90000 VO AERODROM'), false,
    '«so kredit» is a financing preference on a search, not a financing question');
  assert.equal(detectMortgageAsk('BARAM STAN DO 80000 VO CENTAR, MOZE I SO KREDIT'), false);
  // A bank is also a PLACE: the preposition decides.
  assert.equal(detectMortgageAsk('BARAM STAN VO BLIZINA NA BANKA DO 80000'), false,
    '«во близина на банка» is geography');
  assert.equal(detectMortgageAsk('BARAM LOKAL SO 40 M2 VO REGION NA BANKA'), false);
  // Paperwork mentioned in passing — including a NEGATED need.
  assert.equal(detectDocumentsAsk('SAKAM KUKJA DO 150000, DOKUMENTITE KE GI GLEDAME PODOCNA'), false);
  assert.equal(detectDocumentsAsk('SAKAM STAN VO AERODROM, NE MI TREBA DOKUMENTI SEGA'), false,
    'a negated documents mention is not a documents ask');
  // Small talk mixed into a search.
  assert.equal(detectOfftopic('SAKAM STAN DO 100000 VO AERODROM, KOJ E PODOBRO DA ZNAM'), false);
  // The area lane from the [22:34] capture stays fixed in the same sweep.
  assert.equal(detectNeighborhoodAsk('dvosoben stan do 100000 vo reon kaj biser i kapitol mol'), false);
  // …and none of them is reachable through the pre-classifier dispatch either.
  for (const text of [
    'SAKAM STAN SO KREDIT DO 90000 VO AERODROM',
    'BARAM STAN VO BLIZINA NA BANKA DO 80000',
    'SAKAM KUKJA DO 150000, DOKUMENTITE KE GI GLEDAME PODOCNA',
  ]) {
    assert.equal(dispatchSimple(text, 'discovery'), undefined, `no advice lane for: ${text}`);
  }
});

test('search instructions are not comparison, defer or negotiation', () => {
  // The rest of the pre-classifier sweep: a request verb + specs + a type/area
  // is the funnel asking for ROWS — all three lanes were answering it.
  const searches = [
    'sakam stan podobar od ovoj do 95000 vo aerodrom',
    'ke se javam podocna, baram stan do 80000 vo aerodrom',
    'daj mi poevtino stan do 70000 vo karpos',
    'sakam stan so popust do 80000',
    'sakam stan do 90000, moze da go gledam vikend',
    'baram stan do 80000, ke go gledam posle 17 saat',
    'daj mi poevtino do 70000 vo karpos',
  ];
  for (const text of searches) {
    assert.equal(detectComparison(text), false, `comparison claimed a search: ${text}`);
    assert.equal(detectDefer(text), false, `defer claimed a search: ${text}`);
    assert.equal(detectNegotiate(text), false, `negotiate claimed a search: ${text}`);
    assert.equal(dispatchSimple(text, 'presentation'), undefined, `advice lane claimed a search: ${text}`);
  }
  // Genuine lane traffic keeps its lane: no specs ⇒ still an eval/defer/negotiation.
  assert.equal(detectComparison('KOE E PODOBRO, OVA ILI ONAA?'), true);
  assert.equal(detectDefer('KE RAZMISLAM POTOA'), true);
  assert.equal(detectNegotiate('MOZE LI POMALA CENA?'), true);
  assert.equal(detectNegotiate('DALI MOZE ZA 140000?'), true);
  // …and a cheaper ask with no type/area/specs stays a negotiation.
  assert.equal(detectNegotiate('DALI IMA POPUST?'), true);
});

test('genuine advice questions keep their lanes', () => {
  // Financing ASKS survive — with and without a property in the sentence.
  assert.equal(detectMortgageAsk('DALI MOZE SO KREDIT ZA STAN?'), true);
  assert.equal(detectMortgageAsk('SAKAM KREDIT OD BANKA'), true, '«od banka» is financing, not a place');
  // Paperwork ASKS survive, including one phrased as a question about NOT
  // having documents («ne treba li…?» is still an ask).
  assert.equal(detectDocumentsAsk('KAKVI DOKUMENTI TREBAAT ZA KUPUVANJE?'), true);
  assert.equal(detectDocumentsAsk('NE TREBA LI DA NOSAM DOKUMENTI?'), true);
  // Small talk without criteria still redirects.
  assert.equal(detectOfftopic('KAKO SI ?'), true);
});

const ROWS: Property[] = [
  { eb: 701, id: 701, location: 'Аеродром', address: 'Ул. Јане Сандански 20', price: 86000, bedrooms: 2, sqm: 55, size: '55 м²', service: 'buy' },
  { eb: 702, id: 702, location: 'Аеродром', address: 'Ул. Јане Сандански 44', price: 89000, bedrooms: 2, sqm: 58, size: '58 м²', service: 'buy' },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
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
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  return { handler, sessions, sent, chatId: id };
}

test('a search with a mortgage preference reaches the funnel, never the financing script', async () => {
  const { handler, sent, chatId } = makeHandler('mortgage-search');
  await handler.handle('test', chatId, 'sakam da kupam stan so kredit do 90000 vo aerodrom');
  const reply = sent.at(-1) ?? '';
  assert.doesNotMatch(reply, /кредит|банка|хипотека|каматн|рата|главница/iu,
    `the financing script must not answer a search: ${reply}`);
  assert.match(reply, /спалн|spaln/iu,
    `the funnel asks its own missing criterion: ${reply}`);
});

test('production route-drift replay: no advice lane claims these captures', () => {
  // Replayed from data/route-drift-2026-10-31.jsonl + -10-30.jsonl (325 unique
  // production texts × every state). Each block names the lane the executor
  // ACTUALLY served in production — the correct owner of that turn.
  // Price-extreme and recommendation asks (OFFTOPIC's optional-pronoun arm):
  for (const t of [
    'KOJ E NAJSKAPIOT STAN VO CENTAR?',                       // PRICE_EXTREME
    'KOJ E NAJEVTINIOT STAN ZA IZNAJMUVANJE VO AERODROM?',    // PRICE_EXTREME
    'KOJ E PODOBAR STAN OD OVIE DVA ?',                       // RECOMMEND_ASK
  ]) {
    assert.equal(detectOfftopic(t), false, `off-topic redirect claims a property ask: ${t}`);
    assert.notEqual(dispatchSimple(t, 'idle')?.intent, 'OFFTOPIC', t);
  }
  // A question about the FLAT's own area (LOCATION_NAG in production):
  assert.equal(detectNeighborhoodAsk('VO KOJA NASELBA E STANOT'), false);
  assert.equal(dispatchSimple('VO KOJA NASELBA E STANOT', 'idle'), undefined);
  // Show-me / raise-the-cap searches (no advice close may own them):
  for (const t of ['POMALO NESTO DO 300EVRA', 'A NESTO POSKAPO DO 1000 EVRA']) {
    assert.equal(detectComparison(t), false, `comparison claims a search: ${t}`);
    assert.notEqual(dispatchSimple(t, 'property_query')?.intent, 'COMPARISON', t);
  }
  // Criteria answers (FEATURE_RE's bare «квадрати»/«спални» arms):
  for (const t of ['40 KVADRATI, DO 500 EVRA', '350 EVRA IMAM', 'DO 500 KVADRATI, IMAM 500000 EVRA BUDJET']) {
    assert.equal(detectFeatureAsk(t), false, `feature lane claims criteria: ${t}`);
  }
  // A recommendation ask is never a price negotiation:
  assert.equal(detectNegotiate('koj stan bi mi go preporacale 54 ili 63 i zosto ?'), false);
  // …and the genuine lanes still fire on their own shapes.
  assert.equal(detectOfftopic('KAKO SI ?'), true);
  assert.equal(detectNeighborhoodAsk('VO KOJA NASELBA IMA NAJDOBRI STANOVI?'), true);
  assert.equal(detectFeatureAsk('DALI IMA TERASA VO STANOT ?'), true);
  assert.equal(detectFeatureAsk('kolku kvadrati ima ?'), true);
});

test('the advice gate is inherited, not re-implemented per lane', () => {
  // ONE policy row per pre-classifier lane. A row is a decision (gated or
  // explicitly exempt), never an accident of code that happens to be missing:
  // the family defect was eight hand-written vetoes that a ninth lane would
  // not have had.
  for (const d of SIMPLE_DETECTORS) {
    assert.ok(ADVICE_GATES[d.intent], `lane ${d.intent} has no ADVICE_GATES row`);
  }

  // AN UNKNOWN INTENT IS DENIED BY DEFAULT — this is the inheritance: a lane
  // added tomorrow with no row and no veto of its own still cannot answer a
  // search. A genuine (spec-free) turn still admits it.
  const search = 'sakam stan do 80000 vo aerodrom';
  assert.equal(adviceLaneAdmits('A_LANE_NOBODY_HAS_WRITTEN_YET', search), false);
  assert.equal(adviceLaneAdmits('A_LANE_NOBODY_HAS_WRITTEN_YET', 'KAKO SI ?'), true);

  // …and dispatchSimple applies it STRUCTURALLY, before the detector runs, so
  // an unguarded lane added to SIMPLE_DETECTORS is covered without edits.
  const fake = {
    intent: 'ZZ_LANE_ADDED_TOMORROW',
    bankKey: 'zz.key',
    fallback: 'zz',
    detect: () => true, // deliberately naive: it knows nothing about searches
  };
  SIMPLE_DETECTORS.push(fake);
  try {
    assert.equal(dispatchSimple(search, 'presentation'), undefined,
      'an unguarded new lane answered a search — the gate is not structural');
    assert.equal(dispatchSimple('QWERTY ZXCV', 'presentation')?.intent, 'ZZ_LANE_ADDED_TOMORROW',
      'the gate must not silence a new lane on ordinary traffic');
  } finally {
    SIMPLE_DETECTORS.pop();
  }

  // An EXEMPT lane keeps its turn even when the message carries specs — the
  // money/hours protocols name amounts by design, so the exemption is real
  // behaviour, not a hole in the sweep.
  assert.equal(
    dispatchSimple('sakam stan do 80000 vo aerodrom, sakam menadzer', 'discovery')?.intent,
    'ESCALATION',
    'a manager request with specs in it is still a manager request');
});

test('the ROUTING_ORDER mirror owns the lanes production served (route-drift replay)', () => {
  // Replayed from data/route-drift-2026-10-3*.jsonl: each text carries the lane
  // production ACTUALLY served. Two of them were missing from the mirror, so it
  // predicted an advice lane instead of the lane that was right:
  assert.equal(resolveIntent('STO IMA VO BLIZINA NA GARSONJERATA KAJ CRNOGORSKA AMBASADA?', 'idle'),
    'NEARBY_ASK', 'production served NEARBY_ASK; the mirror said PROPERTY_DESCRIPTION');
  assert.equal(resolveIntent('IMAVTE EDNA KUKJA NAKAJ AERODROM . OKOLU 130 000 BESE', 'idle'),
    'SEEN_LISTING_RECALL', 'production served SEEN_LISTING_RECALL; the mirror said SURROUNDINGS');

  // A SEARCH IS NOT A PRICE-VALENCE REMARK (the [01:47] capture): «ako ima
  // dobra cena» is the client's CONDITION on a dual-service shop search, not
  // praise for a price on the table. Production served it as an unknown
  // property-price evaluate and the mirror predicted PRICE_EVAL_CHEAP — one
  // step from answering a search with «цената е навистина поволна».
  const dukjan = 'MI TREBA DUKJAN VO CENTAR\nMOZE DA GO IZNAJMAM , A AKO IMA DOBRA CENA MOZE I DA KUPAM';
  assert.equal(detectPriceEval(dukjan), undefined, 'a stock search is not a valence remark');
  assert.notEqual(resolveIntent(dukjan, 'presentation'), 'PRICE_EVAL_CHEAP');
  // A search with a shop noun is a stock search, so the funnel owns it — and a
  // spec search is never an inventory browse either.
  assert.equal(detectSeeOffers('MI TREBA DUKJAN VO CENTAR'), false,
    'a spec search is not an inventory browse');
});
