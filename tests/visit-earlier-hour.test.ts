// THE [00:59] CAPTURE — the ping-pong went off with the brain.
//
//   [00:58] CEETVRTOK POPLADNE            → the client proposes a day
//   [00:58] PA OKOLU 5                    → and an hour  → owner_checking
//   [00:59] ЛИНА: owner can't do it, he proposes Петок 18:00
//   [00:59] DALI KE MOZE PORANO MALCE . NAKAJ 5 ?
//   [00:59] ЛИНА: Тоа се наоѓа во близина на ООУ Лазар Трповски. <maps pin>
//
// Two defects, one message:
//   1. «накај 5» was not a CLOCK on the client side (the owner-side parser has
//      read «NAKAJ 4» since the [17:45] rule), so the turn carried no time at
//      all and never reached the owner;
//   2. «накај» is a SIDE trigger, so the SURROUNDINGS lane claimed a
//      scheduling message and served the property's landmark + a maps pin.
//
// The client asked for an hour EARLIER than the owner's 18:00 — around 5, i.e.
// 17:00 — so the owner must be asked about 17:00, on the owner's own day, and
// the client must never read a landmark.
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
import { LandmarkService } from '../src/geo/landmarks';
import { LlmClient } from '../src/llm/types';
import { detectVisitTime, detectSurroundingsAsk } from '../src/llm/deterministic';
import { parseVisitDateTime, hasClockHint, outsideVisitWindow } from '../src/visits/time';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 78, id: 78, location: 'Центар', price: 36000, service: 'buy', sqm: 74, size: '74 м²',
    address: 'Партизерска 10', lat: 41.996, lon: 21.428, geo_source: 'stored' } as Property,
];

const NOW = new Date(2026, 10, 2, 0, 55, 0); // the capture's night, pinned

async function makeHandler() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(llm, cfg, properties),
    responder: new Responder(llm, cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  const ownerAsks: string[] = [];
  handler.onOwnerAsk = (_c: string, eb: number, q: string) => { ownerAsks.push(`${eb}: ${q}`); };
  const send = async (m: string) => { await handler.handle('test', 'relay', m); return sessions.get('relay')!; };
  return { handler, sessions, sent, send, ownerAsks };
}

// interest → availability → owner contact → fee agree → contact → proposed term
async function reachProposedTerm(send: (m: string) => Promise<any>): Promise<void> {
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA');
  await send('DA, SE SOGLASUVAM');
  await send('ZORAN 078/914 196');
  // The capture's own split: the day+part, then the hour — the two must merge
  // into ONE term before the owner is pinged.
  await send('CETVRTOK POPLADNE');
  const s = await send('PA OKOLU 5');
  assert.equal(s.state, 'owner_checking', `setup failed: ${s.state}`);
}

test('[00:59] «накај 5» is a clock — the earlier-hour request is a time, in both scripts', () => {
  const phrases = [
    'DALI KE MOZE PORANO MALCE . NAKAJ 5 ?',
    'дали ќе може порано малце . накај 5 ?',
    'dali ke moze porano malce . nakaj 5 ?',
    'NAKAJ 5',
    'накај 5',
  ];
  for (const phrase of phrases) {
    assert.equal(hasClockHint(phrase), true, `no clock hint: ${phrase}`);
    assert.ok(detectVisitTime(phrase) !== undefined, `the client's time is not captured: ${phrase}`);
    const d = parseVisitDateTime(phrase, NOW);
    assert.ok(d, `not parsed: ${phrase}`);
    assert.equal(d!.getHours(), 17, `«накај 5» is 17:00 (the visit window): ${phrase}`);
    assert.equal(outsideVisitWindow(phrase, NOW), false, `inside the window: ${phrase}`);
  }
  // The surrounding forms keep their lanes: a bare «накај» with a PLACE is still
  // a side question, and an earlier/later word with no hour changes nothing.
  assert.equal(hasClockHint('накај Центар'), false, 'a place after накај is not a clock');
});

test('[00:59] a clock is never a SIDE question — the surroundings lane stands down', () => {
  const scheduling = [
    'DALI KE MOZE PORANO MALCE . NAKAJ 5 ?',
    'дали ќе може порано малце . накај 5 ?',
    'MOZE MALCE PORANO, NAKAJ 4',
    'pokasno 7:30 ?',
  ];
  for (const t of scheduling) {
    assert.equal(detectSurroundingsAsk(t), undefined, `a time was read as a side question: ${t}`);
  }
  // …while a genuine side ask is untouched (the [01:29] family).
  const side = detectSurroundingsAsk('od stranata na trgovskiот ili odkaj pazarceto');
  assert.ok(side, 'the side lane must survive');
  assert.ok(side!.anchors.length >= 2, `both named places: ${JSON.stringify(side)}`);
  assert.ok(detectSurroundingsAsk('на која страна е ?'), 'a side ask with no place still fires');
});

test('e2e [00:59]: an hour earlier than the owner\'s is PROPOSED TO THE OWNER — never a landmark', async () => {
  const { handler, sessions, sent, send, ownerAsks } = await makeHandler();
  await reachProposedTerm(send);
  assert.equal(ownerAsks.length, 1, `the first term reaches the owner: ${JSON.stringify(ownerAsks)}`);

  // [00:59] the owner cannot do the proposed term and counters with Петок 18:00.
  handler.ownerAnswer('relay', 78, { status: 'counter', ownerTime: 'Петок 18:00' });
  await new Promise(r => setTimeout(r, 80));
  assert.equal(sessions.get('relay')!.state, 'time_confirm', 'the counter is the term on the table');

  const before = sent.length;
  const asksBefore = ownerAsks.length;
  const s = await send('DALI KE MOZE PORANO MALCE . NAKAJ 5 ?');
  const reply = sent[sent.length - 1] ?? '';

  // 1. The client never reads a location — the field's landmark + maps pin was
  //    an answer to a question about TIME.
  assert.ok(!/во близина на|maps\.google|населбата|https?:\/\//iu.test(reply),
    `a scheduling message was answered with a PLACE: ${reply.slice(0, 200)}`);

  // 2. The owner is pinged with the requested hour, on HIS day (Петок) — the
  //    client moves the hour, not the day.
  assert.equal(ownerAsks.length, asksBefore + 1, `the owner must be asked again: ${JSON.stringify(ownerAsks)}`);
  const ask = ownerAsks[ownerAsks.length - 1];
  assert.match(ask, /17:00/u, `the earlier hour must be the proposal: ${ask}`);
  assert.match(ask, /Петок/u, `the owner's day must ride the new hour: ${ask}`);
  // 18:00 MUST appear — as the term the client cannot do (the follow-up
  // contract), never as the proposal. Asserting its absence was wrong: the
  // first draft of this test demanded a sentence the relay is required to
  // carry.
  const proposed = ask.split(/Има друг предлог\s*[:：]/u)[1] ?? '';
  assert.ok(proposed, `the ask must name a NEW proposal: ${ask}`);
  assert.match(proposed, /17:00/u, `the proposal is the earlier hour: ${ask}`);
  assert.doesNotMatch(proposed, /18:00/u, `the proposal must not be the refused 18:00: ${ask}`);

  // 3. The ping-pong is alive: the check is in flight and the turn produced
  //    ONE client-facing line.
  assert.equal(s.state, 'owner_checking', `the owner check must be armed: ${s.state}`);
  assert.equal(sent.length, before + 1, `one message to the client: ${sent.slice(before).join(' | ')}`);
});
