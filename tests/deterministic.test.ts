import { test } from 'node:test';
import assert from 'node:assert';
import {
  detectService, detectBedrooms, detectBudget, detectRejection,
  detectLocation, buildEvent, extractSlots, detectAgreement, detectContact,
  detectBusiness, detectHouse, detectSqm, detectVisitInterest, detectVisitTime,
  detectTimeRejection, detectWhereIs, detectOwnerVerdict,
} from '../src/llm/deterministic';

const FEED_LOCS = ['Аеродром', 'Центар', 'Центар (населба)', 'Карпош', 'Кисела Вода', 'Капиштец', 'Дебар Маало'];

test('detectService: buy vs rent, first mention wins', () => {
  assert.equal(detectService('сакам да купам стан'), 'buy');
  assert.equal(detectService('sakam da kupam stan'), 'buy');
  assert.equal(detectService('интересирана сум за изнајмување'), 'rent');
  assert.equal(detectService('pod kirija stan'), 'rent');
  assert.equal(detectService('zdravo, kako si?'), undefined);
  assert.equal(detectService('сакам да купам, не да изнајмам'), 'buy');
});

test('detectOwnerVerdict: plain-text owner answers → ok / counter / gone', () => {
  const proposed = 'утре по 18:00';
  // agreement (plain, or confirming the SAME time) -> ok
  assert.deepEqual(detectOwnerVerdict('да, може', proposed), { status: 'ok', ownerTime: proposed });
  assert.deepEqual(detectOwnerVerdict('dostapen e, utre po 18:00 e okej', proposed), { status: 'ok', ownerTime: proposed });
  assert.deepEqual(detectOwnerVerdict('во ред, го прифаќам терминот', proposed), { status: 'ok', ownerTime: proposed });
  // a positively proposed DIFFERENT time -> counter with that time
  assert.deepEqual(detectOwnerVerdict('не, само во петок во 11', proposed), { status: 'counter', ownerTime: 'Петок во 11' });
  assert.deepEqual(detectOwnerVerdict('можам само сабота попладне', proposed), { status: 'counter', ownerTime: 'Сабота попладне' });
  // can't do it, no alternative -> counter without time (client proposes another)
  assert.deepEqual(detectOwnerVerdict('не можам тогаш', proposed), { status: 'counter' });
  // gone
  assert.deepEqual(detectOwnerVerdict('продаден е', proposed), { status: 'gone', note: 'продаден' });
  assert.deepEqual(detectOwnerVerdict('веќе издаден', proposed), { status: 'gone', note: 'издаден' });
  // not understood -> undefined (Lina repeats the question)
  assert.equal(detectOwnerVerdict('kako si?', proposed), undefined);
  assert.equal(detectOwnerVerdict('blabla 123', proposed), undefined);
  // false-positive guards: "ок" inside "kako", "да" inside "дава"
  assert.equal(detectOwnerVerdict('kako si, kako okolu?', proposed), undefined);
  assert.equal(detectOwnerVerdict('давам под кирија?', proposed), undefined);
});

test('detectWhereIs: "каде е X?" is a place question, never a search', () => {
  // the exact paste: named place, Latin, with determiner
  assert.deepEqual(detectWhereIs('KADE E TOA PALOMA BJANKA ?'), { place: 'PALOMA BJANKA', generic: false });
  assert.deepEqual(detectWhereIs('каде е Кисела Вода?'), { place: 'Кисела Вода', generic: false });
  assert.deepEqual(detectWhereIs('kade se naoga toj stan ?'), { place: '', generic: true });
  assert.deepEqual(detectWhereIs('каде се наоѓа тој стан?'), { place: '', generic: true });
  assert.deepEqual(detectWhereIs('kade e stanot ?'), { place: '', generic: true });
  assert.deepEqual(detectWhereIs('каде е деловниот простор?'), { place: '', generic: true });
  assert.deepEqual(detectWhereIs('KADE ?'), { place: '', generic: true });
  // not place questions / no where-is at all
  assert.equal(detectWhereIs('до каде е цената?'), undefined);
  assert.equal(detectWhereIs('zdravo, kako si?'), undefined);
  assert.equal(detectWhereIs('каде си?'), undefined);
  assert.equal(detectWhereIs('колку чини?'), undefined);
  assert.equal(detectWhereIs('каде е?'), undefined); // no place named
  assert.equal(detectWhereIs('DALI E SEUSTE DOSTAPEN ?'), undefined); // visit-interest stays intact
});

