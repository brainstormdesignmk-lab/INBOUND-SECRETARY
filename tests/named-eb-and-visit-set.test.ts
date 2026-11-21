/**
 * THE [06:39]–[06:49] FIELD CAPTURE — a conversation about SEVERAL flats.
 *
 *   [06:39] me interesira stan so evidenten broj 52      → card 52
 *   [06:39] dali uste e na prodazba ?                    → availability ack
 *   [06:39] a stanot so broj 51 ?                        → **gemini:1** (a
 *           landmark line, from a model, for a row the base holds)
 *   [06:40] sakam da gi posetam ovie dva stana           → «Посетата е за
 *           станот со Евидентен број 51» — ONE visit, the second flat gone
 *   [06:47] PROVERI TI DALI SE DOSTAPNI PA KJE SE DOGOVORIME ZA PARI
 *                                                        → the cards again
 *   [06:48] 6 (answer to «слободни се 16:00 и 18:00»)    → «Кој термин Ви
 *           одговара?» again; the owner was asked 20:00
 *
 * FOUR roots, each pinned here:
 *
 *   1. The flat-reference FRAME: «stanot so broj 51» names a listing exactly
 *      as «А 51?» does, but only the bare ellipsis was read, so the turn had no
 *      owner and the closing catch-all served the fee (or the brain).
 *   2. The conversation's SET: `presentedIds` is the last BATCH, and an EB
 *      answer replaces it — so after 52 then 51 there was ONE flat "on screen"
 *      and «ovie dva» could only ever mean one.
 *   3. A check-then-arrange turn after the fee: «proveri … pa kje se
 *      dogovorime» is the client's consent to proceed, but only an agreement
 *      word or a visit verb opened contact collection — the availability lane
 *      answered the card instead.
 *   4. A LONE HOUR is a clock: «6» answering «кој термин?» parsed as nothing.
 */
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
import { EnrichmentStore } from '../src/store/enrichment';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { BankStore } from '../src/store/bank';
import { detectNamedEbReference } from '../src/llm/ebNumber';
import { detectBareEbFollowup } from '../src/llm/deterministic';
import { parseVisitDateTime, hasClockHint } from '../src/visits/time';

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

const ROWS: Property[] = [
  { eb: 52, id: 52, location: 'Козле', address: 'Букурешка', price: 167600, bedrooms: 3, sqm: 73, size: '73 м²', service: 'buy', lat: 41.9957, lon: 21.3928 },
  { eb: 51, id: 51, location: 'Водно', address: 'Кочо Рацин', price: 99000, bedrooms: 3, sqm: 71, size: '71 м²', service: 'buy', lat: 41.9884, lon: 21.4177 },
  { eb: 57, id: 57, location: 'Центар', address: 'Ѓуро Стругар', price: 1000, business: true, sqm: 105, service: 'rent', lat: 41.9931, lon: 21.4289 },
  { eb: 58, id: 58, location: 'Центар', address: 'Ѓуро Стругар', price: 1200, business: true, sqm: 110, service: 'rent', lat: 41.9931, lon: 21.4289 },
  { eb: 59, id: 59, location: 'Центар', address: 'Ѓуро Стругар', price: 950, business: true, sqm: 105, service: 'rent', lat: 41.9931, lon: 21.4289 },
];

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  get healthy(): boolean { return true; }
}

function makeHandler(id: string) {
  const cfg = loadConfig();
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const channels = new ChannelRegistry();
  const sent: string[] = [];
  channels.register({ name: 'test', send: async (_c: string, text: string) => { sent.push(text); } });
  const props = new FakeProps(ROWS);
  const handler = new InboundHandler({
    cfg, db, sessions, bank: new BankStore(db),
    classifier: new Classifier(new FailingLlm(), cfg, props),
    responder: new Responder(new FailingLlm(), cfg),
    properties: props,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false }),
    enrichment: new EnrichmentStore(db),
  });
  const ownerAsks: string[] = [];
  handler.onOwnerAsk = (_c: string, _eb: number, q: string) => { ownerAsks.push(q); };
  return { handler, sessions, sent, ownerAsks, chatId: id };
}

