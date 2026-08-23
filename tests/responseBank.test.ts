import { test } from 'node:test';
import assert from 'node:assert';
import { RESPONSE_BANK } from '../src/data/responses';
import { pickVariant, fallbackVariant, noMatchLine, exhaustedLine, normalizeVariant } from '../src/data/responseBank';
import { randomGreeting } from '../src/data/greetings';

test('response bank: every entry is non-empty and placeholders live only where expected', () => {
  for (const [key, variants] of Object.entries(RESPONSE_BANK)) {
    assert.ok(variants.length > 0, `${key}: empty bank`);
    for (const v of variants) {
      assert.ok(v.trim().length >= 10, `${key}: too short: "${v}"`);
      if (key === 'no.match.location' || key === 'exhausted.location') {
        assert.equal(v.match(/\{location\}/g)?.length ?? 0, 1, `${key}: "${v}"`);
      } else if (key === 'presentation.open.anywhere') {
        assert.equal(v.match(/\{budget\}/g)?.length ?? 0, 1, `${key}: "${v}"`);
      } else if (key === 'both.ask.service') {
        assert.equal(v.match(/\{type\}/g)?.length ?? 0, 1, `${key}: "${v}"`);
      } else {
        assert.ok(!v.includes('{'), `${key}: unexpected placeholder: "${v}"`);
      }
    }
  }
});

test('pickVariant: unknown key returns undefined; known key fills {location}', () => {
  assert.equal(pickVariant('no.such.key'), undefined);
  const v = pickVariant('no.match.location', { vars: { location: 'Центар' } });
  assert.ok(v && v.includes('Центар'), v);
  assert.ok(!v?.includes('{location}'), v);
});

test('pickVariant: never repeats a recently-used variant while fresh ones remain', () => {
  const all = RESPONSE_BANK['patience.line'];
  const recent = all.slice(0, all.length - 1);
  for (let i = 0; i < 50; i++) {
    const v = pickVariant('patience.line', { recent });
    assert.ok(v && !recent.includes(v), v);
  }
  // when EVERY variant was recently used, it still returns one (full pool)
  const exhausted = pickVariant('patience.line', { recent: all });
  assert.ok(all.includes(exhausted as string));
});

test('pickVariant: repeat avoidance is by normalized text (punctuation/case insensitive)', () => {
  const variant = RESPONSE_BANK['no.match.plain'][0];
  const norm = normalizeVariant(variant);
  for (let i = 0; i < 30; i++) {
    const again = pickVariant('no.match.plain', { recent: [variant] });
    assert.ok(again, 'should always pick something');
    assert.notEqual(normalizeVariant(again), norm, 'must not repeat the same normalized text');
  }
});

test('fallbackVariant: bank-backed states return variants; unknown keys return undefined', () => {
  const v = fallbackVariant('owner_checking');
  assert.ok(v && RESPONSE_BANK['patience.line'].includes(v), v);
  for (const state of ['discovery', 'presentation']) {
    const x = fallbackVariant(state as 'discovery');
    assert.ok(x && RESPONSE_BANK[`fallback.${state}`].includes(x), `${state}: ${x}`);
  }
  // no fallback.<state> key for these — caller keeps its code-built line
  assert.equal(fallbackVariant('closing'), undefined);
  assert.equal(fallbackVariant('idle'), undefined);
});

test('noMatchLine: location form fills the placeholder, plain form has none', () => {
  const withLoc = noMatchLine('Карпош');
  assert.ok(withLoc && withLoc.includes('Карпош'), withLoc);
  assert.ok(!withLoc?.includes('{location}'), withLoc);
  const plain = noMatchLine(undefined);
  assert.ok(plain && RESPONSE_BANK['no.match.plain'].includes(plain), plain);
});

test('exhaustedLine: location form fills the placeholder, plain form has none', () => {
  const withLoc = exhaustedLine('Карпош');
  assert.ok(withLoc && withLoc.includes('Карпош'), withLoc);
  assert.ok(!withLoc?.includes('{location}'), withLoc);
  const plain = exhaustedLine(undefined);
  assert.ok(plain && RESPONSE_BANK['exhausted.plain'].includes(plain), plain);
});

test('randomGreeting: avoids recently-used greetings and stays in the bank', () => {
  const recent = RESPONSE_BANK['greeting'].slice(0, 5);
  for (let i = 0; i < 30; i++) {
    const g = randomGreeting(recent);
    assert.ok(!recent.includes(g), g);
    assert.ok(RESPONSE_BANK['greeting'].includes(g), g);
  }
});
