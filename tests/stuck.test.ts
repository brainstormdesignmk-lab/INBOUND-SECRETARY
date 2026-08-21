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
import { detectOwnerVerdict } from '../src/llm/deterministic';
import { LandmarkService } from '../src/geo/landmarks';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

// An LLM that is UP but hallucinates: answers PROPERTY_ID_REQUESTED with no
// propertyId for a budget refinement ("A NESTO POSKAPO DO 1000 EVRA").
class HallucinatingLlm implements LlmClient {
  async complete(): Promise<string> {
    return JSON.stringify({ event: 'PROPERTY_ID_REQUESTED', propertyId: null, reason: 'neshto poskapo' });
  }
}

// An LLM that is UP but fills the budget slot with GARBAGE ("кукја пофтина
// евра") even though the message has a real price. The garbage must never
// reach the reply — the real budget from the message wins.
class GarbageBudgetLlm implements LlmClient {
  async complete(args: { role: string }): Promise<string> {
    if (args.role === 'respond') return 'Еве ги деталите.';
    return JSON.stringify({ event: 'DETAILS_PROVIDED', service: 'buy', budget: 'кукја пофтина евра' });
  }
}

// An LLM that is UP but returns a SENTENCE as the location — it must be
// canonicalized to the feed neighborhood, never echoed verbatim.
class SloppyLocationLlm implements LlmClient {
  async complete(args: { role: string }): Promise<string> {
    if (args.role === 'respond') return 'Еве ги деталите.';
    return JSON.stringify({ event: 'DETAILS_PROVIDED', service: 'buy', location: 'во Кисела Вода кај пазар' });
  }
}

// An LLM that is UP but returns GARBAGE as the location — it must be dropped
// so the deterministic detector fills the real one from the message.
class GarbageLocationLlm implements LlmClient {
  async complete(args: { role: string }): Promise<string> {
    if (args.role === 'respond') return 'Еве ги деталите.';
    return JSON.stringify({ event: 'DETAILS_PROVIDED', service: 'buy', location: 'кукја пофтина' });
  }
}

// An LLM that is UP but MISREADS the visit-time message as DETAILS_PROVIDED
// ("MOZAM UTRE POSLE 18:00" → criteria, not a time). The deterministic
// visit-time override must still start the owner ping-pong.
class MisreadTimeLlm implements LlmClient {
  async complete(args: { role: string; messages: { role: string; content: string }[] }): Promise<string> {
    const last = args.messages[args.messages.length - 1].content;
    if (args.role === 'respond') return 'Еве ги деталите за имотот.';
    if (/DALI E SEUSTE|кога може|KOGA BI/i.test(last)) return JSON.stringify({ event: 'INTERESTED', propertyId: 78 });
    if (/SOGLASUVAM/i.test(last)) return JSON.stringify({ event: 'FEE_AGREED' });
    if (/ZORAN/i.test(last)) return JSON.stringify({ event: 'CONTACT_PROVIDED', name: 'Zoran', phone: '078914196' });
    if (/UTRE|MOZAM/i.test(last)) return JSON.stringify({ event: 'DETAILS_PROVIDED', reason: 'misread the time as criteria' });
    return JSON.stringify({ event: 'PROPERTY_ID_REQUESTED', propertyId: 78 });
  }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  get healthy(): boolean { return true; } // the real getAll sets this.ok — the fake never runs it
}

// The exhausted-area ask is bank-backed (wording varies) — the contract is the
// widen/register ASK itself, never the exact code-built sentence.
const EXHAUSTED_ASK = /(?:друга населба|друг дел од градот|друга локаци|други населби|забележам|регистрирам|контактирам)/iu;

// GORAN's session: buy, Кисела Вода, 60.000 € budget. Карпош's only apartment
// (EB 54) is OVER budget; EB 48 in Карпош is a rental.
const ROWS: Property[] = [
  { eb: 80, id: 80, location: 'Кисела Вода', price: 46000, service: 'buy' },
  { eb: 46, id: 46, location: 'Кисела Вода', price: 72300, service: 'buy' },
  { eb: 53, id: 53, location: 'Аеродром', price: 55000, service: 'buy' },
  { eb: 55, id: 55, location: 'Влае', price: 40000, service: 'buy' },
  { eb: 54, id: 54, location: 'Карпош III', price: 69500, service: 'buy' },
  { eb: 78, id: 78, location: 'Капиштец', price: 185000, service: 'buy', bedrooms: 3, size: '82 м²', address: 'Народен Фронт' },
  { eb: 63, id: 63, location: 'Центар', price: 36000, service: 'buy' },
  { eb: 48, id: 48, location: 'Карпош III', price: 250, service: 'rent' },
  { eb: 56, id: 56, location: undefined, price: 500, service: 'rent', business: true, sqm: 40 },
  { eb: 59, id: 59, location: 'Центар', address: 'Палома Бјанка', price: 950, service: 'rent', business: true, sqm: 105 },
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
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  // viber: the sender id IS the caller's phone (prefillViberPhone) — the
  // insult-protocol tests exercise the phone-backed blocklist through it.
  channels.register({ name: 'viber', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    // Address-privacy landmark resolver — deterministic table layer only, so
    // tests never hit the OSM/Google network.
    landmarks: new LandmarkService(db, { osm: false }),
  });
  return { handler, sessions, sent };
}

test('stuck loop: an area switch re-targets, exhaustion ASKS, agreement widens', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'goran';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // 1) search Кисела Вода up to 60.000 € -> only EB 80 fits
  let s = await send('SAKAM DA KUPAM MALO STANCE VO KISELA VODA, DO 60.000 EVRA');
  assert.equal(s.state, 'presentation');
  assert.ok(sent[0].includes('Евидентен број 80'), sent[0]);

  // 2) rejection -> Кисела Вода is DRAINED -> the exhausted line ASKS about a
  //    different area FIRST — never a silent Влае/Аеродром spill. Bank-backed
  //    (wording varies): the contract is the widen/register ASK, not the text.
  s = await send('NE MI SE DOPAGA, DRUGI OPCII');
  assert.equal(s.state, 'presentation');
  assert.ok(EXHAUSTED_ASK.test(sent[1]), sent[1]);
  assert.ok(!sent[1].includes('Евидентен број 53'), sent[1]); // no spill
  assert.equal(s.slots.areaExhausted, true);

  // 3) "STO IMAS VO KARPOS?" -> location must RE-TARGET to Карпош (was the bug),
  //    and since nothing in Карпош fits the 60k budget -> honest NO_MATCH, NOT a
  //    silent Маџари-style spill.
  s = await send('STO IMAS VO KARPOS ?');
  assert.equal(s.slots.location, 'Карпош III');
  // The no-match line is bank-backed (wording varies): the contract is that it
  // names the re-targeted area honestly and never spills other properties.
  assert.ok(sent[2].includes('Карпош III'), sent[2]);
  assert.ok(!sent[2].includes('Евидентен број'), sent[2]);

  // 4) rejection of the ask -> the exhausted line re-asks (still no spill)
  s = await send('NE MI SE DOPAGA');
  assert.ok(EXHAUSTED_ASK.test(sent[3]), sent[3]);
  assert.ok(!sent[3].includes('Евидентен број 63'), sent[3]);

  // 5) pure agreement on the ask -> the search WIDENS: options from the rest of
  //    the city appear ONLY after the ask, never silently before it
  s = await send('DOBRO');
  assert.equal(s.state, 'presentation');
  assert.equal(s.slots.location, undefined);   // area lock released
  assert.equal(s.slots.areaExhausted, false);
  assert.ok(sent[4].includes('Евидентен број 53'), sent[4]); // price-closest to 60k

  // 6) rejection of the widened batch -> next batch from the rest of the city
  s = await send('NE MI SE DOPAGA');
  assert.ok(sent[5].includes('Евидентен број 63'), sent[5]);
  assert.ok(!sent[5].includes('Ги исцрпивме'), sent[5]);
});

test('multi-area selection: "помало нешто" and bedroom follow-ups stay INSIDE the named areas (never Влае)', async () => {
  // The Влае-spill transcript: "pa moze centar, kisela voda, aerodrom" then
  // "pomalo nesto" / "nesto so edna spalna?" — every presentation must stay in
  // the union of the THREE named areas. EB 55 (Влае) must never appear.
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'jovan';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  let s = await send('ve kontaktiram okolu kupuvanje na stan');
  assert.equal(s.state, 'discovery');

  // the multi-area answer captures ALL THREE neighborhoods
  s = await send('pa moze centar, kisela voda, aerodrom');
  const loc = s.slots.location ?? '';
  assert.ok(loc.includes('Центар') && loc.includes('Кисела Вода') && loc.includes('Аеродром'), loc);
  assert.ok(!loc.includes('Влае'), loc);

  // "помало нешто" mid-discovery -> real offers, SMALLEST first, inside the 3 areas
  s = await send('pomalo nesto');
  assert.equal(s.state, 'presentation');
  assert.ok(sent[2].includes('Евидентен број 53') || sent[2].includes('Евидентен број 63'), sent[2]);
  assert.ok(!sent[2].includes('Влае'), sent[2]); // the spill bug: never Влае

  // "nesto so edna spalna?" -> the NEXT batch, still inside the 3 areas
  s = await send('nesto so edna spalna?');
  assert.equal(s.state, 'presentation');
  assert.ok(!sent[3].includes('Влае'), sent[3]);
  assert.ok(!sent[3].includes('Евидентен број 55'), sent[3]);
});

test('business: деловен простор never asks bedrooms — location/sqm/price, then presentation', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'biz';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  let s = await send('ZDRAVO, SAKAM DA IZNAJMAM DELOVEN PROSTOR VO KARPOS');
  assert.equal(s.slots.business, true);
  assert.equal(s.slots.service, 'rent');
  assert.equal(s.state, 'discovery');
  assert.ok(/(површина|м²|m²|квадрат)/iu.test(sent[0]), sent[0]);
  assert.ok(/(цена|евра)/iu.test(sent[0]), sent[0]);
  assert.ok(!sent[0].includes('спални'), sent[0]);

  // sqm + price -> complete, but Карпош has NO business space ≤ 500 (EB 56 is
  // locationless, EB 59 is Центар) -> honest no-match that ASKS about other
  // areas — never a locationless mystery property presented as "in Карпош"
  s = await send('40 KVADRATI, DO 500 EVRA');
  assert.equal(s.state, 'presentation');
  assert.ok(sent[1].includes('Карпош'), sent[1]);
  assert.ok(/други|друга/.test(sent[1]), sent[1]);
  assert.ok(!sent[1].includes('Евидентен број 56'), sent[1]);
});

