// TWO TURNS FROM THE [04:10]–[04:13] FIELD CAPTURE.
//
//  [04:10] the pair (84 и 77) was disclosed the visit fee — but with a SECOND
//          copy voice: «Посетата е за становите со Евидентни броеви 84 и 77
//          (Центар). Да, точно — 500 денари … за двете недвижности тоа е
//          вкупно 1.000 денари». The one-flat disclosure the owner calls
//          perfected («Одличен избор … Морам да Ве информирам …», a dozen bank
//          variants) was thrown away and a fixed sentence served in its place.
//          A visit to two flats is the SAME disclosure plus the arithmetic.
//
//  [04:13] «AMA OVA SE 1000 DEN ?» — the client challenged exactly the total he
//          had just been quoted. Nothing caught it: the viewing noun, the
//          charge verb and the value adjective are all absent, and the denar
//          figure was read as a 1.000-EURO BUDGET, so the search re-ran and the
//          turn answered «Ги исцрпивме двособни до 160.000 евра и трособни до
//          300.000 евра во Центар» — the second resistance never burned a rung
//          and the funnel left the fee entirely.

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
import { detectBudget, detectFeeNag } from '../src/llm/deterministic';
import { extendFeeAskForCount, buildFeeAsk } from '../src/llm/prompts';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('probe: LLM disabled'); }
}

const ROWS: Property[] = [
  { eb: 84, id: 84, location: 'Центар', address: 'Рузвелтова 84', price: 137000, bedrooms: 2, sqm: 48, size: '48 м²', service: 'buy', lat: 42.0002, lon: 21.4170, geo_source: 'google_cached', details: '' },
  { eb: 77, id: 77, location: 'Центар', address: 'Рузвелтова 77', price: 145000, bedrooms: 2, sqm: 55, size: '55 м²', service: 'buy', lat: 42.0003, lon: 21.4171, geo_source: 'google_cached', details: '' },
] as Property[];

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
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
  });
  const chatId = 'restate';
  const say = async (m: string): Promise<string> => {
    sent.length = 0;
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  // The [04:10] state: the pair presented, the fee not yet agreed.
  const seed = () => {
    const s = freshSession('test', chatId);
    s.state = 'presentation';
    s.slots.service = 'buy';
    s.slots.currentBatch = [84, 77];
    s.slots.presentedIds = [84, 77];
    s.slots.location = 'Центар';
    sessions.set(s);
    return s;
  };
  return { handler, sessions, chatId, say, seed };
}

test('[field] a denar figure is fee money, never a euro budget', () => {
  // The [04:13] read: «1000 DEN» became a 1.000-EUR cap.
  assert.equal(detectBudget('AMA OVA SE 1000 DEN ?'), undefined, 'denar money is not a euro cap');
  assert.equal(detectBudget('500 denari'), undefined);
  assert.equal(detectBudget('1500 денари месечно'), undefined, 'no rent cap invented either');
  // …and the euro reads are untouched.
  assert.equal(detectBudget('do 1500 evra'), '1500');
  assert.equal(detectBudget('1500 eura'), '1500');
});

test('[field] the restated fee in a challenge frame is a nag', () => {
  assert.equal(detectFeeNag('AMA OVA SE 1000 DEN  ?'), true, 'the capture sentence');
  assert.equal(detectFeeNag('OVA SE 1000 DEN ?'), true, 'without the «ама»');
  // A fee-sized figure in the challenge frame only: a PROPERTY price keeps its
  // own lane, and the magnitude ceiling is the same every fee arm uses.
  assert.equal(detectFeeNag('OVA SE 250000 DEN ?'), false, 'a property-sized denar figure is not the fee');
  assert.equal(detectFeeNag('ова е цената 1000 ден'), false, 'a PRICE noun moves the read to the flat');
  // A denar figure with no challenge frame stays a (fee) question, not a nag:
  // the amount/why lanes own it.
  assert.equal(detectFeeNag('1000 denari'), false);
});

test('[field] the two-flat disclosure KEEPS the served variant and adds the sum', () => {
  const single = buildFeeAsk('buy');
  const two = extendFeeAskForCount(single, 'buy', 2);
  assert.ok(two.startsWith(single.slice(0, single.indexOf('. ') + 1)),
    `the disclosure is kept verbatim, not replaced: ${two}`);
  assert.match(two, /За двете недвижности тоа е вкупно 1\.000 денари\./u, two);
  assert.ok(two.trimEnd().endsWith('?'), `the agreement ask still closes it: ${two}`);
  // One flat is untouched; three flats sum; the undeclared market names both
  // fees (never a defaulted 500 — the [09:0x] rule).
  assert.equal(extendFeeAskForCount(single, 'buy', 1), single);
  assert.match(extendFeeAskForCount(single, 'buy', 3), /вкупно 1\.500 денари/u);
  const anonymous = extendFeeAskForCount(buildFeeAsk(undefined), undefined, 2);
  assert.match(anonymous, /600 денари/u, `the rent half: ${anonymous}`);
  assert.match(anonymous, /1\.000 денари/u, `the buy half: ${anonymous}`);
});

test('[field] [04:10] the two-flat fee is the one-flat disclosure plus the sum', async () => {
  const h = makeHandler();
  h.seed();
  const reply = await h.say('SAKAM DA GI VIDAM DVATA');
  const s = h.sessions.get(h.chatId)!;
  assert.equal(s.state, 'closing', 'the fee protocol is open');
  assert.equal(s.slots.visitWanted, true, 'both flats are remembered');
  assert.match(reply, /84/u, `the first flat is named: ${reply}`);
  assert.match(reply, /77/u, `the second flat is named: ${reply}`);
  assert.match(reply, /вкупно 1\.000 денари/u, `the per-property sum: ${reply}`);
  assert.match(reply, /0%/u, `the buy commission framing survives: ${reply}`);
  // The perfected disclosure's OWN words — the fixed per-property sentence is
  // not a second voice mid-protocol (that is what the field served).
  assert.doesNotMatch(reply, /Да, точно —/u, `never the arithmetic-only voice: ${reply}`);
  assert.ok(reply.trimEnd().endsWith('?'), `it still ends with the agreement ask: ${reply}`);
});

test('[field] [04:13] the restated total burns a rung, never the drained-search line', async () => {
  const h = makeHandler();
  h.seed();
  await h.say('SAKAM DA GI VIDAM DVATA');
  const rung1 = await h.say('KAKO MISLIS PARI ZEMATE ZA RAZGLEDUVANJE ?');
  let s = h.sessions.get(h.chatId)!;
  assert.equal(s.slots.feeRejections, 1, `the first resistance is rung 1: ${rung1.slice(0, 120)}`);

  const reply = await h.say('AMA OVA SE 1000 DEN  ?');
  s = h.sessions.get(h.chatId)!;
  assert.equal(s.slots.feeRejections, 2, 'the second resistance is rung 2');
  assert.equal(s.slots.budget, undefined, 'the denar total is not a budget');
  assert.equal(s.state, 'closing', 'the funnel stays at the fee');
  assert.deepEqual(s.slots.currentBatch, [84, 77], 'no search was re-run');
  assert.doesNotMatch(reply, /исцрп|друга населба|друга категорија|погледнавме/iu,
    `never the drained-search answer: ${reply}`);
  assert.doesNotMatch(reply, /\d/u, `fee.rule.hold carries no figure: ${reply}`);
  assert.ok(reply.trimEnd().endsWith('?'), `the rung still asks: ${reply}`);
});
