import { test } from 'node:test';
import assert from 'node:assert';
import {
  detectService, detectBedrooms, detectBudget, detectRejection,
  detectLocation, buildEvent, extractSlots,
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

test('detectBedrooms: numbers and word forms', () => {
  assert.equal(detectBedrooms('2 spalni'), 2);
  assert.equal(detectBedrooms('двособен стан'), 2);
  assert.equal(detectBedrooms('една соба'), 1);
  assert.equal(detectBedrooms('три соби'), 3);
  assert.equal(detectBedrooms('4 sobni'), 4);
  assert.equal(detectBedrooms('zdravo'), undefined);
});

test('detectBudget: currencies, илјади, and no false positives', () => {
  assert.equal(detectBudget('do 80.000 evra'), '80000');
  assert.equal(detectBudget('до 80 000 евра'), '80000');
  assert.equal(detectBudget('80 илјади евра'), '80000');
  assert.equal(detectBudget('do 2500 евра'), '2500');
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