test('ZOKI: visit interest ("дали е достапен?") -> fee disclosed -> agreement -> owner ping-pong — never a phone ask before the fee', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'zoki';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // 1) "ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78" -> property_query, property shown
  let s = await send('ZDRAVO. ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  assert.equal(s.state, 'property_query');
  assert.ok(sent[0].includes('Евидентен број 78'), sent[0]);

  // 2) "DALI E SEUSTE DOSTAPEN ?" -> availability ACK asks permission to contact
  //    owner. NO fee yet — the client must confirm they WANT the owner contacted.
  s = await send('DALI E SEUSTE DOSTAPEN ?');
  assert.equal(s.state, 'closing');
  assert.ok(/(?:достапен|постои|база|слободен|достапн)/i.test(sent[1]), sent[1]); // availability ack
  assert.ok(sent[1].includes('?'), sent[1]); // must be a QUESTION (permission ask)
  assert.ok(!sent[1].includes('500 денари'), sent[1]); // fee NOT yet disclosed
  assert.ok(!sent[1].includes('телефонски'), sent[1]); // no phone ask
  assert.ok(s.slots.ownerContactPending, 'ownerContactPending should be set');

  // 3) "DA" -> client confirms they want the owner contacted -> NOW the fee
  s = await send('DA');
  assert.equal(s.state, 'closing');
  assert.ok(sent[2].includes('500 денари'), sent[2]); // buy fee disclosed
  assert.ok(!s.slots.ownerContactPending, 'ownerContactPending should be cleared');

  // 4) "DA, SE SOGLASUVAM" -> FEE_AGREED -> contact_collection (name+phone now)
  s = await send('DA, SE SOGLASUVAM');
  assert.equal(s.state, 'contact_collection');
  assert.ok(sent[3].includes('име'), sent[3]);

  // 5) name + phone -> visit_scheduling -> preferred time question
  s = await send('ZORAN 078/914 196');
  assert.equal(s.state, 'visit_scheduling');
  assert.ok(sent[4].includes('Кој термин'), sent[4]);

  // 6) proposed time -> owner_checking (the owner ping-pong starts)
  s = await send('UTRE POPLADNE POSLE 6');
  assert.equal(s.state, 'owner_checking');
  assert.ok(s.slots.visitTime?.includes('UTRE'), JSON.stringify(s.slots));
  assert.ok(sent[5].includes('потврдам'), sent[5]); // OWNER_CHECK_ACK
});

test('ZOKI: "кога може да се погледне" is visit interest too — same fee funnel', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'zoki2';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  const s = await send('KOGA BI MOZELO DA SE POGLEDNE STANOT ?');
  assert.equal(s.state, 'closing');
  assert.ok(sent[1].includes('500 денари'), sent[1]);
  assert.ok(!sent[1].includes('телефонски'), sent[1]);
});

// The LLM is UP but (mis)classifies the fee-why question as FEE_REFUSED — its
// own rules literally list "зошто надомест" as a refusal. The handler must
// detect the why-question and answer the agency's rationale WITHOUT burning a
// persuasion rung; a GENUINE refusal still uses the ladder.
class FeeWhyMisclassifyingLlm implements LlmClient {
  async complete(args: { role: string; messages: { role: string; content: string }[] }): Promise<string> {
    const last = args.messages[args.messages.length - 1].content;
    if (args.role === 'respond') return 'Еве ги деталите за имотот.';
    if (/DALI E SEUSTE|KOGA BI|кога може|КОГА БИ/i.test(last)) return JSON.stringify({ event: 'INTERESTED', propertyId: 78 });
    if (/ZOSTO|NIKOJ|ЗОШТО|НАПЛАЌАТЕ|NAPLATUVATE/i.test(last)) return JSON.stringify({ event: 'FEE_REFUSED', reason: 'зошто надомест' });
    if (/не сакам да платам|NE SAKAM DA PLATAM/i.test(last)) return JSON.stringify({ event: 'FEE_REFUSED', reason: 'refusal' });
    if (/NE MI SE DOPAGA|DOPAGA/i.test(last)) return JSON.stringify({ event: 'REJECTED', reason: 'rejection' });
    return JSON.stringify({ event: 'PROPERTY_ID_REQUESTED', propertyId: 78 });
  }
}

// The pivot answer is bank-backed (wording varies) — the contract is the
// OFFER itself (other neighborhoods), never the exact sentence.
const PIVOT_OFFER = /(?:друга населба|други населби|друг дел од градот|други делови|друга локаци|други опции|други имоти|останати)/iu;

// Build a handler with the given feed rows + LLM.
function makeFeeHandler(rows: Property[], llm: LlmClient): { handler: InboundHandler; sessions: SessionStore; sent: string[] } {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(rows);
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  // viber: the sender id IS the caller's phone (prefillViberPhone) — the
  // insult-protocol tests exercise the phone-backed blocklist through it.
  channels.register({ name: 'viber', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels });
  return { handler, sessions, sent };
}

// Reach closing on EB 78 (Капиштец) — the fee was just disclosed.
async function reachClosing(send: (m: string) => Promise<unknown>): Promise<void> {
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('KOGA BI MOZELO DA SE POGLEDNE STANOT ?');
}

test('fee resistance PIVOTS to other neighborhoods when alternatives exist ("zosto naplatuvate poseta ?")', async () => {
  const { handler, sessions, sent } = makeFeeHandler(ROWS, new FeeWhyMisclassifyingLlm());
  const chatId = 'zoki3';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await reachClosing(send);
  assert.ok(sent[1].includes('500 денари'), sent[1]); // the fee disclosure came first

  // "зощо наплаќате?" is a WHY question, not a refusal — Lina answers
  // with the agency rationale (fee.why) and stays at closing. The pivot to
  // alternatives only fires for actual refusals (FEE_REFUSED), not questions.
  let s = await send('zosto naplatuvate poseta ?');
  assert.equal(s.state, 'closing', JSON.stringify(s)); // stays at closing — not a refusal
  assert.equal(s.slots.feeRejections, undefined, JSON.stringify(s.slots)); // a question, not a refusal
  const why = sent[2];
  assert.ok(/(?:филтер|филтрираме|препознава|издвојуваме|селекци)/iu.test(why), why); // the filter rationale
  assert.ok(!why.includes('500 денари'), why); // never a disclosure repeat
  assert.ok(!/Евидентен број/.test(why), why); // no property cards in a why-answer

  // NOW a genuine refusal — the pivot fires (alternatives exist in other areas)
  s = await send('не сакам да платам');
  assert.equal(s.state, 'presentation'); // pivoted
  const pivot = sent[3];
  assert.ok(PIVOT_OFFER.test(pivot), pivot); // the other-neighborhoods offer
  assert.ok(/(?:Евидентен број 63|Евидентен број 55)/.test(pivot), pivot); // price-closest alternatives
  assert.ok(!/(?:Евидентен број 78)/.test(pivot), pivot); // the current property is NOT re-offered
  assert.ok(!/Капиштец/.test(pivot), pivot); // its neighborhood is NOT re-offered
  assert.ok(!pivot.includes('500 денари'), pivot); // never a fee disclosure repeat
  assert.ok(/(?:допаѓа|одговара|посета)/iu.test(pivot), pivot); // the pick-closer follows

  // a rejection of the pivoted batch pulls the NEXT batch (normal presentation)
  s = await send('NE MI SE DOPAGA');
  assert.equal(s.state, 'presentation');
  assert.ok((s.slots.currentBatch ?? []).includes(80), JSON.stringify(s.slots)); // next price-closest alternative
  assert.ok(!(s.slots.currentBatch ?? []).includes(78), JSON.stringify(s.slots)); // the resisted property is never re-shown
  assert.equal(s.slots.service, 'buy', JSON.stringify(s.slots)); // pinned from the resisted property
});

test('a fee REFUSAL with alternatives also pivots — and the refusal rung resets for the fresh property', async () => {
  const { handler, sessions, sent } = makeFeeHandler(ROWS, new FeeWhyMisclassifyingLlm());
  const chatId = 'zoki4';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await reachClosing(send);
  let s = await send('не сакам да платам'); // a genuine refusal
  assert.equal(s.state, 'presentation'); // pivoted — alternatives exist
  assert.equal(s.slots.feeRejections, undefined, JSON.stringify(s.slots)); // reset: the new property gets a fresh fee ask
  assert.ok(PIVOT_OFFER.test(sent[2]), sent[2]);
  assert.ok(/(?:Евидентен број 63|Евидентен број 55)/.test(sent[2]), sent[2]);
});

test('no alternatives anywhere: the fee question stays — filter rationale for why, persuasion ladder for refusals', async () => {
  // A feed with ONLY EB 78 — nothing else exists in any neighborhood.
  const single = new FakeProps([{ eb: 78, id: 78, location: 'Капиштец', price: 185000, service: 'buy' }]);
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const llm = new FeeWhyMisclassifyingLlm();
  const classifier = new Classifier(llm, cfg, single);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties: single,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels });
  const chatId = 'zoki5';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await reachClosing(send);

  // why-question with NOTHING else available -> the filter rationale (fee.why),
  // state stays at the fee question — no cards, no pivot.
  let s = await send('zosto naplatuvate poseta ?');
  assert.equal(s.state, 'closing');
  assert.equal(s.slots.feeRejections, undefined);
  const why = sent[2];
  assert.ok(/(?:филтер|филтрираме|препознава|издвојуваме|селекци)/iu.test(why), why); // the filter rationale
  assert.ok(/(?:симболич)/iu.test(why), why); // symbolic for serious clients
  assert.ok(/Дали (?:се согласувате|го прифаќате|Ви одговара|би прифатиле)/u.test(why), why); // agreement re-ask
  assert.ok(!why.includes('500 денари'), why); // never a disclosure repeat
  assert.ok(!why.includes('Евидентен број'), why); // no cards

  // a genuine REFUSAL with nothing else -> the persuasion ladder burns a rung
  s = await send('не сакам да платам');
  assert.equal(s.state, 'closing');
  assert.equal(s.slots.feeRejections, 1);
  assert.ok(sent[3].includes('500 денари'), sent[3]); // persuade.1 anchors the amount
});

