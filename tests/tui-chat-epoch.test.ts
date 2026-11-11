// A CHAT ID MUST NOT SURVIVE A RUN.
//
// data/tui.db persists across TUI runs while the client counter restarts at 1, so
// every run's first client used to be `client-1` — the same identity as the first
// client of every previous run. The session row was cleared on claim, but the
// OPERATIONAL rows keyed by chat id (appointments, events, escalations,
// enrichment) stayed, and the [20:54] capture read a brand-new client a visit
// another person had booked: «Договорената посета е за станот со Евидентен број
// 79 (Четврток, 12.11.2026 во 17:00)» — row #14 of data/tui.db, created
// 2026-11-09 under the SAME `client-1`.
//
// The fix is identity, not filtering: a chat id carries its run
// (`client-1@<stamp>`), so `listByChat` cannot reach another run's records by
// construction. These tests pin BOTH halves — the separation, and the fact that
// the recall path still reads the table for the chat it is actually in.
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
import { BankStore } from '../src/store/bank';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';
import { newClientId, displayChatId, runStamp } from '../src/tui/chatId';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const EB79: Property = {
  eb: 79, id: 79, uuid: 'eb79', location: 'Водно', address: 'Владимир Назор бр.26-2',
  price: 300, bedrooms: 2, sqm: 35, size: '35 м²', service: 'rent',
  lat: 41.9905, lon: 21.4181, geo_source: 'osm_building',
};
const ROWS: Property[] = [EB79];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getAllEbs(): Promise<Set<number>> { return new Set(this.rows.map(r => r.eb)); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb || r.id === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(db: Db, chatId: string) {
  const cfg = loadConfig();
  const sessions = new SessionStore(db);
  const appointments = new AppointmentStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions, bank: new BankStore(db),
    classifier: new Classifier(new FailingLlm(), cfg, new FakeProps(ROWS)),
    responder: new Responder(new FailingLlm(), cfg),
    properties: new FakeProps(ROWS), appointments,
    escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  return { say, sessions, appointments, chatId, sent };
}

/** The [20:54] booking, planted under the LEGACY bare id — what a previous run
 *  left behind. */
function plantOldBooking(db: Db, chatId = 'client-1'): void {
  new AppointmentStore(db).insert({
    chatId, clientName: 'CLIENT', clientPhone: '070123456',
    propertyId: 79, service: 'rent', viewingFee: '300',
    time: 'Четврток, 12.11.2026 во 17:00', agentPhone: null,
  });
}

const PAST_RECALL = 'ЗА КОЈ СТАН ТИ КАЖАВ ДА ДОГОВОРИШ ПРЕЕСКА ?';

test('a chat id carries the run that minted it', () => {
  // Two runs, the same client number: never the same identity.
  const runA = newClientId(1, runStamp(1_794_350_000_000));
  const runB = newClientId(1, runStamp(1_794_400_000_000));
  assert.notEqual(runA, runB, 'the same slot in two runs must be two identities');
  assert.match(runA, /^client-1@[0-9a-z]{5}$/u, `readable, stamped, short: ${runA}`);
  // The operator-facing half is what `/state client-1` types and what the lead
  // row shows — it survives the stamp.
  assert.equal(displayChatId(runA), 'client-1');
  assert.equal(displayChatId('legacy-bare-id'), 'legacy-bare-id', 'a bare id still resolves');
  // A stamp changes every millisecond-run; the last 5 base36 digits are enough
  // to keep two runs apart (36^5 ≈ 60M).
  assert.notEqual(runStamp(1_794_350_000_000), runStamp(1_794_350_001_000));
});

test('a fresh run cannot read a previous run\'s booking — and its own chat still can', async () => {
  const db = new Db(':memory:');
  plantOldBooking(db);
  const appointments = new AppointmentStore(db);

  // THIS RUN's first client — the same human slot, a different identity.
  const mine = newClientId(1, runStamp(1_794_500_000_000));
  assert.equal(appointments.listByChat(mine).length, 0,
    'the new run starts with no appointments of its own');

  const fresh = makeHandler(db, mine);
  const reply = await fresh.say(PAST_RECALL);
  // The honest answer is "nothing arranged here", never another person's visit.
  assert.doesNotMatch(reply, /79/u, `a previous run's flat must never be named: ${reply}`);
  assert.doesNotMatch(reply, /12\.11\.2026/u, `nor its time: ${reply}`);
  assert.match(reply, /Немам забележано/u, `the turn says so: ${reply}`);
  assert.equal(fresh.sessions.get(mine)?.slots.interestedPropertyId, undefined,
    'and it binds nothing: the flat of a stranger must not become the topic');

  // CONTROL — the recall path itself is intact: the chat that OWNS the booking
  // still reads it. Without this, the assertions above would pass on a broken
  // store just as happily.
  const owner = makeHandler(db, 'client-1');
  const owned = await owner.say(PAST_RECALL);
  assert.match(owned, /79/u, `the owning chat still sees its own booking: ${owned}`);
  assert.match(owned, /12\.11\.2026|17:00/u, `with its time: ${owned}`);
});

test('every chat-keyed store is separated by the run stamp', async () => {
  const db = new Db(':memory:');
  plantOldBooking(db);
  const mine = newClientId(2, runStamp(1_794_600_000_000));
  const fresh = makeHandler(db, mine);
  await fresh.say(PAST_RECALL);
  // The session the turn wrote belongs to THIS id only.
  assert.ok(fresh.sessions.get(mine), 'the new chat has its own session row');
  assert.equal(fresh.sessions.get('client-1'), null,
    'the previous run\'s session id was not touched by this turn');
  // The stores that key on chat id (events, escalations, enrichment) inherit the
  // same separation because they are written with this session's chatId — the
  // appointments table is the one a reply ever reads back, and it is asserted
  // above through the handler rather than the store.
  assert.equal(fresh.appointments.listByChat('client-1').length, 1,
    'the previous run\'s row is untouched, not migrated');
  assert.equal(fresh.appointments.listByChat(mine).length, 0, 'and nothing leaked in');
});
