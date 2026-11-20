// THE BOOKINGS PANE'S TIME RULE (the owner's 2026-11-20 directive):
//   «visits schedules that passed should be grey in the tui. and not be counted
//    as remaining visits. active should be white.»
//
// The pane listed every confirmed row as «закажана» forever, so a visit from
// this morning read like work still ahead and the operator's count was wrong.
// `visit_at` is the confirmed instant (never the raw `time` text), and it is
// what splits the pane: upcoming = white and counted, past = grey, labelled
// «мината», and excluded from `останати`.
//
// A `finalized` row WITHOUT `visit_at` is still a negotiation — it keeps
// counting and is never greyed as past.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AppointmentRow } from '../src/store/appointments';
import { bookingsPaneModel } from '../src/tui/bookings';

const NOW = new Date(2026, 10, 20, 12, 0, 0, 0).getTime();
const HOUR = 3600_000;

function row(over: Partial<AppointmentRow>): AppointmentRow {
  return {
    id: 1, chatId: 'c', clientName: 'Тест', clientPhone: '070', propertyId: 50,
    service: 'buy', viewingFee: '500', status: 'finalized', time: '20.11 12:00',
    visitAt: null, agentPhone: null, createdAt: NOW,
    ...over,
  };
}

test('a past confirmed visit is grey and is not counted as remaining', () => {
  const past = row({ id: 1, propertyId: 42, visitAt: NOW - 3 * HOUR });
  const next = row({ id: 2, propertyId: 59, visitAt: NOW + 2 * HOUR });
  const negotiating = row({ id: 3, propertyId: 70, status: 'pending', time: null, visitAt: null, createdAt: NOW - HOUR });

  const model = bookingsPaneModel([past, next, negotiating], NOW);
  assert.equal(model.remaining, 1, 'only the hour still ahead counts');
  assert.match(model.lines[0]!, /останати: 1/u, model.lines[0]!);

  // The upcoming visit is plain white text…
  const nextLine = model.lines.find(l => l.includes('ЕБ 59')) ?? '';
  assert.ok(!nextLine.includes('{gray-fg}'), `an active visit is white: ${nextLine}`);
  // …the status label is the NEXT line (the pane's two-row block).
  const nextIdx = model.lines.findIndex(l => l.includes('ЕБ 59'));
  assert.match(model.lines[nextIdx + 1] ?? '', /закажана/u,
    `the upcoming visit says it is arranged: ${JSON.stringify(model.lines)}`);

  // …the past one is grey and marked as history…
  const pastLine = model.lines.find(l => l.includes('ЕБ 42')) ?? '';
  assert.match(pastLine, /\{gray-fg\}/u, `a passed visit is grey: ${pastLine}`);
  assert.ok(model.lines.some(l => l.includes('мината')), `the past row is labelled: ${JSON.stringify(model.lines)}`);

  // …the negotiation still counts and stays white (same two-row block)…
  const negIdx = model.lines.findIndex(l => l.includes('ЕБ 70'));
  assert.match(model.lines[negIdx + 1] ?? '', /во тек/u,
    `a negotiation is not a past visit: ${JSON.stringify(model.lines)}`);
  assert.ok(!model.lines[negIdx]!.includes('{gray-fg}'),
    `a negotiation is white: ${model.lines[negIdx]}`);

  // …and the reading order is work first, history last.
  const idx = (needle: string) => model.lines.findIndex(l => l.includes(needle));
  assert.ok(idx('ЕБ 59') < idx('ЕБ 70'), 'upcoming before negotiating');
  assert.ok(idx('ЕБ 70') < idx('ЕБ 42'), 'negotiating before past');
});

test('a calendar whose every visit has passed shows zero remaining', () => {
  const model = bookingsPaneModel([
    row({ id: 1, visitAt: NOW - HOUR }),
    row({ id: 2, visitAt: NOW - 5 * HOUR }),
  ], NOW);
  assert.equal(model.remaining, 0);
  assert.match(model.lines[0]!, /останати: 0/u);
  assert.equal(model.lines.filter(l => l.includes('{gray-fg}')).length >= 2, true,
    `every past row is grey: ${JSON.stringify(model.lines)}`);
});
