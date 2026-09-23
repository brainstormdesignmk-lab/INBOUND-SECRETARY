#!/usr/bin/env tsx
/**
 * sweep-keys — the trigger sweep over ALL bank-key families.
 *
 * Same contract as harden-triggers (generate → simulate through REAL
 * detectors → classify), but the family table covers the whole routing
 * surface, not just this session's five fixes. Each family names the bank
 * key it feeds, so a GAP means: that bank answer is unreachable for a
 * natural client phrasing TODAY.
 *
 *   COVERED — target fires, no dangerous competitor
 *   GAP     — target silent → the key never gets served → bug reproduces
 *   CROSS   — target fires but a competitor co-fires (routing race; guards
 *             or branch order resolve — each CROSS is a pin candidate)
 *
 * REPORT ONLY — nothing is patched. Patching is a separate, approved step.
 *
 * Usage:
 *   npx tsx scripts/sweep-keys.ts                     # all families
 *   npx tsx scripts/sweep-keys.ts --pass agreement    # one family
 *   npx tsx scripts/sweep-keys.ts --batches 3         # more batches
 *   npx tsx scripts/sweep-keys.ts --replay            # re-classify saved corpora
 *   npx tsx scripts/sweep-keys.ts --report            # summary from saved corpora
 */

import '../src/compat/node16';
import * as fs from 'fs';
import { loadConfig } from '../src/config';
import { createLlmStrict } from '../src/llm/factory';
import {
  detectAgreement, detectAvailabilityAsk, detectBedrooms, detectBothServices,
  detectBudget, detectBusiness, detectCheaperSearch, detectComparison,
  detectDefer, detectDocumentsAsk, detectEnthusiasm, detectEscalation, detectExplicitWiden,
  detectExactAddressAsk, detectExhaustedFollowUp, detectEyeCatch,
  detectFeatureAsk, detectFeeComplaint, detectFeeSurprise, detectFeeWhy,
  detectGarsonjera, detectHouse, detectInvestmentOpinion, detectLocation,
  detectMortgageAsk, detectNearbyAsk, detectNegotiate, detectNeighborhoodAsk,
  detectOfftopic, detectOwnerContact, detectPriceAsk, detectPriceFreshness, detectPropertyDescription,
  detectProvisionAsk, detectProvisionWho, detectRejection,
  detectSchedulingFlex, detectSeeOffers, detectService,
  detectSuggestAlternatives, detectTimeRejection, detectVagueTime,
  detectVisitCancellation, detectVisitInterest, detectVisitTime,
  detectWhereIs, detectWidenIntent, extractSlots, isKadeTocno,
} from '../src/llm/deterministic';

interface FamilySpec {
  id: string;
  bankKey: string;          // the answer this intent must reach
  protects: string;         // what breaks when the key is unreachable
  seedLine: string;
  genPrompt: string;
  batches: number;
  target: (t: string) => boolean;
  crossFire: Record<string, (t: string) => boolean>;
  benignCross?: Record<string, (t: string) => boolean>;
}

const b = (fn: (t: string) => unknown) => (t: string) => Boolean(fn(t));

const C = {
  budget: b(detectBudget), priceAsk: b(detectPriceAsk), freshness: b(detectPriceFreshness),
  service: b(detectService), both: b(detectBothServices), enthusiasm: b(detectEnthusiasm), remark: b(detectEnthusiasm),
  agreement: b(detectAgreement), availability: b(detectAvailabilityAsk),
  visit: b(detectVisitInterest), whereIs: b(detectWhereIs), nearby: b(detectNearbyAsk),
  feeComplaint: b(detectFeeComplaint), feeWhy: b(detectFeeWhy), feeSurprise: b(detectFeeSurprise),
  invest: b(detectInvestmentOpinion), cheaper: b(detectCheaperSearch),
  bedrooms: (t: string) => detectBedrooms(t) !== undefined,
  location: (t: string) => detectLocation(t, []) !== undefined, widen: b(detectExplicitWiden),
  offtopic: b(detectOfftopic), escalate: b(detectEscalation),
  provisionAsk: b(detectProvisionAsk), provisionWho: b(detectProvisionWho),
  garage: b(detectGarsonjera), house: b(detectHouse), biz: b(detectBusiness),
  visitTime: b(detectVisitTime), vagueTime: b(detectVagueTime),
  timeRej: b(detectTimeRejection), cancel: b(detectVisitCancellation),
  ownerContact: b(detectOwnerContact), exactAddr: b(detectExactAddressAsk),
  seeOffers: b(detectSeeOffers), alternatives: b(detectSuggestAlternatives),
  negot: b(detectNegotiate), defer: b(detectDefer), docs: b(detectDocumentsAsk),
  mortgage: b(detectMortgageAsk), hood: b(detectNeighborhoodAsk),
  comparison: b(detectComparison), feature: b(detectFeatureAsk),
  schedFlex: b(detectSchedulingFlex), exhausted: b(detectExhaustedFollowUp),
  eyeCatch: b(detectEyeCatch), rejection: b(detectRejection), description: b(detectPropertyDescription),
  // The NEW-CRITERIA composite: the message names search criteria (bedrooms/
  // sqm/budget/garsonjera) but NO routing trigger fired on it — the exact
  // shape the exhausted-pivot release block releases on (the 23:26 fix).
  criteria: (t: string) => {
    const s = extractSlots(t);
    // Mirror of the release block's criteriaSignals — keep in sync.
    return !!(s.bedrooms || s.sqm || s.budget || s.garsonjera || s.sizeWaived
      || s.house !== undefined || s.business);
  },
};

/** Families = every bank-key intent worth a phrase population.
 *  The five already-swept families (interest-bind, price-freshness,
 *  bare-bedrooms, investment-verb, fee-counter) live in harden-triggers
 *  and are NOT duplicated here. */
