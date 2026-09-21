import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'fs';
import { mkdtempSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { setLearnedBank, pickVariant, retrieveVariant } from '../src/data/responseBank';

test('P0 meters: pickVariant records per-key hit/miss with last-serve timestamp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p0-meters-'));
  try {
    const bank = new BankStore(new Db(join(dir, 't.db')));
    setLearnedBank(bank);
    // Seed one variant for a.k (hit path) and leave b.k empty (miss path).
    bank.addVariant('a.k', 'Варианта за а');
    assert.ok(pickVariant('a.k', {}), 'a.k must serve');
    assert.equal(pickVariant('b.k', {}), undefined, 'b.k must miss');

    // retrieveVariant must NOT double-count: one pickVariant call = one row update.
    bank.addExample('a.k', 'колку чини станот');
    retrieveVariant('колку чини станот', {});

    const m = bank.db.db.prepare(
      `SELECT key, hits, misses, updated_at FROM bank_metrics ORDER BY key`
    ).all() as Array<{ key: string; hits: number; misses: number; updated_at: number }>;
    const a = m.find(r => r.key === 'a.k')!;
    const b = m.find(r => r.key === 'b.k')!;
    assert.equal(a.hits, 2, 'a.k: one direct serve + one retrieval serve');
    assert.equal(a.misses, 0);
    assert.equal(b.hits, 0);
    assert.equal(b.misses, 1);
    assert.ok(a.updated_at > 0, 'last-serve timestamp recorded');
    // Every bank_metrics row carries updated_at (fresh DBs via schema, old via ALTER migration).
    assert.ok(b.updated_at > 0);
  } finally {
    setLearnedBank(undefined);
    rmSync(dir, { recursive: true, force: true });
  }
});

test('P0 meters: ALTER migration backfills updated_at on pre-existing DBs', () => {
  const dir = mkdtempSync(join(tmpdir(), 'p0-mig-'));
  try {
    const dbFile = join(dir, 'old.db');
    // Simulate a production DB from before this change: old metrics schema + rows.
    const Database = require('better-sqlite3');
    const raw = new Database(dbFile);
    raw.exec(`CREATE TABLE bank_metrics (key TEXT PRIMARY KEY, hits INTEGER NOT NULL DEFAULT 0, misses INTEGER NOT NULL DEFAULT 0)`);
    raw.prepare(`INSERT INTO bank_metrics (key, hits, misses) VALUES ('legacy.k', 7, 3)`).run();
    raw.close();
    // Boot the real store over it — migration must add the column without data loss.
    const bank = new BankStore(new Db(dbFile));
    const row = bank.db.db.prepare(`SELECT hits, misses, updated_at FROM bank_metrics WHERE key='legacy.k'`).get() as { hits: number; misses: number; updated_at: number };
    assert.equal(row.hits, 7);
    assert.equal(row.misses, 3);
    assert.equal(row.updated_at, 0, 'legacy row backfilled with 0 until next serve');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
