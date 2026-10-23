/**
 * BATCH DAYS — one header per day a batch was generated, with its size.
 *
 * The review tabs are chronological logs: the cron writes a batch, an operator
 * pushes a batch, the digest stages a batch. Sorting by id alone showed the
 * newest rows but not WHICH RUN they belonged to or how big that run was, so
 * "when was this generated" could not be answered from the screen.
 *
 * Pure on purpose: the TUI only interleaves the rows this returns, so the
 * grouping/counting rule is unit-testable without blessed or a DB.
 *
 * Order: newest day first (the operator usually looks at the last run), rows
 * inside a day keep the order their query returned (already newest-first for
 * the queue/dynamic, and that order is the tie-breaker). Rows with no usable
 * timestamp go last under `UNKNOWN_DATE` — they are history, not a batch.
 */

export const UNKNOWN_DATE = 'непознат датум';

const pad = (n: number): string => String(n).padStart(2, '0');

/** Local calendar day of an epoch-ms stamp, `YYYY-MM-DD`, or UNKNOWN_DATE.
 *  Local, not UTC: a 01:00 Skopje import belongs to that day on this machine. */
export function dayKey(ts: number | null | undefined): string {
  if (typeof ts !== 'number' || !Number.isFinite(ts) || ts <= 0) return UNKNOWN_DATE;
  const d = new Date(ts);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export interface DatedBatch<T> {
  /** `YYYY-MM-DD`, or UNKNOWN_DATE for rows with no timestamp. */
  date: string;
  count: number;
  items: T[];
}

/** Group rows by the local day they were created, newest day first. */
export function groupByDay<T extends { createdAt?: number }>(
  items: readonly T[],
): DatedBatch<T>[] {
  const byDay = new Map<string, T[]>();
  for (const item of items) {
    const key = dayKey(item.createdAt);
    const bucket = byDay.get(key);
    if (bucket) bucket.push(item);
    else byDay.set(key, [item]);
  }
  const days = [...byDay.keys()].sort((a, b) => {
    if (a === UNKNOWN_DATE) return 1;
    if (b === UNKNOWN_DATE) return -1;
    // ISO dates compare lexicographically; descending = newest batch first.
    return b.localeCompare(a);
  });
  return days.map(date => ({
    date,
    count: byDay.get(date)!.length,
    items: byDay.get(date)!,
  }));
}

/** Header text for a batch day, e.g. `2026-10-19 · 42` or `2026-10-19 · денес · 42`. */
export function dayLabel(date: string, count: number, now: number = Date.now()): string {
  const suffix = date === UNKNOWN_DATE ? '' : date === dayKey(now) ? ' · денес' : date === dayKey(now - 86_400_000) ? ' · вчера' : '';
  return date === UNKNOWN_DATE ? `${date} · ${count}` : `${date}${suffix} · ${count}`;
}
