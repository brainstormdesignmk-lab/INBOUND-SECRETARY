// Router precedence tests — the order-dependent guards in inbound.ts encoded
// as data in src/handlers/router.ts. If a future detector insertion breaks one
// of these precedences, the mirror diverges from reality here FIRST — before
// it ships a wrong answer to a client.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';
import { resolveIntent, ROUTING_ORDER, dispatchSimple, routeLog, ROUTE_LANES } from '../src/handlers/router';
import { inferPropertyId } from '../src/llm/classify';
import { detectEyeCatch, detectAgreement } from '../src/llm/deterministic';
import { readRouteDrift, flushRouteDrift, setRouteDriftDir } from '../src/store/routeDrift';

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

test('explicit demands without каде enter the exact-address handler lane', () => {
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

test('shadow router: prediction and actual are compared, drift is logged', () => {
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  try {
    routeLog('drift-c1', 'MNOGU EFTINA CENA E TOA', 'FEE_PUSH', 'predict');
    routeLog('drift-c1', 'MNOGU EFTINA CENA E TOA', 'PRICE_EVAL_CHEAP');
    routeLog('drift-c2', 'MNOGU EFTINA CENA E TOA', 'PRICE_EVAL_CHEAP', 'predict');
    routeLog('drift-c2', 'MNOGU EFTINA CENA E TOA', 'PRICE_EVAL_CHEAP');
  } finally {
    console.log = original;
  }
  assert.ok(logs.some(l => l.includes('[route-drift] drift-c1')), 'a divergence must be visible');
  assert.ok(!logs.some(l => l.includes('[route-drift] drift-c2')), 'agreement stays quiet');
});

// THE TAXONOMY: only a turn both sides claim for a MIRRORED lane is a drift.
// The other two shapes used to be logged as drift, which trained the operator to
// ignore the line: the classifier's own route (the mirror's FALLTHROUGH means
// exactly "the classifier decides") and a lane that has NO mirror row yet (a
// pending-migration GAP, not a wrong prediction).
test('a divergence is a drift only when both sides claim a mirrored lane', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'route-taxonomy-'));
  setRouteDriftDir(dir);
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  try {
    // a pending lane serves after FALLTHROUGH — a GAP
    routeLog('tax-gap', 'DA NE E VO SKOPJANKA ?', 'FALLTHROUGH', 'predict');
    routeLog('tax-gap', 'DA NE E VO SKOPJANKA ?', 'POI_CONFIRM');
    // the classifier's own route — not a divergence at all
    routeLog('tax-classifier', 'KOJ E NAJBOLJI STAN ?', 'FALLTHROUGH', 'predict');
    routeLog('tax-classifier', 'KOJ E NAJBOLJI STAN ?', 'ROUTE_UNKNOWN:unknown.unknown.assert');
    // two MIRRORED lanes disagree — the real thing
    routeLog('tax-drift', 'MNOGU EFTINA CENA E TOA', 'FEE_PUSH', 'predict');
    routeLog('tax-drift', 'MNOGU EFTINA CENA E TOA', 'PRICE_EVAL_CHEAP');
  } finally {
    console.log = original;
  }
  assert.ok(ROUTE_LANES.POI_CONFIRM && ROUTE_LANES.POI_CONFIRM.intent === null,
    'the gap fixture must be a lane with no mirror row');
  assert.ok(logs.some(l => l.includes('[route-gap] tax-gap')), `a pending lane is a gap: ${logs.join(' | ')}`);
  assert.ok(!logs.some(l => l.includes('[route-drift] tax-gap')), 'a gap is never a drift');
  assert.ok(!logs.some(l => l.includes('[route-drift] tax-classifier') || l.includes('[route-gap] tax-classifier')),
    `a classifier hand-off is agreement, not drift: ${logs.join(' | ')}`);
  assert.ok(logs.some(l => l.includes('[route-drift] tax-drift')), 'a mirrored mismatch is still a drift');
  await flushRouteDrift();
  const rows = await readRouteDrift();
  assert.equal(rows.find(r => r.chatId === 'tax-gap')?.kind, 'gap',
    'the gap is persisted and labeled, so the mirror backlog is readable');
  assert.equal(rows.find(r => r.chatId === 'tax-drift')?.kind, 'drift');
  await fs.rm(dir, { recursive: true, force: true });
});

test('PRICE_EVAL_CHEAP beats the fee ladder for a compliment on the quoted price', () => {
  assert.equal(resolveIntent('MNOGU EFTINA CENA E TOA', 'closing'), 'PRICE_EVAL_CHEAP');
  assert.equal(resolveIntent('MNOGU EFTINA CENA E TOA', 'property_query'), 'PRICE_EVAL_CHEAP');
  // a question or a search is not the remark lane
  assert.notEqual(resolveIntent('DALI E DOBRA CENATA?', 'closing'), 'PRICE_EVAL_CHEAP');
  assert.notEqual(resolveIntent('MNOGU EFTINA CENA E TOA', 'discovery'), 'PRICE_EVAL_CHEAP');
});

