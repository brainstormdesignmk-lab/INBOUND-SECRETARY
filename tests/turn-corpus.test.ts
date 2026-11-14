// PHASE 1 — every line of tests/corpus/turns.jsonl is a test.
//
// The corpus asserts what the prose tests could not: which lane answered, which
// property the answer is about, which sanctioned facts it must carry, what it
// must never say, and what the turn did to the session. See
// tests/helpers/turn-corpus.ts for the engine and the case schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadCorpus, assertCorpusCase, CORPUS_PATH } from './helpers/turn-corpus';

const cases = loadCorpus();

test('the corpus is loaded, unique, and every case names its lane', () => {
  assert.ok(cases.length >= 4, `the corpus must keep the captured field cases: ${CORPUS_PATH}`);
  const ids = cases.map(c => c.id);
  assert.equal(new Set(ids).size, ids.length, `duplicate ids in the corpus: ${ids.join(', ')}`);
  for (const c of cases) {
    assert.ok(c.intent.length > 0, `${c.id} must declare intent`);
    assert.ok(c.turns.length > 0, `${c.id} must carry the client's turn`);
  }
});

for (const c of cases) {
  test(`${c.id} — ${c.capture}`, async () => {
    await assertCorpusCase(c);
  });
}
