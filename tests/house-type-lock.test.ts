// THE [20:37–20:38] CAPTURE — a HOUSE recall answered with a STUDIO.
//
//   [20:37] VIDOV EDNA KUKJA STO SE IZDAVASE KAJ UNIVERZALNA KAJ VAS PRED NEKOE VREME.
//   [20:38] DALI E SLOBODNA , IMASE EFTINA KIRIJA ?
//   [20:38] ЛИНА: Имам три недвижности близу Универзална Сала:
//             • Евидентен број 76 · гарсоњера, 24 м² · 200 евра месечно …   ✗
//
// The client declared a TYPE (куќа, rented). The batch served a гарсоњера — a
// different category entirely. The owner's rule: once a type is chosen
// (куќа / деловен простор / плац / гарсоњера) ONLY that type may be served; a
// generic ask with no type still sees everything.
//
// THE FIX IS A LOCK, NOT A LANE PATCH: the type lives in the session slots and
// is installed on the data service for the turn (PropertyService.setTypeLock),
// so candidates()/closestMatches()/search() filter by it for EVERY lane —
// present and future — unless the caller states a type of its own.
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
import { setLearnedBank } from '../src/data/responseBank';
import { buildPropertyCard } from '../src/llm/prompts';

setLearnedBank({
  variants: () => [], addVariant: () => false, addExample: () => false,
  metric: () => {}, retrieve: () => undefined,
} as any);

const cfg = loadConfig();
let offlineMap: OfflineMapStore | undefined;
const map = (): OfflineMapStore => (offlineMap ??= new OfflineMapStore(cfg.skopjePoisDb));

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://feed-not-used'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(p => p.eb === eb); }
  get healthy(): boolean { return true; }
}

// Pins near Универзална Сала (Центар).
const HOUSE: Property = {
  eb: 70, id: 70, uuid: 'house-70', address: 'УЛ. А', location: 'Центар',
  lat: 41.9975, lon: 21.4258, geo_source: 'google_cached',
  service: 'rent', price: 450, house: true, sqm: 120, size: '120 м²',
  details: 'Се издава куќа',
} as Property;
const STUDIO: Property = {
  eb: 76, id: 76, uuid: 'studio-76', address: 'УЛ. Б', location: 'Центар',
  lat: 41.9971, lon: 21.4252, geo_source: 'google_cached',
  service: 'rent', price: 200, sqm: 24, size: '24 м²', studio: true,
  details: 'Гарсоњера за издавање',
} as Property;
const FLAT: Property = {
  eb: 77, id: 77, uuid: 'flat-77', address: 'УЛ. В', location: 'Центар',
  lat: 41.9990, lon: 21.4270, geo_source: 'google_cached',
  service: 'rent', price: 300, bedrooms: 2, sqm: 60, size: '60 м²',
} as Property;
const OFFICE: Property = {
  eb: 57, id: 57, uuid: 'office-57', address: 'УЛ. Г', location: 'Центар',
  lat: 41.9978, lon: 21.4262, geo_source: 'google_cached',
  service: 'rent', price: 900, business: true, sqm: 45, size: '45 м²',
} as Property;
const PLOT: Property = {
  eb: 50, id: 50, uuid: 'plot-50', address: 'УЛ. Д', location: 'Центар',
  lat: 41.9972, lon: 21.4268, geo_source: 'google_cached',
  service: 'buy', price: 60000, plac: true, sqm: 600, size: '600 м²',
} as Property;

const ROWS = [HOUSE, STUDIO, FLAT, OFFICE, PLOT];
const ebs = (rows: Property[]): number[] => rows.map(p => p.eb).sort((a, b) => a - b);

function makeHandler(rows: Property[]): { props: FakeProps; handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps(rows);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions,
    classifier: new Classifier(llm, cfg, props),
    responder: new Responder(llm, cfg),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: map() }),
  });
  return { props, handler, sessions, sent };
}

// ── 1. THE LOCK ITSELF (data layer, every pool builder) ─────────────────────

