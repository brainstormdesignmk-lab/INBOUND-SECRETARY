// THE SET THE FEE NAMED IS THE SET THE VISIT BOOKS (the [10:19] field turn).
//
//   [10:19] «dali se slobodni vo momentov ?» after three RENT business spaces
//           → all three answered available, and the disclosure said «За 3
//             недвижности тоа е вкупно 900 денари»
//   [10:19] the client agrees, gives name+phone, names a term
//           → ONE owner was asked and ONE visit was booked (EB 58, the tail of
//             the batch); the other two viewings he had just paid for vanished.
//
// The cause: the availability lane remembered the rows as SHOWN but not as the
// subject of the disclosure, so the term lane fell back to the single pinned
// flat. A per-property fee names its set — consent to that fee is consent to
// that many viewings.
//
// The same turn also pins the post-booking reply (the [10:26] capture): after
// the visit was arranged, the client's next message was answered with «штом ќе
// го контактирам сопственикот и прашам за моментална достапност» — a check
// that had already happened. `pending` means the visit IS arranged.

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
import { detectOwnerVerdict } from '../src/llm/deterministic';
import { stateTask, FALLBACKS } from '../src/llm/prompts';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('probe: LLM disabled'); }
}

const ROWS: Property[] = [56, 57, 58].map(eb => ({
  eb, id: eb, location: 'Центар', address: `Улица ${eb}`, price: 400 + eb,
  bedrooms: 2, sqm: 40, size: '40 м²', service: 'rent', business: true,
  lat: 41.995 + eb / 10000, lon: 21.431 + eb / 10000, geo_source: 'google_cached', details: '',
} as Property));

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id || r.eb === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler() {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const properties = new FakeProps(ROWS);
  const appointments = new AppointmentStore(db);
  const handler = new InboundHandler({
    cfg: loadConfig(), db, sessions,
    classifier: new Classifier(new FailingLlm(), loadConfig(), properties),
    responder: new Responder(new FailingLlm(), loadConfig()),
    properties, appointments,
    escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
  });
  const asks: Array<{ eb: number; q: string }> = [];
  handler.onOwnerAsk = (_c, eb, q) => { asks.push({ eb, q }); };
  const chatId = 'rent-three';
  const seed = () => {
    const s = freshSession('test', chatId);
    s.state = 'presentation';
    s.slots.service = 'rent';
    s.slots.currentBatch = [56, 57, 58];
    s.slots.presentedIds = [56, 57, 58];
    s.slots.propertyId = 58;
    s.slots.interestedPropertyId = 58;
    sessions.set(s);
    return s;
  };
  const say = async (m: string): Promise<string> => {
    sent.length = 0;
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  const answerOwner = async (ask: { eb: number; q: string }): Promise<string> => {
    sent.length = 0;
    const term = ask.q.match(/(?:Понеделник|Вторник|Среда|Четврток|Петок|Сабота|Недела)[^,]*во \d{2}:\d{2}/u)?.[0]
      ?? ask.q.match(/во \d{2}:\d{2}/u)?.[0] ?? '';
    handler.ownerAnswer(chatId, ask.eb, detectOwnerVerdict('MOZE', term));
    await new Promise(r => setTimeout(r, 150));
    return sent.at(-1) ?? '';
  };
  return { handler, sessions, sent, asks, chatId, seed, say, answerOwner, appointments };
}

test('[10:19] the fee quoted for three books three viewings', async () => {
  const h = makeHandler();
  h.seed();
  const avail = await h.say('dali se slobodni vo momentov ?');
  for (const eb of [56, 57, 58]) {
    assert.match(avail, new RegExp(`Евидентен број ${eb}`), `every named flat is answered: ${avail}`);
  }
  assert.match(avail, /900/u, `the per-property total is stated: ${avail}`);
  // The disclosure names the set; consent to it is consent to all three.
  const s = h.sessions.get(h.chatId)!;
  assert.deepEqual(s.slots.visitEbs, [56, 57, 58], 'the offered set is remembered');
  assert.equal(s.slots.visitWanted, true, 'the fee was for a plural visit');

  const contact = await h.say('da se soglasuvam');
  assert.match(contact, /56, 57 и 58|56, 57, 58/u, `the contact ask names the set: ${contact}`);
  assert.match(contact, /деловните простори/u, `the set's own noun, not «становите»: ${contact}`);

  await h.say('Дејан Узунов 076845234');
  await h.say('ponedelnik vo 6');

  // ONE round, THREE owners — every stop of the set, no flat silently dropped.
  assert.equal(h.asks.length, 3, `every flat is asked: ${JSON.stringify(h.asks)}`);
  assert.deepEqual(h.asks.map(a => a.eb).sort((a, b) => a - b), [56, 57, 58]);
  for (const ask of [...h.asks]) await h.answerOwner(ask);
  const routeAsk = h.sent.at(-1) ?? '';
  assert.match(routeAsk, /Дали да ги потврдам посетите/u, `the route ask: ${routeAsk}`);
  assert.match(routeAsk, /56/u, routeAsk);
  assert.match(routeAsk, /57/u, routeAsk);
  assert.match(routeAsk, /58/u, routeAsk);

  await h.say('ДА');
  const booked = h.appointments.listByChat(h.chatId).map(r => r.propertyId).sort((a, b) => a - b);
  assert.deepEqual(booked, [56, 57, 58], `three visits are booked: ${JSON.stringify(booked)}`);
});

test('[10:26] after the visit is booked, «ќе го контактирам сопственикот» is never said', async () => {
  const h = makeHandler();
  h.seed();
  await h.say('dali se slobodni vo momentov ?');
  await h.say('da se soglasuvam');
  await h.say('Дејан Узунов 076845234');
  await h.say('ponedelnik vo 6');
  for (const ask of [...h.asks]) await h.answerOwner(ask);
  await h.say('ДА');
  assert.equal(h.sessions.get(h.chatId)!.state, 'pending');

  // A later message in the same chat must not re-open a check that is done.
  const after = await h.say('tocno');
  assert.ok(!/ќе го контактирам сопственикот|моментална достапност/iu.test(after),
    `no owner check after booking: ${after}`);
  assert.match(after, /договорена|посетата/iu, `the booked visit is what the reply stands on: ${after}`);

  // The model-side instruction carries the same truth…
  const task = stateTask('pending', h.sessions.get(h.chatId)!.slots);
  assert.match(task, /ALREADY ARRANGED/u, task);
  assert.match(task, /3 stops/u, `the booked route is named, not one flat: ${task}`);
  assert.match(task, /NEVER promise to contact the owner/u, task);
  // The old instruction ORDERED the check; the new one forbids it.
  assert.ok(!/give the closing phrase|Acknowledge the provided contact details/u.test(task),
    `never the pre-booking instruction: ${task}`);
  // …and so does the static fallback.
  assert.ok(!/ќе го контактирам сопственикот|моментална достапност/iu.test(FALLBACKS.pending ?? ''),
    `the fallback never promises a done check: ${FALLBACKS.pending}`);
});