test('detectService: "ми треба стан" without a marker is UNKNOWN — never assumed buy', () => {
  // "MI TREBA STANCE" does NOT say buy or rent — Lina must ask the intent
  // question, not claim the client wants to buy.
  assert.equal(detectService('ми треба мало станче'), undefined);
  assert.equal(detectService('MI TREBA MALO STANCE'), undefined);
  assert.equal(detectService('барам стан во Центар'), undefined);
  assert.equal(detectService('sakam stan vo Centar'), undefined);
  assert.equal(detectService('need an apartment in centar'), undefined);
  // explicit markers still win
  assert.equal(detectService('ми треба стан под кирија'), 'rent');
  assert.equal(detectService('барам стан за изнајмување'), 'rent');
  assert.equal(detectService('сакам да купам стан'), 'buy');
  assert.equal(detectService('sakam da kupam stan'), 'buy');
  // the answers to the intent question — both scripts
  assert.equal(detectService('ЗА КУПУВАЊЕ'), 'buy');
  assert.equal(detectService('ZA KUPUVANJE'), 'buy');
  assert.equal(detectService('ЗА ИЗНАЈМУВАЊЕ'), 'rent');
  assert.equal(detectService('ZA IZNAJMUVANJE'), 'rent');
  // no need/want word -> still unknown
  assert.equal(detectService('имате ли стан во Центар?'), undefined);
});

test('detectBedrooms: numbers and word forms', () => {
  assert.equal(detectBedrooms('2 spalni'), 2);
  assert.equal(detectBedrooms('двособен стан'), 2);
  assert.equal(detectBedrooms('една соба'), 1);
  assert.equal(detectBedrooms('три соби'), 3);
  assert.equal(detectBedrooms('4 sobni'), 4);
  assert.equal(detectBedrooms('zdravo'), undefined);
});

test('detectBedrooms: "мало станче"/"гарсоњера" is a 1-bedroom request (explicit wins)', () => {
  assert.equal(detectBedrooms('ми треба мало станче'), 1);
  assert.equal(detectBedrooms('MI TREBA MALO STANCE'), 1);
  assert.equal(detectBedrooms('мала гарсоњера'), 1);
  assert.equal(detectBedrooms('garsonjera'), 1);
  // an explicit bedroom mention overrides the small-word heuristic
  assert.equal(detectBedrooms('мало станче со 2 спални'), 2);
  assert.equal(detectBedrooms('zdravo'), undefined);
});

test('detectBudget: currencies, илјади, and no false positives', () => {
  assert.equal(detectBudget('do 80.000 evra'), '80000');
  assert.equal(detectBudget('до 80 000 евра'), '80000');
  assert.equal(detectBudget('80 илјади евра'), '80000');
  assert.equal(detectBudget('do 2500 евра'), '2500');
  assert.equal(detectBudget('40 KVADRATI, DO 500 EVRA'), '500'); // Latin currency + sqm side by side
  assert.equal(detectBudget('2 spalni vo Centar'), undefined);
  assert.equal(detectBudget('petok vo 18:30'), undefined);
  assert.equal(detectBudget('078/914 196'), undefined);
  assert.equal(detectBudget('godina 2025 gradba'), undefined);
  assert.equal(detectBudget('zdravo'), undefined);
});

test('detectRejection: refusal phrases', () => {
  assert.equal(detectRejection('не ми се допаѓа овој стан'), true);
  assert.equal(detectRejection('ne mi se dopaga'), true);
  assert.equal(detectRejection('сакам нешто друго'), true);
  assert.equal(detectRejection('дали е достапен 82?'), false);
});

