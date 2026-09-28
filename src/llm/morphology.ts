/**
 * Macedonian Morphology Engine
 *
 * Generates all inflected forms from base words so detector regexes
 * don't need to enumerate every variant manually. Handles:
 *
 *   - Adjectives / typed participles: достапен → достапна/достапно/достапни
 *   - Verbs (present, past, verbal noun): продавам → продаваш/продава/продаваат/продаден
 *   - Palatalization: г→ж, к→ч, х→ш before vowel suffixes
 *
 * Usage:
 *   const forms = expandAdjective('достапен');
 *   // → ['достапен', 'достапна', 'достапно', 'достапни', 'достапната', ...]
 *
 *   const forms = expandVerb('продавам');
 *   // → ['продавам', 'продаваш', 'продава', 'продаваме', 'продавате', 'продаваат',
 *   //    'продаден', 'продадена', 'продадено', 'продадени', 'продавање', ...]
 */

// ── Palatalization ──────────────────────────────────────────────────────────
// Before a vowel suffix, final г→ж, к→ч, х→ш (Macedonian hard-to-soft shift)
const PALATAL_MAP: Record<string, string> = { г: 'ж', к: 'ч', х: 'ш' };

function palatalize(stem: string): string {
  const last = stem.slice(-1);
  return PALATAL_MAP[last] ? stem.slice(0, -1) + PALATAL_MAP[last] : stem;
}

// ── Adjective expansion ─────────────────────────────────────────────────────
// Masculine nominative ends in -ен / -ан / -он
// Extracts the stem and generates feminine (-на/-а), neuter (-но/-о), plural (-ни/-и),
// definite forms (тата/тото/тите), and comparative (по- stem)
const ADJ_MASC_RE = /^(.{2,})(ен|ан|он)$/;

export function expandAdjective(base: string): string[] {
  const lower = base.toLowerCase();
  const m = lower.match(ADJ_MASC_RE);
  if (!m) return [lower];

  const stem = m[1]; // e.g. "достап", "слобод", "продад"
  const suffix = m[2]; // "ен", "ан", or "он"
  const vowSuffix = suffix === 'ен' ? 'на' : suffix === 'ан' ? 'на' : 'на';

  const pStem = palatalize(stem);

  const forms = new Set<string>();

  // Base (masculine nominative)
  forms.add(stem + suffix);

  // Feminine: stem + на (with palatalization)
  forms.add(pStem + 'на');

  // Neuter: stem + но
  forms.add(pStem + 'но');

  // Plural: stem + ни
  forms.add(pStem + 'ни');

  // Definite forms (the/this)
  forms.add(pStem + 'ната');  // feminine definite
  forms.add(pStem + 'ното');  // neuter definite
  forms.add(pStem + 'ниот');  // masculine definite
  forms.add(pStem + 'ните');  // plural definite

  // Comparative: по + stem + OR (with palatalization)
  forms.add('по' + pStem + 'ор');
  forms.add('по' + pStem + 'на');

  // Adverb: stem + но (same as neuter)
  // Already covered above

  return [...forms].sort();
}

// ── Verb expansion ──────────────────────────────────────────────────────────
// Infinitive-stem extraction from 1st person singular present (-ам/-ам)
// Generates: present (6 persons), aorist, imperfect, perfect (masculine),
// verbal noun, verbal adjective

const VERB_STEM_RE = /^(.{2,})(ам|увам|ирам)$/;

export function expandVerb(base: string): string[] {
  const lower = base.toLowerCase();
  const m = lower.match(VERB_STEM_RE);
  if (!m) return [lower];

  const fullStem = m[1] + m[2]; // "продавам", "пишувам", "читам"
  const stem = m[1]; // "продав", "пишув", "чит"
  const conjType = m[2]; // "ам", "увам", "ирам"

  const forms = new Set<string>();

  // ── Present tense (6 persons) ──
  if (conjType === 'ам') {
    // Regular а-verbs: продавам
    forms.add(stem + 'ам');
    forms.add(stem + 'аш');
    forms.add(stem + 'а');
    forms.add(stem + 'аме');
    forms.add(stem + 'ате');
    forms.add(stem + 'аат');
  } else if (conjType === 'увам') {
    // увам-verbs: пишувам
    forms.add(stem + 'увам');
    forms.add(stem + 'уваш');
    forms.add(stem + 'ува');
    forms.add(stem + 'уваме');
    forms.add(stem + 'увате');
    forms.add(stem + 'уваат');
  } else if (conjType === 'ирам') {
    // ирам-verbs: читам (actually читам is а-verb, but ирам covers cases like "посетирам")
    forms.add(stem + 'ирам');
    forms.add(stem + 'ирас');
    forms.add(stem + 'ира');
    forms.add(stem + 'ираме');
    forms.add(stem + 'ирате');
    forms.add(stem + 'ираат');
  }

  // ── Past tense (аорист / imperfect) ──
  // а-verbs: продав → продадов/продаде/продаде/продадовме/продадовте/продадоа
  // The past participle stem is often different (suppletive or palatalized)
  const pastStem = palatalize(stem);
  forms.add(pastStem + 'ов');
  forms.add(pastStem + 'е');
  forms.add(pastStem + 'е');
  forms.add(pastStem + 'овме');
  forms.add(pastStem + 'овте');
  forms.add(pastStem + 'оа');

  // ── Perfect (past participle + sum) ──
  // Masculine: продаден, Feminine: продадена, Neuter: продадено, Plural: продадени
  forms.add(pastStem + 'ен');
  forms.add(pastStem + 'ена');
  forms.add(pastStem + 'ено');
  forms.add(pastStem + 'ени');

  // ── Verbal noun (герунд) ──
  forms.add(stem + 'ање');

  // ── Verbal adjective (active) ──
  forms.add(stem + 'ачки');

  // ── Imperative ──
  forms.add(stem + 'ај');
  forms.add(stem + 'ајте');

  // ── Conditional ──
  forms.add(stem + 'ав');
  forms.add(stem + 'авме');

  return [...forms].sort();
}

