/**
 * THE [10:16] V16K11 BURST — a goodbye must never become a search.
 *
 * The live client, after the pair 78/84 was quoted, wrote:
 *
 *   10:09:55  «skapo e mnogu»
 *   10:10:10  «ke ve kontaktiram ako se odlucam»
 *
 * and at 10:16 the bot answered with the LOCATE ask
 * («Разбрав — Центар. За да го стесниме изборот, кажете ми — колку квадрати има
 * станот и по која цена беше? …») — asking him for the size and price of a flat
 * she had just described, instead of letting him go.
 *
 * Root cause: the price complaint carried `pricePriority`, the classifier merged
 * it with the session's own service/location/bedrooms, and `buildEvent` rebuilt
 * a SEARCH_REQUESTED — so the funnel re-served (or re-interrogated) a client who
 * had said he would call back.
 *
 * The contract pinned here:
 *   • a deferral owns the turn — the «ке Ве побарам штом…» line, no re-offer,
 *     no locate question, no property card;
 *   • the SAME deferral is still a search when it carries a search instruction
 *     («ke se javam podocna, baram stan do 80000 vo aerodrom») — that guard
 *     lives in detectDefer and must keep working.
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
import { detectDefer } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const ROWS: Property[] = [
  { eb: 78, id: 78, location: 'Капиштец', address: 'Ул. Капиштец 8', price: 185000,
    bedrooms: 3, sqm: 82, size: '82 м²', service: 'buy' } as Property,
  { eb: 84, id: 84, location: 'Центар', address: 'Ул. Димитар Миладинов 4', price: 117000,
    bedrooms: 3, sqm: 48, size: '48 м²', service: 'buy' } as Property,
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
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const props = new FakeProps(ROWS);
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
  return { handler, sessions, sent, chat: 'v16k11-burst' };
}

/** Run the real opening of the live chat, so the burst lands in the same
 *  state (a pair on the table) it landed in on the box. */
async function reachPairOnTable(
  handler: InboundHandler, chat: string,
): Promise<void> {
  await handler.handle('test', chat, 'zdravo');
  await handler.handle('test', chat, 'sto imate za prodavanje kaj beverli hils');
  await handler.handle('test', chat, 'stance mi treba trosobno');
}

// CONTRACT-LEVEL, never one wording: every followup.defer variant records the
// criteria and promises a later contact, and none of them asks the client for a
// detail of the flat (bank variants rotate — AGENTS.md §2).
const DEFER_COPY = /(?:контактирам|побарам|известам|запишам|забележам|евидентирам)/iu;
const SPEC_QUESTION = /колку (?:квадрати|спални)|До која (?:сума|цена)|дефинирано максимална цена|по која цена/iu;
const CARD = /Станот под Евидентен број|Евидентен број \d+/iu;

test('the live goodbye burst defers — no locate ask, no re-served pair', async () => {
  const { handler, sessions, sent, chat } = makeHandler();
  await reachPairOnTable(handler, chat);

  await handler.handle('test', chat, 'skapo e mnogu\nke ve kontaktiram ako se odlucam');

  const reply = sent.at(-1)!;
  assert.match(reply, DEFER_COPY, `the deferral line owns the turn: ${reply}`);
  assert.doesNotMatch(reply, SPEC_QUESTION, `she must not ask about a flat's m²/price: ${reply}`);
  assert.doesNotMatch(reply, CARD, `a client who is leaving gets no new card: ${reply}`);
  assert.ok(!sessions.get(chat)!.slots.pricePriority,
    'a complaint inside a goodbye is not a new "cheaper" search direction');
});

test('the same goodbye alone also defers', async () => {
  const { handler, sent, chat } = makeHandler();
  await reachPairOnTable(handler, chat);
  await handler.handle('test', chat, 'ke ve kontaktiram ako se odlucam');
  assert.match(sent.at(-1)!, DEFER_COPY, `the deferral line: ${sent.at(-1)}`);
});

test('a deferral that carries a search instruction is still a search', async () => {
  const text = 'ke se javam podocna, baram stan do 80000 vo aerodrom';
  assert.equal(detectDefer(text), false,
    'detectDefer must keep standing down when the burst carries specs');
  const { handler, sent, chat } = makeHandler();
  await reachPairOnTable(handler, chat);
  await handler.handle('test', chat, text);
  const reply = sent.at(-1)!;
  // The funnel used what the burst said (its own area/budget), which is the
  // proof the search reached it — not the goodbye line's shape.
  assert.match(reply, /80\.000|80000|Аеродром/iu,
    `the criteria in the burst must reach the funnel: ${reply}`);
});
