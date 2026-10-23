/**
 * WHERE A CODE-OWNED ANSWER LIVES.
 *
 * The review screen can only change what is stored in the bank. Frozen policy
 * answers (fee, commission, contact protocol, info-miss lines) and data-carried
 * templates are CODE — deliberately so: the rules belong in version control,
 * not in a table a keystroke can rewrite. That makes the screen's job different
 * for those rows: it must say WHERE the wording is, so the operator knows what
 * to change, instead of offering an edit that cannot take effect.
 *
 * This module is that map, and only that map. It is pure data + a lookup, so a
 * test can check that every file and symbol it prints still exists — a stale
 * path here would be worse than no path at all.
 */
import { RESPONSE_BANK } from '../data/responses';

export interface CodeSource {
  /** Path relative to the project root. */
  file: string;
  /** The constant / function / key whose text serves. */
  symbol: string;
  /** Extra honesty line (e.g. "this file is generated"). */
  note?: string;
}

/** The generator that rewrites the seed file — named because editing
 *  responses.ts by hand is undone the next time it runs. */
const SEED_NOTE = 'генерирано: src/scripts/generateResponses.ts (рачната измена се губи)';

/** Keys whose wording is composed in code, not seeded. */
const EXPLICIT: Record<string, CodeSource> = {
  'info.no.data': { file: 'src/llm/infoAnswer.ts', symbol: 'INFO_NO_DATA_LINE' },
  'info.no.floors': { file: 'src/llm/infoAnswer.ts', symbol: 'INFO_NO_FLOORS_LINE' },
  'info.no.year': { file: 'src/llm/infoAnswer.ts', symbol: 'INFO_NO_YEAR_LINE' },
  'info.no.renovation': { file: 'src/llm/infoAnswer.ts', symbol: 'INFO_NO_RENOVATION_LINE' },
  'price.ask': { file: 'src/handlers/inbound.ts', symbol: "'price.ask'" },
  'where.landmark': { file: 'src/store/bank.ts', symbol: "'where.landmark'" },
};

/**
 * The source of a key's served wording, or undefined when the key is not
 * code-owned / has no located source. Seeded keys resolve to the generated
 * seed file, because that is literally the text pickVariant serves first.
 */
export function codeSourceFor(key: string | null | undefined): CodeSource | undefined {
  const k = (key ?? '').trim();
  if (!k) return undefined;
  const explicit = EXPLICIT[k];
  if (explicit) return explicit;
  if ((RESPONSE_BANK[k]?.length ?? 0) > 0) {
    // Double quotes deliberately: that is how the generated file spells its
    // keys, so the operator can search for the exact string the screen shows.
    return { file: 'src/data/responses.ts', symbol: `"${k}"`, note: SEED_NOTE };
  }
  return undefined;
}

/**
 * CODE ONLY — the answer is composed in code and has NO bank pool at all.
 *
 * This is the narrow definition the screen's ORANGE stands for. A frozen key
 * with seeded variants (fee.ask.buy, contact.ask.*, availability.ack…) is served
 * from a POOL in src/data/responses.ts: it is protected, but it is still bank
 * material, and painting all of it orange turned 131 of 175 queue rows orange.
 * Orange is reserved for the answers that exist nowhere but a constant/function
 * (the info-miss lines, the price-ask template): no pool, no variant, no edit.
 */
export function isCodeConstant(key: string | null | undefined): boolean {
  const k = (key ?? '').trim();
  if (!k || !EXPLICIT[k]) return false;
  return (RESPONSE_BANK[k]?.length ?? 0) === 0;
}

/** One-line form for the status bar. */
export function codeSourceLine(key: string | null | undefined): string | undefined {
  const src = codeSourceFor(key);
  return src ? `${src.file} → ${src.symbol}` : undefined;
}
