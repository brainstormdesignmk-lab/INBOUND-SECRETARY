// THE TWO ECONOMICS OF THE LOOP (2026-10-21).
//
// 1) BUDGET — the gate fires on any uncovered question, so without a cap a
//    client asking twenty novel questions buys twenty Gemini calls. The cap is
//    per SESSION and only a SUCCESSFUL generation spends it: a dirty answer or
//    a quota error teaches nothing and must leave the allowance intact.
//
// 2) VERBATIM BIND — promoting a capture to a real key is a ROUTING fact, so a
//    human supplies the key and nothing is generated. The phrase lands in
//    bank_examples verbatim, the dynamic row is retired (otherwise the stored
//    prose keeps winning at `retrieveDynamicExact` and the binding is inert),
//    and the key's own seeded variants answer next time.
//
// Refusals pinned here: a frozen/data-driven key (never learns), a `dynamic:`
// group (not a key), a 3-letter phrase (below addExample's retrieval floor —
// "TWO" is detector work), and an unknown id.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { freshSession } from '../src/fsm/session';
import { generateDynamic, shouldTryDynamic, MAX_GENERATED_PER_SESSION } from '../src/llm/dynamicFallback';
import { LlmClient } from '../src/llm/types';
import { RESPONSE_BANK } from '../src/data/responses';

class ScriptedLlm implements LlmClient {
  calls = 0;
  constructor(private reply: string) {}
  async complete(): Promise<string> { this.calls++; return this.reply; }
}

const CLEAN = 'Секогаш почнуваме со преглед на документацијата на недвижноста. Дали сакате да организираме посета за да ги видите документите во оригинал?';
const FACTY = 'Станот чини 143.000 евра и е слободен веднаш.';
const ASK = 'kade ima reptil tamu ?';

function store(): { bank: BankStore; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'verbatim-bind-'));
  const bank = new BankStore(new Db(path.join(dir, 'lina.db')));
  return { bank, dir };
}

test('budget: only successful generations spend it, and the cap closes the gate', async () => {
  const { bank, dir } = store();
  try {
    const llm = new ScriptedLlm(CLEAN);
    const s = freshSession('test', 'budget');
    s.state = 'idle';

    for (let i = 0; i < MAX_GENERATED_PER_SESSION; i++) {
      assert.equal(shouldTryDynamic(s, ASK), true, `gate open on turn ${i + 1}`);
      const res = await generateDynamic(llm, s, `${ASK} ${'x'.repeat(i)}`, bank);
      assert.ok(res, `generation ${i + 1} succeeds`);
      assert.equal(res.source, 'dynamic');
    }
    assert.equal(llm.calls, MAX_GENERATED_PER_SESSION);
    // Rows, not groups: dynamicSlug() folds near-duplicate phrasings into ONE
    // group on purpose, so a group count would under-report the stored turns.
    assert.equal(bank.pendingDynamic().length, MAX_GENERATED_PER_SESSION);
    assert.equal(shouldTryDynamic(s, ASK), false, 'budget exhausted — no more calls this session');

    // A dirty answer must NOT spend the allowance: the call failed to teach us.
    const dirty = new ScriptedLlm(FACTY);
    const fresh = freshSession('test', 'budget2');
    fresh.state = 'idle';
    const before = fresh.slots.generatedAnswers ?? 0;
    assert.equal(await generateDynamic(dirty, fresh, ASK, bank), undefined);
    assert.equal(fresh.slots.generatedAnswers ?? 0, before, 'a rejected answer costs no budget');
    assert.equal(shouldTryDynamic(fresh, ASK), true);

    // A reset clears the slots, so a brand-new funnel gets a fresh allowance.
    s.slots = {};
    assert.equal(shouldTryDynamic(s, ASK), true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bind: the phrase becomes a real retrieval hit and the dynamic row is retired', () => {
  const { bank, dir } = store();
  try {
    const PHRASE = 'moze dogovori mi';
    assert.equal(bank.addDynamic('dynamic:idle:dogovori', 'idle', PHRASE, CLEAN), true);
    assert.equal(bank.pendingDynamic().length, 1);
    assert.equal(bank.retrieveExact(PHRASE), undefined, 'not routable yet');

    const id = bank.pendingDynamic()[0].id;
    const res = bank.bindDynamic(id, 'visit.confirm.ask');
    assert.equal(res.ok, true);
    assert.equal(res.added, true);

    const hit = bank.retrieveExact(PHRASE);
    assert.equal(hit?.key, 'visit.confirm.ask', 'the verbatim phrase now routes to the real key');
    assert.equal(RESPONSE_BANK['visit.confirm.ask'].length > 0, true, 'and that key has variants to serve');
    assert.equal(bank.dynamicGroups().length, 0, 'the generated prose no longer shadows the binding');

    // Same phrase captured again later: the binding already exists, so the row
    // is still retired instead of being re-promoted forever.
    bank.addDynamic('dynamic:idle:dogovori', 'idle', PHRASE, CLEAN);
    const again = bank.bindDynamic(bank.pendingDynamic()[0].id, 'visit.confirm.ask');
    assert.equal(again.ok, true);
    assert.equal(again.added, false);
    assert.equal(bank.dynamicGroups().length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bind refusals: unknown id, short phrase, frozen key, dynamic group', () => {
  const { bank, dir } = store();
  try {
    assert.equal(bank.bindDynamic(9999, 'visit.confirm.ask').ok, false);
    assert.match(bank.bindDynamic(9999, 'visit.confirm.ask').reason ?? '', /no such dynamic row/);

    // "TWO" — the operator's own example — has no retrieval path at all.
    bank.addDynamic('dynamic:idle:two', 'idle', 'TWO', CLEAN);
    const short = bank.pendingDynamic()[0];
    const r = bank.bindDynamic(short.id, 'visit.confirm.ask');
    assert.equal(r.ok, false);
    assert.match(r.reason ?? '', /too short/);
    assert.equal(bank.pendingDynamic().length, 1, 'a refused bind must not retire the row');

    bank.addDynamic('dynamic:idle:provizija', 'idle', 'kolku e provizijata?', CLEAN);
    const frozenRow = bank.pendingDynamic().find(p => p.msg === 'kolku e provizijata?')!;
    const f = bank.bindDynamic(frozenRow.id, 'fee.ask.buy');
    assert.equal(f.ok, false, 'frozen keys never learn — their routing is detector-owned');
    assert.match(f.reason ?? '', /frozen/);

    const d = bank.bindDynamic(frozenRow.id, 'dynamic:idle:provizija');
    assert.equal(d.ok, false);
    assert.match(d.reason ?? '', /deterministic bank key/);
    assert.equal(bank.pendingDynamic().length, 2, 'only a successful bind retires a row');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
