// dedupe — text-identity helpers shared by the learning layer's merge points
// (capture store, bank importer). Pure functions, no I/O, no bank policy.

/** Normalized identity of a wording: case/punctuation/WHITESPACE collapsed,
 *  with the x→кс and ks→кс folds applied (the normalizeMc direction, inlined
 *  so this module has no import cycle). Digits survive: "До 160 000" and
 *  "до 160000" are the same wording, "do 160000" ≠ "do 150000". */
export function normalizedKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/x/g, 'кс')
    .replace(/k[sс]/g, 'кс')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, '');
}

/** Character-trigram similarity (Dice coefficient) — the near-duplicate test.
 *  1 = identical, 0 = nothing shared. */
export function trigramSimilarity(a: string, b: string): number {
  const grams = (s: string): Set<string> => {
    const out = new Set<string>();
    const t = ` ${s} `;
    for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
    return out;
  };
  const ga = grams(a), gb = grams(b);
  if (ga.size === 0 || gb.size === 0) return 0;
  let inter = 0;
  for (const g of ga) if (gb.has(g)) inter++;
  return (2 * inter) / (ga.size + gb.size);
}

/** Near-duplicate threshold used by the bank importer: one-word drift inside
 *  an otherwise identical sentence reads as a twin; different sentences don't. */
export const NEAR_DUP_THRESHOLD = 0.85;
