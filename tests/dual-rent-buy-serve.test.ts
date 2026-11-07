/**
 * THE [19:19]–[19:36] BATCH — rent AND buy in one search, and the flat the
 * client NAMES stays the subject. Seven field faults in one session:
 *
 *   [19:19] CENTAR / DVOSOBEN STAN ILI GARSONJERA
 *   [19:19] DO 150000 ZA KUPUVANJE   → a sale pair (correct so far)
 *   [19:19] DO 350 ZA IZNAJMUVANJE   → the rent budget REPLACED the buy one;
 *                                       the serve listed sale flats only
 *   [19:20] ZA IZNAJMUVANJE ?        → answered by the LLM (it had the rows)
 *   [19:26] OVOJ ZA 350 EVRA KIRIJA BI GO VIDEL → «нема гарсоњери до 350»
 *   [19:27] DOBRO TOGAS KAZI MI STO IMA VO BLIZINA POZNATO ? → answered about
 *                                       a DIFFERENT card (EB 63 for EB 70)
 *   [19:30] DOGOVORI MI DA GO VIDAM 70 → «ги исцрптивме опциите», not the visit
 *   [19:32] 70 BI SAKAL DA GO POSETAM → the visit agreement was never caught
 *   [19:36] KOJA AGENCIJA STE VIE ?   → ignored (client AND owner side)
 *
 * The contracts pinned here:
 *   • two service budgets are a DUAL search (slots.dualService) — every serve
 *     is one rent card + one buy card, each under ITS OWN cap, in the pinned
 *     area (the event echoes the session's armed criteria, so the purity test
 *     reads the MESSAGE's own slots, never the classifier's event);
 *   • a later message that NAMES one market narrows the search to it and hands
 *     that leg's own cap over — deterministic, from the DB, never the LLM;
 *   • a visit command that names a flat binds it as the subject (fee protocol
 *     first), so the address/surroundings asks answer THAT flat;
 *   • once the fee was disclosed, a repeated visit request IS the agreement —
 *     no second disclosure;
 *   • «Која агенција сте вие?» is answered (Метрополис) and the pending
 *     question is repeated, on both sides of the chat.
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
import { OfflineMapStore } from '../src/geo/offlineMap';
import { detectAgencyIdentityAsk, detectVisitInterest, detectVisitRequest, detectExhaustedFollowUp, detectFeePaymentAgreement } from '../src/llm/deterministic';
import { extractMentionSignals, resolveMention } from '../src/llm/mentionResolve';

const cfg = loadConfig();

class FailingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('429 quota exhausted'); }
}

class FakeProps extends PropertyService {
  constructor(private rows: Property[]) { super('http://fake-feed'); }
  async getAll(): Promise<Property[]> { return this.rows; }
  async getByEb(eb: number): Promise<Property | undefined> { return this.rows.find(r => r.eb === eb); }
  async getById(id: number): Promise<Property | undefined> { return this.rows.find(r => r.id === id); }
  async locations(): Promise<string[]> {
    return [...new Set(this.rows.map(r => (r.location ?? '').trim()).filter(Boolean))];
  }
  get healthy(): boolean { return true; }
}

// The capture's own four rows, in the capture's own order.
const ROWS: Property[] = [
  // Sale: 99.000 двособен + 36.000 гарсоњера (the pair the session was served).
  { eb: 69, id: 69, location: 'Центар', address: 'Ул. Димитар Миладинов 4', price: 99000, bedrooms: 2, sqm: 51, size: '51 м²', service: 'buy', details: 'Двособен стан, лифт, парно.', lat: 41.9985, lon: 21.4330 } as Property,
  { eb: 63, id: 63, location: 'Центар', address: 'Ул. Никола Вапцаров 8', price: 36000, bedrooms: 0, sqm: 28, size: '28 м²', service: 'buy', isStudio: true, landmark: 'Амбасада на Црна Гора', details: 'Гарсоњера во строг центар.', lat: 41.99599, lon: 21.41817 } as Property,
  // Rent: 350 двособен (39 м²) + 200 гарсоњера — the pair the LLM served.
  { eb: 70, id: 70, location: 'Центар', address: 'Ул. Кралевска 3', price: 350, bedrooms: 2, sqm: 39, size: '39 м²', service: 'rent', landmark: 'Евангелска Конгрешанска Црква', details: 'Двособен стан со две спални, лифт и парно.', lat: 41.99835, lon: 21.41490 } as Property,
  { eb: 76, id: 76, location: 'Центар', address: 'Ул. Универзална 5', price: 200, bedrooms: 0, sqm: 24, size: '24 м²', service: 'rent', isStudio: true, landmark: 'Амбасада на Црна Гора', details: 'Реновирана гарсоњера во сутерен.', lat: 41.99599, lon: 21.41817 } as Property,
];

function makeHandler(id: string) {
  const db = new Db(':memory:');
  const sessions = new SessionStore(db);
  const properties = new FakeProps(ROWS);
  const channels = new ChannelRegistry();
  const sent: Array<{ text: string; source?: string }> = [];
  channels.register({ name: 'test', send: async (_c: string, text: string, source?: string) => { sent.push({ text, source }); } });
  const handler = new InboundHandler({
    cfg, db, sessions,
    classifier: new Classifier(new FailingLlm(), cfg, properties),
    responder: new Responder(new FailingLlm(), cfg),
    properties,
    appointments: new AppointmentStore(db), escalations: new EscalationStore(db),
    meta: new MetaStore(db), channels,
    landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
    enrichment: new EnrichmentStore(db),
  });
  const say = async (m: string): Promise<string> => {
    await handler.handle('test', id, m);
    return sent.at(-1)?.text ?? '';
  };
  return { handler, say, sent, sessions, chatId: id };
}

const ebsIn = (text: string): number[] => (text.match(/Евидентен број (\d+)/gu) ?? [])
  .map(m => Number(m.replace(/\D/g, '')));

test('[19:19] two service budgets are a DUAL search — one rent card + one buy card, each under its own cap', async () => {
  const { say, sessions, chatId } = makeHandler('dual-pair');
  await say('CENTAR');
  await say('STAN MI TREBA');
  await say('DO 150000 ZA KUPUVANJE');
  await say('DO 350 ZA IZNAJMUVANJE');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.dualService, true, 'the two budgets must arm the dual search');
  assert.equal(s.slots.rentBudget, '350', 'the rent cap is banked');
  assert.equal(s.slots.buyBudget, '150000', 'and so is the buy cap');
  assert.equal(s.slots.location, 'Центар (населба)',
    'a budget that names its market is a refinement — it never unlocks the pinned area');

  const pair = await say('DVOSOBEN');
  const ebs = ebsIn(pair);
  assert.ok(ebs.includes(70), `the RENT card must ride the pair: ${pair}`);
  assert.ok(ebs.includes(69), `and the BUY card: ${pair}`);
  assert.ok(!ebs.some(e => e === 76 || e === 63),
    `the caps exclude the rest of both legs (350 rent / 150.000 buy): ${pair}`);
});

test('[19:20] a message naming ONE market narrows the dual search to that leg — deterministic, from the DB', async () => {
  const { say, sent, sessions, chatId } = makeHandler('dual-narrow');
  await say('CENTAR');
  await say('STAN MI TREBA');
  await say('DO 150000 ZA KUPUVANJE');
  await say('DO 350 ZA IZNAJMUVANJE');
  await say('DVOSOBEN'); // the pair: EB 70 (rent) + EB 69 (buy)

  const rentOnly = await say('ZA IZNAJMUVANJE ?');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.dualService, undefined, 'the named market retires the pair');
  assert.equal(s.slots.service, 'rent');
  assert.equal(s.slots.budget, '350', "the rent leg's own cap becomes the search's cap");
  const ebs = ebsIn(rentOnly);
  assert.ok(ebs.includes(70), `the rent card is served: ${rentOnly}`);
  assert.ok(!ebs.includes(69), `a flat for SALE must never answer a rent ask: ${rentOnly}`);
  assert.equal(sent.at(-1)?.source?.startsWith('deterministic'), true,
    `this answer is in the DB — never an LLM round trip: ${sent.at(-1)?.source}`);
});

test('[19:26] the flat named by its rent is the subject: fee protocol, then THAT flat answers the location asks', async () => {
  const { say, sessions, chatId } = makeHandler('named-rent');
  await say('CENTAR');
  await say('STAN MI TREBA');
  await say('DO 150000 ZA KUPUVANJE');
  await say('DO 350 ZA IZNAJMUVANJE');
  await say('DVOSOBEN');

  const fee = await say('OVOJ ZA 350 EVRA KIRIJA BI GO VIDEL');
  const s = sessions.get(chatId)!;
  assert.equal(s.state, 'closing', `the visit protocol owns the turn: ${fee}`);
  assert.match(fee, /300 денари/u, `the RENT fee is disclosed: ${fee}`);
  assert.equal(s.slots.propertyId, 70, 'the flat he named is the one under discussion');

  const address = await say('NA KOJA ADRESA E ?');
  assert.match(address, /Евидентен број 70/u, `the address answer is for EB 70: ${address}`);
  assert.doesNotMatch(address, /Евидентен број (?:76|63|69)/u, `not another card: ${address}`);

  const nearby = await say('DOBRO TOGAS KAZI MI STO IMA VO BLIZINA POZNATO ?');
  assert.match(nearby, /Евидентен број 70/u, `the surroundings answer is for EB 70: ${nearby}`);
  assert.doesNotMatch(nearby, /Евидентен број (?:76|63|69)/u,
    `never a flat from another batch: ${nearby}`);
});

test('[19:30–19:32] a repeated visit request after the disclosure IS the agreement — one fee, then the contact ask', async () => {
  const { say, sessions, chatId } = makeHandler('visit-agree');
  await say('CENTAR');
  await say('STAN MI TREBA');
  await say('DO 150000 ZA KUPUVANJE');
  await say('DO 350 ZA IZNAJMUVANJE');
  await say('DVOSOBEN');
  await say('OVOJ ZA 350 EVRA KIRIJA BI GO VIDEL'); // the fee disclosure
  const agree = await say('70 BI SAKAL DA GO POSETAM');
  const s = sessions.get(chatId)!;
  assert.equal(s.state, 'contact_collection', `the visit request closes the fee turn: ${agree}`);
  assert.doesNotMatch(agree, /300 денари/u, `never a second disclosure: ${agree}`);
  assert.match(agree, /име|телефон/u, `the contact ask: ${agree}`);
});

test('[19:36] «КОЈА АГЕНЦИЈА СТЕ ВИЕ?» answers the agency and repeats the pending question — client and owner', async () => {
  assert.equal(detectAgencyIdentityAsk('KOJA AGENCIJA STE VIE ?'), true);
  assert.equal(detectAgencyIdentityAsk('која агенција сте вие?'), true);
  assert.equal(detectAgencyIdentityAsk('KAKO SE VIKA AGENCIJATA ?'), true);
  assert.equal(detectAgencyIdentityAsk('KOLKU E PROVIZIJATA NA AGENCIJATA ?'), false);
  assert.equal(detectAgencyIdentityAsk('NA KOJA ADRESA E ?'), false);

  const { say, handler, sessions, chatId } = makeHandler('identity');
  await say('CENTAR');
  await say('STAN MI TREBA');
  await say('DO 150000 ZA KUPUVANJE');
  await say('DO 350 ZA IZNAJMUVANJE');
  await say('DVOSOBEN');
  const identity = await say('KOJA AGENCIJA STE VIE ?');
  assert.match(identity, /Метрополис/u, `the agency is named: ${identity}`);
  assert.ok(identity.trim().endsWith('?'), `and the pending question is repeated: ${identity}`);

  // OWNER SIDE: the same question mid-ping-pong gets the same treatment.
  const s = sessions.get(chatId)!;
  s.state = 'owner_checking';
  s.slots.ownerAskTime = 'Вторник во 18:00';
  s.slots.visitTime = 'Вторник во 18:00';
  s.slots.interestedPropertyId = 70;
  sessions.set(s);
  const ownerReply = handler.ownerQuestionReply(chatId, 'KOJA AGENCIJA STE VIE ?');
  assert.ok(ownerReply, 'the owner question lane must answer');
  assert.match(ownerReply!, /Метрополис/u, `the owner hears the agency name: ${ownerReply}`);
  assert.ok(ownerReply!.trim().endsWith('?'), `and the term question is repeated: ${ownerReply}`);
});

test('a budget that also names a PLACE is a full search — the area is banked, never swallowed by the money capture', async () => {
  // THE [20:33] REGRESSION: «KIRIJA DO 350E VO CENTAR» was read as a PURE money
  // delivery for the dual-budget capture, which skips applySlots — so the
  // pinned area never landed. Everything downstream inherited an area-less
  // funnel: the discovery re-asked the part of town the client had just named,
  // and the pricier / elsewhere pivots ranked the WHOLE city (an Аеродром flat
  // served inside a Центар search).
  const { say, sessions, chatId } = makeHandler('budget-and-place');
  const ask = await say('KIRIJA DO 350E VO CENTAR');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.location, 'Центар (населба)', `the area is banked: ${ask}`);
  assert.equal(s.slots.budget, '350', 'and the cap');
  assert.equal(s.slots.service, 'rent');
  assert.match(ask, /стан|куќа|деловен/u, `the TYPE is asked (it was never named): ${ask}`);
  assert.doesNotMatch(ask, /населба или дел од градот/iu,
    `never re-ask the place he just gave: ${ask}`);
});

test('the mention binder reads a RENT price — a 3-digit euro figure binds, a cap does not', () => {
  const cands = [
    { eb: 70, price: 350, bedrooms: 2, sqm: 39 },
    { eb: 76, price: 200, bedrooms: 0, sqm: 24, studio: true },
  ];
  assert.deepEqual(extractMentionSignals('OVOJ ZA 350 EVRA KIRIJA'), { price: 350 });
  assert.equal(resolveMention('OVOJ ZA 350 EVRA KIRIJA', cands as never)?.eb, 70);
  assert.equal(resolveMention('OVOJ ZA 200 EVRA', cands as never)?.eb, 76);
  // A CAP is the client's budget, never a reference to a card.
  assert.deepEqual(extractMentionSignals('DO 350 EVRA ZA IZNAJMUVANJE'), {});
  // The fee's own amounts are not prices (5/10 €, 300/500 ден).
  assert.deepEqual(extractMentionSignals('NADOMEST 300 DENARI'), {});
  assert.deepEqual(extractMentionSignals('10 EVRA ZA POSETA'), {});
});

test('a visit command that names its market is not an exhausted-follow-up', () => {
  const t = 'OVOJ ZA 350 EVRA KIRIJA BI GO VIDEL';
  assert.equal(detectVisitInterest(t), true);
  assert.equal(detectExhaustedFollowUp(t), false, 'the market noun must not veto the visit');
  // A genuine market comment keeps the lane.
  assert.equal(detectExhaustedFollowUp('KIRIJA E SKUPA ZA TOJ REON'), true);
  assert.equal(detectExhaustedFollowUp('NE BI GO VIDEL'), false); // negation: not even interest
});

test('[19:30] «DOGOVORI MI DA GO VIDAM 70» is the visit protocol, never the exhausted line', async () => {
  const { say, sessions, chatId } = makeHandler('arrange-70');
  await say('CENTAR');
  await say('STAN MI TREBA');
  await say('DO 150000 ZA KUPUVANJE');
  await say('DO 350 ZA IZNAJMUVANJE');
  await say('DVOSOBEN');
  const arrange = await say('DOGOVORI MI DA GO VIDAM 70');
  const s = sessions.get(chatId)!;
  assert.equal(s.slots.propertyId, 70, 'the flat he named is the subject');
  assert.equal(s.state, 'closing', `the fee gate opens: ${arrange}`);
  assert.match(arrange, /300 денари/u, `the RENT fee is disclosed: ${arrange}`);
  assert.doesNotMatch(arrange, /исцрп|прегледавме сите|друга населба/iu,
    `the exhausted-properties line is a lie here — the flat exists: ${arrange}`);
  // The arrange VERB must not read as the contract NOUN (a documents lecture).
  assert.doesNotMatch(arrange, /документ/iu, `never the paperwork answer: ${arrange}`);
});

test('[19:34] «STOM TAKA RABOTITE DOGOVORI TOA E TOA» IS the consent — contact ask, no re-lecture', async () => {
  assert.equal(detectFeePaymentAgreement('STOM TAKA RABOTITE DOGOVORI TOA E TOA'), true);
  assert.equal(detectFeePaymentAgreement('ШТОМ ТАКА РАБОТИТЕ ДОГОВОРИ ТОА Е ТОА'), true);
  assert.equal(detectFeePaymentAgreement('DOGOVORI TOA E TOA'), true);
  assert.equal(detectFeePaymentAgreement('KE SE DOGOVORIME'), true);
  // A visit command is the visit lane's traffic, not a fee-agreement token.
  assert.equal(detectFeePaymentAgreement('DOGOVORI MI DA GO VIDAM 70'), false);
  assert.equal(detectFeePaymentAgreement('DOGOVORI MI POSETA'), false);
  // A question about the practice stays the explanation lane.
  assert.equal(detectFeePaymentAgreement('STOM TAKA RABOTITE ZOSTO 300 ?'), false);

  const { say, sessions, chatId } = makeHandler('concessive-yes');
  await say('CENTAR');
  await say('STAN MI TREBA');
  await say('DO 150000 ZA KUPUVANJE');
  await say('DO 350 ZA IZNAJMUVANJE');
  await say('DVOSOBEN');
  await say('70 BI SAKAL DA GO POSETAM');   // the fee is disclosed
  await say('NAPLATA ZA POSETA IMA?');      // rung 1: a nag
  await say('ZA SEKOJ STAN PO 300?');       // rung 2: another nag
  const yes = await say('STOM TAKA RABOTITE DOGOVORI TOA E TOA');
  const s = sessions.get(chatId)!;
  assert.equal(s.state, 'contact_collection', `the concession closes the fee turn: ${yes}`);
  assert.equal(s.slots.viewingFeeAgreed, true, 'the notebook records the yes');
  assert.match(yes, /име|телефон/u, `the contact ask is served: ${yes}`);
  assert.doesNotMatch(yes, /300 денари|Надомест/iu, `never a fourth explanation: ${yes}`);
  assert.doesNotMatch(yes, /документ/iu, `and never the paperwork lecture: ${yes}`);
});

// THE IDENTITY ANSWER REPEATS WHAT IS PENDING, NOT WHAT WAS ANSWERED — the
// [19:36] capture, continued. The client gave his term («MOZAM VO VTORNIK VO 6»)
// and the chat moved to owner_checking; the identity ask then repeated an
// EARLIER question ("Кој термин би Ви одговарал за посета?"), asking a client
// for a term he had already given — the same "ignores everything beside the
// ping-pong" defect the owner reported, one turn later. Only the LAST assistant
// turn's own question may be re-asked; when it asked nothing, the state's
// standing line says where the deal really is.
test('[19:36] the identity answer repeats only the STILL-PENDING question — never a term already given', async () => {
  // The request/interest split the fee-agreement gate depends on.
  assert.equal(detectVisitRequest('70 BI SAKAL DA GO POSETAM'), true);
  assert.equal(detectVisitRequest('DOGOVORI MI DA GO VIDAM 70'), true);
  assert.equal(detectVisitRequest('PA VIDI STO E SO NEGO ZAINTERESIRAN SUM'), false,
    'a mere interest tail is not a visit request');
  assert.equal(detectVisitRequest('NE SAKAM DA GO POSETAM'), false,
    'and a refusal is not one either');

  const { say, sessions, chatId } = makeHandler('identity-pending');
  await say('CENTAR');
  await say('STAN MI TREBA');
  await say('DO 150000 ZA KUPUVANJE');
  await say('DO 350 ZA IZNAJMUVANJE');
  await say('DVOSOBEN');
  await say('OVOJ ZA 350 EVRA KIRIJA BI GO VIDEL'); // the fee disclosure
  await say('70 BI SAKAL DA GO POSETAM');           // the agreement
  await say('PETAR PETROVSKI 070123456');           // the contact
  assert.equal(sessions.get(chatId)!.state, 'visit_scheduling', 'the term is asked');
  const time = await say('MOZAM VO VTORNIK VO 6');
  assert.equal(sessions.get(chatId)!.state, 'owner_checking', `the owner is checked: ${time}`);

  const identity = await say('KOJA AGENCIJA STE VIE ?');
  assert.match(identity, /Метрополис/u, `the agency is named: ${identity}`);
  assert.doesNotMatch(identity, /термин/u,
    `never re-ask a term the client already gave: ${identity}`);
  assert.match(identity, /сопственик/u, `says where the deal stands: ${identity}`);
});
