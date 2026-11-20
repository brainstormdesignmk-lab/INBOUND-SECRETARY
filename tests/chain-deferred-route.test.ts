// A DEFERRED FLAT IS A PROMISE, NOT A FOOTNOTE (the owner's 2026-11-19 answer:
// nobody is dropped — the property that fits is arranged, the other is asked
// for another day/time and arranged separately).
//
// So after a route is booked, the flats that could not share that day are the
// client's NEXT negotiation: his next term starts a route over THEM — owners
// asked in parallel, hours chain-linked, the pause put to the client, and the
// books already signed on the first day left alone. ONE deferred flat keeps the
// ordinary single visit; two or more are a chain, because chaining them is the
// whole reason the deferral was honest.
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

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('probe: LLM disabled'); }
}

const EBS = [82, 84, 88, 59];
const ROWS: Property[] = EBS.map(eb => ({
  eb, id: eb, location: 'Центар', address: `Улица ${eb}`, price: 80000 + eb * 100,
  bedrooms: 2, sqm: 58, size: '58 м²', service: 'buy',
} as Property));

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id || r.eb === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(ebs: number[] = EBS) {
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
    properties,
    appointments, escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
  });
  const asks: Array<{ eb: number; text: string }> = [];
  handler.onOwnerAsk = (_c, eb, q) => asks.push({ eb, text: q });
  const chatId = 'deferred-route';
  const say = async (m: string): Promise<string> => {
    sent.length = 0;
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  const seed = () => {
    const s = freshSession('test', chatId);
    s.state = 'visit_scheduling';
    s.slots.service = 'buy';
    s.slots.currentBatch = ebs;
    s.slots.presentedIds = ebs;
    s.slots.viewingFeeAgreed = true;
    s.slots.feeDisclosed = true;
    sessions.set(s);
  };
  const answer = async (eb: number, text: string, term: string): Promise<string> => {
    sent.length = 0;
    handler.ownerAnswer(chatId, eb, detectOwnerVerdict(text, term));
    await new Promise(r => setTimeout(r, 200));
    return sent.at(-1) ?? '';
  };
  /** Keep answering EVERY owner whose question is in flight with his fixed
   *  hour until the CLIENT hears a sentence. A parallel round asks several
   *  owners at once, so reading only the LAST ask leaves the others 'asked' and
   *  the route can never advance (the negotiator may also chase a linking hour a
   *  few times — each question is spent against that owner's budget). */
  const refuseUntilOffer = async (hours: Record<number, string>): Promise<string> => {
    for (let i = 0; i < 12; i++) {
      const plan = sessions.get(chatId)?.slots.visitPlan;
      const open = plan?.stops.filter(z => z.status === 'asked' && z.askedHour !== undefined) ?? [];
      if (open.length === 0) break;
      for (const stop of open) {
        const client = await answer(stop.eb, `SAMO VO ${hours[stop.eb] ?? '12:00'}`,
          `Петок во ${String(stop.askedHour ?? 17).padStart(2, '0')}:00`);
        if (client) return client;
      }
    }
    return '';
  };
  return { handler, sessions, sent, asks, chatId, say, seed, answer, refuseUntilOffer, appointments };
}

