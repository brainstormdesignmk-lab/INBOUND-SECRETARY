// Input normalizer — transliterates Macedonian Latin into Cyrillic.
//
// WHY: every concept in deterministic.ts exists twice (Cyrillic + Latin
// alternations across ~40 regexes). That duplication already produced a real
// production bug (менаџер misspelled inside an alternation — invisible until
// a generated matrix test caught it). Normalizing input to ONE canonical
// script means every future regex is written once, in Cyrillic, and the
// entire homoglyph-typo class disappears structurally.
//
// USAGE CONTRACT (important):
//   - normalizeMc() LOWERCASES and returns the Cyrillic-canonical form.
//   - Detectors use it as a SECOND CHANCE: `re.test(text) || re.test(normalizeMc(text))`.
//     Raw text keeps priority so place-name extraction ("helen doron") stays in
//     the client's original script — landmark matching compares against POI
//     names that are often Latin-scripted.
//   - Never feed normalized text into EB-number parsing or reply strings:
//     "EB 78" would become "еб 78".

// Longest-match-first digraphs (ASCII typings users actually send).
const DIGRAPHS: Array<[string, string]> = [
  ['dzh', 'џ'], ['dž', 'џ'],
  ['gj', 'ѓ'], ['dj', 'ѓ'],
  ['kj', 'ќ'],
  ['lj', 'љ'], ['nj', 'њ'],
  ['zh', 'ж'], ['sh', 'ш'], ['ch', 'ч'],
];

const SINGLES: Record<string, string> = {
  a: 'а', b: 'б', c: 'ц', d: 'д', e: 'е', f: 'ф', g: 'г',
  h: 'х', i: 'и', j: 'ј', k: 'к', l: 'л', m: 'м', n: 'н',
  o: 'о', p: 'п', r: 'р', s: 'с', t: 'т', u: 'у', v: 'в',
  z: 'з',
  // Precomposed Latin diacritics → their Macedonian letters
  č: 'ч', ć: 'ќ', š: 'ш', ž: 'ж', đ: 'ѓ', ѐ: 'ѐ',
};

const MAX_DIGRAPH = Math.max(...DIGRAPHS.map(([k]) => k.length));

/**
 * Lowercase + transliterate any Macedonian-Latin text to Cyrillic.
 * Non-letter characters (digits, punctuation, emoji) pass through untouched;
 * unknown letters (q, w, x, y) are preserved verbatim.
 */
export function normalizeMc(text: string): string {
  const lower = text.toLowerCase();
  let out = '';
  let i = 0;
  while (i < lower.length) {
    // Greedy digraph match first (dzh > zh; gj > g; ...)
    let matched = false;
    for (let len = Math.min(MAX_DIGRAPH, lower.length - i); len >= 2; len--) {
      const seg = lower.slice(i, i + len);
      const hit = DIGRAPHS.find(([k]) => k === seg);
      if (hit) {
        out += hit[1];
        i += len;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    const ch = lower[i];
    out += SINGLES[ch] ?? ch;
    i++;
  }
  return out;
}
