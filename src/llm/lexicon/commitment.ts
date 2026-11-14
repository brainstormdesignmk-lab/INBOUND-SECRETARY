/**
 * THE COMMITMENT LEXICON — the client CHOSE.
 *
 * The funnel knew every shade of interest («ми се допаѓа», «ми фати око»,
 * «заинтересиран сум») and nothing about the DECISION: «GO IZBRAV STANOT SO EB
 * 63», «SE ODLUCIV ZA STANOT», «OSTANUVAM NA STANOT 63», «TOJ E MOJOT IZBOR».
 * Those turns matched no detector at all, so the choice — the moment the fee
 * protocol starts (the owner's rule: «Ви честитам на изборот … па објаснување
 * на надоместот за посета») — fell through to a funnel lane and was answered
 * with a criteria question.
 *
 * INTEREST IS NOT A CHOICE, and the split is the rule:
 *   - interest («ми се допаѓа», «ми е интересна») earns the enthusiasm reply
 *     (`property.liked`) — the fee comes later, after the client confirms;
 *   - COMMITMENT (these verbs) earns the congratulation + the visit-fee
 *     disclosure in ONE turn, because the client has already decided.
 *
 * Only FIRST-PERSON DECIDED forms are listed. «избира/одлучува/решава» (third
 * person) and the undecided «не сум одлучил / уште избирам» are deliberately
 * absent — a client who has not decided must never be congratulated.
 */

import { NB, NA, WS, stemWords, stems } from './text';

/** The first-person decision verbs. Each stem takes its own inflections
 *  (избрав/избравме/избравте, одлучив/одлучивме …), so the stem is a prefix. */
export const SELECTION_VERBS = [
  'избрав',      // I chose (избрав/избравме/избравте)
  'одлучив',     // I decided (се одлучив за …)
  // THE FOLD SPELLING (the [10:06] Latin capture): normalizeMc folds `c` to
  // «ц», never to «ч», so «odluciv» arrives as «одлуцив» while «odlucen» — a
  // genuinely different word — is «одлучен». Both spellings are listed, the
  // same way the copula family keeps «privlachn» beside «привлачн».
  'одлуцив',
  'решив',       // I settled (се решив за …)
  'ресив',       // the fold spelling of «resiv»
  'зедов',       // I took (го зедов)
  'земам',       // I take (ќе го земам)
  'земав',       // I took (го земав)
  'останав',     // I stayed with it (останав на станот)
  'останувам',   // I am staying with it
];

/** The NOUN commitment: «тој е мојот избор», «ова е мојата одлука». */
export const SELECTION_NOUNS = ['избор', 'одлука'];

/** What can precede a decision verb and CANCEL it: «не избрав», «нема да
 *  изберам» is a different form, but «не решив» is real client speak. */
const NEGATION = ['не', 'ни', 'нема'];

/** Is the message a first-person COMMITMENT to a property? */
export function selectionPattern(): RegExp {
  // The bare decision verb is a commitment on its own; the noun needs the
  // possessive («мојот избор»), because «изборот е тежок» is a comment.
  const noun = `${NB}(?:мој\\p{L}*|ова|оваа|тој|тоа)${WS}(?:${SELECTION_NOUNS.join('|')})${NA}`;
  return new RegExp(`${stemWords(SELECTION_VERBS)}|${noun}`, 'iu');
}

/** A QUESTION about choosing is not a choice: «ДАЛИ ДА ГО ЗЕМАМ?», «КОЈ ДА ГО
 *  ИЗБЕРАМ?». The verb is the same, the decision is not taken yet. */
export function questionedSelectionPattern(): RegExp {
  const ask = ['дали', 'како', 'што', 'зошто', 'кој', 'која', 'кое', 'треба'];
  const verbs = stems(SELECTION_VERBS);
  return new RegExp(
    `${NB}(?:${ask.join('|')})${WS}(?:\\p{L}+${WS}){0,4}${NB}${verbs}${NA}`,
    'iu',
  );
}

/** A NEGATED decision is no decision at all. */
export function negatedSelectionPattern(): RegExp {
  const verbs = stems(SELECTION_VERBS);
  return new RegExp(
    `${NB}(?:${NEGATION.join('|')})${WS}(?:\\p{L}+${WS}){0,2}${NB}${verbs}${NA}`
      + `|${NB}(?:уште|се\\s+уште)${WS}(?:\\p{L}+${WS}){0,3}${NB}${verbs}${NA}`,
    'iu',
  );
}