test('detectBusiness + detectSqm: commercial spaces are identified without bedrooms', () => {
  assert.equal(detectBusiness('SAKAM DA IZNAJMAM DELOVEN PROSTOR VO KARPOS'), true);
  assert.equal(detectBusiness('барам канцеларија во Центар'), true);
  assert.equal(detectBusiness('имате ли локал за издавање?'), true);
  assert.equal(detectBusiness('магацин во Гази Баба'), true);
  assert.equal(detectBusiness('сакам стан во Карпош'), false);
  assert.equal(detectSqm('40 квадрати'), 40);
  assert.equal(detectSqm('од 105 м2'), 105);
  assert.equal(detectSqm('150 kvadrata'), 150);
  assert.equal(detectSqm('2 spalni'), undefined);
  assert.equal(detectSqm('zdravo'), undefined);
});

test('detectBusiness: дуќан/дукјан/продавница/ресторан are business — never answered as стан', () => {
  assert.equal(detectBusiness('ZDRAVO, MI TREBA DUKJAN POD KIRIJA'), true);
  assert.equal(detectBusiness('барам дуќан под кирија'), true);
  assert.equal(detectBusiness('sakam dukjan pod kirija'), true);
  assert.equal(detectBusiness('треба ми продавница'), true);
  assert.equal(detectBusiness('ресторан за изнајмување во Центар'), true);
  assert.equal(detectBusiness('sakam lokal pod kirija'), true);
});

test('detectHouse: куќа is a house — стан wins over a mixed mention', () => {
  assert.equal(detectHouse('SAKAM DA KUPAM KUKJA'), true);
  assert.equal(detectHouse('сакам да купам куќа'), true);
  assert.equal(detectHouse('барам куќа под кирија'), true);
  assert.equal(detectHouse('kukja vo VIZBEGOVO'), true);
  assert.equal(detectHouse('вила на Водно'), true);
  // an apartment word wins — "куќа или стан" stays an apartment request
  assert.equal(detectHouse('сакам куќа или стан'), false);
  assert.equal(detectHouse('SAKAM STAN'), false);
  assert.equal(detectHouse('zdravo'), false);
  assert.equal(detectHouse('деловен простор'), false);
});

test('extractSlots + buildEvent: a house request stays a house end-to-end', () => {
  const s = extractSlots('SAKAM DA KUPAM KUKJA VO VIZBEGOVO');
  assert.equal(s.service, 'buy');
  assert.equal(s.house, true);
  const ev = buildEvent('idle', s);
  assert.equal(ev.type, 'INTENT_DECLARED');
  assert.equal(ev.house, true);
  // a complete house set -> SEARCH_REQUESTED with house preserved
  const full = buildEvent('idle', { service: 'buy', house: true, location: 'Визбегово', bedrooms: 3, budget: '150000' });
  assert.equal(full.type, 'SEARCH_REQUESTED');
  assert.equal(full.house, true);
});

test('detectBusiness: an explicit стан/куќа makes business words landmarks, not the property', () => {
  assert.equal(detectBusiness('sakam stan do kafe'), false);
  assert.equal(detectBusiness('сакам стан до ресторан'), false);
  assert.equal(detectBusiness('стан со дуќан во приземје'), false);
  assert.equal(detectBusiness('куќа со локал'), false);
  // bare weak term without need-context is not a business search either
  assert.equal(detectBusiness('дали имате кафе во близина?'), false);
});

test('buildEvent: business spaces complete with sqm, not bedrooms', () => {
  const det = buildEvent('idle', { service: 'rent', location: 'Карпош', business: true, sqm: 40, budget: '500' });
  assert.equal(det.type, 'SEARCH_REQUESTED');
  assert.equal(det.business, true);
  assert.equal(det.sqm, 40);
  // business WITHOUT sqm stays DETAILS_PROVIDED
  const partial = buildEvent('idle', { service: 'rent', location: 'Карпош', business: true });
  assert.equal(partial.type, 'DETAILS_PROVIDED');
  // residential still needs bedrooms
  const res = buildEvent('idle', { service: 'rent', location: 'Карпош', bedrooms: 2, budget: '500' });
  assert.equal(res.type, 'SEARCH_REQUESTED');
});

