import { test } from 'node:test';
import assert from 'node:assert';
import { inferPropertyId, parseClassified } from '../src/llm/classify';

test('inferPropertyId: bare 2-3 digit numbers are Евидентен број references', () => {
  assert.equal(inferPropertyId('ZAINTERESIRANA SUM ZA 78'), 78);
  assert.equal(inferPropertyId('zdravo, sto e so 95?'), 95);
  assert.equal(inferPropertyId('sakam da ja vidam 74'), 74);
  assert.equal(inferPropertyId('kolkava e cenata za 78?'), 78);
  assert.equal(inferPropertyId('sakam da kupam, broj 69'), 69);
  assert.equal(inferPropertyId('DALI E SEUSTE DOSTAPEN SIFRA 82?'), 82);
  assert.equal(inferPropertyId('дали е достапен шифра 82?'), 82);
});

test('inferPropertyId: does NOT fire on bedrooms/prices/sizes/times/phones/years', () => {
  assert.equal(inferPropertyId('2 spalni vo Centar'), undefined);
  assert.equal(inferPropertyId('do 80.000 evra'), undefined);
  assert.equal(inferPropertyId('bilo kade do 250'), undefined); // rent budget, never EB 250
  assert.equal(inferPropertyId('bilo kade до 250'), undefined); // Cyrillic cap word too
  assert.equal(inferPropertyId('околу 250'), undefined);
  assert.equal(inferPropertyId('sakam stan 78 m2'), undefined);
  assert.equal(inferPropertyId('sakam stan 78 м2'), undefined);
  assert.equal(inferPropertyId('petok vo 18:30'), undefined);
  assert.equal(inferPropertyId('078/914 196'), undefined);
  assert.equal(inferPropertyId('godina 2025 gradba'), undefined);
  assert.equal(inferPropertyId('na 5 kat'), undefined);
  // Latin bedroom counts must never be misread as an Евидентен број
  assert.equal(inferPropertyId('1 SPALNA'), undefined);
  assert.equal(inferPropertyId('12 SPALNI'), undefined);
  // Latin currency — "DO 250 EVRA" is a RENT BUDGET, never Евидентен број 250
  // (Cyrillic евра was guarded, Latin EVRA wasn't — same gap as detectBudget)
  assert.equal(inferPropertyId('DO 250 EVRA'), undefined);
  assert.equal(inferPropertyId('do 250 evra'), undefined);
  assert.equal(inferPropertyId('DO 250 EVRO'), undefined);
  assert.equal(inferPropertyId('до 250 евра'), undefined);
  // but a genuine bare-number property reference still works
  assert.equal(inferPropertyId('ZAINTERESIRAN SUM ZA 78'), 78);
});

test('parseClassified: bedrooms/sqm are numeric-only and bounded — garbage and absurd values are dropped', () => {
  const beds = parseClassified('{"event":"DETAILS_PROVIDED","bedrooms":"кукја пофтина"}');
  assert.equal(beds.event.bedrooms, undefined);
  const bedsOk = parseClassified('{"event":"DETAILS_PROVIDED","bedrooms":2}');
  assert.equal(bedsOk.event.bedrooms, 2);
  const bedsAbsurd = parseClassified('{"event":"DETAILS_PROVIDED","bedrooms":99}');
  assert.equal(bedsAbsurd.event.bedrooms, undefined); // cap: 1..10
  const sqmG = parseClassified('{"event":"DETAILS_PROVIDED","sqm":"многу квадрати"}');
  assert.equal(sqmG.event.sqm, undefined);
  const sqmOk = parseClassified('{"event":"DETAILS_PROVIDED","sqm":105}');
  assert.equal(sqmOk.event.sqm, 105);
  const sqmHuge = parseClassified('{"event":"DETAILS_PROVIDED","sqm":99999}');
  assert.equal(sqmHuge.event.sqm, undefined); // cap: 10..5000
  const sqmTiny = parseClassified('{"event":"DETAILS_PROVIDED","sqm":2}');
  assert.equal(sqmTiny.event.sqm, undefined);
});

