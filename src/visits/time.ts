// Visit-time parsing — the visit protocol's scheduler needs a CONCRETE
// datetime ("2 hours before", "morning of the visit day"), but the client
// proposes free text: "петок 11.06 во 17:30", "утре на пладне", "сабота
// попладне". This resolves that text deterministically (both scripts),
// relative to a `now` — injected so tests can pin the clock.
//
// Unresolvable phrases ("по договор", "викенд") return undefined and the
// caller degrades gracefully (arranged message still sent, timed turns marked
// unschedulable, operator told the time needs manual handling).

export const MK_WEEKDAYS = ['недела', 'понеделник', 'вторник', 'среда', 'четврток', 'петок', 'сабота'];

/** THE VISIT WINDOW. Viewings are made 09:00–21:00 and never outside it, and
 *  that window is what decides AM/PM for a BARE hour — the owner's rule, stated
 *  from the [17:45] capture: «no visits until 9:00 in the morning, and none
 *  after 21:00, so the hour frame is 9…20».
 *
 *  A bare hour 1–8 is therefore an AFTERNOON/EVENING clock: 1 → 13:00, 4 →
 *  16:00, 6 → 18:00, 7 → 19:00, 8 → 20:00 — and with minutes kept, 7:30 →
 *  19:30. Hours 9–12 stay as said („во 11“ = 11:00, „на пладне“ = 12:00) and
 *  13–20 are already 24-hour. Anything that resolves outside 09:00–21:00 is
 *  not a visit and must never be relayed as one. */
export const VISIT_FIRST_HOUR = 9;
export const VISIT_LAST_HOUR = 21; // a visit may start up to 21:00

/** 1–8 are PM (the visit window starts at 9), everything else is as said. */
export function visitClockHour(hour: number): number {
  return hour >= 1 && hour <= 8 ? hour + 12 : hour;
}

/** Does this clock (minutes since midnight) fall inside the visit window? */
export function isVisitClock(minutes: number): boolean {
  return minutes >= VISIT_FIRST_HOUR * 60 && minutes <= VISIT_LAST_HOUR * 60;
}

/** A phrase that NAMES a clock but cannot be a visit because that clock sits
 *  outside 09:00–21:00 («во 8 наутро», «во 22:00»). The owner's counters are
 *  checked with it before they are relayed — a visit the window forbids must
 *  not be offered to the client as a term. A phrase with no clock at all is
 *  not "outside": that is the vague-time lane's business. */
export function outsideVisitWindow(phrase: string, now: Date = new Date()): boolean {
  if (!hasClockHint(phrase)) return false;
  return parseVisitDateTime(phrase, now) === undefined;
}

// A MORNING word fixes the hour as AM ("понеделник утрово во 9" stays 09:00);
// without one, the visit-window rule above decides.
const MORNING_WORD_RE = /(наутро|наутрото|утрово|утрина|сабајле|sabajle|nautro|utrovo|претпладне|pretpladne)/i;

const DAY_WORDS: Array<[RegExp, number]> = [
  // "понеделк/PONEDELIK/ponedenik" — the n→k / dropped-letter day typos (the
  // [12:42] transcript: "PONEDELIK 6" left the day unparsed and the owner ask
  // fell back to the raw phrase / a stale day). Parsed as понеделник.
  // "понеделок" — theCaught distance-2 n→k slip ([00:57] family, pinned in the
  // deterministic fuzzy sweep and mkTimePhrase's MK_DAY_FIX); a day word read
  // day-less makes every merge gate treat the stored day as day-less.
  // "ponednik/понедник" — the dropped-«el» spelling a client actually types
  // (the [04:05] capture: «DA OSTAVIME ZA PONEDNIK VO 6 MOZE?»). Unrecognized,
  // the day word read as NO day, parseVisitDateTime anchored the clock to
  // TODAY's weekday, and the owner was asked about Четврток instead of the
  // Понеделник the client proposed.
  [/(понеделни|понедник|понеделк|понеделок|ponedelnik|ponednik|ponedelk|ponedelok|ponedelik|ponedenik)/i, 1],
  [/(вторни|вторик|втрик|vtornik|vtorik|vtrik)/i, 2],
  [/(сред[аи]|сретта|срета|средта|sred[аa]|sredta|sreta)/i, 3],
  [/(четврто|четврток|цетврток|cetvrtok|četvrtok)/i, 4],
  [/(петочни|петок|петк|petok|petk)/i, 5],
  [/(саботи|сабота|сабта|субота|sabota|sabta|subota)/i, 6],
  [/(недели|недела|nedela)/i, 0],
];

const REL_DAY_RE = /(задутре|zadutre|утре|utre|денес|денеска|denes|deneska)/i;

