import { test } from 'node:test';
import assert from 'node:assert';
import { inferPropertyId } from '../src/llm/classify';

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
});
