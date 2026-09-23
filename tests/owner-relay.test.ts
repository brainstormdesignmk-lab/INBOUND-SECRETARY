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
import { mkTimePhrase } from '../src/data/properties';
import { detectOwnerVerdict, detectWorkdaysQuestion, detectVisitTime } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 78, id: 78, location: 'Центар', price: 36000, service: 'buy', sqm: 74, size: '74 м²', address: 'Партизерска 10', lat: 41.996, lon: 21.428, geo_source: 'stored' } as Property,
];

async function makeHandler() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels, landmarks: undefined,
  });
  const send = async (m: string) => { await handler.handle('test', 'relay', m); return sessions.get('relay')!; };
  return { handler, sessions, sent, send };
}

// Reusable setup: interest → fee → agree → contact → proposed time → owner_checking
async function reachOwnerChecking(send: (m: string) => Promise<any>): Promise<void> {
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA'); // confirm owner contact
  await send('DA, SE SOGLASUVAM'); // fee agree
  await send('ZORAN 078/914 196'); // contact
  const s = await send('UTRE POPLADNE POSLE 6'); // proposed time → owner_checking
  assert.equal(s.state, 'owner_checking', `setup failed: ${s.state}`);
}

test('mkTimePhrase: English day canonizations render Macedonian in client-facing relays', () => {
  assert.equal(mkTimePhrase('Friday 18:00'), 'Петок 18:00');
  assert.equal(mkTimePhrase('friday 18:00'), 'Петок 18:00');
  assert.equal(mkTimePhrase('saturday posle 5'), 'Сабота posle 5');
  assert.equal(mkTimePhrase('Петок во 18:00'), 'Петок во 18:00'); // untouched
  assert.equal(mkTimePhrase('VO NEDELA RABOTITE ?'), 'VO NEDELA RABOTITE ?'); // mixed-script untouched
});

test('whole-day counter: owner offers a day with any hour → relay carries the day, asks the client for the clock', async () => {
  const { handler, sessions, sent, send } = await makeHandler();
  await reachOwnerChecking(send);

  // THE 20:24 FIELD TEXT: refusal + day proposal with NO clock.
  const verdict = detectOwnerVerdict('NE MOZAM VO 6 VO PETOK . CEL DEN SUM ZAUZET. KE MORA VO SABOTA . BILO KOE VREME', 'Утре попладне после 6');
  assert.ok(verdict, 'owner text must parse');
  assert.equal(verdict.status, 'counter');
  assert.match(verdict.ownerTime ?? '', /сабот/i, `the day proposal must survive: ${JSON.stringify(verdict)}`);
  assert.equal(verdict.canAcceptWholeDay, true, 'day-only counter must flag canAcceptWholeDay');

  // The verdict lands in the pipeline → the relay carries the day + clock ask
  handler.ownerAnswer('relay', 78, verdict);
  await new Promise(r => setTimeout(r, 50));
  const s = sessions.get('relay')!;
  assert.equal(s.state, 'visit_scheduling', `relay must return to visit_scheduling, got ${s.state}`);
  const relay = sent[sent.length - 1];
  assert.match(relay, /сабот/iu, `relay must carry the owner's day: ${relay}`);
  assert.match(relay, /часот\s*\?|кога точно|кое време|колку часот|кога би дојделе/u, `relay must ask the client to precise the clock: ${relay}`);
  assert.ok(!/не може во тој термин(?!.*сабот)/iu.test(relay), `never the dropped-day refusal: ${relay}`);
});

test('workdays question never reaches the owner — answered from the bank, then scheduling continues', async () => {
  const { handler, sessions, sent, send } = await makeHandler();
  await reachOwnerChecking(send);

  assert.equal(detectWorkdaysQuestion('VO NEDELA RABOTITE ?'), true, 'the 20:26 field text must fire');
  assert.equal(detectVisitTime('VO NEDELA RABOTITE ?'), undefined, 'and must never be captured as a slot');

  const s = await send('VO NEDELA RABOTITE ?');
  assert.equal(s.state, 'owner_checking', 'the pending owner check must stay alive');
  const reply = sent[sent.length - 1];
  assert.match(reply, /понеделник|петок/u, `agency hours must be answered: ${reply}`);
  assert.match(reply, /сабота и недела|неработн|не работиме|затворен|не е можно/iu, `closed days must be stated: ${reply}`);
  // The owner ask must NOT echo the hours question as a proposed term
  // (the previous owner ask carried the visit time, not this question).
  assert.ok(!sent.some(t => /сака посета: VO NEDELA/u.test(t)), `hours question must never be forwarded to the owner`);
});

