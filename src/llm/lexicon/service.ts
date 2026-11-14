/**
 * THE SERVICE LEXICON — buy vs rent, one vocabulary for every reader.
 *
 * The two families were hand-written in `BUY_RE` / `RENT_RE` with no word
 * boundaries, so «скупо» («МНОГУ СКУПО») matched the buy stem «куп» and armed
 * service=buy on a VALUE COMPLAINT. Bounded matching fixes that by
 * construction: a stem only counts when it STARTS the word.
 *
 * Deliberate exclusions live here too, once:
 *   • «рентабил-» (profitable) is not rent — the stem carries the lookahead;
 *   • «рентa» as a car-rental word is still rent (it is the same money shape).
 */

import { NB, NA } from './text';
import { normalizeMc } from '../normalize';

/** Purchase side: копува/купи/купен + продава/продажба (the listing's side). */
const BUY_STEMS = ['куп', 'kup', 'продажб', 'prodazb', 'продава', 'prodava', 'продав', 'prodv'];
/** Tenancy side: изнајмува/издава/кирија/наем + rent(-anje, -iranje). */
const RENT_STEMS = ['изнајм', 'iznajm', 'кириј', 'kirij', 'кирја', 'kirja', 'крија', 'krija',
  'издав', 'izdav', 'издад', 'izdad', 'наем', 'naem', 'rentanj', 'rentir'];
/** «рента» is rent; «рентабил-» is a yield word, not a tenancy. */
const RENT_LOOKAHEAD = '(?!абил|abil)';

function alternation(stemList: readonly string[], lookahead = ''): string {
  return `${NB}(?:${stemList.map((s) => `${s}\\p{L}*`).join('|')})${lookahead}${NA}`;
}

/** The whole buy / rent family as one bounded matcher. */
export function buyPattern(): RegExp {
  return new RegExp(alternation(BUY_STEMS), 'iu');
}

export function rentPattern(): RegExp {
  // The «рент(абил)» family is inflected (`\p{L}*` AFTER the lookahead): a bare
  // `рент(?!абил)(?!\p{L})` refused the very word it was written for —
  // «РЕНТАЊЕ» — because the letter after the stem is not a word boundary.
  return new RegExp(
    `(?:${alternation(RENT_STEMS)}|${NB}рент${RENT_LOOKAHEAD}\\p{L}*${NA}|${NB}rent${RENT_LOOKAHEAD}\\p{L}*${NA})`,
    'iu',
  );
}

/** Compiled once — `detectService` runs on every inbound message. */
export const BUY_RE = buyPattern();
export const RENT_RE = rentPattern();

/** Does the message name BOTH deals? (the «и купување и изнајмување» answer) */
export function readServiceWords(text: string): { buy: boolean; rent: boolean } {
  const probe = `${text}\n${normalizeMc(text)}`;
  return { buy: BUY_RE.test(probe), rent: RENT_RE.test(probe) };
}

/** The service the message names, when it names exactly one. */
export function readServiceWord(text: string): 'buy' | 'rent' | undefined {
  const { buy, rent } = readServiceWords(text);
  if (buy && rent) return undefined;
  if (buy) return 'buy';
  if (rent) return 'rent';
  return undefined;
}

/** The money cue words of a deal — «за продажба», «под кирија». */
export function dealCuePattern(): string {
  return `${NB}(?:за\\s+продажба|za\\s+prodazba|за\\s+изнајмување|za\\s+iznajmuvanje|под\\s+кирија|pod\\s+kirija|на\\s+продажба|na\\s+prodazba)${NA}`;
}
