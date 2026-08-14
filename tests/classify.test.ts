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

test('parseClassified: a PROPERTY_ID_REQUESTED with NO number is a hallucination', () => {
  // "A NESTO POSKAPO DO 1000 EVRA" — the LLM sometimes answers
  // PROPERTY_ID_REQUESTED with no propertyId; there is no EB to look up.
  const c = parseClassified('{"event":"PROPERTY_ID_REQUESTED","propertyId":null,"reason":"neshto"}');
  assert.equal(c.event.type, 'PROPERTY_ID_REQUESTED');
  assert.equal(c.event.propertyId, undefined); // no number survived parsing
});