test('"DOGOVORI MI ZA OVOJ SO BROJ 89" is visit interest — fee disclosed first, never the property-query re-ask', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'dogovori';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // the exact paste: the client is in presentation and explicitly asks to
  // ARRANGE the visit for EB 89 — the bare number must not downgrade this to
  // "tell me about 89" (property_query + card + "Дали овој имот Ви одговара?").
  let s = await send('SAKAM DA KUPAM MALO STANCE VO AERODROM, DO 120.000 EVRA');
  assert.equal(s.state, 'presentation');
  s = await send('DOGOVORI MI ZA OVOJ SO BROJ 89');
  assert.equal(s.state, 'closing'); // straight to the fee, not a card re-ask
  assert.equal(s.slots.interestedPropertyId, 89);
  assert.ok(sent[1].includes('500 денари'), sent[1]); // buy fee disclosed (code-built)
  assert.ok(!sent[1].includes('Дали овој имот Ви одговара'), sent[1]); // never the closing question again

  // the same message with the Latin imperative must also route to closing
  const { handler: h2, sessions: s2, sent: sent2 } = makeHandler();
  const chatId2 = 'dogovori2';
  const send2 = async (m: string) => { await h2.handle('test', chatId2, m); return s2.get(chatId2)!; };
  let t = await send2('SAKAM DA KUPAM MALO STANCE VO AERODROM, DO 120.000 EVRA');
  assert.equal(t.state, 'presentation');
  t = await send2('ZAKAZI MI ZA OVOJ SO BROJ 89');
  assert.equal(t.state, 'closing');
  void sent2;
});

test('an LLM sloppy location ("во Кисела Вода кај пазар") is canonicalized to the feed neighborhood', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new SloppyLocationLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  // viber: the sender id IS the caller's phone (prefillViberPhone) — the
  // insult-protocol tests exercise the phone-backed blocklist through it.
  channels.register({ name: 'viber', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels });
  const chatId = 'sloppy';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  const s = await send('SAKAM DA KUPAM STAN'); // the LLM invents the location
  assert.equal(s.state, 'discovery');
  assert.equal(s.slots.location, 'Кисела Вода'); // canonical, not the sentence
  // NO recap anymore — the reply just asks what's still missing (bedrooms+budget),
  // and the garbage suffix never reaches it
  assert.ok(/спални/.test(sent[0]), sent[0]);
  assert.ok(!sent[0].includes('кај пазар'), sent[0]);
  assert.ok(!sent[0].includes('Разбрав — барате'), sent[0]);
});

test('an LLM garbage location ("кукја пофтина") never reaches the reply — the real location from the message wins', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new GarbageLocationLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  // viber: the sender id IS the caller's phone (prefillViberPhone) — the
  // insult-protocol tests exercise the phone-backed blocklist through it.
  channels.register({ name: 'viber', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels });
  const chatId = 'gloc';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  const s = await send('SAKAM DA KUPAM STAN VO KISELA VODA'); // message carries the real location
  assert.equal(s.state, 'discovery');
  assert.equal(s.slots.location, 'Кисела Вода');
  // no recap — the reply asks what's missing, and the garbage never reaches it
  assert.ok(/спални/.test(sent[0]), sent[0]);
  assert.ok(!sent[0].includes('кукја'), sent[0]);
  assert.ok(!sent[0].includes('пофтина'), sent[0]);
  assert.ok(!sent[0].includes('Разбрав — барате'), sent[0]);
});

test('an LLM garbage budget ("кукја пофтина евра") never reaches the reply — the real budget wins', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new GarbageBudgetLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  // viber: the sender id IS the caller's phone (prefillViberPhone) — the
  // insult-protocol tests exercise the phone-backed blocklist through it.
  channels.register({ name: 'viber', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels });
  const chatId = 'budget';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // the LLM says budget="кукја пофтина евра" but the message says DO 50000
  // EVRA — the garbage is dropped and the REAL budget is stored
  const s = await send('SAKAM DA KUPAM STAN DO 50000 EVRA');
  assert.equal(s.state, 'discovery');
  assert.equal(s.slots.budget, '50000');
  // no recap — the reply asks the missing location, never echoes the budget
  assert.ok(/(дел од градот|населба|локаци)/iu.test(sent[0]), sent[0]);
  assert.ok(!sent[0].includes('50.000'), sent[0]);
  assert.ok(!sent[0].includes('кукја'), sent[0]);
  assert.ok(!sent[0].includes('пофтина'), sent[0]);
  assert.ok(!sent[0].includes('Разбрав — барате'), sent[0]);
});

test('"SAKAM DA KUPAM KUKJA" is a HOUSE request — discovery speaks куќа, never стан', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'kukja';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  let s = await send('SAKAM DA KUPAM KUKJA');
  assert.equal(s.state, 'discovery');
  assert.equal(s.slots.service, 'buy');
  assert.equal(s.slots.house, true);
  // NO recap — just the missing question, house-wording intact
  assert.ok(/куќ/.test(sent[0]) && /(дел од градот|населба|локаци)/iu.test(sent[0]), sent[0]);
  assert.ok(!sent[0].includes('барате куќа за купување'), sent[0]);
  assert.ok(!sent[0].includes('стан'), sent[0]);
  assert.ok(!sent[0].includes('Разбрав — барате'), sent[0]);
});

test('Viber: the contacting number (sender id) is known and stored — contact completes with the name alone', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'viber', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels });
  const chatId = '38970123456'; // real Viber sender id = the caller's phone number
  const send = async (m: string) => { await handler.handle('viber', chatId, m); return sessions.get(chatId)!; };

  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA'); // confirm owner contact
  await send('DA, SE SOGLASUVAM');
  let s = await send('GORAN MOZE NA OVOJ BROJ');
  assert.equal(s.state, 'visit_scheduling'); // name alone completes the contact
  assert.equal(s.slots.phone, '38970123456'); // THE contacting number is stored
  assert.ok(s.slots.name === 'Goran' || s.slots.name === 'Горан', JSON.stringify(s.slots));
  // the contact ask was name-only — Lina never asks for a number she already has
  assert.ok(sent[3].includes('име и презиме'), sent[3]);
  assert.ok(!sent[3].includes('телефонски'), sent[3]);
});

test('LLM-free: "lile" then "078914198" — the phone is never eaten as a budget, and the re-ask never repeats the known name', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'lile';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // reach contact_collection (LLM-down, the transcript flow: EB -> availability -> confirm contact -> fee -> agree)
  await send('ve kontaktiram vo vrska so oglasot so evidenten broj 53');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA'); // confirm owner contact
  await send('DA, SE SOGLASUVAM');
  let s = await send('lile');
  assert.equal(s.state, 'contact_collection');
  assert.equal(s.slots.name, 'Lile', JSON.stringify(s.slots));
  assert.equal(s.slots.phone, undefined);
  // with the name known, the ask is PHONE-ONLY — never repeats the name
  const askPhone = sent[sent.length - 1];
  assert.ok(/телефон|број/i.test(askPhone), askPhone);
  assert.ok(!/име и презиме/i.test(askPhone), askPhone);

  s = await send('078914198');
  // the digits must be a PHONE, not a budget — contact completes to visit_scheduling
  assert.equal(s.state, 'visit_scheduling', JSON.stringify(s.slots));
  assert.equal(s.slots.phone, '078914198', JSON.stringify(s.slots));
  assert.equal(s.slots.name, 'Lile', JSON.stringify(s.slots));
  assert.equal(s.slots.budget, undefined, JSON.stringify(s.slots));
});

test('LLM-free: "па ти ги напишав" never overwrites the stored name', async () => {
  const { handler, sessions } = makeHandler();
  const chatId = 'napisav';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ve kontaktiram vo vrska so oglasot so evidenten broj 53');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA'); // confirm owner contact
  await send('DA, SE SOGLASUVAM');
  let s = await send('lile');
  assert.equal(s.slots.name, 'Lile');
  s = await send('pa ti gi napisav');
  assert.equal(s.slots.name, 'Lile', JSON.stringify(s.slots)); // NOT "Napisav"
  assert.equal(s.state, 'contact_collection');
});

// An LLM that is UP but fills the contact/time fields with GARBAGE ("кукја
// пофтина" as name/phone/visitTime). parseClassified must drop the garbage
// and the deterministic intake must fill the REAL values from the message —
// the appointment record can never store the garbage.
class GarbageContactLlm implements LlmClient {
  async complete(args: { role: string; messages: { role: string; content: string }[] }): Promise<string> {
    const last = args.messages[args.messages.length - 1].content;
    if (args.role === 'respond') return 'Еве ги деталите за имотот.';
    if (/DALI E SEUSTE|кога може|KOGA BI/i.test(last)) return JSON.stringify({ event: 'INTERESTED', propertyId: 78 });
    if (/SOGLASUVAM/i.test(last)) return JSON.stringify({ event: 'FEE_AGREED' });
    if (/ZORAN/i.test(last)) return JSON.stringify({ event: 'CONTACT_PROVIDED', name: 'кукја пофтина', phone: 'кукја пофтина' });
    if (/UTRE|MOZAM/i.test(last)) return JSON.stringify({ event: 'VISIT_TIME_PROVIDED', visitTime: 'кукја пофтина' });
    return JSON.stringify({ event: 'PROPERTY_ID_REQUESTED', propertyId: 78 });
  }
}

test('garbage name/phone/visitTime from the LLM never reach the appointment record — deterministic intake fills the real values', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new GarbageContactLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const appointments = new AppointmentStore(db);
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments, escalations: new EscalationStore(db), meta: new MetaStore(db), channels });
  const chatId = 'garbcontact';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA'); // confirm owner contact
  await send('DA, SE SOGLASUVAM');
  let s = await send('ZORAN PETROVSKI 078/914 196');
  // the garbage name/phone were dropped -> deterministic detectContact filled
  // the real ones from the message
  assert.equal(s.state, 'visit_scheduling');
  assert.equal(s.slots.name, 'Zoran Petrovski', JSON.stringify(s.slots));
  assert.equal(s.slots.phone, '078914196', JSON.stringify(s.slots));

  s = await send('MOZAM UTRE POPLADNE POSLE 6');
  assert.equal(s.state, 'owner_checking');
  assert.ok(s.slots.visitTime?.includes('UTRE'), JSON.stringify(s.slots));

  handler.ownerAnswer(chatId, 78, detectOwnerVerdict('да, може', s.slots.visitTime ?? '')!);
  await new Promise(r => setTimeout(r, 50));
  const rows = appointments.listByChat(chatId);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].clientName, 'Zoran Petrovski');
  assert.equal(rows[0].clientPhone, '078914196');
  assert.ok(rows[0].time?.includes('UTRE'), JSON.stringify(rows[0]));
  // NOT a single trace of the LLM garbage in the persisted record
  assert.ok(!rows[0].clientName.includes('кукја'), JSON.stringify(rows[0]));
  assert.ok(!rows[0].clientPhone.includes('кукја'), JSON.stringify(rows[0]));
  assert.ok(!rows[0].time?.includes('кукја'), JSON.stringify(rows[0]));
});

