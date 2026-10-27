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
import { detectAgreement, detectSendToOwnerAsk } from '../src/llm/deterministic';
import { buildOwnerAsk, ownerPropertyLabels, AVAILABILITY_ACK, AVAILABILITY_ACK_FEM } from '../src/llm/prompts';

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

// „Недвижност“ is FEMININE. The mass имот→недвижност replacement left
// masculine agreement behind ("недвижноста е активен", "го имаме"), and the
// [20:14] owner ping said "за Вашиот куќа … кој … е внесен" — a куќа is
// feminine too (Вашата / која / внесена / достапна).
test('availability.ack seeds agree with the feminine „недвижност“', () => {
  const seeds: string[] = RESPONSE_BANK['availability.ack'] ?? [];
  const MASC = /(?<![\p{L}])(?:слободен|активен|достапен|евидентиран|внесен|заведен|продаден|издаден)(?![\p{L}])/iu;
  for (const v of seeds) {
    assert.ok(!MASC.test(v), `masculine agreement on „недвижност“: ${v}`);
    assert.ok(!/(?<![\p{L}])го\s+имаме(?![\p{L}])/iu.test(v), `„го имаме“ for a feminine property: ${v}`);
  }
});

test('owner ask agrees with the property gender (куќа = feminine)', () => {
  const house = { ...ROWS[0], eb: 55, id: 55, house: true } as Property;
  const l = ownerPropertyLabels(house);
  const ask = buildOwnerAsk(55, 'Четврток, 22.10.2026 во 17:30', {
    eb: 55, proposedTime: 'Четврток, 22.10.2026 во 17:30',
    propertyType: l.type, propertyTypeDef: l.def, possessive: l.possessive,
    dostapen: l.dostapen, relative: l.relative, entered: l.entered,
  });
  assert.match(ask, /за Вашата куќа која во нашиот систем е внесена со број 55/);
  assert.match(ask, /Дали куќата е сè уште достапна/);
  assert.ok(!/Вашиот куќа|кој во нашиот систем|е внесен со број/.test(ask), ask);

  // стан stays masculine.
  const flat = { ...ROWS[0], house: false } as Property;
  const fl = ownerPropertyLabels(flat);
  const flatAsk = buildOwnerAsk(78, 'Петок, 23.10.2026 во 12:00', {
    eb: 78, proposedTime: 'Петок, 23.10.2026 во 12:00',
    propertyType: fl.type, propertyTypeDef: fl.def, possessive: fl.possessive,
    dostapen: fl.dostapen, relative: fl.relative, entered: fl.entered,
  });
  assert.match(flatAsk, /за Вашиот трисобен стан кој во нашиот систем е внесен со број 78/);
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

function makeHandler(rowsArg?: Property[]): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(rowsArg ?? ROWS);
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
  // Stems, not masculine endings: "имотот е достапен" is now "недвижноста е
  // достапна" — the contract is the availability claim, not its gender.
  assert.ok(/достап|активн|баз|евиденц|слободн|располага/iu.test(ack), `availability ack expected, got: ${ack}`);
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

// The [18:59] field capture: the client's typing-window burst lands as ONE
// combined turn ("prasaj\nako e slobodna i ako e dobra ke ja iznajmam"), and
// the availability-ack arm read the availability half as a FRESH availability
// question — re-animating the permission ask the same turn's arrow half just
// answered. Three identical re-acks in a row before the client sent the bare
// arrow. detectSendToOwnerAsk marks the arrow; with ownerContactPending armed
// the serve is the agreement serve: the FEE, never another ack.
test('bundled confirm-arrow ("prasaj\nako e slobodna…") after the ack → FEE, never a re-ack', async () => {
  // Detector shape: the go-ahead arrow fires; offers-to-me stays out.
  assert.equal(detectSendToOwnerAsk('prasaj'), true);
  assert.equal(detectSendToOwnerAsk('pRAŠAJ GO SOPSTVENIKOT'), true);
  assert.equal(detectSendToOwnerAsk('kontaktiraj go sopstvenikot'), true);
  assert.equal(detectSendToOwnerAsk('прашај'), true);
  assert.equal(detectSendToOwnerAsk('prati mi ponudi'), false, 'offer-send to ME is not the owner arrow');
  assert.equal(detectSendToOwnerAsk('ne go kontaktiraj uste'), false, 'hold never reads as a go-ahead');
  assert.equal(detectSendToOwnerAsk('kade se naoga 78?'), false);

  const { handler, sessions, sent } = makeHandler();
  const chatId = 'bundle-arrow';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // 1) availability ask on a known EB → the ack, ownerContactPending armed
  let s = await send('dali e seuste dostapen broj 78?');
  assert.equal(s.slots.ownerContactPending, true, 'ack must arm the owner-contact gate');

  // 2) the bundled turn → the FEE (the arrow step-up), NOT a re-ack
  s = await send('prasaj\nako e slobodna i ako e dobra ke ja iznajmam');
  const bundled = sent[sent.length - 1] ?? '';
  assert.ok(
    /(надомест|300|денари|симболичн|посета|политика)/iu.test(bundled),
    `fee disclosure expected for the bundled arrow, got: ${bundled.slice(0, 160)}`,
  );
  assert.ok(
    !/(?:сакале|сакате)\s+да\s+(?:го\s+)?(?:исконтактирам|контактирам)/iu.test(bundled),
    `bundled turn re-asked the permission the arrow just gave: ${bundled.slice(0, 160)}`,
  );
  assert.equal(s.state, 'closing', 'fee stage keeps the funnel in closing');
  assert.equal(s.slots.ownerContactPending, false, 'the arrow consumes the pending contact gate');

  // 3) a plain yes continues the funnel → contact collection
  s = await send('da');
  assert.equal(s.state, 'contact_collection', 'funnel must continue after the fee');
});

// The [00:49] capture: the client asks „ЕВИДЕНТЕН БРОЈ 47“ — a masculine
// frame. The availability.ack pool is written for the feminine noun
// („недвижноста … достапна“); an ask backed by a masculine row (стан, плац,
// деловен) must serve the code-built masculine line — never „достапна“.
test('availability ack agrees with the ROW gender (an EB ask is a masculine frame)', async () => {
  const masculineLine = AVAILABILITY_ACK;
  assert.ok(/достапен(?![\p{L}])/iu.test(masculineLine), masculineLine);
  const { handler, sent } = makeHandler();
  const chatId = 'gender-masc';
  await handler.handle('test', chatId, 'DALI USTE E NA PRODAZBA 78?');
  const ack = sent[sent.length - 1] ?? '';
  assert.ok(/достапен(?![\p{L}])/iu.test(ack), `masculine ack for a стан row, got: ${ack}`);
  assert.ok(!/достапна(?![\p{L}])/iu.test(ack), ack);
  assert.ok(!FORBIDDEN_CONNECT.test(ack), ack);
});

test('availability ack for a куќа row serves the feminine pool', async () => {
  const femLine = AVAILABILITY_ACK_FEM;
  assert.ok(/достапна(?![\p{L}])/iu.test(femLine), femLine);
  const houseRows: Property[] = [
    { eb: 55, id: 55, location: 'Капиштец', address: 'Тест', price: 120000, service: 'buy', house: true },
  ];
  const { handler, sent } = makeHandler(houseRows);
  const chatId = 'gender-fem';
  await handler.handle('test', chatId, 'DALI USTE E NA PRODAZBA 55?');
  const ack = sent[sent.length - 1] ?? '';
  // The bank pool rotates — the contract is feminine agreement (all its
  // variants speak „недвижноста“), never a masculine-ending claim.
  assert.ok(/(?:достап|активн|баз|евиденц|слободн|располага)/iu.test(ack), `availability ack expected, got: ${ack}`);
  assert.ok(!/(?:достапен|слободен|активен|внесен)(?![\p{L}])/iu.test(ack), `masculine agreement leaked: ${ack}`);
  assert.ok(!/достапен(?![\p{L}])/iu.test(ack), ack);
  assert.ok(!FORBIDDEN_CONNECT.test(ack), ack);
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
