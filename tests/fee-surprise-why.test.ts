// The 08:32 transcript regression — the fee-surprise question answered, not re-asked.
//
//   client: KONTAKTIRAJTE GO I KAZETE MI   → fee disclosure (fee.ask.buy)
//   client: OVA E NESTO NOVO ?             → MUST be the fee-why rationale
//                                            (the time-waster filter), never a
//                                            second fee disclosure.
//
// Why it broke: the B/E boundary macros in LOC_CONFIRM_QUESTION_RE were
// (?<!\p{L}\p{N}) — a TWO-char lookbehind matching letter+digit pairs, not a
// negated class. So "NOVO ?" matched the "vo … ?" leg (no letter/digit pair
// directly before "VO"), detectLocationConfirm fired, fsmRequired blocked the
// FEE_SURPRISE fast interceptor, the FSM + classifier tagged INTERESTED, and
// the closing branch re-disclosed fee.ask — answering "is this new?" by
// repeating the fee verbatim.
//
// Context for the business rule: Macedonian agencies usually charge NO visit
// fee, so clients meet the practice for the first time here. The surprise is
// fee-protocol traffic — Lina explains the time-waster-filter rationale and
// re-asks for agreement, never a second copy-paste of the amount.
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
import { detectFeeSurprise } from '../src/llm/deterministic';

setLearnedBank({
  variants: () => [],
  addVariant: () => false,
  addExample: () => false,
  metric: () => {},
  retrieve: () => undefined,
} as any);

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

// Every fee.why seed must carry the filter rationale, and the pool must
// include the literal "is this new?" answer (the 08:32 question family).
test('fee.why pool: rationale present + the "is this new?" literal answer', () => {
  const seeds: string[] = RESPONSE_BANK['fee.why'] ?? [];
  assert.ok(seeds.length >= 10, `expected a real pool, got ${seeds.length}`);
  const literal = seeds.find(v => /новост|ново\s+за\s|прв\s*пат/iu.test(v));
  assert.ok(literal, `no "is this new?" literal variant in fee.why:\n${seeds.join('\n')}`);
  for (const v of seeds) {
    assert.ok(/филт|селекци|издвој|препознаваме|луѓето со вистински/iu.test(v), `no filter rationale: ${v}`);
  }
});

test('08:32 flow: fee ask → "OVA E NESTO NOVO ?" → fee.why, never a second disclosure', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'nesto-novo';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // Client names the property, asks availability (arms ownerContactPending),
  // then orders the contact → fee disclosure (the 12:51 flow).
  let s = await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  s = await send('DALI E SEUSTE DOSTAPEN ?');
  assert.ok(s.slots.ownerContactPending, 'availability ack must arm ownerContactPending');
  s = await send('KONTAKTIRAJTE GO I KAZETE MI');
  assert.equal(s.state, 'closing', 'contact order must land in closing');
  const feeAsk = sent[sent.length - 1] ?? '';
  assert.ok(feeAsk.includes('500 денари'), `expected fee disclosure, got: ${feeAsk}`);

  // The surprise question.
  assert.equal(detectFeeSurprise('OVA E NESTO NOVO ?'), true);
  s = await send('OVA E NESTO NOVO ?');

  const reply = sent[sent.length - 1] ?? '';
  // NEVER a second fee disclosure: the amount was already on the table.
  assert.ok(!reply.includes('500 денари') && !reply.includes('10 евра'),
    `fee-surprise re-disclosed the fee: ${reply}`);
  // It must be the RATIONALE (filter for real clients / time-wasters).
  assert.ok(/филтер|селекци|вистинск(и|ите)|сериозн/iu.test(reply), `no rationale in reply: ${reply}`);
  // Funnel keeps moving: still in closing, waiting for the fee agreement.
  assert.equal(s.state, 'closing');
});
