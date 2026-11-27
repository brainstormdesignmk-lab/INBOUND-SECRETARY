/**
 * THE [09:14]–[09:27] V16K11 TURNS — ONE CLIENT, FIVE DEFECTS.
 *
 *   [09:24] ДАЛИ УШТЕ ВИ СЕ ПРОДАВААТ 66 И 65 ?   → only 66 was answered; 65
 *                                                   was never mentioned again
 *   [09:14] KOLKU SE PO KVADRAT STANOVIVE ?       → one flat's rate, though
 *                                                   «становиве» is the pair
 *   [09:15] NAPRAJ MI SPOREDBA SO PONUDENITE
 *           PRETHODNO                             → «немам недвижност во
 *                                                   близина на Сити Мол» — a
 *                                                   landmark sentence for a
 *                                                   comparison of the cards
 *   [09:27] KOI INFORMACII MOZETE DA MI
 *           KAZETE ZA 66 ?                        → the 500 денари disclosure,
 *                                                   as if he had agreed to a
 *                                                   visit
 *   [08:54] УШТЕ НЕШТО ИМА ЛИ ИЛИ ТОА Е ТОА ?     → LLM copy that invented
 *                                                   «да Ве контактирам штом се
 *                                                   појави нова понуда», which
 *                                                   then re-served
 *
 * Each test drives the real InboundHandler: the routing order is as much the
 * subject here as the wording.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { Db } from '../src/store/db';
import { SessionStore, freshSession, ChatSession } from '../src/fsm/session';
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

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> {
    return this.rows.find(r => r.eb === eb || r.id === eb);
  }
  get healthy(): boolean { return true; }
}

/** Two three-bedroom flats in Центар (66 exists, 65 is the sold number the
 *  client still asks about) plus one two-bedroom flat — the pair the rate
 *  question is about. */
const ROWS: Property[] = [
  { eb: 66, id: 66, location: 'Центар', address: 'Ул. Рузвелтова 5', price: 137000, bedrooms: 3, sqm: 79, size: '79 м²', service: 'buy', lat: 41.9950, lon: 21.4320 } as Property,
  { eb: 63, id: 63, location: 'Карпош', address: 'Ул. Партизански одреди 20', price: 120000, bedrooms: 3, sqm: 80, size: '80 м²', service: 'buy', lat: 42.0040, lon: 21.3910 } as Property,
];

function makeHandler(rows: Property[] = ROWS) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const props = new FakeProps(rows);
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  return { handler, sessions, sent, db };
}

/** A chat that has just been shown the pair and is being asked about the fee
 *  (the live state at [09:27] was `closing`). */
function seedClosing(s: ChatSession, ebs: number[]): void {
  s.state = 'closing';
  s.slots.service = 'buy';
  s.slots.propertyId = ebs[0];
  s.slots.interestedPropertyId = ebs[0];
  s.slots.presentedIds = [...ebs];
  s.slots.currentBatch = [...ebs];
  s.slots.describedEbs = [...ebs];
  s.slots.feeDisclosed = true;
}

test('[09:27] an info ask by number gets the card, never the fee protocol', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chat = 'v16k11-info-66';
  const s = freshSession('test', chat);
  seedClosing(s, [66, 63]);
  sessions.set(s);

  await handler.handle('test', chat, 'KOI INFORMACII MOZETE DA MI KAZETE ZA 66 ?');
  const reply = sent[sent.length - 1] ?? '';
  assert.match(reply, /66/u, 'the flat he named is the subject');
  assert.match(reply, /79\s*м²|Центар/u, `the card's own facts: ${reply}`);
  assert.doesNotMatch(reply, /денари|провизија|надомест/u,
    'a request for information is not consent — no money in the answer');
  assert.doesNotMatch(reply, /Дали се согласувате/u, 'and no fee question either');
});

