import { test } from 'node:test';
import assert from 'node:assert';
import { Db } from '../src/store/db';
import { EventStore } from '../src/store/events';
import { OwnerStore } from '../src/store/owners';
import { DeferredOwnerAgent, OwnerVerdict } from '../src/backoffice/ownerAgent';

// THE 21:34 BUG: a leftover pending owner_check_result ("counter 19:00") on
// the events bus from an EARLIER visit instantly satisfied the NEXT check for
// the same chatId+EB — Lina relayed a time-shift the owner NEVER GAVE. The
// freshness guard must consume-and-drop stale events and only accept events
// created after the current check started.

test('stale pending owner_check_result is dropped, never consumed by a later check', async () => {
  const db = new Db(':memory:');
  const events = new EventStore(db);
  const owners = new OwnerStore(db);
  const agent = new DeferredOwnerAgent(owners, events, 30_000, 25);

  // An answer from THE PAST sits on the bus: nobody consumed it (process died
  // between insert and poll), it lingers pending forever.
  events.insert('owner_check_result', 'chat-x', 79, {
    status: 'counter', ownerTime: 'Во 19:00',
  } satisfies OwnerVerdict);

  // Small delay so the stale event's createdAt is strictly BEFORE the new check.
  await new Promise(r => setTimeout(r, 15));

  const p = agent.check('chat-x', 79, 'VO SABOTA VO 12:00');
  const race = await Promise.race([
    p.then(v => ({ kind: 'verdict' as const, v })),
    new Promise<{ kind: 'timeout' }>(r => setTimeout(() => r({ kind: 'timeout' }), 250)),
  ]);
  assert.equal(race.kind, 'timeout', 'stale event must NOT resolve the new check');
  // The stale event was consumed-and-dropped at request time (never fires again)
  assert.equal(events.listPending('owner_check_result').length, 0, 'stale event must be resolved/dropped');
});

test('a FRESH owner_check_result (after the request) still resolves the check', async () => {
  const db = new Db(':memory:');
  const events = new EventStore(db);
  const owners = new OwnerStore(db);
  const agent = new DeferredOwnerAgent(owners, events, 30_000, 25);

  const p = agent.check('chat-y', 79, 'VO SABOTA VO 12:00');
  // Answer arrives after the request — must resolve.
  await new Promise(r => setTimeout(r, 60));
  assert.equal(agent.answer('chat-y', 79, { status: 'ok', ownerTime: 'Сабота 12:00' }), true);
  const v = await p;
  assert.equal(v.status, 'ok');
  assert.equal(v.ownerTime, 'Сабота 12:00');
});
