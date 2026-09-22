import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/store/db';
import { BankStore, FROZEN_BANK_KEYS } from '../src/store/bank';

function fresh(): { bank: BankStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'relearn-'));
  const db = new Db(join(dir, 't.db'));
  return { bank: new BankStore(db), dir };
}

test('variant lifecycle defaults to active; staged/retired never serve', () => {
  const { bank, dir } = fresh();
  try {
    assert.ok(bank.addVariant('k1', 'active v1'));
    assert.ok(bank.addStagedVariant('k1', 'staged candidate'));
    const serving = bank.variants('k1');
    assert.deepEqual(serving, ['active v1'], 'staged row must not serve');
    const rows = bank.variantsWithLifecycle('k1');
    assert.equal(rows.length, 2);
    const staged = rows.find(r => r.lifecycle === 'staged')!;
    assert.ok(staged, 'staged row visible via lifecycle view');
    // promote → serves; retire → stops serving (reversibly)
    assert.ok(bank.promoteVariant(staged.id));
    assert.deepEqual(bank.variants('k1'), ['active v1', 'staged candidate']);
    const id2 = bank.variantsWithLifecycle('k1').find(r => r.text === 'staged candidate')!.id;
    assert.ok(bank.retireVariant(id2, 'test retire'));
    assert.deepEqual(bank.variants('k1'), ['active v1']);
    assert.ok(bank.promoteVariant(id2)); // reversible
    assert.equal(bank.variants('k1').length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('addStagedVariant unlocks FROZEN keys (the correction fits the lock)', () => {
  const { bank, dir } = fresh();
  try {
    assert.ok(FROZEN_BANK_KEYS.has('fee.ask.buy'), 'sanity: fee.ask.buy is frozen');
    assert.ok(!bank.addVariant('fee.ask.buy', 'cron write — must fail'), 'plain addVariant stays locked');
    assert.ok(bank.addStagedVariant('fee.ask.buy', 'human-corrected, staged'), 'staged write unlocked');
    assert.deepEqual(bank.variants('fee.ask.buy'), [], '…but still does not serve');
    assert.equal(bank.stagedVariants('fee.ask.buy').length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('data-driven keys stay locked even for staging', () => {
  const { bank, dir } = fresh();
  try {
    assert.ok(!bank.addStagedVariant('price.ask', 'adresna proseka 42'));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('deleteStagedVariant removes only staged rows; active rows survive', () => {
  const { bank, dir } = fresh();
  try {
    bank.addVariant('k2', 'keep me');
    assert.ok(bank.addStagedVariant('k2', 'drop me'));
    const stagedId = bank.stagedVariants('k2')[0].id;
    assert.ok(bank.deleteStagedVariant(stagedId));
    assert.equal(bank.stagedVariants('k2').length, 0);
    const active = bank.variantsWithLifecycle('k2').find(r => r.text === 'keep me')!;
    assert.ok(!bank.deleteStagedVariant(active.id), 'active row is not deletable via staged path');
    assert.equal(bank.variants('k2').length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('variant cap counts only active rows — staged candidates do not exhaust the budget', () => {
  const { bank, dir } = fresh();
  try {
    for (let i = 0; i < 15; i++) assert.ok(bank.addVariant('k3', `v${i}`));
    assert.ok(!bank.addVariant('k3', 'v15-over'), 'cap holds for active writes');
    assert.ok(bank.addStagedVariant('k3', 'still stages above cap'), 'relearn stages regardless');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
