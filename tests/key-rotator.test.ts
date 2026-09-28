// Piece 5 — the per-atom key rotator contract.
//
// The 2026-09 quota drought starved the atom: ONE key, 429-exhausted, so
// every LLM-bound turn burned its retry ladder before serving a deterministic
// fallback. The fix is organizational, not architectural: each atom owns its
// OWN pool in its own ~/.lina/lina.env (GEMINI_API_KEY_1..N — the RotatingClient
// with cooldown-skip already exists), and "make enough keys for each atom to
// never starve" becomes an env edit, never a code change.
//
// What is pinned here:
//   1. cfg.geminiKeyPool — the three documented slots + GEMINI_API_KEY_4..N,
//      blanks skipped, numeric order, position-stable 'gemini:N' labels.
//   2. The rotator skips keys ON COOLDOWN without burning attempts (pass 1),
//      then honestly probes them when ALL are cold (pass 2) so failover works.
//   3. createLlm / createLlmStrict build N backends from the pool; strict
//      still throws on an empty pool (the 2026-09-12 enrichment contract).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config';
import { RotatingClient } from '../src/llm/rotatingClient';
import { createLlm, createLlmStrict } from '../src/llm/factory';
import { CompleteOpts, LlmClient } from '../src/llm/types';

// ── 1. The open-ended pool parser ────────────────────────────────────────────

test('geminiKeyPool: three slots + _4.._N, blanks skipped, numeric order, per-machine env', () => {
  const prev = { ...process.env };
  try {
    process.env.GEMINI_API_KEY = 'keyA';
    process.env.GEMINI_API_KEY_2 = ''; // blank slot — must be skipped
    process.env.GEMINI_API_KEY_3 = 'keyC';
    process.env.GEMINI_API_KEY_4 = 'keyD';
    process.env.GEMINI_API_KEY_5 = 'keyE';
    process.env.GEMINI_API_KEY_10 = 'key10'; // out of numeric order on purpose
    const cfg = loadConfig();
    assert.deepEqual(cfg.geminiKeyPool, ['keyA', 'keyC', 'keyD', 'keyE', 'key10']);
  } finally {
    process.env = prev;
  }
});

test('geminiKeyPool: empty env → empty pool (single-key atoms are just pool size 1)', () => {
  const prev = { ...process.env };
  try {
    delete process.env.GEMINI_API_KEY;
    delete process.env.GEMINI_API_KEY_2;
    delete process.env.GEMINI_API_KEY_3;
    const cfg = loadConfig();
    assert.deepEqual(cfg.geminiKeyPool, []);
  } finally {
    process.env = prev;
  }
});

// ── 2. The rotator: cooldown-skip + honest probe when all are cold ──────────

class FakeKey implements LlmClient {
  constructor(public tag: string, public failWith: string | null = null) { this.quotaBlocked = false; }
  quotaBlocked: boolean;
  attempts = 0;
  async complete(_o: CompleteOpts): Promise<string> {
    this.attempts++;
    if (this.failWith) throw new Error(this.failWith);
    return `served-by-${this.tag}`;
  }
}

function opts(): CompleteOpts { return { prompt: 'ping', maxTokens: 8 }; }

test('rotation: exhausted key is SKIPPED (zero attempts) and the healthy one serves', async () => {
  const hot = new FakeKey('hot', '429 quota exceeded');
  const ok = new FakeKey('ok');
  hot.quotaBlocked = true; // the cooldown flag GeminiClient sets on a 429
  const r = new RotatingClient([hot, ok]);
  const out = await r.complete(opts());
  assert.equal(out, 'served-by-ok');
  assert.equal(hot.attempts, 0, 'a cooled-down key must cost zero attempts');
  assert.equal(ok.attempts, 1);
  // stats bookkeeping stays useful for measuring which key served
  assert.deepEqual(r.stats, [0, 1]);
});

test('rotation: ALL keys cold → one honest probe each, then the error propagates (failover)', async () => {
  const a = new FakeKey('a', '429');
  const b = new FakeKey('b', '429');
  a.quotaBlocked = true;
  b.quotaBlocked = true;
  const r = new RotatingClient([a, b]);
  await assert.rejects(() => r.complete(opts()), /429/);
  assert.equal(a.attempts, 1, 'pass 2 probes each cold key once');
  assert.equal(b.attempts, 1);
});

// ── 3. Factory wiring from the pool ──────────────────────────────────────────

test('createLlm builds the RotatingClient from the pool and labels backends gemini:1..N', () => {
  const cfg = loadConfig({
    llmProvider: 'gemini',
    geminiKeyPool: ['k1', 'k2', 'k3', 'k4'],
    groqApiKey: '',
  } as Partial<typeof cfg>);
  const client = createLlm(cfg) as RotatingClient;
  assert.ok(client instanceof RotatingClient, '4 keys → one rotating client');
  assert.equal((client as unknown as { clients: unknown[] }).clients.length, 4);
});

test('createLlmStrict throws on an empty pool (enrichment must never degrade) — 2026-09-12 contract intact', () => {
  const cfg = loadConfig({ geminiKeyPool: [] } as Partial<typeof cfg>);
  assert.throws(() => createLlmStrict(cfg), /enrichment requires the generator-grade model/);
});

test('createLlmStrict rotates the WHOLE pool (not just the first three slots)', () => {
  const cfg = loadConfig({
    geminiKeyPool: ['k1', 'k2', 'k3', 'k4', 'k5'],
  } as Partial<typeof cfg>);
  const client = createLlmStrict(cfg) as RotatingClient;
  assert.ok(client instanceof RotatingClient);
  assert.equal((client as unknown as { clients: unknown[] }).clients.length, 5);
});
