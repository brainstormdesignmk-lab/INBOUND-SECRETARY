// The owner's corrected address — the queue that carries it to the app.
//
// WHY THIS TEST EXISTS: the correction used to stop at
// `appointments.corrected_address` and live only in that one visit's turns, so
// the public listing kept the feed's wrong street forever. These tests pin the
// contract of the queue that fixes that: it is written exactly once per real
// change, it is never written for a no-op, and a synced row cannot come back.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/store/db';
import { AddressChangeStore, sameAddress } from '../src/store/addressChanges';

test('a real correction is queued once; a repeat or a no-op is not', () => {
  const store = new AddressChangeStore(new Db(':memory:'));

  // The owner corrects the feed's address at Turn 0 → queued for the app.
  assert.equal(store.insertIfChanged({
    eb: 78, oldAddress: 'Народен Фронт', newAddress: 'Васил Стефановски 16', chatId: 'c1',
  }), true);
  assert.equal(store.listPending().length, 1);

  // The SAME owner corrects to the SAME address on a later visit → still one row.
  assert.equal(store.insertIfChanged({
    eb: 78, oldAddress: 'Народен Фронт', newAddress: 'Васил Стефановски 16',
  }), false, 'a duplicate pending correction must not stack up');
  assert.equal(store.listPending().length, 1);

  // The feed already has it → there is nothing to publish.
  assert.equal(store.insertIfChanged({
    eb: 79, oldAddress: 'ул. Партизанска 16', newAddress: 'партизанска 16',
  }), false, 'an unchanged address is not a change');
  // …and an empty answer is never a change.
  assert.equal(store.insertIfChanged({ eb: 80, oldAddress: 'X 1', newAddress: '   ' }), false);

  assert.equal(store.listPending().length, 1);
});

test('resolve empties the queue; a later move is queued again', () => {
  const store = new AddressChangeStore(new Db(':memory:'));
  assert.equal(store.insertIfChanged({
    eb: 5, oldAddress: 'А 1', newAddress: 'Б 2', chatId: 'chat-5',
  }), true);

  const [row] = store.listPending();
  assert.equal(row.eb, 5);
  assert.equal(row.oldAddress, 'А 1');
  assert.equal(row.newAddress, 'Б 2');
  assert.equal(row.chatId, 'chat-5');
  assert.equal(row.source, 'owner');
  assert.equal(row.status, 'pending');
  assert.equal(row.resolvedAt, null);

  // Hermes applied it (2xx from update-property-address) → resolved.
  store.resolve(row.id);
  assert.equal(store.listPending().length, 0, 'a synced correction is not pending');

  // The owner moves again later — that is a NEW fact, and it must be queued.
  assert.equal(store.insertIfChanged({ eb: 5, oldAddress: 'Б 2', newAddress: 'Б 2' }), false);
  assert.equal(store.insertIfChanged({ eb: 5, oldAddress: 'Б 2', newAddress: 'В 3' }), true);
  const pending = store.listPending();
  assert.equal(pending.length, 1);
  assert.equal(pending[0].newAddress, 'В 3');
});

test('sameAddress ignores case, punctuation and the street prefix', () => {
  assert.ok(sameAddress('ул. Партизанска 16', 'партизанска 16'));
  assert.ok(sameAddress('Васил Стефановски 16', 'васил стефановски, 16'));
  assert.ok(!sameAddress('Васил Стефановски 16', 'Васил Стефановски 18'));
  // Two different languages for the same street are NOT collapsed — a human
  // decides those, and a wrong merge would rewrite the listing silently.
  assert.ok(!sameAddress('ул. Партизанска 16', 'Partizanska 16'));
});
