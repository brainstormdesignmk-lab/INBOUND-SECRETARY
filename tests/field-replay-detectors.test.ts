/**
 * Regression pins for the field replay (defects #1/#2, #4, #7).
 *
 *  #1/#2  «AMA NE SAKAM KARPOS 3 I AERODROM, SAMO CENTAR» named three areas,
 *         but two were only EXCLUDED. Every named area was stored, so the
 *         client got Карпош III and Аеродром back. A negated area must not be
 *         stored; the affirmed one is kept.
 *  #4     «ZNACI PODRUM?» matched no detector and got a wrong Центар answer.
 *         It is a definition ask answered by the glossary.
 *  #7     «MALCE POSKAPI DAJ MI AMA NORMALNI» is a request for a slightly
 *         pricier unit, not the client judging the market, so it must not be
 *         investment.opinion.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectLocation, detectInvestmentOpinion } from '../src/llm/deterministic';
import { detectGlossaryAsk, PODRUM_MEANING } from '../src/llm/glossary';

const FEED = ['Центар', 'Карпош III', 'Аеродром', 'Кисела Вода'];

test('#1/#2: a negated area is not stored; the affirmed area is', () => {
  const loc = detectLocation('AMA NE SAKAM KARPOS 3 I AERODROM, SAMO CENTAR', FEED) ?? '';
  assert.match(loc, /Центар/u, `the affirmed area must stay: ${loc}`);
  assert.doesNotMatch(loc, /Карпош/u, `the excluded Karpos must not be stored: ${loc}`);
  assert.doesNotMatch(loc, /Аеродром/u, `the excluded Aerodrom must not be stored: ${loc}`);
});

test('#1/#2: an affirmed multi-area list keeps every area', () => {
  const loc = detectLocation('IMAM BUDZET VO CENTAR I KARPOS', FEED) ?? '';
  assert.match(loc, /Центар/u);
  assert.match(loc, /Карпош/u);
});

test('#4: «ZNACI PODRUM?» is a podrum definition, not a floor or feature answer', () => {
  assert.equal(detectGlossaryAsk('ZNACI PODRUM?'), 'podrum-meaning');
  assert.equal(detectGlossaryAsk('sto znaci podrum'), 'podrum-meaning');
  assert.match(PODRUM_MEANING, /вкопан/u);
  assert.doesNotMatch(PODRUM_MEANING, /подрум во класична смисла.*е подрум\./u);
});

test('#4: a feature question about a basement room is NOT a definition', () => {
  assert.equal(detectGlossaryAsk('ima li podrum?'), undefined);
  assert.equal(detectGlossaryAsk('podrum'), undefined);
});

test('#7: «MALCE POSKAPI DAJ MI» is a pricier-unit request, not investment opinion', () => {
  assert.equal(detectInvestmentOpinion('MALCE POSKAPI DAJ MI AMA NORMALNI'), false);
});

test('#7: a market complaint is still investment opinion', () => {
  assert.equal(detectInvestmentOpinion('MNOGU SE POSKAPEA STANOVIVE'), true);
});
