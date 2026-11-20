// THE ASSENT FAMILY — one table of yes/no surface forms, read by every lane
// that has to understand a human's one-word answer.
//
// The [18:35] capture: the owner answered the Turn-0 address question
// («Дали адресата е точна?») with «tocno» and was asked AGAIN, because the
// address lane's regex knew «точна» and the h-digraph «tochno» but not the
// h-less «tocno» an owner types on a phone keyboard. The same word was also
// missing from the client-side bare-yes family. A word added in one lane and
// not in its sibling is the bug class — the forms therefore live HERE, and the
// lanes read them from this one table (add the word once).
//
// Two spellings must be matched for every Latin form, and that is not
// defensive coding, it is the normaliser: `normalizeMc('tocno')` is «тоцно»
// (c → ц), which matches NEITHER «точно» nor the Latin original. So every
// reader checks the raw text AND the normalised text, and the table carries
// the normalised surface form too where it differs.

import { normalizeMc } from './normalize';

/** Which question the answer is answering. The lane decides WHICH forms count:
 *  a form can be a legitimate yes in one lane and silence in another. */
export type AssentLane = 'address' | 'generic';

/**
 * YES — as the corpus actually types it. A form is a word or a short phrase;
 * matching is boundary-guarded, so «точно» never fires inside «неточно»
 * (that belongs to NO).
 */
const YES_FORMS: string[] = [
  // The plain yes.
  'да', 'da', 'ок', 'ok', 'океј', 'okej', 'okey', 'во ред', 'vo red', 'добро', 'dobro',
  // THE EXACTNESS FAMILY — the yes to «Дали адресата е точна?». Latin carries
  // BOTH transliterations (`tochno` textbook digraph, `tocno` phone spelling)
  // and its normalised form («тоцно»: c→ц, see the header).
  'точно', 'tocno', 'tochno', 'тоцно',
  'точна', 'tocna', 'tochna', 'точни', 'tocni',
  'точно е', 'tocno e', 'tochno e',
  'така е', 'taka e', 'така', 'taka',
  'правилно', 'pravilno', 'исправно', 'ispravno',
  // Consent verbs and confirmations.
  'се согласувам', 'se soglasuvam', 'se saglasuvam', 'се сложувам', 'se slozuvam', 'se slozhuvam',
  'согласен', 'soglasen', 'согласна', 'soglasna', 'saglasen', 'saglasna',
  'потврдувам', 'potvrduvam', 'потврдено', 'potvrdeno', 'потврда', 'potvrda',
  'потврди', 'potvrdi', 'потврдете', 'potvrdete',
  'важи', 'vazi', 'може', 'moze', 'мозе', 'супер', 'super', 'нема проблем', 'nema problem',
  'исто', 'isto', 'истото', 'istoto', 'сето е', 'seto e',
];

/**
 * NO — a real negative. NOT the correction words («друга адреса», «промена»):
 * those say "that is not the address" without answering the question, and the
 * address lane already owns them (ADDR_CORRECT_RE).
 */
const NO_FORMS: string[] = [
  'не', 'ne', 'no', 'ниту', 'nitu', 'немој', 'nemoj',
  'не е точно', 'ne e tocno', 'ne e tochno', 'не е тоцно',
  'не е така', 'ne e taka', 'грешно', 'gresno', 'неточно', 'netocno', 'не точно', 'ne tocno',
  'не може', 'ne moze', 'нема', 'nema', 'нема шанси', 'nema sansi',
  'не ми одговара', 'ne mi odgovara', 'не сакам', 'ne sakam',
  'не прифаќам', 'ne prifakjam', 'погрешно', 'pogresno',
  'wrong', 'incorrect', 'not exactly', 'not correct',
];

/**
 * FORMS THAT ARE YES ONLY IN SOME LANES — documented data, never silence.
 * «може» answers a TERM ("can you do 6?"); it says nothing about whether a
 * street is right, so the address turn must ask again instead of confirming
 * an address the owner never looked at.
 */
const LANE_EXCLUDES_YES: Record<AssentLane, string[]> = {
  address: ['може', 'moze', 'мозе'],
  generic: [],
};

/** Longest first: a phrase must win over a word it contains. */
function escapeForms(forms: string[]): string[] {
  return [...forms]
    .filter(f => f.trim().length > 0)
    .sort((a, b) => b.length - a.length)
    .map(f => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/** The boundary-guarded alternation source for a family — for lanes that build
 *  their own regex (the address confirm keeps its own stem extras). */
export function assentSource(kind: 'yes' | 'no', lane: AssentLane = 'generic'): string {
  const excluded = kind === 'yes' ? LANE_EXCLUDES_YES[lane] : [];
  const forms = escapeForms((kind === 'yes' ? YES_FORMS : NO_FORMS).filter(f => !excluded.includes(f)));
  return forms.join('|');
}

function familyRe(kind: 'yes' | 'no', lane: AssentLane): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}])(?:${assentSource(kind, lane)})(?![\\p{L}\\p{N}])`, 'iu');
}

const YES_RE: Record<AssentLane, RegExp> = {
  address: familyRe('yes', 'address'),
  generic: familyRe('yes', 'generic'),
};
const NO_RE: Record<AssentLane, RegExp> = {
  address: familyRe('no', 'address'),
  generic: familyRe('no', 'generic'),
};

/**
 * The answer a message carries, or undefined when it carries none.
 *
 * Precedence: a QUESTION is not an answer («дали е точна?» asks back), and a
 * NEGATED yes is a no — «ne e tocno» must never confirm. Both spellings of the
 * text are tried (see the header): the raw one and `normalizeMc`'s.
 */
export function detectPolarity(text: string, opts: { lane?: AssentLane } = {}): 'yes' | 'no' | undefined {
  const lane = opts.lane ?? 'generic';
  const raw = String(text ?? '').trim();
  if (!raw) return undefined;
  const variants = [raw.toLowerCase(), normalizeMc(raw).toLowerCase()];
  for (const v of variants) {
    // A QUESTION IS NOT AN ANSWER: the owner checking the address back
    // («дали е точна?») neither confirms nor corrects it.
    if (/\?/u.test(v) || /(?<![\p{L}])(?:дали|dali)(?![\p{L}])/u.test(v)) return undefined;
    if (NO_RE[lane].test(v)) return 'no'; // negation wins over every yes token
  }
  for (const v of variants) if (YES_RE[lane].test(v)) return 'yes';
  return undefined;
}

/**
 * A WHOLE-MESSAGE yes — one word (plus punctuation), nothing else. Deliberately
 * narrower than `detectPolarity`: «нормално» inside a sentence («ова не е
 * нормално») is not a yes, and the negated forms must stay complaints.
 */
const BARE_YES = new Set([
  'normalno', 'нормално', 'sekako', 'секако', 'vazi', 'важи',
  'taka e', 'така е', 'tocno', 'точно', 'tochno', 'тоцно',
  'definitivno', 'дефинитивно', 'absolutno', 'апсолутно',
]);

export function isBareYes(text: string): boolean {
  const raw = String(text ?? '').trim();
  if (!raw) return false;
  const clean = (s: string): string => s.toLowerCase().replace(/[.!?,;:]+/gu, ' ').replace(/\s+/gu, ' ').trim();
  return BARE_YES.has(clean(raw)) || BARE_YES.has(clean(normalizeMc(raw)));
}