export const FAMILIES: FamilySpec[] = [
  {
    id: 'agreement-yes',
    bankKey: '(gate) ownerContactPending → fee workflow',
    protects: 'the fee-consent YES gate — the greediest boundary in the funnel',
    seedLine: 'da',
    batches: 2,
    genPrompt: `The assistant just asked "Дали сакате да остварам контакт со сопственикот?" (shall I contact the owner for you?) or disclosed the small viewing fee and asked for agreement. The client says YES/consents. Vary: "da", "da super", "ok", "vazhi", "se soglasuvam", "ajde", "neka", "dobre", "togash da", "mhm" — typos ("dea", "okj"), both scripts, 1-4 words. MUST be consent to the asked question. NOT a new question, NOT availability, NOT a price ask.`,
    target: C.agreement,
    crossFire: { priceAsk: C.priceAsk, freshness: C.freshness, bedrooms: C.bedrooms, budget: C.budget, service: C.service, whereIs: C.whereIs, avail: C.availability },
  },
  {
    id: 'price-ask',
    bankKey: 'price.ask (fast path)',
    protects: 'the FIRST price quote — swallowed here means discovery loops or wrong info',
    seedLine: 'kolku e cenata ?',
    batches: 2,
    genPrompt: `A client asks the PRICE of a property under discussion (first time, not re-checking currency). Vary: "kolku chini?", "cena?", "za kolku e?", "koja e cenata na oglasot", "kolku bara sopstvenikot" — both scripts, typos ("cenua", "kolku cine"), colloquial, 1-8 words. MUST be a direct price question. NOT freshness ("uste vazi?"), NOT the viewing fee, NOT a budget statement.`,
    target: C.priceAsk,
    crossFire: { freshness: C.freshness, feeComplaint: C.feeComplaint, budget: C.budget, service: C.service, invest: C.invest },
    benignCross: { avail: C.availability },
  },
  {
    id: 'availability',
    bankKey: 'both.ask.availability',
    protects: 'the availability ask — wrong routing fakes a search or a visit',
    seedLine: 'dali e uste sloboden ?',
    batches: 2,
    genPrompt: `A client asks whether a SPECIFIC property still AVAILABLE (not taken/sold/rented). Vary: "e sloboden?", "dali e zauzet?", "uste e?" — both scripts, typos ("slobode", "zauze"), 2-8 words. MUST be about availability of the property on the table. NOT price, NOT a visit request, NOT "kade e" (where is it).`,
    target: C.availability,
    crossFire: { priceAsk: C.priceAsk, visit: C.visit, whereIs: C.whereIs, service: C.service },
  },
  {
    id: 'visit-interest',
    bankKey: 'both.ask.visit → visit_scheduling',
    protects: 'the transition to scheduling — losing it stalls the funnel at presentation',
    seedLine: 'sakam da go vidam stanot',
    batches: 2,
    genPrompt: `A client wants to SEE/visit the property in person. Vary: "moze li poseta?", "koga moze da se vidi?", "sakam termin", "ke dojdam da go vidam" — both scripts, typos, 2-9 words. MUST express wish for a viewing. NOT availability ("e sloboden?"), NOT a concrete time offer (that's scheduling), NOT price.`,
    target: C.visit,
    crossFire: { avail: C.availability, visitTime: C.visitTime, priceAsk: C.priceAsk, agreement: C.agreement },
  },
  {
    id: 'visit-time',
    bankKey: '(visit_scheduling capture)',
    protects: 'concrete time capture — a missed time means the client repeats and churns',
    seedLine: 'utre vo 12 casot',
    batches: 2,
    genPrompt: `The client offers/answers with a CONCRETE visit time. Vary: "utre na 5", "vo ponedelnik popladne", "sabota utro", "vo 18:30" — both scripts, typos ("utrea", "ponedelok"), natural formats (digits, words, "na 3casot"), 2-7 words. MUST contain a day and/or clock time in a visit context. NOT vague ("nekogas"), NOT rejection.`,
    target: C.visitTime,
    crossFire: { vagueTime: C.vagueTime, timeRej: C.timeRej, agreement: C.agreement, avail: C.availability },
  },
  {
    id: 'vague-time',
    bankKey: '(time follow-up ask)',
    protects: 'the clarify loop for non-times — swallowing a non-time fakes a booked slot',
    seedLine: 'nekogas popladne',
    batches: 1,
    genPrompt: `The client answers the "when can you visit?" question WITHOUT a concrete time. Vary: "popladne", "nekogas navecer", "bilo koga", "posle rabota", "najdobro vikendi" — both scripts, typos, 1-5 words. MUST be time-related but with NO specific day/clock. NOT a concrete time, NOT a refusal.`,
    target: C.vagueTime,
    crossFire: { visitTime: C.visitTime, timeRej: C.timeRej },
  },
  {
    id: 'time-rejection',
    bankKey: '(rescheduling branch)',
    protects: 'a refused slot must reschedule, never book',
    seedLine: 'togash ne mozam',
    batches: 1,
    genPrompt: `The client REJECTS the proposed visit time but is still interested. Vary: "togash ne mozam", "ne odgovara", "po drugo vreme", "ne mozam utre" — both scripts, typos ("mozam"→"mozan"), 2-6 words. MUST refuse the TIME. NOT cancelling the visit entirely, NOT offering a new time (that's visit-time).`,
    target: C.timeRej,
    crossFire: { visitTime: C.visitTime, cancel: C.cancel, vagueTime: C.vagueTime },
  },
  {
    id: 'visit-cancel',
    bankKey: '(cancellation path)',
    protects: 'a cancellation must free the slot, not await a no-show',
    seedLine: 'ne mozam da dojdam utre , otkazuvam',
    batches: 1,
    genPrompt: `The client CANCELS a booked viewing entirely. Vary: "otkazuvam", "ne ke dojdam", "vidi go drugpat", "ja otkeazuvam posetata" — both scripts, typos, 2-8 words. MUST cancel. NOT reschedule to another time (that's time-rejection with interest).`,
    target: C.cancel,
    crossFire: { timeRej: C.timeRej, visitTime: C.visitTime, defer: C.defer },
  },
  {
    id: 'fee-why',
    bankKey: 'fee.why',
    protects: 'the "why do I even pay this" question — wrong route serves price or drops persuasion',
    seedLine: 'zoska 500 denari ?',
    batches: 2,
    genPrompt: `The client asks WHY there is a viewing fee / what it is for (a question, not a complaint about the amount). Vary: "za shto e toj nadomestok?", "zoska da plakjam?", "shto dobivam za tie pari?", "zoska provizija koga drugade e gratis" — both scripts, typos ("zoshto", "nadomestok"), 2-12 words. MUST question the PURPOSE/EXISTENCE of the fee. NOT disputing the amount (that's the counter-offer), NOT asking the property price.`,
    target: C.feeWhy,
    crossFire: { priceAsk: C.priceAsk, feeComplaint: C.feeComplaint, feeSurprise: C.feeSurprise, provisionWho: C.provisionWho },
  },
  {
    id: 'fee-surprise',
    bankKey: 'fee.surprise',
    protects: 'first-hearing-the-fee reaction — must acknowledge surprise, not quote price',
    seedLine: 'kakva 10 evra ??',
    batches: 1,
    genPrompt: `The client hears about the viewing fee for the FIRST time and reacts with surprise (short exclamation, not yet a dispute or a "why"). Vary: "kakva taksa?", "10 evra?!", "ozbilno?", "e pa dobro..." — both scripts, typos, 1-6 words. MUST be surprise about the fee. NOT a why-question, NOT a counter-offer, NOT agreement.`,
    target: C.feeSurprise,
    crossFire: { feeWhy: C.feeWhy, feeComplaint: C.feeComplaint, agreement: C.agreement, priceAsk: C.priceAsk },
  },
  {
    id: 'negotiate',
    bankKey: 'price.negotiate',
    protects: 'price negotiation on the PROPERTY — must not trigger a search or fee talk',
    seedLine: 'moze li popust na cenata ?',
    batches: 1,
    genPrompt: `The client tries to NEGOTIATE the property's price. Vary: "dajte 130", "popust?", "sopstvenikot ke svali?", "moze na keš podobra cena" — both scripts, typos, 2-9 words. MUST be negotiation of the property price. NOT cheaper-search ("imate drugi poevtino"), NOT the viewing fee, NOT a budget cap.`,
    target: C.negot,
    crossFire: { cheaper: C.cheaper, feeComplaint: C.feeComplaint, budget: C.budget, priceAsk: C.priceAsk },
  },
  {
    id: 'cheaper',
    bankKey: '(cheaper-search branch)',
    protects: '"show me cheaper" — swallowed, it re-presents the same options',
    seedLine: 'imate nesto poevtino ?',
    batches: 2,
    genPrompt: `The client asks for CHEAPER OPTIONS than what was shown (a search request, not negotiating one property). Vary: "prikazi poeftino", "ima li nesto 20-30 kila pomalku", "ovoj mi e nad budzet, daj poevtino" — both scripts, typos ("poeftino", "poefitno"), 2-10 words. MUST ask for cheaper alternatives. NOT negotiation of one property, NOT a market complaint (no verb like poskapea).`,
    target: C.cheaper,
    crossFire: { budget: C.budget, negot: C.negot, invest: C.invest, alternatives: C.alternatives },
  },
  {
    id: 'suggest-alt',
    bankKey: '(alternatives pivot)',
    protects: '"show me something else" — wrong route repeats the same list',
    seedLine: 'pokazete mi drugi',
    batches: 1,
    genPrompt: `The client asks for DIFFERENT/OTHER options (any dimension — not specifically cheaper). Vary: "imate drugo?", "nesto drugo", "pokazi drugi lokacii", "ne ovoj, drug" — both scripts, typos, 1-8 words. MUST ask for alternatives. NOT cheaper-specific, NOT widening criteria explicitly.`,
    target: C.alternatives,
    crossFire: { cheaper: C.cheaper, widen: C.widen, seeOffers: C.seeOffers },
  },
  {
    id: 'widen',
    bankKey: '(widen-criteria branch)',
    protects: 'explicit criteria relaxation — swallowed, the search stays too narrow',
    seedLine: 'sirok opseg , i nad 250',
    batches: 1,
    genPrompt: `The client explicitly RELAXES their criteria (expand budget/area/rooms). Vary: "moze i nadvor od centar", "razgledajte siroko", "i do 300 da bide", "ne mora novo" — both scripts, typos, 2-10 words. MUST relax/expand criteria. NOT a new first search, NOT alternatives without relaxation.`,
    target: C.widen,
    crossFire: { budget: C.budget, alternatives: C.alternatives, location: C.location },
  },
  {
    id: 'defer',
    bankKey: 'followup.defer',
    protects: '"call me later" — swallowed, the bot keeps pushing the funnel',
    seedLine: 'ke se javam podocna',
    batches: 1,
    genPrompt: `The client postpones — will continue/contact LATER. Vary: "podocna ke zborame", "ne sega, posle", "ke vi pisam utre", "za ova ke razmislam i ke se javam" — both scripts, typos, 2-9 words. MUST postpone politely. NOT a rejection, NOT a question, NOT availability.`,
    target: C.defer,
    crossFire: { rejection: C.rejection, agreement: C.agreement, avail: C.availability },
  },
  {
    id: 'rejection',
    bankKey: '(rejection branch)',
    protects: 'a refused property must pivot, not keep presenting the same one',
    seedLine: 'ne , ovoj ne mi se svigja',
    batches: 1,
    genPrompt: `The client REJECTS the property just shown (still in the market). Vary: "ne ovoj", "ne mi se svigja ovoj", "ovoj ne", "preskoki go" — both scripts, typos, 1-8 words. MUST reject the property. NOT asking alternatives explicitly, NOT deferring, NOT price talk.`,
    target: C.rejection,
    crossFire: { alternatives: C.alternatives, defer: C.defer, agreement: C.agreement },
  },
  {
    id: 'where-is',
    bankKey: '(where-is / locate branch)',
    protects: '"where exactly is it" — swallowed, serves a generic description instead',
    seedLine: 'kade tochno e stanot ?',
    batches: 2,
    genPrompt: `The client asks WHERE the property is located (street/landmark/exact spot). Vary: "na koja ulica?", "kade e?", "vo koe kvartal?", "blizu shto e?", the EXACT-location family — "na koja lokacija e", "dali mi mozete da ja kazete tocnata lokacija", "tocna lokacija molam", "na koja adresa e" (these get the landmark rotation on turn 1, the agency protocol on turn 2). Both scripts, typos ("kade"→"kadee", "tocna"), 2-8 words. MUST ask location of the property. NOT availability, NOT "shto ima blizu" (nearby), NOT a first search for an area.`,
    target: (t: string) => { const w = detectWhereIs(t); const e = detectExactAddressAsk(t); return !!(w || e); },
    crossFire: { location: C.location, nearby: C.nearby, avail: C.availability },
    // "во која населба е ова" co-fires location (the handler serves the
    // rotation, which answers it approximately); "на која улица се продава"
    // co-fires availability (prodava-word race, pre-existing).
    benignCross: { location: C.location, avail: C.availability, nearby: C.nearby },
  },
  {
    // THE EXACT-ADDRESS DEMAND family — the ladder's turn-2 gate. Turn 1 of
    // any location ask serves rotation 1; only THIS family's insistence
    // ("точно која адреса", "kazi mi tocno adresata") escalates to the
    // privacy protocol, then the polite shut-down. The o-form "tocno
    // adresata" (indefinite adjective + definite noun) is a live gap class.
    id: 'exact-address',
    bankKey: '(EXACT_ADDRESS lane → address.exact)',
    protects: '"give me the exact address" — a miss re-serves rotation 1 forever',
    seedLine: 'kazi mi tocno adresata',
    batches: 1,
    genPrompt: `The client DEMANDS the exact address/street of the property (not just where it roughly is). Vary: "kazi mi tocno adresata", "tocna adresa molam", "daj mi ja adresata", "na koja ulica tochno", "adresata sakaam da ja znam", "која е точната адреса" — both scripts, typos ("tocna"→"tocno", "adresata"→"adresataa"), 2-8 words. MUST demand the exact address. NOT a plain where-is ("kade e" alone), NOT nearby amenities, NOT a search request.`,
    target: (t: string) => detectExactAddressAsk(t) && !isKadeTocno(t),
    crossFire: { whereIs: C.whereIs, nearby: C.nearby, location: C.location },
    // "na koja ulica e tochno" co-fires whereIs — the WHERE_IS lane climbs
    // the SAME ladder (rotation → protocol), so the client still reaches
    // the privacy line on insistence. Documented race, not a misroute.
    benignCross: { whereIs: C.whereIs, location: C.location },
  },
  {
    id: 'nearby',
    bankKey: '(nearby-ask branch)',
    protects: '"what is around it" — wrong route serves the property card again',
    seedLine: 'shto ima blizu ?',
    batches: 1,
    genPrompt: `The client asks what is AROUND the property (amenities/landmarks nearby). Vary: "ima li skola blizu?", "kakvi objekti ima okolu?", "daleku e do pazar?" — both scripts, typos, 2-9 words. MUST ask about surroundings. NOT where-is (asking the property's own location), NOT poi-confirm of a guess.`,
    target: C.nearby,
    crossFire: { whereIs: C.whereIs, avail: C.availability, feature: C.feature },
  },
  {
    id: 'service',
    bankKey: 'discovery.ask.service',
    protects: 'buy vs rent — the first funnel question; a miss starts the wrong branch',
    seedLine: 'baram pod kirija',
    batches: 2,
    genPrompt: `The client states BUY or RENT intent (any phrasing). Vary: "sakam da kupam", "baram stan za izdavanje", "kirija", "kupuvam", "za ziveenje da kupam" — both scripts, typos ("kupam"→"kupem", "kirija"→"krija"), 1-8 words. MUST state buy or rent. NOT both simultaneously, NOT a price ask, NOT budget.`,
    target: C.service,
    crossFire: { both: C.both, budget: C.budget, priceAsk: C.priceAsk, garage: C.garage },
  },
  {
    id: 'both-services',
    bankKey: '(both-services branch)',
    protects: 'the "both" answer — swallowed, the funnel forces a wrong single choice',
    seedLine: 'i kupuvam i kirija me interesira',
    batches: 1,
    genPrompt: `The client says BOTH buying AND renting interest. Vary: "dvete", "i ednoto i drugoto", "kakvo bilo, kupuvam ili kirija" — both scripts, typos, 1-9 words. MUST express both. NOT a single service.`,
    target: C.both,
    crossFire: { service: C.service, agreement: C.agreement },
  },
  {
    id: 'garsonjera',
    bankKey: 'discovery.ask.type (studio)',
    protects: 'type detection: studio',
    seedLine: 'garsonjera baram',
    batches: 1,
    genPrompt: `The client wants a STUDIO/garsonjera. Vary: "malo stanche", "garnizonera", "studio", "ednosoben" — typos ("garsonjera"→"garsonjeraa", "garnsonjera"), both scripts, 1-6 words. MUST be studio. NOT a number of bedrooms (that's the rooms question), NOT price.`,
    target: C.garage,
    crossFire: { bedrooms: C.bedrooms, service: C.service, budget: C.budget },
  },
  {
    id: 'house',
    bankKey: 'discovery.ask.type (house)',
    protects: 'type detection: house',
    seedLine: 'kuka barame',
    batches: 1,
    genPrompt: `The client wants a HOUSE. Vary: "kukja so dvor", "vila", "barame kuka" — typos ("kuka"→"kukaа"), both scripts, 1-7 words. MUST be house. NOT business space, NOT apartment.`,
    target: C.house,
    crossFire: { biz: C.biz, garage: C.garage, service: C.service },
  },
  {
    id: 'business',
    bankKey: 'discovery.ask.type (business)',
    protects: 'type detection: business premises',
    seedLine: 'deloven prostor baram',
    batches: 1,
    genPrompt: `The client wants BUSINESS premises. Vary: "lokalicza", "dukan", "kancelarija", "magacin" — typos ("lokalchica", "dukjan"), both scripts, 1-7 words. MUST be business. NOT house, NOT apartment.`,
    target: C.biz,
    crossFire: { house: C.house, garage: C.garage, service: C.service },
  },
  {
    id: 'owner-contact',
    bankKey: '(owner-contact ask)',
    protects: '"can I talk to the owner directly" — sensitive: agency policy answer',
    seedLine: 'moze direktno so sopstvenikot ?',
    batches: 1,
    genPrompt: `The client asks to CONTACT THE OWNER directly. Vary: "dajte mi go brojot na gazdata", "sopstvenikot moze li da go javam?", "posredno ne sakam" — both scripts, typos, 2-10 words. MUST be a direct-owner-contact request. NOT the fee, NOT availability.`,
    target: C.ownerContact,
    crossFire: { feeWhy: C.feeWhy, agreement: C.agreement, avail: C.availability, provisionWho: C.provisionWho },
  },
  {
    id: 'provision-ask',
    bankKey: 'provision.ask',
    protects: 'the commission amount question — swallowed, fallback text leaks',
    seedLine: 'kolku e provizijata ?',
    batches: 1,
    genPrompt: `The client asks the AMOUNT of the agency commission/provision. Vary: "kolku vi e provizijata?", "kolku plakjate agencii?", "provizija?" — typos ("provizija"→"provizia"), both scripts, 1-8 words. MUST ask the commission amount. NOT who pays it (that's provision-who), NOT the viewing fee complaint.`,
    target: C.provisionAsk,
    crossFire: { provisionWho: C.provisionWho, feeWhy: C.feeWhy, priceAsk: C.priceAsk },
  },
  {
    id: 'provision-who',
    bankKey: 'provision.who',
    protects: 'who-pays-the-commission — the 50/50 policy answer',
    seedLine: 'koj ja plakja provizijata ?',
    batches: 1,
    genPrompt: `The client asks WHO PAYS the commission (buyer/seller/both). Vary: "plakja li kupuvacot?", "kaj e 50-50?", "dali sopstvenikot plakja" — both scripts, typos, 2-9 words. MUST ask who bears the commission. NOT the amount, NOT the viewing fee.`,
    target: C.provisionWho,
    crossFire: { provisionAsk: C.provisionAsk, feeWhy: C.feeWhy },
  },
  {
    id: 'escalation',
    bankKey: 'escalation.polite',
    protects: 'manager escalation — swallowed, angry clients churn',
    seedLine: 'sakam da zboram so menadzer',
    batches: 1,
    genPrompt: `The client demands a MANAGER/human/supervisor. Vary: "vikaite nekoj nadlezan", "ke javam naDirektor", "sopstvenik na agencijata da vi bidi" — typos ("menadzer"→"menazer"), both scripts, 2-9 words. MUST demand escalation. NOT off-topic, NOT a complaint about prices (that's investment opinion).`,
    target: C.escalate,
    crossFire: { invest: C.invest, feeComplaint: C.feeComplaint, offtopic: C.offtopic },
  },
  {
    id: 'documents',
    bankKey: 'documents.info',
    protects: 'document questions — swallowed, the funnel stalls',
    seedLine: 'kakvi dokumenti se potrebni ?',
    batches: 1,
    genPrompt: `The client asks about DOCUMENTS (needed for buy/rent, contract, notary). Vary: "sto dokumenti?", "dali treba dogovor", "kakvi papki za kirija" — typos ("dokumenti"→"dokumeti"), both scripts, 2-9 words. MUST be about documents/paperwork. NOT mortgage, NOT price.`,
    target: C.docs,
    crossFire: { mortgage: C.mortgage, priceAsk: C.priceAsk },
  },
  {
    id: 'mortgage',
    bankKey: 'mortgage.info',
    protects: 'financing questions — swallowed, the funnel offers visits instead',
    seedLine: 'imate krediti ?',
    batches: 1,
    genPrompt: `The client asks about FINANCING/mortgage/credit/bank loan. Vary: "dali pomagate so kredit?", "kakvi banki sorabotuvate", "glavnica i kamata" — typos ("kredit"→"kreditе"), both scripts, 1-9 words. MUST be about financing. NOT documents, NOT price.`,
    target: C.mortgage,
    crossFire: { docs: C.docs, priceAsk: C.priceAsk, budget: C.budget },
  },
  {
    id: 'neighborhood',
    bankKey: 'neighborhood.general',
    protects: 'area questions in discovery — swallowed, the funnel re-asks criteria',
    seedLine: 'vo koi naselbi imate ?',
    batches: 1,
    genPrompt: `The client asks which AREAS/neighborhoods the agency covers (discovery stage, not a property on the table). Vary: "kade imate stanovi?", "vo Centar imate?", "koi kvartali gi pokrivate" — typos ("naselba"→"naselva"), both scripts, 2-9 words. MUST ask coverage/areas. NOT where-is of a specific property, NOT a first location preference statement.`,
    target: C.hood,
    crossFire: { location: C.location, whereIs: C.whereIs },
  },
  {
    id: 'comparison',
    bankKey: 'comparison.help',
    protects: '"which of the two is better" — swallowed, the funnel ignores the question',
    seedLine: 'koj e podoben od dvata ?',
    batches: 1,
    genPrompt: `The client asks to COMPARE two or more properties already shown. Vary: "koe e podobro?", "sporedi gi", "razlikite me interesiraat" — typos ("sporedi"→"sporedи"), both scripts, 2-9 words. MUST ask comparison of shown properties. NOT feature questions about one, NOT price ask.`,
    target: C.comparison,
    crossFire: { feature: C.feature, priceAsk: C.priceAsk },
  },
  {
    id: 'feature-ask',
    bankKey: 'feature.after.show',
    protects: 'detail questions on a shown property — swallowed, the funnel re-presents',
    seedLine: 'dali ima lift ?',
    batches: 2,
    genPrompt: `The client asks about a FEATURE/DETAIL of the property on the table (lift, parking, floor, heating, furniture). Vary: "na koj sprat e?", "ima parking?", "toplo voda ima?", "namesten li e" — typos ("namesten"→"namestten"), both scripts, 2-8 words. MUST ask a specific feature. NOT comparison of two, NOT availability.`,
    target: C.feature,
    crossFire: { comparison: C.comparison, avail: C.availability, whereIs: C.whereIs },
  },
  {
    id: 'scheduling-flex',
    bankKey: 'scheduling.flex',
    protects: '"can we move the time" — swallowed, reads as rejection',
    seedLine: 'moze li podocna ?',
    batches: 1,
    genPrompt: `The client asks to FLEX the scheduled time (politely, keeping the visit). Vary: "moze 1 cas podocna?", "ke mozam li posle 6?", " pomestete go za utre" — typos, both scripts, 2-8 words. MUST ask to move/flex the appointment. NOT rejection, NOT cancellation.`,
    target: C.schedFlex,
    crossFire: { timeRej: C.timeRej, cancel: C.cancel, visitTime: C.visitTime },
  },
  {
    id: 'exhausted',
    bankKey: 'no.match.location / no.match.plain',
    protects: '"nothing of this fits" — the exhausted-follow-up that keeps re-serving the same list',
    seedLine: 'nisto od ovie ne mi odgovara',
    batches: 1,
    genPrompt: `After being shown several options, the client says NONE fits (exhausted, still polite). Vary: "ovie ne", "nisto za mene", "site se istovetni", "nema nisto vistinsko?" — typos, both scripts, 1-8 words. MUST be "none of these". NOT rejection of ONE property, NOT a cheaper ask, NOT defer.`,
    target: C.exhausted,
    crossFire: { alternatives: C.alternatives, cheaper: C.cheaper, rejection: C.rejection, defer: C.defer },
  },
  {
    id: 'exhausted-pivot',
    bankKey: '(new-criteria release block)',
    protects: 'fresh search criteria after exhaustion — swallowed means the exhausted ask loops over a NEW search (the 23:26 transcript)',
    seedLine: 'a so edna spalna nesto',
    batches: 2,
    genPrompt: `The assistant just said every matching option is exhausted and asked: register your criteria for later, or look in another neighborhood? The client instead PIVOTS with fresh search criteria — different size/rooms ("a so edna spalna nesto", "a imas so dve spalni", "a nesto pogolem"), a different category ("drugi garsonjeri nemate ?", "a dvosobni stanovi ima?"), or a new budget ("a do 300 evra nesto?"). Vary tone: hesitant, direct, "a"/"ili" pivots, short questions. Typos ("garsonjeraa", "garsonjeraa", "spalnii"), both scripts, 2-8 words. MUST name concrete search criteria (rooms/size/category/budget). NOT pure consent ("da", "ajde zabelezi"), NOT rejection ("ne ovie"), NOT a fee or price-of-one-property question, NOT a market opinion, NOT small talk, NOT only a neighborhood name without criteria.`,
    target: C.criteria,
    crossFire: {
      agreement: C.agreement, service: C.service, both: C.both, seeOffers: C.seeOffers,
      description: C.description, invest: C.invest, priceAsk: C.priceAsk,
      feeComplaint: C.feeComplaint, exhausted: C.exhausted, offtopic: C.offtopic,
    },
  },
  {
    id: 'size-waived',
    bankKey: '(discovery funnel: sizeWaived slot — bedroom ask skipped, biggest-for-the-money presentation)',
    protects: 'the 21:40 transcript: "NEBITNO" / "NE E BITNO KOLKU SPALNI" missed detectSizeWaived, the funnel re-asked bedrooms and swallowed the price criterion',
    seedLine: 'nebitno',
    batches: 2,
    genPrompt: `The assistant asked "Колку спални соби…?" (how many bedrooms) during a search funnel. The client says bedrooms DON'T MATTER — any size is fine, budget decides. Shapes: bare "nebitno" / "ne bitno", "ne e bitno kolkju spalni", "ne me zanimaat spalnite", "ne e vazno kolku spalni", "kako sto ke bide", "bilo kolkav", "site po golemina mi odgovaraat", "ne go ogranicuvam brojot na spalni", dismissals WITH the topic noun — "nema veze kolkju spalni ima", "nema veze kolku spalni ima stanot", "nema veze spalnite", "ne pravam problem za sobite". Vary: one-word shrug, polite sentence, annoyed repetition (they already answered once). Typos ("nebitnoо", "spalnii", "kolkju"), both scripts, 1-8 words. MUST express indifference to size/bedrooms. NOT a concrete bedroom count ("edna spalna"), NOT sqm ("do 60 m2"), NOT budget ("do 300 e"), NOT price/freshness questions, NOT fee, NOT agreement to anything, NOT small talk.`,
    target: (t: string) => { const s = extractSlots(t); return !!s.sizeWaived; },
    crossFire: {
      bedrooms: C.bedrooms, budget: C.budget, garage: C.garage, agreement: C.agreement,
      feeComplaint: C.feeComplaint, priceAsk: C.priceAsk, offtopic: C.offtopic,
    },
    // “seedno mi e za spalniti“ garbles into a bedrooms match — benign: the
    // waiver branch consumes sizeWaived BEFORE any bedrooms ask in discovery.
    benignCross: { bedrooms: C.bedrooms },
  },
  {
    id: 'enthusiasm',
    bankKey: '(remark/enthusiasm ack)',
    protects: 'pure enthusiasm ("super!") — swallowed, the bot answers a question nobody asked',
    seedLine: 'super !',
    batches: 1,
    genPrompt: `The client reacts with PURE enthusiasm/praise, no question, no request. Vary: "odlichno!", "bravo", "fantastika e", "super izgleda" — typos ("super"→"supr"), both scripts, 1-5 words. MUST be bare enthusiasm. NOT interest-claim with a property ask, NOT agreement to a question.`,
    target: C.enthusiasm,
    crossFire: { agreement: C.agreement, avail: C.availability },
  },
  {
    id: 'offtopic',
    bankKey: 'offtopic.redirect',
    protects: 'the redirect — a miss means real-estate answers to nonsense',
    seedLine: 'dali imate tiketi za fudbal ?',
    batches: 1,
    genPrompt: `A client says something COMPLETELY OFF real-estate (small talk, other business, nonsense). Vary: "kje vidime fudbal?" ("does it rain tomorrow?"), "imate taxi?", "kolku e 2+2", "zdravo kako si" — typos, both scripts, 1-8 words. MUST be clearly NOT about property/search/visit/fee. Keep it short and diverse.`,
    target: C.offtopic,
    crossFire: { service: C.service, avail: C.availability, priceAsk: C.priceAsk },
  },
];