// ── Convenience: expand a list of base words ────────────────────────────────
export type WordType = 'adjective' | 'verb';

export function expandWords(
  bases: Array<{ word: string; type: WordType }>,
): string[] {
  const all = new Set<string>();
  for (const { word, type } of bases) {
    const forms = type === 'adjective'
      ? expandAdjective(word)
      : expandVerb(word);
    for (const f of forms) all.add(f);
  }
  return [...all].sort();
}

// ── Build a regex alternation from expanded forms ───────────────────────────
// Escapes special regex characters and joins with |
// GROUPED: the return value is always (?:a|b|c) so it can be interpolated
// into any larger pattern with quantifiers/boundaries binding to the WHOLE
// alternation. An ungrouped return was the trap that made _cb() unsafe
// (guards bound only to the first alternative; bare "plakja" substring-
// matched inside "na-PLAKJA-te") — this helper can never reproduce that
// class, even if a future call site forgets its own wrapping.
export function toRegexAlt(forms: string[]): string {
  return '(?:' + forms
    .map(f => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|') + ')';
}

// ── Pre-built lexicons for common detector categories ───────────────────────

/** Availability / property status words */
export const AVAILABILITY_LEXICON: string[] = expandWords([
  // Adjectives
  { word: 'достапен', type: 'adjective' },
  { word: 'остапен', type: 'adjective' },
  { word: 'слободен', type: 'adjective' },
  { word: 'продаден', type: 'adjective' },
  { word: 'издаден', type: 'adjective' },
  { word: 'активен', type: 'adjective' },
  { word: 'зафатен', type: 'adjective' },
  { word: 'резервиран', type: 'adjective' },
  // Verbs
  { word: 'продавам', type: 'verb' },
  { word: 'изнајмувам', type: 'verb' },
  { word: 'издавам', type: 'verb' },
  { word: 'нудам', type: 'verb' },
  { word: 'имам', type: 'verb' },
]);

/** Location / where words */
export const LOCATION_LEXICON: string[] = expandWords([
  { word: 'наоѓам', type: 'verb' },
  { word: 'наоѓа', type: 'verb' },
  { word: 'сместен', type: 'adjective' },
  { word: 'лизгиран', type: 'adjective' },
]);

/** Fee / price words */
export const FEE_LEXICON: string[] = expandWords([
  { word: 'наплаќам', type: 'verb' },
  { word: 'чина', type: 'verb' },
  { word: 'струва', type: 'verb' },
  { word: 'фисксен', type: 'adjective' },
  { word: 'конечен', type: 'adjective' },
]);

/** Negotiation words */
export const NEGOTIATE_LEXICON: string[] = expandWords([
  { word: 'намалувам', type: 'verb' },
  { word: 'поевтинувам', type: 'verb' },
  { word: 'попуст', type: 'adjective' },
  { word: 'флексибилен', type: 'adjective' },
]);

/** Service type words */
export const SERVICE_LEXICON: string[] = expandWords([
  { word: 'купувам', type: 'verb' },
  { word: 'изнајмувам', type: 'verb' },
  { word: 'продавам', type: 'verb' },
  { word: '投资ирам', type: 'verb' },
]);

/** Scheduling words */
export const SCHEDULING_LEXICON: string[] = expandWords([
  { word: 'договорам', type: 'verb' },
  { word: 'закажувам', type: 'verb' },
  { word: 'посетувам', type: 'verb' },
  { word: 'организирам', type: 'verb' },
]);

// ════════════════════════════════════════════════════════════════════════════
// v2 ADDITIONS (the [22:55] pomalo family, generalized once-and-for-all):
// noun declension, bare-stem adjective grid, Cyrillic↔Latin transliteration,
// and a boundary-guarded regex builder that auto-transliterates. The original
// expandAdjective/expandVerb/toRegexAlt above stay exactly as they were —
// existing lexicons and tests pin their behavior.
// ════════════════════════════════════════════════════════════════════════════

