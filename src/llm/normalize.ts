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

// ---------------------------------------------------------------------------
// Single-letter-typo fallback (edit distance ≤ 1 on long tokens).
//
// WHY: normalizeMc removes the script mismatch, but NOT typos — the poeKtino
// bug (21:39 transcript) showed a one-letter slip silently voids every regex.
// Fuzzing EVERY word is wrong ("да"→"дс" must never become agreement), so
// callers pass only LONG, unambiguous keywords (≥5 letters) whose distance-1
// neighborhood contains no other real word with a different intent.

const MIN_FUZZY_TOKEN = 5;

function editDistanceAtMost1(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  if (a.length === b.length) {
    // Damerau-style: an adjacent transposition ("посета"→"опсета") is ONE edit.
    let diff = -1;
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        if (diff >= 0) {
          // Second difference: only a swap of the two differs-from positions
          // qualifies (a[i-1]…a[i] swapped); anything else is 2+ edits.
          if (diff === i - 1 && a[diff] === b[i] && a[i] === b[diff]) return true;
          return false;
        }
        diff = i;
      }
    }
    return true; // 0 or 1 substitution
  }
  // One insertion/deletion: walk both strings, skip at most one letter.
  const [s, l] = a.length < b.length ? [a, b] : [b, a];
  let i = 0, j = 0, skipped = false;
  while (i < s.length && j < l.length) {
    if (s[i] === l[j]) { i++; j++; continue; }
    if (skipped) return false;
    skipped = true;
    j++;
  }
  return true;
}

/**
 * True when any whitespace-separated token of `text` is within one single-
 * letter edit of one of `keywords` (single words, lower or upper case).
 * Each keyword is compared in THREE spaces against the matching space of the
 * token: raw (as typed), Cyrillic-folded (normalizeMc — covers Latin input
 * and Cyrillic typos), and the keyword's canonical Latin reverse-form (covers
 * digraph-forming typos like "kjpuvam" whose fold "ќпувам" loses a letter).
 */
const CYR_TO_LAT: Record<string, string> = {
  'а': 'a', 'б': 'b', 'в': 'v', 'г': 'g', 'д': 'd', 'ѓ': 'gj', 'е': 'e',
  'ж': 'zh', 'з': 'z', 'ѕ': 'dz', 'и': 'i', 'ј': 'j', 'к': 'k', 'ќ': 'kj',
  'л': 'l', 'љ': 'lj', 'м': 'm', 'н': 'n', 'њ': 'nj', 'о': 'o', 'п': 'p',
  'р': 'r', 'с': 's', 'т': 't', 'у': 'u', 'ф': 'f', 'х': 'h', 'ц': 'c',
  'ч': 'ch', 'џ': 'dzh', 'ш': 'sh',
};

// The DIACRITIC-STRIPPED Latin users actually type: "prosiri" (не "proshiri"),
// "predlozi" (не "predlozhi"), "iznajmuvam". Distance-1 checks against the
// canonical digraph form alone would miss first-letter slips of these.
const CYR_TO_LAT_ASCII: Record<string, string> = {
  'ѓ': 'g', 'ж': 'z', 'ѕ': 'z', 'ќ': 'k', 'љ': 'l', 'њ': 'n',
  'ч': 'c', 'џ': 'd', 'ш': 's',
};

function toLatin(cyr: string, map: Record<string, string> = CYR_TO_LAT): string {
  let out = '';
  for (const ch of cyr) out += (map[ch] ?? CYR_TO_LAT[ch]) ?? ch;
  return out;
}

export function fuzzyHasToken(text: string, keywords: string[]): boolean {
  const raw = text.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  if (raw.length === 0) return false;
  const cyr = raw.map(normalizeMc);
  for (const kw of keywords) {
    const k = kw.toLowerCase();
    if (k.length < MIN_FUZZY_TOKEN || /\s/.test(k)) continue;
    const kc = normalizeMc(k);
    const kl = toLatin(kc);
    const kla = toLatin(kc, CYR_TO_LAT_ASCII);
    for (let i = 0; i < raw.length; i++) {
      if (editDistanceAtMost1(raw[i], k)          // Cyrillic token vs Cyrillic keyword
          || editDistanceAtMost1(cyr[i], kc)      // folded token vs folded keyword
          || editDistanceAtMost1(raw[i], kl)      // Latin token vs Latin keyword form
          || editDistanceAtMost1(raw[i], kla)) {  // …and the diacritic-stripped form
        return true;
      }
    }
  }
  return false;
}