interface Row {
  phrase: string;
  verdict: 'COVERED' | 'GAP' | 'CROSS';
  target: boolean;
  cross: string[];
  benign: string[];
}

async function generateBatch(llm: ReturnType<typeof createLlmStrict>, spec: FamilySpec, i: number): Promise<string[]> {
  const r = await llm.complete({
    role: 'generate',
    messages: [
      { role: 'system', content: 'You generate realistic Macedonian client chat lines for a real-estate assistant. Output ONLY lines, each prefixed "- ". No numbering, no explanations. Real clients make typos, mix scripts, are brief.' },
      { role: 'user', content: `${spec.genPrompt}\n\nExample of the intent (do NOT copy it): ${spec.seedLine}\n\nGenerate 15 distinct lines${i > 0 ? `, variation angle #${i + 1} (different vocabulary than typical)` : ''}:` },
    ],
    temperature: 1.0 + i * 0.15,
    maxTokens: 600,
    topP: 0.95,
  });
  return r.split('\n').map(l => l.trim()).filter(l => l.startsWith('- ')).map(l => l.slice(2).trim()).filter(l => l.length > 1);
}

function classify(spec: FamilySpec, phrase: string): Row {
  const target = spec.target(phrase);
  const cross = Object.entries(spec.crossFire).filter(([, fn]) => fn(phrase)).map(([k]) => k);
  const benign = Object.entries(spec.benignCross ?? {}).filter(([, fn]) => fn(phrase)).map(([k]) => k);
  const isSeed = phrase === spec.seedLine;
  // benignCross = documented benign overlaps; they must not flag a CROSS
  // (the field existed but the verdict never subtracted it — a phrase that
  // fired both a crossFire and a benignCross counted as a dangerous race).
  const realCross = cross.filter(k => !(spec.benignCross?.[k]?.(phrase)));
  let verdict: Row['verdict'];
  if (target && realCross.length === 0) verdict = 'COVERED';
  else if (target && realCross.length > 0) verdict = 'CROSS';
  else verdict = isSeed ? 'COVERED' : 'GAP';
  return { phrase, verdict, target, cross: realCross, benign };
}

async function runFamily(llm: ReturnType<typeof createLlmStrict>, spec: FamilySpec, batchCount: number, existing: Row[] = []): Promise<Row[]> {
  // CUMULATIVE corpora: a regression asset only grows. Previous phrases are
  // re-classified with the CURRENT detectors; the new batch adds on top.
  const phrases = new Set<string>([spec.seedLine, ...existing.map(r => r.phrase)]);
  for (let i = 0; i < batchCount; i++) {
    try {
      for (const p of await generateBatch(llm, spec, i)) phrases.add(p);
    } catch (e) {
      console.error(`  [${spec.id}] batch ${i} failed: ${(e as Error).message}`);
    }
  }
  return [...phrases].map(p => classify(spec, p));
}

function loadCorpus(id: string): Row[] {
  const file = `data/hardening/${id}.json`;
  if (!fs.existsSync(file)) return [];
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as { rows?: Row[] };
    return Array.isArray(saved.rows) ? saved.rows : [];
  } catch { return []; }
}

