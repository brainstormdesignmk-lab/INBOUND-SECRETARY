// THE [02:16] CAPTURE — a client at the CLOSE, stuck between two flats:
//
//   [02:16] DAJ MI INFO ZA NEJZE ... (EB 50, куќа/гарсоњера во Центар)
//   [02:18] A GARSONJERATA KAJ CRNOGORSKA AMBASADA DALI E SLOBODNA SEUSTE ?
//   [02:18] SE MISLAM MEGJU OVIE DVE . NE ZNAM KOJA DA JA ODBERAM.
//   [02:19] KOJA OPCIJA BI MI JA PREPORACALE ?
//   [02:19] ЛИНА: „Надоместот од 300 денари (5 евра) е навистина симболичен…“
//
// The question is a CHOICE question. It reached the fee ladder because the
// recommendation block only accepted idle/intent/discovery/property_query/
// presentation — `closing` was missing, so the block was skipped and the
// fee-persuasion lane answered a question about which flat to pick with a
// defence of the viewing fee.
//
// Pinned here: at `closing`, a choice question is answered with the
// recommendation close (visit offer, decision left to the client) and NEVER
// with fee wording; and the choice grammar is recognised by word class, so
// „koja opcija“ / „koja da ja odberam“ need no phrase in the bank.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InboundHandler } from '../src/handlers/inbound';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { SessionStore, freshSession, ChatSession } from '../src/fsm/session';
import { PropertyService, Property } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { ChannelRegistry } from '../src/channels/types';
import { LandmarkService } from '../src/geo/landmarks';
import { Db } from '../src/store/db';
import { loadConfig } from '../src/config';
import { RESPONSE_BANK } from '../src/data/responses';
import { setLearnedBank } from '../src/data/responseBank';

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

// The two rows actually under discussion in the capture.
const ROWS: Property[] = [
  { eb: 50, id: 50, location: 'Центар', price: 250, service: 'rent', size: '74 м²', address: 'Рузвелтова' },
  { eb: 76, id: 76, location: 'Центар', price: 200, service: 'rent', size: '24 м²', address: 'Његошева' },
];

function makeHandler(): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions,
    classifier: new Classifier(llm, cfg, properties),
    responder: new Responder(llm, cfg),
    properties,
    appointments: new AppointmentStore(db),
    escalations: new EscalationStore(db),
    meta: new MetaStore(db),
    channels,
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent };
}

/** The session as it stood at [02:19]: at the close, both flats on the table. */
function seedClosing(chatId: string, userTexts: string[]): ChatSession {
  const s = freshSession('test', chatId);
  s.state = 'closing';
  s.slots = { service: 'rent', propertyId: 76, presentedIds: [50, 76] };
  s.history = userTexts.map(text => ({ role: 'user' as const, text }));
  return s;
}

const CLOSE_POOL: string[] = RESPONSE_BANK['recommend.close'] ?? [];
// Any fee wording at all — amount, noun, or the persuasion frame. The answer
// to "which one?" must contain none of it.
const FEE_RE = /(надомест|денар|симболич(?:н|ен)|надоместот|провизи|5 евра)/iu;

test('[02:19] closing state: „KOJA OPCIJA BI MI JA PREPORACALE?“ — close, never fee', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'client-closing-choice';
  sessions.set(seedClosing(chatId, [
    'DAJ MI INFO ZA NEJZE',
    'A GARSONJERATA KAJ CRNOGORSKA AMBASADA DALI E SLOBODNA SEUSTE ?',
    'SE MISLAM MEGJU OVIE DVE . NE ZNAM KOJA DA JA ODBERAM.',
  ]));

  await handler.handle('test', chatId, 'KOJA OPCIJA BI MI JA PREPORACALE ?');
  const reply = sent.at(-1) ?? '';

  assert.ok(!FEE_RE.test(reply), `fee wording reached a choice question: ${reply}`);
  assert.match(reply, /посет|осети|види лично/, `must offer a visit: ${reply}`);
  assert.match(reply, /\?$|потврд|кажете|посочите|Ве молам/, `must put the choice to the client: ${reply}`);
  // Served from the seeded pool (bank or code fallback), not invented text.
  assert.ok(
    CLOSE_POOL.includes(reply.trim()) || /Секоја недвижнина|Убавината е во очите/.test(reply),
    `close must come from the recommend.close pool: ${reply}`,
  );
  // The choice question does not advance the funnel out of the close.
  assert.equal(sessions.get(chatId)!.state, 'closing');
});

test('[02:19]/[11:39] closing state: a judgment ask about flats ALREADY shown is the close, no card replay', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'client-closing-choice-ebs';
  sessions.set(seedClosing(chatId, [
    'me interesira stanot 50',
    'i garsonjerata 76',
  ]));

  await handler.handle('test', chatId, 'ne znam koja da ja odberam, koja opcija e podobra ?');
  const reply = sent.at(-1) ?? '';

  assert.ok(!FEE_RE.test(reply), `fee wording reached a choice question: ${reply}`);
  // THE CONTRACT MOVED AFTER THIS CAPTURE (the [11:39] rule, pinned in
  // tests/two-flat-claims.test.ts): both flats are already ON THE TABLE
  // (`presentedIds`), and replaying their cards word for word is a wall of
  // text the client just read — the judgment turn carries the clientela close
  // alone. The [02:19] failure this test exists for was the FEE LADDER
  // answering the choice question, and that is still asserted above; what is
  // no longer expected is the card dump for rows already served.
  assert.doesNotMatch(reply, /Евидентен број 50|Евидентен број 76/,
    `flats already on the table must not be re-dumped: ${reply}`);
  assert.match(reply, /посет|осети|види лично/iu, `the close is still the visit offer: ${reply}`);
  // The old failure asked for numbers the client had already given.
  assert.doesNotMatch(reply, /Дали го знаете Евидентен број/);
  assert.equal(sessions.get(chatId)!.state, 'closing', 'a judgment ask never advances the funnel');
});

test('a choice question with nothing under discussion does not fabricate a close', async () => {
  const { handler, sent } = makeHandler();
  await handler.handle('test', 'client-cold-choice', 'koja opcija bi mi ja preporacale ?');
  const reply = sent.at(-1) ?? '';
  // Cold session: no properties presented, no anchor — the funnel asks its own
  // first question rather than pretending a flat is under discussion.
  assert.doesNotMatch(reply, /Евидентен број 50|Евидентен број 76/);
  assert.ok(reply.length > 0, 'the turn must still be answered');
});