test('parseClassified: budget is canonicalized — garbage without digits is dropped', () => {
  // "до кукја пофтина евра" — the LLM filled budget with nonsense (no number)
  const garbage = parseClassified('{"event":"DETAILS_PROVIDED","budget":"кукја пофтина евра"}');
  assert.equal(garbage.event.budget, undefined);
  // canonical forms survive and normalize to digits
  const plain = parseClassified('{"event":"DETAILS_PROVIDED","budget":"1000"}');
  assert.equal(plain.event.budget, '1000');
  const formatted = parseClassified('{"event":"DETAILS_PROVIDED","budget":"до 80.000 евра"}');
  assert.equal(formatted.event.budget, '80000');
  const words = parseClassified('{"event":"DETAILS_PROVIDED","budget":"80 илјади"}');
  assert.equal(words.event.budget, '80000');
});

test('parseClassified: name/phone/visitTime garbage is dropped, real values survive', () => {
  // name: LLM fills it with a sentence — never stored
  const nameG = parseClassified('{"event":"CONTACT_PROVIDED","name":"кукја пофтина","phone":"078914196"}');
  assert.equal(nameG.event.name, undefined);
  assert.equal(nameG.event.type, 'STAY'); // required payload missing -> hallucination
  const nameOk = parseClassified('{"event":"CONTACT_PROVIDED","name":"Горан Петровски","phone":"078914196"}');
  assert.equal(nameOk.event.name, 'Горан Петровски');
  assert.equal(nameOk.event.type, 'CONTACT_PROVIDED');
  // phone: letter soup is rejected outright (and drops the whole event)
  const phoneG = parseClassified('{"event":"CONTACT_PROVIDED","name":"Горан","phone":"кукја пофтина"}');
  assert.equal(phoneG.event.phone, undefined);
  assert.equal(phoneG.event.type, 'STAY');
  const phoneOk = parseClassified('{"event":"CONTACT_PROVIDED","name":"Горан","phone":"078/914 196"}');
  assert.equal(phoneOk.event.phone, '078914196');
  assert.equal(phoneOk.event.type, 'CONTACT_PROVIDED');
  // visitTime: garbage is dropped (event -> STAY), a bare time survives
  const tG = parseClassified('{"event":"VISIT_TIME_PROVIDED","visitTime":"кукја пофтина"}');
  assert.equal(tG.event.visitTime, undefined);
  assert.equal(tG.event.type, 'STAY');
  const tOk = parseClassified('{"event":"VISIT_TIME_PROVIDED","visitTime":"19:00"}');
  assert.equal(tOk.event.visitTime, '19:00');
  assert.equal(tOk.event.type, 'VISIT_TIME_PROVIDED');
  const tOk2 = parseClassified('{"event":"VISIT_TIME_PROVIDED","visitTime":"утре на пладне"}');
  assert.equal(tOk2.event.visitTime, 'утре на пладне');
  assert.equal(tOk2.event.type, 'VISIT_TIME_PROVIDED');
});

test('parseClassified: a PROPERTY_ID_REQUESTED with NO number is a hallucination', () => {
  // "A NESTO POSKAPO DO 1000 EVRA" — the LLM sometimes answers
  // PROPERTY_ID_REQUESTED with no propertyId; there is no EB to look up.
  const c = parseClassified('{"event":"PROPERTY_ID_REQUESTED","propertyId":null,"reason":"neshto"}');
  assert.equal(c.event.type, 'PROPERTY_ID_REQUESTED');
  assert.equal(c.event.propertyId, undefined); // no number survived parsing
});

test('parseClassified: SEEN_PROPERTY is a valid event carrying the remembered details', () => {
  const c = parseClassified('{"event":"SEEN_PROPERTY","location":"Карпош","budget":"70000"}');
  assert.equal(c.event.type, 'SEEN_PROPERTY');
  assert.equal(c.event.location, 'Карпош');
  assert.equal(c.event.budget, '70000');
});