function replay(only?: string): void {
  const ids = only ? FAMILIES.filter(f => f.id.includes(only)).map(f => f.id) : FAMILIES.map(f => f.id);
  for (const id of ids) {
    const file = `data/hardening/${id}.json`;
    if (!fs.existsSync(file)) { console.log(`[replay] ${id}: no saved corpus`); continue; }
    const spec = FAMILIES.find(f => f.id === id)!;
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as { rows?: Row[] };
    if (!Array.isArray(saved.rows)) { console.log(`[replay] ${id}: foreign format, skipped`); continue; }
    const rows = saved.rows.map(r => classify(spec, r.phrase));
    const cnt = (rs: Row[], v: Row['verdict']) => rs.filter(r => r.verdict === v).length;
    console.log(`[replay] ${id}: COVERED ${cnt(saved.rows, 'COVERED')}→${cnt(rows, 'COVERED')}, GAP ${cnt(saved.rows, 'GAP')}→${cnt(rows, 'GAP')}, CROSS ${cnt(saved.rows, 'CROSS')}→${cnt(rows, 'CROSS')}`);
    for (const g of rows.filter(r => r.verdict === 'GAP').slice(0, 10)) console.log(`    STILL-GAP "${g.phrase}"`);
    // Corpora are the fixed regression asset — verdicts are recomputed for
    // reporting but only persisted with --save (otherwise a post-patch emit
    // would see 'no GAPs' and gut the extensions).
    if (process.argv.includes('--save')) fs.writeFileSync(file, JSON.stringify({ bankKey: spec.bankKey, rows }, null, 2));
  }
}