test('owner_checking: the client rejects the proposed time -> new time collected, owner re-asked with it (ping-pong survives)', async () => {
  const { handler, sessions, sent } = makeHandler();
  const ownerAsks: string[] = [];
  handler.onOwnerAsk = (_chatId, eb, q) => { ownerAsks.push(`${eb}: ${q}`); };
  const chatId = 'ping4';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA'); // confirm owner contact
  await send('DA, SE SOGLASUVAM');
  await send('ZORAN 078/914 196');
  let s = await send('UTRE POPLADNE POSLE 6');
  assert.equal(s.state, 'owner_checking');
  assert.equal(ownerAsks.length, 1);
  assert.ok(ownerAsks[0].includes('UTRE POPLADNE POSLE 6'), ownerAsks[0]);

  // the client can't do the proposed time -> back to the time question, NOT
  // the patience line, and no new owner ask for a time the client rejected
  s = await send('NE MOZAM VO 18:00 DALI MOZE POKASNO');
  assert.equal(s.state, 'visit_scheduling');
  assert.ok(sent[6].includes('Кој термин'), sent[6]);
  assert.equal(ownerAsks.length, 1);

  // a NEW concrete time -> owner_checking again, owner re-asked WITH it
  s = await send('MOZAM VO 19:00');
  assert.equal(s.state, 'owner_checking');
  assert.equal(ownerAsks.length, 2);
  assert.ok(ownerAsks[1].includes('19:00'), ownerAsks[1]);
  assert.ok(!ownerAsks[1].includes('18:00'), ownerAsks[1]);
});

test('visit time survives an LLM misread: "MOZAM UTRE POSLE 18:00" as DETAILS_PROVIDED still starts the owner ping-pong', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new MisreadTimeLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  const ownerAsks: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels });
  handler.onOwnerAsk = (_c, eb, q) => { ownerAsks.push(`${eb}: ${q}`); };
  const chatId = 'misread';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA'); // confirm owner contact
  await send('DA, SE SOGLASUVAM');
  await send('ZORAN 078/914 196');
  let s = await send('MOZAM UTRE POSLE 18:00'); // the user's paste wording
  assert.equal(s.state, 'owner_checking'); // NOT stuck re-asking the time
  assert.ok(s.slots.visitTime?.includes('UTRE'), JSON.stringify(s.slots));
  assert.equal(ownerAsks.length, 1);
  assert.ok(ownerAsks[0].includes('78') && ownerAsks[0].includes('достапен'), ownerAsks[0]);
  assert.ok(sent[5].includes('потврдам'), sent[5]); // to the client: waiting
});

test('owner ping-pong: Lina ASKS the owner, his plain-text answer is relayed — ok / counter / gone', async () => {
  const { handler, sessions, sent } = makeHandler();
  const ownerAsks: string[] = [];
  handler.onOwnerAsk = (_chatId, eb, q) => { ownerAsks.push(`${eb}: ${q}`); };
  const tick = () => new Promise(r => setTimeout(r, 50));
  const toOwner = (chatId: string, eb: number, t: string) =>
    handler.ownerAnswer(chatId, eb, detectOwnerVerdict(t, 'UTRE POPLADNE POSLE 6')!);
  const last = () => sent[sent.length - 1];

  // --- scenario 1: owner says OK -> the visit is confirmed at the client's time
  const c1 = 'ping1';
  const s1 = async (m: string) => { await handler.handle('test', c1, m); return sessions.get(c1)!; };
  await s1('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await s1('DALI E SEUSTE DOSTAPEN ?');
  await s1('DA'); // confirm owner contact
  await s1('DA, SE SOGLASUVAM');
  await s1('ZORAN 078/914 196');
  let s = await s1('UTRE POPLADNE POSLE 6');
  assert.equal(s.state, 'owner_checking');
  assert.ok(last().includes('потврдам'), last()); // to the client: waiting
  // the ping-pong QUESTION reached the owner (available now? agree to the time?)
  assert.equal(ownerAsks.length, 1);
  assert.ok(ownerAsks[0].includes('78') && ownerAsks[0].includes('достапен'), ownerAsks[0]);
  assert.ok(ownerAsks[0].includes('UTRE POPLADNE POSLE 6'), ownerAsks[0]);
  // owner: "да, може" (plain text) -> ok -> confirmed at the proposed time
  toOwner(c1, 78, 'da, moze');
  await tick();
  s = sessions.get(c1)!;
  assert.equal(s.state, 'pending');
  assert.ok(last().includes('Договорена посета'), last());

  // --- scenario 2: owner COUNTERS with петок во 11 -> relayed -> client accepts
  const c2 = 'ping2';
  const s2 = async (m: string) => { await handler.handle('test', c2, m); return sessions.get(c2)!; };
  await s2('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await s2('DALI E SEUSTE DOSTAPEN ?');
  await s2('DA'); // confirm owner contact
  await s2('DA, SE SOGLASUVAM');
  await s2('ZORAN 078/914 196');
  s = await s2('UTRE POPLADNE POSLE 6');
  assert.equal(ownerAsks.length, 2);
  toOwner(c2, 78, 'ne, samo vo petok vo 11');
  await tick();
  s = sessions.get(c2)!;
  assert.equal(s.state, 'time_confirm');
  assert.ok(last().toLowerCase().includes('петок во 11'), last()); // relayed to the client
  s = await s2('VO RED, TOA VREME E DOBRO');
  assert.equal(s.state, 'pending');
  assert.ok(last().includes('Договорена посета'), last());

  // --- scenario 3: owner says GONE -> honest message, no fake confirmation
  const c3 = 'ping3';
  const s3 = async (m: string) => { await handler.handle('test', c3, m); return sessions.get(c3)!; };
  await s3('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await s3('DALI E SEUSTE DOSTAPEN ?');
  await s3('DA'); // confirm owner contact
  await s3('DA, SE SOGLASUVAM');
  await s3('ZORAN 078/914 196');
  s = await s3('UTRE POPLADNE POSLE 6');
  assert.equal(ownerAsks.length, 3);
  toOwner(c3, 78, 'prodaden e');
  await tick();
  s = sessions.get(c3)!;
  assert.equal(s.state, 'presentation');
  assert.ok(last().includes('продаден'), last());
  assert.ok(!last().includes('Договорена'), last());
});

test('owner counter-offer: accept/reject the owner time works with every LLM down', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'bob';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // reach owner_checking (interest -> fee -> agree -> contact -> time)
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA'); // confirm owner contact
  await send('DA, SE SOGLASUVAM');
  await send('ZORAN 078/914 196');
  let s = await send('UTRE POPLADNE POSLE 6');
  assert.equal(s.state, 'owner_checking');

  // owner counter-proposes a different time -> time_confirm
  const agent = handler.ownerAgent as unknown as {
    simulate?: (chatId: string, eb: number, action: 'ok' | 'sold' | 'rented' | 'counter', ownerTime?: string) => boolean;
  };
  assert.ok(agent.simulate?.(chatId, 78, 'counter', 'петок во 17:00'));
  await new Promise(r => setTimeout(r, 50)); // let the enqueued verdict land
  s = sessions.get(chatId)!;
  assert.equal(s.state, 'time_confirm');
  assert.ok(sent[6].includes('петок во 17:00'), sent[6]);

  // accept the counter-time -> pending (confirmed appointment), LLM down
  s = await send('VO RED, TOA VREME E DOBRO');
  assert.equal(s.state, 'pending');
  assert.ok(sent[7].includes('Договорена посета'), sent[7]);
});

test('owner refusal "denes nema da mozam" is a COUNTER — the visit is never confirmed, the owner text never stored as the time', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'odbi';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // reach owner_checking (interest -> fee -> agree -> contact -> time)
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA'); // confirm owner contact
  await send('DA, SE SOGLASUVAM');
  await send('ZORAN 078/914 196');
  let s = await send('deneska vo 18:00');
  assert.equal(s.state, 'owner_checking');

  // THE PASTE: the owner says he CAN'T today but proposes tomorrow 16:00.
  // The refusal must NEVER resolve to ok (that closed the deal in the field)
  // and the raw owner text must never become the stored visit time.
  handler.ownerAnswer(chatId, 78, detectOwnerVerdict('denes nema da mozam. utre vo 16:00 ?', 'deneska vo 18:00')!);
  await new Promise(r => setTimeout(r, 50)); // let the enqueued verdict land
  s = sessions.get(chatId)!;
  assert.equal(s.state, 'time_confirm');
  const relay = sent[sent.length - 1];
  assert.ok(relay.includes('Утре во 16:00'), relay);   // the counter time, Cyrillic, correct day
  assert.ok(!relay.includes('Договорена посета'), relay); // NOT closed
  assert.ok(!relay.includes('nema da mozam'), relay);      // raw owner text never relayed verbatim
  assert.ok(!(s.slots.ownerTime ?? '').includes('nema da mozam'), JSON.stringify(s.slots));

  // client accepts the counter -> pending (confirmed at the OWNER's time)
  s = await send('VO RED, TOA VREME E DOBRO');
  assert.equal(s.state, 'pending');
  assert.ok(sent[sent.length - 1].includes('Договорена посета'), sent[sent.length - 1]);
  assert.ok(sent[sent.length - 1].includes('Утре во 16:00'), sent[sent.length - 1]);
});

test('owner BARE refusal (no alternative time): no fabricated "по договор" term — client is asked for another time, owner re-asked with it', async () => {
  const { handler, sessions, sent } = makeHandler();
  const ownerAsks: string[] = [];
  handler.onOwnerAsk = (_chatId, eb, q) => { ownerAsks.push(`${eb}: ${q}`); };
  const chatId = 'bare';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA'); // confirm owner contact
  await send('DA, SE SOGLASUVAM');
  await send('ZORAN 078/914 196');
  let s = await send('UTRE VO 18:00');
  assert.equal(s.state, 'owner_checking');

  // THE FIELD: the owner refuses the proposed time without offering another
  handler.ownerAnswer(chatId, 78, detectOwnerVerdict('ne mozam vo toj termin', 'UTRE VO 18:00')!);
  await new Promise(r => setTimeout(r, 50)); // let the enqueued verdict land
  s = sessions.get(chatId)!;
  const relay = sent[sent.length - 1];
  assert.equal(s.state, 'visit_scheduling');       // NOT time_confirm — nothing to accept
  assert.ok(relay.includes('не може'), relay);     // honest refusal relayed
  assert.ok(relay.includes('Кој термин'), relay);  // asks for another time
  assert.ok(!relay.includes('по договор'), relay); // no fabricated term
  assert.ok(!relay.includes('Договорена посета'), relay); // never closed at the refused time

  // the client proposes ANOTHER time -> the owner is re-asked with it
  s = await send('MOZAM VO 19:00');
  assert.equal(s.state, 'owner_checking');
  assert.equal(ownerAsks.length, 2);
  assert.ok(ownerAsks[1].includes('19:00'), ownerAsks[1]);
  assert.ok(!ownerAsks[1].includes('18:00'), ownerAsks[1]);
});

test('TUI /owner counter WITHOUT a time = bare refusal: same honest path, never "по договор"', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'bare2';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA'); // confirm owner contact
  await send('DA, SE SOGLASUVAM');
  await send('ZORAN 078/914 196');
  let s = await send('UTRE VO 18:00');
  assert.equal(s.state, 'owner_checking');

  const agent = handler.ownerAgent as unknown as {
    simulate?: (chatId: string, eb: number, action: 'ok' | 'sold' | 'rented' | 'counter', ownerTime?: string) => boolean;
  };
  assert.ok(agent.simulate?.(chatId, 78, 'counter')); // no time → bare refusal
  await new Promise(r => setTimeout(r, 50));
  s = sessions.get(chatId)!;
  const relay = sent[sent.length - 1];
  assert.equal(s.state, 'visit_scheduling');
  assert.ok(relay.includes('не може'), relay);
  assert.ok(!relay.includes('по договор'), relay);
  assert.ok(!relay.includes('Договорена посета'), relay);
});

