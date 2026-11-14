/**
 * The regex primitives every lexicon module (and grammar.ts) builds with.
 *
 * ONE definition, because two copies of `or()` drift: one author adds the
 * boundary guard, another forgets it, and a word class silently starts matching
 * inside longer words («lokaciJA IMA» → ja+ima, the 22:05 false availability
 * ack; «ima LI ft» → li inside «lift»). JS `\b` is ASCII-only and never binds
 * around Cyrillic, so the guard is an explicit Unicode lookaround pair.
 */

/** Latin letter class for a word boundary (kept next to NB so they agree). */
export const NB = '(?<![\\p{L}\\p{N}])';
export const NA = '(?![\\p{L}\\p{N}])';
/** Required whitespace separator. */
export const WS = '\\s+';
/** A clause-internal gap: anything but a sentence end (`.!?` + newline). */
export const GAP = '[^.!?\\n]';

/**
 * Word-bounded alternation: `(?:a|b)` that only matches WHOLE words.
 * Use it for clitics, pronouns and verbs — a word's letters inside another
 * word are always a misread.
 */
export function or(words: readonly string[]): string {
  return `${NB}(?:${words.join('|')})${NA}`;
}

/** Optional non-capturing group: `(?:…)?` */
export function opt(group: string): string {
  return `(?:${group})?`;
}

/**
 * Inflected alternation — NO boundaries. A stem is a prefix by definition
 * («куќ» → куќа/куќи/куќичка), so the caller composes it inside its own
 * guard: `NB + stems(...) + NA` for a whole word, or bare inside a larger
 * pattern where the surrounding slot already carries the guard.
 *
 * Inflection is the rule, not an enhancement (AGENTS.md §4b-2): listing the
 * bare nominative is how «двособен» worked while «двособниот» did not.
 */
export function stems(list: readonly string[]): string {
  return `(?:${list.map((s) => `${s}\\p{L}*`).join('|')})`;
}

/** The same alternation with the word boundaries applied. */
export function stemWords(list: readonly string[]): string {
  return `${NB}${stems(list)}${NA}`;
}