// A clock WITH a time-word prefix: "во 17:30", "во 11", "околу 10". The prefix
// is REQUIRED so "11.06" (a date) is never read as 11:06. "на/na" and "од/od"
// are legal time prefixes too ("na 5", "od 6") — dates are never written with
// them, so no date collision.
// «накај 5» / «nakaj 5» is a clock too (the [00:59] capture: «DALI KE MOZE
// PORANO MALCE . NAKAJ 5 ?» — the client moving the owner's 18:00 an hour
// earlier). The OWNER-side parser already read «NAKAJ 4» (the [17:45] rule);
// the CLIENT side had no such prefix, so the message carried no time at all,
// never reached the owner, and the surroundings lane answered it with a
// landmark. «накај» means "towards" and a bare hour after it is only a clock.
const CLOCK_RE = /(?:во|vo|на|na|околу|okolu|по|po|после|posle|од|od|накај|nakaj)\s*(\d{1,2})(?:[:.](\d{2}))?\b/i;
// A bare hour WITH the hour-word suffix: "6 saat", "6 саати", "6 casot" —
// Latin transcripts write the hour as digits + the hour noun. The suffix
// anchors the digits as a clock (a bare "6" alone never parses as a time).
// Exported: detectVisitTime/isValidVisitTime (llm/deterministic) reuse it so a
// BARE "6 SAAT" (the split [14:35] message) is recognized as a time reference
// on its own, without a day word. Suffixes are EXPLICIT (not \w*) — \w has no
// Cyrillic, so "6 саати" never matched and the boundary lookahead failed; the
// explicit list also keeps "6 casino" out (cas+ino is not a suffix).
export const HOUR_WORD_RE =
  /(?<![\p{L}\p{N}])(\d{1,2})\s*(?:саат(?:и|от|а)?|saat(?:i|ot|a)?|час(?:от|а|и)?|cas(?:ot|ovi|a|i)?)(?![\p{L}\p{N}])/iu;

/** Hour-word clock adapter: returns a CLOCK_RE-shaped match for "6 saat"
 *  (index 2 — the minutes — is always absent in the hour-word form). */
function hourWordClock(t: string): { 1: string; 2?: string; length: number } | null {
  const m = t.match(HOUR_WORD_RE);
  return m ? { 1: m[1], 2: undefined, length: 2 } : null;
}

// SPOKEN HALF-HOUR — "пет и пол" / "pet i pol" = 5:30 (the [22:50]
// transcript: the client answered the exact-hour ask for "VO VTORNIK POSLE 5"
// with "PA NEKA BIDE PET I POL", which the classifier could only read as a
// bare clock "5:30", dropping the day AND the afternoon context — the owner
// was asked about НЕДЕЛА 05:30 instead of ВТОРНИК (the intended 17:30).
// Word-number hour + "и пол": the hour table follows the VISIT WINDOW rule
// (see visitClockHour — 1–8 are PM: "пет и пол" = 17:30).
// The trailing-room-noun veto keeps the bedroom fraction ("една и пол
// спални") out.
/** The hour a token names — a word («пет», «pet») or digits («5»). */
function spokenHour(token: string): number | undefined {
  const raw = token.trim().toLowerCase();
  if (!raw) return undefined;
  if (/^\d{1,2}$/.test(raw)) {
    const n = Number(raw);
    return n >= 0 && n <= 23 ? n : undefined;
  }
  for (const [re, h] of HOUR_WORDS) if (re.test(raw)) return h;
  return undefined;
}

const HOUR_WORDS: Array<[RegExp, number]> = [
  [/(?:еден|една|eden|edna)(?![\p{L}\p{N}])/iu, 1],
  [/(?:два|dva)(?![\p{L}\p{N}])/iu, 2],
  [/(?:три|tri)(?![\p{L}\p{N}])/iu, 3],
  [/(?:четири|cetiri)(?![\p{L}\p{N}])/iu, 4],
  [/(?:пет|pet)(?![\p{L}\p{N}])/iu, 5],
  [/(?:шест|sest|shest)(?![\p{L}\p{N}])/iu, 6],
  [/(?:седум|sedum)(?![\p{L}\p{N}])/iu, 7],
  [/(?:осум|osum)(?![\p{L}\p{N}])/iu, 8],
  [/(?:девет|devet)(?![\p{L}\p{N}])/iu, 9],
  [/(?:десет|deset)(?![\p{L}\p{N}])/iu, 10],
  [/(?:единаесет|edinaeset)(?![\p{L}\p{N}])/iu, 11],
  [/(?:дванаесет|dvanaeset)(?![\p{L}\p{N}])/iu, 12],
];
export const HALF_CLOCK_RE =
  /(?<![\p{L}\p{N}])(еден|една|два|три|четири|пет|шест|седум|осум|девет|десет|единаесет|дванаесет|eden|edna|dva|tri|cetiri|pet|sest|shest|sedum|osum|devet|deset|edinaeset|dvanaeset)\s+(?:и|i)\s+(?:пол|pol)(?:а|a|овина)?(?![\p{L}\p{N}])(?!\s*(?:спалн|spaln|соби|sobi|лежа|krev))/iu;

