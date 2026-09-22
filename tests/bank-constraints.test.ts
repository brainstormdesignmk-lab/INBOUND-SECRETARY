import { test } from 'node:test';
import assert from 'node:assert/strict';
import { constraintsFor, violationsFor, renderPromptBlock, validateBatch } from '../src/llm/bankConstraints';
import { RESPONSE_BANK } from '../src/data/responses';

const pass = (key: string, text: string) => assert.deepEqual(violationsFor(text, key), [], `expected PASS: ${text.slice(0, 60)}`);
const fail = (key: string, text: string, mustMention: string) => {
  const v = violationsFor(text, key);
  assert.ok(v.length > 0, `expected FAIL for: ${text.slice(0, 60)}`);
  if (mustMention) assert.ok(v.some(x => x.includes(mustMention)), `reason must mention "${mustMention}": ${v.join('; ')}`);
};

test('fee contract: a compliant variant passes clean', () => {
  pass('fee.ask.buy', 'Надоместот за организација на посетата е 500 денари (10 евра). Дали Ви одговара тоа?');
});

test('fee contract: missing fee figure is rejected', () => {
  fail('fee.ask.buy', 'Можеме да организираме посета. Дали Ви одговара?', 'required fact');
});

test('fee contract: unsanctioned amount is rejected even with fee present', () => {
  fail('fee.ask.buy', 'Надоместот е 500 денари (10 евра), а нотарот чини 150 евра. Дали Ви одговара?', 'unsanctioned');
});

test('fee contract: notary claim is forbidden', () => {
  fail('fee.ask.buy', 'Надоместот е 500 денари (10 евра), нотарот е задолжителен. Дали Ви одговара?', 'forbidden');
});

test('fee contract: statement without trailing question is rejected', () => {
  fail('fee.ask.buy', 'Надоместот за посетата е 500 денари (10 евра).', 'question');
});

test('baseline: promises and guarantees are forbidden on any key', () => {
  fail('owner.contact.refusal', 'Ќе ветувам дека ќе се сретнете со сопственикот. Дали е во ред?', 'forbidden');
});

test('baseline: any unlisted amount is rejected on a no-amounts key', () => {
  fail('exhausted.pivot', 'Имотот чини 99.000 евра. Дали Ви одговара?', 'unsanctioned');
});

test('fee.why allows figures but never requires them', () => {
  pass('fee.why', 'Надоместот ни помага да издвоиме сериозни клиенти. Дали би сакале да продолжиме?');
  pass('fee.why', 'Надоместот е 500 денари (10 евра) — филтер за сериозни клиенти. Дали продолжуваме?');
});

test('learn.* keys inherit the baseline contract', () => {
  assert.equal(constraintsFor('learn.dozvola-za-koristenje').allowedAmounts?.length ?? 0, 0);
  fail('learn.misc', 'Сопственикот ветува намалување. Дали Ви одговара?', 'forbidden');
});

test('prompt block: fee key names the sanctioned figures', () => {
  const p = renderPromptBlock('fee.ask.buy');
  assert.ok(p.includes('500 денари'));
  assert.ok(p.includes('5 евра'));
  assert.ok(p.includes('end with a question'));
});

test('prompt block: unlisted key forbids all amounts, mandates {price}', () => {
  const p = renderPromptBlock('neighborhood.general');
  assert.ok(p.includes('NEVER state any specific price'));
  assert.ok(p.includes('{price}'));
});

test('validateBatch partitions kept/rejected', () => {
  const { kept, rejected } = validateBatch('fee.ask.buy', [
    'Надоместот е 500 денари (10 евра). Дали Ви одговара?',
    'Нотарот чини 200 евра.',
  ]);
  assert.equal(kept.length, 1);
  assert.equal(rejected.length, 1);
  assert.ok(rejected[0].reasons.length > 0);
});

test('SEED AUDIT — every human seed variant satisfies its own contract', () => {
  const bad: string[] = [];
  for (const [key, variants] of Object.entries(RESPONSE_BANK)) {
    variants.forEach((v, i) => {
      const reasons = violationsFor(v, key);
      if (reasons.length > 0) bad.push(`${key}#${i}: ${reasons.join('; ')}`);
    });
  }
  assert.deepEqual(bad, []);
});