test('JANE burst: "ZDRAVO / MI TREBA STAN POD KIRIJA / DO 250 EVRA" as ONE turn → one rent-aware reply, never EB 250', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'jane';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // The TUI joins the client's burst into ONE pipeline message (flushClient).
  const s = await send('ZDRAVO\nMI TREBA STAN POD KIRIJA\nDO 250 EVRA');
  assert.equal(s.state, 'discovery');
  assert.equal(s.slots.service, 'rent');
  assert.equal(s.slots.budget, '250');
  // ONE reply, rent-aware slots stored — never the buy/rent battery, never EB 250,
  // and NO recap (the burst's own words are not echoed back)
  assert.equal(sent.length, 1, sent.join(' | '));
  assert.ok(/стан/.test(sent[0]) && /(дел од градот|населба|локаци)/iu.test(sent[0]), sent[0]);
  assert.ok(!sent[0].includes('за изнајмување'), sent[0]); // no recap echo
  assert.ok(!sent[0].includes('до 250 евра'), sent[0]);
  assert.ok(!sent[0].includes('купување или за изнајмување'), sent[0]);
  assert.ok(!sent[0].includes('Евидентен број 250'), sent[0]);
  assert.ok(!sent[0].includes('не можам да го најдам'), sent[0]);
  assert.ok(!sent[0].includes('Разбрав — барате'), sent[0]);
});

test('GORAN TUI regression: "MI TREBA STANCE VO AERODROM" is NOT a buy statement — intent is asked, never claimed', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'goran3';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // the exact paste from the TUI: no buy/rent marker -> discovery must ASK the
  // intent question, never claim "барате стан за купување". NO recap anywhere.
  let s = await send('MI TREBA STANCE VO AERODROM');
  assert.equal(s.state, 'discovery');
  assert.equal(s.slots.service, undefined);
  assert.equal(s.slots.location, 'Аеродром');
  assert.ok(!sent[0].includes('Разбрав — барате'), sent[0]);
  assert.ok(/стан/.test(sent[0]) && /(куп|изнајм|кириј)/iu.test(sent[0]), sent[0]);
  assert.ok(!sent[0].includes('барате стан за купување'), sent[0]); // never the false claim
  assert.ok(!sent[0].includes('Евидентен број'), sent[0]); // no property before intent

  // the client answers the intent question -> only bedrooms + budget remain.
  // No recap on any ask — plain questions only.
  s = await send('ZA KUPUVANJE');
  assert.equal(s.slots.service, 'buy');
  assert.equal(s.state, 'discovery');
  assert.ok(!sent[1].includes('Разбрав — барате'), sent[1]);
  assert.ok(/спални/.test(sent[1]), sent[1]);
  assert.ok(/(цена|евра)/iu.test(sent[1]), sent[1]);
  assert.ok(!sent[1].includes('купување или за изнајмување'), sent[1]);
});

test('bare "MI TREBA STANCE" (no details at all) still enters discovery, intent asked', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'bareneed';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // the smoke-test case: not even a location — the funnel must still move
  // idle -> discovery and ask the intent question, never claim buy.
  let s = await send('MI TREBA STANCE');
  assert.equal(s.state, 'discovery');
  assert.equal(s.slots.service, undefined);
  // bare need -> generic greeting + intent question (bank greeting.open),
  // never "барате стан за купување" and never the apartment intro
  assert.ok(/куп|изнајм|кириј/i.test(sent[0]), sent[0]);
  assert.ok(!sent[0].includes('барате стан за купување'), sent[0]);
  assert.ok(!sent[0].includes('најсоодветни станови'), sent[0]);

  // answer the intent -> normal discovery continues (location asked next)
  s = await send('ZA KUPUVANJE');
  assert.equal(s.slots.service, 'buy');
  assert.ok(/стан/.test(sent[1]) && /(дел од градот|населба|локаци)/iu.test(sent[1]), sent[1]);
  assert.ok(!sent[1].includes('купување или за изнајмување'), sent[1]); // intent never re-asked
});

test('LLM-provided phone is normalized like the deterministic path (078/914 196 → 078914196)', async () => {
  // an LLM that is UP and hands back the phone with separators — parseClassified
  // must store the SAME canonical number detectContact produces.
  class SloppyPhoneLlm implements LlmClient {
    async complete(args: { role: string }): Promise<string> {
      if (args.role === 'respond') return 'Еве ги деталите.';
      return JSON.stringify({ event: 'CONTACT_PROVIDED', name: 'Zoran', phone: '078/914 196' });
    }
  }
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new SloppyPhoneLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  // viber: the sender id IS the caller's phone (prefillViberPhone) — the
  // insult-protocol tests exercise the phone-backed blocklist through it.
  channels.register({ name: 'viber', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels });
  const chatId = 'sloppyphone';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // reach contact_collection (LLM responds INTERESTED/FEE_AGREED via the override-free path:
  // use FailingLlm-style messages that the funnel overrides catch deterministically)
  await send('DALI E SEUSTE DOSTAPEN ?'); // visit interest -> INTERESTED -> closing
  await send('DA, SE SOGLASUVAM');        // agreement in closing -> FEE_AGREED -> contact_collection
  const s = await send('ZORAN 078/914 196');
  assert.equal(s.slots.phone, '078914196');
  assert.equal(s.slots.name, 'Zoran');
});

test('"A NESTO POSKAPO DO 1000 EVRA": a hallucinated EB-0 property query stays in the funnel', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const llm = new HallucinatingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  // viber: the sender id IS the caller's phone (prefillViberPhone) — the
  // insult-protocol tests exercise the phone-backed blocklist through it.
  channels.register({ name: 'viber', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels });
  const chatId = 'poskapo';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // business discovery flow, then the budget refinement (the paste scenario)
  await send('ZDRAVO, MI TREBA DUKJAN POD KIRIJA');
  await send('VO CENTAR');
  const s = await send('A NESTO POSKAPO DO 1000 EVRA');
  assert.equal(s.state, 'discovery'); // never property_query
  assert.equal(s.slots.budget, '1000');
  assert.equal(s.slots.propertyId, undefined);
  // the recap was on the FIRST ask — this ask is plain (never echoes "до 1.000 евра")
  assert.ok(!sent[2].includes('Разбрав — барате'), sent[2]);
  assert.ok(!sent[2].includes('до 1.000 евра'), sent[2]);
  assert.ok(/(површина|м²|m²|квадрат)/iu.test(sent[2]), sent[2]);
  assert.ok(!sent[2].includes('Евидентен број 0'), sent[2]);
  assert.ok(!sent[2].includes('не можам да го најдам'), sent[2]);
});

test('"KADE E TOA PALOMA BJANKA ?" — a place question is answered from the DB, never a search/exhausted reply', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'kade';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // the exact paste: "каде е X?" must be ANSWERED (EB 59's address is in the
  // feed), never misread as a search in Палома Бјанка with zero matches.
  let s = await send('KADE E TOA PALOMA BJANKA ?');
  assert.equal(s.state, 'idle'); // the where-answer does not change the funnel
  // ADDRESS PRIVACY: the street is never named — the answer gives the
  // neighborhood or a resolved landmark ("во близина на …").
  assert.ok(!sent[0].includes('Палома Бјанка'), sent[0]); // the address stays hidden
  assert.ok(sent[0].includes('во близина на'), sent[0]);
  assert.ok(!sent[0].includes('улица'), sent[0]);
  assert.ok(!sent[0].includes('исцрпивме'), sent[0]);
  assert.ok(!sent[0].includes('немам слободни'), sent[0]);

  // generic referent: "каде се наоѓа тој стан?" right after a presentation
  // answers with the SHOWN property's location, not a new search.
  await send('SAKAM DA KUPAM STAN VO CENTAR, 2 SPALNI, DO 40.000 EVRA');
  assert.ok(sent[1].includes('Евидентен број 63'), sent[1]);
  s = await send('KADE SE NAOGA TOJ STAN ?');
  assert.equal(s.state, 'presentation'); // state untouched
  // EB 63 is in Центар (населба) — the deterministic table answers with a
  // landmark ("во близина на …"), never the street.
  assert.ok(sent[2].includes('во близина на'), sent[2]);
  assert.ok(!sent[2].includes('улица'), sent[2]);
  assert.ok(!sent[2].includes('исцрпивме'), sent[2]);
});