test('detectAgreement: exits the exhausted dead-end, never misfires on questions', () => {
  assert.equal(detectAgreement('ДОБРО'), true);
  assert.equal(detectAgreement('KONTAKTIRAJ ME'), true);
  assert.equal(detectAgreement('во ред'), true);
  assert.equal(detectAgreement('ok'), true);
  assert.equal(detectAgreement('дали е достапен 82?'), false); // "да" inside "дали"
  assert.equal(detectAgreement('STO IMAS VO KARPOS ?'), false);
  assert.equal(detectAgreement('НЕ САКАМ'), false);
});

test('detectVisitInterest: "кога може да се погледне" / "дали е достапен" / "сакам да ја видам" are visit interest', () => {
  assert.equal(detectVisitInterest('KOGA BI MOZELO DA SE POGLEDNE STANOT ?'), true);
  assert.equal(detectVisitInterest('Кога би можело да се погледне станот?'), true);
  assert.equal(detectVisitInterest('DALI E SEUSTE DOSTAPEN ?'), true);
  assert.equal(detectVisitInterest('Дали е достапен имотот?'), true);
  assert.equal(detectVisitInterest('Sakam da ja vidam 78'), true);
  assert.equal(detectVisitInterest('сакам да ја видам'), true);
  assert.equal(detectVisitInterest('organizirajte poseta'), true);
  assert.equal(detectVisitInterest('да, сакам да организираме посета'), true);
  // the bare "договори ми" / "закажи ми" imperatives are visit interest too
  assert.equal(detectVisitInterest('DOGOVORI MI ZA OVOJ SO BROJ 89'), true);
  assert.equal(detectVisitInterest('договори ми посета'), true);
  assert.equal(detectVisitInterest('договори посета'), true);
  assert.equal(detectVisitInterest('dogovori mi ja za 89'), true);
  assert.equal(detectVisitInterest('ЗАКАЖИ МИ'), true);
  // the noun "договор" / "договориме" are NOT visit commands
  assert.equal(detectVisitInterest('договор за кирија'), false);
  assert.equal(detectVisitInterest('можеме да се договориме'), false);
  // negation keeps rejection out
  assert.equal(detectVisitInterest('NE SAKAM DA JA VIDAM'), false);
  assert.equal(detectVisitInterest('не сакам да ја видам'), false);
  // unrelated chat is NOT visit interest
  assert.equal(detectVisitInterest('zdravo, kako si?'), false);
  assert.equal(detectVisitInterest('STO IMAS VO KARPOS ?'), false);
  assert.equal(detectVisitInterest('дај ми цена'), false);
});

test('detectVisitTime: a proposed time is recognized without any LLM', () => {
  assert.equal(detectVisitTime('UTRE NAPLADNE'), 'UTRE NAPLADNE');
  assert.equal(detectVisitTime('утре на пладне'), 'утре на пладне');
  assert.equal(detectVisitTime('Pozdravi, mozam utre popladne posle 6'), 'Pozdravi, mozam utre popladne posle 6');
  assert.equal(detectVisitTime('сабота попладне'), 'сабота попладне');
  assert.equal(detectVisitTime('petok vo 17:30'), 'petok vo 17:30');
  assert.equal(detectVisitTime('zdravo'), undefined);
  assert.equal(detectVisitTime('STO IMAS VO KARPOS ?'), undefined);
});

test('detectTimeRejection: the client can\'t do the proposed time — never a new proposal', () => {
  // rejection of the CURRENT proposal, both scripts
  assert.equal(detectTimeRejection('NE MOZAM VO 18:00 DALI MOZE POKASNO'), true);
  assert.equal(detectTimeRejection('не можам во 18:00'), true);
  assert.equal(detectTimeRejection('ne mozam utre'), true);
  assert.equal(detectTimeRejection('дали може покасно'), true);
  assert.equal(detectTimeRejection('подоцна не ми одговара'), true);
  assert.equal(detectTimeRejection('не ми е згодно тогаш'), true);
  // a NEW concrete time is NOT a rejection
  assert.equal(detectTimeRejection('MOZAM VO 19:00'), false);
  assert.equal(detectTimeRejection('утре попладне'), false);
  assert.equal(detectTimeRejection('zdravo'), false);
});

