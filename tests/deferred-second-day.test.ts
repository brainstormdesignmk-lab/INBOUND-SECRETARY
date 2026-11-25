// A SECOND MISSED DAY IS A DECISION, NOT A THIRD ATTEMPT.
//
// The owner who could only do 09:00 missed Friday (the client's day started at
// 17:00) and then missed Tuesday (his anchor 14:00). Asking the same man into
// the same chain a third time is the loop the route was meant to end — so:
//
//   * the hours he gave on the missed day are REMEMBERED (`slots.deferHours`)
//     and aim the next day's question at HIS hour (never the anchor he refused);
//   * a flat that now misses twice goes SOLO (`slots.soloEbs`): arranged on its
//     own, never chained again — and the copy says so;
//   * the client can RELEASE it («остави го»), because the offer must mean
//     something: the flat leaves the owed notebooks and the next term cannot
//     book it;
//   * a flat is owed only until it is BOOKED — the single-visit booking clears
//     the notebooks too, so a later plural term cannot re-chain a seen flat.
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
import { detectOwnerVerdict, detectParkVisit } from '../src/llm/deterministic';
import { planAsks } from '../src/visits/negotiate';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('probe: LLM disabled'); }
}

// THE DAY NAMES ARE DATA, NOT LITERALS (fixed 2026-11-24, a Tuesday): with
// «ВТОРНИК» hardcoded, the second-day scenario ran on TODAY every Tuesday — the
// term resolved to the same date as day one, the flow took another branch, and
// the owner's remembered 09:00 never led (the assertion saw the client's 14:00
// anchor instead). The scenario needs two days that are ALWAYS in the future,
// ALWAYS ordered — and ALWAYS working days, because the agency works Mon–Fri
// (`isWeekendTerm`, src/visits/time.ts) and a Saturday/Sunday term is answered
// with the working-hours protocol instead of a visit (a Thursday base resolved
// day 2 to Saturday and the round never happened). Spellings come from the
// handler's own DAY_FORMS: «ЧЕТВОРТОК»/«ПОНЕДЕЛК» are not Macedonian words.
const MK_DAYS = ['НЕДЕЛА', 'ПОНЕДЕЛНИК', 'ВТОРНИК', 'СРЕДА', 'ЧЕТВРТОК', 'ПЕТОК', 'САБОТА'];
const nextWorkdays = (n: number): string[] => {
  const out: string[] = [];
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  while (out.length < n) {
    d.setDate(d.getDate() + 1);
    if (d.getDay() >= 1 && d.getDay() <= 5) out.push(MK_DAYS[d.getDay()]);
  }
  return out;
};
const [DAY1, DAY2, DAY3] = nextWorkdays(3);
const titleDay = (d: string): string => d.charAt(0) + d.slice(1).toLowerCase();