test('exact-address ask: "потoчно која улица?" gets the privacy line, never the street', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'adresa';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // the exact pastes, both scripts — answered deterministically, never the street
  await send('SAKAM DA KUPAM STAN VO CENTAR, 2 SPALNI, DO 40.000 EVRA');
  assert.ok(sent[0].includes('Евидентен број 63'), sent[0]);
  let s = await send('potocno koja ulica ?');
  assert.equal(s.state, 'presentation'); // the answer does not change the funnel
  // ADDRESS PRIVACY: the street is NEVER named — the exact-address line tells
  // the reveal time (2 часа пред посетата / на денот на посетата).
  assert.ok(!sent[1].includes('улица'), sent[1]);
  assert.ok(!sent[1].includes('се наоѓа'), sent[1]);
  assert.ok(/час[аи]?\s+пред|денот\s+на\s+посета|на\s+самата\s+посета|на\s+самиот\s+ден|непосредно\s+пред|пред\s+средбата|термин[аот]*\s+/i.test(sent[1]), sent[1]);
  assert.ok(!sent[1].includes('во близина на'), sent[1]); // asked PAST the landmark

  // Cyrillic variant after a property_query — same privacy answer
  s = await send('точно која адреса?');
  assert.equal(s.state, 'presentation');
  assert.ok(!sent[2].includes('улица'), sent[2]);
  assert.ok(/час[аи]?\s+пред|денот\s+на\s+посета|на\s+самата\s+посета|на\s+самиот\s+ден|непосредно\s+пред|пред\s+средбата|термин[аот]*\s+/i.test(sent[2]), sent[2]);
});

test('stuck loop: the exhausted line never repeats for contact requests', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'goran2';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };
  // search + reject until every option is shown (exhausted line fires ONCE legitimately)
  await send('SAKAM DA KUPAM MALO STANCE VO KISELA VODA, DO 60.000 EVRA');
  await send('NE MI SE DOPAGA');
  await send('NE MI SE DOPAGA');
  let s = await send('NE MI SE DOPAGA');
  assert.ok(EXHAUSTED_ASK.test(sent[3]), sent[3]); // honest exhausted ask, once
  // contact intent must then move forward — never repeat the exhausted line
  s = await send('KONTAKTIRAJ ME');
  assert.equal(s.state, 'contact_collection');
  assert.ok(sent[4].includes('име и презиме'), sent[4]);
  assert.ok(/телефон/.test(sent[4]), sent[4]);
  assert.ok(!sent[4].includes('Ги исцрпивме'), sent[4]);
});

test('"не барам стан" pivots — Lina asks what the client DOES want, never repeats the same ask', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'denial';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // 1) bare greeting -> generic buy/rent ask (no apartment assumption)
  let s = await send('zdravo');
  const first = sent[0];
  assert.ok(/куп|изнајм|кириј/i.test(first), first);
  assert.ok(!first.includes('најсоодветни станови'), first);

  // 2) type denial -> PIVOT (what DO you want), NOT the same ask repeated
  s = await send('ne baram stan');
  assert.equal(s.state, 'discovery');
  const second = sent[1];
  assert.notEqual(second, first);
  assert.ok(second.includes('што барате'), second);
  assert.ok(second.includes('куќа'), second);
  assert.ok(!second.includes('најсоодветни станови'), second);

  // 3) the client names a NEW direction -> house discovery, house questions
  s = await send('baram kukja');
  assert.equal(s.state, 'discovery');
  assert.equal(s.slots.house, true);
  assert.ok(sent[2].includes('куќа'), sent[2]);
});

test('discovery asks are ALWAYS plain (no recap, no flourish); the contact ask carries the last-info prefix once', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'prefixes';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // 1) bare need -> generic greeting + intent question, NO prefix (the flourish
  //    never collides with the greeting opener).
  let s = await send('MI TREBA STANCE');
  assert.equal(s.state, 'discovery');
  assert.ok(/куп|изнајм|кириј/i.test(sent[0]), sent[0]);
  assert.ok(!sent[0].includes('Супер. Уште неколку прашања.'), sent[0]);

  // 2) intent answered -> the missing location question, PLAIN — the discovery
  //    flourish ("Супер. Уште неколку прашања.") is gone entirely: it echoed
  //    the client's own words back, which reads robotic. Never on discovery.
  s = await send('ZA KUPUVANJE');
  assert.ok(/стан/.test(sent[1]) && /(дел од градот|населба|локаци)/iu.test(sent[1]), sent[1]);
  assert.ok(!sent[1].includes('Супер. Уште неколку прашања.'), sent[1]);
  assert.ok(!sent[1].includes('Разбрав — барате'), sent[1]);

  // 3-5) all later discovery questions are PLAIN — the flourish never repeats
  s = await send('VO AERODROM');
  assert.ok(/спални/.test(sent[2]), sent[2]);
  assert.ok(!sent[2].includes('Супер. Уште неколку прашања.'), sent[2]);
  s = await send('2 SPALNI');
  assert.ok(/(цена|евра)/iu.test(sent[3]), sent[3]);
  assert.ok(!sent[3].includes('Супер. Уште неколку прашања.'), sent[3]);
  s = await send('DO 60.000 EVRA');
  assert.equal(s.state, 'presentation');

  // 6) interest -> closing (fee) -> contact_collection
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA'); // confirm owner contact
  await send('DA, SE SOGLASUVAM');
  // the FIRST contact ask carries the last-info prefix ONCE
  assert.ok(sent[7].includes('Одлично, уште последниве информации и завршуваме.'), sent[7]);
  assert.ok(sent[7].includes('име и презиме'), sent[7]);
  assert.ok(/телефон/.test(sent[7]), sent[7]);

  // 7) a retry (garbage instead of a name) repeats the PLAIN ask — no prefix
  s = await send('NE ZNAM');
  assert.equal(s.state, 'contact_collection');
  assert.ok(sent[8].includes('име и презиме'), sent[8]);
  assert.ok(!sent[8].includes('Одлично, уште последниве информации и завршуваме.'), sent[8]);
});

test('rent EB without declared intent: the fee is the RENT script (300 денари), never the buy 500 — the property service is pinned', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'filip';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // the exact field flow: the client jumps straight to the property ("sifra 62"
  // in the paste) WITHOUT ever declaring buy/rent — EB 48 is a RENT (250 евра).
  let s = await send('zainteresiran sum za sifra 48');
  assert.equal(s.state, 'property_query');
  assert.equal(s.slots.propertyId, 48);
  assert.equal(s.slots.service, 'rent'); // pinned from the property itself
  assert.ok(sent[0].includes('Евидентен број 48'), sent[0]);

  // visit interest -> closing (still no declared intent) — the fee MUST be
  // the rent script: 300 денари (5 евра), never the buy 500 / 0% commission.
  s = await send('sakam da ja vidam');
  assert.equal(s.state, 'closing');
  assert.equal(s.slots.service, 'rent');
  assert.equal(s.slots.interestedPropertyId, 48);
  assert.ok(sent[1].includes('300 денари'), sent[1]);
  assert.ok(!sent[1].includes('500 денари'), sent[1]);
  assert.ok(!sent[1].includes('0%'), sent[1]);
  assert.ok(!sent[1].includes('провизија'), sent[1]);
});

test('insult protocol: "DA SE EBETE VO GAZOT" is a strike — 3 strikes terminate + permanent blocklist, ZERO output', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = '070123456'; // viber: the sender id IS the caller's phone
  const send = async (m: string) => { await handler.handle('viber', chatId, m); return sessions.get(chatId)!; };

  // rent flow into closing (the field: rent declared, bilo kade do 250, fee agreed)
  let s = await send('mi treba stan pod kirija');
  s = await send('bilo kade do 250');
  assert.equal(s.state, 'presentation');
  s = await send('sakam da ja vidam');
  assert.equal(s.state, 'closing');
  assert.ok(sent[2].includes('300 денари'), sent[2]); // rent fee
  s = await send('DA');
  assert.equal(s.state, 'contact_collection'); // fee agreed -> contact ask
  assert.ok(sent[3].includes('име'), sent[3]);

  // THE FIELD BUG: the burst "DA MOZE DA SE EBETE VO GAZOT" must be a STRIKE
  // (deterministic scan, LLM-free path) — never read as agreement and answered
  // with "Одлично, уште последниве информации...". The funnel does NOT advance.
  s = await send('DA MOZE DA SE EBETE VO GAZOT');
  assert.equal(s.state, 'contact_collection');
  assert.equal(s.strikes, 1);
  assert.ok(/професионалн|Господине|ве молам/i.test(sent[4]), sent[4]);
  assert.ok(!sent[4].includes('Одлично'), sent[4]);
  assert.ok(!sent[4].includes('име и презиме'), sent[4]);

  // two more offenses -> final warning, then strike 3 = terminate + blocklist
  s = await send('debilu');
  assert.equal(s.strikes, 2);
  assert.ok(/последна опомена/i.test(sent[5]), sent[5]);
  s = await send('glupava si');
  assert.equal(s.strikes, 3);
  assert.equal(s.state, 'terminated');
  assert.equal(sent.length, 6); // ZERO output on strike 3

  // absolute silence afterwards — even with a FRESH session (the blocklist is
  // permanent, the session TTL can never resurrect a strike-3 chat)
  await send('zdravo, izvinete');
  assert.equal(sent.length, 6);
  sessions.delete(chatId);
  await send('zdravo');
  assert.equal(sent.length, 6);
  assert.equal(sessions.get(chatId), null); // blocked at entry — session never re-created
});

test('insult protocol: strike 1 decays on the next clean message — the funnel continues from strike 1 again', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'decay1';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  let s = await send('mi treba stan pod kirija');
  s = await send('bilo kade do 250');
  assert.equal(s.state, 'presentation');

  s = await send('glupava si');
  assert.equal(s.strikes, 1);
  const warnCount = sent.length;

  // a clean follow-up resets the counter and is ANSWERED (not silence)
  s = await send('ne mi se dopaga');
  assert.equal(s.strikes, 0);
  assert.ok(sent.length > warnCount, 'clean message must be answered');

  // the next offense starts from strike 1 again — a warning, never a terminate
  s = await send('debilu');
  assert.equal(s.strikes, 1);
  assert.equal(s.state, 'presentation'); // funnel untouched
});