function report(only?: string): void {
  const ids = only ? FAMILIES.filter(f => f.id.includes(only)).map(f => f.id) : FAMILIES.map(f => f.id);
  const lines: string[] = [];
  for (const id of ids) {
    const file = `data/hardening/${id}.json`;
    if (!fs.existsSync(file)) continue;
    const spec = FAMILIES.find(f => f.id === id)!;
    const saved = JSON.parse(fs.readFileSync(file, 'utf-8')) as { rows?: Row[] };
    if (!Array.isArray(saved.rows)) continue;
    const total = saved.rows.length;
    const covered = saved.rows.filter(r => r.verdict === 'COVERED').length;
    const gap = saved.rows.filter(r => r.verdict === 'GAP').length;
    const cross = saved.rows.filter(r => r.verdict === 'CROSS').length;
    lines.push({ id, bankKey: spec.bankKey, total, covered, gap, cross });
  }
  lines.sort((a, x) => (x.gap / x.total) - (a.gap / a.total));
  console.log('FAMILY               TOTAL COVERED GAP CROSS  BANK-KEY');
  for (const l of lines) {
    console.log(`${l.id.padEnd(20)} ${String(l.total).padStart(5)} ${String(l.covered).padStart(7)} ${String(l.gap).padStart(3)} ${String(l.cross).padStart(5)}  ${l.bankKey}`);
  }
  const T = lines.reduce((s, l) => s + l.total, 0);
  const CV = lines.reduce((s, l) => s + l.covered, 0);
  const G = lines.reduce((s, l) => s + l.gap, 0);
  const X = lines.reduce((s, l) => s + l.cross, 0);
  console.log(`${''.padEnd(20)} ${String(T).padStart(5)} ${String(CV).padStart(7)} ${String(G).padStart(3)} ${String(X).padStart(5)}`);
}

