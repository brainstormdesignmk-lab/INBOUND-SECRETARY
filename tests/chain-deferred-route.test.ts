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
  // MIDDAY-ONLY OWNERS AGAINST A LATE-AFTERNOON DAY: 12:00 and 13:00 sit more
  // than three hours before the client's 17:00, so they cannot join Friday —
  // but on the new day (14:00 anchor) they link. THE HOURS THEY GAVE ON THE
  // MISSED DAY ARE THE ONES THE NEXT DAY ASKS FIRST (`slots.deferHours`): the
  // owner is never asked the anchor hour he already refused.
  const offer = await h.refuseUntilOffer({ 88: '12:00', 59: '13:00' });
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
  const asked = new Map(round.map(a => [a.eb, a.text]));
  assert.match(asked.get(88)!, /12:00/u, `his own earlier hour leads: ${asked.get(88)}`);
  assert.match(asked.get(59)!, /13:00/u, `…and so does his: ${asked.get(59)}`);
  assert.doesNotMatch(asked.get(88)!, /14:00/u, `the anchor hour he refused is not re-asked: ${asked.get(88)}`);
  for (const a of round) {
    assert.doesNotMatch(a.text, /број (?:82|84)/u, `a booked flat is never re-asked: ${a.text}`);
  }
  // The first day's bookings are untouched by the new negotiation.
  const booked = h.appointments.listByChat(h.chatId);
  assert.deepEqual(booked.map((a: { propertyId: number }) => a.propertyId).sort((x: number, y: number) => x - y), [82, 84]);

  // Both owners agree → the client gets the second day's route, and his yes
  // books it; the first route stays as it was.
  // Both owners agree at their own hours; the negotiator may then chase ONE
  // better start (its lookahead, the same rule as the first day), so every
  // following question is answered yes until the client hears the offer.
  await h.answer(88, 'MOZE', 'Вторник во 12:00');
  await h.answer(59, 'MOZE', 'Вторник во 13:00');
  let secondOffer = h.sent.at(-1) ?? '';
  for (let i = 0; i < 6 && secondOffer === ''; i++) {
    const plan = h.sessions.get(h.chatId)!.slots.visitPlan;
    const open = plan?.stops.filter(z => z.status === 'asked' && z.askedHour !== undefined) ?? [];
    if (open.length === 0) { secondOffer = h.sent.at(-1) ?? ''; break; }
    for (const stop of open) {
      const client = await h.answer(stop.eb, 'MOZE',
        `Вторник во ${String(stop.askedHour).padStart(2, '0')}:00`);
      if (client) { secondOffer = client; break; }
    }
  }
  assert.match(secondOffer, /88/u, `the second route is offered: ${secondOffer}`);
  assert.match(secondOffer, /59/u, secondOffer);
  assert.match(secondOffer, /Посети по ред/ui, `…as a route, not a single visit: ${secondOffer}`);
  await h.say('ДА');
  const all = h.appointments.listByChat(h.chatId);
  assert.equal(all.length, 4, `nobody is dropped: ${JSON.stringify(all.map((a: { propertyId: number; visitAt: string }) => [a.propertyId, a.visitAt]))}`);
  assert.deepEqual(all.map((a: { propertyId: number }) => a.propertyId).sort((x: number, y: number) => x - y), [59, 82, 84, 88]);
  const s = h.sessions.get(h.chatId)!;
  assert.equal(s.slots.visitPlan, undefined, 'the flow is finished, not left half-open');
});

test('[cross-day] re-solving the second day never moves a booking from the first', async () => {
  const h = makeHandler();
  h.seed();
  await h.say('ПЕТОК ВО 17:00, САКАМ ДА ГИ ВИДАМ СИТЕ ЧЕТИРИ');
  await h.answer(82, 'MOZE', 'Петок во 17:00');
  await h.answer(84, 'MOZE', 'Петок во 18:00');
  // Two owners who can only do midday: deferred from Friday, their hours kept.
  const offer = await h.refuseUntilOffer({ 88: '12:00', 59: '13:00' });
  assert.match(offer, /17:00/u, offer);
  await h.say('ДА, ГИ ПОТВРДУВАМ');
  // The STORED TERM is what the owner and the client were told (the scheduler
  // fills `visitAt` in production; this harness has no scheduler), so that is
  // what "unchanged" has to mean here.
  const day1 = h.appointments.listByChat(h.chatId)
    .map((a: { propertyId: number; time: string }) => [a.propertyId, a.time]);
  assert.equal(day1.length, 2, JSON.stringify(day1));

  // DAY TWO: one owner keeps 12:00, the other can only do 15:00 — a two-hour
  // pause, not a shift. The re-solve is the SECOND day's business only.
  const before = h.asks.length;
  await h.say('ВТОРНИК ВО 14:00');
  assert.equal(h.asks.length - before, 2, 'the owed pair asked in one round');
  const secondOffer = await h.refuseUntilOffer({ 88: '12:00', 59: '15:00' });
  assert.match(secondOffer, /12:00/u, `the pause route is offered: ${secondOffer}`);
  assert.match(secondOffer, /15:00/u, secondOffer);
  assert.match(secondOffer, /пауза/u, `the pause is NAMED to the client: ${secondOffer}`);
  await h.say('ДА');

  const all = h.appointments.listByChat(h.chatId)
    .map((a: { propertyId: number; time: string }) => [a.propertyId, a.time]);
  assert.equal(all.length, 4, `both days are booked: ${JSON.stringify(all)}`);
  // THE FIRST DAY IS BYTE-IDENTICAL — a later day's negotiation is never a
  // reason to move an appointment an owner already confirmed.
  for (const [eb, at] of day1) {
    assert.ok(all.some(([e, a]) => e === eb && a === at),
      `Friday's booking ${eb}@${at} moved: ${JSON.stringify(all)}`);
  }
  const tuesday = all.filter(([eb]) => eb === 88 || eb === 59).map(([, at]) => String(at));
  assert.equal(tuesday.length, 2, JSON.stringify(tuesday));
  assert.ok(tuesday.every(at => at.includes('12:00') || at.includes('15:00')),
    `the second day keeps its own hours: ${JSON.stringify(tuesday)}`);
  assert.notEqual(tuesday[0], tuesday[1], 'the two visits are not at the same instant');
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