test('fee why-question: "KAKO TOA ? DA PLATAM ZA POSETA ?" is fee resistance, never FEE_AGREED', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'kako1';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // rent flow into closing (the fee was just disclosed)
  let s = await send('mi treba stan pod kirija');
  s = await send('bilo kade do 250');
  assert.equal(s.state, 'presentation');
  s = await send('sakam da ja vidam');
  assert.equal(s.state, 'closing');
  assert.ok(sent[2].includes('300 денари'), sent[2]); // rent fee

  // THE FIELD BUG: "KAKO TOA ? DA PLATAM ZA POSETA ?" was read as FEE_AGREED
  // (the bare "da" token) and jumped to contact collection ("Одлично, уште
  // последниве информации..."). It is a fee QUESTION — answered as fee
  // resistance (fee.why here, since no other ≤250 € rent exists to pivot to),
  // the funnel STAYS at the fee question, viewingFeeAgreed is never set.
  s = await send('KAKO TOA ? DA PLATAM ZA POSETA ?');
  assert.equal(s.state, 'closing');
  assert.equal(s.slots.viewingFeeAgreed, undefined, JSON.stringify(s.slots)); // NOT agreed
  assert.ok(/(филтер|сериозн|симболич|услов|согласувате)/iu.test(sent[3]), sent[3]);
  assert.ok(!sent[3].includes('Одлично'), sent[3]);
  assert.ok(!sent[3].includes('име и презиме'), sent[3]);
  assert.ok(!sent[3].includes('телефонски'), sent[3]);

  // a real "да" still agrees and the funnel advances normally
  s = await send('da, se soglasuvam');
  assert.equal(s.state, 'contact_collection');
  assert.equal(s.slots.viewingFeeAgreed, true);
});

test('anywhere + rent + "do 250": a budget, not EB 250 — city-wide presentation from the most popular neighborhoods', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'goran2';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // the exact field flow: rent declared, then "bilo kade do 250" — the 250 is
  // a RENT PRICE (up to 250 €/месец), never an Евидентен број. The funnel must
  // NOT ask "кој дел од градот?" again (било каде answers it) and must NOT
  // claim "не можам да го најдам имотот со Евидентен број 250".
  let s = await send('mi treba stan pod kirija');
  assert.equal(s.state, 'discovery');

  s = await send('bilo kade do 250');
  assert.equal(s.state, 'presentation');
  assert.equal(s.slots.anywhere, true);
  assert.equal(s.slots.budget, '250');
  assert.equal(s.slots.service, 'rent');
  assert.equal(s.slots.location, undefined); // no area was named
  // rent offers ≤ 250 € only, never the over-budget EB 59 (950 € business) and
  // never a "не можам да го најдам имотот со Евидентен број 250" dead-end
  assert.ok(sent[1].includes('Евидентен број'), sent[1]);
  assert.ok(!sent[1].includes('Евидентен број 250'), sent[1]);
  assert.ok(!sent[1].includes('не можам да го најдам'), sent[1]);
  // the descriptive opener names the budget (the LLM-free card path)
  assert.ok(sent[1].includes('250'), sent[1]);

  // rejection after the single ≤250€ match -> the exhausted line asks about
  // other areas / registering — NEVER a location question, never an EB dead-end
  s = await send('ne mi se dopaga');
  assert.equal(s.state, 'presentation');
  assert.equal(s.slots.location, undefined);
  assert.ok(!sent[2].includes('кој дел од градот'), sent[2]);
  assert.ok(!sent[2].includes('Евидентен број 250'), sent[2]);
});

test('unknown EB escape: "predlozi mi" / "drugi lokaciii" / "да" pivot to real alternatives, never repeat the not-found line', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'dile';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // A non-existent EB lands in property_query with the not-found line — which
  // itself INVITES "Дали би сакале да Ви предложам слични имоти од други
  // локации?". The follow-ups must PIVOT to real alternatives (the stuck loop
  // repeated the not-found line on every "predlozi mi" / "drugi lokaciii").
  let s = await send('sifra 250');
  assert.equal(s.state, 'property_query');
  assert.ok(sent[0].includes('Евидентен број 250'), sent[0]);

  // "predlozi mi" -> presentation with REAL offers (EB 48, rent in Карпош III)
  s = await send('predlozi mi');
  assert.equal(s.state, 'presentation');
  assert.ok(sent[1].includes('Евидентен број 48'), sent[1]);
  assert.ok(!sent[1].includes('не можам да го најдам имотот со Евидентен број 250'), sent[1]);
  // the bad EB is cleared so a later INTERESTED never grabs it
  assert.equal(s.slots.propertyId, undefined);

  // "drugi lokaciii" -> next batch (exhausted here, but NEVER the EB-250 line)
  s = await send('drugi lokaciii');
  assert.ok(!sent[2].includes('не можам да го најдам имотот со Евидентен број 250'), sent[2]);
});

test('seen property without a number: Lina asks for Евидентен број first, then finds the closest matches by details', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'zoki';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // 1) "go gledav oglasot za stan vo karpos na internet. dali go imate uste ?"
  //    — a SPECIFIC seen property with NO number: never the buy/rent battery.
  let s = await send('dobar den. go gledav oglasot za stan vo karpos na internet. dali go imate uste ?');
  assert.equal(s.state, 'property_locate');
  assert.ok(sent[0].includes('Евидентен број'), sent[0]);
  assert.ok(!sent[0].includes('купување или изнајмување'), sent[0]);

  // 2) the client does NOT know the number — the area is already known (Карпош),
  //    so Lina immediately presents the closest Карпош matches to identify it
  s = await send('ne go znam brojot');
  assert.equal(s.state, 'property_locate');
  assert.ok(sent[1].includes('Евидентен број 54'), sent[1]); // 69.500 € in Карпош III
  assert.ok(sent[1].includes('првиот'), sent[1]);

  // 3) "triesetina kvadrati nekade" (≈30 м²) — word-form sqm is extracted
  s = await send('triesetina kvadrati nekade');
  assert.equal(s.state, 'property_locate');
  assert.equal(s.slots.sqm, 30);

  // 4) "okolu 70 000 evra bese" — the price detail re-ranks the WHOLE pool;
  //    EB 54 (69.500) stays the closest match (the exclude bug hid it before)
  s = await send('okolu 70 000 evra bese');
  assert.equal(s.state, 'property_locate');
  assert.ok(sent[3].includes('Евидентен број 54'), sent[3]);

  // 5) the client picks it by position — INTERESTED -> closing (fee disclosed)
  s = await send('да, првиот е тој');
  assert.equal(s.state, 'closing');
  assert.equal(s.slots.interestedPropertyId, 54);
  assert.ok(sent[4].includes('500 денари'), sent[4]);
});

test('availability ask: "ve kontaktiram ... broj 53 \n dali e seuste dostapen?" → ack (permission) → fee, NEVER a re-description', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'lidija';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // The exact transcript: the client knows the property from the website and
  // asks about AVAILABILITY — Lina must NOT re-describe it. She answers the
  // availability ack (still available) and ASKS PERMISSION to contact the owner.
  // The fee comes only after the client confirms.
  let s = await send('ve kontaktiram vo vrska so oglasot so evidenten broj 53\ndali e seuste dostapen?');
  assert.equal(s.state, 'closing');
  assert.equal(s.slots.interestedPropertyId, 53);
  // availability ack anchor (bank-backed, all variants carry one)
  assert.ok(/(?:достапен|постои|база|слободен|активен)/i.test(sent[0]), sent[0]);
  assert.ok(sent[0].includes('?'), sent[0]); // must be a QUESTION (permission ask)
  assert.ok(!sent[0].includes('500 денари'), sent[0]); // fee NOT yet disclosed
  assert.ok(!sent[0].includes('Станот под Евидентен'), sent[0]); // never the card
  // The ack carries the approximate landmark — human-like, natural.
  // Google Maps link is NOT included (only on precision asks).
  assert.ok(sent[0].includes('во близина на'), sent[0]);
  assert.ok(!sent[0].includes('Бисер'), sent[0]); // the street stays hidden
  assert.ok(s.slots.ownerContactPending, 'ownerContactPending should be set');

  // client confirms they want owner contacted -> NOW the fee
  await send('DA');
  s = sessions.get(chatId)!; // re-read session after send
  assert.ok(sent[1].includes('500 денари'), sent[1]); // buy fee disclosed (EB 53 is buy)
  assert.ok(!s.slots.ownerContactPending, 'ownerContactPending should be cleared');

  // fee ok -> contact -> time -> the owner ping-pong starts
  await send('DA, SE SOGLASUVAM');
  s = await send('LIDIJA 078/914 196');
  assert.equal(s.state, 'visit_scheduling');
  s = await send('UTRE POPLADNE');
  assert.equal(s.state, 'owner_checking');
  assert.equal(s.slots.interestedPropertyId, 53);
});

test('availability ask: the client asks about a SHOWN property → ack (permission), no card again', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'avail2';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // the property was already shown in property_query ("кој е 78?") — now the
  // client asks availability; Lina answers ack (permission ask), no re-description
  let s = await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  assert.equal(s.state, 'property_query');
  assert.ok(sent[0].includes('Евидентен број 78'), sent[0]);
  s = await send('dali e seuste dostapen?');
  assert.equal(s.state, 'closing');
  assert.ok(/(?:достапен|постои|база|слободен|активен)/i.test(sent[1]), sent[1]);
  assert.ok(sent[1].includes('?'), sent[1]); // must be a QUESTION (permission ask)
  assert.ok(!sent[1].includes('500 денари'), sent[1]); // fee NOT yet disclosed
  assert.ok(!sent[1].includes('Станот под Евидентен'), sent[1]);
  assert.ok(s.slots.ownerContactPending, 'ownerContactPending should be set');
});

test('owner dictates a NEW price: stored for Hermes + relayed to the client before the confirmation', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'cena';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };
  const ownerAsks: string[] = [];
  handler.onOwnerAsk = (_c, eb, q) => { ownerAsks.push(`${eb}: ${q}`); };
  const tick = () => new Promise(r => setTimeout(r, 50));

  // reach owner_checking (interest -> fee -> agree -> contact -> time)
  await send('ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 78');
  await send('DALI E SEUSTE DOSTAPEN ?');
  await send('DA'); // confirm owner contact
  await send('DA, SE SOGLASUVAM');
  await send('ZORAN 078/914 196');
  let s = await send('UTRE POPLADNE POSLE 6');
  assert.equal(s.state, 'owner_checking');
  assert.equal(ownerAsks.length, 1);

  // the owner answers: available, BUT the price changed to 200.000 €
  const ok = handler.ownerAnswer(chatId, 78, detectOwnerVerdict('да, ама цената е 200.000 евра', s.slots.visitTime ?? '')!);
  assert.ok(ok);
  await tick();
  s = sessions.get(chatId)!;
  assert.equal(s.state, 'pending'); // visit confirmed
  // the price change was STORED (pending for Hermes) with old -> new
  const pending = handler.priceChanges.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].eb, 78);
  assert.equal(pending[0].oldPrice, 185000); // the feed price of EB 78
  assert.equal(pending[0].newPrice, 200000);
  // and relayed to the client BEFORE the confirmation
  const relayIdx = sent.findIndex(m => m.includes('200.000 евра'));
  const confirmIdx = sent.findIndex(m => m.includes('Договорена посета'));
  assert.ok(relayIdx !== -1 && confirmIdx !== -1, sent.join(' | '));
  assert.ok(relayIdx < confirmIdx, 'price relay must precede the confirmation');
  // the local price must follow the owner's word ("нашата цена се менува")
  assert.ok(pending[0].status === 'pending', 'Hermes has not applied it yet');
});

