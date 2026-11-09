// THE [10:24] OWNER INSULT — «МА КАКВО ВЧЕРА . ПУШИ КУРАЦ».
//
// In the field the owner's slap reached the owner-answer seam, matched no
// verdict shape, and the pending availability/term question was put back to
// him — the same failure the CLIENT side had before the 3-strike protocol:
// an insult read as a slow answer. The tone rule binds both sides of the
// relay, so the owner gets the identical protocol (strike 1 professional
// rebuff, strike 2 final warning, strike 3 ends the exchange) on his OWN
// counter: a rude owner never spends the client's strikes and never bans the
// client's chat.

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
import { STRIKE_1_RESPONSES, STRIKE_2_RESPONSES } from '../src/antiabuse/strikes';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}
class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 78, id: 78, location: 'Центар', price: 36000, service: 'buy', sqm: 74, size: '74 м²', address: 'Партизанска 10', lat: 41.996, lon: 21.428, geo_source: 'stored' } as Property,
];

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
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels, landmarks: undefined,
  });
  const send = async (m: string) => { await handler.handle('test', 'owner-insult', m); return sessions.get('owner-insult')!; };
  return { handler, sessions, sent, send };
}

// Interest → fee → contact → proposed time: the owner has a pending question.
async function reachOwnerChecking(send: (m: string) => Promise<any>): Promise<void> {
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA');
  await send('DA, SE SOGLASUVAM');
  await send('ZORAN 078/914 196');
  const s = await send('UTRE POPLADNE POSLE 6');
  assert.equal(s.state, 'owner_checking', `setup failed: ${s.state}`);
}

test('[10:24] the owner gets strike 1 — a professional rebuff, and NO re-ask of the pending question', async () => {
  const { handler, sessions, send } = await makeHandler();
  await reachOwnerChecking(send);

  const res = await handler.ownerMessage('owner-insult', 'МА КАКВО ВЧЕРА . ПУШИ КУРАЦ');
  assert.equal(res.effect, 'offended', JSON.stringify(res));
  assert.ok(STRIKE_1_RESPONSES.includes(res.replyText ?? ''),
    `the client's own strike-1 copy: ${res.replyText}`);
  // The field defect: the pending availability/term ask went straight back to
  // him. The rebuff is the whole turn.
  assert.ok(!/дали\b.*(?:достапн|термин)/iu.test(res.replyText ?? ''),
    `never the pending question in the same turn: ${res.replyText}`);
  assert.ok(!/Евидентен број/u.test(res.replyText ?? ''), `no card echo: ${res.replyText}`);

  const s = sessions.get('owner-insult')!;
  assert.equal(s.slots.ownerStrikes, 1, 'the OWNER counter carries the strike');
  assert.equal(s.strikes, 0, "the client's own strike counter is untouched");
  assert.equal(s.state, 'owner_checking', 'the visit funnel is not derailed');
});

test('[10:24] strike 2 is the final warning; a clean owner reply between strikes decays', async () => {
  const { handler, send } = await makeHandler();
  // A session must exist before the owner pane can write to it.
  await send('ZDRAVO');

  // A clean sentence between two insults resets strike 1 (the same decay the
  // client protocol runs), so the ladder always needs CONSECUTIVE offenses.
  let res = await handler.ownerMessage('owner-insult', 'МА КАКВО ВЧЕРА . ПУШИ КУРАЦ');
  assert.equal(res.effect, 'offended');
  res = await handler.ownerMessage('owner-insult', 'DOSTAPEN E');
  assert.notEqual(res.effect, 'offended', 'a clean answer is not an offense');
  res = await handler.ownerMessage('owner-insult', 'ПУШИ КУРАЦ');
  assert.equal(res.effect, 'offended');
  assert.ok(STRIKE_1_RESPONSES.includes(res.replyText ?? ''),
    `decayed back to strike 1: ${res.replyText}`);

  // Two CONSECUTIVE offenses → the final warning.
  res = await handler.ownerMessage('owner-insult', 'ПУШИ КУРАЦ');
  assert.equal(res.effect, 'offended');
  assert.ok(STRIKE_2_RESPONSES.includes(res.replyText ?? ''),
    `the final warning: ${res.replyText}`);
});

test('[10:24] strike 3 ends the owner exchange — the operator is alerted, the client chat is intact', async () => {
  const { handler, sessions } = await makeHandler();
  await reachOwnerChecking(async (m) => { await handler.handle('test', 'owner-insult', m); return sessions.get('owner-insult')!; });

  await handler.ownerMessage('owner-insult', 'ПУШИ КУРАЦ');
  await handler.ownerMessage('owner-insult', 'ПУШИ КУРАЦ');
  const third = await handler.ownerMessage('owner-insult', 'ПУШИ КУРАЦ');
  assert.equal(third.effect, 'offended');
  assert.equal(third.replyText, 'Разговорот е завршен.', `the ban notice: ${third.replyText}`);
  const s = sessions.get('owner-insult')!;
  assert.equal(s.slots.ownerStrikes, 3);
  assert.equal(s.slots.ownerMuted, true, 'the owner pane is muted for this chat');
  assert.equal(s.strikes, 0, 'the client was never struck');
  assert.equal(s.terminatedAt, undefined, "the client's chat is NOT terminated");

  // After the ban notice the owner pane stays silent.
  const after = await handler.ownerMessage('owner-insult', 'DOSTAPEN E');
  assert.equal(after.replyText, undefined, 'silence after the ban notice');
});
