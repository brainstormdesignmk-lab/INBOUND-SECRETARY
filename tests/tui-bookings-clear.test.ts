// THE BOOKINGS PANE'S TWO INVARIANTS (the owner's 2026-11-12 directive).
//
//  [09:52] the client asked for 17:00 and was told «17:00 часот е веќе зафатен»
//          — by a visit a PREVIOUS test chat had finalized. The answer was
//          correct about the calendar and wrong about the test run: nothing on
//          the screen showed that calendar, and nothing could clear it.
//
// The fix is deliberately NOT "reset the bookings at boot" — production must
// remember its visits across restarts. It is a MANUAL reset: the operator sees
// the arranged visits in the lower half of the left column and clears them with
// [F8] (two presses) when a test needs a clean slate.
//
// These are the parts a headless test can prove: the store's reset really frees
// the day calendar, and the column split is a real split (the first attempt used
// `bottom: '50%'`, which blessed never resolves — the leads box got
// `height: NaN` and drew nothing under its label, a blank client column that
// still looked "present").

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'stream';
import { Db } from '../src/store/db';
import { AppointmentStore } from '../src/store/appointments';
import { buildLayout } from '../src/tui/layout';

const DAY = new Date(2030, 0, 15, 17, 0, 0, 0).getTime();

function seeded(): { db: Db; store: AppointmentStore; id: number } {
  const db = new Db(':memory:');
  const store = new AppointmentStore(db);
  const id = store.insert({
    chatId: 'client-1', clientName: 'Тест', clientPhone: '070000000',
    propertyId: 50, service: 'buy', viewingFee: '500', time: '15.01 17:00', agentPhone: null,
  });
  store.markFinalized(id, '15.01 17:00');
  db.db.prepare(`UPDATE appointments SET visit_at = ? WHERE id = ?`).run(DAY, id);
  return { db, store, id };
}

test('the calendar really holds the visit — the taken-hour answer has a row behind it', () => {
  const { store } = seeded();
  const busy = store.listVisitsBetween(DAY - 3600_000, DAY + 3600_000);
  assert.equal(busy.length, 1, 'the finalized visit is what the day calendar reads');
  assert.equal(busy[0]!.eb, 50);
  assert.equal(busy[0]!.visitAt, DAY);
});

test('[F8] clears the calendar: the reset is real, and it reports what it removed', () => {
  const { store } = seeded();
  assert.equal(store.count(), 1);
  assert.equal(store.clearAll(), 1, 'the operator is told how many rows went');
  assert.equal(store.count(), 0);
  // THE POINT OF THE RESET: the hour is free again, so the next test turn is not
  // told «зафатен» by a booking from a previous run.
  assert.deepEqual(store.listVisitsBetween(DAY - 3600_000, DAY + 3600_000), []);
  // Clearing an empty calendar is a no-op, never a crash (a stray second press).
  assert.equal(store.clearAll(), 0);
});

test('a pending row is cleared too — the pane shows everything, so the reset takes everything', () => {
  const { store } = seeded();
  store.insert({
    chatId: 'client-2', clientName: 'Втор', clientPhone: '070000001',
    propertyId: 66, service: 'rent', viewingFee: '300', time: null, agentPhone: null,
  });
  assert.equal(store.count(), 2);
  assert.equal(store.clearAll(), 2);
  assert.equal(store.listAll().length, 0);
});

// ── the split itself ────────────────────────────────────────────────────────

function layoutAt(cols: number, rows: number): { boxes: any; output: any } {
  const input = new PassThrough(); (input as any).isTTY = true;
  const output = new PassThrough(); (output as any).isTTY = true;
  (output as any).columns = cols; (output as any).rows = rows;
  return { boxes: buildLayout('SPLIT-TEST', { input, output }), output };
}

for (const [cols, rows] of [[100, 40], [80, 24]] as const) {
  test(`the left column is split: clients above the visits at ${cols}x${rows}`, async () => {
    const { boxes } = layoutAt(cols, rows);
    boxes.leadsBox.setContent('▸ Клиент-1');
    boxes.bookingsBox.setContent(' 15.01 17:00 · ЕБ 50');
    await new Promise(r => setImmediate(r));

    const leads = boxes.leadsBox.lpos;
    const books = boxes.bookingsBox.lpos;
    assert.ok(leads && books, 'both panes are laid out');
    // A RESOLVED height, not NaN: this is the bug the first attempt shipped —
    // `bottom: '50%'` left the box with no height at all and its body blank.
    assert.ok(Number.isFinite(leads.yl) && leads.yl > leads.yi, `the client pane has real rows: ${JSON.stringify(leads)}`);
    assert.ok(Number.isFinite(books.yl) && books.yl > books.yi, `the bookings pane has real rows: ${JSON.stringify(books)}`);
    assert.ok(leads.yl - leads.yi >= 3 && books.yl - books.yi >= 3, 'both halves can show a labelled row and content');
    // Adjacent, no overlap, both between the top bar and the status bar.
    assert.equal(books.yi, leads.yl, 'the visits start exactly where the clients end');
    assert.ok(leads.yi >= 1 && books.yl <= rows - 1, 'neither pane runs into the top bar or the status bar');
    // Same column, and the chat is untouched to their right.
    assert.equal(books.xi, leads.xi);
    assert.equal(books.xl, leads.xl);
    assert.equal(boxes.chatBox.lpos.xi, leads.xl, 'the chat starts where the left column ends');

    const text = boxes.screen.lines.map((l: any) => l.map((c: any) => c[1]).join('')).join('\n');
    assert.ok(text.includes('┌─ КЛИЕНТИ'), 'the client pane keeps its name');
    assert.ok(text.includes('┌─ ПОСЕТИ'), 'the bookings pane has its own name');
  });
}

test('a resize re-splits the column instead of leaving the old geometry', async () => {
  const { boxes, output } = layoutAt(100, 40);
  await new Promise(r => setImmediate(r));
  const beforeSplit = boxes.bookingsBox.lpos.yi;
  // A resize is driven through the STREAM, the way the frame check (and a real
  // terminal) does it: blessed re-reads the stream's size in its own handler.
  output.rows = 24;
  output.emit('resize');
  await new Promise(r => setImmediate(r));
  const leads = boxes.leadsBox.lpos;
  const books = boxes.bookingsBox.lpos;
  assert.ok(books.yi < beforeSplit, `the split followed the shorter screen: ${books.yi} vs ${beforeSplit}`);
  assert.equal(books.yi, leads.yl, 'still adjacent after the resize');
  assert.ok(books.yl <= 24 - 1, `the visits pane stays above the status bar: ${JSON.stringify(books)}`);
});
