// THE [23:00] CAPTURE — a place the client never named became the geography.
//
//   [23:00] GLEDAV EDEN STAN KAJ VAS NA SAJT KAJ SJO
//   [23:00] TROSOBEN MISLAM DEKA BESE
//   [23:01] ZA PRODAVANJE BESE , AMA NE GO ZAPISAV BROJOT
//   [23:01] ЛИНА: «Разбрав — значи баравте стан во близина на Жито (Капиштец)…»
//                  Евидентен број 51 — трисобен стан, во Водно …
//                  Евидентен број 78 — трисобен стан, во Капиштец …
//
// Nobody said Жито. Nobody said Капиштец. Two seams had to fail for that:
//
//  1. The wish extractor's tail floor was FOUR characters, so the client's
//     institution — «СЈО» — could never be captured. What survived was the
//     grammar tail «ВАС НА САЈТ» (the website), trimmed to «САЈТ».
//  2. The map's fuzzy lookup answered «сајт» with the bakery «Жито» (and a bare
//     «стан» with «Станица Парк»): a single everyday word is not a venue, but
//     nothing said so.
//  3. With the anchor at Жито, the AREA derivation compared areas word-by-word,
//     so the map's quarter «Карпош 1» «matched» a feed row tagged «Карпош III»
//     and the district shown was one nobody had mentioned either.
//
// The client's own place is the geography: СЈО is in Центар, the nine Центар
// rows sit within 700 m of it, and those are the flats he must be offered.
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
import { setLearnedBank } from '../src/data/responseBank';
import { extractPoiWishCandidates } from '../src/llm/deterministic';

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

// ── 1. THE EXTRACTOR — a three-letter institution is a place -----------------

test('extractPoiWishCandidates: «кај СЈО» survives after the website tail', () => {
  const cands = extractPoiWishCandidates('GLEDAV EDEN STAN KAJ VAS NA SAJT KAJ SJO', { withCriteria: true });
  assert.ok(cands.includes('сјо'), `the client's own place must be a candidate: ${JSON.stringify(cands)}`);
});

test('extractPoiWishCandidates: other acronyms and short tails are captured too', () => {
  // The candidate keeps the script it was read in — the raw pass keeps the
  // client's Latin, the folded pass hands the map Cyrillic. Either is a place.
  for (const [text, want] of [
    ['stan kaj UJP', ['UJP', 'ујп', 'УЈП']],
    ['kukja do GOB', ['GOB', 'гоб', 'ГОБ']],
    ['СТАН КАЈ УЈП', ['УЈП', 'UJP', 'ујп']],
  ] as const) {
    const c = extractPoiWishCandidates(text, { withCriteria: true });
    assert.ok(c.some(x => (want as readonly string[]).includes(x)),
      `${text} → ${JSON.stringify(c)} must carry one of ${JSON.stringify(want)}`);
  }
});

// ── 2. THE MAP — an everyday word is never a venue ---------------------------

test('the map refuses single generic words instead of fuzzing them onto businesses', () => {
  const m = map();
  assert.equal(m.findPoiByName('сајт'), undefined, '«сајт» is a website, not a bakery');
  assert.equal(m.findPoiByName('страницата'), undefined);
  assert.equal(m.findPoiByName('стан'), undefined, '«стан» is the listing, not «Станица Парк»');
  assert.equal(m.findPoiByName('станот'), undefined);
  assert.equal(m.findPoiByNameLoose('сајт'), undefined, 'the typo pass must not rescue it either');
  assert.equal(m.findPoiByNameLoose('стан'), undefined);
  // …while the places themselves still resolve, in both scripts and lengths.
  assert.equal(m.findPoiByName('сјо')?.name, 'СЈО - Специјално Јавно Обвинителство');
  assert.equal(m.findPoiByName('SJO')?.name, 'СЈО - Специјално Јавно Обвинителство');
  assert.ok(m.findPoiByName('жито')?.name, 'a real place named Жито still resolves');
  // A multi-word needle is untouched by the veto.
  assert.ok(m.findPoiByName('Жито Маркет')?.name);
});

// ── 3. THE TURN — the client's place, and only it -----------------------------

// Three-room flats: two in Центар within ~150 m of СЈО (42.001063/21.4137532)
// and one in Капиштец, 1.2 km south, next to the bakery the old run invented.
const C66: Property = {
  eb: 66, id: 66, uuid: 'c66', address: 'Рузвелтова 51', location: 'Центар',
  service: 'buy', price: 137000, bedrooms: 3, sqm: 79, size: '79 м²',
  lat: 42.0018, lon: 21.4142,
} as Property;
const C95: Property = {
  eb: 95, id: 95, uuid: 'c95', address: 'Црвена Вода', location: 'Центар',
  service: 'buy', price: 204000, bedrooms: 3, sqm: 74, size: '74 м²',
  lat: 42.0015, lon: 21.4130,
} as Property;
const K78: Property = {
  eb: 78, id: 78, uuid: 'k78', address: 'Народен Фронт 23', location: 'Капиштец',
  service: 'buy', price: 185000, bedrooms: 3, sqm: 82, size: '82 м²',
  lat: 41.9900, lon: 21.4197,
} as Property;

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://feed-not-used'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(p => p.eb === eb); }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(p => p.id === id); }
  get healthy(): boolean { return true; }
}

function makeHandler(): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps([C66, C95, K78]);
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
  return { handler, sessions, sent };
}

test('«stan kaj vas na sajt kaj SJO» serves the СЈО flats — never Жито / Капиштец', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'sjo';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  let s = await send('GLEDAV EDEN STAN KAJ VAS NA SAJT KAJ SJO');
  assert.equal(s.slots.poiAnchor, 'СЈО - Специјално Јавно Обвинителство',
    `the anchor is the place the client named: ${JSON.stringify(s.slots)}`);
  assert.equal(s.slots.location, 'Центар', `and its district (СЈО is in Центар): ${s.slots.location}`);
  for (const r of sent) {
    assert.ok(!/Жито/iu.test(r), `never a place nobody named: ${r}`);
    assert.ok(!/Капиштец/iu.test(r), `never a place nobody named: ${r}`);
  }

  s = await send('TROSOBEN MISLAM DEKA BESE');
  const reply = sent.at(-1) ?? '';
  assert.match(reply, /СЈО/u, `the answer names the client's own place: ${reply}`);
  assert.match(reply, /Евидентен број 66/u, `the Центар three-room at the place serves: ${reply}`);
  assert.ok(!/Евидентен број 78/u.test(reply), `the Капиштец flat must not serve: ${reply}`);
  assert.ok(!/Жито|Капиштец/u.test(reply), `no invented geography anywhere: ${reply}`);
  assert.equal(s.slots.service, undefined);

  s = await send('ZA PRODAVANJE BESE , AMA NE GO ZAPISAV BROJOT');
  const last = sent.at(-1) ?? '';
  assert.equal(s.slots.service, 'buy', 'the sale is recorded');
  assert.ok(!/Жито|Капиштец/u.test(last), `still no invented geography: ${last}`);
  assert.match(last, /СЈО/u, `still the client's place: ${last}`);
});
