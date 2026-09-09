import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shouldLogForEnrichment } from '../src/llm/enrichPolicy';

// THE TEACHER/EXAM POLICY:
//   hybrid / gemini / groq = teacher — everything is logged so the midnight
//     cron can digest it into variants and new keys.
//   free = exam — nothing is logged; the pure deterministic+bank stack must
//     score 100% on its own. Enriching during the exam would pollute the
//     measurement (bank hits would come from material learned seconds ago).

test('teacher modes (hybrid/gemini/groq) log everything for enrichment', () => {
  assert.equal(shouldLogForEnrichment('hybrid', true), true);
  assert.equal(shouldLogForEnrichment('hybrid', false), true);
  assert.equal(shouldLogForEnrichment('hybrid', true, 'bank'), true);
  assert.equal(shouldLogForEnrichment('gemini', true), true);
  assert.equal(shouldLogForEnrichment('groq', true), true);
});

test('exam mode (free) logs nothing — the bank must stand alone', () => {
  assert.equal(shouldLogForEnrichment('free', true), false);
  assert.equal(shouldLogForEnrichment('free', false), false);
  assert.equal(shouldLogForEnrichment('free', true, 'bank'), false);
  assert.equal(shouldLogForEnrichment('free', true, 'deterministic'), false);
});

test('unknown brain mode defaults to teacher (never silently stop learning)', () => {
  assert.equal(shouldLogForEnrichment(undefined as any, true), true);
  assert.equal(shouldLogForEnrichment('unexpected' as any, true), true);
});
