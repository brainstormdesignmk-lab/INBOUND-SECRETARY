/**
 * THE [04:01]–[04:04] CAPTURES — three routing mistakes in one session.
 *
 *   [04:01] MI TREBA NESTO OD STRANATA NA AERODROM , MICURIN
 *   [04:01] ЛИНА: Евидентен број 77 се наоѓа во близина на УДГС Здравко Цветковски.
 *           ← a WHERE-IS answer (SURROUNDINGS: «од страната на») to an acquisition
 *   [04:02] KAZI MI KOI STANOVI VO AERODROM SE NAJBLISKU DO ZELEZNICKA ?
 *   [04:02] ЛИНА: Не, Станот со Евидентен број 77 всушност се наоѓа во Центар.
 *           ← a LOCATION-CONFIRM correction to a RANKING question
 *   [04:04] RASTOJANIE NA 75 DO ZELEZNICKA STANICA PRASAV
 *   [04:04] ЛИНА: Би требало да е сеуште достапен.
 *           ← the distance lane missed the ask (no «?», no «kolku») and the
 *             availability lane answered a measurement with a status
 *
 * The three contracts pinned here: an acquisition on a named side is a SEARCH
 * (never a surroundings/description answer); a nearest-in-an-area ranking is
 * never an area CORRECTION; and a distance ask is a distance ask however the
 * client phrases the asking («прашав» is asking).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  detectSurroundingsAsk, detectPropertyDescription, detectLocationConfirm,
  detectNearestOfShown, isDistanceQuestion, isPlaceAcquisition, extractDistancePlace,
} from '../src/llm/deterministic';
import { resolveIntent } from '../src/handlers/router';

const ACQ = 'MI TREBA NESTO OD STRANATA NA AERODROM , MICURIN';
const RANK = 'KAZI MI KOI STANOVI VO AERODROM SE NAJBLISKU DO ZELEZNICKA ?';

test('[04:01] an acquisition on a named side is a search, not a surroundings answer', () => {
  assert.equal(isPlaceAcquisition(ACQ), true, '«mi treba … od stranata na X» is a request for rows');
  assert.equal(detectSurroundingsAsk(ACQ), undefined,
    'the which-side lane must not answer a request for offers');
  assert.equal(detectPropertyDescription(ACQ), false,
    'nor may the remembered-property lane');
  assert.notEqual(resolveIntent(ACQ, 'idle'), 'SURROUNDINGS');
  assert.notEqual(resolveIntent(ACQ, 'idle'), 'PROPERTY_DESCRIPTION');
  // The GENUINE which-side question keeps its lane ([01:29]).
  assert.ok(detectSurroundingsAsk('OD STRANATA NA TRGOVSKIOT ILI ODKAJ PAZARCETO ?'),
    'a real «which side of X?» question still reads as a surroundings ask');
  // …and a definite property subject is never an acquisition.
  assert.equal(isPlaceAcquisition('STANOT OD STRANATA NA AERODROM'), false);
});

test('[04:02] a nearest-in-an-area ranking is not a location correction', () => {
  assert.equal(detectNearestOfShown(RANK), true, 'the ranking lane owns it');
  assert.equal(detectLocationConfirm(RANK), false,
    'the confirm lane answered a ranking question with «Не, станот … е во Центар»');
  assert.equal(resolveIntent(RANK, 'idle'), 'NEAREST_OF_SHOWN',
    `the mirror must give the ranking lane the turn, got ${resolveIntent(RANK, 'idle')}`);
  // A genuine confirmation still confirms.
  assert.equal(detectLocationConfirm('ZNACI NA VODNO E ?'), true);
});

test('[04:04] a distance ask phrased as «… прашав » is still a distance ask', () => {
  for (const t of [
    'NA KOLKAVO RASTOJANIE DO ZELEZNICKA E 75 ?',
    'RASTOJANIE NA 75 DO ZELEZNICKA STANICA PRASAV',
    'RASTOJANIE NA 75 DO ZELEZNICKA STANICA',
    'prasam na kolkavo rastojanie e 75 od zeleznicka',
  ]) {
    assert.equal(isDistanceQuestion(t), true, `the distance lane must own: ${t}`);
    assert.equal(resolveIntent(t, 'property_query'), 'DISTANCE',
      `the mirror must route it to DISTANCE, got ${resolveIntent(t, 'property_query')} for: ${t}`);
  }
  // The place is extracted from the asking phrasing — WITHOUT the verb he asked
  // with («… STANICA PRASAV» used to include it) — so the measurement has a
  // real anchor and the EB is read from the rest of the text.
  const place = extractDistancePlace('RASTOJANIE NA 75 DO ZELEZNICKA STANICA PRASAV') ?? '';
  assert.match(place, /(?:zeleznicka|железнич)/iu, `the measured place is Železnička, got: ${place}`);
  assert.doesNotMatch(place, /prasav|prasam/iu, `the asking verb rode into the place: ${place}`);
  // A status question is NOT a distance question.
  assert.equal(isDistanceQuestion('DALI USTE E DOSTAPEN 75 ?'), false);
});
