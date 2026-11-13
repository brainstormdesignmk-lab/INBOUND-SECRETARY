// The review workflow always opens the canonical workstation master. Picking
// by mtime is unsafe: reading/opening a DB can update its mtime, and the two
// schema-identical files make the wrong choice invisible.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pickLiveDb, REVIEW_MASTER_DB } from '../src/bank/liveDb';
import { findProjectRoot } from './helpers/project-root';

function sandbox(): { dir: string; make: (name: string, at: number) => string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-live-db-'));
  fs.mkdirSync(path.join(dir, 'data'), { recursive: true });
  const make = (name: string, at: number): string => {
    const file = path.join(dir, 'data', name);
    fs.writeFileSync(file, 'x');
    fs.utimesSync(file, at / 1000, at / 1000);
    return file;
  };
  return { dir, make };
}

test('canonical master wins regardless of sibling recency or WAL activity', () => {
  const { dir, make } = sandbox();
  const tui = make('tui.db', 1_000_000);
  make('lina.db', 5_000_000);
  make('tui.db-wal', 9_000_000);
  assert.equal(REVIEW_MASTER_DB, path.join('data', 'tui.db'));
  assert.equal(pickLiveDb(dir), tui);
});

test('a missing canonical master still resolves to its expected path', () => {
  const { dir, make } = sandbox();
  make('lina.db', 2_000_000);
  assert.equal(pickLiveDb(dir), path.join(dir, REVIEW_MASTER_DB));
});

test('no database at all names the canonical master path', () => {
  const { dir } = sandbox();
  assert.equal(pickLiveDb(dir), path.join(dir, REVIEW_MASTER_DB));
});

test('the real project resolves to the canonical review DB', () => {
  // findProjectRoot, not `__dirname/..`: the bundled runner would hand
  // pickLiveDb dist-test/ and this assertion (which only checks the TAIL of the
  // path) would pass while naming a directory the review never reads.
  const picked = pickLiveDb(findProjectRoot());
  assert.match(picked, /data[\\/]tui\.db$/);
});
