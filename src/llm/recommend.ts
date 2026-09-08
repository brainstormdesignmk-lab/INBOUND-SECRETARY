// Grammar-based recommendation ask + code-built recommendation answer.
//
// THE BUG: "me interesira stanot 89" / "i stanot 94" / "koj bi mi go
// preporacale?" — the client names TWO properties and asks which one Lina
// recommends. No deterministic detector fired, the LLM misread it as
// SEEN_PROPERTY, and the client got "Дали го знаете Евидентен број на тој
// стан?" — asking for the numbers they had JUST given.
//
// The fix, as written:
//  1. detectRecommendAsk — grammar word classes (Macedonian verb предлог-…
//     family + English recommend) so recognition grows by grammar, not by
//     appending phrases.
//  2. collectMentionedEbs — the EBs the client named in RECENT MESSAGES
//     (the session history carries them), validated against the DB.
//  3. buildRecommendation — one card per mentioned property (DB facts only)
//     + the frozen professional close: "Секоја недвижнина има своја
//     клиентела… Дали да се обидам да договарам посета?"

import type { Property } from '../data/properties';
import { buildPropertyCard } from './prompts';
import { normalizeMc } from './normalize';

/** Word classes for the recommendation ask. The verb family: preporac-/препорач-
 *  (all conjugations), suggest/recommend (English). */
const RECO_VERB_RE =
  /(?:препорач|препорац|preporac|preporaka|preporaci|preporach|препорака|избер|избира|izber|izbira|избор|izbor)/iu;

/** True when the client asks for a recommendation between/for properties.
 *  Tested raw AND normalized: normalizeMc folds Latin→Cyrillic ('c'→'ц'),
 *  so the raw test catches Latin 'preporac…' and the normalized test catches
 *  its Cyrillic form 'препорац…'. */
export function detectRecommendAsk(text: string): boolean {
  return RECO_VERB_RE.test(text) || RECO_VERB_RE.test(normalizeMc(text));
}

/** Extract EB numbers the client mentioned in their messages. */
export function collectMentionedEbs(
  userTexts: string[],
  validEbs: Set<number>,
  window = 6,
): number[] {
  const found: number[] = [];
  for (const raw of userTexts.slice(-window)) {
    // "stanot 89", "i stanot 94", "EB 89", "евидентен број 94", bare "89".
    // Lookahead guards: a number followed by a thousands separator ("100.000",
    // "110 000") is a PRICE, never an EB — the tail group gets filtered by
    // validEbs anyway, but the head group must not fire.
    const re = /(?:\b(?:stanot|stan|kuca|куќата|куќа|станот|стан|eb|е|евидентен\s+број|evi[dđ]enten)\s*)?\b(\d{2,3})\b(?!\s*[.,]\d)(?!\s+\d{3})/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw))) {
      const n = parseInt(m[1], 10);
      if (validEbs.has(n) && !found.includes(n)) found.push(n);
    }
  }
  return found;
}

/** Build the recommendation answer from DB facts ONLY — one card per
 *  property, then the frozen professional close. No LLM at reply time. */
export function buildRecommendation(props: Property[], closeVariant: string): string {
  const cards = props.map(p => buildPropertyCard(p)).join('\n\n');
  return `${cards}\n\n${closeVariant}`;
}
