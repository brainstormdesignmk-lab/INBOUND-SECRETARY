// TWO TURNS FROM THE [02:03]–[02:05] FIELD CAPTURE.
//
//  [02:03] the owner was asked about the flat, the term — and NEVER about the
//          price, so he was never given the chance to correct the figure the
//          client is looking at. The clean-price clause rode only rows carrying
//          a `cleanPrice` column; most feed rows carry only the published one.
//
//  [02:05] the owner countered 19:00 and the client accepted («ПА ДОБРО НЕКА
//          БИДЕ ВО 7»). Lina answered «19:00 часот е веќе зафатен» — the
//          calendar had counted the chat's OWN visit row, the one under
//          negotiation, as a booking. A slot being discussed is not a slot that
//          is taken.

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
import { buildOwnerPublishedPriceQuestion } from '../src/pricing/cleanPrice';

const cfg = loadConfig();

/** NEXT Friday 19:00 — the capture's own slot, COMPUTED instead of pinned.
 *
 *  The two slot tests below used to pin «Петок, 13.11.2026 во 19:00» and
 *  `new Date(2026, 10, 13, 19, 0, 0)`. 13.11.2026 IS a Friday, so the pair
 *  expired the moment the real clock passed 19:00 that day: «Петок во 19:00»
 *  then resolves to the NEXT Friday, the stored booking is a past instant, and
 *  the conflict rule never fires — both tests failed at 19:33 on their own
 *  date (2026-11-13) with no code change behind them. The rule under test is
 *  "a booking at that hour blocks", so the fixture has to be the hour the
 *  client's sentence resolves to: the next Friday at 19:00. */
function nextFriday19(): { label: string; at: number } {
  const now = new Date();
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 19, 0, 0, 0);
  let delta = (5 - now.getDay() + 7) % 7;
  if (delta === 0 && d.getTime() <= now.getTime()) delta = 7;
  d.setDate(d.getDate() + delta);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  return { label: `Петок, ${dd}.${mm}.${d.getFullYear()} во 19:00`, at: d.getTime() };
}

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('probe: LLM disabled'); }
}

const ROWS: Property[] = [{
  eb: 66, id: 66, location: 'Центар', address: 'Рузвелтова 66', price: 137000,
  bedrooms: 2, sqm: 79, size: '79 м²', service: 'buy',
  lat: 42.0026, lon: 21.4177, geo_source: 'google_cached', details: '',
} as Property];

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
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties, appointments,
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
  });
  const ownerAsks: string[] = [];
  handler.onOwnerAsk = (_c, _eb, q) => ownerAsks.push(q);
  const chatId = 'slot';
  const say = async (m: string): Promise<string> => {
    sent.length = 0;
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  const seed = (): void => {
    const s = freshSession('test', chatId);
    s.state = 'visit_scheduling';
    s.slots.service = 'buy';
    s.slots.currentBatch = [66];
    s.slots.presentedIds = [66];
    s.slots.propertyId = 66;
    s.slots.interestedPropertyId = 66;
    s.slots.viewingFeeAgreed = true;
    s.slots.feeDisclosed = true;
    s.slots.name = 'Марко';
    s.slots.phone = '076845234';
    sessions.set(s);
  };
  return { db, sessions, appointments, handler, chatId, say, seed, ownerAsks, sent };
}

test('[field] the owner ask carries the PUBLISHED price when there is no clean one', () => {
  // The builder half: a row with only the ad price still gets a confirmation.
  assert.equal(buildOwnerPublishedPriceQuestion(137000, 'buy'),
    'Дали цената од огласот, 137.000 евра, е сè уште актуелна?');
  assert.match(buildOwnerPublishedPriceQuestion(800, 'rent') ?? '', /кирија/u);
  assert.equal(buildOwnerPublishedPriceQuestion(undefined), '', 'no price, no made-up question');
});

test('[field] the first owner ask asks about the money too', async () => {
  const h = makeHandler();
  h.seed();
  await h.say('Кога можам да го видам станот? Петок во 17:00');
  const ask = h.ownerAsks.at(-1) ?? '';
  assert.notEqual(ask, '', 'the owner was asked something');
  assert.match(ask, /137\.000/u, `the figure the client sees: ${ask}`);
  assert.match(ask, /сè уште актуелна/iu, `as a confirmation, not a rewrite: ${ask}`);
  assert.match(ask, /Дали се согласувате на овој термин/iu, `the term question stays: ${ask}`);
});

test('[field] the chat’s own visit is not a «зафатен» hour', async () => {
  const h = makeHandler();
  h.seed();
  // The owner's counter was 19:00 and the client accepted it. The row under
  // negotiation already sits in the store as a finalized visit for THIS chat
  // and THIS flat — the state the capture was in.
  const appt = h.appointments.insert({
    chatId: h.chatId, clientName: 'Марко', clientPhone: '076845234', propertyId: 66,
    service: 'Купување', viewingFee: '500 MKD', time: '', agentPhone: '076247467',
  });
  const slot = nextFriday19();
  h.appointments.markFinalized(appt, slot.label);
  // The scheduler pins the concrete instant when the visit is arranged; the
  // calendar reads only rows that carry it.
  h.db.db.prepare('UPDATE appointments SET visit_at = ? WHERE id = ?')
    .run(slot.at, appt);

  const answer = await h.say('Петок во 19:00');
  assert.doesNotMatch(answer, /веќе зафатен|веќе е зафатен|зафатен/iu,
    `his own slot is not taken: ${answer}`);
  // …and the owner is asked about the hour he offered.
  assert.match(h.ownerAsks.at(-1) ?? '', /19:00/u, `the owner confirms 19:00: ${h.ownerAsks.at(-1)}`);
});

test('[field] ANOTHER chat’s booking at that hour still blocks', async () => {
  const h = makeHandler();
  h.seed();
  const other = h.appointments.insert({
    chatId: 'someone-else', clientName: 'Ана', clientPhone: '070111222', propertyId: 66,
    service: 'Купување', viewingFee: '500 MKD', time: '', agentPhone: '076247467',
  });
  const slot = nextFriday19();
  h.appointments.markFinalized(other, slot.label);
  h.db.db.prepare('UPDATE appointments SET visit_at = ? WHERE id = ?')
    .run(slot.at, other);
  const answer = await h.say('Петок во 19:00');
  assert.match(answer, /зафатен/iu, `the agent cannot hold two visits: ${answer}`);
});
