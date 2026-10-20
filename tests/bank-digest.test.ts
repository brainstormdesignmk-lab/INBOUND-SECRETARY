// THE NO-MODEL HALF, COMPILED (2026-10-21).
//
// The digest and the verbatim bind must be runnable where the data lives — the
// atoms — and those machines run dist/ with no tsx. So the logic sits in src/
// and these tests call the same entry point the atom calls
// (`main()` in src/scripts/relearnBank.ts), not a copy of it.
//
// Pinned here:
//   • digest folds groups into examples + STAGED variants and purges the tail;
//   • a bind file applies per line, refuses a key that cannot answer, and exits
//     non-zero while leaving refused rows pending;
//   • `main` returns undefined for commands it does not own, so the workstation
//     script can fall through to its LLM half;
//   • the TUI status rows report the budget and the backlog honestly.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { EnrichmentStore } from '../src/store/enrichment';
import { digestDynamic, parseBindFile } from '../src/store/digest';
import { main } from '../src/scripts/relearnBank';
import { loopStatusLines } from '../src/tui/status';
import { MAX_GENERATED_PER_SESSION } from '../src/llm/dynamicFallback';

const CLEAN = 'Секогаш почнуваме со преглед на документацијата. Дали сакате да организираме посета?';

function fresh(): { bank: BankStore; db: Db; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-digest-'));
  const db = new Db(path.join(dir, 'lina.db'));
  return { bank: new BankStore(db), db, dir };
}

test('digest: folds groups into examples + staged variants, purges the tail, marks serve rows', () => {
  const { bank, db, dir } = fresh();
  try {
    bank.addDynamic('dynamic:idle:a', 'idle', 'moze dogovori mi', CLEAN);
    bank.addDynamic('dynamic:idle:a', 'idle', 'mozhe dogovori mi', CLEAN);
    bank.addDynamic('dynamic:idle:b', 'idle', 'kade ima reptil tamu ?', CLEAN);
    new EnrichmentStore(db).insert({
      chatId: 't1', state: 'idle', eventType: 'LEARNED_RECALL',
      userMsg: 'moze dogovori mi', replyText: CLEAN, replySource: 'dynamic',
    });

    const r = digestDynamic(bank, db, 1);
    assert.equal(r.groups, 2, 'two dynamicSlug groups');
    assert.equal(r.examples, 3, 'every stored phrasing becomes retrieval material');
    assert.equal(r.staged, 2, 'one staged variant per group — review still gates prose');
    assert.equal(bank.stagedVariants().length, 2);
    assert.equal(r.purged, 2, 'keep=1 leaves the store a signal, not an archive');
    assert.equal(r.marked, 1, 'the dynamic serve row is marked processed');

    // Staged is NOT served: nothing reaches the response bank before review.
    assert.equal(bank.variants('dynamic:idle:a').length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bind-file: applies good lines, refuses a dead key, leaves refusals pending, exits 1', () => {
  const { bank, db, dir } = fresh();
  try {
    bank.addDynamic('dynamic:idle:x', 'idle', 'moze dogovori mi', CLEAN);
    bank.addDynamic('dynamic:idle:y', 'idle', 'kolku e provizijata?', CLEAN);
    bank.addDynamic('dynamic:idle:z', 'idle', 'TWO', CLEAN);

    const file = path.join(dir, 'binds.txt');
    fs.writeFileSync(file, [
      '# review session 2026-10-21',
      '1 visit.confirm.ask',
      '2=nope.key',
      '3 visit.confirm.ask   # TWO is too short — detector work',
      '',
    ].join('\n'));

    const code = main(['--bind-file', file], { bank, db });
    assert.equal(code, 1, 'a refused line makes the run non-zero');

    assert.equal(bank.retrieveExact('moze dogovori mi')?.key, 'visit.confirm.ask');
    const pending = bank.pendingDynamic().map(p => p.id).sort();
    assert.deepEqual(pending, [2, 3], 'only the successful bind retires its row');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('parse: comments, blanks, = and : separators; a malformed line is reported, not dropped', () => {
  const { entries, errors } = parseBindFile([
    '# header',
    '',
    '12 visit.confirm.ask',
    '13=visit.confirm.ask',
    '14 : visit.confirm.ask',
    'fifteen visit.confirm.ask',
    '15',
  ].join('\n'));
  assert.deepEqual(entries, [
    { id: 12, key: 'visit.confirm.ask' },
    { id: 13, key: 'visit.confirm.ask' },
    { id: 14, key: 'visit.confirm.ask' },
  ]);
  assert.equal(errors.length, 2);
  assert.match(errors[0], /line 6/);
});

test('main: returns undefined for commands it does not own', () => {
  const { bank, db, dir } = fresh();
  try {
    assert.equal(main(['--list'], { bank, db }), undefined);
    assert.equal(main(['--key', 'fee.ask.buy', '--text', 'x'], { bank, db }), undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pending + stats: the backlog is visible where the operator looks', () => {
  const { bank, db, dir } = fresh();
  try {
    bank.addDynamic('dynamic:idle:x', 'idle', 'moze dogovori mi', CLEAN);
    assert.equal(bank.stats().dynamicPending, 1);

    const code = main(['--pending'], { bank, db });
    assert.equal(code, 0, 'listing is not a failure');
    assert.equal(bank.pendingDynamic().length, 1, 'listing changes nothing');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('TUI status rows: budget left and backlog stated plainly', () => {
  const idle = loopStatusLines({ pending: 0, generated: 0 });
  assert.match(idle[0], new RegExp(`0/${MAX_GENERATED_PER_SESSION}`));
  assert.match(idle[1], /0 — сè е врзано/);

  const spent = loopStatusLines({ pending: 4, generated: 2 });
  assert.match(spent[0], /2\/3/);
  assert.match(spent[0], /преостанати 1/);
  assert.match(spent[1], /4 чекаат клуч/);

  // At the cap the remaining count must read 0, never negative.
  const capped = loopStatusLines({ pending: 1, generated: 9 });
  assert.match(capped[0], /9\/3/);
  assert.match(capped[0], /преостанати 0/);
});