test('BUSINESS_BUDGET_ASK is an explicit intake-gated route', () => {
  assert.equal(resolveIntent('Колку чини деловен простор во Центар?', 'idle'), 'BUSINESS_BUDGET_ASK');
  assert.equal(resolveIntent('Колку чини деловен простор во Центар?', 'discovery'), 'BUSINESS_BUDGET_ASK');
  // once a flat is on the table, its price and the fee protocol own the money talk
  assert.notEqual(resolveIntent('Колку чини деловен простор во Центар?', 'closing'), 'BUSINESS_BUDGET_ASK');
  assert.notEqual(resolveIntent('Колку чини деловен простор во Центар?', 'property_query'), 'BUSINESS_BUDGET_ASK');
  // residential price questions are not commercial traffic
  assert.notEqual(resolveIntent('Колку чини стан во Центар?', 'discovery'), 'BUSINESS_BUDGET_ASK');
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

// --- dispatchSimple table tests ---

test('dispatchSimple: OFFTOPIC fires in idle state', () => {
  const r = dispatchSimple('како си', 'idle');
  assert.equal(r?.intent, 'OFFTOPIC');
});

test('dispatchSimple: OFFTOPIC does NOT fire in owner_checking', () => {
  const r = dispatchSimple('како си', 'owner_checking');
  assert.equal(r, undefined);
});

test('dispatchSimple: DEFER fires in closing', () => {
  const r = dispatchSimple('ќе размислам', 'closing');
  assert.equal(r?.intent, 'DEFER');
});

test('dispatchSimple: DEFER does NOT fire in idle', () => {
  const r = dispatchSimple('ќе размислам', 'idle');
  assert.equal(r, undefined);
});

test('dispatchSimple: ESCALATION fires in any state', () => {
  for (const st of ['idle', 'closing', 'discovery', 'presentation']) {
    const r = dispatchSimple('сакам менаџер', st);
    assert.equal(r?.intent, 'ESCALATION', st);
  }
});

test('dispatchSimple: NEGOTIATE fires in presentation', () => {
  const r = dispatchSimple('popust', 'presentation');
  assert.equal(r?.intent, 'NEGOTIATE');
});

test('dispatchSimple: NEGOTIATE does NOT fire in idle', () => {
  const r = dispatchSimple('popust', 'idle');
  assert.equal(r, undefined);
});

test('dispatchSimple: SCHEDULING_FLEX fires in visit_scheduling', () => {
  const r = dispatchSimple('само попладне', 'visit_scheduling');
  assert.equal(r?.intent, 'SCHEDULING_FLEX');
});

test('dispatchSimple: returns undefined for unrecognized text', () => {
  const r = dispatchSimple('јаболко', 'idle');
  assert.equal(r, undefined);
});

test('dispatchSimple: order matters — DEFER before NEGOTIATE', () => {
  const r = dispatchSimple('ќе размислам за цената', 'closing');
  assert.equal(r?.intent, 'DEFER');
});

// --- the inFORMiraj bug: the English `forms?` alternative inside the
// documents regex matched inside "informiraj" (no word boundary), so ANY
// message containing informiraj/informacija routed to DOCUMENTS_ASK. ---

test('inform-family does NOT trigger DOCUMENTS_ASK (the inFORMiraj bug)', () => {
  for (const t of [
    'STAPI VO KONTAKT I INFORMIRAJ ME',
    'informiraj me', 'ИНФОРМИРАЈ МЕ',
    'koga ke me informirate?',
    'sakam da me informirate za dostapnosta',
  ]) {
    assert.equal(resolveIntent(t, 'closing'), 'FALLTHROUGH',
      `"${t}" must not route to DOCUMENTS_ASK`);
  }
});

test('genuine documents questions still route to DOCUMENTS_ASK', () => {
  for (const t of ['sto dokumenti se potrebni?', 'какви документи треба?', 'documents needed?']) {
    assert.equal(resolveIntent(t, 'closing'), 'DOCUMENTS_ASK', `"${t}"`);
  }
});

test('contact-request family counts as agreement (stapi vo kontakt)', () => {
  for (const t of [
    'STAPI VO KONTAKT I INFORMIRAJ ME',
    'stapi vo kontakt so mene', 'стапи во контакт со сопственикот',
    'vlezi vo kontakt so menе', 'СТАПЕТЕ ВО КОНТАКТ',
  ]) {
    assert.equal(detectAgreement(t), true, `agreement expected: "${t}"`);
  }
});
