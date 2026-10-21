// THE GLOSSARY LANE — when the client asks what a term MEANS, explain it.
//
// The [08:52] transcript: "na koj kat e garsonjerata?" → "Се наоѓа во
// сутерен.", then "sto znaci toa suteren ?" → the SAME line again. The floor
// ask and the definition ask both carry the word "сутерен", so the info-ask
// family claimed the second one and re-served the property's floor — it
// answered the property again instead of the vocabulary.
//
// A definition is NOT a fact about the bound property: it needs no binding, no
// feed row, and must never be answered with a facet. This module owns the
// terms the agency's own listings use but a client may not know, and the
// followed-up clarification ("дали е вкопан / под земја / подрум").
//
// Everything is probed through normalizeMc, so Latin typing ("suteren",
// "sto znaci", "dali e vkopan") is the same string as Cyrillic.

import { normalizeMc } from './normalize';

/** SUTEREN = кат −1, one storey below the ground floor of the building. */
export const SUTEREN_MEANING =
  'Сутерен е кат −1 — позиција еден кат подолу од приземјето на објектот.';

/** The follow-up about how deep it sits: partially dug in, never a full
 *  basement and never "underground". */
export const SUTEREN_DUG_IN = 'Делумно вкопан.';

export type GlossaryAsk = 'suteren-meaning' | 'suteren-dug-in';

// The term itself. Probed on the normalized (Cyrillic) text.
const SUTEREN_RE = /сутерен/iu;

// The definition scaffold: "што значи (тоа) сутерен", "што е сутерен", "што
// подразбира", "објасни ми", "не знам што е", "шо значи" (the dialect form).
// The QUESTION WORD is mandatory — "suteren" alone, "vo suteren e" or
// "suteren li e" are property asks and stay with the info-ask family.
// NOTE the Latin typing the normalizer produces: "sto" → "сто" (not "што"),
// "znaci" → "знаци" (not "значи"), so every spelling of the pair is listed.
const DEFINITION_CUE_RE = new RegExp(
  `(?:^|[\\s,.!?])(?:што|шо|сто|со)\\s+(?:знач[иа]|знаци|е|подразбира|се\\s+подразбира)(?=[\\s?!.,]|$)`
  + `|(?:^|[\\s,.!?])(?:објасни(?:те)?|објаснување)(?=[\\s?!.,]|$)`
  + `|(?:^|[\\s,.!?])(?:не\\s+(?:знам|разбирам|ми\\s+е\\s+јасно)|немам\\s+поим)(?=[\\s?!.,]|$)`,
  'iu',
);

// The DUG-IN clarification. Explicit copula forms only — "има ли подрум?"
// asks whether the flat HAS a basement room (a feature ask), which is a
// different question and stays with the feature probes.
const DUG_IN_SUBJECT = '(?:вкопан[ао]?|под\\s*земј[ае]?|подземј[а-я]*|подрум[а-я]*)';
const DUG_IN_RE = new RegExp(
  [
    `(?:дали\\s+(?:е\\s+)?(?:тоа\\s+)?${DUG_IN_SUBJECT})`,
    `${DUG_IN_SUBJECT}\\s+ли\\s+е`,
    `(?:^|[\\s,.!?])е\\s+ли\\s+(?:тоа\\s+)?${DUG_IN_SUBJECT}`,
    // "e pod zemja ?" — the copula form, the way the client actually types it.
    `(?:^|[\\s,.!?])е\\s+(?:тоа\\s+)?${DUG_IN_SUBJECT}\\s*\\?+$`,
    // the bare term as the WHOLE message ("pod zemja?"); "има ли подрум?"
    // asks whether the flat HAS a basement room and must NOT land here.
    `^(?:а\\s+|и\\s+)?${DUG_IN_SUBJECT}\\s*\\?+$`,
  ].join('|'),
  'iu',
);

/** Which glossary ask this message is, if any. */
export function detectGlossaryAsk(text: string): GlossaryAsk | undefined {
  const t = normalizeMc(text);
  if (DUG_IN_RE.test(t)) return 'suteren-dug-in';
  // A definition needs BOTH the scaffold and the term: "што значи тоа
  // сутерен?", "објасни ми што е сутерен", "не знам што е сутерен".
  if (SUTEREN_RE.test(t) && DEFINITION_CUE_RE.test(t)) return 'suteren-meaning';
  return undefined;
}

/** True when the message is a definition/clarification ask, i.e. never a fact
 *  about the bound property. The info-ask family vetoes on this. */
export function isGlossaryAsk(text: string): boolean {
  return detectGlossaryAsk(text) !== undefined;
}

export interface GlossaryContext {
  /** The property on the table is actually IN a suteren (кат −1). The dug-in
   *  line is RESERVED for those units: it must never be served for an
   *  upper-floor flat, and never when no suteren unit is bound at all. */
  suteren?: boolean;
}

/** The reply for a glossary ask, or undefined when it is not one — or when the
 *  ask is the dug-in follow-up and no suteren unit is on the table. */
export function answerGlossary(text: string, ctx: GlossaryContext = {}): string | undefined {
  switch (detectGlossaryAsk(text)) {
    case 'suteren-meaning': return SUTEREN_MEANING;
    case 'suteren-dug-in': return ctx.suteren === true ? SUTEREN_DUG_IN : undefined;
    default: return undefined;
  }
}
