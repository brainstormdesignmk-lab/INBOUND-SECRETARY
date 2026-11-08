// THE [04:36] OWNER CHANNEL — «NE MOZAM PRED 5», «NA RABOTA SUM».
//
// The owner answered the term ask with a WINDOW («I can't before 5») and then
// with a REASON («I'm at work»). Both readings were wrong in the field:
//
//   * «NE MOZAM PRED 5» parsed as a BARE counter — the hour the owner gave was
//     dropped, so the client read «сопственикот не е во можност» with no
//     alternative to accept and the funnel stalled on a question the owner had
//     already answered;
//   * «NA RABOTA SUM» parsed as nothing, so Lina told a stranger asking for a
//     favour «Не разбрав. Евидентен број 91 — дали недвижноста е достапна…»,
//     and because the first counter had already moved the funnel to
//     visit_scheduling the owner's next sentence died with «нема активна
//     проверка за овој клиент» — the channel closed and the chat went silent.
//
// The owner's own rule stays intact: nothing reaches the client until a time
// frame is given or declined (a reason is not a time).
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
import { detectOwnerNotBefore, detectOwnerVerdict, isOwnerWorkReason } from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 91, id: 91, location: 'Центар', price: 178000, service: 'buy', sqm: 71, size: '71 м²',
    address: 'Партизански одреди 10', bedrooms: 3, lat: 41.9955, lon: 21.4310, geo_source: 'stored' } as Property,
];

function makeHandler() {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, t: string) => { sent.push(t); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(llm, cfg, properties),
    responder: new Responder(llm, cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: undefined,
  } as never);
  const chatId = 'owner-0436';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };
  return { handler, sessions, sent, send, chatId };
}

async function reachOwnerChecking(send: (m: string) => Promise<ReturnType<SessionStore['get']> & object>) {
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 91');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA');
  await send('DA, SE SOGLASUVAM');
  await send('ZORAN 078/914 196');
  const s = await send('UTRE VO 4');
  assert.equal(s.state, 'owner_checking', `setup failed: ${s.state}`);
  return s;
}

test('[04:36] «NE MOZAM PRED 5» is a window from 5, not a bare refusal', () => {
  assert.equal(detectOwnerNotBefore('NE MOZAM PRED 5'), '5');
  assert.equal(detectOwnerNotBefore('ne mozam do 17:00'), '17:00');
  assert.equal(detectOwnerNotBefore('не можам пред 17'), '17');
  // A clock he CAN do is not a negated bound.
  assert.equal(detectOwnerNotBefore('MOZAM VO 5'), undefined);

  const v = detectOwnerVerdict('NE MOZAM PRED 5', 'Утре во 4');
  assert.ok(v, 'the sentence must parse');
  assert.equal(v.status, 'counter');
  assert.ok(v.ownerTime, 'the hour the owner gave rides on the verdict');
  assert.match(v.ownerTime!, /5/u, 'the bound reaches the relay');
});

test('[04:36] «NA RABOTA SUM» is a reason — understood in both scripts', () => {
  for (const t of ['NA RABOTA SUM', 'SUM NA RABOTA', 'сум на работа', 'NA RABOTNO VREME']) {
    assert.equal(isOwnerWorkReason(t), true, t);
  }
  assert.equal(isOwnerWorkReason('MOZAM POSLE 5'), false);
  // A reason alone fixes no term, so the client hears nothing yet.
  assert.equal(detectOwnerVerdict('NA RABOTA SUM', 'Утре во 4'), undefined);
});

test('[04:36] the owner window reaches the client instead of a dead-end refusal', async () => {
  const { handler, sent, send, chatId } = makeHandler();
  await reachOwnerChecking(send);

  const res = await handler.ownerMessage(chatId, 'NE MOZAM PRED 5');
  assert.notEqual(res.effect, 'no_pending', `the owner must be heard: ${JSON.stringify(res)}`);
  // THE CLIENT MUST GET AN ALTERNATIVE TO ACCEPT (the field stall: a bare
  // «сопственикот не е во можност» with nothing after it). The owner copy is
  // not asserted here — a clocked counter is relayed straight to the client,
  // and `replyText` rides only the lanes that answer the OWNER.
  const clientLine = sent[sent.length - 1] ?? '';
  assert.match(clientLine, /Има друг предлог/u, `the window is relayed: ${clientLine}`);
  assert.match(clientLine, /17:00|18:00|по 17|по 5|После 5/u, `with the hour he gave: ${clientLine}`);
  assert.match(clientLine, /\?$/u, `and ends on a question the client can answer: ${clientLine}`);
});

test('[04:36] the owner channel survives a bare counter: «NA RABOTA SUM» is answered', async () => {
  const { handler, sessions, send, chatId } = makeHandler();
  await reachOwnerChecking(send);

  // A bare refusal moves the funnel to visit_scheduling (client asked for a new
  // time). The owner's reason must still be ANSWERED, and the check must be
  // open again for his follow-up — this is the sentence that used to die with
  // «нема активна проверка за овој клиент».
  await handler.ownerMessage(chatId, 'NE MOZAM');
  assert.equal(sessions.get(chatId)!.state, 'visit_scheduling', 'bare counter asks the client for a time');

  const reason = await handler.ownerMessage(chatId, 'NA RABOTA SUM');
  assert.equal(reason.effect, 'answered', `the reason is answered: ${JSON.stringify(reason)}`);
  assert.match(reason.replyText ?? '', /работа/u, `he hears his own reason: ${reason.replyText}`);
  assert.equal(sessions.get(chatId)!.state, 'owner_checking', 'the check stays open while the term is unsettled');

  // …and the next sentence is a verdict again, not «нема активна проверка».
  const term = await handler.ownerMessage(chatId, 'MOZAM POSLE 6');
  assert.notEqual(term.effect, 'no_pending', `the term must land: ${JSON.stringify(term)}`);
});