// ── 1. THE FLAT-REFERENCE FRAME ─────────────────────────────────────────────

test('[06:39] a flat named in a noun frame is read as a reference', () => {
  // The field sentence and its siblings — every one is a listing reference.
  for (const t of [
    'a stanot so broj 51 ?', 'STANOT SO BROJ 51', 'a evidenten broj 51 ?',
    'stanot 51', 'stan so broj 51', 'EB 51', 'sifra 51',
  ]) {
    assert.equal(detectNamedEbReference(t), 51, `a flat reference: ${t}`);
  }
  // The bare ELLIPSIS is the other reader's shape (it must also be one of the
  // flats this chat showed — a "42" in a budget answer is not a listing), so
  // the lane in the handler tries the frame first and falls back to it.
  assert.equal(detectBareEbFollowup('a 51 ?'), 51);
  assert.equal(detectNamedEbReference('a 51 ?'), undefined);
  // …and a CRITERION never becomes one (the shared EB grammar refuses units,
  // caps and thousands; the frame refuses everything else).
  for (const t of [
    'stan so 3 spalni', 'stan do 180000', 'stan od 45 m2', 'kolku e kvadratura na stanot ?',
    'baram stan', 'stanot e 73 kvadrati', 'cena 51000',
  ]) {
    assert.notEqual(detectNamedEbReference(t), 51, `a criterion, not a flat: ${t}`);
  }
});

test('[06:39] the second flat is answered from the base, not by a model', async () => {
  const { handler, sent, sessions, chatId } = makeHandler('ref-eb');
  await handler.handle('test', chatId, 'me interesira stan so evidenten broj 52');
  await handler.handle('test', chatId, 'dali uste e na prodazba ?');
  await handler.handle('test', chatId, 'a stanot so broj 51 ?');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /Евидентен број 51/u, `the named flat's own row is the answer: ${answer}`);
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.propertyId, 51, 'the discussion anchor moved to the flat he named');
  assert.deepEqual(s.slots.askedEbs, [52, 51], 'both flats are the conversation so far');
});

// ── 2. THE CONVERSATION'S SET IS THE PLURAL ─────────────────────────────────

test('[06:40] «ovie dva stana» means both flats he asked about', async () => {
  const { handler, sent, sessions, chatId } = makeHandler('ref-set');
  await handler.handle('test', chatId, 'me interesira stan so evidenten broj 52');
  await handler.handle('test', chatId, 'a stanot so broj 51 ?');
  await handler.handle('test', chatId, 'sakam da gi posetam ovie dva stana');
  const answer = sent[sent.length - 1] ?? '';
  assert.match(answer, /Евидентни броеви 52 и 51/u,
    `the visit is for BOTH flats: ${answer}`);
  // The fee is per property — two flats are two viewings.
  assert.match(answer, /1\.000 денари/u, `the arithmetic is stated, not left to him: ${answer}`);
  const s = sessions.get(chatId)!;
  assert.deepEqual(s.slots.visitEbs, [52, 51], 'the route/booking set is the pair');
});

// ── 3. CHECK-THEN-ARRANGE AFTER THE FEE IS THE AGREEMENT ────────────────────

