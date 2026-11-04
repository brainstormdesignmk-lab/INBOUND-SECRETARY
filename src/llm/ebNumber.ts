// THE EB NUMBER GRAMMAR — "the client named a flat by its number", read
// LOCALLY (one reader for every lane that asks that question).
//
// WHY THIS EXISTS (the [20:11] capture): «KOLKU DOAGJA CENA PO KVADRAT ZA 53 ?»
// asks EB 53's own rate. The market lane's guard — "a named property owns its
// lane" — asks inferPropertyId whether a flat was named, and that reader
// refused to look at ANY number as soon as the message carried a unit word:
//
//   if (…|м2|м²|kvadrat|евра|спални|(?:до|околу|под)\s*\d{2,3}\b… .test(text))
//     return undefined;
//
// so the very word «kvadrat» that ASKS for the rate destroyed the number that
// names the flat. The band lane then answered Аеродром's 1.250–2.026 €/м² — a
// market statistic — for a question about one flat.
//
// A unit word somewhere in the sentence says nothing about a number somewhere
// else: «50 м², а за 53 колку е квадратот?» carries both a criterion and a
// flat. The rules below therefore look at the NUMBER's own neighbourhood:
//
//   - a number with a UNIT after it is a criterion («50 м²», «120.000 евра»,
//     «3 кат», «6 саат», «70 %») — never a listing;
//   - a number behind a CAP/comparison word is a limit («do 120», «nad 50»,
//     «preku 60», «pomalo 40») — never a listing (the [09:24] Дебар Маало
//     binding of EB 50 off «NAD 50 M2»);
//   - a number inside a thousands figure is a price («100.000», «110 000»,
//     «1.286 €/м²»), caught by the decimal lookbehind/lookahead and the
//     three-digit tail guard;
//   - everything else is a reference to a listing.
//
// Both directions are contract and pinned in tests/eb-number.test.ts: loosening
// this reader turns budgets and sizes into flats, tightening it sends
// single-flat questions to the market/criteria lanes again.
import { normalizeMc } from './normalize';

// A LONE «E» IS A CURRENCY (the [20:11] sweep): «KE DADAM 400 E» names 400
// euros and the turn answered «400 моментално го нема во нашата понуда» — a
// price read as an Евидентен број. Latin only and clause-final, exactly like
// the money scanner: the Cyrillic «е» is the copula («DA, 63 E TAA» = "63 IS
// that") and a trailing word («1286E PO M2») is a rate.
const UNIT_TAIL =
  '(?:м2|м²|m2|m²|кв\\.?\\s*м|kvadrat|квадрат|спалн|соби|sob|евра|евро|evra|evro|€|[eEеЕ](?!\\s*[\\p{L}\\p{N}])|денар|денари|den|%|кат|спрат|саат|час)';
const CAP_HEAD =
  '(?:nad|над|do|до|pod|под|okolu|околу|preku|преку|poveke|повеќе|pomalo|помалку)';

/** The shared source of the EB-number grammar. Use ebNumbersInText() /
 *  firstEbNumber() rather than an own copy: a second regex drifts. */
export const EB_NUMBER_SOURCE =
  `(?<![\\p{L}\\p{N}])(?<!\\d[.,])(?<!\\d\\s)(?<!(?:${CAP_HEAD})\\s*)`
  + `\\b(\\d{2,3})\\b(?!\\s*[.,]\\d)(?!\\s+\\d{3})(?!\\s*${UNIT_TAIL})`;

/** Every EB-shaped number the client mentioned, in the order typed.
 *  NB: this is a TEXT read — it says "the client pointed at a listing", not
 *  "that listing exists"; callers that must be sure filter against the feed. */
export function ebNumbersInText(text: string): number[] {
  const found: number[] = [];
  // THE FOLD IS MANDATORY, not a second chance: this reader answers with a
  // NUMBER, so «first the raw text, else the fold» would keep the raw form's
  // false positive — «12 SPALNI» read as EB 12 because the Latin unit word
  // missed a Cyrillic-canonical UNIT list. The units are written once, in
  // Cyrillic (the same contract as every detector in deterministic.ts), and
  // normalizeMc passes digits and punctuation through untouched, so the digit
  // group read here is still exactly the client's.
  const form = normalizeMc(text);
  // A FRESH regex per call: a module-level /g regex carries lastIndex state
  // across calls, and a shared one would make two lanes disagree depending on
  // who ran first.
  const re = new RegExp(EB_NUMBER_SOURCE, 'giu');
  let m: RegExpExecArray | null;
  while ((m = re.exec(form))) {
    const n = parseInt(m[1], 10);
    // \d{2,3} alone admits «00»; 0–9 is never an Евидентен број.
    if (n >= 10 && !found.includes(n)) found.push(n);
    // An empty-width match cannot happen (the group is mandatory), but the
    // guard keeps a future edit from spinning forever.
    if (m.index === re.lastIndex) re.lastIndex++;
  }
  return found;
}

/** The FIRST flat the message names — the subject of the sentence, which is
 *  what every lane needs ("which flat is this about?"). */
export function firstEbNumber(text: string): number | undefined {
  return ebNumbersInText(text)[0];
}
