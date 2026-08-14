import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transition, isFeeAllowed, maxProperties, Event } from '../src/fsm/machine';
import { TokenBucket } from '../src/antiabuse/rateLimiter';
import { applyStrike } from '../src/antiabuse/strikes';
import { freshSession, canSend, resetToIdle, pushHistory } from '../src/fsm/session';
import { Classified } from '../src/llm/classify';

const ev = (type: string, extra: Record<string, unknown> = {}): Event =>
  ({ type, ...extra }) as Event;

const classified = (offensive: boolean, offenseLevel: number): Classified =>
  ({ event: ev('STAY'), offensive, offenseLevel }) as Classified;

test('FSM: happy path full funnel (v2 machine)', () => {
  // v2: intent is folded into discovery — idle+INTENT_DECLARED goes straight there.
  assert.equal(transition('idle', ev('INTENT_DECLARED', { service: 'buy' })), 'discovery');
  assert.equal(transition('discovery', ev('DETAILS_PROVIDED', { location: 'Карпош', bedrooms: 2, budget: '80.000 евра' })), 'discovery');
  assert.equal(transition('discovery', ev('SEARCH_REQUESTED')), 'presentation');
  assert.equal(transition('presentation', ev('INTERESTED')), 'closing');
  assert.equal(transition('closing', ev('FEE_AGREED')), 'contact_collection');
  // v2 visit sub-funnel: name+phone -> preferred time -> owner check -> pending.
  assert.equal(transition('contact_collection', ev('CONTACT_PROVIDED')), 'visit_scheduling');
  assert.equal(transition('visit_scheduling', ev('VISIT_TIME_PROVIDED')), 'owner_checking');
  assert.equal(transition('owner_checking', ev('OWNER_OK')), 'pending');
});

test('FSM: rejection returns to discovery (ask why)', () => {
  // v3: rejection never restarts discovery — it pulls the NEXT batch of alternatives.
  assert.equal(transition('presentation', ev('REJECTED')), 'presentation');
  assert.equal(transition('property_query', ev('REJECTED')), 'presentation');
  assert.equal(transition('closing', ev('REJECTED')), 'presentation');
});

test('FSM: incomplete contact loops back', () => {
  assert.equal(transition('contact_collection', ev('CONTACT_INCOMPLETE')), 'contact_collection');
});

test('FSM: direct property query by Evidenten broj', () => {
  assert.equal(transition('intent', ev('PROPERTY_ID_REQUESTED', { propertyId: 5 })), 'property_query');
});

test('FSM: escalation, timeout, reset', () => {
  // ESCALATE is legal from every conversational state (client asks for a manager).
  assert.equal(transition('presentation', ev('ESCALATE')), 'escalated');
  assert.equal(transition('closing', ev('ESCALATE')), 'escalated');
  assert.equal(transition('owner_checking', ev('ESCALATE')), 'escalated');
  assert.equal(transition('pending', ev('TIMEOUT')), 'idle');
  assert.equal(transition('terminated', ev('RESET')), 'idle');
  assert.equal(transition('presentation', ev('STAY')), 'presentation');
});

test('FSM: v2 owner sub-funnel — counter, unavailable, time negotiation', () => {
  assert.equal(transition('owner_checking', ev('OWNER_COUNTER')), 'time_confirm');
  assert.equal(transition('owner_checking', ev('OWNER_UNAVAILABLE')), 'presentation');
  assert.equal(transition('time_confirm', ev('TIME_ACCEPTED')), 'pending');
  assert.equal(transition('time_confirm', ev('TIME_REJECTED')), 'visit_scheduling');
});

test('FSM: fee refusal loops in closing; queued exits only via reset/timeout', () => {
  // 1st/2nd refusal stays in closing (persuasion ladder); the 3rd refusal -> queued is
  // pipeline logic (feeRejections counter), not the table. queued itself is a dead end.
  assert.equal(transition('closing', ev('FEE_REFUSED')), 'closing');
  assert.equal(transition('queued', ev('STAY')), 'queued');
  assert.equal(transition('queued', ev('TIMEOUT')), 'idle');
  assert.equal(transition('queued', ev('RESET')), 'idle');
});

test('FSM: ESCALATE legal from every conversational state', () => {
  for (const s of ['discovery', 'property_query', 'presentation', 'closing',
    'contact_collection', 'visit_scheduling', 'owner_checking', 'time_confirm'] as const) {
    assert.equal(transition(s, ev('ESCALATE')), 'escalated', `ESCALATE from ${s}`);
  }
});

test('FSM: terminated is a hard stop until reset', () => {
  assert.equal(transition('terminated', ev('STAY')), 'terminated');
  assert.equal(transition('terminated', ev('TIMEOUT')), 'terminated');
  assert.equal(transition('terminated', ev('RESET')), 'idle');
});

test('FSM: legality flags — fee timing and property caps', () => {
  assert.equal(isFeeAllowed('presentation'), false);
  assert.equal(isFeeAllowed('property_query'), false);
  assert.equal(isFeeAllowed('closing'), true);
  assert.equal(isFeeAllowed('contact_collection'), true);
  assert.equal(maxProperties('property_query'), 1);
  assert.equal(maxProperties('presentation'), 2);
  assert.equal(maxProperties('closing'), 1);
});

test('TokenBucket: 9 req/s cap respected', async () => {
  const bucket = new TokenBucket(9, 9);
  for (let i = 0; i < 9; i++) assert.equal(bucket.tryTake(), true);
  assert.equal(bucket.tryTake(), false);
  await new Promise(r => setTimeout(r, 1100));
  assert.equal(bucket.tryTake(), true);
});

test('Strikes: 3 warnings then terminate', () => {
  const s = freshSession('viber', 't1');
  assert.equal(applyStrike(s, classified(true, 1)), 'warn');
  assert.equal(applyStrike(s, classified(true, 1)), 'warnFinal');
  assert.equal(applyStrike(s, classified(true, 1)), 'terminate');
  assert.equal(s.strikes, 3);
});

test('Strikes: severe abuse terminates instantly', () => {
  const s = freshSession('viber', 't2');
  assert.equal(applyStrike(s, classified(true, 3)), 'terminate');
  assert.equal(s.strikes, 3);
});

test('Strikes: non-offensive input does nothing', () => {
  const s = freshSession('viber', 't3');
  assert.equal(applyStrike(s, classified(false, 0)), 'none');
  assert.equal(s.strikes, 0);
});

test('Session: Viber 100/hr outbound budget', () => {
  const s = freshSession('viber', 'c1');
  assert.equal(canSend(s), true);
  s.outboundCount = 99;
  assert.equal(canSend(s), true);
  s.outboundCount = 100;
  assert.equal(canSend(s), false);
});

test('Session: reset returns to a fresh idle state', () => {
  const s = freshSession('viber', 'c2');
  s.state = 'terminated';
  s.strikes = 3;
  s.slots.bedrooms = 2;
  pushHistory(s, { role: 'user', text: 'x' }, 20);
  resetToIdle(s);
  assert.equal(s.state, 'idle');
  assert.equal(s.strikes, 0);
  assert.equal(s.history.length, 0);
  assert.equal(s.resetGreeting, true);
});
