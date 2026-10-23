// OPTION 3 — the LLM as LAST-RESORT arbiter (P5.2). The LLM is a router, never
// an author: closed menu, JSON tuple, deterministic vetoes re-run on the pick,
// fall-through (undefined) on any veto or parse failure.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MONEY_ARBITER_MENU, llmArbitrateKey, parseArbiterJson, vetoPickedKey,
} from '../src/llm/arbiterLlm';
import { arbitrateMoney, type MoneyVerdict } from '../src/llm/moneyArbitration';
import type { LlmClient, CompleteOpts } from '../src/llm/types';

const arb = (text: string, over: Record<string, unknown> = {}): MoneyVerdict =>
  arbitrateMoney(text, {
    state: 'idle', propertyOnTable: false, feeAgreed: false,
    feeBlocked: false, provisionBlocked: false, ...over,
  } as never);

const stubLlm = (reply: string | Error): LlmClient => ({
  complete: async (_o: CompleteOpts): Promise<string> => {
    if (reply instanceof Error) throw reply;
    return reply;
  },
});

const CLARIFY_JSON = JSON.stringify({
  key: 'ask.money.clarify',
  tuple: { topic: 'unknown', act: 'ask', valence: 'neutral', target: 'none' },
  reason: 'money without object',
});

test('menu is closed and every entry is a money key', () => {
  assert.ok(MONEY_ARBITER_MENU.length >= 5);
  for (const k of MONEY_ARBITER_MENU) {
    assert.ok(/^(?:ask\.money\.clarify|remark\.price\.|fee\.ask\.|provision\.ask\.)/.test(k), k);
  }
});

test('parse: extracts the balanced JSON even with wrapping prose (vetoed later, parse only)', () => {
  const o = parseArbiterJson('Framebuffer noise. {"key":"ask.money.clarify"} trailing.');
  assert.equal(o?.key, 'ask.money.clarify');
  assert.equal(parseArbiterJson('no json at all'), undefined);
  assert.equal(parseArbiterJson('{broken'), undefined);
});

test('vetoes: the deterministic layer stays sovereign on every pick class', () => {
  // clarify is always allowed
  assert.equal(vetoPickedKey('ask.money.clarify', 'пари?', arb('пари?')), undefined);
  // cheap requires a POSITIVE evaluation in the text
  assert.ok(vetoPickedKey('remark.price.cheap', 'пари?', arb('пари?')));
  assert.ok(vetoPickedKey('remark.price.cheap', 'cfenv price valence', arb('CENATA E PREVISOKA')));
  // expensive requires a negative property-price tuple
  assert.ok(vetoPickedKey('remark.price.expensive', 'пари?', arb('пари?')));
  assert.equal(
    vetoPickedKey('remark.price.expensive', 'CENATA E PREVISOKA', arb('CENATA E PREVISOKA', { state: 'property_query', propertyOnTable: true })),
    undefined,
  );
  // fee/provision picks require a fee frame the seam can corroborate
  assert.ok(vetoPickedKey('fee.ask.buy', 'пари?', arb('пари?')));
  assert.equal(vetoPickedKey('fee.ask.buy', 'kolku e za poseta', arb('kolku e za poseta', { state: 'closing' })), undefined);
  // no off-menu keys, ever
  assert.ok(vetoPickedKey('learn.novel-key', 'пари?', arb('пари?')));
});

test('llmArbitrateKey serves a valid clarify pick on residue', async () => {
  const v = arb('пари?');
  const pick = await llmArbitrateKey(stubLlm(CLARIFY_JSON), 'пари?', 'idle', v);
  assert.ok(pick);
  assert.equal(pick.key, 'ask.money.clarify');
  assert.deepEqual(Object.keys(pick.tuple).sort(), ['act', 'target', 'topic', 'valence']);
});

test('llmArbitrateKey REFUSES a fee pick the seam cannot corroborate (fall-through)', async () => {
  const v = arb('пари?');
  const bad = JSON.stringify({
    key: 'fee.ask.rent',
    tuple: { topic: 'fee', act: 'ask', valence: 'neutral', target: 'visit-fee' },
  });
  assert.equal(await llmArbitrateKey(stubLlm(bad), 'пари?', 'idle', v), undefined,
    'the LLM must not conjure a fee referent the text lacks');
});

test('llmArbitrateKey REFUSES off-menu and malformed replies (fall-through)', async () => {
  const v = arb('пари?');
  assert.equal(await llmArbitrateKey(stubLlm('just prose, no keys'), 'пари?', 'idle', v), undefined);
  assert.equal(await llmArbitrateKey(stubLlm('{"key":"withdraw.all.funds"}'), 'пари?', 'idle', v), undefined);
});

test('llmArbitrateKey survives an LLM failure (fall-through, never throws)', async () => {
  const v = arb('пари?');
  assert.equal(await llmArbitrateKey(stubLlm(new Error('boom')), 'пари?', 'idle', v), undefined);
});

test('llmArbitrateKey: an expensive pick is validated against the NEGATIVE price tuple', async () => {
  const v = arb('CENATA E PREVISOKA', { state: 'discovery', propertyOnTable: false });
  // Discovery state vetoes the wired lane; the residue reaches the LLM arbiter.
  // The pick is corroborated (negative + property-price) and allowed.
  const good = JSON.stringify({ key: 'remark.price.expensive', tuple: v.tuple });
  const pick = await llmArbitrateKey(stubLlm(good), 'CENATA E PREVISOKA', 'discovery', v);
  assert.ok(pick && pick.key === 'remark.price.expensive', 'a corroborated pick was refused');
});
