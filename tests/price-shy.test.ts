// THE 21:38/21:39 TRANSCRIPT — the client complained about the price
// ("mnogu skapa cena ima") and asked for something cheaper in that area
// ("daj nesto poeKtino vo toj reon" — with the ф→к typo). The old behavior:
// the cheaper-ask matched NO detector (only поевтино/поефтино/pojeftino were
// known), so inside the closed funnel it was swallowed by the contact path
// and Lina answered "Да ми го оставите бројот на телефон?" — the phone ask.
// THE CONTRACT:
//   1. Any cheaper-word spelling (poeftino/poeKtino/poftino/pojeftino,
//      поефтино, појефтино…) is a SEARCH: Lina serves REAL cheaper options
//      from the DB (price.shy intro + cheapest-first cards), never a
//      market-opinion excuse and never the contact ask;
//   2. When the area has nothing cheaper, she OFFERS other neighborhoods
//      (price.shy.empty ask) — the widen happens only after the client
//      agrees, options never spill silently;
//   3. This works in BOTH scripts — fresh presentation and the closed
//      funnel (closing state) — and with the LLM DOWN (без LLM contract).
import { test } from 'node:test';
import assert from 'node:assert';
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
import { detectCheaperSearch } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// Кисела Вода buy: three candidates — 46 is the CHEAPEST (it must surface
// first on a cheaper-ask), 80 mid, 63-1 was already rejected. Nothing cheaper
// than 46 exists in the area — after all are shown, a cheaper-ask must get
// the other-neighborhoods OFFER (not a silent spill, not the phone ask).
const ROWS: Property[] = [
  { eb: 80, id: 80, location: 'Кисела Вода', price: 72300, service: 'buy' },
  { eb: 46, id: 46, location: 'Кисела Вода', price: 46000, service: 'buy' },
  { eb: 47, id: 47, location: 'Кисела Вода', price: 47000, service: 'buy' },
  { eb: 63, id: 63, location: 'Центар', price: 36000, service: 'buy' },
  { eb: 55, id: 55, location: 'Влае', price: 40000, service: 'buy' },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

function makeHandler(): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent };
}

// The phone ask that swallowed the 21:39 message — the reply must NEVER be it.
const PHONE_ASK = /бројот на телефон|телефонски број/iu;
// Bank-backed cheaper intro (wording varies) — the contract is the empathy +
// cheapest-first SERVE, never the exact sentence.
const CHEAPER_INTRO = /пристапн|најевтин|цената е важна|подредени од најевтина/iu;

test('detector: every real-world cheaper-word spelling fires detectCheaperSearch', () => {
  for (const msg of [
    'daj nesto poeftino vo toj reon',   // ф→т slip
    'daj nesto poeKtino vo toj reon',   // ф→к typo — THE 21:39 transcript
    'nesto poftino',                    // dropped vowel
    'daj pojeftino',                    // й-insertion
    'дај нешто поефтино во тој реон',   // Cyrillic ф→т
    'појефтино ако има',                // Cyrillic й
    'sto poevtino ima',                 // canonical
    'najeftino shto ima',               // superlative
  ]) {
    assert.ok(detectCheaperSearch(msg), `must detect cheaper-search: ${msg}`);
  }
  // NOT cheaper asks: price questions and pure agreements stay out.
  assert.ok(!detectCheaperSearch('kolku cena ima'), 'price question is not a cheaper-search');
  assert.ok(!detectCheaperSearch('dobro'), 'agreement is not a cheaper-search');
});

test('closing-state cheaper-ask serves cheapest-first cards, never the phone ask (21:39)', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'goran';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // The funnel up to closing: search Кисела Вода → card → visit interest → fee.
  let s = await send('SAKAM DA KUPAM STAN VO KISELA VODA, DVE SPALNI, DO 80.000 EVRA');
  assert.equal(s.state, 'presentation');
  assert.ok(sent[0].includes('Евидентен број'), sent[0]);

  s = await send('sakam da ja vidam');
  assert.equal(s.state, 'closing');
  assert.ok(/надомест|наплаќ|500|300/iu.test(sent[1]), sent[1]); // fee disclosed

  // THE 21:39 MESSAGE — with the ф→к typo, LLM DOWN. The contract: cheaper
  // cards from the DB (the 46.000 € row is the cheapest NOT-yet-shown in the
  // pool), never "Да ми го оставите бројот на телефон?".
  s = await send('daj nesto poeKtino vo toj reon');
  const reply = sent[sent.length - 1];
  assert.ok(CHEAPER_INTRO.test(reply), reply);
  assert.ok(reply.includes('Евидентен број 46'), reply);         // cheapest-first
  assert.ok(!PHONE_ASK.test(reply), reply);                      // never the phone ask
  assert.equal(s.state, 'presentation');
  assert.equal(s.slots.pricePriority, true);
});

test('presentation-state cheaper-ask re-serves cheapest-first without swallowing', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'lena';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  let s = await send('SAKAM DA KUPAM STAN VO KISELA VODA, DVE SPALNI, DO 80.000 EVRA');
  assert.equal(s.state, 'presentation');

  // The price complaint ("mnogu skapa cena ima") then the cheaper ask — the
  // fresh-search script must serve the cheaper row, not a market opinion.
  s = await send('daj nesto poeKtino vo toj reon');
  const reply = sent[sent.length - 1];
  assert.ok(CHEAPER_INTRO.test(reply), reply);
  assert.ok(reply.includes('Евидентен број'), reply);
  assert.ok(!PHONE_ASK.test(reply), reply);
  assert.ok(!/самите сопственици ги дефинираат цените|исклучиво посредничка/iu.test(reply), reply); // no investment.opinion excuse
  assert.equal(s.slots.pricePriority, true);
});

test('drained area: cheaper-ask OFFERS other neighborhoods (bank ask), widen only after "da"', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'ivo';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // Show BOTH Кисела Вода rows (search → reject → next batch), so the area is drained.
  let s = await send('SAKAM DA KUPAM STAN VO KISELA VODA, DVE SPALNI, DO 80.000 EVRA');
  assert.ok(sent[0].includes('Евидентен број'), sent[0]);
  s = await send('NEBITNI SE SPALNITE');
  assert.ok(!sent[1].includes('Евидентен број'), sent[1]); // sizeWaived alone must not re-present
  s = await send('NE MI SE DOPAGA');
  assert.ok(/Евидентен број (46|47)/.test(sent[2]), sent[2]); // next (cheaper) row
  s = await send('NE MI SE DOPAGA');
  // Area exhausted: the widen/register ASK, no more cards.
  assert.ok(/друга населба|друг дел|друга локаци|регистрирам|запишам|контактирам|погледнеме/iu.test(sent[3]), sent[3]);

  // Cheaper ask on a DRAINED area: the exhausted line already ASKED about
  // other neighborhoods, so the cheaper-ask IS the consent — Lina widens
  // directly with the cheapest cards from the rest of the city. Never the
  // phone ask, never another redundant ask.
  s = await send('daj nesto poeKtino');
  const widened = sent[sent.length - 1];
  assert.ok(widened.includes('Евидентен број'), widened); // real cards from other areas
  assert.ok(!PHONE_ASK.test(widened), widened);
  assert.ok(widened.includes('Евидентен број 63'), widened); // cheapest city-wide (36.000 €)
  assert.equal(s.state, 'presentation');
});
