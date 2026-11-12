// THE VISIT CALENDAR — one agent, one day, hourly slots.
//
// The agency's visits are made by ONE agent, back to back: a visit lasts at
// most 30 minutes and the rest of the hour is travel to the next building, so
// the calendar's unit is a 60-minute SLOT that starts on the hour (the owner's
// 2026-11-11 brief). A slot is TAKEN once a term is confirmed; a negotiation
// holds it for a bounded time so two clients cannot be promised the same hour
// mid-negotiation.
//
// Everything here is pure arithmetic on epoch-ms hour starts: the handler reads
// the appointments, this module decides what is free and what to tell the
// client. No copy lives here except the small free-hour formatter.

import { VISIT_FIRST_HOUR, VISIT_LAST_HOUR } from './time';

export const SLOT_MINUTES = 60;
/** How long an unconfirmed negotiation holds its slot (the owner's #3 rule). */
export const NEGOTIATION_HOLD_MS = 20 * 60_000;

/** The hour starts (epoch ms) of every visit already on the books that day. */
export interface CalendarInput {
  /** Epoch ms at 00:00 of the visit day. */
  dayStart: number;
  /** Busy hour starts (epoch ms), one per taken slot. */
  busy: number[];
}

const HOUR_MS = 3600_000;

/** 00:00 of the day the given moment belongs to (local time, DST-safe). */
export function dayStartOf(when: Date): number {
  return new Date(when.getFullYear(), when.getMonth(), when.getDate()).getTime();
}

/** The hour start of a moment (visits are on the hour). */
export function slotStartOf(when: Date): number {
  return new Date(when.getFullYear(), when.getMonth(), when.getDate(), when.getHours()).getTime();
}

/** The visit-window hours (09..21) that are NOT busy that day, ascending. */
export function freeHours({ dayStart, busy }: CalendarInput): number[] {
  const taken = new Set(busy.map(b => new Date(b).getHours()));
  const out: number[] = [];
  for (let h = VISIT_FIRST_HOUR; h <= VISIT_LAST_HOUR; h++) {
    if (!taken.has(h)) out.push(h);
  }
  return out;
}

/** Is the hour of `when` already taken that day? */
export function isSlotTaken(when: Date, cal: CalendarInput): boolean {
  const start = slotStartOf(when);
  return cal.busy.some(b => Math.abs(b - start) < HOUR_MS / 2);
}

/**
 * The NEAREST FREE HOURS around a wanted hour — the honest answer to a client
 * who asked for an hour that is already taken: what is left BEFORE and AFTER,
 * never a bare "no". Returns up to two hours, nearest first, in the visit
 * window.
 */
export function freeHoursNear(when: Date, cal: CalendarInput, want = 2): number[] {
  const free = freeHours(cal);
  const hour = when.getHours();
  const sorted = [...free].sort((a, b) => {
    const da = Math.abs(a - hour);
    const db = Math.abs(b - hour);
    return da - db || a - b;
  });
  return sorted.slice(0, Math.max(1, want));
}

/** «15:00 и 17:00» — the free hours as the client reads them. */
export function formatFreeHours(hours: number[]): string {
  const hh = hours.map(h => `${String(h).padStart(2, '0')}:00`);
  if (hh.length === 0) return '';
  if (hh.length === 1) return hh[0]!;
  return `${hh.slice(0, -1).join(', ')} и ${hh[hh.length - 1]}`;
}

/**
 * The client asked for an hour somebody else already holds. One sentence: the
 * hour is taken, here is what is free — and the question that moves the funnel
 * (which of them suits him). Never «не може», never a silent re-ask of the
 * same hour.
 */
export function buildSlotTakenLine(wantHour: number, free: number[]): string {
  const hh = `${String(wantHour).padStart(2, '0')}:00`;
  if (free.length === 0) {
    return `${hh} часот е веќе зафатен, а тој ден немам друг слободен термин. Дали сакате да пробаме друг ден?`;
  }
  return `${hh} часот е веќе зафатен. Слободни се ${formatFreeHours(free)} часот — кој термин Ви одговара?`;
}
