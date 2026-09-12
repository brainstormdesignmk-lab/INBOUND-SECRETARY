// The 21:23 transcript regression:
//   1) availability ack must NEVER say "Дали сакате да Ве поврзам со
//      сопственикот" — Lina contacts the OWNER herself; the client and the
//      owner are never "connected" with each other.
//   2) the client's whole-message confirmation ("DA SAKAM" / "да сакам")
//      after that ack must disclose the VISIT FEE (closing path), not the
//      contact-ask. detectAgreement now treats the short answer as agreement
//      (CLIENT_CONFIRM_RE), and the ownerContactPending branch serves fee.ask.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InboundHandler } from '../src/handlers/inbound';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { SessionStore } from '../src/fsm/session';
import { PropertyService } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { LandmarkService } from '../src/geo/landmarks';
import { Db } from '../src/store/db';
import { loadConfig } from '../src/config';
import { Property } from '../src/data/properties';
import { RESPONSE_BANK } from '../src/data/responses';
import { setLearnedBank } from '../src/data/responseBank';
import { detectAgreement } from '../src/llm/deterministic';

// Every availability.ack seed/learned variant must be owner-contact phrasing,
// never client↔owner "connecting".
const FORBIDDEN_CONNECT = /да\s+Ве\s+поврзам\s+со\s+сопственикот|да\s+Ве\s+поврзам\s+со\s+сопственикот|Сакате\s+ли\s+да\s+Ве\s+поврзам/iu;

test('availability.ack variants never "connect" the client with the owner', () => {
  const seeds: string[] = RESPONSE_BANK['availability.ack'] ?? [];
  assert.ok(seeds.length >= 10, `expected a real pool, got ${seeds.length}`);
  for (const v of seeds) {
    assert.ok(!FORBIDDEN_CONNECT.test(v), `connect-phrasing in availability.ack: ${v}`);
    assert.ok(/(?:исконтактирам|контактирам|стапам|поврзам|разговор|слушам)/iu.test(v), `no owner-contact verb: ${v}`);
  }
});

class FailingLlm { async complete(): Promise<string> { throw new Error('429 quota exhausted'); } }

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

const ROWS: Property[] = [
  { eb: 78, id: 78, location: 'Капиштец', price: 185000, service: 'buy', bedrooms: 3, size: '82 м²', address: 'Народен Фронт' },
];

function makeHandler(): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
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
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent };
}

test('21:23 flow: availability ack → "DA SAKAM" → VISIT FEE (not contact ask)', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'client-confirm';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // 1) availability ask on a known EB → the ack
  let s = await send('DALI USTE E NA PRODAZBA 78?');
  assert.ok(s, 'session must exist');
  const ack = sent[sent.length - 1] ?? '';
  assert.ok(/достапен|активен|баз|евиденц|слободен|располага/iu.test(ack), `availability ack expected, got: ${ack}`);
  assert.ok(!FORBIDDEN_CONNECT.test(ack), `connect-phrasing leaked: ${ack}`);
  assert.equal(s.slots.ownerContactPending, true, 'ack must arm the owner-contact gate');

  // 2) whole-message confirmation → the FEE, not the contact ask
  s = await send('DA SAKAM');
  const after = sent[sent.length - 1] ?? '';
  assert.ok(!/(име и презиме|име и телефон|телефонскиот број)/iu.test(after), `contact ask served instead of fee: ${after}`);
  assert.ok(
    /(надомест|300|денари|симболичн|посета)/iu.test(after),
    `visit fee expected after "DA SAKAM", got: ${after}`,
  );
  assert.equal(s.state, 'closing', 'fee stage keeps the funnel in closing');
});

test('detectAgreement: short confirmation vs purpose clauses', () => {
  assert.equal(detectAgreement('DA SAKAM'), true);
  assert.equal(detectAgreement('да сакам'), true);
  assert.equal(detectAgreement('DA'), true);
  // still NOT agreement:
  assert.equal(detectAgreement('да сакам да го видам'), false);
  assert.equal(detectAgreement('DA SAKAM DA GO VIDAM'), false);
  assert.equal(detectAgreement('сакам стан во Карпош'), false);
  assert.equal(detectAgreement('да видам'), false);
  assert.equal(detectAgreement('да ти кажам искрено'), false);
  assert.equal(detectAgreement('не, не сакам'), false);
});
