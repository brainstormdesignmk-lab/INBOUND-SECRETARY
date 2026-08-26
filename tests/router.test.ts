// Router precedence tests — the order-dependent guards in inbound.ts encoded
// as data in src/handlers/router.ts. If a future detector insertion breaks one
// of these precedences, the mirror diverges from reality here FIRST — before
// it ships a wrong answer to a client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveIntent, ROUTING_ORDER } from '../src/handlers/router';
import { inferPropertyId } from '../src/llm/classify';
import { detectEyeCatch } from '../src/llm/deterministic';

test('routing order has unique intents', () => {
  const names = ROUTING_ORDER.map(r => r.intent);
  assert.equal(new Set(names).size, names.length, 'duplicate intent in ROUTING_ORDER');
});

test('WHERE_IS beats EXACT_ADDRESS for каде-prefixed questions (the lokacijata bug)', () => {
  for (const t of [
    'kade mu e lokacijata ?', 'kade mu e adresata', 'Каде адресата?',
    'KADE TOCNO SE NAOGJA ?', 'kade tocno',
    'KADE PO TOCNO ?', 'kade potocno ?',
  ]) {
    assert.notEqual(resolveIntent(t, 'closing'), 'EXACT_ADDRESS',
      `"${t}" must not route to privacy protocol`);
  }
});

test('explicit demands without каде still get the protocol', () => {
  for (const t of ['ulica i broj?', 'moram da znam adresata', 'daj mi ja adresata']) {
    assert.equal(resolveIntent(t, 'closing'), 'EXACT_ADDRESS', `"${t}"`);
  }
});

test('owner contact beats WHERE_IS ("kade ti e telefonot?")', () => {
  // A каде-question that is really a contact request must route to OWNER_CONTACT
  const r = ROUTING_ORDER.findIndex(x => x.intent === 'OWNER_CONTACT');
  const w = ROUTING_ORDER.findIndex(x => x.intent === 'WHERE_IS');
  assert.ok(r < w, 'OWNER_CONTACT must sit before WHERE_IS');
});

test('PROPERTY_DESCRIPTION precedes state-gated intents', () => {
  const d = ROUTING_ORDER.findIndex(x => x.intent === 'PROPERTY_DESCRIPTION');
  const o = ROUTING_ORDER.findIndex(x => x.intent === 'OFFTOPIC');
  assert.ok(d < o, 'description flow must not be swallowed by small talk');
});

test('ESCALATION has no state gate and fires anywhere late in the chain', () => {
  for (const s of ['idle', 'closing', 'presentation', 'visit_scheduling']) {
    assert.equal(resolveIntent('sakam da zboruvam so menadzer', s), 'ESCALATION', `state=${s}`);
  }
});

test('state-gated intents do not fire in wrong states', () => {
  assert.notEqual(resolveIntent('moze li pomala cena', 'visit_scheduling'), 'NEGOTIATE');
  assert.notEqual(resolveIntent('samo popladne', 'closing'), 'SCHEDULING_FLEX');
});

test('eye-catch idiom supplies the EB ("mi fati oko 94" bug)', () => {
  // The idiom's "око" must NOT read as a price cap ("околу 250") — the
  // number is the Евидентен број and the client gets the visit-offer ack.
  for (const t of ['MI FATI OKO 94 ?', 'ми фати окото 94', 'MI PADNA VO OKO 76']) {
    assert.equal(inferPropertyId(t) !== undefined, true, `eb expected: ${t}`);
    assert.equal(detectEyeCatch(t), true, `eyecatch expected: ${t}`);
  }
  // Genuine budget caps still guard against EB hallucination.
  assert.equal(inferPropertyId('bilo kade do 250'), undefined);
  assert.equal(detectEyeCatch('bilo kade do 250'), false);
});