test('workdays question still fires without a question mark ("rabotite vo nedela")', () => {
  assert.equal(detectWorkdaysQuestion('rabotite vo nedela'), true);
  assert.equal(detectWorkdaysQuestion('dali rabotite vo sabota'), true);
  assert.equal(detectVisitTime('rabotite vo nedela'), undefined);
});

test('workdays detector never eats slot proposals or acceptances', () => {
  assert.equal(detectWorkdaysQuestion('VO PETOK BI MOZELA POSLE 5'), false, 'slot proposal with clock-context must stay a slot');
  assert.equal(detectWorkdaysQuestion('VO SABOTA VO 10 E SUPER'), false, 'acceptance of a proposed term stays a slot');
  assert.equal(detectWorkdaysQuestion('rabotite od 9 do 17'), false, 'carries a clock → not a days question');
});

test('whole-day sweep round 2: obligation anchor, whenever idioms, inflected day forms', () => {
  // ke-mora obligation inside the refusal clause — the scope rule must not
  // discard the offered day
  const km = detectOwnerVerdict('Nemozam togas ke mora vo nedela, sloboden sum bilokoga', 'Утре во 18:00');
  assert.equal(km?.status, 'counter');
  assert.equal(km?.canAcceptWholeDay, true);
  assert.match(km?.ownerTime ?? '', /недел/i);
  // Latin disagreement + whenever idiom
  const lat = detectOwnerVerdict('ne mi odgovara toj den, vikendov moze koga bilo', 'Утре во 18:00');
  assert.equal(lat?.canAcceptWholeDay, true);
  assert.match(lat?.ownerTime ?? '', /викенд/i);
  // Range idiom must not let the day-part steal the carrier ("Среда вечер" was fabricated)
  const range = detectOwnerVerdict('Зафатен сум тогаш, во среда сум слободен од сабајле до вечер.', 'Утре во 18:00');
  assert.equal(range?.canAcceptWholeDay, true);
  assert.ok(!/вечер/.test(range?.ownerTime ?? ''), `range endpoint must not become the term: ${range?.ownerTime}`);
  // "ne e mozno" + sloboden must NEVER ok on the refused time
  const okTrap = detectOwnerVerdict('ne e mozno togas. vo petk cel den sum sloboden bilo koe vreme.', 'Утре во 18:00');
  assert.equal(okTrap?.status, 'counter');
  assert.equal(okTrap?.canAcceptWholeDay, true);
});

test('fixed counters and refusals never gain the whole-day flag', () => {
  // No anytime idiom, no refusal: a bare positive day is a FIXED counter
  const fixed = detectOwnerVerdict('vo petok mozam', 'Утре во 18:00');
  assert.equal(fixed?.status, 'counter');
  assert.equal(fixed?.canAcceptWholeDay, undefined);
  // Refused day without an alternative: bare counter, no day at all
  const bare = detectOwnerVerdict('ne mozam utre vo 4', 'Утре во 4');
  assert.equal(bare?.status, 'counter');
  assert.equal(bare?.ownerTime, undefined);
  // Clock counter stays fixed
  const clock = detectOwnerVerdict('ne, samo vo petok vo 11', 'Утре во 18:00');
  assert.equal(clock?.canAcceptWholeDay, undefined);
  assert.match(clock?.ownerTime ?? '', /Петок во 11/);
});

test('mkTimePhrase canonicalizes owner day misspellings in both scripts', () => {
  assert.equal(mkTimePhrase('Средота'), 'Среда');
  assert.equal(mkTimePhrase('Сабота'), 'Сабота');
  assert.equal(mkTimePhrase('sabta'), 'Сабота');
  assert.equal(mkTimePhrase('sredta vo 6'), 'Среда vo 6');
  assert.equal(mkTimePhrase('Петк'), 'Петок');
  assert.equal(mkTimePhrase('Црногорска амбасада'), 'Црногорска амбасада'); // non-day text untouched
  assert.equal(mkTimePhrase('Friday 18:00'), 'Петок 18:00'); // English-day path intact
});

test('fixed counter with clock still relays a precise term (regression guard)', async () => {
  const { handler, sessions, sent, send } = await makeHandler();
  await reachOwnerChecking(send);
  const verdict = detectOwnerVerdict('ne, samo vo petok vo 11', 'Утре попладне после 6')!;
  assert.equal(verdict.status, 'counter');
  assert.equal(verdict.canAcceptWholeDay, undefined);
  handler.ownerAnswer('relay', 78, verdict);
  await new Promise(r => setTimeout(r, 50));
  const s = sessions.get('relay')!;
  assert.equal(s.state, 'time_confirm');
  assert.match(sent[sent.length - 1], /Петок во 11/u);
});
