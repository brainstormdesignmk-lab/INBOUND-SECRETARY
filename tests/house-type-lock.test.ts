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

// THE [18:51] V16K11 CAPTURE — the SAME request in ONE message.
//
//   GLEDAV KAJ VAS NA SAJT EDNA KUKJA ZA IZDAVANJE OKOLU UNIVERZALNA
//   DALI SE IZDAVA USTE TOA ?
//   ЛИНА: Имам три недвижности близу Универзална Сала:
//           • ЕБ 76 · гарсоњера …   • ЕБ 70 · двособен стан …   • ЕБ 50 · куќа …
//
// The type lock above is installed from the SESSION at the top of the turn, so
// the two-message shape worked (the house had landed in the slots on the turn
// before). A client who types both sentences at once — the TUI joins a burst
// into ONE message — had nothing in the slots yet, the lock was empty, and the
// batch served every category again. The type in THIS message must reach the
// turn's lock, and it must be remembered for the turns after it.
// The live [18:51] feed around Универзална Сала: the client's house (50), a
// second rental house (52) so the place can hold an ambiguous house set, the
// гapсоњера 76 and the двособен 70 he was shown by mistake.
const LIVE_ROWS: Property[] = [
  { eb: 76, id: 76, uuid: 'live-76', address: 'Ул. Б', location: 'Центар', lat: 41.9992, lon: 21.4165, geo_source: 'google_cached', service: 'rent', price: 200, sqm: 24, size: '24 м²', studio: true, details: 'Гарсоњера, греење на струја, наместен.' } as Property,
  { eb: 70, id: 70, uuid: 'live-70', address: 'Ул. Ц', location: 'Центар', lat: 41.9986, lon: 21.4170, geo_source: 'google_cached', service: 'rent', price: 350, bedrooms: 2, sqm: 39, size: '39 м²', details: 'Двособен стан, лифт, парно, на 3 кат.' } as Property,
  { eb: 50, id: 50, uuid: 'live-50', address: 'Христо Смирненски 41', location: 'Центар', lat: 41.9962, lon: 21.4147, geo_source: 'google_cached', service: 'rent', price: 300, house: true, bedrooms: 2, sqm: 74, size: '74 м²', features: ['двор', 'тераса'], details: 'Помеѓу Универзална сала и Треска, се издава стан во вид на двоспратна галерија.' } as Property,
  { eb: 52, id: 52, uuid: 'live-52', address: 'Ул. Д', location: 'Центар', lat: 41.9980, lon: 21.4175, geo_source: 'google_cached', service: 'rent', price: 380, house: true, sqm: 90, size: '90 м²', details: 'Куќа за издавање, двор.' } as Property,
];

const LIVE_ASK = 'GLEDAV KAJ VAS NA SAJT EDNA KUKJA ZA IZDAVANJE OKOLU UNIVERZALNA\n\nDALI SE IZDAVA USTE TOA ?';

test('[18:51] the category in the SAME message as the availability ask locks the batch', async () => {
  const { handler, sessions, sent } = makeHandler(LIVE_ROWS);
  const chatId = 'house-lock-one-message';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, LIVE_ASK);

  const session = sessions.get(chatId)!;
  const reply = sent[sent.length - 1]!;
  assert.equal(session.slots.house, true, `the type he named is remembered: ${reply}`);
  assert.match(reply, /Универзална/iu, `the place he named is confirmed back: ${reply}`);
  // ONLY HOUSES ARE OFFERED AT THE PLACE — a гарсоњера and a двособен are not
  // candidates for a house he saw, in either script of the card line.
  assert.ok(!/Евидентен број 76/u.test(reply), `never the гapсоњера: ${reply}`);
  assert.ok(!/Евидентен број 70/u.test(reply), `never the двособен: ${reply}`);
  assert.ok(/Евидентен број 50|Евидентен број 52/u.test(reply),
    `the houses at the place answer him: ${reply}`);
});

// …AND THE LOCK IS NOT FOREVER: the owner's rule is "the type he chose, until he
// asks for another one". A client who moves on to flats may be served flats.
test('[18:51] an explicit flat ask releases the house lock', async () => {
  const { handler, sessions } = makeHandler(LIVE_ROWS);
  const chatId = 'house-lock-release';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, LIVE_ASK);
  assert.equal(sessions.get(chatId)!.slots.house, true);

  await handler.handle('test', chatId, 'A STAN IMATE ?');
  const s = sessions.get(chatId)!;
  assert.deepEqual(s.slots.flat, true, 'the flat he asks for is the type now');
  assert.equal(s.slots.house, false, 'the house lock is released, not made permanent');
});

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

// THE STUDIO IDENTITY OF A SERVE: a гapсоњера ask serves the STUDIOS and only
// studios — the feed flag, «гарсоњер» in the ad, or a LEGACY row small enough to
// be one — and never a двособен of the same price band. This pins the POSITIVE
// side (all three studio shapes answer, the flat never appears); the negative
// case that put a трисобен beside the гapсоњера is the [04:04] capture fixture
// (tests/fixtures/transcripts/0404-embasada-prodva.txt), which fails on the old
// loose arm (`!house && !business && !plac`) — that arm is where the client's
// recall of his гapсоњера came back as «која од двете е таа?».
const STUDIO_ROWS: Property[] = [
  { eb: 90, id: 90, uuid: 's-90', address: 'Ул. Е', location: 'Центар', service: 'rent', price: 200, studio: true, sqm: 24, size: '24 м²' } as Property,
  { eb: 91, id: 91, uuid: 's-91', address: 'Ул. Ж', location: 'Центар', service: 'rent', price: 210, sqm: 28, size: '28 м²', details: 'Гарсоњера, наместена, греење на струја.' } as Property,
  { eb: 92, id: 92, uuid: 's-92', address: 'Ул. З', location: 'Центар', service: 'rent', price: 220, sqm: 30, size: '30 м²' } as Property,
  { eb: 93, id: 93, uuid: 's-93', address: 'Ул. И', location: 'Центар', service: 'rent', price: 290, bedrooms: 2, sqm: 45, size: '45 м²', details: 'Двособен стан, лифт.' } as Property,   // closest to the budget — the loose arm served it FIRST
];

test('a гapсоњера ask serves studios only — flag, ad text or legacy small row, never a двособен', async () => {
  const { handler, sessions, sent } = makeHandler(STUDIO_ROWS);
  const chatId = 'studio-lock';
  sessions.set(freshSession('test', chatId));

  await handler.handle('test', chatId, 'SAKAM DA IZNAJMAM GARSONJERA VO CENTAR DO 300 EVRA');

  const session = sessions.get(chatId)!;
  assert.equal(session.slots.garsonjera, true, 'the studio ask is remembered');
  const everything = sent.join('\n');
  assert.ok(!cardEbs(everything).includes(93),
    `a двособен is not a гapсоњера: ${everything}`);
  assert.ok(cardEbs(everything).some(eb => eb === 90 || eb === 91 || eb === 92),
    `a studio answers (flagged, ad-text or legacy small row): ${everything}`);

  // THE LOCK, not the one search: the NEXT turn inherits the studio category, so
  // the двособен closest to the budget (290 of 300) must still never ride in.
  const before = sent.length;
  await handler.handle('test', chatId, 'DRUGI GARSONJERI IMATE ?');
  const second = sent.slice(before).join('\n');
  assert.ok(!cardEbs(second).includes(93), `still no двособен: ${second}`);
});
