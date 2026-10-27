/**
 * THE [14:46–14:47] CAPTURE, as tests.
 *
 *   [14:45] KOJA MU E CENATA ZA M2
 *   [14:46] REALNA CENA ZA OVOJ REON AMA SAKAM NESTO POEFTINO   ← price echo (fixed veto)
 *   [14:46] DAJ MI NESTO POEFTINO VO TOJ REON                   ← served a GARSONJERA + a
 *                                                                 Влае house against his
 *                                                                 two-bedroom apartment talk
 *   [14:47] MI TREBA STAN SO DVE SPALNI SOBI VO TOJ REON ,
 *           NE GARSONJERI I KUKJI                              ← OUT OF CONTEXT
 *                                                              (feature.after.show owner line)
 *
 * Repairs pinned here:
 *   (1) The cheaper search ANCHORS on the property he chose: cheaper SAME-
 *       bedroom, same-type options in the chosen naselba serve FIRST; a
 *       studio and a house must never ride a two-bedroom apartment ask.
 *   (2) When the same-characteristics pool is empty, Lina ASKS the two-way
 *       question: cheaper smaller in the SAME naselba, or same specs in
 *       NEIGHBOURING naselbi. She never silently spills other areas.
 *   (3) A criteria restatement after the wrong serve gets ONE apology and
 *       the pool he actually asked for.
 *   (4) The feature.ask lane never swallows the restatement (owner-contact
 *       line was the out-of-context reply), and a negated studio mention
 *       ("NE GARSONJERI") never arms slots.garsonjera.
 */
import { test } from 'node:test';
import assert from 'node:assert';
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
import { LandmarkService } from '../src/geo/landmarks';
import {
  detectFeatureAsk, detectCriteriaStatement, detectNegatedType, extractSlots,
} from '../src/llm/deterministic';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; }
}

// EB 74, the client's chosen anchor (Центар, 72 м², 3 rooms, 190.000). The
// cheaper-same pool lives in Центар; the decoys he must NEVER see in a
// same-characteristics serve: the studio EB 63 (Центар, 28 м²) and the Влае
// house EB 55 (the capture's mis-serves).
const ROWS: Property[] = [
  { eb: 74, id: 74, location: 'Центар', address: 'ул. Водњанска', city: 'Скопје',
    price: 190000, service: 'buy', sqm: 72, size: '72 м²', house: false, bedrooms: 3,
    details: 'стан со две спални' },
  { eb: 77, id: 77, location: 'Центар', address: 'ул. Орце Николов', city: 'Скопје',
    price: 150000, service: 'buy', sqm: 70, size: '70 м²', house: false, bedrooms: 3,
    details: 'стан со две спални, поевтин' },
  // Studio decoy: CHEAPER and in Центар — but NOT the same characteristics.
  { eb: 63, id: 63, location: 'Центар', address: 'ул. Ж', city: 'Скопје',
    price: 36000, service: 'buy', sqm: 28, size: '28 м²', house: false, bedrooms: undefined,
    studio: true, details: 'гарсоњера' },
  // House decoy in Влае — the capture's second mis-serve.
  { eb: 55, id: 55, location: 'Влае', address: 'Мраморец 12а', city: 'Скопје',
    price: 40000, service: 'buy', sqm: 240, size: '240 м²', house: true, bedrooms: undefined,
    details: 'куќа' },
  // A same-3-rooms flat in a NEIGHBOURING naselba — pool C for the widen answer.
  { eb: 82, id: 82, location: 'Аеродром', address: 'ул. W', city: 'Скопје',
    price: 145000, service: 'buy', sqm: 74, size: '74 м²', house: false, bedrooms: 3,
    details: 'стан со две спални во Аеродром' },
];

function makeHandler(rows: Property[]): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(rows);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels, landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent };
}

/** The capture's context: the client just saw EB 74 (Центар, two bedrooms). */
async function seedChoice(handler: InboundHandler, sessions: SessionStore, chatId: string): Promise<void> {
  const session = sessions.get(chatId) ?? freshSession('test', chatId);
  session.slots.service = 'buy';
  session.slots.location = 'Центар';
  session.state = 'presentation';
  session.slots.propertyId = 74;
  session.slots.interestedPropertyId = 74;
  session.slots.presentedIds = [74];
  sessions.set(session);
}