test('[09:24] «66 И 65» is answered for BOTH — the sold number is named, not dropped', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chat = 'v16k11-avail-66-65';
  const s = freshSession('test', chat);
  s.state = 'closing';
  s.slots.service = 'buy';
  s.slots.presentedIds = [66];
  s.slots.currentBatch = [66];
  sessions.set(s);

  await handler.handle('test', chat, 'DALI USTE VI SE PRODAVAAT 66 I 65 ?');
  const reply = sent[sent.length - 1] ?? '';
  assert.match(reply, /66/u, 'the flat that exists is answered from its own row');
  assert.match(reply, /65/u, `the sold number is named: ${reply}`);
  // The absent flat must be reported as absent — a bare number without a word
  // that says it is gone is the same silence in a different costume. ASSERTED
  // AS A CONTRACT, NOT A PHRASE: the not-found copy is a bank pool whose
  // variants rotate («не се појавува», «не го гледам … во системот», «не можам
  // да го најдам», «продаден или повлечен»), so the invariant is that the line
  // names 65 and never claims it is available.
  const line65 = reply.split('\n').find(l => l.includes('65')) ?? '';
  assert.notEqual(line65, '', `a line about 65 is owed: ${reply}`);
  assert.doesNotMatch(line65, /достап|актив|слободн|на продажба/u,
    `the sold number is never called available: ${line65}`);
  // One flat exists, so the per-property arithmetic may only be for one.
  assert.doesNotMatch(reply, /за двете|вкупно 1\.000/u,
    'the fee is not multiplied over a flat the agency does not have');
});

test('[09:14] a plural «по квадрат» question answers EVERY flat on the table', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chat = 'v16k11-m2-plural';
  const s = freshSession('test', chat);
  s.state = 'presentation';
  s.slots.service = 'buy';
  s.slots.presentedIds = [66, 63];
  s.slots.currentBatch = [66, 63];
  s.slots.describedEbs = [66, 63];
  sessions.set(s);

  await handler.handle('test', chat, 'KOLKU SE PO KVADRAT STANOVIVE ?');
  const reply = sent[sent.length - 1] ?? '';
  assert.match(reply, /66/u, `the first flat's rate: ${reply}`);
  assert.match(reply, /63/u, 'and the second — «становиве» is the pair');
  assert.match(reply, /евра за м²/u, 'each line carries its own arithmetic');
});

test('[09:15] a comparison of the shown flats is arithmetic, not a landmark search', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chat = 'v16k11-compare';
  const s = freshSession('test', chat);
  s.state = 'presentation';
  s.slots.service = 'buy';
  s.slots.presentedIds = [66, 63];
  s.slots.currentBatch = [66, 63];
  s.slots.describedEbs = [66, 63];
  sessions.set(s);

  await handler.handle('test', chat, 'NAPRAJ MI SPOREDBA SO PONUDENITE PRETHODNO');
  const reply = sent[sent.length - 1] ?? '';
  assert.match(reply, /Споредба/u, `the comparison is what is served: ${reply}`);
  assert.match(reply, /66/u);
  assert.match(reply, /63/u);
  assert.match(reply, /евра за м²/u, 'the per-м² column is the point of the diff');
  assert.doesNotMatch(reply, /немам недвижност во непосредна близина|km/u,
    'a comparison of cards on the table is not an empty landmark search');
});

test('[08:54] «или тоа е тоа?» is confirmed from the shown set, without the new-offer promise', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chat = 'v16k11-set-confirm';
  const s = freshSession('test', chat);
  s.state = 'presentation';
  s.slots.service = 'buy';
  s.slots.presentedIds = [66, 63];
  s.slots.currentBatch = [66, 63];
  sessions.set(s);
  // The cards on the screen (its own reply is what "last shown" reads).
  await handler.handle('test', chat, 'KOI INFORMACII MOZETE DA MI KAZETE ZA 66 ?');

  await handler.handle('test', chat, 'USTE NESTO IMA LI ILI TOA E TOA ?');
  const reply = sent[sent.length - 1] ?? '';
  assert.match(reply, /Да/u, `the set is confirmed: ${reply}`);
  assert.match(reply, /66/u, 'the flat he was just shown is named');
  // THE OWNER'S REMOVAL: the promise «да Ве контактирам штом се појави нова
  // соодветна понуда» is not served — it stalled the funnel and the client
  // never chose a next step.
  assert.doesNotMatch(reply, /штом се појави|нова соодветна понуда|Ве контактирам веднаш/u,
    'never the new-offer promise');
  // …and it is answered once from the bank of facts, not by the brain: with no
  // LLM in this harness a dynamic reply would be impossible anyway, which is
  // exactly why the lane must exist.
  assert.doesNotMatch(reply, /моменталните понуди ги ажурираме/u, 'no LLM copy');
});