/** The hour of a spoken half-hour ("пет и пол" → 5), or undefined. */
export function halfClockHour(t: string): number | undefined {
  const m = t.match(HALF_CLOCK_RE);
  if (!m) return undefined;
  const word = m[1].toLowerCase();
  for (const [re, h] of HOUR_WORDS) if (re.test(word)) return h;
  return undefined;
}

// DIGIT half-hour — "7ipol" / "7 и пол" / "velmi 7 i pol" (the [19:29]
// owner counter: "Cetvrtok vo 7ipol ?"). HALF_CLOCK_RE only knows hour WORDS
// ("седум и пол"), so the digit form fell through to DAY_TRAILING_HOUR_RE,
// which read the bare "7" as 7:00 — the :30 vanished and the counter relay
// told the client "Четврток во 7". Same room-noun veto as the word form
// ("две и пол спални" is a bedroom count, never a clock).
export const DIGIT_HALF_RE =
  /(?<![\p{L}\p{N}])(\d{1,2})\s*(?:и|i)?\s*(?:пол|pol)(?:а|a|овина)?(?![\p{L}\p{N}])(?!\s*(?:спалн|spaln|соби|sobi|лежа|krev))/iu;

function digitHalfClock(t: string): { 1: string; length: number } | null {
  const m = t.match(DIGIT_HALF_RE);
  return m ? { 1: m[1], length: 2 } : null;
}

// DIGIT + "и" + MINUTES — «5 I 30» / «5 и 30» = 5:30 (the [13:16] capture: the
// client answered the exact-hour ask with «NEKA BIDE 5 I 30» and the funnel
// repeated the whole term question, because no family covered an hour digit, a
// conjunction and the minutes). The minutes must be TWO digits, and the clock
// must not run into a word: «5 и 30 стана» is a count and «5 и 30 евра» is
// money, so neither can ever be read as a clock.
export const DIGIT_MINUTES_RE =
  /(?<![\p{L}\p{N}])(\d{1,2})\s*(?:и|i)\s*(\d{2})(?![\d\p{L}])(?!\s*(?:спалн|spaln|соби|sobi|стан|stan|стана|stana|евр|evr|eur|ден|den|м2|m2|кв|kv))/iu;

// THE SPOKEN QUARTERS AND THE HALF-TO — the same "x past y" arithmetic said
// with words instead of digits: «пет и четврт» (5:15), «без четврт пет»
// (4:45), «без 15 пет» (4:45), «пол 6» (5:30 — Macedonian "half TO six", the
// mirror of «6 и пол» = 6:30, which HALF_CLOCK_RE already owns). The hour
// token is a word OR digits, and the same room/money veto as the digit
// families stops «5 и четврт спални» from reading as a clock.
const SPOKEN_HOUR_SRC =
  '(еден|една|два|три|четири|пет|шест|седум|осум|девет|десет|единаесет|дванаесет'
  + '|eden|edna|dva|tri|cetiri|pet|sest|shest|sedum|osum|devet|deset|edinaeset|dvanaeset'
  + '|\\d{1,2})';
const CLOCK_NOUN_SRC = '(?:четврт|четвртина|петнаесет|петнаест|cetvrt|cetvrtina|petnaeset|15)';
const CLOCK_UNIT_VETO = '(?!\\s*(?:спалн|spaln|соби|sobi|стан|stan|стана|stana|евр|evr|eur|ден|den|м2|m2|кв|kv))';
export const QUARTER_PAST_RE = new RegExp(
  '(?<![\\p{L}\\p{N}])' + SPOKEN_HOUR_SRC + '\\s+(?:и|i)\\s+' + CLOCK_NOUN_SRC + '(?![\\p{L}\\p{N}])' + CLOCK_UNIT_VETO, 'iu');
export const QUARTER_TO_RE = new RegExp(
  '(?<![\\p{L}\\p{N}])(?:без|bez)\\s+' + CLOCK_NOUN_SRC + '\\s+' + SPOKEN_HOUR_SRC + '(?![\\p{L}\\p{N}])' + CLOCK_UNIT_VETO, 'iu');
