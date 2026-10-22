/**
 * THE PERSONAL LANE — the client asking about LINA HERSELF.
 *
 * The [08:35–08:38] transcript: "KAKO TI E IMETO?" and "UBAVO IME IMAS" each
 * burned 14–30 s of LLM classify time before falling through to the generic
 * greeting, and "KOLKU GODINI IMAS LINA ?" was answered (and STORED in
 * bank_dynamic) with „Јас сум дигитален асистент, па немам години“ — a
 * machine-identity reveal the agency never authorised, served from the bank
 * forever after.
 *
 * These three shapes are closed-class: a name ask, a compliment, an age ask.
 * They are answered deterministically (0 ms, offline, free) and never reach
 * the dynamic generate+store door, so the bank cannot learn a persona answer
 * a model improvised. Everything else the client might ask about her stays on
 * the constrained Gemini path (see dynamicFallback's PERSONA prompt).
 *
 * The voice is Lina from Metropolis in the first person. She never says she
 * is digital, an AI, a bot, a robot, a program or a language model, and she
 * never gives an age — the answer deflects warmly and hands the turn back.
 */

import { pickVariant } from '../data/responseBank';

export type PersonalAsk = 'name' | 'age' | 'compliment';

const BOUNDARY = "(?:^|[\\s,.!?„“\"'(])";

/** A question about her NAME. */
const NAME_ASK_RE = new RegExp(
  '(?:' + BOUNDARY + ')(?:' +
    '(?:kako|како)\\s+(?:ti\\s+e|ти\\s+е|se\\s+vikas?|се\\s+викаш?|vie\\s+se\\s+vikate|вие\\s+се\\s+викате|e\\s+imeto|е\\s+името)' +
    '|(?:koe|кое)\\s+(?:ti\\s+e|ти\\s+е)\\s+(?:imeto|името)' +
    '|(?:kako|како)\\s+da\\s+(?:ve|ве|te|те)\\s+(?:vikam|викам)' +
    '|(?:tvoeto|твоето)\\s+(?:ime|име)' +
  ')(?=[\\s?!.,]|$)',
  'iu',
);

/** A question about her AGE. */
const AGE_ASK_RE = new RegExp(
  '(?:' + BOUNDARY + ')(?:' +
    '(?:kolku|колку)\\s+(?:godini|години|leta|лета)\\s+(?:imas|имаш|imaš|имате)' +
    '|(?:na\\s+kolku|на\\s+колку)\\s+(?:godini|години)\\s+(?:si|си|ste|сте)' +
    '|(?:kolku|колку)\\s+(?:si|си)\\s+(?:stara|стара)' +
    '|(?:koja|која)\\s+godina\\s+(?:si|си)\\s+(?:rodena|родена)' +
    '|(?:koga|кога)\\s+(?:si|си)\\s+(?:rodena|родена)' +
  ')(?=[\\s?!.,]|$)',
  'iu',
);

/** A compliment aimed at HER (not at a property). */
const COMPLIMENT_RE = new RegExp(
  '(?:' + BOUNDARY + ')(?:' +
    '(?:ubavo|убаво|prekrasno|прекрасно)\\s+(?:ime|име)' +
    '|(?:mnogu|многу|prennogu|премногу)?\\s*(?:si|си)\\s+(?:ubav[ao]|убав[ао]|prekrasn[ao]|прекрасн[ао]|divn[ao]|дивн[ао]|slatk[ao]|слатк[ао]|simpaticn[ao]|симпатичн[ао]|odlicn[ao]|одличн[ао]|super|супер)' +
    '|(?:ubav[ao]|убав[ао]|prekrasn[ao]|прекрасн[ао])\\s+(?:si|си)' +
  ')(?=[\\s?!.,]|$)',
  'iu',
);

/** Property/agency vocabulary — a line naming one of these is business talk,
 *  never a compliment to the agent or a question about her years. */
const BUSINESS_VETO_RE = /(?:stan|стан|kukj|куќ|imov|имот|nedviznost|недвижност|cena|цена|ceni|цени|zgrad|зград|proekt|проект|sopstvenik|сопственик|agent|аген|kvadrat|квадрат|спалн|spaln|poset|посет|ulic|улиц|naselb|населб|bulevar|булевар|mesto|место|grad|град)/iu;

/** The machine-identity family — what the stored age answer said and what no
 *  persona reply may ever say. Shared by the runtime validator and the purge
 *  tool, so "what counts as a reveal" has exactly one definition. */
const AI_REVEAL_RE = /(?:дигитал\w*|вештачк\w*\s+(?:интелигенц|интелегент)\w*|\bAI\b|\bA\.I\.|робот\w*|\bбот\b|chat\s*bot|чат\s*бот|јазичен\s+модел|language\s+model|\bLLM\b|немам\s+години|не\s+сум\s+(?:човек|личност)|програм(?:а|ски)?\s+сум)/iu;

/** True when the reply exposes a machine identity / refuses an age as a
 *  machine would. Used by validateDynamicAnswer() and the purge script. */
export function revealsMachineIdentity(text: string): boolean {
  return AI_REVEAL_RE.test(text);
}

/** Classify a personal small-talk turn, or undefined when it is not one. */
export function detectPersonalAsk(text: string): PersonalAsk | undefined {
  const flat = text.trim().replace(/\s+/g, ' ');
  if (!flat) return undefined;
  if (BUSINESS_VETO_RE.test(flat)) return undefined;
  if (NAME_ASK_RE.test(flat)) return 'name';
  if (AGE_ASK_RE.test(flat)) return 'age';
  if (COMPLIMENT_RE.test(flat)) return 'compliment';
  return undefined;
}

/** Is this turn owned by the personal lane? (The dynamic gate's exclusion.) */
export function isPersonalAsk(text: string): boolean {
  return detectPersonalAsk(text) !== undefined;
}

/** Code-built last resort — the bank seeds live in responseBank.ts, but the
 *  lane must answer even on a corrupted/absent bank. */
const FALLBACK: Record<PersonalAsk, string> = {
  name: 'Јас сум Лина, од агенцијата Метрополис. Како можам да Ви помогнам?',
  age: 'Годините не ги кажувам — но со задоволство ќе Ви помогнам да најдете добра недвижност.',
  compliment: 'Ви благодарам, тоа е многу љубезно! Со задоволство продолжувам да Ви помагам.',
};

/** The deterministic persona reply. Never mentions a machine identity, never
 *  states an age, and never turns into a property pitch the funnel did not
 *  ask for. */
export function personalReply(ask: PersonalAsk, recent: string[] = []): string {
  return pickVariant(`personal.${ask}`, { recent }) ?? FALLBACK[ask];
}
