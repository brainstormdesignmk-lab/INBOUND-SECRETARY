// P-RUNTIME DYNAMIC FALLBACK — the closed loop's runtime half.
//
// Unroutable question → recall from bank_dynamic (0 ms) → miss → one
// constrained Gemini call → validate (P1 baseline + hygiene + no-facts) →
// serve + store immediately. Any dirty output degrades to the pre-existing
// path with NOTHING stored — a wrong answer must never become permanent.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { validateDynamicAnswer, recallDynamic, dynamicAnswer, dynamicSlug } from '../src/llm/dynamicFallback';
import { LlmClient } from '../src/llm/types';
import { ChatSession } from '../src/fsm/session';

function fresh(): { bank: BankStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dynfb-'));
  const db = new Db(join(dir, 't.db'));
  return { bank: new BankStore(db), dir };
}

const CLEAN = 'Секогаш почнуваме со преглед на документацијата на имотот. Дали сакате да организираме посета за да ги видите документите во оригинал?';

test('validation: clean pass, fact violations, hygiene violations, promises', () => {
  assert.deepEqual(validateDynamicAnswer(CLEAN), []);
  // price named → forbidden fact
  assert.ok(validateDynamicAnswer('Станот чини 50.000 евра. Дали Ве интересира?').some(v => v.includes('concrete fact')));
  // EB named
  assert.ok(validateDynamicAnswer('Имотот со Евидентен број 41 е слободен?').length > 0);
  // promise
  assert.ok(validateDynamicAnswer('Ветувам целосна поддршка. Дали продолжуваме?').some(v => v.includes('forbidden')));
  // hygiene: latin junk line
  assert.ok(validateDynamicAnswer('totally latin answer without question mark').length > 0);
});

test('slug: stable and state-scoped', () => {
  const a = dynamicSlug('property_query', 'dali stanot ima dozvola za koristenje?');
  const b = dynamicSlug('property_query', 'dali stanot ima dozvola za koristenje?');
  assert.equal(a, b);
  assert.ok(a.startsWith('dynamic:property_query:'));
  assert.ok(a.includes('dozvola'));
});

test('recall: stored answer returns; stale answer re-validated and degraded', () => {
  const { bank, dir } = fresh();
  try {
    bank.addDynamic('dynamic:property_query:dozvola', 'property_query', 'dali ima dozvola?', CLEAN);
    const hit = recallDynamic(bank, 'dali ima dozvola?');
    assert.ok(hit, 'clean stored answer recalls');
    assert.equal(hit!.source, 'dynamic-recall');
    // A stored answer that now violates hygiene (e.g. contract tightened)
    // must NOT serve.
    bank.addDynamic('dynamic:property_query:uplata', 'property_query', 'kakvo se plakja?', 'Секако, плаќа се 5000 евра веднаш!');
    assert.equal(recallDynamic(bank, 'kakvo se plakja?'), undefined, 'dirty stored row degrades');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

class ScriptedLlm implements LlmClient {
  constructor(private reply: string) {}
  async complete(): Promise<string> { return this.reply; }
}

class ThrowingLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('must not be called'); }
}

function fail(): never { throw new Error('unreachable'); }

function fakeSession(): ChatSession {
  return {
    chatId: 'dyn-test',
    state: 'property_query',
    slots: { service: 'buy', location: 'Аеродром' },
    history: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  } as unknown as ChatSession;
}

test('generate: clean LLM answer is served AND stored; recall hits next time', async () => {
  const { bank, dir } = fresh();
  try {
    const first = await dynamicAnswer(new ScriptedLlm(CLEAN), fakeSession(), 'kakvi dokumenti se potrebni za kupuvanje?', bank);
    assert.ok(first, 'clean answer must serve');
    assert.equal(first!.source, 'dynamic');
    // second call: recall (no LLM needed) — ThrowingLlm fails the test if called
    void fail;
    const second = await dynamicAnswer(new ThrowingLlm(), fakeSession(), 'kakvi dokumenti se potrebni za kupuvanje?', bank);
    assert.ok(second);
    assert.equal(second!.source, 'dynamic-recall');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('generate: dirty LLM output serves NOTHING and stores NOTHING', async () => {
  const { bank, dir } = fresh();
  try {
    const dirty = 'Цената е 143.000 евра и имотот е слободен веднаш.';
    const res = await dynamicAnswer(new ScriptedLlm(dirty), fakeSession(), 'kolku kuini imotot?', bank);
    assert.equal(res, undefined, 'dirty answer degrades');
    assert.equal(bank.dynamicGroups().length, 0, 'nothing stored');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('generate: LLM failure degrades silently', async () => {
  const { bank, dir } = fresh();
  try {
    const res = await dynamicAnswer(new class implements LlmClient {
      async complete(): Promise<string> { throw new Error('429'); }
    }, fakeSession(), 'neodgovoreno prasanje sluchaj?', bank);
    assert.equal(res, undefined);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
