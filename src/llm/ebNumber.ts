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

// A GLUED «E» IS ALWAYS THE CURRENCY (the [22:27] capture): «A GARSONJERATA ZA
// 200E DALI E DOSTAPNA USTE ?» — the client typed 200 euros, and the reader
// answered «200 не се наоѓа во моменталната понуда» (a price read as an
// Евидентен број). UNIT_TAIL's «E» arm needs the letter to END the clause, so
// a glued «200E» followed by more words slipped through: the lookahead read
// the word after it as the currency's continuation. Two things are true at
// once, and only the SPACING tells them apart:
//   • «200E»/«350e»/«200EUR» — attached to the digits: a price, always;
//   • «63 E TAA» — spaced: the Latin E is the COPULA («63 IS that») and the
//     number is an Евидентен број (a pinned idiom, see UNIT_TAIL above).
// So the glued arm is tested WITHOUT the «\\s*» prefix the other units allow.
// The Cyrillic «е» is in the class because normalizeMc folds the client's Latin
// typing into Cyrillic BEFORE this reader runs («200E» arrives as «200е») — a
// Latin-only class would miss every real message.
const GLUED_UNIT_TAIL = '(?:[eEеЕ](?![\\p{L}\\p{N}])|[eEеЕ][\\p{L}]+)';
// AN APPROXIMATION WORD IS A CAP TOO (the [05:23] capture): «ПЕТОК ПРЕТПЛАДНЕ
// НАКАЈ 10» — «накај 10» is «around ten», a CLOCK, and the reader took the 10
// as an Евидентен број: the turn answered «10 моментално го нема во нашата
// понуда» to a client proposing a viewing time. «накај/кон/приближно/баш» are
// the same family as «околу» — a limit on the number, never a listing.
const CAP_HEAD =
  '(?:nad|над|do|до|pod|под|okolu|околу|preku|преку|poveke|повеќе|pomalo|помалку'
  + '|nakaj|накај|kon|кон|priblizno|приближно|bas|баш|tocno|точно)';

// A DAY/DAY-PART FRAME MAKES THE NUMBER A CLOCK (the [05:23] capture): after
// «петок претпладне» a bare «10» is ten o'clock, not a listing. The head is a
// day name or a day part (in both scripts, any inflection), optionally with
// the scaffolding a client types between them («утре попладне накај», «в
// сабота во»). CAP_HEAD already refuses «накај 10» on its own; this arm is
// what refuses «ПРЕТПЛАДНЕ 10» and «В САБОТА ВО 10» — the clock words that do
// not carry a preposition. Fixed-width-free lookbehind is legal in V8 and is
// used the same way by the CAP_HEAD arm above.
const TIME_HEAD =
  '(?:(?:sabajle|сабајле|izutrina|изутрина|nautro|наутро|pretspladne|претпладне'
  + '|popladne|попладне|navecer|навечер|vecer|вечер|utro|утро'
  + '|ponedelnik|понеделник|vtornik|вторник|sreda|среда|cetvrtok|четврток'
  + '|petok|петок|sabota|сабота|nedela|недела|utre|утре|denes|денес|deneska|денеска'
  + '|casot|часот|cas|час|saat|саат)(?:\\s+(?:\\p{L}+)){0,3}\\s+)';

/** The shared source of the EB-number grammar. Use ebNumbersInText() /
 *  firstEbNumber() rather than an own copy: a second regex drifts. */
export const EB_NUMBER_SOURCE =
  `(?<![\\p{L}\\p{N}])(?<!\\d[.,])(?<!\\d\\s)(?<!(?:${CAP_HEAD})\\s*)`
  + `\\b(\\d{2,3})\\b(?!\\s*[.,]\\d)(?!\\s+\\d{3})(?!\\s*${UNIT_TAIL})(?!${GLUED_UNIT_TAIL})`;

/** Day and day-part words — the frames that turn a bare number into a clock. */
const DAY_WORDS = new Set([
  'sabajle', 'сабајле', 'izutrina', 'изутрина', 'nautro', 'наутро',
  'pretspladne', 'претпладне', 'popladne', 'попладне', 'navecer', 'навечер',
  'vecer', 'вечер', 'utro', 'утро', 'denes', 'денес', 'deneska', 'денеска',
  'utre', 'утре', 'ponedelnik', 'понеделник', 'vtornik', 'вторник',
  'sreda', 'среда', 'cetvrtok', 'четврток', 'petok', 'петок', 'sabota', 'сабота',
  'nedela', 'недела', 'cas', 'час', 'casot', 'часот', 'saat', 'саат',
]);

/** A PROPERTY/CRITERION word between the day word and the number means the
 *  number is NOT the clock's («В САБОТА СТАНОТ 50» names EB 50 on Saturday). */
const NOT_A_CLOCK_WORD_RE = /^(?:стан|куќ|kukj|stan|недвиж|nedviz|имот|imot|објект|objekt|локал|lokal|дуќан|dukjan|гарсоњер|garsonjer|спалн|соби|квадрат|kvadrat|метри|metri|евра|evro|evra|денар|den|цена|cena|буџет|budzet)/u;

/**
 * TRUE when the number that starts at `index` is a CLOCK, not an Евидентен
 * број — a day or day-part word in the same clause with nothing but
 * time-scaffolding between it and the digits (the [05:23] capture: «ПЕТОК
 * ПРЕТПЛАДНЕ НАКАЈ 10» answered «10 моментално го нема во нашата понуда» to a
 * client proposing a viewing time).
 */
function isClockNumber(text: string, index: number): boolean {
  // The clause before the number, last few words only — a day word three
  // sentences back says nothing about this number.
  const before = text.slice(Math.max(0, index - 40), index);
  const clause = before.split(/[.!?;\n]/u).pop() ?? before;
  const words = clause.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  const tail = words.slice(-4);
  const dayAt = tail.findIndex(w => DAY_WORDS.has(w.toLowerCase()));
  if (dayAt < 0) return false;
  // Everything between the day word and the digits must be scaffolding
  // («накај», «во», «околу», a second day-part word). A property or
  // criterion word means the number is the listing's.
  return tail.slice(dayAt + 1).every(w => !NOT_A_CLOCK_WORD_RE.test(w.toLowerCase()));
}

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
    // An empty-width match cannot happen (the group is mandatory), but the
    // guard keeps a future edit from spinning forever — it runs BEFORE any
    // skip below, so a refused number cannot loop.
    if (m.index === re.lastIndex) re.lastIndex++;
    const n = parseInt(m[1], 10);
    // A NUMBER INSIDE A DAY FRAME IS A CLOCK (see isClockNumber) — «петок
    // претпладне накај 10» proposes a viewing, it does not name flat 10.
    if (isClockNumber(form, m.index)) continue;
    // \d{2,3} alone admits «00»; 0–9 is never an Евидентен број.
    if (n >= 10 && !found.includes(n)) found.push(n);
  }
  return found;
}

/** The FIRST flat the message names — the subject of the sentence, which is
 *  what every lane needs ("which flat is this about?"). */
export function firstEbNumber(text: string): number | undefined {
  return ebNumbersInText(text)[0];
}
