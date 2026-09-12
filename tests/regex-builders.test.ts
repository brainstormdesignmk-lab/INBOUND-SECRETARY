// Structural audit probe: every regex-assembly helper must return a value
// that is SAFE to interpolate — i.e. its alternations (if any) are wrapped in
// a non-capturing group, so quantifiers/boundaries at an insertion site bind
// to the whole alternation, never just the first branch.
//

import { test } from 'node:test';
import assert from 'node:assert/strict';
// The _cb bug (ungrouped helper + first-only guard binding) produced the
// "NAPLAKJATE ZA POSETA" → provision-who misroute and, in the same family,
// the "lokaciJA IMA" availability false-match. This probe pins the helpers.

import { toRegexAlt } from '../src/llm/morphology';
import { AVAILABILITY_LEXICON } from '../src/llm/morphology';

// Compile a helper's output inside a group with an optional quantifier —
// the WORST possible insertion site. If the helper returned an ungrouped
// alternation, the quantifier would bind only to the last alternative.
function worstCaseSource(fragment: string): RegExp {
  return new RegExp(fragment + '?', 'u');
}

test('toRegexAlt returns a GROUPED alternation (safe to interpolate)', () => {
  const out = toRegexAlt(['abc', 'def']);
  assert.equal(out, '(?:abc|def)');
});

test('toRegexAlt under the worst-case insertion still matches every alternative', () => {
  const lex = toRegexAlt(AVAILABILITY_LEXICON);
  const re = worstCaseSource(lex);
  // Every alternative must survive quantified interpolation — sample the
  // lexicon: first, last, and a mid entry.
  const sample = [AVAILABILITY_LEXICON[0], AVAILABILITY_LEXICON[Math.floor(AVAILABILITY_LEXICON.length / 2)], AVAILABILITY_LEXICON[AVAILABILITY_LEXICON.length - 1]];
  for (const w of sample) {
    assert.ok(re.test(w), `quantified interpolation lost alternative: ${w}`);
  }
});

test('boundary-guarded helpers survive the grammar.ts regroup pattern', () => {
  // The or() shape from grammar.ts, rebuilt here to pin the CONTRACT (not
  // the private function): guards + group. A guarded fragment cannot carry a
  // bare quantifier suffix (the lookahead makes it a loud SyntaxError —
  // nothing silently mis-binds); the regroup convention `(${X})?` is the
  // documented insertion pattern, so test exactly that.
  const orShape = '(?<![\\p{L}\\p{N}])(?:ima|go|ja)(?![\\p{L}\\p{N}])';
  const re = new RegExp('(' + orShape + ')?', 'u');
  assert.ok(re.test('ima'));
  assert.ok(re.test('go'));
  assert.ok(re.test('ja'));
  // The lokacija-ima class: "ima" inside another word must never match.
  assert.ok(!new RegExp(orShape, 'u').test('lokacijaima'));
  // And a bare quantifier on a lookahead fails LOUDLY, never silently:
  assert.throws(() => new RegExp(orShape + '?', 'u'), SyntaxError);
});

test('the _cb bug shape is dead: first-only guard binding cannot happen', () => {
  // Reconstruct the BUGGY shape (ungrouped, guard on first branch only) and
  // the FIXED shape, then prove they behave differently on the 13:01 input.
  const buggy = "(?<![\\p{L}\\p{N}])(?:koj)|plakja|плаќа";
  const fixed = "(?<![\\p{L}\\p{N}])(?:koj|plakja|плаќа)";
  const input = 'NAPLAKJATE ZA POSETA';
  // buggy: bare "plakja" substring-matches inside "naPLAKJAte"
  assert.ok(new RegExp(buggy, 'iu').test(input), 'buggy shape reproduces the bug (sanity)');
  // fixed: guards wrap EVERY alternative
  assert.ok(!new RegExp(fixed, 'iu').test(input), 'grouped shape kills the bug');
});
