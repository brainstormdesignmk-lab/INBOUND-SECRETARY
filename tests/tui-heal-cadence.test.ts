// THE HEAL IS NOT A REWARD FOR SILENCE.
//
// The operator's 2026-11-12 report was visual: «the owner part gets messed up —
// ПОСЕТИ drawn over other panes, chats mixed». The frame model itself is sound
// (scripts/tui-frame-check.ts and the real pty both paint the panes correctly),
// so what the operator saw is damage a web-terminal broker left behind — and
// the self-heal that repairs exactly that damage only ever ran once the chat
// and owner panes had been IDENTICAL for ~1.5 s. A live exchange changes those
// panes on every turn, which is the one state where the operator is reading the
// screen, so the damage outlived the whole conversation.
//
// paint.ts's owedHeal() is the one predicate the app consults. These tests pin
// both halves: the quiet path still heals (never regress the [00:32] fix), and
// the live path heals on a bounded cadence while content keeps changing.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  owedHeal,
  HEAL_LIVE_MS,
  HEAL_QUIET_TICKS,
  HEAL_QUIET_REPEAT_TICKS,
} from '../src/tui/paint';

test('heal: a live exchange is repaired within the bounded cadence', () => {
  // Content changed on the previous tick, so quietTicks is 0 — the old rule
  // never healed here, no matter how long the operator stared at garbage.
  assert.equal(owedHeal({ hasContent: true, quietTicks: 0, waiting: false, sinceHealMs: HEAL_LIVE_MS - 1 }), false,
    'no heal is owed before the cadence elapses');
  assert.equal(owedHeal({ hasContent: true, quietTicks: 0, waiting: false, sinceHealMs: HEAL_LIVE_MS }), true,
    'a changing screen must still be healed once the cadence elapses');
  // And it keeps doing so: the app resets `sinceHealMs` after each heal.
  assert.equal(owedHeal({ hasContent: true, quietTicks: 0, waiting: true, sinceHealMs: HEAL_LIVE_MS * 3 }), true);
});

test('heal: silence still heals at ~1.5 s, then every 3 s of continued silence', () => {
  assert.equal(owedHeal({ hasContent: true, quietTicks: HEAL_QUIET_TICKS - 1, waiting: false, sinceHealMs: 100 }),
    false, 'one tick short of the quiet window is not a heal');
  assert.equal(owedHeal({ hasContent: true, quietTicks: HEAL_QUIET_TICKS, waiting: false, sinceHealMs: 100 }),
    true, 'the [00:32] quiet-path heal must survive this change');
  assert.equal(owedHeal({
    hasContent: true,
    quietTicks: HEAL_QUIET_TICKS + HEAL_QUIET_REPEAT_TICKS,
    waiting: true,
    sinceHealMs: 100,
  }), true, 'a wait keeps re-healing every 3 s of silence');
  assert.equal(owedHeal({
    hasContent: true,
    quietTicks: HEAL_QUIET_TICKS + 1,
    waiting: false,
    sinceHealMs: 100,
  }), false, 'an idle console that already healed is not rewritten every tick');
});

test('heal: an empty frame is never healed', () => {
  // Before the first content there is nothing to protect, and a heal would
  // only re-emit the boot frame.
  assert.equal(owedHeal({ hasContent: false, quietTicks: HEAL_QUIET_TICKS, waiting: false, sinceHealMs: 0 }), false);
  assert.equal(owedHeal({ hasContent: false, quietTicks: 0, waiting: true, sinceHealMs: 60_000 }), false);
});

test('heal: a clock that has not advanced cannot force a heal', () => {
  assert.equal(owedHeal({ hasContent: true, quietTicks: 0, waiting: false, sinceHealMs: Number.NaN }), false);
  assert.equal(owedHeal({ hasContent: true, quietTicks: 0, waiting: false, sinceHealMs: -1 }), false);
});