export const HALF_TO_RE = new RegExp(
  '(?<![\\p{L}\\p{N}])(?:пол|пола|pol|pola)\\s+' + SPOKEN_HOUR_SRC + '(?![\\p{L}\\p{N}])' + CLOCK_UNIT_VETO, 'iu');

// A RANGE names two clocks. PER THE PINNED CONTRACT a CLOSED range («од 17:00
// до 19:00», «5-7», «меѓу 5 и 7») is a concrete TERM that starts at its first
// clock — the [23:48] rule re-asks only the OPEN window («од 5 па натака»),
// because a window start there is availability, not an appointment. The range
// is still a family of its own so the FIRST number is what the parser reads
// (a bare «5-7» has no preposition for CLOCK_RE to bind).
const RANGE_NUM = '(?:\\d{1,2}(?:[.:]\\d{2})?)';
// Group 1 = the start of an "од X до Y" / "X-Y" range, group 2 = the start of
// a "меѓу X и Y" range — the parser reads whichever alternative fired.
export const TIME_RANGE_RE = new RegExp(
  '(?<![\\p{L}\\p{N}])(?:од\\s+|od\\s+)?(' + RANGE_NUM + ')\\s*(?:до|do|[-–—])\\s*' + RANGE_NUM
  + '(?![\\p{L}\\p{N}])' + CLOCK_UNIT_VETO
  + '|(?<![\\p{L}\\p{N}])(?:меѓу|megju|помеѓу|pomegju)\\s+(' + RANGE_NUM + ')\\s+(?:и|i)\\s+' + RANGE_NUM
  + '(?![\\p{L}\\p{N}])' + CLOCK_UNIT_VETO, 'iu');
// A BARE clock "17:30" — legal only when the message carries no date (a bare
// HH:MM next to a date is ambiguous and the date wins).
const BARE_CLOCK_RE = /\b(\d{1,2})[:.](\d{2})\b/;