test('seen property: the client KNOWS the number — easy property_query lookup, then interest', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'sifra';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // "го видов станот, broj 78" — the number is known: straight to property_query.
  let s = await send('go vidov stanot, broj 78');
  assert.equal(s.state, 'property_query');
  assert.equal(s.slots.propertyId, 78);
  assert.ok(sent[0].includes('Евидентен број 78'), sent[0]);

  // then the normal flow: availability ack (permission) -> fee -> agree
  s = await send('DALI E SEUSTE DOSTAPEN ?');
  assert.equal(s.state, 'closing');
  assert.equal(s.slots.interestedPropertyId, 78);
  assert.ok(sent[1].includes('?'), sent[1]); // permission question
  assert.ok(s.slots.ownerContactPending, 'ownerContactPending should be set');
  // confirm owner contact -> fee
  await send('DA');
  assert.ok(sent[2].includes('500 денари'), sent[2]);
});

test('the recap NEVER appears on any discovery ask — only the missing question', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'marija';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // 1) "zdravo" -> generic greeting (never apartment talk)
  let s = await send('zdravo');
  assert.equal(s.state, 'idle');

  // 2) "mi treba dukjan pod kirija" -> business + rent known -> the missing
  //    location question, NO recap, NO flourish
  s = await send('mi treba dukjan pod kirija');
  assert.equal(s.state, 'discovery');
  assert.ok(!sent[1].includes('Разбрав — барате'), sent[1]);
  assert.ok(!sent[1].includes('Супер. Уште неколку прашања.'), sent[1]);
  assert.ok(/(дел од градот|населба|локаци)/iu.test(sent[1]), sent[1]);

  // 3) budget arrives -> SECOND ask: still just the location question
  s = await send('do 500 evra');
  assert.equal(s.state, 'discovery');
  assert.ok(!sent[2].includes('Разбрав — барате'), sent[2]);
  // the recap structure is gone — the ask never echoes the full criteria set
  // („деловен простор, за изнајмување, до 500 евра“); the location question
  // itself may naturally mention „деловниот простор“ (bank wording)
  assert.ok(!sent[2].includes('деловен простор, за изнајмување'), sent[2]);
  assert.ok(/(дел од градот|населба|локаци)/iu.test(sent[2]), sent[2]);

  // 4) location arrives -> THIRD ask: plain sqm question, never the recap
  s = await send('centar i okolu centar');
  assert.equal(s.state, 'discovery');
  assert.ok(/(површина|м²|m²|квадрат)/iu.test(sent[3]), sent[3]);
  assert.ok(!sent[3].includes('Разбрав — барате'), sent[3]);
  assert.ok(!sent[3].includes('Центар'), sent[3]);
});

test('a куќа funnel stays куќа through type-less detail messages — a стан is NEVER presented', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  // Ново Лисиче has BOTH a house (EB 91) and a стан (EB 92) — only the house
  // may be presented to a куќа buyer, even after type-less detail messages
  // ("DVE SPALNI…") that used to reset house:false and show the apartment.
  const rows: Property[] = [
    { eb: 91, id: 91, location: 'Ново Лисиче', price: 90000, service: 'buy', house: true, bedrooms: 3, size: '120 м²' },
    { eb: 92, id: 92, location: 'Ново Лисиче', price: 88000, service: 'buy', bedrooms: 3, size: '75 м²' },
  ];
  const properties = new FakeProps(rows);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  // viber: the sender id IS the caller's phone (prefillViberPhone) — the
  // insult-protocol tests exercise the phone-backed blocklist through it.
  channels.register({ name: 'viber', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels });
  const chatId = 'kukja';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // the exact transcript flow — куќа buyer, then location/budget/bedrooms
  let s = await send('SAKAM DA KUPAM KUKJA');
  assert.equal(s.state, 'discovery');
  assert.equal(s.slots.house, true);
  s = await send('VO LISICE ILI BUTEL');
  assert.equal(s.state, 'discovery');
  assert.equal(s.slots.house, true);
  s = await send('DO 100.000');
  assert.equal(s.state, 'discovery');
  assert.equal(s.slots.house, true);
  // the regression: "DVE SPALNI…" (no type word) must NOT flip the funnel to стан
  s = await send('DVE SPALNI OBAVEZNO A MOZE I TRI');
  assert.equal(s.state, 'presentation');
  assert.equal(s.slots.house, true);
  assert.equal(s.slots.bedrooms, 2); // "DVE SPALNI" is a real bedroom count now
  assert.ok(sent[3].includes('Евидентен број 91'), sent[3]); // the HOUSE
  assert.ok(!sent[3].includes('Евидентен број 92'), sent[3]); // never the стан
  assert.ok(!sent[3].includes('станот под'), sent[3]);
});

test('"помало нешто" mid-discovery answers with SMALLEST м² offers — empty area asks about other locations', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = 'ponuda';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  // build up: business + rent + budget 500 + location Центар (sqm still missing)
  await send('mi treba dukjan pod kirija');
  await send('do 500 evra');
  let s = await send('centar i okolu centar');
  assert.equal(s.state, 'discovery');
  assert.ok(/(површина|м²|m²|квадрат)/iu.test(sent[2]), sent[2]);

  // "што имате во понуда?" -> REAL DB offers, not the repeated sqm question.
  // ROWS has NO Центар business ≤ 500 (EB 59 is 950, EB 56 has no location) —
  // so the honest no-match line asks about other locations.
  s = await send('sto imate vo ponuda?');
  assert.equal(s.state, 'presentation');
  assert.ok(sent[3].includes('Центар'), sent[3]);
  // honest no-match: asks about OTHER areas (bank wording varies)
  assert.ok(/други|друга/.test(sent[3]), sent[3]);
  assert.ok(!sent[3].includes('Која површина'), sent[3]);

  // the client keeps asking — "помало нешто" while in presentation pulls the
  // next candidates from the alternatives engine (never the sqm question)
  s = await send('pomalo nesto');
  assert.equal(s.state, 'presentation');
  assert.ok(!sent[4].includes('Која површина'), sent[4]);
});

test('"помало нешто" with matches: smallest м² presented first, going up', async () => {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const rows: Property[] = [
    { eb: 71, id: 71, location: 'Центар', price: 300, service: 'rent', business: true, sqm: 80 },
    { eb: 72, id: 72, location: 'Центар', price: 350, service: 'rent', business: true, sqm: 35 },
    { eb: 73, id: 73, location: 'Центар', price: 400, service: 'rent', business: true, sqm: 55 },
  ];
  const properties = new FakeProps(rows);
  const llm = new FailingLlm();
  const classifier = new Classifier(llm, cfg, properties);
  const responder = new Responder(llm, cfg);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c, text) => { sent.push(text); } });
  // viber: the sender id IS the caller's phone (prefillViberPhone) — the
  // insult-protocol tests exercise the phone-backed blocklist through it.
  channels.register({ name: 'viber', send: async (_c, text) => { sent.push(text); } });
  const handler = new InboundHandler({ cfg, db, sessions, classifier, responder, properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels });
  const chatId = 'malo';
  const send = async (m: string) => { await handler.handle('test', chatId, m); return sessions.get(chatId)!; };

  await send('mi treba dukjan pod kirija');
  await send('do 500 evra');
  let s = await send('centar i okolu centar');
  assert.equal(s.state, 'discovery');

  // "помало нешто" -> presentation with the SMALLEST м² (EB 72 = 35 м²) first
  s = await send('pomalo nesto');
  assert.equal(s.state, 'presentation');
  const eb72 = sent[3].indexOf('Евидентен број 72');
  const eb73 = sent[3].indexOf('Евидентен број 73');
  assert.ok(eb72 !== -1 && eb73 !== -1 && eb72 < eb73, sent[3]); // 35 м² before 55 м²
  assert.ok(!sent[3].includes('Евидентен број 71'), sent[3]); // only 2 shown

  // a follow-up "што имате?" in presentation pulls the NEXT candidate
  // (EB 71 = 80 м² — the only one left), never re-shows EB 72 (already shown)
  s = await send('sto imate?');
  assert.equal(s.state, 'presentation');
  assert.ok(sent[4].includes('Евидентен број 71'), sent[4]);
  assert.ok(!sent[4].includes('Евидентен број 72'), sent[4]);
});

test('contact with property interest: even if queueAfterContact was set, a specific property means visit_scheduling, not goodbye', async () => {
  const { handler, sessions, sent } = makeHandler();
  const chatId = '070123456';
  const send = async (text: string) => {
    await handler.handle('test', chatId, text);
    return sessions.get(chatId);
  };

  // 1) property_query: client requests EB 53, property shown
  await send('sifra 53');
  let s = sessions.get(chatId)!;
  assert.equal(s.state, 'property_query');
  assert.ok(sent[0].includes('Евидентен број 53'), sent[0]);

  // 2) availability ask → closing (permission ask)
  await send('dali e dostapen?');
  s = sessions.get(chatId)!;
  assert.equal(s.state, 'closing');
  assert.ok(s.slots.ownerContactPending, 'ownerContactPending should be set');
  assert.ok(!/500/.test(sent[1]), sent[1]); // fee NOT yet disclosed

  // 2b) confirm owner contact → fee disclosed
  await send('da');
  assert.ok(/(?:500|300|надомест|провизија)/i.test(sent[2]), sent[2]); // fee disclosed

  // 3) fee agreement → contact_collection
  await send('da, soglasuvam');
  s = sessions.get(chatId)!;
  assert.equal(s.state, 'contact_collection');

  // 3) Simulate the queueAfterContact flag being set incorrectly
  //    (this can happen when the LLM misroutes through exhausted-options escape)
  s.slots.queueAfterContact = true;
  sessions.set(s);

  // 4) Client gives name + phone — should STILL go to visit_scheduling
  //    because there IS a specific property of interest (EB 53)
  await send('Vanesa 076 873 697');
  s = sessions.get(chatId)!;
  assert.equal(s.state, 'visit_scheduling', `expected visit_scheduling but got ${s.state}`);
  assert.ok(sent[sent.length - 1].includes('термин'), sent[sent.length - 1]);
  // The goodbye (QUEUED_CONFIRM) must NOT appear
  assert.ok(!sent[sent.length - 1].includes('забележани'), sent[sent.length - 1]);
});
