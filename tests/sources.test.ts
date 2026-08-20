import { test } from 'node:test';
import assert from 'node:assert';
import { Responder } from '../src/llm/respond';
import { Classifier } from '../src/llm/classify';
import { LlmClient, CompleteOpts } from '../src/llm/types';
import { freshSession } from '../src/fsm/session';
import { loadConfig } from '../src/config';

/** An LLM that reports its identity via onProvider and answers with prose. */
class OkLlm implements LlmClient {
  constructor(private provider: string) {}
  async complete(o: CompleteOpts): Promise<string> {
    o.onProvider?.(this.provider);
    return 'Еве ги деталите за имотот. Дали би сакале да организираме посета?';
  }
}

class DownLlm implements LlmClient {
  async complete(): Promise<string> {
    throw new Error('llm down');
  }
}

class FixedJsonLlm implements LlmClient {
  constructor(private json: string) {}
  async complete(): Promise<string> {
    return this.json;
  }
}

const PROSE_REPLY = 'Еве ги деталите за имотот. Дали би сакале да организираме посета?';

test('respond: code-built states report deterministic — never an LLM call', async () => {
  const cfg = loadConfig();
  // discovery (criteria ask), contact_collection (name ask), closing (fee ask)
  for (const state of ['discovery', 'contact_collection', 'closing'] as const) {
    const s = freshSession('test', `x-${state}`);
    s.state = state;
    const r = await new Responder(new DownLlm(), cfg).respond(s, [], 'zdravo');
    assert.equal(r.source, 'deterministic', state);
    assert.ok(r.text.length > 0, state);
  }
});

test('respond: LLM prose reports the provider that served (via onProvider)', async () => {
  const cfg = loadConfig();
  const s = freshSession('test', 'x');
  s.state = 'presentation';
  const r = await new Responder(new OkLlm('gemini:2'), cfg).respond(s, [], 'zdravo');
  assert.equal(r.source, 'gemini:2');
  assert.equal(r.text, PROSE_REPLY);
});

test('respond: LLM failure reports fallback (even with props — cards are fallback too)', async () => {
  const cfg = loadConfig();
  const s = freshSession('test', 'x');
  s.state = 'presentation';
  const r = await new Responder(new DownLlm(), cfg).respond(s, [], 'zdravo');
  assert.equal(r.source, 'fallback');
  assert.ok(r.text.length > 0);
});

test('respond: closing fee ask/persuasion stay deterministic with exact amounts', async () => {
  const cfg = loadConfig();
  const s = freshSession('test', 'x');
  s.state = 'closing';
  s.slots.service = 'buy';
  const r = await new Responder(new DownLlm(), cfg).respond(s, [], 'да');
  assert.equal(r.source, 'deterministic');
  assert.ok(r.text.includes('500 денари'), r.text);
  assert.ok(r.text.includes('Дали се согласувате'), r.text);
  s.slots.feeRejections = 1;
  const r2 = await new Responder(new DownLlm(), cfg).respond(s, [], 'не');
  assert.equal(r2.source, 'deterministic');
  assert.ok(r2.text.includes('500 денари'), r2.text);
});

test('setLlm swaps the responder brain at runtime (TUI chooser)', async () => {
  const cfg = loadConfig();
  const s = freshSession('test', 'x-swap');
  s.state = 'presentation';
  const r = new Responder(new DownLlm(), cfg);
  assert.equal((await r.respond(s, [], 'zdravo')).source, 'fallback');
  r.setLlm(new OkLlm('groq'));
  const up = await r.respond(s, [], 'zdravo');
  assert.equal(up.source, 'groq');
  assert.equal(up.text, PROSE_REPLY);
});

test('setLlm swaps the classifier brain at runtime (TUI chooser)', async () => {
  const cfg = loadConfig();
  const s = freshSession('test', 'y-swap');
  s.state = 'property_query';
  s.slots.propertyId = 78;
  const c = new Classifier(new DownLlm(), cfg);
  // LLM down -> deterministic path, nothing extracted from "да" -> STAY
  assert.equal((await c.classify(s, 'da')).event.type, 'STAY');
  c.setLlm(new FixedJsonLlm(JSON.stringify({ event: 'INTERESTED', propertyId: 78, offensive: false, offenseLevel: 0 })));
  const up = await c.classify(s, 'da');
  assert.equal(up.event.type, 'INTERESTED');
  assert.equal(up.event.propertyId, 78);
});

test('respond: property cards on LLM failure are fallback, text is code-built', async () => {
  const cfg = loadConfig();
  const s = freshSession('test', 'x');
  s.state = 'presentation';
  const props = [{ eb: 63, id: 63, address: 'x', location: 'Центар', price: 36000 }];
  const r = await new Responder(new DownLlm(), cfg).respond(s, props, 'zdravo');
  assert.equal(r.source, 'fallback');
  assert.ok(r.text.includes('Евидентен број 63'), r.text);
});