async function main() {
  const cfg = loadConfig();
  const replayArg = process.argv.includes('--replay');
  const reportArg = process.argv.includes('--report');
  const passArg = process.argv.indexOf('--pass');
  const only = passArg > -1 ? process.argv[passArg + 1] : undefined;
  const bArg = process.argv.indexOf('--batches');
  const batchCount = bArg > -1 ? parseInt(process.argv[bArg + 1], 10) : 2;
  const skipExisting = process.argv.includes('--skip-existing');
  if (replayArg) { replay(only); return; }
  if (reportArg) { report(only); return; }

  fs.mkdirSync('data/hardening', { recursive: true });
  const llm = createLlmStrict(cfg);
  for (const spec of FAMILIES) {
    if (only && !new RegExp(only).test(spec.id)) continue;
    if (skipExisting && fs.existsSync(`data/hardening/${spec.id}.json`)) continue;
    process.stdout.write(`[sweep] ${spec.id} — generating…\n`);
    const rows = await runFamily(llm, spec, batchCount, loadCorpus(spec.id));
    const covered = rows.filter(r => r.verdict === 'COVERED').length;
    const gap = rows.filter(r => r.verdict === 'GAP');
    const cross = rows.filter(r => r.verdict === 'CROSS');
    fs.writeFileSync(`data/hardening/${spec.id}.json`, JSON.stringify({ bankKey: spec.bankKey, protects: spec.protects, rows }, null, 2));
    console.log(`[sweep] ${spec.id}: ${rows.length} phrases — COVERED ${covered}, GAP ${gap.length}, CROSS ${cross.length}  [${spec.bankKey}]`);
    for (const g of gap.slice(0, 10)) console.log(`    GAP  "${g.phrase}"`);
    for (const c of cross.slice(0, 4)) console.log(`    CROSS "${c.phrase}" → ${c.cross.join(',')}`);
  }
  console.log('\n[sweep] corpora in data/hardening/*.json — REPORT ONLY, nothing patched');
}

const runMain = async () => {
  // Only execute when run directly — scripts/propose-stems.ts imports FAMILIES.
  if (!process.argv[1] || !process.argv[1].includes('sweep-keys')) return;
  await main();
};
runMain().catch(e => { console.error('[sweep] fatal:', e); process.exit(1); });
