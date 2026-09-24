/**
 * Owner-relay judge assertions — the 20:24/20:26 misroute classes.
 *
 * The owner-exchange serves used to be invisible to the enrichment log, so a
 * wrong relay (the owner's whole-day Saturday dropped, a working-hours
 * question forwarded to the owner as a proposed term, an English day in the
 * Macedonian sentence) looked identical to a healthy one. Three surfaces are
 * pinned here:
 *   1. the judge assertions (owner-relay-* / owner-ask-*) fire on the exact
 *      misroute classes and stay silent on healthy exchanges;
 *   2. the handler LOGS the owner ask (raw client term) and every relay
 *      (verdict + relayed text) as OWNER_ASK / OWNER_RELAY rows;
 *   3. e2e: the whole-day counter relay carries the day AND the clock-ask,
 *      the fixed-clock counter carries the day + clock, and the enrichment
 *      rows match the verdict that produced them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { ASSERTIONS } from '../scripts/judge-enrichment';
import { detectWorkdaysQuestion } from '../src/llm/deterministic';
import { makeOwnerRelayTestHarness, reachOwnerChecking } from './helpers/owner-relay-harness';

const owner = (id: string) => ASSERTIONS.find(a => a.id === id)!;

const violates = (id: string, row: any) => owner(id).violates(row);

// ── 1. Judge assertions ──────────────────────────────────────────────────────

test('judge: healthy whole-day relay never flags', () => {
  const row = {
    eventType: 'OWNER_RELAY',
    userMsg: '[owner:78] counter+wholeday @ Сабота',
    bankKey: 'owner.relay:counter.wholeday',
    replyText: 'Сопственикот не може во предложениот термин, но го нуди Сабота во целост — било кое време му одговара. Во колку часот би сакале да дојдете?',
  };
  assert.equal(violates('owner-relay-dropped-alternative', row), false);
  assert.equal(violates('owner-relay-wholeday-as-fixed-term', row), false);
  assert.equal(violates('owner-relay-english-day', row), false);
});

test('judge: dropped-alternative relay (the 20:24 class) flags', () => {
  // The verdict carried "@ Сабота" but the relay never mentions it — Lina
  // re-asked from zero while the owner had just offered the whole Saturday.
  const row = {
    eventType: 'OWNER_RELAY',
    userMsg: '[owner:78] counter @ Сабота',
    bankKey: 'owner.relay:counter',
    replyText: 'Сопственикот не може во тој термин (Утре во 17:00). Кој термин би Ви одговарал за посета?',
  };
  assert.equal(violates('owner-relay-dropped-alternative', row), true);
});

test('judge: whole-day verdict relayed as a FIXED term flags', () => {
  const row = {
    eventType: 'OWNER_RELAY',
    userMsg: '[owner:78] counter+wholeday @ Сабота',
    bankKey: 'owner.relay:counter.wholeday',
    replyText: 'Сопственикот го нуди Сабота. Дали се согласувате на овој термин?',
  };
  assert.equal(violates('owner-relay-wholeday-as-fixed-term', row), true);
});

test('judge: English day in the Macedonian relay flags', () => {
  const row = {
    eventType: 'OWNER_RELAY',
    userMsg: '[owner:78] counter @ Петок во 11',
    bankKey: 'owner.relay:counter',
    replyText: 'Сопственикот не може во тој термин (Friday 18:00). Кој термин би Ви одговарал?',
  };
  assert.equal(violates('owner-relay-english-day', row), true);
});

test('judge: working-hours question forwarded as a visit term flags (20:26)', () => {
  assert.equal(detectWorkdaysQuestion('VO NEDELA RABOTITE ?'), true,
    'the question must be detected for the assertion to fire');
  const row = {
    eventType: 'OWNER_ASK',
    userMsg: 'VO NEDELA RABOTITE ?',
    bankKey: 'owner.ask',
    replyText: 'Здраво. … Клиентот сака посета: VO NEDELA RABOTITE ?. Дали се согласувате на овој термин…',
  };
  assert.equal(violates('owner-ask-question-as-term', row), true);
  // A REAL proposed term never flags:
  assert.equal(violates('owner-ask-question-as-term', {
    eventType: 'OWNER_ASK', userMsg: 'UTRE PO 18:00', bankKey: 'owner.ask', replyText: '…',
  }), false);
});

// ── 2. The handler logs the exchange ────────────────────────────────────────

test('e2e: whole-day counter logs OWNER_RELAY with verdict-consistent fields; relay carries day + clock-ask', async () => {
  const h = await makeOwnerRelayTestHarness();
  await reachOwnerChecking(h.send);

  h.handler.ownerAnswer('relay', 78, { status: 'counter', ownerTime: 'сабота', canAcceptWholeDay: true });
  await new Promise(r => setTimeout(r, 60));

  const last = h.sent[h.sent.length - 1];
  assert.match(last, /Сабота/u, 'the day must reach the client');
  assert.match(last, /во колку часот|кое време|кога\s+би\s+сакале/iu, 'the client is asked for the clock');

  const rows = h.ownerLogRows();
  const relayRow = rows.filter(r => r.eventType === 'OWNER_RELAY').at(-1)!;
  assert.ok(relayRow, 'OWNER_RELAY row must be logged');
  assert.match(relayRow.bankKey!, /owner\.relay:counter\.wholeday/);
  assert.match(relayRow.userMsg, /\[owner:78\] counter\+wholeday @ Сабота/u);
  // The logged relay is consistent with the verdict — judge-clean by design.
  for (const a of ASSERTIONS.filter(a => a.id.startsWith('owner-'))) {
    assert.equal(a.violates(relayRow), false, `${a.id} must stay silent`);
  }
});

test('e2e: fixed-clock counter logs the full term; the day and clock both reach the client', async () => {
  const h = await makeOwnerRelayTestHarness();
  await reachOwnerChecking(h.send);

  h.handler.ownerAnswer('relay', 78, { status: 'counter', ownerTime: 'Петок во 11' });
  await new Promise(r => setTimeout(r, 60));

  const last = h.sent[h.sent.length - 1];
  assert.match(last, /Петок во 11/u);
  const relayRow = h.ownerLogRows().filter(r => r.eventType === 'OWNER_RELAY').at(-1)!;
  assert.match(relayRow.userMsg, /@ Петок во 11/u);
  assert.match(relayRow.bankKey!, /owner\.relay:counter$/);
});

test('e2e: the owner ask logs the client RAW proposed term under owner.ask', async () => {
  const h = await makeOwnerRelayTestHarness();
  // reachOwnerChecking proposes 'UTRE POPLADNE POSLE 6' → runOwnerCheck fires.
  await reachOwnerChecking(h.send);
  const askRow = h.ownerLogRows().filter(r => r.eventType === 'OWNER_ASK').at(-1)!;
  assert.ok(askRow, 'OWNER_ASK row must be logged');
  assert.equal(askRow.bankKey, 'owner.ask');
  assert.match(askRow.userMsg, /UTRE POPLADNE POSLE 6/);
  // Real proposed term → judge-clean.
  assert.equal(violates('owner-ask-question-as-term', askRow), false);
});

test('e2e: bare counter (no alternative) logs owner.relay:counter without a time tag', async () => {
  const h = await makeOwnerRelayTestHarness();
  await reachOwnerChecking(h.send);
  h.handler.ownerAnswer('relay', 78, { status: 'counter' });
  await new Promise(r => setTimeout(r, 60));
  const relayRow = h.ownerLogRows().filter(r => r.eventType === 'OWNER_RELAY').at(-1)!;
  assert.match(relayRow.userMsg, /\[owner:78\] counter$/u, 'no @ time tag when nothing was offered');
});
