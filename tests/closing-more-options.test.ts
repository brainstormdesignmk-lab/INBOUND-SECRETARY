import { test } from 'node:test';
import assert from 'node:assert';
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
import { detectMoreOptions } from '../src/llm/deterministic';

// The [22:2x] Viber transcript (V16K11): the client went
//   "dobra lokacija ima / dogovori mi da go vidam" -> fee ask
//   "pari za poseta / nesto novo"                  -> fee pitch AGAIN
//   "a drugi stanovi do taa cena imate?"           -> INFO_ASK price re-render
//   "drugi nemate vo celo skopje"                  -> LLM (Groq) -> fee pitch AGAIN
// A client mid-fee-funnel asking for ALTERNATIVES must get the NEXT BATCH —
// the fee debate resumes when a new property catches him. Three seams:
//   1. FSM: closing gains SEARCH_REQUESTED/DETAILS_PROVIDED -> presentation.
//   2. det-classify: the more-ask family is owned (no LLM round-trip), with
//      fee/rent-math/total-cost/visit-time vetoes.
//   3. INFO_ASK: a more-ask that echoes the discussed price ("do taa cena")
//      never re-renders the card.

class FailingLlm implements LlmClient { async complete(): Promise<string> { throw new Error('429'); } }
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 79, id: 79, location: 'Водно', price: 300, service: 'rent', bedrooms: 2, size: '35 м²', address: 'Клиника' },
  { eb: 48, id: 48, location: 'Карпош III', price: 250, service: 'rent' },
  { eb: 41, id: 41, location: 'Аеродром', price: 290, service: 'rent', bedrooms: 2 },
  { eb: 50, id: 50, location: 'Кисела Вода', price: 280, service: 'rent', bedrooms: 3 },
  { eb: 76, id: 76, location: 'Центар', price: 295, service: 'rent', bedrooms: 2 },
] as unknown as Property[];

async function makeHandler() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const classifier = new Classifier(new FailingLlm(), cfg, properties);
  const responder = new Responder(new FailingLlm(), cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { sessions, sent,
    send: async (chatId: string, m: string) => {
      await handler.handle('test', chatId, m);
      return { s: sessions.get(chatId)!, reply: sent.at(-1) ?? '' };
    } };
}

test('detectMoreOptions: the alternatives family fires; fee/price/time questions do not', () => {
  for (const t of ['a drugi stanovi do taa cena imate?', 'drugi nemate vo celo skopje',
    'nesto novo', 'drugo nesto ima?', 'a drugi so dve spalni imate?']) {
    assert.equal(detectMoreOptions(t), true, `${t} must fire`);
  }
  for (const t of ['kolku e cenata?', 'da, se soglasuvam', 'koga mozam da dojdam?',
    'dali e dostapen?', 'znaci 250 evra 125 se za vas?']) {
    assert.equal(detectMoreOptions(t), false, `${t} must stay clean`);
  }
});

test('[22:2x] closing more-ask ("drugi nemate vo celo skopje") serves the options engine, never the fee pitch', async () => {
  const { send, sessions, sent } = await makeHandler();
  const chat = 'closing-more-ask';
  await send(chat, 'mi treba stan pod kirija vo karpos do 300');
  await send(chat, 'sakam da go vidam 48');   // -> closing, fee.ask.rent
  const s0 = sessions.get(chat)!;
  assert.equal(s0.state, 'closing');

  // THE TRANSCRIPT LINE — verbatim. Must land presentation (next batch),
  // det-owned (no Groq round-trip), and never repeat the fee.
  const r = await send(chat, 'drugi nemate vo celo skopje');
  const s = sessions.get(chat)!;
  assert.equal(s.state, 'presentation', `must move to presentation, got ${s.state}`);
  assert.ok(!/надомест|300\s*денари|согласувате/iu.test(r.reply), `no fee debate: ${r.reply}`);
  // The reply is the options machinery (widen/exhausted/alternatives family) —
  // wording-agnostic: the Карпош III batch is drained, so the widen ask or the
  // rest-of-city presentation is the correct serve.
  assert.ok(/друг|населб|провер|покаж|останат|imam/iu.test(r.reply), `options machinery served: ${r.reply}`);
});

test('[22:2x] closing more-ask with the old price ("a drugi stanovi do taa cena imate?") never re-renders the card', async () => {
  const { send, sessions } = await makeHandler();
  const chat = 'closing-more-ask-cena';
  await send(chat, 'mi treba stan pod kirija vo karpos do 300');
  const first = await send(chat, 'sakam da go vidam 48');
  const card = first.reply;

  const r = await send(chat, 'a drugi stanovi do taa cena imate?');
  const s = sessions.get(chat)!;
  assert.equal(s.state, 'presentation', `must move to presentation, got ${s.state}`);
  assert.ok(r.reply !== card, 'must not repeat the property card');
  assert.ok(!/надомест|согласувате/iu.test(r.reply), `no fee debate: ${r.reply}`);
});

test('[22:2x] the joined burst ("pari za poseta / nesto novo") pivots to options — the client wants alternatives, not the fee again', async () => {
  // The relay joins the client's burst into ONE turn (the two messages were
  // 6s apart in the transcript). The user contract: SHE SHOULD GIVE HIM
  // OPTIONS, not the visit fee — the fee was already disclosed twice and the
  // jab "pari za poseta" is not a decision (no agreement, no refusal).
  const { send, sessions } = await makeHandler();
  const chat = 'closing-fee-lane';
  await send(chat, 'mi treba stan pod kirija vo karpos do 300');
  await send(chat, 'sakam da go vidam 48');
  assert.equal(sessions.get(chat)!.state, 'closing');

  const r = await send(chat, 'pari za poseta / nesto novo');
  const s = sessions.get(chat)!;
  assert.equal(s.state, 'presentation', 'options must serve');
  assert.ok(!/согласувате/iu.test(r.reply), `no fee re-ask: ${r.reply}`);
});

test('[22:2x] fee DECISION lanes stay intact: agreement never pivots to options', async () => {
  const { send, sessions } = await makeHandler();
  const chat = 'closing-fee-decisions';
  await send(chat, 'mi treba stan pod kirija vo karpos do 300');
  await send(chat, 'sakam da go vidam 48');

  // agreement -> contact collection (never presentation/options)
  const r = await send(chat, 'da, se soglasuvam');
  assert.equal(sessions.get(chat)!.state, 'contact_collection');
  assert.ok(/име|презиме|телефон/iu.test(r.reply), `contact ask served: ${r.reply}`);
});

test('[22:2x] a real "nesto novo" follow-up in closing pivots to options (det-owned)', async () => {
  const cfg = loadConfig();
  const classifier = new Classifier(new FailingLlm(), cfg, undefined);
  const r = await classifier.deterministicClassify(
    { state: 'closing', slots: { propertyId: 48, service: 'rent' } } as any,
    'nesto novo');
  assert.ok(r, 'bare more-ask must be det-owned in closing');
  assert.equal(r!.event.type, 'SEARCH_REQUESTED');
});
