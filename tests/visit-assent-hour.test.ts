// THE [18:49] CAPTURE — «PA NEKA BIDE 5» is a CLOCK, not a non-answer.
//
//   [18:49] ЛИНА: … ми треба информација за точниот час … Во колку часот
//                планирате да дојдете?
//   [18:49] PA NEKA BIDE 5
//   [18:49] ЛИНА: Кој термин би Ви одговарал за посета?  ✗
//
// The client had ALREADY given the day («MOZAM VO PETOK») and then answered the
// exact-hour ask with a consent frame and a naked digit. No clock family read
// it — CLOCK_RE wants a preposition, HOUR_WORD_RE wants the hour noun — so the
// whole visit question came back and the owner was never asked.
//
// The contract pinned here, in one place (visits/time.ts owns the pattern, the
// detector and the parser both read it):
//  1. «neka bide / neka e / ajde neka bide» + a digit IS a clock;
//  2. the visit window decides AM/PM (5 → 17:00), like every other bare hour;
//  3. the stored DAY is donated to the clock completion, so the owner is asked
//     for Петок 17:00 — not for a clock on an invented day;
//  4. a money or room tail («neka bide 5 iljadi», «neka bide 5 spalni») is
//     NEVER an appointment.
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
import { LandmarkService } from '../src/geo/landmarks';
import { detectVisitTime, hasDayWord, isValidVisitTime } from '../src/llm/deterministic';
import { parseVisitDateTime, hasClockHint } from '../src/visits/time';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const ROWS: Property[] = [
  { eb: 57, id: 57, location: 'Центар', address: 'Ѓуро Стругар', price: 350,
    service: 'rent', bedrooms: 2, size: '55 м²' },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

// Friday 06.11.2026 09:00 — «VO PETOK» is TODAY, so the completion must stay on
// it and 5 must become 17:00.
const NOW = new Date(2026, 10, 6, 9, 0, 0);

test('[18:49] the assent family reads a bare hour as a clock', () => {
  for (const t of ['PA NEKA BIDE 5', 'NEKA BIDE 5', 'НЕКА БИДЕ 5', 'NEKA E 5',
    'AJDE NEKA BIDE 5', 'ајде нека биде 5', 'NEKA BIDE VO 5', 'neka bide 5 saat']) {
    assert.ok(detectVisitTime(t), `not read as a time: ${t}`);
    assert.ok(hasClockHint(t), `no clock hint: ${t}`);
    assert.ok(isValidVisitTime(t), `the validator refused the client's own time: ${t}`);
    assert.equal(hasDayWord(t), false, `a bare clock must not claim a day: ${t}`);
    const d = parseVisitDateTime(t, NOW);
    assert.ok(d, `unparsed: ${t}`);
    assert.equal(d!.getHours(), 17, `${t} must resolve to the visit window hour 17:00, got ${d!.toISOString()}`);
  }
});

test('[18:49] a money or room tail is never an appointment', () => {
  for (const t of ['NEKA BIDE 5 SPALNI', 'neka bide 5 iljadi', 'neka bide 5 evra', 'neka bide 5%']) {
    assert.equal(detectVisitTime(t), undefined, `read as a visit time: ${t}`);
    assert.equal(parseVisitDateTime(t, NOW), undefined, `parsed as a visit time: ${t}`);
  }
});

test('[18:49] e2e: «PA NEKA BIDE 5» completes Петок 17:00 and reaches the owner', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const props = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  const ownerAsks: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions,
    classifier: new Classifier(llm, cfg, props),
    responder: new Responder(llm, cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  handler.onOwnerAsk = (_c: string, _eb: number, q: string) => { ownerAsks.push(q); };
  const chatId = 'assent-hour';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 57');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA');
  await send('DA, SE SOGLASUVAM');
  await send('MARKO 078/914 196');
  let s = await send('MOZAM VO PETOK'); // day only — the exact-hour ask follows
  assert.equal(s.state, 'visit_scheduling');
  assert.ok(/колку|точ(?:н|ен)|час/iu.test(sent[sent.length - 1] ?? ''), `the exact-clock ask fires: ${sent[sent.length - 1]}`);

  // THE CAPTURE: the client answers the ask with a consent frame + a digit.
  s = await send('PA NEKA BIDE 5');
  assert.equal(s.state, 'owner_checking', `the answer is a term, not a non-answer: ${sent[sent.length - 1]}`);
  assert.ok(ownerAsks.length > 0, 'the owner is asked about the completed term');
  const ask = ownerAsks[ownerAsks.length - 1];
  assert.match(ask, /Петок, \d{2}\.\d{2}\.\d{4} во 17:00/u, `the owner reads Петок … 17:00: ${ask}`);
  // The stored term carries BOTH halves (day donated, clock completed) — one
  // phrase the next reader can resolve, never a day-less 5.
  assert.ok(hasDayWord(s.slots.visitTime ?? ''), `the day survived the merge: ${s.slots.visitTime}`);
  db.close();
});