test('detectors: the restatement is criteria, NOT a feature ask; negated garsonjera never arms', () => {
  const t = 'MI TREBA STAN SO DVE SPALNI SOBI VO TOJ REON , NE GARSONJERI I KUKJI';
  assert.equal(detectCriteriaStatement(t), true, 'wish + type = criteria statement');
  assert.equal(detectNegatedType(t), true, 'the negator strikes the served types');
  assert.equal(detectFeatureAsk(t), false, 'the owner-contact lane must not own a criteria statement');
  const slots = extractSlots(t);
  assert.equal(slots.garsonjera, undefined, '"NE GARSONJERI" must not arm the studio category');
  assert.equal(slots.house, false, '"NE ... KUKJI" keeps houses out');
  assert.equal(slots.bedrooms, 3, 'dve spalni = 3 rooms (rooms convention)');
  // Sanity: a real feature ask keeps firing.
  assert.equal(detectFeatureAsk('kolku spalni ima 74?'), true);
});

test('A: cheaper serve is the SAME characteristics in the naselba — never studio nor house', async () => {
  const { handler, sessions, sent } = makeHandler(ROWS);
  const chatId = 'cheap-A';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };
  await seedChoice(handler, sessions, chatId);

  await send('DAJ MI NESTO POEFTINO VO TOJ REON');
  assert.match(sent[0] ?? '', /Евидентен број 77/, `the same-bedroom cheaper flat must serve, got: ${sent}`);
  for (const eb of [63, 55]) {
    assert.ok(!sent[0].includes(`Евидентен број ${eb}`),
      `the ${eb === 63 ? 'studio' : 'house'} decoy must never ride a same-characteristics ask; got: ${sent[0]}`);
  }
  // The ask itself must not re-quote EB 74's price (the [14:46] echo).
  assert.ok(!sent[0].includes('190.000'), `the price echo must stay out; got: ${sent[0]}`);
});

test('B: empty same-characteristics pool → the TWO-WAY ask, then "da" serves smaller-in-area', async () => {
  // Only the studio and the house remain cheaper — no same-characteristics row.
  const rows = ROWS.filter(r => r.id !== 77 && r.id !== 82);
  const { handler, sessions, sent } = makeHandler(rows);
  const chatId = 'cheap-B';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };
  await seedChoice(handler, sessions, chatId);

  await send('DAJ MI NESTO POEFTINO VO TOJ REON');
  assert.match(sent[0] ?? '', /помали станови во истата населба/, `the two-way ask must fire, got: ${sent}`);
  assert.match(sent[0] ?? '', /соседните населби/, 'the ask must name BOTH fallback options');
  // A question, not a silent spill of other-area rows.
  assert.ok(!sent[0].includes('Евидентен број 82'), 'the elsewhere row must not spill before the client chooses');
  assert.equal(sessions.get(chatId)!.slots.cheaperChoicePending, true);

  // "da" agrees with the FIRST-named option: cheaper smaller in the same naselba.
  await send('da');
  assert.match(sent[1] ?? '', /Евидентен број 63/, `the smaller-in-area batch must serve, got: ${sent[1]}`);
  assert.ok(!sent[1].includes('Евидентен број 55'), 'the Влае house is not a smaller Центар flat');
});

test('C: the elsewhere answer serves the same characteristics in a neighbouring naselba', async () => {
  const rows = ROWS.filter(r => r.id !== 77);
  const { handler, sessions, sent } = makeHandler(rows);
  const chatId = 'cheap-C';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };
  await seedChoice(handler, sessions, chatId);

  await send('DAJ MI NESTO POEFTINO VO TOJ REON');
  assert.match(sent[0] ?? '', /помали станови во истата населба/, 'the two-way ask fires first');

  await send('ne, pokazi mi so isti karakteristiki vo druga naselba');
  assert.match(sent[1] ?? '', /Евидентен број 82/, `the same-specs elsewhere batch must serve, got: ${sent[1]}`);
  assert.ok(!sent[1].includes('Евидентен број 63'), 'the studio is NOT the same characteristics');
});

test('D: after a WRONG serve, the restatement gets ONE apology and the pool he asked for', async () => {
  // EB 77 simulates the good-but-late row; WITHOUT it the correct answer to
  // the restatement is the two-way ask — also acceptable per the brief. Here
  // we pin the apology + correct serve.
  const rows = ROWS;
  const { handler, sessions, sent } = makeHandler(rows);
  const chatId = 'cheap-D';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };
  await seedChoice(handler, sessions, chatId);

  await send('DAJ MI NESTO POEFTINO VO TOJ REON');
  await send('MI TREBA STAN SO DVE SPALNI SOBI VO TOJ REON , NE GARSONJERI I KUKJI');
  const out = sent[1] ?? '';
  assert.match(out, /извин/iu, `an apology MUST open the restatement serve, got: ${out}`);
  assert.match(out, /Евидентен број 77/, `the restatement must serve the same-bedroom cheaper pool, got: ${out}`);
});
