import { test } from 'node:test';
import assert from 'node:assert/strict';
import { transition, isFeeAllowed, maxProperties, Event } from '../src/fsm/machine';
import { TokenBucket } from '../src/antiabuse/rateLimiter';
import { applyStrike, applyStrikeDecay } from '../src/antiabuse/strikes';
import { classifyOffensive } from '../src/antiabuse/offensive';
import { freshSession, canSend, resetToIdle, pushHistory } from '../src/fsm/session';

const ev = (type: string, extra: Record<string, unknown> = {}): Event =>
  ({ type, ...extra }) as Event;

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
  // intake denials ("не барам стан") enter discovery so Lina pivots
  assert.equal(transition('idle', ev('REJECTED')), 'discovery');
  assert.equal(transition('intent', ev('REJECTED')), 'discovery');
  assert.equal(transition('discovery', ev('REJECTED')), 'discovery');
});

test('FSM: incomplete contact loops back', () => {
  assert.equal(transition('contact_collection', ev('CONTACT_INCOMPLETE')), 'contact_collection');
});

test('FSM: direct property query by Evidenten broj', () => {
  assert.equal(transition('intent', ev('PROPERTY_ID_REQUESTED', { propertyId: 5 })), 'property_query');
});

test('FSM: a seen property without a number routes to property_locate', () => {
  // intake states -> locate funnel; number known -> easy property_query
  assert.equal(transition('idle', ev('SEEN_PROPERTY')), 'property_locate');
  assert.equal(transition('intent', ev('SEEN_PROPERTY')), 'property_locate');
  assert.equal(transition('discovery', ev('SEEN_PROPERTY')), 'property_locate');
  assert.equal(transition('property_locate', ev('PROPERTY_ID_REQUESTED', { propertyId: 54 })), 'property_query');
  // details keep the funnel collecting; picking a match -> closing (fee flow)
  assert.equal(transition('property_locate', ev('DETAILS_PROVIDED')), 'property_locate');
  assert.equal(transition('property_locate', ev('INTERESTED', { propertyId: 54 })), 'closing');
  assert.equal(transition('property_locate', ev('REJECTED')), 'property_locate');
  assert.equal(transition('property_locate', ev('STAY')), 'property_locate');
  assert.equal(transition('property_locate', ev('ESCALATE')), 'escalated');
  // mid-funnel the client remembers the number -> back to the easy lookup
  assert.equal(transition('presentation', ev('SEEN_PROPERTY')), 'property_locate');
});

test('FSM: legality flags — property_locate shows at most 2 matches, no fee', () => {
  assert.equal(isFeeAllowed('property_locate'), false);
  assert.equal(maxProperties('property_locate'), 2);
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

test('Strikes: 3 warnings then terminate (ANA protocol)', () => {
  const s = freshSession('viber', 't1');
  assert.equal(applyStrike(s, classifyOffensive('Ајде бе, глупава си!')), 'warn');
  assert.equal(applyStrike(s, classifyOffensive('Што ме замараш, дебилу!')), 'warnFinal');
  assert.equal(applyStrike(s, classifyOffensive('Иди земи си, курво!')), 'terminate');
  assert.equal(s.strikes, 3);
});

test('Strikes: severe abuse still escalates one strike at a time (no instant terminate)', () => {
  const s = freshSession('viber', 't2');
  // severity 3 (sexual/violence) is a strike like any other — ANA's rule: no
  // offense type skips the warning stage.
  assert.equal(applyStrike(s, classifyOffensive('DA SE EBETE VO GAZOT')), 'warn');
  assert.equal(s.strikes, 1);
});

test('Strikes: clean input does nothing', () => {
  const s = freshSession('viber', 't3');
  assert.equal(applyStrike(s, classifyOffensive('sakam stan vo centar do 250 evra')), 'none');
  assert.equal(s.strikes, 0);
});

test('Strikes: strike 1 decays on a clean message; strike 2 never decays', () => {
  const s = freshSession('viber', 't4');
  assert.equal(applyStrike(s, classifyOffensive('debilu')), 'warn');
  assert.equal(s.strikes, 1);
  // clean message after strike 1 -> the client corrected themselves -> reset
  assert.equal(applyStrike(s, classifyOffensive('sakam stan vo centar')), 'none');
  assert.equal(s.strikes, 0);
  // two consecutive offenses -> strike 2 (final warning)
  assert.equal(applyStrike(s, classifyOffensive('debilu')), 'warn');
  assert.equal(applyStrike(s, classifyOffensive('glupava si')), 'warnFinal');
  assert.equal(s.strikes, 2);
  // clean message after strike 2 -> NEVER decays
  assert.equal(applyStrike(s, classifyOffensive('sakam stan vo centar')), 'none');
  assert.equal(s.strikes, 2);
  // any further offense terminates
  assert.equal(applyStrike(s, classifyOffensive('debilu')), 'terminate');
  assert.equal(s.strikes, 3);
});

test('StrikeDecay: 1 resets on clean, 2+ never decays', () => {
  assert.equal(applyStrikeDecay(0, true), 1);
  assert.equal(applyStrikeDecay(1, false), 0);
  assert.equal(applyStrikeDecay(2, false), 2);
  assert.equal(applyStrikeDecay(2, true), 3);
  assert.equal(applyStrikeDecay(3, true), 3);
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
