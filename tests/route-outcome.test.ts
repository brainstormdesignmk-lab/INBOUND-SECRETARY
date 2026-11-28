// PHASE 1 — OUTCOMES ARE THE LABEL (docs/classifier-build-runbook.md).
//
// The verdict is not the label. These tests pin every rule of the linker and
// the acceptance rule of the corpus: only a clean outcome is teachable, and a
// human correction outranks a pause.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/store/db';
import { ClassifyTurnStore } from '../src/store/classifyTurns';
import { classifyOutcome, isTeachable, OUTCOME_WINDOW_MS } from '../src/llm/routeOutcome';
import { linkOutcomes, buildCorpus, corpusStats } from '../src/scripts/routeCorpus';
import { normalizedKey } from '../src/store/capture';

const T = 1_700_000_000_000;

function verdict(event = 'STAY', state = 'idle', createdAt = T) {
  return { event, state, createdAt };
}

// ── Rules ───────────────────────────────────────────────────────────────────

test('a correction outranks a pause', () => {
  assert.equal(classifyOutcome(verdict(), undefined, true), 'corrected');
});

test('no follow-up inside the window is a clean turn', () => {
  assert.equal(classifyOutcome(verdict(), undefined, false), 'clean');
  assert.equal(
    classifyOutcome(verdict(), { event: 'STAY', state: 'idle', createdAt: T + OUTCOME_WINDOW_MS + 1 }, false),
    'clean',
    'a pause longer than the window is not a reaction',
  );
});

test('the same event twice is the client repeating himself', () => {
  assert.equal(
    classifyOutcome(verdict('STAY'), { event: 'STAY', state: 'idle', createdAt: T + 60_000 }, false),
    'repeat',
  );
});

test('a state change is a move', () => {
  assert.equal(
    classifyOutcome(verdict('DETAILS_PROVIDED', 'discovery'), {
      event: 'SEARCH_REQUESTED', state: 'presentation', createdAt: T + 5_000,
    }, false),
    'moved',
  );
});

test('a different event in the same state is only a follow-up', () => {
  assert.equal(
    classifyOutcome(verdict('DETAILS_PROVIDED', 'discovery'), {
      event: 'INTERESTED', state: 'discovery', createdAt: T + 5_000,
    }, false),
    'followup',
  );
});

test('only clean outcomes may teach', () => {
  assert.equal(isTeachable('clean'), true);
  for (const o of ['corrected', 'repeat', 'moved', 'followup', 'unknown'] as const) {
    assert.equal(isTeachable(o), false, `${o} must not teach a route`);
  }
});

test('a backwards clock is unknown, not clean', () => {
  assert.equal(
    classifyOutcome(verdict(), { event: 'STAY', state: 'idle', createdAt: T - 1 }, false),
    'unknown',
  );
});

// ── Linker ──────────────────────────────────────────────────────────────────

function seed(store: ClassifyTurnStore, chatId: string, rows: Array<{ at: number; event: string; state?: string; text?: string }>): void {
  for (const r of rows) {
    const id = store.insert({
      chatId, state: r.state ?? 'idle', text: r.text ?? 'T',
      // The REAL seam stores normalizedKey(text) — the linker compares a
      // correction's question with this exact identity, so the fixture must
      // use the same fold or it tests a string that production never writes.
      norm: normalizedKey(r.text ?? 'T'), sig: '{}', sigKey: 'k',
      event: r.event, tier: 'remote', latencyMs: 10,
    });
    // The store stamps Date.now(); rewrite the timestamp so the window rules
    // are exercised with controlled distances.
    store['db'].db.prepare('UPDATE classify_turns SET created_at = ? WHERE id = ?').run(r.at, id);
  }
}

test('the linker labels a silent turn clean and a repeat as repeat', () => {
  const db = new Db(':memory:');
  const store = new ClassifyTurnStore(db);
  seed(store, 'a', [
    { at: T, event: 'STAY' },
    { at: T + 30_000, event: 'STAY' },
    { at: T + OUTCOME_WINDOW_MS + 60_000, event: 'SEARCH_REQUESTED' },
  ]);
  const stats = linkOutcomes(db, store);
  assert.equal(stats.linked, 3);
  const rows = store.forChat('a', 10).reverse();
  assert.equal(rows[0]?.outcome, 'repeat');
  // The middle row's successor is BEYOND the window (> 10 min), so the
  // conversation had paused: it is clean, not a repeat. Getting this wrong is
  // exactly how a linker would teach a route from a client who simply left.
  assert.equal(rows[1]?.outcome, 'clean', 'a gap beyond the window is a pause');
  assert.equal(rows[2]?.outcome, 'clean', 'the last row has no successor in the window');
});

test('a bank correction on the same question marks the row corrected', () => {
  const db = new Db(':memory:');
  const store = new ClassifyTurnStore(db);
  seed(store, 'b', [{ at: T, event: 'FEE_AGREED', text: 'DOGOVORI MI' }]);
  db.db.prepare('INSERT INTO bank_corrections (key, msg, reply, reason, created_at) VALUES (?,?,?,?,?)')
    .run('fee.ask', 'dogovori mi', 'wrong answer', 'client-said-wrong-answer', T + 1_000);
  linkOutcomes(db, store);
  assert.equal(store.forChat('b', 1)[0]?.outcome, 'corrected');
});

test('linking is idempotent and never relinks a row', () => {
  const db = new Db(':memory:');
  const store = new ClassifyTurnStore(db);
  seed(store, 'c', [{ at: T, event: 'STAY' }]);
  linkOutcomes(db, store);
  const before = store.forChat('c', 1)[0]?.outcome;
  const second = linkOutcomes(db, store);
  assert.equal(second.linked, 0, 'a linked row is not in the work queue');
  assert.equal(store.forChat('c', 1)[0]?.outcome, before);
});

// ── Corpus ──────────────────────────────────────────────────────────────────

test('the corpus contains clean rows only, with their route identity', () => {
  const db = new Db(':memory:');
  const store = new ClassifyTurnStore(db);
  seed(store, 'd', [
    { at: T, event: 'STAY' },
    { at: T + 1_000, event: 'STAY' },
  ]);
  linkOutcomes(db, store);
  const rows = buildCorpus(store);
  assert.equal(rows.length, 1, 'only the last (clean) row is teachable');
  assert.equal(rows[0]?.outcome, 'clean');
  assert.equal(rows[0]?.event, 'STAY');
  assert.ok(rows[0]?.sigKey);
  assert.ok(rows[0]?.norm);
});

test('corpus stats expose repeat coverage honestly', () => {
  const rows = [
    { norm: 'a', state: 'idle', sigKey: 'k', event: 'STAY', tier: 'det' as const, outcome: 'clean', createdAt: T },
    { norm: 'a', state: 'idle', sigKey: 'k', event: 'STAY', tier: 'det' as const, outcome: 'clean', createdAt: T + 86_400_000 },
    { norm: 'b', state: 'discovery', sigKey: 'k2', event: 'DETAILS_PROVIDED', tier: 'remote' as const, outcome: 'clean', createdAt: T },
  ];
  const s = corpusStats(rows);
  assert.equal(s.total, 3);
  assert.equal(s.distinctIdentities, 2);
  assert.equal(s.repeatedIdentities, 1);
  assert.equal(s.byState.discovery, 1);
});