test('the category lock filters EVERY pool builder — candidates, closestMatches, search', async () => {
  const { props } = makeHandler(ROWS);
  // No lock: a generic ask sees every category.
  assert.deepEqual(ebs(await props.candidates({})), [50, 57, 70, 76, 77]);
  assert.deepEqual(ebs(await props.search({})), [50, 57, 70, 76, 77]);

  props.setTypeLock(p => p.house === true);
  assert.deepEqual(ebs(await props.candidates({})), [70], 'candidates: a house ask sees houses only');
  assert.deepEqual(ebs(await props.closestMatches({})), [70], 'closestMatches: same lock');
  assert.deepEqual(ebs(await props.search({})), [70], 'search: same lock');
  // A caller that states its OWN type is authoritative (never narrowed twice).
  assert.deepEqual(ebs(await props.candidates({ business: true })), [57]);
  assert.deepEqual(ebs(await props.closestMatches({ plac: true })), [50]);

  // The lock clears for a generic turn — the type is a choice, not a life sentence.
  props.setTypeLock(undefined);
  assert.deepEqual(ebs(await props.candidates({})), [50, 57, 70, 76, 77]);
});

// ── 1b. THE CARD MUST NOT CALL A HOUSE A «СТАН» (the [20:41] capture) ────────
//
//   ЛИНА: «Куќата под Евидентен број 50 е во Центар. … Помеѓу Универзална
//          сала и Треска, стан во вид на двоспратна галерија …»
//
// The ad text says «стан»; the ROW is a house. The card cannot open with one
// category and quote the other in the same breath.
test('a house/plot/office card never echoes the ad calling it a flat', () => {
  const houseRow = { ...HOUSE, details: 'Помеѓу Универзална сала и Треска, стан во вид на двоспратна галерија. Станот има двор и тераса.' } as Property;
  const card = buildPropertyCard(houseRow);
  assert.match(card, /Куќата под Евидентен број 70/u, card);
  assert.match(card, /куќа во вид на двоспратна галерија/u, `the ad's noun follows the row: ${card}`);
  assert.match(card, /Куќата има двор и тераса/u, card);
  assert.doesNotMatch(card, /(?<![\p{L}\p{N}])стан(?![\p{L}\p{N}])/iu, `no bare «стан» in a house card: ${card}`);
  // The legitimate «станбена површина» keeps its own word — it is a different
  // word, not the category noun.
  assert.match(card, /станбена површина/u, card);

  const officeRow = { ...OFFICE, details: 'Се издава стан со две простории, погоден за канцеларија.' } as Property;
  const officeCard = buildPropertyCard(officeRow);
  // The «се издава стан» opener is stripped as AD COPY before the noun swap runs,
  // so what matters here is the contract, not the sentence shape: an office card
  // never carries the word «стан», and the fact itself survives.
  assert.match(officeCard, /Со две простории, погоден за канцеларија/u, `office card: ${officeCard}`);
  assert.doesNotMatch(officeCard, /(?<![\p{L}\p{N}])стан(?![\p{L}\p{N}])/iu, officeCard);

  const plotRow = { ...PLOT, details: 'Станот е урнат, плацот е чист и рамен.' } as Property;
  const plotCard = buildPropertyCard(plotRow);
  assert.match(plotCard, /Плацот е урнат/u, `plot card: ${plotCard}`);
  assert.doesNotMatch(plotCard, /(?<![\p{L}\p{N}])стан(?![\p{L}\p{N}])/iu, plotCard);

  // A FLAT row keeps its own noun untouched.
  const flatCard = buildPropertyCard({ ...FLAT, details: 'Светол стан со две спални.' } as Property);
  assert.match(flatCard, /Светол стан со две спални/u, `flat card unchanged: ${flatCard}`);
});

// ── 2. THE CAPTURE, THROUGH THE HANDLER ─────────────────────────────────────

const cardEbs = (text: string): number[] =>
  [...text.matchAll(/Евидентен број (\d+)/gu)].map(m => parseInt(m[1], 10));

test('a house recall near a place never serves a studio, an office or a plot', async () => {
  const { handler, sessions, sent } = makeHandler(ROWS);
  const chatId = 'house-lock';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'ZDRAVO');
  await handler.handle('test', chatId, 'VIDOV EDNA KUKJA STO SE IZDAVASE KAJ UNIVERZALNA KAJ VAS PRED NEKOE VREME.');
  await handler.handle('test', chatId, 'DALI E SLOBODNA , IMASE EFTINA KIRIJA ?');

  const session = sessions.get(chatId)!;
  assert.equal(session.slots.house, true, 'the type he named is the one the funnel holds');
  const everything = sent.join('\n');
  for (const eb of [76, 57, 50]) {
    assert.ok(!cardEbs(everything).includes(eb),
      `EB ${eb} is another category and must never be served: ${everything}`);
  }
});
