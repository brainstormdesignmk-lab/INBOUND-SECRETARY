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
export function toRegexAlt(forms: string[]): string {
  return forms
    .map(f => f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('|');
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
  { word: 'ȍдавам', type: 'verb' },
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