const ROWS: Property[] = [82, 84, 88].map(eb => ({
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
    properties,
    appointments, escalations: new EscalationStore(db), meta: new MetaStore(db), channels,
  });
  const asks: Array<{ eb: number; text: string }> = [];
  handler.onOwnerAsk = (_c, eb, q) => asks.push({ eb, text: q });
  const chatId = 'second-miss';
  const say = async (m: string): Promise<string> => {
    sent.length = 0;
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  const seed = () => {
    const s = freshSession('test', chatId);
    s.state = 'visit_scheduling';
    s.slots.service = 'buy';
    s.slots.currentBatch = [82, 84, 88];
    s.slots.presentedIds = [82, 84, 88];
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
  /** Answer every owner whose question is in flight with the hour he can do,
   *  until the CLIENT hears something (a parallel round asks several at once). */
  const answerRound = async (hours: Record<number, string>): Promise<string> => {
    for (let i = 0; i < 10; i++) {
      const plan = sessions.get(chatId)?.slots.visitPlan;
      const open = plan?.stops.filter(z => z.status === 'asked' && z.askedHour !== undefined) ?? [];
      if (open.length === 0) return '';
      for (const stop of open) {
        // The map carries the owner's whole sentence (an hour he can do, or
        // «not that day»), so the verdict is the one the owner would really give.
        const client = await answer(stop.eb, hours[stop.eb] ?? 'SAMO VO 12:00',
          `${titleDay(DAY1)} во ${String(stop.askedHour).padStart(2, '0')}:00`);
        if (client) return client;
      }
    }
    return '';
  };
  return { handler, sessions, sent, asks, chatId, say, seed, answer, answerRound, appointments };
}

test('[second miss] a day nobody can do is a miss; the second one goes solo and can be released', async () => {
  const h = makeHandler();
  h.seed();
  await h.say(`${DAY1} ВО 17:00, САКАМ ДА ГИ ВИДАМ СИТЕ ТРИ`);
  assert.equal(h.asks.length, 3, `one parallel round: ${JSON.stringify(h.asks.map(a => a.eb))}`);
  // 82 can do the day; 84 and 88 cannot («not that day» carries no alternative
  // hour, so there is nothing to solve them onto this day).
  await h.answer(82, 'MOZE', `${titleDay(DAY1)} во 17:00`);
  const offer = await h.answerRound({ 84: 'НЕ МОЖАМ ТОЈ ДЕН', 88: 'НЕ МОЖАМ ТОЈ ДЕН' });
  assert.match(offer, /17:00/u, `the visit that fits is offered: ${offer}`);
  await h.say('ДА, ГО ПОТВРДУВАМ');
  assert.equal(h.appointments.listByChat(h.chatId).length, 1);
  const s1 = h.sessions.get(h.chatId)!;
  assert.deepEqual(s1.slots.visitEbs, [84, 88], 'the missed flats are owed, in the client\'s order');
  assert.equal(s1.slots.deferCounts?.[84], 1, 'one miss remembered');
  assert.equal(s1.slots.deferCounts?.[88], 1, 'per flat, not per chat');
  assert.deepEqual(s1.slots.deferHours?.[84], undefined, 'no hour was given — nothing to remember');

  // DAY TWO: 2+ owed = a route over them; both say "not that day" again, so
  // nobody can be placed at all. That is the SECOND miss for both.
  const before = h.asks.length;
  await h.say(`${DAY2} ВО 14:00`);
  const day2 = h.asks.slice(before);
  assert.deepEqual(day2.map(a => a.eb).sort((x, y) => x - y), [84, 88],
    `one parallel round for the owed pair: ${JSON.stringify(day2)}`);
  const secondMiss = await h.answerRound({ 84: 'НЕ МОЖАМ ТОЈ ДЕН', 88: 'НЕ МОЖАМ ТОЈ ДЕН' });
  assert.match(secondMiss, /84/u, `the owed flats are named: ${secondMiss}`);
  assert.match(secondMiss, /88/u, secondMiss);
  assert.match(secondMiss, /и по втор ден/u, `the second miss is said out loud: ${secondMiss}`);
  assert.match(secondMiss, /остави го/u, `and the release is offered: ${secondMiss}`);
  assert.match(secondMiss, /Кој ден и час/ui, `the term is still asked for: ${secondMiss}`);
  const s2 = h.sessions.get(h.chatId)!;
  assert.equal(s2.slots.deferCounts?.[84], 2);
  assert.equal(s2.slots.deferCounts?.[88], 2);
  assert.deepEqual(s2.slots.soloEbs, [84, 88], 'flats that missed twice go solo');
  assert.equal(s2.slots.visitWanted, undefined, 'they are no longer chained');

  // RELEASING ONE keeps the other owed.
  const released = await h.say('остави го 84');
  assert.match(released, /84/u, `the release is confirmed: ${released}`);
  assert.match(released, /88/u, `the other flat is still owed: ${released}`);
  const s3 = h.sessions.get(h.chatId)!;
  assert.deepEqual(s3.slots.soloEbs, [88], 'only the named flat was released');
  assert.deepEqual(s3.slots.visitEbs, undefined);
  assert.equal(s3.slots.deferCounts?.[84], undefined, 'the miss memory goes with it');
  assert.equal(s3.slots.deferCounts?.[88], 2, 'the other flat keeps its history');

  // Releasing the last one clears the subject — a later term is not the
  // released flat's.
  const all = await h.say('остави го 88');
  assert.match(all, /88/u, all);
  const s4 = h.sessions.get(h.chatId)!;
  assert.equal(s4.slots.soloEbs, undefined);
  assert.equal(s4.slots.propertyId, undefined, 'nothing is the subject any more');
  const asksBefore = h.asks.length;
  await h.say(`${DAY3} ВО 11:00`);
  const later = h.asks.slice(asksBefore);
  assert.equal(later.filter(a => a.eb === 84 || a.eb === 88).length, 0,
    `released flats are never asked again: ${JSON.stringify(later)}`);
});

test('[second day] a flat that missed a day is asked at its OWNER\'s hour', async () => {
  const h = makeHandler();
  h.seed();
  await h.say(`${DAY1} ВО 17:00, САКАМ ДА ГИ ВИДАМ СИТЕ ТРИ`);
  await h.answer(82, 'MOZE', `${titleDay(DAY1)} во 17:00`);
  await h.answer(84, 'MOZE', `${titleDay(DAY1)} во 18:00`);
  // 88 can only do 09:00 (five hours before the client's 17:00) — deferred, and
  // the hour he gave is remembered even though this day cannot hold it.
  const offer = await h.answerRound({ 88: 'SAMO VO 09:00' });
  assert.match(offer, /17:00/u, offer);
  await h.say('ДА, ГО ПОТВРДУВАМ');
  const s1 = h.sessions.get(h.chatId)!;
  assert.deepEqual(s1.slots.deferHours?.[88], [9], 'his own hour is remembered');
  assert.equal(s1.slots.deferCounts?.[88], 1);

  // DAY TWO: one owed flat is ONE visit, and its owner is asked at his hour.
  const before = h.asks.length;
  await h.say(`${DAY2} ВО 14:00`);
  const day2 = h.asks.slice(before);
  assert.equal(day2.length, 1, JSON.stringify(day2));
  assert.match(day2[0]!.text, /09:00/u, `his own hour leads: ${day2[0]!.text}`);
  assert.doesNotMatch(day2[0]!.text, /14:00/u, `the anchor he refused is not re-asked: ${day2[0]!.text}`);
  // He agrees on the new date; the visit is booked and the notebooks clear.
  const asked = await h.answer(88, 'MOZE', `${titleDay(DAY2)} во 09:00`);
  assert.match(asked, /09:00/u, `the owner's hour reaches the client: ${asked}`);
  await h.say('ДА');
  const s2 = h.sessions.get(h.chatId)!;
  assert.equal(h.appointments.listByChat(h.chatId).filter((a: { propertyId: number }) => a.propertyId === 88).length, 1,
    'the owed flat is booked, not dropped');
  assert.equal(s2.slots.visitEbs, undefined, 'a booked flat is no longer owed');
  assert.equal(s2.slots.deferCounts?.[88], undefined, 'its miss history is cleared');
});

test('[park detector] only a release ABOUT a flat fires', () => {
  for (const yes of ['остави го', 'ОСТАВЕТЕ ГО', 'ne mi treba povekje', 'откажи го', 'не ми треба веќе тој']) {
    assert.equal(detectParkVisit(yes), true, yes);
  }
  for (const no of ['оставив кола пред зградата', 'остави порака', 'не ми требаат документи', 'да, сакам да го видам']) {
    assert.equal(detectParkVisit(no), false, no);
  }
});

test('[prefer] a never-asked stop is asked the hour he gave on an earlier day', () => {
  const asks = planAsks({
    targetHour: 14,
    stops: [{ eb: 88, prefer: [9] }, { eb: 84 }, { eb: 82 }],
  });
  assert.equal(asks.length, 3, JSON.stringify(asks));
  assert.equal(asks.find(a => a.eb === 88)?.hour, 9, `his own hour: ${JSON.stringify(asks)}`);
  // The plan itself is contiguous from the client's hour: 14, 15, 16 in the
  // stops' order — only the preferred stop breaks away from it.
  assert.equal(asks.find(a => a.eb === 84)?.hour, 15, JSON.stringify(asks));
  assert.equal(asks.find(a => a.eb === 82)?.hour, 16, JSON.stringify(asks));
});
