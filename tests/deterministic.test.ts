import { test } from 'node:test';
import assert from 'node:assert';
import {
  detectService, detectBedrooms, detectBudget, detectRejection,
  detectLocation, buildEvent, extractSlots, detectAgreement, detectWidenIntent,
  detectContact, detectBusiness, detectHouse, detectSqm, detectVisitInterest,
  detectVisitTime, detectTimeRejection, detectWhereIs, detectOwnerVerdict,
  detectApartmentNeed, detectSeenProperty, detectLocatePick, detectSeeOffers,
  detectAvailabilityAsk, detectFeeWhy, detectExactAddressAsk, detectAnywhere,
  detectSuggestAlternatives,
  isPlausibleName, isValidPhone, isValidVisitTime,
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

test('detectService: the "krija" typo (missing i) is still rent — the funnel never re-asks buy/rent', () => {
  // the exact client message from the TUI: "mi treba stan pod krija"
  assert.equal(detectService('mi treba stan pod krija'), 'rent');
  assert.equal(detectService('pod krija stan'), 'rent');
  assert.equal(detectService('барам стан под кирја'), 'rent');
  assert.equal(detectService('pod kirija stan'), 'rent');
  assert.equal(detectService('zdravo'), undefined);
});

test('detectService: the "kupan" typo (m→n) is still buy — no re-ask of the intent question', () => {
  // the exact TUI message: "sakam da kupan stance vo Aerodrom"
  assert.equal(detectService('sakam da kupan stance vo Aerodrom'), 'buy');
  assert.equal(detectService('sakam da kupan'), 'buy');
  assert.equal(detectService('da kupam'), 'buy');
  assert.equal(detectService('zdravo'), undefined);
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
  // THE refusal phrasing from the field: "nema da mozam" / "нема да можам"
  // (I won't be able to) — the bare "mozam" inside it must NEVER be read as
  // agreement (that closed the deal on a refusal). A refusal with a concrete
  // alternative is a COUNTER with that time ("утре во 16:00" — the day NEAREST
  // the clock, not the refused "денес"); a bare refusal is a plain counter.
  assert.deepEqual(detectOwnerVerdict('denes nema da mozam. utre vo 16:00 ?', 'deneska vo 18:00'),
    { status: 'counter', ownerTime: 'Утре во 16:00' });
  assert.deepEqual(detectOwnerVerdict('денес нема да можам, утре во 16:00', 'денеска во 18:00'),
    { status: 'counter', ownerTime: 'Утре во 16:00' });
  assert.deepEqual(detectOwnerVerdict('nema da mozam', proposed), { status: 'counter' });
  assert.deepEqual(detectOwnerVerdict('denes nema da mozam', proposed), { status: 'counter' });
  assert.deepEqual(detectOwnerVerdict('нема да можам', proposed), { status: 'counter' });
  assert.deepEqual(detectOwnerVerdict('ne mozam denes, utre vo 16:00 mozam', 'deneska vo 18:00'),
    { status: 'counter', ownerTime: 'Утре во 16:00' });
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

test('detectOwnerVerdict: the owner dictates a NEW price — it rides the verdict', () => {
  const proposed = 'утре по 18:00';
  // Cyrillic + Latin, with and without currency word
  assert.deepEqual(detectOwnerVerdict('да, ама цената е 60.000 евра', proposed),
    { status: 'ok', ownerTime: proposed, price: 60000 });
  assert.deepEqual(detectOwnerVerdict('dostapen e, no cenata e 60000', proposed),
    { status: 'ok', ownerTime: proposed, price: 60000 });
  assert.deepEqual(detectOwnerVerdict('да, може, ама по 60 илјади евра', proposed),
    { status: 'ok', ownerTime: proposed, price: 60000 });
  // a counter with a new price
  assert.deepEqual(detectOwnerVerdict('само петок, а цената е 65000 евра', proposed),
    { status: 'counter', ownerTime: 'Петок', price: 65000 });
  // no price mentioned -> no price field (deepEqual must stay exact)
  assert.deepEqual(detectOwnerVerdict('да, може', proposed), { status: 'ok', ownerTime: proposed });
  // a bare clock / no currency is NOT a price
  assert.equal(detectOwnerVerdict('да, утре во 11', proposed)?.price, undefined);
});

test('detectAvailabilityAsk: "дали е сеуште достапен?" — the client asks availability of a known property', () => {
  // Cyrillic + Latin, several phrasings
  assert.equal(detectAvailabilityAsk('дали е сеуште достапен?'), true);
  assert.equal(detectAvailabilityAsk('dali e seuste dostapen?'), true);
  assert.equal(detectAvailabilityAsk('дали е достапен?'), true);
  assert.equal(detectAvailabilityAsk('DALI E SEUSTE DOSTAPEN ?'), true);
  assert.equal(detectAvailabilityAsk('дали го имате уште?'), true);
  assert.equal(detectAvailabilityAsk('dali go imate uste?'), true);
  assert.equal(detectAvailabilityAsk('го имате ли уште?'), true);
  assert.equal(detectAvailabilityAsk('go imate li uste?'), true);
  assert.equal(detectAvailabilityAsk('дали е продаден?'), true);
  assert.equal(detectAvailabilityAsk('сеуште ли е на продажба?'), true);
  assert.equal(detectAvailabilityAsk('дали е достапен 82?'), true); // number supplies the EB
  assert.equal(detectAvailabilityAsk('Dail e dostapen seuste ?'), true); // transposed l/i typo
  assert.equal(detectAvailabilityAsk('DAIL E SEUSTE DOSTAPEN ?'), true); // same typo uppercase
  // NOT availability asks — visit interest, searches, greetings stay untouched
  assert.equal(detectAvailabilityAsk('KOGA BI MOZELO DA SE POGLEDNE STANOT ?'), false);
  assert.equal(detectAvailabilityAsk('сакам да ја видам 78'), false);
  assert.equal(detectAvailabilityAsk('zdravo, kako si?'), false);
  assert.equal(detectAvailabilityAsk('STO IMAS VO KARPOS ?'), false);
  assert.equal(detectAvailabilityAsk('сакам стан во Центар'), false);
  assert.equal(detectAvailabilityAsk('да, се согласувам'), false);
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
  // "каде е?" / "каде се наоѓа?" — no place named, means the last shown property
  assert.deepEqual(detectWhereIs('каде е?'), { place: '', generic: true });
  assert.deepEqual(detectWhereIs('каде се наоѓа?'), { place: '', generic: true });
  assert.deepEqual(detectWhereIs('kade se naogja?'), { place: '', generic: true });
  assert.equal(detectWhereIs('DALI E SEUSTE DOSTAPEN ?'), undefined); // visit-interest stays intact
});

test('detectExactAddressAsk: exact-address questions get the privacy answer, not a landmark', () => {
  // the user's exact phrasings, both scripts
  assert.equal(detectExactAddressAsk('potocno koja ulica ?'), true);
  assert.equal(detectExactAddressAsk('tocno koja adresa'), true);
  assert.equal(detectExactAddressAsk('точно која адреса?'), true);
  assert.equal(detectExactAddressAsk('поточно која улица?'), true);
  assert.equal(detectExactAddressAsk('потoчно која улица'), true);
  assert.equal(detectExactAddressAsk('на која адреса е?'), true);
  assert.equal(detectExactAddressAsk('na koja adresa e ?'), true);
  assert.equal(detectExactAddressAsk('каде е точната адреса?'), true);
  assert.equal(detectExactAddressAsk('kade e tocnata lokacija ?'), true);
  assert.equal(detectExactAddressAsk('каде точно?'), true);
  assert.equal(detectExactAddressAsk('kade tocno ?'), true);
  assert.equal(detectExactAddressAsk('кажи ми ја адресата'), true);
  // NOT exact-address asks — regular where-is and ordinary traffic stay intact
  assert.equal(detectExactAddressAsk('каде е Палома Бјанка?'), false);
  assert.equal(detectExactAddressAsk('kade se naoga toj stan ?'), false);
  assert.equal(detectExactAddressAsk('каде е станот?'), false);
  assert.equal(detectExactAddressAsk('zdravo, kako si?'), false);
  assert.equal(detectExactAddressAsk('колку чини?'), false);
  // insistence patterns — "moram da znam kade e" / "za da se odlucam"
  assert.equal(detectExactAddressAsk('moram da znam kade e'), true);
  assert.equal(detectExactAddressAsk('moram da znam kade e, za da se odlucam'), true);
  assert.equal(detectExactAddressAsk('moram da znam kade e za da se odlucam'), true);
  assert.equal(detectExactAddressAsk('treba da znam kade e'), true);
  assert.equal(detectExactAddressAsk('moram da znam kade se naogja'), true);
  assert.equal(detectExactAddressAsk('mora da znam kade e'), true);
  assert.equal(detectExactAddressAsk('морам да знам каде е'), true);
  assert.equal(detectExactAddressAsk('треба да знам каде е'), true);
  assert.equal(detectExactAddressAsk('за да се одлучам'), true);
  assert.equal(detectExactAddressAsk('za da se odlucam'), true);
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

test('detectBedrooms: "спални" word forms count — "DVE SPALNI" is 2 (the transcript gap)', () => {
  assert.equal(detectBedrooms('DVE SPALNI ОБАВЕЗНО А МОЖЕ И ТРИ'), 2);
  assert.equal(detectBedrooms('dve spalni'), 2);
  assert.equal(detectBedrooms('две спални'), 2);
  assert.equal(detectBedrooms('три спални'), 3);
  assert.equal(detectBedrooms('една спална'), 1);
  assert.equal(detectBedrooms('четири спални'), 4);
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

test('detectBudget: a cap word (до/околу/под) marks a price even WITHOUT currency — "bilo kade do 250"', () => {
  // The rent budget "250" has no currency word — the cap word "до" makes it a
  // price, never an Евидентен број. Cyrillic AND Latin cap words (JS \b never
  // binds around Cyrillic, so the Unicode-aware lookbehind is what makes
  // "каде до 250" match).
  assert.equal(detectBudget('bilo kade do 250'), '250');
  assert.equal(detectBudget('bilo kade до 250'), '250');
  assert.equal(detectBudget('околу 250'), '250');
  assert.equal(detectBudget('pod 250'), '250');
  assert.equal(detectBudget('okolu 250'), '250');
  // sanity floor: "до 3 соби" is a bedroom count, never a 3€ budget
  assert.equal(detectBudget('до 3 соби'), undefined);
  assert.equal(detectBudget('do 3 sobi'), undefined);
  // a bare small number (no cap word) is still NOT a budget — "sifra 62"
  // stays an Евидентен број reference, not a 62€ price
  assert.equal(detectBudget('sifra 62'), undefined);
  assert.equal(detectBudget('bilo kade 250'), undefined);
});

test('detectSuggestAlternatives: "predlozi mi" / "drugi lokaciii" ask for alternatives, not a repeat', () => {
  assert.equal(detectSuggestAlternatives('predlozi mi'), true);
  assert.equal(detectSuggestAlternatives('предложи ми'), true);
  assert.equal(detectSuggestAlternatives('drugi lokaciii'), true);
  assert.equal(detectSuggestAlternatives('други локации'), true);
  assert.equal(detectSuggestAlternatives('da, predlozi mi nesto drugo'), true);
  assert.equal(detectSuggestAlternatives('pokazi drugi opcii'), true);
  // an EB query or a location search is NOT an alternatives request
  assert.equal(detectSuggestAlternatives('sifra 62'), false);
  assert.equal(detectSuggestAlternatives('kolkava e cenata za 78?'), false);
  assert.equal(detectSuggestAlternatives('zdravo'), false);
});

test('detectAnywhere: "bilo kade" means no location preference', () => {
  assert.equal(detectAnywhere('pa bilo kade'), true);
  assert.equal(detectAnywhere('bilo kade do 250'), true);
  assert.equal(detectAnywhere('било каде'), true);
  assert.equal(detectAnywhere('каде било'), true);
  assert.equal(detectAnywhere('kade bilo'), true);
  assert.equal(detectAnywhere('anywhere'), true);
  assert.equal(detectAnywhere('секаде'), true);
  // a where-is question is NOT anywhere
  assert.equal(detectAnywhere('каде е Палома Бјанка?'), false);
  assert.equal(detectAnywhere('vo karpos'), false);
});

test('detectRejection: refusal phrases', () => {
  assert.equal(detectRejection('не ми се допаѓа овој стан'), true);
  assert.equal(detectRejection('ne mi se dopaga'), true);
  assert.equal(detectRejection('сакам нешто друго'), true);
  assert.equal(detectRejection('дали е достапен 82?'), false);
  // "ne baram stan"-style type denials
  assert.equal(detectRejection('не барам стан'), true);
  assert.equal(detectRejection('ne baram stan'), true);
  assert.equal(detectRejection('не сакам стан'), true);
  assert.equal(detectRejection('не ми треба стан'), true);
  assert.equal(detectRejection('не ме интересира стан'), true);
  assert.equal(detectRejection('друго'), false); // standalone 'drugo' = 'different', not a rejection
  assert.equal(detectRejection('drugo nesto vo Aerodrom'), false); // search refinement, not rejection
  // a NEW direction is NOT a denial
  assert.equal(detectRejection('барам куќа'), false);
  assert.equal(detectRejection('сакам стан'), false);
  assert.equal(detectRejection('ми треба стан'), false);
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

test('detectHouse: куќа is a house — стан wins over a mixed mention, NO type word is undefined', () => {
  assert.equal(detectHouse('SAKAM DA KUPAM KUKJA'), true);
  assert.equal(detectHouse('сакам да купам куќа'), true);
  assert.equal(detectHouse('барам куќа под кирија'), true);
  assert.equal(detectHouse('kukja vo VIZBEGOVO'), true);
  assert.equal(detectHouse('вила на Водно'), true);
  // an apartment word wins — "куќа или стан" stays an apartment request
  assert.equal(detectHouse('сакам куќа или стан'), false);
  assert.equal(detectHouse('SAKAM STAN'), false);
  // NO property-type word -> undefined: a detail message ("DVE SPALNI…") must
  // never clobber an established куќа funnel into a стан search
  assert.equal(detectHouse('zdravo'), undefined);
  assert.equal(detectHouse('деловен простор'), undefined);
  assert.equal(detectHouse('DVE SPALNI OBAVEZNO'), undefined);
  assert.equal(detectHouse('DO 100.000'), undefined);
});

test('detectApartmentNeed: a bare place-need starts the funnel, negation does not', () => {
  assert.equal(detectApartmentNeed('ми треба стан'), true);
  assert.equal(detectApartmentNeed('MI TREBA STANCE'), true);
  assert.equal(detectApartmentNeed('ми треба мало станче'), true);
  assert.equal(detectApartmentNeed('барам стан во Центар'), true);
  assert.equal(detectApartmentNeed('SAKAM STAN'), true);
  assert.equal(detectApartmentNeed('ми треба куќа'), true);
  // negation is NOT a need
  assert.equal(detectApartmentNeed('не сакам стан'), false);
  assert.equal(detectApartmentNeed('NE SAKAM STAN'), false);
  // no place word -> not a need
  assert.equal(detectApartmentNeed('zdravo'), false);
  assert.equal(detectApartmentNeed('како си?'), false);
});

test('buildEvent: a bare "ми треба стан" routes idle -> discovery (INTENT_DECLARED, no service)', () => {
  const s = extractSlots('MI TREBA STANCE');
  assert.equal(s.service, undefined);
  assert.equal(s.need, true);
  const ev = buildEvent('idle', s);
  assert.equal(ev.type, 'INTENT_DECLARED');
  assert.equal(ev.service, undefined); // never an assumed buy
  // negated need is a DENIAL -> REJECTED (the handler pivots: what DO you want)
  const neg = extractSlots('NE SAKAM STAN');
  assert.equal(buildEvent('idle', neg).type, 'REJECTED');
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
  // 'moze' as a criteria modifier ('can be bigger'), NOT agreement
  assert.equal(detectAgreement('moze i pogolem'), false);
  assert.equal(detectAgreement('moze 2 spalni'), false);
  assert.equal(detectAgreement('moze i poevtino'), false);
  assert.equal(detectAgreement('moze i pomalku'), false);
  assert.equal(detectAgreement('може поголем'), false);
  // 'moze' alone or with 'da' IS agreement
  assert.equal(detectAgreement('moze'), true);
  assert.equal(detectAgreement('moze da'), true);
  assert.equal(detectAgreement('може'), true);
  assert.equal(detectAgreement('може да'), true);
});

test('detectVisitInterest: "кога може да се погледне" / "дали е достапен" / "сакам да ја видам" are visit interest', () => {
  assert.equal(detectVisitInterest('KOGA BI MOZELO DA SE POGLEDNE STANOT ?'), true);
  assert.equal(detectVisitInterest('Кога би можело да се погледне станот?'), true);
  assert.equal(detectVisitInterest('DALI E SEUSTE DOSTAPEN ?'), true);
  assert.equal(detectVisitInterest('Dail e dostapen seuste ?'), true); // transposed l/i typo
  assert.equal(detectVisitInterest('Дали е достапен имотот?'), true);
  assert.equal(detectVisitInterest('Sakam da ja vidam 78'), true);
  assert.equal(detectVisitInterest('сакам да ја видам'), true);
  assert.equal(detectVisitInterest('organizirajte poseta'), true);
  assert.equal(detectVisitInterest('organiziraj'), true);
  assert.equal(detectVisitInterest('организирај'), true);
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
  assert.equal(detectVisitTime('OKOLU 18:00 ?'), 'OKOLU 18:00 ?'); // Latin okolu
  assert.equal(detectVisitTime('околу 18:00'), 'околу 18:00'); // Cyrillic околу
  assert.equal(detectVisitTime('zdravo'), undefined);
  assert.equal(detectVisitTime('STO IMAS VO KARPOS ?'), undefined);
});

test('detectFeeWhy: "зошто наплаќате посета?" is a why-question, never a refusal', () => {
  // the exact live transcript questions, Cyrillic + Latin
  assert.equal(detectFeeWhy('zosto naplatuvate poseta ?'), true);
  assert.equal(detectFeeWhy('зошто наплаќате посета?'), true);
  assert.equal(detectFeeWhy('ЗОШТО НАПЛАЌАТЕ ПОСЕТА ?'), true);
  assert.equal(detectFeeWhy('зошто надомест?'), true);
  assert.equal(detectFeeWhy('зошто се наплаќа посетата?'), true);
  assert.equal(detectFeeWhy('зашто треба да платам 500 денари?'), true);
  assert.equal(detectFeeWhy('зошто да плаќам?'), true);
  assert.equal(detectFeeWhy('nikoj ne go pravi toa'), true);
  assert.equal(detectFeeWhy('никој не го прави тоа'), true);
  assert.equal(detectFeeWhy('никому не наплаќаат посета'), true);
  // the "како тоа?" form — the exact live transcript that was misread as
  // agreement (the bare "da" in "da platam") and closed the deal
  assert.equal(detectFeeWhy('KAKO TOA ? DA PLATAM ZA POSETA ?'), true);
  assert.equal(detectFeeWhy('како тоа, ќе плаќам за посета?'), true);
  assert.equal(detectFeeWhy('kako da plakjam?'), true);
  assert.equal(detectFeeWhy('kako toa, pa se plakja nadomest?'), true);
  // "prv pat slusam" disbelief — the client expresses surprise about the
  // fee, not a direct "why" question. Functionally a fee-why: Lina must
  // explain the rationale (fee.why) or pivot to other neighborhoods.
  assert.equal(detectFeeWhy('prv pat slusam da se naplatuva poseta'), true);
  assert.equal(detectFeeWhy('PRV PAT SLUSAM DA SE NAPLATUVA POSETA'), true);
  assert.equal(detectFeeWhy('првпат слушам дека се наплаќа посетата'), true);
  assert.equal(detectFeeWhy('prv pat cuvam za toa'), true);
  // NOT why-fee questions: property-price asks, refusals, agreement, small talk
  assert.equal(detectFeeWhy('зошто е цената 68.000 евра?'), false);
  assert.equal(detectFeeWhy('kako e organizirana posetata?'), false); // logistics, not the fee
  assert.equal(detectFeeWhy('kako se plakja kirijata'), false); // rent payment, not the fee
  assert.equal(detectFeeWhy('зошто е скап станот?'), false);
  assert.equal(detectFeeWhy('не сакам да платам'), false);
  assert.equal(detectFeeWhy('без надомест'), false);
  assert.equal(detectFeeWhy('да, се согласувам'), false);
  assert.equal(detectFeeWhy('zdravo, kako si?'), false);
  assert.equal(detectFeeWhy('KOGA BI MOZELO DA SE POGLEDNE STANOT ?'), false);
});

test('detectSeeOffers: mid-discovery "што имате во понуда?" is a see-offers ask', () => {
  assert.equal(detectSeeOffers('што имате во понуда?'), true);
  assert.equal(detectSeeOffers('sto imate vo ponuda?'), true);
  assert.equal(detectSeeOffers('sto imate na ponuda?'), true);
  assert.equal(detectSeeOffers('што имате на понуда?'), true);
  assert.equal(detectSeeOffers('sto imate?'), true);
  assert.equal(detectSeeOffers('што имаш?'), true);
  assert.equal(detectSeeOffers('помало нешто'), true);
  assert.equal(detectSeeOffers('pomalo nesto'), true);
  assert.equal(detectSeeOffers('покажи ми'), true);
  assert.equal(detectSeeOffers('имате ли нешто'), true);
  // a location search is NOT a see-offers ask (the text after имаш breaks it)
  assert.equal(detectSeeOffers('што имаш во Карпош?'), false);
  assert.equal(detectSeeOffers('sto imas vo karpos?'), false);
  // ordinary messages are not see-offers
  assert.equal(detectSeeOffers('zdravo'), false);
  assert.equal(detectSeeOffers('ми треба стан'), false);
  assert.equal(detectSeeOffers('колку чини?'), false);
});

test('detectTimeRejection: the client can\'t do the proposed time — never a new proposal', () => {
  // rejection of the CURRENT proposal, both scripts
  assert.equal(detectTimeRejection('NE MOZAM VO 18:00 DALI MOZE POKASNO'), true);
  assert.equal(detectTimeRejection('NE MOZAM TOGAS'), true); // Latin, common live pattern
  assert.equal(detectTimeRejection('не можам во 18:00'), true);
  assert.equal(detectTimeRejection('ne mozam utre'), true);
  assert.equal(detectTimeRejection('дали може покасно'), true);
  assert.equal(detectTimeRejection('подоцна не ми одговара'), true);
  assert.equal(detectTimeRejection('не ми е згодно тогаш'), true);
  // the "won't be able to" refusal (nema da mozam / нема да можам) is a
  // rejection too — otherwise the owner's refusal text typed during
  // owner_checking is misread as a NEW visit time and stored as garbage.
  assert.equal(detectTimeRejection('denes nema da mozam. utre vo 16:00 ?'), true);
  assert.equal(detectTimeRejection('денес нема да можам'), true);
  assert.equal(detectTimeRejection('nema da mozam'), true);
  // a NEW concrete time is NOT a rejection
  assert.equal(detectTimeRejection('MOZAM VO 19:00'), false);
  assert.equal(detectTimeRejection('утре попладне'), false);
  assert.equal(detectTimeRejection('zdravo'), false);
});

test('detectSeenProperty: a specific seen property without a number is NOT a fresh search', () => {
  // the exact live cases from the funnel log
  assert.equal(detectSeenProperty('dobar den. go gledav oglasot za stan vo karpos na internet. dali go imate uste ?'), true);
  assert.equal(detectSeenProperty('go vidov stanot.'), true);
  assert.equal(detectSeenProperty('go sakam toj konkreten stan.'), true);
  assert.equal(detectSeenProperty('moze da mi kazete koj stan bese ?'), true);
  assert.equal(detectSeenProperty('ГО ГЛЕДАВ ОГЛАСОТ ЗА СТАН ВО КАРПОШ'), true);
  assert.equal(detectSeenProperty('gledav oglas za stan na internet'), true);
  // a fresh search is NOT a seen property
  assert.equal(detectSeenProperty('SAKAM DA KUPAM STAN VO KARPOS'), false);
  assert.equal(detectSeenProperty('MI TREBA STAN VO CENTAR'), false);
  assert.equal(detectSeenProperty('zdravo, imate li stanovi vo aerodrom'), false);
});

test('detectLocatePick: position picks among presented matches (првиот/вториот)', () => {
  assert.equal(detectLocatePick('да, првиот е тој'), 0);
  assert.equal(detectLocatePick('PRVIOT'), 0);
  assert.equal(detectLocatePick('вториот'), 1);
  assert.equal(detectLocatePick('втората'), 1);
  assert.equal(detectLocatePick('да, го знам'), undefined);
  assert.equal(detectLocatePick('не е тој'), undefined);
  assert.equal(detectLocatePick('zdravo'), undefined);
});

test('detectSqm: word-form sizes (триесетина квадрати ≈ 30 м²)', () => {
  assert.equal(detectSqm('триесетина квадрати некаде'), 30);
  assert.equal(detectSqm('околу педесет квадрати'), 50);
  assert.equal(detectSqm('triesetina kvadrati'), 30);
  assert.equal(detectSqm('стотина квадрати'), 100);
  assert.equal(detectSqm('2 спални'), undefined);
  assert.equal(detectSqm('zdravo'), undefined);
});

test('isPlausibleName: real names pass, LLM sentence-garbage is rejected', () => {
  assert.equal(isPlausibleName('Горан Петровски'), true);
  assert.equal(isPlausibleName('Zoran'), true);
  assert.equal(isPlausibleName('Ангела'), true);
  // the LLM sometimes fills the name field with garbage — never stored
  assert.equal(isPlausibleName('кукја пофтина'), false);
  assert.equal(isPlausibleName('кукја пофтина евра'), false);
  assert.equal(isPlausibleName('може на овој број'), false);
  assert.equal(isPlausibleName('да'), false);
  assert.equal(isPlausibleName('Горан Петровски 078914196'), false); // phone inside
  assert.equal(isPlausibleName(''), false);
});

test('isValidPhone: digits-only 7-15 after stripping separators', () => {
  assert.equal(isValidPhone('078914196'), true);
  assert.equal(isValidPhone('078/914 196'), true);
  assert.equal(isValidPhone('070 123 456'), true);
  assert.equal(isValidPhone('38970123456789'), true);
  // garbage / too short
  assert.equal(isValidPhone('кукја пофтина'), false);
  assert.equal(isValidPhone('123'), false);
  assert.equal(isValidPhone(''), false);
});

test('isValidVisitTime: real times pass (incl. bare HH:MM), garbage rejected', () => {
  assert.equal(isValidVisitTime('19:00'), true);
  assert.equal(isValidVisitTime('17:30'), true);
  assert.equal(isValidVisitTime('петок во 17:30'), true);
  assert.equal(isValidVisitTime('утре на пладне'), true);
  assert.equal(isValidVisitTime('после 6'), true);
  assert.equal(isValidVisitTime('кукја пофтина'), false);
  assert.equal(isValidVisitTime('да'), false);
  assert.equal(isValidVisitTime(''), false);
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
  // 'Центар (населба)' is the canonical feed form — the bare 'Центар' row is
  // deduped as subsumed, so the SPECIFIC name wins.
  assert.equal(detectLocation('sakam stan vo centar, 2 spalni', FEED_LOCS), 'Центар (населба)');
  assert.equal(detectLocation('сакам во Центар', FEED_LOCS), 'Центар (населба)');
  assert.equal(detectLocation('nešto vo Kisela Voda', FEED_LOCS), 'Кисела Вода');
  assert.equal(detectLocation('vo Debar Maalo', FEED_LOCS), 'Дебар Маало');
  assert.equal(detectLocation('shto imate vo kapistec?', FEED_LOCS), 'Капиштец');
  // a place that is not a Skopje neighborhood stays unknown
  assert.equal(detectLocation('nešto vo Nepostoechko', FEED_LOCS), undefined);
  assert.equal(detectLocation('zdravo', FEED_LOCS), undefined);
});

test('detectLocation: known neighborhoods are recognized even with an EMPTY feed (no location loop)', () => {
  // The feed was unreachable in the TUI session — locations() returned [] and
  // "karpos"/"centar" never matched, so Lina re-asked the location question
  // forever. The known-neighborhood fallback must break that loop.
  assert.equal(detectLocation('karpos', []), 'Карпош III');
  assert.equal(detectLocation('centar', []), 'Центар (населба)');
  assert.equal(detectLocation('ti kazav karpos', []), 'Карпош III');
  assert.equal(detectLocation('kisela voda', []), 'Кисела Вода');
  assert.equal(detectLocation('zdravo', []), undefined);
  assert.equal(detectLocation('нешто во Непостоечко', []), undefined);
});

test('detectLocation: a comma-separated LIST captures ALL named areas', () => {
  // "pa moze centar, kisela voda, aerodrom" (the Влае-spill transcript): every
  // named neighborhood is captured, so presentations stay inside the union.
  const got = detectLocation('pa moze centar, kisela voda, aerodrom', FEED_LOCS);
  assert.ok(got?.includes('Центар (населба)'), got);
  assert.ok(got?.includes('Кисела Вода'), got);
  assert.ok(got?.includes('Аеродром'), got);
  // overlapping feed names are deduped — never "Центар (населба), …, Центар"
  assert.equal(got, 'Центар (населба), Кисела Вода, Аеродром');
});

test('detectWidenIntent: pure agreement widens; register/contact intents do NOT', () => {
  assert.equal(detectWidenIntent('DOBRO'), true);
  assert.equal(detectWidenIntent('да, покажи друго'), true);
  assert.equal(detectWidenIntent('moze, drugi opcii'), true);
  assert.equal(detectWidenIntent('KONTAKTIRAJ ME'), false); // queue, not a wider search
  assert.equal(detectWidenIntent('запиши ме'), false);
  assert.equal(detectWidenIntent('забележи ги барањата'), false);
  assert.equal(detectWidenIntent('ne sakam nisto'), false);
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

test('buildEvent: REJECTED against shown offers AND intake denials, carries new area', () => {
  const ev = buildEvent('presentation', { rejected: true, location: 'Кисела Вода' });
  assert.equal(ev.type, 'REJECTED');
  assert.equal(ev.location, 'Кисела Вода');
  // "не барам стан" in the intake states -> REJECTED (handler pivots)
  assert.equal(buildEvent('discovery', { rejected: true }).type, 'REJECTED');
  assert.equal(buildEvent('idle', { rejected: true }).type, 'REJECTED');
  // a NEW direction beats the denial: "не барам стан, барам куќа" -> house
  const ev2 = buildEvent('discovery', { rejected: true, house: true });
  assert.equal(ev2.type, 'DETAILS_PROVIDED');
  assert.equal(ev2.house, true);
  // a bare need is not a rejection
  assert.equal(buildEvent('discovery', { need: true }).type, 'INTENT_DECLARED');
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