test('[06:47] «proveri … pa kje se dogovorime» opens contact collection', async () => {
  const { handler, sent, sessions, chatId } = makeHandler('proceed-after-fee');
  await handler.handle('test', chatId, 'SAKAM DA IZNAJMAM DELOVEN PROSTOR');
  const s0 = sessions.get(chatId)!;
  s0.state = 'closing';
  s0.slots.service = 'rent';
  s0.slots.business = true;
  s0.slots.currentBatch = [57, 58, 59];
  s0.slots.presentedIds = [57, 58, 59];
  s0.slots.askedEbs = [57, 58, 59];
  s0.slots.propertyId = 59;
  s0.slots.interestedPropertyId = 59;
  s0.slots.feeDisclosed = true;
  s0.slots.visitWanted = true;
  sessions.set(s0);
  await handler.handle('test', chatId, 'PROVERI TI DALI SE DOSTAPNI PA KJE SE DOGOVORIME ZA PARI');
  const answer = sent[sent.length - 1] ?? '';
  const s = sessions.get(chatId)!;
  assert.equal(s.state, 'contact_collection',
    `the client delegated the check and accepted the arrangement: ${answer}`);
  assert.equal(s.slots.viewingFeeAgreed, true, 'the disclosed fee is agreed by the proceed clause');
  assert.doesNotMatch(answer, /делovен простор|деловен простор, 105 м2/iu,
    `the card he has already read is not the answer: ${answer}`);
  assert.match(answer, /име|телефон/u, `the contact ask is the next step: ${answer}`);
});

// ── 4. A LONE HOUR IS A CLOCK ───────────────────────────────────────────────

test('[06:48] «6» answering a slot question is 18:00, not nothing', () => {
  const now = new Date('2026-11-21T08:00:00');
  const at = parseVisitDateTime('6', now);
  assert.ok(at, 'a lone hour parses as a term');
  assert.equal(at!.getHours(), 18, `the visit window makes 6 an evening hour: ${at!.toString()}`);
  assert.equal(hasClockHint('6'), true, 'and every merge/validator gate sees a clock');
  // A CRITERION is not a slot answer: a number with words around it is not lone.
  assert.equal(hasClockHint('6 spalni'), false);
  assert.equal(parseVisitDateTime('6 spalni', now), undefined);
});

// ── 5. THE ROUTE OVER THE SET, NOT A FREEZE AFTER THE FIRST OWNER ──────────

test('[06:52] the term arranges the WHOLE set he named, not only the last one', async () => {
  // THE FREEZE: two flats asked by number, «sakam da gi posetam ovie dva
  // stana», the fee agreed, then the term. The route must be over BOTH flats
  // and both owners asked in one round — the [22:0x] capture booked the first
  // and then went silent on the rest of the visit he had asked for.
  const { handler, sessions, sent, ownerAsks, chatId } = makeHandler('route-set');
  for (const m of [
    'ZAINTERESIRAN SUM ZA EVIDENTEN BROJ 52',
    'A STANOT SO BROJ 51 ?',
    'DALI E SEUSTE DOSTAPEN ?',
    'DA',
    'DA, SE SOGLASUVAM',
    'ZORAN 078/914 196',
    'SAKAM DA GI POSETAM OVIE DVA STANA',
  ]) await handler.handle('test', chatId, m);
  const s0 = sessions.get(chatId)!;
  assert.equal(s0.slots.visitWanted, true, 'the plural wish is remembered');
  assert.deepEqual(s0.slots.visitEbs, [52, 51], `the set is the pair he asked about: ${JSON.stringify(s0.slots.visitEbs)}`);
  await handler.handle('test', chatId, 'PETOK VO 16:00');
  await new Promise(r => setTimeout(r, 200));
  const s = sessions.get(chatId)!;
  assert.equal(s.state, 'owner_checking', `the route opens the owners: ${s.state}`);
  assert.ok(s.slots.visitPlan, 'the term starts a ROUTE over the set');
  assert.deepEqual(s.slots.visitPlan!.stops.map(x => x.eb), [52, 51], 'every flat in the set is a stop');
  assert.equal(s.slots.visitPlan!.stops.filter(x => x.status === 'asked').length, 2,
    `both owners are asked in the same round: ${JSON.stringify(s.slots.visitPlan!.stops)}`);
  assert.equal(ownerAsks.length, 2, `one question per owner: ${JSON.stringify(ownerAsks)}`);
  assert.match(ownerAsks.join('\n'), /број 52/u, ownerAsks.join('\n'));
  assert.match(ownerAsks.join('\n'), /број 51/u, ownerAsks.join('\n'));
  assert.doesNotMatch(sent.at(-1) ?? '', /Кој термин/u,
    `the term is not re-asked once both owners have it: ${sent.at(-1)}`);
});
