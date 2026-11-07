/**
 * «Радо ќе ги проверам достапните» — a dynamic (Gemini) answer stored in the
 * bank. «Радо» is Serbian; the agency speaks Macedonian. The validator runs at
 * generation AND on recall (recallDynamic), so the rule must reject the stored
 * sentence on both paths, not only when a new one is generated.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateDynamicAnswer } from '../src/llm/dynamicFallback';

const CAPTURED = 'Радо ќе ги проверам достапните и ќе Ви се јавам набргу.';
const MACEDONIAN = 'Ќе ги проверам достапните и ќе Ви се јавам набргу.';

test('the captured Serbian sentence is rejected by the dynamic validator', () => {
  const v = validateDynamicAnswer(CAPTURED, 'ИМАМ ПРАШАЊЕ ЗА ЦЕНАТА');
  assert.ok(
    v.some(x => x.includes('Serbian-only')),
    `expected a Serbian-only violation, got: ${JSON.stringify(v)}`,
  );
});

test('the corrected Macedonian wording is not rejected by the Serbian rule', () => {
  const v = validateDynamicAnswer(MACEDONIAN, 'ИМАМ ПРАШАЊЕ ЗА ЦЕНАТА');
  assert.ok(!v.some(x => x.includes('Serbian-only')), JSON.stringify(v));
});

test('«радо» inside a longer Macedonian word is not a Serbian match', () => {
  const v = validateDynamicAnswer(
    'Ќе ги проверам достапните станови, нема проблем, ќе Ви се јавам.',
    'ИМАМ ПРАШАЊЕ ЗА ЦЕНАТА',
  );
  assert.ok(!v.some(x => x.includes('Serbian-only')), JSON.stringify(v));
});
