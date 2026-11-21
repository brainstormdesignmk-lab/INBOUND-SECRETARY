// THE [06:48] LONE-HOUR BATCH
//
// (originally the [10:0x] batch — the scaffold is shared)
// THE [10:0x] CLIENT BATCH — the visit term must be a TERM, and the fee must
// be quotable per visit.
//
//   [10:06] NE MOZAM VO VTORNIK          → a REFUSAL, not a proposal
//   [10:06] CEL DEN SUM NA RABOTA        → «I am at work all day», a busy REASON
//   ЛИНА → OWNER: «Клиентот не е во можност … Има друг предлог: Цел ден сум на
//           работа. Дали би Ви одговарал тој термин?»
//
// Two defects met: «RABOTA» is edit-distance 1 from «SABOTA», so the busy reason
// read as a Saturday proposal; and the owner relay accepted ANY sentence as the
// client's counter. The owner's standing rule, now the contract:
//
//   A VISIT TERM IS A DAY **AND** A TIME. If either is missing, Lina asks the
//   CLIENT for the missing half — she never hands something undefined to the
//   owner or the client.
//
// The same seam owns the sibling from the [09:58] capture: «MOZAM VO PONEDELNIK»
// after «КОГА МОЖЕ ДА СЕ ПОСЕТИ?» must complete the term (ask the HOUR on that
// day), never fall out of the lane into a landmark search.
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
import { LlmClient } from '../src/llm/types';
import { detectVisitTime, detectVisitTime as dv } from '../src/llm/deterministic';
import { isCompleteVisitTerm, missingTermPiece } from '../src/visits/time';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore, writeMap } from '../src/geo/offlineMap';
import path from 'path';
import os from 'os';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 66, id: 66, location: 'Центар', price: 137000, service: 'buy', sqm: 79, size: '79 м²',
    address: 'Партизански одреди 12', bedrooms: 3, lat: 41.9955, lon: 21.4310, geo_source: 'stored' } as Property,
  { eb: 95, id: 95, location: 'Центар', price: 204000, service: 'buy', sqm: 74, size: '74 м²',
    address: 'Македонија 8', bedrooms: 3, lat: 41.9960, lon: 21.4320, geo_source: 'stored' } as Property,
];

function makeHandler(chat: string) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  const ownerAsks: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(llm, cfg, properties),
    responder: new Responder(llm, cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: undefined,
  } as never);
  handler.onOwnerAsk = (_c: string, _eb: number, q: string) => { ownerAsks.push(q); };
  const send = async (m: string) => { await handler.handle('test', chat, m); return sessions.get(chat)!; };
  return { handler, sessions, sent, ownerAsks, send };
}

/** Drive a chat to the point where the client's term goes to the owner. */
async function reachTermAsk(send: (m: string) => Promise<unknown>, ownerAsks: string[]) {
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 66');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA');
  await send('DA, SE SOGLASUVAM');
  await send('ZORAN 078/914 196');
  const before = ownerAsks.length;
  await send('MOZAM DA DOJDAM');
  return ownerAsks.length > before;
}

// THE [06:48] SLOT ANSWER — «6» after «Кој термин Ви одговара?».
//
// The client documented two failures in one turn:
//   * he answered the slot question with the number alone («6») and the
//     funnel asked the WHOLE term question again — nothing he said was heard;
//   * the hour that eventually reached the owner was 20:00 for a client who
//     had said six (the visit window turns 6 into 18:00 — see visitClockHour).
//
// A term is a DAY and a TIME. When the clock is present and the day is not,
// the missing half is the DAY, and the hour echoes back so the client sees it
// was taken. When both halves arrive (day first, then the bare hour), the
// owner is asked with the resolved clock and never a guessed one.

test('[06:48] «6» alone is heard as 18:00 and the DAY is the question', async () => {
  const { sent, ownerAsks, sessions, send } = makeHandler('lone-hour');
  await reachTermAsk(send, ownerAsks);
  const asksBefore = ownerAsks.length;
  await send('6');
  const last = sent[sent.length - 1] ?? '';
  assert.equal(sessions.get('lone-hour')?.state, 'visit_scheduling',
    'no owner is asked without a day');
  assert.equal(ownerAsks.length, asksBefore, 'a clock alone never reaches the owner');
  assert.match(last, /18:00/, `the hour he named is echoed back: ${last}`);
  assert.match(last, /кој ден|Кој ден/iu, `the missing half is the DAY: ${last}`);
  assert.doesNotMatch(last, /Кој термин би Ви одговарал/u,
    `the whole term question must not be re-asked: ${last}`);
});

test('[06:48] day then a bare hour reaches the owner as 18:00, never 20:00', async () => {
  const { sent, ownerAsks, send } = makeHandler('lone-hour-pm');
  await reachTermAsk(send, ownerAsks);
  await send('PONEDELNIK');
  const asksBefore = ownerAsks.length;
  await send('6');
  const ownerLine = ownerAsks.slice(asksBefore).join('\n');
  assert.match(ownerLine, /во 18:00/u, `the owner reads the clock the client said: ${ownerLine}`);
  assert.doesNotMatch(ownerLine, /20:00/u, `20:00 is the funnel's guess, not his hour: ${ownerLine}`);
  assert.match(sent[sent.length - 1] ?? '', /во ред|потврд/iu,
    `the client is told the check is in flight: ${sent[sent.length - 1]}`);
});