// Explicit date "11.06" / "11.06.2026" / "12/7" — strict: month must be 1-12.
const DATE_RE = /(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?/;

// Time-of-day words, LONGEST FIRST: "попладне" contains "пладне" and
// "претпладне" contains "пладне" — the alternation must never let the short
// word shadow the long one.
const PART_RE =
  /(наутро|наутрото|утрово|утрина|nautro|utrovo|претпладне|pretpladne|попладне|popladne|навечер|вечерва|вечер|navecer|vecer|пладне|на пладне|pladne|на полноќ|polnok)/i;

// DAY + TRAILING BARE HOUR ("PONEDELIK 6", "сабота 6", "петок 19") — the day
// names the day and the trailing digit IS the clock, no prefix and no hour
// word. The [12:42] transcript: "PONEDELIK 6" parsed as day-ONLY, the funnel
// re-asked the hour the client had already given, and the follow-up "6" then
// completed against a stale day. Guards: up to 20 non-digit chars between
// ("VO PONEDELNIK MOZAM 6"), the hour must not run into a longer number or a
// clock/date ("петок 11.06" stays a date), and no money tail ("sabota 350
// evra" is a budget). Same visit-window rule as the hour-word form: 1–8 are PM,
// 9–12 stay as said (see visitClockHour).
export const DAY_TRAILING_HOUR_RE =
  new RegExp(
    '(?:понеделн|понедник|понеделк|понеделок|вторн|вторик|втрик|сред[аи]|сретта|срета|средта|четврт|цетврт|петочн|петок|петк|сабот|сабта|субота|недел|задутре|утре|денес|викенд'
    +    '|ponedelnik|ponednik|ponedelk|ponedelok|ponedelik|ponedenik|vtorn|vtorik|vtrik|sred|sredta|sreta|cetvrt|četvrt|petocn|petok|petk|sabot|sabta|subota|nedel|zadutre|utre|denes|vikend)'
    + '[^\\d]{0,20}(\\d{1,2})(?![\\d:.])(?!\\s*(?:евр|eur|evr|ден|mkd|kv|кв|м2|m2))',
    'iu');

// ASSENT + BARE HOUR — «PA NEKA BIDE 5» (the [18:49] capture). The client
// answered the exact-hour ask ("Во колку часот планирате да дојдете?") with a
// consent frame and a naked digit; no family above knows it (CLOCK_RE wants a
// preposition, HOUR_WORD_RE wants the hour noun), so the term read as NO TIME
// at all and the funnel re-asked the whole visit question — a time the client
// had just given. The frame («нека биде / нека е / ајде нека биде», optionally
// after «па») anchors the digit as a CLOCK, exactly like the hour noun does.
// The visit window decides AM/PM downstream (5 → 17:00, see visitClockHour),
// and a money/room tail is vetoed so «neka bide 5 iljadi» or «neka bide 5
// spalni» can never become an appointment.
export const ASSENT_HOUR_RE =
  /(?<![\p{L}\p{N}])(?:(?:pa|па)\s+)?(?:(?:ajde|ајде)\s+)?(?:neka|нека)\s+(?:bide|биде|e|е)\s+(?:(?:vo|во|na|на|okolu|околу)\s+)?(\d{1,2})(?![\d:.,])(?!\s*(?:евр|evr|eur|€|ден|den|илјад|iljad|хилјад|спалн|spaln|соби|sobi|%|кат|спрат|м2|m2|кв|kv))/iu;

/** True when the phrase carries a PART-OF-DAY word (попладне, утрово,
 *  вечер…). A day+period term ("утре попладне") resolves to a concrete
 *  hour — specific enough for the owner; a bare day ("во понеделник")
 *  is not (the split [14:35] intake asks the exact clock). */
export function hasPeriodHint(s: string): boolean {
  return PART_RE.test(s);
}

function partHour(t: string): number | undefined {
  if (/(наутро|утрово|утрина|nautro|utrovo)/i.test(t)) return 9;
  if (/(претпладне|pretpladne)/i.test(t)) return 10;
  if (/(попладне|popladne)/i.test(t)) return 16;
  if (/(пладне|pladne)/i.test(t)) return 12;
  if (/(навечер|вечерва|вечер|navecer|vecer)/i.test(t)) return 19;
  if (/(полноќ|polnok)/i.test(t)) return 0;
  return undefined;
}

function dayOfWeekFrom(t: string): number | undefined {
  for (const [re, d] of DAY_WORDS) if (re.test(t)) return d;
  return undefined;
}

// The list-order day scan walked the TABLE, not the text: in the owner's
// counter "ne mozam bas vtornik . Cetvrtok vo 7ipol ?" (the [19:29] capture)
// вторник's regex was checked first and won, so the counter resolved to the
// REFUSED day — the relay said "Вторник" where the owner proposed Четврток.
const DAY_SCAN_RE = new RegExp(DAY_WORDS.map(([re]) => re.source).join('|'), 'giu');

/** The OFFERED day, not the first day word the table happens to match. With
 *  two day words in the text (refusal frame + counter offer) and a clock
 *  clause, the day whose END sits nearest the clock digits is the offered
 *  one ("cetvrtok vo 7ipol" → четврток); a distance tie goes to the LATER
 *  match (an offer always reads after the refusal it counters). No clock or
 *  a single day word keeps the legacy first-match behavior. */
function offeredDow(t: string, digitIndex?: number): number | undefined {
  if (digitIndex === undefined) return dayOfWeekFrom(t);
  let best: { dow: number; index: number; dist: number } | undefined;
  for (const m of t.matchAll(DAY_SCAN_RE)) {
    const dow = dayOfWeekFrom(m[0]);
    if (dow === undefined || m.index === undefined) continue;
    const dist = Math.abs(digitIndex - (m.index + m[0].length));
    if (!best || dist < best.dist || (dist === best.dist && m.index > best.index)) {
      best = { dow, index: m.index, dist };
    }
  }
  return best?.dow ?? dayOfWeekFrom(t);
}

function relOffset(t: string): number | undefined {
  if (/(задутре|zadutre)/i.test(t)) return 2;
  if (/(утре|utre)/i.test(t)) return 1;
  if (/(денес|денеска|denes|deneska)/i.test(t)) return 0;
  return undefined;
}

function nextWeekday(dow: number, from: Date): Date {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const diff = (dow - d.getDay() + 7) % 7;
  d.setDate(d.getDate() + (diff === 0 ? 7 : diff)); // always the NEXT occurrence
  return d;
}

/** Resolve a free-text visit time to a concrete Date, or undefined. */
export function parseVisitDateTime(text: string, now = new Date()): Date | undefined {
  const t = text.trim();
  if (!t) return undefined;

  const date = t.match(DATE_RE);
  const day = Number(date?.[1] ?? NaN);
  const month = Number(date?.[2] ?? NaN);
  const hasDate = date && day >= 1 && day <= 31 && month >= 1 && month <= 12;
  const explicitYear = !!(date?.[3]); // "11.06.2026" vs implied "11.06"

  // Clock with a time-word prefix ("во 17:30", "околу 10") — the prefix is
  // required so "11.06" reads as a date. A BARE "17:30" counts only when the
  // message has no date at all (otherwise "17.30" would be 17 July).
  // DAY+TRAILING-HOUR arm ("PONEDELIK 6"): a bare trailing digit after a day
  // word is the clock — tried FIRST so it beats the date arm on "петок 11.06"
  // (the trailing-hour regex itself vetoes clock/date tails there).
  let hour: number | undefined;
  const hc = halfClockHour(t);
  const th = t.match(DAY_TRAILING_HOUR_RE);
  const hw = hourWordClock(t);
  const dhm = t.match(DIGIT_HALF_RE); // "7ipol" — :30 wins over the bare digit
  const dm = t.match(DIGIT_MINUTES_RE); // "5 i 30" = 5:30 (the [13:16] capture)
  const qp = t.match(QUARTER_PAST_RE); // "пет и четврт" = 5:15
  const qt = t.match(QUARTER_TO_RE); // "без четврт пет" = 4:45
  const ht = t.match(HALF_TO_RE); // "пол 6" = 5:30
  const rg = t.match(TIME_RANGE_RE); // closed range → its FIRST clock
  const ah = t.match(ASSENT_HOUR_RE); // «PA NEKA BIDE 5» — consent frame + digit
  const clock = hw ?? th ?? t.match(CLOCK_RE);
  if (hc !== undefined) {
    hour = hc * 60 + 30; // "пет и пол" = 5:30
  } else if (dhm) {
    const h = Number(dhm[1]); // "7ipol" / "7 и пол" = 7:30 (see DIGIT_HALF_RE)
    if (h >= 0 && h <= 23) hour = h * 60 + 30;
  } else if (dm) {
    const h = Number(dm[1]);
    const m = Number(dm[2]);
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) hour = h * 60 + m;
  } else if (qt) {
    const h = spokenHour(qt[1]); // "bez cetvrt pet" = 4:45 (one hour back)
    if (h !== undefined) hour = ((h + 23) % 24) * 60 + 45;
  } else if (qp) {
    const h = spokenHour(qp[1]); // "pet i cetvrt" = 5:15
    if (h !== undefined) hour = h * 60 + 15;
  } else if (ht) {
    const h = spokenHour(ht[1]); // "pol 6" = 5:30 (half TO six)
    if (h !== undefined) hour = ((h + 23) % 24) * 60 + 30;
  } else if (rg && (rg[1] ?? rg[2])) {
    // A closed range starts at its first clock («5-7» → 5, «5:00 - 7:00» → 5:00,
    // «меѓу 5 и 7» → 5 — the [23:48] contract: only an OPEN window is vague).
    // The capture may carry minutes («17:00»), so the HOUR is the part before
    // the separator.
    const h = Number(String(rg[1] ?? rg[2]).split(/[.:]/)[0]);
    if (h >= 0 && h <= 23) hour = h * 60;
  } else if (ah) {
    // «PA NEKA BIDE 5»: the consent frame owns the digit as an hour (the
    // [18:49] capture). Minutes are absent — the visit window shifts 1–8 PM
    // exactly like every other bare clock.
    const h = Number(ah[1]);
    if (h >= 0 && h <= 23) hour = h * 60;
  } else if (clock) {
    const h = Number(clock[1]);
    const m = clock[2] ? Number(clock[2]) : 0;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59) hour = h * 60 + m;
  } else if (!hasDate) {
    const bare = t.match(BARE_CLOCK_RE);
    if (bare) {
      const h = Number(bare[1]);
      const m = Number(bare[2]);
      if (h >= 0 && h <= 23 && m >= 0 && m <= 59) hour = h * 60 + m;
    }
  }
  const part = partHour(t);
  if (hour === undefined && part !== undefined) hour = part * 60; // part is an HOUR
  // THE VISIT WINDOW DECIDES AM/PM (see visitClockHour): a bare 1–8 is an
  // afternoon/evening clock, so "во 8" is 20:00, "7:30" is 19:30 and "6 IPOL"
  // is 18:30 — the [17:45] capture had "POKASNO 7:30" relayed to the owner as
  // 07:30. The rule replaced four separate ad-hoc shifts (hour-word, day-adjacent,
  // part-word and prefixed-clock) that each covered a different spelling and
  // none of them covered a bare clock after «покасно». A MORNING word is the
  // only opt-out: "понеделник утрово во 9" stays 09:00, and "во 8 наутро" is
  // 08:00 — which the window then refuses below.
  if (hour !== undefined && !MORNING_WORD_RE.test(t)) {
    const h = Math.floor(hour / 60);
    const m = hour % 60;
    hour = visitClockHour(h) * 60 + m;
  }
  // OUTSIDE THE VISIT WINDOW IS NOT A VISIT: no viewings before 09:00 or after
  // 21:00 (the owner's rule). Checked HERE, before any date is built, so the
  // bare-clock branch (which returns early) obeys it too — "во 8 наутро" was
  // accepted as 08:00 and "во 22:00" as 22:00.
  if (hour !== undefined && !isVisitClock(hour)) return undefined;

  // Day pick: with several day words, the day that RIDES the clock clause is
  // the offered one — the digits' absolute position is the anchor (the
  // [19:29] owner counter: "ne mozam bas vtornik . Cetvrtok vo 7ipol ?" must
  // resolve to Четврток, not the Вторник the refusal frame names).
  const digitMatch = dhm ?? th ?? (clock && 'index' in (clock as RegExpMatchArray) ? clock : null);
  let digitIndex: number | undefined;
  if (digitMatch && digitMatch[1] && typeof (digitMatch as RegExpMatchArray).index === 'number') {
    const mm = digitMatch as RegExpMatchArray;
    const at = mm.index! + mm[0].indexOf(mm[1]);
    if (Number.isFinite(at)) digitIndex = at;
  }
  const dow = offeredDow(t, digitIndex);
  const rel = relOffset(t);

  let base: Date | undefined;
  if (hasDate) {
    let year = explicitYear ? Number(date![3]) : now.getFullYear();
    if (year < 100) year += 2000;
    base = new Date(year, month - 1, day);
    // An IMPLIED year in the past ("5.1" said in summer) means next year; an
    // explicit one ("11.06.2026") is the client's stated date — respected.
    if (!explicitYear && base.getTime() < new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()) {
      base.setFullYear(base.getFullYear() + 1);
    }
  } else if (dow !== undefined) {
    // A weekday named for TODAY (with a time still ahead) means today; the
    // same weekday otherwise means the next occurrence.
    if (dow === now.getDay()) {
      base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else {
      base = nextWeekday(dow, now);
    }
    // "утре петок" — the relative word wins when it IS that weekday today.
    if (rel !== undefined && now.getDay() === dow) {
      base.setDate(base.getDate() + rel);
    }
  } else if (rel !== undefined) {
    base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    base.setDate(base.getDate() + rel);
  }

  if (!base) {
    // Bare clock / time-of-day only: today if still in the future, else tomorrow.
    if (hour !== undefined) {
      const cand = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      cand.setMinutes(hour, 0, 0);
      if (cand.getTime() <= now.getTime()) cand.setDate(cand.getDate() + 1);
      return cand;
    }
    return undefined;
  }

  // A day alone ("задутре", "петок") defaults to midday.
  if (hour === undefined) hour = 12 * 60;
  base.setMinutes(hour, 0, 0);
  // A phrase that resolved into the past pushes forward: a weekday already
  // past this week -> next week; a relative day always lands ahead already.
  // An EXPLICIT date ("11.06.2026") is the client's stated day — respected.
  if (!explicitYear && base.getTime() <= now.getTime()) base.setDate(base.getDate() + 7);
  return base;
}

