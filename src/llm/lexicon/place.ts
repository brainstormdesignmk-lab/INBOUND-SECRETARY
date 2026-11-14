/**
 * THE PLACE LEXICON — a POINT, an AREA, or the place already bound.
 *
 * «кај/до/близу + X» reads a landmark the map can resolve; «во + X» reads a
 * district. That distinction is a CONTRACT in this appliance (AGENTS.md §4r):
 * the place lane owns the point answer, the recall/discovery lanes own the
 * area. It was spelled out locally in three places (the one-place reading, the
 * description precedence, the recall gate) and a local copy drifts — the first
 * version of the recall gate read «до» as a landmark even when it was a PRICE
 * («имавте куќа во Скопје Север ДО 130.000»), which silently handed the turn
 * back to the criteria grill.
 *
 * The guards that make it correct, encoded here once:
 *   • the preposition must be followed by a NON-NUMERIC word (a price is not a
 *     place);
 *   • «кај вас/нас» is the AGENCY anchor (a memory line), not a place name;
 *   • «таму/тамо/там» points at the place already bound in the session.
 */

import { NB, NA, WS } from './text';

/** Prepositions that introduce a landmark (both scripts). */
export const LANDMARK_PREPS = [
  'кај', 'kaj', 'кaj', 'до', 'do', 'близу', 'blizu', 'наспроти', 'nasproti',
  'спроти', 'sproti', 'околу', 'okolu', 'near', 'close',
];
/** The adverb that points at the place already on the table. */
export const ANCHOR_ADVERBS = ['таму', 'тамо', 'там', 'tamu', 'tamo', 'tam'];
/** Prepositions that introduce an area/district (never a point). */
export const AREA_PREPS = ['во', 'vo', 'на', 'na', 'низ', 'niz', 'по', 'po'];

/** «во близина на» — a landmark phrase, not two separate prepositions. */
const NEAR_PHRASE = `(?:во\\s+близина\\s+на|vo\\s+blizina\\s+na)`;
/** The agency anchor — a memory line, never a landmark. */
const AGENCY_ANCHOR = '(?:вас|нас|vas|nas)';

/**
 * A landmark PREPOSITION with something that can be a place after it:
 * not a digit, not the agency pronoun. Used as a test, not for extraction.
 */
export function landmarkPrepPattern(): RegExp {
  return new RegExp(
    `${NB}(?:${LANDMARK_PREPS.join('|')})${NA}${WS}`
    + `(?!\\d|${AGENCY_ANCHOR}${NA})`,
    'iu',
  );
}

/** «во близина на» alone (it carries its own «на», so it needs no complement test). */
export function nearPhrasePattern(): RegExp {
  return new RegExp(`${NB}${NEAR_PHRASE}${NA}`, 'iu');
}

export function anchorAdverbPattern(): RegExp {
  return new RegExp(`${NB}(?:${ANCHOR_ADVERBS.join('|')})${NA}`, 'iu');
}

/** Compiled matchers (the handler asks these once per message). */
export const LANDMARK_PREP_RE = landmarkPrepPattern();
export const NEAR_PHRASE_RE = nearPhrasePattern();
export const ANCHOR_ADVERB_RE = anchorAdverbPattern();

/**
 * THE ONE PREDICATE: does this clause read a POINT (a landmark or the bound
 * place) rather than a district? Every lane that has to decide between the
 * two calls THIS — never a local copy of the list.
 */
export function isLandmarkAnchored(text: string): boolean {
  return LANDMARK_PREP_RE.test(text)
    || NEAR_PHRASE_RE.test(text)
    || ANCHOR_ADVERB_RE.test(text);
}
