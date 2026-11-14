// FIELD DATA IS APPEND-ONLY (AGENTS.md §5a).
//
// What happened: `tests/corpus/turns.jsonl` was created untracked, its header was
// re-authored from memory, and a script re-serialised the rows. The original
// header existed only in a terminal scrollback, so it is gone — unrecoverable
// from git (the file was never committed) and from every dangling blob.
//
// The cause was mechanical (an untracked file plus a rewrite script), so the
// guard is mechanical too: the header is pinned here byte for byte, and every
// non-comment line must be JSON that parses on its own. A rewrite that changes a
// byte of the header, or a re-serialiser that mangles an escape, fails HERE —
// against the shipped text — instead of being discovered in a capture weeks
// later.
//
// The rule this enforces is in AGENTS.md §5a: append a line, never rewrite the
// file, and commit a data file the moment it is created.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const CORPUS = path.join('tests', 'corpus', 'turns.jsonl');

const HEADER = [
  '// tests/corpus/turns.jsonl — captured turns, one JSON object per line.',
  '// Schema and rules: AGENTS.md §5a. Lines starting with // are comments; blanks are skipped.',
  '// APPEND-ONLY: a new capture is a new line. Never rewrite, reformat or re-serialise this file.',
].join('\n');

const corpusLines = (): string[] => {
  assert.ok(fs.existsSync(CORPUS), `${CORPUS} is missing — the corpus is a committed artifact, not scratch`);
  return fs.readFileSync(CORPUS, 'utf8').split('\n');
};

test('the corpus header is the shipped one, byte for byte', () => {
  const text = fs.readFileSync(CORPUS, 'utf8');
  assert.ok(text.startsWith(`${HEADER}\n`),
    'the corpus header was rewritten. Restore the three shipped lines (AGENTS.md §5a) — '
    + 'a narrative header re-authored from memory is invented prose pretending to be the original.');
});

test('every corpus line is a comment, blank, or one JSON object', () => {
  for (const [i, line] of corpusLines().entries()) {
    const at = `${CORPUS}:${i + 1}`;
    if (!line.trim()) continue;
    if (line.startsWith('//')) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      assert.fail(`${at} is not valid JSON — an append must write ONE whole line, '
        + 'never a parse/stringify round-trip of the file`);
    }
    assert.equal(typeof row, 'object', `${at} must be an object`);
    assert.ok(row !== null && !Array.isArray(row), `${at} must be an object`);
  }
});

test('corpus case ids are unique — an append never renumbers or merges a case', () => {
  const ids: string[] = [];
  for (const line of corpusLines()) {
    if (!line.trim() || line.startsWith('//')) continue;
    const row = JSON.parse(line) as { id?: string };
    if (row.id) ids.push(row.id);
  }
  assert.ok(ids.length > 0, 'the corpus must carry at least one case');
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `duplicate case ids: ${dupes.join(', ')}`);
});

test('the corpus declares the five dimensions §5a requires', () => {
  for (const line of corpusLines()) {
    if (!line.trim() || line.startsWith('//')) continue;
    const row = JSON.parse(line) as Record<string, unknown>;
    for (const field of ['id', 'turns', 'intent', 'stateDelta']) {
      assert.ok(field in row, `${String(row.id)}: missing "${field}"`);
    }
    assert.ok(Array.isArray(row.turns) && row.turns.length > 0, `${String(row.id)}: no turns`);
    assert.ok(Array.isArray(row.intent) && row.intent.length > 0, `${String(row.id)}: no intent`);
  }
});