// --- formatting --------------------------------------------------------------
const MK_DAY_FMT = ['Недела', 'Понеделник', 'Вторник', 'Среда', 'Четврток', 'Петок', 'Сабота'];

export function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** "Петок, 11.06.2026 во 17:30" — the canonical visit display. */
export function formatVisitDate(d: Date): string {
  return `${MK_DAY_FMT[d.getDay()]}, ${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()} во ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** Capitalized Macedonian weekday of a resolved date ("Понеделник"). */
export function weekdayName(d: Date): string {
  return MK_DAY_FMT[d.getDay()];
}

/** True when the phrase carries an explicit clock: HH:MM, "во 6", the
 *  hour-word form "6 saat/6 саати/6 часот", or a day + trailing bare hour
 *  ("PONEDELIK 6" — the [12:42] split-intake must never re-ask that hour).
 *  Used by the owner-ask normalizer to decide whether the clock must be
 *  appended. */
// ── «ISTO VREME» — the clock the client is NOT naming ───────────────────────
//
// THE [20:31] CAPTURE: the owner could not do «Утре во 18:00», Lina asked the
// client for another term, and the client answered «CETVRTOK ISTO VREME MOZE ?»
// — Thursday at the SAME TIME. The day was read, the hour was not, so the
// funnel asked «во колку часот точно?» for a clock it had on the table, and the
// owner's ping went out as a bare day. A same-time reference donates the hour
// from the term already in play (the owner's counter first, then the term the
// client gave); the client only ever has to move ONE of the two.
const SAME_TIME_RE =
  /(?<![\p{L}\p{N}])(?:isto|исто|istoto|истото|istata|истата)\s+(?:vreme|време)|same\s+time|исто\s+време\s+како/iu;

/** True when the message reuses the CLOCK already on the table instead of
 *  naming one («isto vreme», «исто време», «same time»). */
export function detectSameTimeReference(s: string): boolean {
  return SAME_TIME_RE.test(s);
}

/** THE COMPLETION MERGE — one rule for every reader (visit_scheduling,
 *  time_confirm and both owner_checking legs). `donors` are the terms in play,
 *  most specific first (the owner's counter, then the client's proposal).
 *
 *  - a same-time reference takes the DAY from the message (or the donor) and
 *    the CLOCK from the donor;
 *  - a bare clock with no day takes the donor's day (never a TODAY collapse);
 *  - anything that already names a day or carries no clock is returned as-is. */
export function mergeVisitTerm(t: string, donors: Array<string | undefined>): string {
  const live = donors.filter((d): d is string => !!d && d.trim().length > 0);
  if (detectSameTimeReference(t)) {
    const withClock = live.find(d => hasClockHint(d));
    const withDay = live.find(d => extractDayWord(d) !== undefined);
    const day = extractDayWord(t) ?? (withDay ? extractDayWord(withDay) : undefined);
    const at = withClock ? parseVisitDateTime(withClock) : undefined;
    if (day && at) return `${day} во ${formatTimeOnly(at)}`;
    if (at) return `во ${formatTimeOnly(at)}`;
    if (day && withClock) return `${day} ${withClock.trim()}`;
    return t;
  }
  if (extractDayWord(t) !== undefined || !hasClockHint(t)) return t;
  const donorDay = live.map(d => extractDayWord(d)).find(Boolean);
  return donorDay ? `${donorDay} ${t.trim()}` : t;
}

export function hasClockHint(s: string): boolean {
  if (/\d{1,2}[:.]\d{2}\b/.test(s)) return true;
  if (HOUR_WORD_RE.test(s)) return true;
  if (HALF_CLOCK_RE.test(s)) return true;
  if (DIGIT_HALF_RE.test(s)) return true; // «6IPOL» / «7 и пол»
  if (DIGIT_MINUTES_RE.test(s)) return true; // «5 I 30» / «5 и 30»
  if (QUARTER_PAST_RE.test(s)) return true; // «пет и четврт»
  if (QUARTER_TO_RE.test(s)) return true; // «без четврт пет»
  if (HALF_TO_RE.test(s)) return true; // «пол 6» = 5:30
  if (TIME_RANGE_RE.test(s)) return true; // «од 5 до 7» — a window, not a term
  if (DAY_TRAILING_HOUR_RE.test(s)) return true;
  if (ASSENT_HOUR_RE.test(s)) return true; // «PA NEKA BIDE 5» (the [18:49] capture)
  return /(?:во|vo|на|na|околу|okolu|по|po|после|posle|од|od|накај|nakaj)\s*\d{1,2}\b/i.test(s);
}

/** Canonical Macedonian weekday named in the phrase ("VTORNIK" → "вторник"),
 *  or undefined. Used to donate a stored day to a clock-only follow-up. */
export function extractDayWord(s: string): string | undefined {
  for (const [re, d] of DAY_WORDS) if (re.test(s)) return MK_WEEKDAYS[d];
  return undefined;
}

// A relative day («утре», «денес») names the DAY just as concretely as a
// weekday — it must not be re-anchored onto the term on the table, and it must
// not be treated as "no day" (that would send the owner a needless re-ask).
const RELATIVE_DAY_RE =
  /(?<![\p{L}])(?:утре|utre|денес|denes|задутре|zadutre|другиот\s+ден|naredniot\s+den)(?![\p{L}])/iu;

/** Does the phrase name the DAY itself — a weekday in either script, a relative
 *  day, or an explicit date? THE [10:24] CONTRACT: a phrase that names a day is
 *  never re-anchored, and a phrase that names none must inherit the day on the
 *  table instead of being dated to TODAY (§ the owner-day carry in
 *  mergeOwnerTerm / normalizeOwnerTime). A dotted pair counts as a date only
 *  when it cannot be a clock (first part > 12) or carries a year — «18.10» is
 *  both shapes, and an ambiguous pair is safer read as a clock that inherits a
 *  day than as a date that invents one. */
export function namesADay(s: string): boolean {
  if (!s) return false;
  if (extractDayWord(s) !== undefined) return true;
  if (RELATIVE_DAY_RE.test(s)) return true;
  if (/(?<![\p{N}])\d{1,2}\s*[.\/]\s*\d{1,2}\s*[.\/]\s*\d{2,4}(?![\p{N}])/u.test(s)) return true; // 05.11.2026
  return /(?<![\p{N}])(?:[1-9]|[12]\d|3[01])\s*[.\/]\s*(?:0?[1-9]|1[0-2])(?![\p{N}.:])/u.test(s); // 18.10 (not 18.10 ч.)
}

/** "11.06.2026" — date only (used in the protocol messages). */
export function formatDateOnly(d: Date): string {
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** "17:30" — time only. */
export function formatTimeOnly(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
