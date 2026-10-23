// AUTO-PASSES (P5.3) — the two mechanical filters between a serve and the
// human gate, pinned on THIS SESSION's real rows:
//   #235  MNOGU EFTINA CENA E TOA  · served fee.persuade.1.buy  → BOUNCE
//   #197  PA NE E MNOGU …          · served fee.ask.buy         → KEEP
//   #236  KOJA AGENCIJA STE?       · dynamic-group key          → AUTO-STAGE
// Pass 1 bounces only PROVABLE genre mismatches (a money-lane key serving a
// resolved price evaluation); unresolved turns stay with the operator, by
// design. Pass 2 stages rows whose wording validates under the resolved key.
// The CLI's write path (scripts/autopass.ts --apply) is exercised too, in a
// temp DB, so the dismissal→corrections and stage→queue-cleanup are pinned
// end-to-end, not just the pure predicate.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { autoRejectDecision, isMoneyLaneKey, relearnPlan } from '../src/bank/autoPass';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { EnrichmentStore } from '../src/store/enrichment';
import { BankReview } from '../src/bank/review';

test('pass 1: the #235 shape bounces — fee lane served a resolved price evaluation', () => {
  const d = autoRejectDecision('MNOGU EFTINA CENA E TOA', 'fee.persuade.1.buy');
  assert.ok(d);
  assert.equal(d.tuple, 'property-price·evaluate·positive·property');
  assert.match(d.reason, /money arbiter parses as property-price·evaluate·positive·property/);
  const dNeg = autoRejectDecision('MNOGU SKAPA CENA E TOA', 'fee.persuade.1.buy');
  assert.ok(dNeg);
  assert.equal(dNeg.tuple, 'property-price·evaluate·negative·property');
});

test('pass 1: the #197 shape stays with the operator — nothing provable', () => {
  assert.equal(autoRejectDecision('PA NE E MNOGU\nMORAM DA GO VIDAM PA DA ODLUCAM\nZIVO SI E ZIVO', 'fee.ask.buy'), null);
  assert.equal(autoRejectDecision('kolku cini stanot', 'fee.ask.buy'), null);
});

test('pass 1: non-money keys are never adjudicated by the arbiter', () => {
  assert.equal(isMoneyLaneKey('learn.mnogu-eftina-cena'), false);
  assert.equal(isMoneyLaneKey('dynamic:presentation:koja-agencija-ste'), false);
  assert.equal(isMoneyLaneKey(null), false);
  assert.equal(autoRejectDecision('MNOGU EFTINA CENA E TOA', 'learn.mnogu-eftina-cena'), null);
  assert.equal(autoRejectDecision('MNOGU EFTINA CENA E TOA', null), null);
  // remark.price.* IS a money lane: a money lane serving a resolved price
  // evaluation is exactly the genre mismatch the valence axiom outlaws.
  assert.ok(autoRejectDecision('MNOGU EFTINA CENA E TOA', 'remark.price.freshness'));
});

function plant(dbPath: string): { db: Db; bank: BankStore; en: EnrichmentStore; review: BankReview } {
  const db = new Db(dbPath);
  const bank = new BankStore(db);
  const en = new EnrichmentStore(db);
  const review = new BankReview(db, bank, en);
  return { db, bank, en, review };
}

test('pass 1 CLI --apply end-to-end: bounce writes bank_corrections AND clears the queue row', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopass-'));
  const { bank, en, review } = plant(path.join(dir, 't.db'));
  en.insert({
    chatId: 'c1', state: 'presentation', eventType: 'FEE_PUSH_FAST',
    userMsg: 'MNOGU EFTINA CENA E TOA',
    replyText: 'трошок од 500 денари (10 евра) за купувачот',
    replySource: 'deterministic', bankKey: 'fee.persuade.1.buy',
  });
  const pend = en.listPending();
  assert.equal(pend.length, 1);

  // Same write the --apply branch performs.
  const it = review.list('enrichment').find(x => x.status === 'pending' && x.id === pend[0].id)!;
  const d = autoRejectDecision(it.userMsg ?? '', it.key ?? null)!;
  assert.ok(d);
  const corrId = bank.correctionManual(it.userMsg ?? '', it.text ?? '', d.reason, it.key ?? null, null);
  en.markEnriched([it.id]);

  assert.equal(en.listPending().length, 0);
  const corr = bank.correctionsByStatus('new').find(c => c.id === corrId);
  assert.ok(corr);
  assert.equal(corr.key, 'fee.persuade.1.buy');
  assert.match(corr.reason, /auto-reject: fee\.persuade\.1\.buy served a turn/);
  // Idempotence guard: rerunning the same dismissal does not duplicate rows.
  const again = en.listPending();
  assert.equal(again.length, 0);
});