test('[deferred route] the flats that missed the day are chained on the NEXT term', async () => {
  const h = makeHandler();
  h.seed();
  await h.say('ПЕТОК ВО 17:00, САКАМ ДА ГИ ВИДАМ СИТЕ ЧЕТИРИ');
  assert.equal(h.asks.length, 4, `every owner asked in one round: ${JSON.stringify(h.asks)}`);

  // Two flats fit the day (17 + 18); the other two can only do the morning, so
  // every question about a linking hour is refused and they stay out of it.
  await h.answer(82, 'MOZE', 'Петок во 17:00');
  await h.answer(84, 'MOZE', 'Петок во 18:00');
  const offer = await h.refuseUntilOffer({ 88: '12:00', 59: '09:00' });
  assert.match(offer, /17:00/u, `the route is offered: ${offer}`);
  assert.match(offer, /18:00/u, offer);
  assert.match(offer, /88/u, `the first deferred flat is named: ${offer}`);
  assert.match(offer, /59/u, `…and so is the second: ${offer}`);
  assert.match(offer, /друг термин/u, `promised, not dropped: ${offer}`);

  const afterBooking = await h.say('ДА, ГИ ПОТВРДУВАМ');
  assert.equal(h.appointments.listByChat(h.chatId).length, 2, 'the two that fit are booked');
  assert.match(afterBooking, /88/u, `the deferred pair is the next question: ${afterBooking}`);
  assert.match(afterBooking, /59/u, afterBooking);

  // HIS NEXT TERM IS A ROUTE OVER THE DEFERRED PAIR — not two separate visits.
  const before = h.asks.length;
  await h.say('ВТОРНИК ВО 14:00');
  const round = h.asks.slice(before);
  assert.equal(round.length, 2, `one parallel round for the deferred pair: ${JSON.stringify(round)}`);
  assert.deepEqual(round.map(a => a.eb).sort((a, b) => a - b), [59, 88], 'exactly the deferred flats');
  assert.match(round[0]!.text, /14:00/u, `the client's hour starts the new route: ${round[0]!.text}`);
  assert.match(round[1]!.text, /15:00/u, `and the next stop one hour later: ${round[1]!.text}`);
  for (const a of round) {
    assert.doesNotMatch(a.text, /број (?:82|84)/u, `a booked flat is never re-asked: ${a.text}`);
  }
  // The first day's bookings are untouched by the new negotiation.
  const booked = h.appointments.listByChat(h.chatId);
  assert.deepEqual(booked.map((a: { propertyId: number }) => a.propertyId).sort((x: number, y: number) => x - y), [82, 84]);

  // Both owners agree → the client gets the second day's route, and his yes
  // books it; the first route stays as it was.
  await h.answer(88, 'MOZE', 'Вторник во 14:00');
  await h.answer(59, 'MOZE', 'Вторник во 15:00');
  const secondOffer = h.sent.at(-1) ?? '';
  assert.match(secondOffer, /14:00/u, `the second route is offered: ${secondOffer}`);
  assert.match(secondOffer, /15:00/u, secondOffer);
  await h.say('ДА');
  const all = h.appointments.listByChat(h.chatId);
  assert.equal(all.length, 4, `nobody is dropped: ${JSON.stringify(all.map((a: { propertyId: number; visitAt: string }) => [a.propertyId, a.visitAt]))}`);
  assert.deepEqual(all.map((a: { propertyId: number }) => a.propertyId).sort((x: number, y: number) => x - y), [59, 82, 84, 88]);
  const s = h.sessions.get(h.chatId)!;
  assert.equal(s.slots.visitPlan, undefined, 'the flow is finished, not left half-open');
});

test('[deferred route] ONE deferred flat keeps the ordinary single visit', async () => {
  const h = makeHandler([82, 84, 88]);
  h.seed();
  await h.say('ПЕТОК ВО 17:00, САКАМ ДА ГИ ВИДАМ СИТЕ ТРИ');
  await h.answer(82, 'MOZE', 'Петок во 17:00');
  await h.answer(84, 'MOZE', 'Петок во 18:00');
  const offer = await h.refuseUntilOffer({ 88: '12:00' });
  assert.match(offer, /88/u, `the deferred flat is named: ${offer}`);
  await h.say('ДА, ГИ ПОТВРДУВАМ');
  assert.equal(h.appointments.listByChat(h.chatId).length, 2);

  // One flat is one visit, not a "route": a single owner is asked, once.
  const before = h.asks.length;
  await h.say('ВТОРНИК ВО 14:00');
  const round = h.asks.slice(before);
  assert.equal(round.length, 1, `a single visit asks one owner: ${JSON.stringify(round)}`);
  assert.equal(round[0]!.eb, 88, JSON.stringify(round));
  assert.equal(h.sessions.get(h.chatId)!.slots.visitPlan, undefined, 'no route for one flat');
});
