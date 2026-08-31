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

const DAY_WORDS: Array<[RegExp, number]> = [
  [/(понеделни|ponedelnik)/i, 1],
  [/(вторни|vtornik)/i, 2],
  [/(сред[аи]|sred[аa])/i, 3],
  [/(четврто|четврток|cetvrtok)/i, 4],
  [/(петочни|петок|petok)/i, 5],
  [/(саботи|сабота|sabota)/i, 6],
  [/(недели|недела|nedela)/i, 0],
];

const REL_DAY_RE = /(задутре|zadutre|утре|utre|денес|денеска|denes|deneska)/i;

// A clock WITH a time-word prefix: "во 17:30", "во 11", "околу 10". The prefix
// is REQUIRED so "11.06" (a date) is never read as 11:06.
const CLOCK_RE = /(?:во|vo|околу|okolu|по|po|после|posle)\s*(\d{1,2})(?:[:.](\d{2}))?\b/i;
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
  let hour: number | undefined;
  const clock = t.match(CLOCK_RE);
  if (clock) {
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
  // PM context adjustment: "попладне после 6" = 18:00, not 06:00.
  // When a bare "после N" (no HH:MM) is parsed and the text carries a PM
  // context word (попладне/вечер/навечер), shift the hour to PM if it's < 12.
  if (hour !== undefined && part !== undefined && part >= 12 && hour < 12 * 60) {
    const h = Math.floor(hour / 60);
    if (h >= 1 && h <= 11 && /(?:после|posle)/i.test(t) && !/\d{1,2}[:.]\d{2}/.test(t)) {
      hour = (h + 12) * 60;
    }
  }
  if (hour === undefined && part !== undefined) hour = part * 60; // part is an HOUR

  const dow = dayOfWeekFrom(t);
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

/** "11.06.2026" — date only (used in the protocol messages). */
export function formatDateOnly(d: Date): string {
  return `${pad2(d.getDate())}.${pad2(d.getMonth() + 1)}.${d.getFullYear()}`;
}

/** "17:30" — time only. */
export function formatTimeOnly(d: Date): string {
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}
