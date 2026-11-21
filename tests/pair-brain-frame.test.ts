// THE BRAIN ANSWERS FOR THE PAIR — AND THE SERVE IS CHECKED (the owner's
// 2026-11-20 limitation): the deterministic info lanes cover every recognised
// facet, but a paraphrase with no facet keyword reaches the LLM. That call used
// to receive the NEXT discovery batch as its property data, so nothing tied it
// to the two flats the client was reading — it answered about one, or invented.
//
// Two halves, both pinned here through the real pipeline:
//   1. a message that points at the pair hands the BRAIN that pair, with an
//      explicit per-property instruction (the model's prompt is asserted);
//   2. after the call, the served sentence must NAME every flat — an answer
//      that drops one gets the honest owner-relay line for the omitted flat,
//      so no property ever disappears from the client's turn.

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
import { LlmClient, LlmRequest } from '../src/llm/types';

/** A brain that answers with a fixed line and records what it was asked. */
class StubLlm implements LlmClient {
  requests: LlmRequest[] = [];
  constructor(private answer: string) {}
  async complete(req: LlmRequest): Promise<string> {
    this.requests.push(req);
    return this.answer;
  }
}

const ROWS: Property[] = [70, 84].map(eb => ({
  eb, id: eb, location: 'Центар', address: `Улица ${eb}`, price: 100000 + eb * 500,
  bedrooms: 3, sqm: 60 + eb / 10, size: `${60 + eb / 10} м²`, service: 'buy',
  features: ['паркинг'], lat: 41.995 + eb / 10000, lon: 21.431 + eb / 10000,
  geo_source: 'google_cached', details: '',
} as Property));

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id || r.eb === id); }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(answer: string) {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const props = new FakeProps(ROWS);
  const llm = new StubLlm(answer);
  const handler = new InboundHandler({
    cfg: loadConfig(), db, sessions,
    classifier: new Classifier(new StubLlm(''), loadConfig(), props),
    responder: new Responder(llm, loadConfig()),
    properties: props,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
  });
  const chatId = 'pair-brain';
  const seed = () => {
    const s = freshSession('test', chatId);
    s.state = 'presentation';
    s.slots.service = 'buy';
    s.slots.currentBatch = [70, 84];
    s.slots.presentedIds = [70, 84];
    s.slots.propertyId = 84;
    s.slots.interestedPropertyId = 84;
    sessions.set(s);
    return s;
  };
  const say = async (m: string): Promise<string> => {
    sent.length = 0;
    await handler.handle('test', chatId, m);
    return sent.at(-1) ?? '';
  };
  const prompt = (): string => llm.requests
    .flatMap(r => r.messages.filter(m => m.role === 'system').map(m => m.content))
    .join('\n');
  return { handler, sessions, sent, llm, chatId, seed, say, prompt };
}

const ASK = 'што знаете за влагата кај овие два стана ?';

test('a pair question reaches the brain with BOTH rows and a per-property rule', async () => {
  const h = makeHandler('За влагата немам податок во системот.');
  h.seed();
  await h.say(ASK);
  const prompt = h.prompt();
  assert.match(prompt, /ALL 2 PROPERTIES/u, `the model is told the ask covers both: ${prompt}`);
  assert.match(prompt, /70, 84/u, `the pair's own numbers: ${prompt}`);
  assert.match(prompt, /"eb": 70/u, `the first row's data is present: ${prompt}`);
  assert.match(prompt, /"eb": 84/u, `the second row's data is present: ${prompt}`);
});

test('a prose answer that drops one flat gets that flat’s honest line appended', async () => {
  // The model answered about EB 70 only — exactly the field failure.
  const h = makeHandler('Станот со Евидентен број 70 е во добра состојба.');
  h.seed();
  const answer = await h.say(ASK);
  assert.match(answer, /Евидентен број 70/u, `the served half is kept: ${answer}`);
  assert.match(answer, /За Евидентен број 84 немам податок/u,
    `the dropped flat is named, never silent: ${answer}`);
});

test('an answer that names both flats is served untouched', async () => {
  const both = 'За станот со Евидентен број 70 немам податок за влага. '
    + 'За станот со Евидентен број 84 исто така ќе го прашам сопственикот.';
  const h = makeHandler(both);
  h.seed();
  const answer = await h.say(ASK);
  assert.equal(answer.includes(both), true, `the model's answer is not rewritten: ${answer}`);
  assert.ok(!/За Евидентен број 84 немам податок во системот за тоа прашање/u.test(answer),
    `no repair line is appended when both are named: ${answer}`);
});

test('a REJECTION of the served pair is not framed as a pair question', async () => {
  // «NE MI SE DOPAGA» carries the reflexive clitic «se», which the plural-ask
  // regex once took as a plural marker — the rejected cards were then answered
  // as "for both flats" instead of walking the ladder.
  const h = makeHandler('Еве други предлози.');
  h.seed();
  await h.say('ne mi se dopagaat, daj drugi');
  const prompt = h.prompt();
  assert.ok(!/ALL 2 PROPERTIES/u.test(prompt),
    `a rejection keeps the funnel, never the pair frame: ${prompt}`);
});

test('a WAIVED criterion is not framed as a pair question', async () => {
  const h = makeHandler('Во ред, големината не Ве врзува.');
  h.seed();
  await h.say('NEBITNI SE SPALNITE');
  const prompt = h.prompt();
  assert.ok(!/ALL 2 PROPERTIES/u.test(prompt),
    `a released criterion moves the search on: ${prompt}`);
});

test('a NEW SEARCH is not framed as a pair question', async () => {
  const h = makeHandler('Еве неколку предлози.');
  h.seed();
  await h.say('барам трисобен стан до 120000 евра во Центар');
  const prompt = h.prompt();
  assert.ok(!/ALL 2 PROPERTIES/u.test(prompt),
    `a search keeps the discovery context: ${prompt}`);
});
