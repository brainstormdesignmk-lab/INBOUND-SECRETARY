// BATCH DAYS — the date headers the review tabs draw.
//
// Pinned here: rows are grouped by their LOCAL creation day, newest batch
// first, each group counts its own rows, order inside a day is preserved, and
// a row without a timestamp lands in the trailing "unknown" group instead of
// silently joining today's batch. Also: all four review categories expose the
// stamp the grouping reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { EnrichmentStore } from '../src/store/enrichment';
import { BankReview } from '../src/bank/review';
import { UNKNOWN_DATE, dayKey, dayLabel, groupByDay } from '../src/bank/dateGroups';

const at = (y: number, m: number, d: number, h = 12): number => new Date(y, m - 1, d, h).getTime();

test('groups by local day, newest first, counts each batch, keeps in-day order', () => {
  const rows = [
    { id: 4, createdAt: at(2026, 10, 20, 9) },
    { id: 3, createdAt: at(2026, 10, 19, 22) },
    { id: 2, createdAt: at(2026, 10, 19, 8) },
    { id: 1, createdAt: at(2026, 10, 18, 23) },
  ];
  const batches = groupByDay(rows);
  assert.deepEqual(batches.map(b => b.date), ['2026-10-20', '2026-10-19', '2026-10-18']);
  assert.deepEqual(batches.map(b => b.count), [1, 2, 1]);
  assert.deepEqual(batches[1].items.map(r => r.id), [3, 2], 'order inside a day is untouched');
});

test('a row with no timestamp is not counted into today', () => {
  const rows = [{ id: 1, createdAt: 0 }, { id: 2 }, { id: 3, createdAt: at(2026, 10, 20) }];
  const batches = groupByDay(rows);
  assert.equal(batches[0].date, '2026-10-20');
  assert.equal(batches[0].count, 1);
  assert.equal(batches.at(-1)!.date, UNKNOWN_DATE);
  assert.equal(batches.at(-1)!.count, 2);
});

test('dayKey is the local calendar day, dayLabel marks today and yesterday', () => {
  const noon = at(2026, 10, 21);
  assert.equal(dayKey(noon), '2026-10-21');
  assert.equal(dayKey(at(2026, 10, 21, 0)), '2026-10-21', 'midnight belongs to its own day');
  assert.equal(dayKey(undefined), UNKNOWN_DATE);
  assert.match(dayLabel('2026-10-21', 42, noon), /^2026-10-21 · денес · 42$/);
  assert.match(dayLabel('2026-10-20', 7, noon), /^2026-10-20 · вчера · 7$/);
  assert.match(dayLabel('2026-10-19', 3, noon), /^2026-10-19 · 3$/);
  assert.match(dayLabel(UNKNOWN_DATE, 5, noon), /^непознат датум · 5$/);
});

test('every review category carries the stamp the date headers group by', () => {
  const db = new Db(':memory:');
  const bank = new BankStore(db);
  const en = new EnrichmentStore(db);
  const review = new BankReview(db, bank, en);
  en.insert({
    chatId: 'c1', state: 'idle', eventType: 'LEARNED_RECALL',
    userMsg: 'kade e stanot?', replyText: 'Ќе проверам и ќе Ви кажам.', replySource: 'dynamic',
  });
  bank.addDynamic('dynamic:idle:stan', 'idle', 'kade e stanot?', 'Ќе проверам и ќе Ви кажам.');
  bank.addStagedVariant('learn.staged', 'Ова е предлог што чека одобрување.', 'test');
  bank.addVariant('learn.active', 'Ова веќе служи на клиенти.');

  const stamp = (cat: 'enrichment' | 'dynamic' | 'staged' | 'active'): number => review.list(cat)[0].createdAt;
  for (const cat of ['enrichment', 'dynamic', 'staged', 'active'] as const) {
    assert.ok(stamp(cat) > 0, `${cat} row has a real createdAt`);
    assert.match(dayKey(stamp(cat)), /^\d{4}-\d{2}-\d{2}$/);
  }
  // All four were created just now → exactly one batch day, holding all four.
  const all = [...review.list('enrichment'), ...review.list('dynamic'), ...review.list('staged'), ...review.list('active')];
  const batches = groupByDay(all);
  assert.equal(batches.length, 1);
  assert.equal(batches[0].count, 4);
  assert.equal(batches[0].date, dayKey(Date.now()));
  db.db.close();
});