/** Macedonian ↔ Latin alphabet correspondence. Each Cyrillic letter maps to
 *  BOTH its diacritic Latin form and the ASCII spelling clients actually
 *  type (ш → ["š","sh","s"]). Generated Latin twins cover the union. */
const CYR_TO_LATIN_V2: Record<string, string[]> = {
  'а': ['a'], 'б': ['b'], 'в': ['v'], 'г': ['g'], 'д': ['d'],
  'ѓ': ['ǵ', 'gj', 'dj'], 'е': ['e'], 'ж': ['ž', 'zh', 'z'], 'з': ['z'],
  'ѕ': ['ѕ', 'dz'], 'и': ['i'], 'ј': ['j', 'y'], 'к': ['k'], 'л': ['l'],
  'љ': ['lj'], 'м': ['m'], 'н': ['n'], 'њ': ['nj'], 'о': ['o'], 'п': ['p'],
  'р': ['r'], 'с': ['s'], 'т': ['t'], 'ќ': ['ќ', 'kj', 'ky'], 'у': ['u'],
  'ф': ['f'], 'х': ['h'], 'ц': ['c'], 'ч': ['č', 'ch', 'c'],
  'џ': ['dž', 'dzh', 'dz'], 'ш': ['š', 'sh', 's'],
};

const hasCyr = (w: string): boolean => /[\u0400-\u04FF]/.test(w);

/** Every Latin spelling of a Cyrillic word (diacritic + ASCII variants),
 *  or the word itself when it is already Latin. Deterministic order. */
export function translitLatin(word: string): string[] {
  if (!hasCyr(word)) return [word];
  let variants: string[] = [''];
  for (const ch of word) {
    const outs = CYR_TO_LATIN_V2[ch.toLowerCase()] ?? [ch];
    const next: string[] = [];
    for (const prefix of variants) for (const o of outs) next.push(prefix + o);
    variants = next;
  }
  return [...new Set(variants)];
}

/** Noun forms from a Cyrillic stem. The stem is the word MINUS its citation
 *  ending: masculine/neuter pass the bare stem ('стан', 'мест'), feminine
 *  pass the stem WITHOUT -а ('цен', 'кириј'). Generated set per gender:
 *    m: стан, станот, стани, станите
 *    f: цена, цената, цени, цените   (кириј → кирија, киријата, кирии, кириите)
 *    n: место-стем, …ото, …ата       (мест → место, местото, места, местата) */
export function nounFormsV2(stem: string, gender: 'm' | 'f' | 'n' = 'm'): string[] {
  const b = stem.toLowerCase();
  return gender === 'm' ? [b, `${b}от`, `${b}и`, `${b}ите`]
    : gender === 'f' ? [`${b}а`, `${b}ата`, `${b}и`, `${b}ите`]
    : [`${b}о`, `${b}ото`, `${b}а`, `${b}ата`];
}

/** Adjective forms from a BARE Cyrillic stem (no -ен/-ан extractor needed —
 *  for stems like 'мал', 'компакт', 'минимал'):
 *  мал → мал, мала, мало, мали, малиот, малата, малото, малите +
 *  comparative (по-) and superlative (нај-) across the same grid. */
export function adjectiveFormsV2(stem: string, opts: { comparative?: boolean; superlative?: boolean } = {}): string[] {
  const s = stem.toLowerCase();
  const grid = (pre: string) => [`${pre}${s}`, `${pre}${s}а`, `${pre}${s}о`, `${pre}${s}и`, `${pre}${s}от`, `${pre}${s}иот`, `${pre}${s}ата`, `${pre}${s}ото`, `${pre}${s}ите`];
  return [
    ...grid(''),
    ...(opts.comparative === false ? [] : grid('по')),
    ...(opts.superlative === false ? [] : grid('нај')),
  ];
}

const escV2 = (f: string): string => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Build ONE regex alternation source from forms (any mix of scripts):
 *  every Cyrillic form contributes its Latin twins; forms are
 *  boundary-guarded (?<![\p{L}\p{N}])(?:f)(?![\p{L}\p{N}]) unless opts.unguarded
 *  (for embedding where the caller already guards). Grouped when unguarded. */
export function formsToRegexSource(forms: string[], opts: { unguarded?: boolean } = {}): string {
  const all = new Set<string>();
  for (const f of forms) {
    all.add(f.toLowerCase());
    for (const t of translitLatin(f)) all.add(t.toLowerCase());
  }
  const parts = [...all].map(f =>
    opts.unguarded ? escV2(f) : `(?<![\\p{L}\\p{N}])(?:${escV2(f)})(?![\\p{L}\\p{N}])`);
  return opts.unguarded ? `(?:${parts.join('|')})` : parts.join('|');
}

/** Compile forms straight into a RegExp (default 'iu'). */
export function formsRegex(forms: string[], opts: { unguarded?: boolean; flags?: string } = {}): RegExp {
  return new RegExp(formsToRegexSource(forms, opts), opts.flags ?? 'iu');
}