test('detectContact: name+phone intake without any LLM', () => {
  assert.deepEqual(detectContact('ZORAN 078/914 196'), { name: 'Zoran', phone: '078914196' });
  assert.deepEqual(detectContact('Моето име е Зоран Петровски, тел 078 914 196'),
    { name: 'Зоран Петровски', phone: '078914196' });
  assert.deepEqual(detectContact('078 914 196'), { name: undefined, phone: '078914196' });
  // no number in the message — the name only (the number comes from the Viber id)
  assert.deepEqual(detectContact('GORAN MOZE NA OVOJ BROJ'), { name: 'Goran', phone: undefined });
  assert.deepEqual(detectContact('zdravo, kako si?'), { name: undefined, phone: undefined });
});

test('detectLocation: Latin and Cyrillic spellings match feed neighborhoods', () => {
  assert.equal(detectLocation('sakam stan vo centar, 2 spalni', FEED_LOCS), 'Центар');
  assert.equal(detectLocation('сакам во Центар', FEED_LOCS), 'Центар');
  assert.equal(detectLocation('nešto vo Kisela Voda', FEED_LOCS), 'Кисела Вода');
  assert.equal(detectLocation('vo Debar Maalo', FEED_LOCS), 'Дебар Маало');
  assert.equal(detectLocation('shto imate vo kapistec?', FEED_LOCS), 'Капиштец');
  assert.equal(detectLocation('nešto vo Drachevo', FEED_LOCS), undefined);
  assert.equal(detectLocation('zdravo', FEED_LOCS), undefined);
});

test('buildEvent: full criteria set -> SEARCH_REQUESTED', () => {
  const ev = buildEvent('idle', { service: 'buy', location: 'Центар', bedrooms: 2, budget: '80000' });
  assert.equal(ev.type, 'SEARCH_REQUESTED');
  assert.equal(ev.service, 'buy');
  assert.equal(ev.location, 'Центар');
  assert.equal(ev.bedrooms, 2);
  assert.equal(ev.budget, '80000');
});

test('buildEvent: service alone -> INTENT_DECLARED, partial -> DETAILS_PROVIDED', () => {
  assert.equal(buildEvent('idle', { service: 'rent' }).type, 'INTENT_DECLARED');
  assert.equal(buildEvent('idle', { bedrooms: 2, budget: '80000' }).type, 'DETAILS_PROVIDED');
  assert.equal(buildEvent('idle', { location: 'Центар' }).type, 'DETAILS_PROVIDED');
});

test('buildEvent: REJECTED only against shown offers, carries new area', () => {
  const ev = buildEvent('presentation', { rejected: true, location: 'Кисела Вода' });
  assert.equal(ev.type, 'REJECTED');
  assert.equal(ev.location, 'Кисела Вода');
  // Rejection from discovery is meaningless — stays STAY
  assert.equal(buildEvent('discovery', { rejected: true }).type, 'STAY');
});

test('buildEvent: nothing detected -> STAY', () => {
  assert.equal(buildEvent('idle', {}).type, 'STAY');
});

test('extractSlots: full LLM-free intake from a single Latin message', () => {
  const s = extractSlots('sakam da kupam stan vo Centar, 2 spalni, do 80.000 evra');
  assert.equal(s.service, 'buy');
  assert.equal(s.bedrooms, 2);
  assert.equal(s.budget, '80000');
  assert.equal(s.rejected, undefined);
});

test('GORAN scenario: "ми треба станче" without a marker stays UNKNOWN — discovery asks intent, never claims buy', () => {
  const s = extractSlots('ZDRAVO, MI TREBA MALO STANCE VO CENTAR ILI KISELA VODA');
  assert.equal(s.service, undefined); // no buy assumption
  assert.equal(s.bedrooms, 1);
  const ev = buildEvent('idle', { ...s, location: 'Центар' });
  assert.equal(ev.type, 'DETAILS_PROVIDED');
  assert.equal(ev.service, undefined);
  assert.equal(ev.location, 'Центар');
  assert.equal(ev.bedrooms, 1);
  // once the client ANSWERS the intent question and the budget lands, the set
  // is complete -> straight to presentation
  const full = buildEvent('idle', { service: 'buy', location: 'Центар', bedrooms: 1, budget: '50000' });
  assert.equal(full.type, 'SEARCH_REQUESTED');
});