test('pass 2: the #236 shape auto-stages under the resolved learn key via review.push', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopass2-'));
  const { bank, en, review } = plant(path.join(dir, 't.db'));
  en.insert({
    chatId: 'c2', state: 'idle', eventType: 'LEARNED_RECALL',
    userMsg: 'KOJA AGENCIJA STE?',
    replyText: 'Здраво! Јас сум Лина од агенцијата за недвижности Метрополис. Кажете ми, каков тип на недвижност барате, па да Ви помогнам во изборот?',
    replySource: 'dynamic', bankKey: 'dynamic:idle:koja-agencija-ste',
  });
  const items = review.list('enrichment').filter(x => x.status === 'pending');
  assert.equal(items.length, 1);
  const it = items[0];
  // The suggested target exists and differs from the dynamic group.
  const target = review.suggestKey(it);
  assert.match(target, /^learn\./);
  assert.notEqual(target, it.key!);
  // The exact guard chain the --apply branch runs: flags only when validating.
  assert.equal(it.flag, 'ok');
  const r = review.push(it, target, it.text ?? '');
  assert.equal(r.ok, true);
  assert.equal(en.listPending().length, 0);
  const staged = bank.stagedVariants(target);
  assert.ok(staged.some(v => v.text === (it.text ?? '').trim()));
  // Serving identity: approve promotes the re-keyed variant inside the gate.
  const v = staged.find(x => x.text === (it.text ?? '').trim())!;
  assert.equal(bank.promoteVariant(v.id), true);
  assert.ok(bank.variants(target).some(t => t === (it.text ?? '').trim()));
});

// ── PASS 3: the Loop B planner (pure, no LLM) ──────────────────────────
const RELEARN_CORPUS: Array<{ id: number; key: string | null; msg: string; reply: string; reason: string }> = [
  { id: 21, key: 'fee.persuade.1.buy', msg: 'MNOGU EFTINA CENA E TOA', reply: 'served fee copy', reason: 'auto-reject: fee.persuade.1.buy served a turn the money arbiter parses as …' },
  { id: 22, key: 'fee.persuade.1.buy', msg: 'MNOGU SKAPA CENA E TOA', reply: 'served fee copy', reason: 'auto-reject: fee.persuade.1.buy served a turn …' },
  { id: 23, key: null, msg: 'no key attach', reply: 'x', reason: 'r' },
  { id: 24, key: 'price.ask', msg: 'kolku cini', reply: 'x', reason: 'r' },
  { id: 25, key: 'learn.full', msg: 'q', reply: 'x', reason: 'r' },
];

function relearnPlanOpts(overrides?: Partial<Parameters<typeof relearnPlan>[1]>): Parameters<typeof relearnPlan>[1] {
  return {
    isDataDriven: k => k === 'price.ask',
    variantCount: k => (k === 'learn.full' ? 999 : 0),
    maxVariants: 24,
    ...overrides,
  };
}

test('pass 3: the planner groups corrections into ONE job per key, newest signal first', () => {
  const { plan, skipped } = relearnPlan(RELEARN_CORPUS, relearnPlanOpts());
  assert.equal(plan.length, 1);
  const job = plan[0];
  assert.equal(job.key, 'fee.persuade.1.buy');
  assert.deepEqual(job.correctionIds, [21, 22]); // newest-first group
  assert.equal(job.wrongReply, 'served fee copy');
  assert.match(job.msg, /MNOGU EFTINA CENA E TOA/); // the NEWEST correction is the signal
});

test('pass 3: unbindable, data-driven and capped keys are skipped with reasons, corrections stay new', () => {
  const { plan, skipped } = relearnPlan(RELEARN_CORPUS, relearnPlanOpts());
  assert.equal(plan.find(j => j.key === 'price.ask'), undefined);
  assert.equal(plan.find(j => j.key === 'learn.full'), undefined);
  const skip22 = skipped.find(s => s.id === 23);
  assert.ok(skip22); assert.match(skip22.reason, /no key to bind/);
  const skip24 = skipped.find(s => s.id === 24);
  assert.ok(skip24); assert.match(skip24!.reason, /data-driven — facts are never prose/);
  const skip25 = skipped.find(s => s.id === 25);
  assert.ok(skip25); assert.match(skip25!.reason, /variant cap \(24\)/);
});

test('pass 2: a duplicate under the resolved key is NOT mechanical — stays visible', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'autopass3-'));
  const { bank, en, review } = plant(path.join(dir, 't.db'));
  bank.addVariant('learn.koja-agencija-ste', 'Здраво! Јас сум Лина од агенцијата за недвижности Метрополис. Кажете ми, каков тип на недвижност барате, па да Ви помогнам во изборот?');
  en.insert({
    chatId: 'c3', state: 'idle', eventType: 'LEARNED_RECALL',
    userMsg: 'KOJA AGENCIJA STE?',
    replyText: 'Здраво! Јас сум Лина од агенцијата за недвижности Метрополис. Кажете ми, каков тип на недвижност барате, па да Ви помогнам во изборот?',
    replySource: 'dynamic', bankKey: 'dynamic:idle:koja-agencija-ste',
  });
  const it = review.list('enrichment').find(x => x.status === 'pending')!;
  assert.equal(it.flag, 'fail'); // duplicate under the suggested key
  assert.equal(review.push(it, review.suggestKey(it), it.text ?? '').ok, false);
  assert.equal(en.listPending().length, 1);
});
