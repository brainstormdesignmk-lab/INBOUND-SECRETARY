// THE BOOKINGS PANE MODEL — what the operator reads in the lower-left pane.
//
// WHY IT IS A SEPARATE MODULE: the pane used to render inside App, where the
// only way to check it was a full pty boot. The owner's [2026-11-20] rule —
// a visit whose hour has PASSED is grey and no longer counts as remaining —
// is a rule about the DATA, so it lives here and is asserted directly.
//
// THE THREE GROUPS, in reading order:
//   • UPCOMING confirmed visits (soonest first) — white, they are the work;
//   • rows still being negotiated (`finalized` without `visit_at`) — white;
//   • PAST confirmed visits — grey, labelled «мината», and NOT counted in the
//     `останати` line: an hour that already passed is history, not a visit the
//     operator still has to attend.
//
// A `finalized` row without `visit_at` is a negotiation, not a past visit:
// `visit_at` is the only confirmed instant (see AppointmentStore), so it is
// never classified by `time` text.
import { AppointmentRow } from '../store/appointments';

export interface BookingsPaneModel {
  /** Confirmed visits whose hour is still ahead — the pane's counter. */
  remaining: number;
  /** Blessed-tagged lines, already in display order. */
  lines: string[];
}

const pad = (n: number): string => String(n).padStart(2, '0');

function whenText(at: number): string {
  const d = new Date(at);
  return `${pad(d.getDate())}.${pad(d.getMonth() + 1)} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function bookingsPaneModel(rows: AppointmentRow[], now: number): BookingsPaneModel {
  const confirmed = rows.filter(r => r.status === 'finalized' && r.visitAt);
  const upcoming = confirmed
    .filter(r => (r.visitAt ?? 0) >= now)
    .sort((a, b) => (a.visitAt ?? 0) - (b.visitAt ?? 0));
  const past = confirmed
    .filter(r => (r.visitAt ?? 0) < now)
    .sort((a, b) => (a.visitAt ?? 0) - (b.visitAt ?? 0));
  const pending = rows
    .filter(r => !(r.status === 'finalized' && r.visitAt))
    .sort((a, b) => b.createdAt - a.createdAt);

  const lines: string[] = [`{gray-fg}останати: ${upcoming.length}{/gray-fg}`];
  for (const r of upcoming) {
    lines.push(` ${whenText(r.visitAt!)} · ЕБ ${r.propertyId}`);
    lines.push('   закажана');
  }
  for (const r of pending) {
    lines.push(`  —  · ЕБ ${r.propertyId}`);
    lines.push('   во тек');
  }
  for (const r of past) {
    lines.push(`{gray-fg} ${whenText(r.visitAt!)} · ЕБ ${r.propertyId}{/gray-fg}`);
    lines.push('{gray-fg}   мината{/gray-fg}');
  }
  return { remaining: upcoming.length, lines };
}
