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

// THE PRE-SERVE GUESS IS NOT A LANE (regression, Phase 4 slice 3/4): the
// classifier logs `ROUTE_UNKNOWN:unknown.property-price.ask` before the
// deterministic block, so a correctly served price turn (predicted=INFO_ASK)
// used to be persisted as a GAP. Gaps are the mirror backlog — filling it with
// turns that were served correctly makes the backlog unreadable.
test('a ROUTE_UNKNOWN guess never records a gap, whatever the prediction', async () => {
  const dir = await fs.mkdtemp(path.join(tmpdir(), 'route-guess-'));
  setRouteDriftDir(dir);
  const logs: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
  try {
    routeLog('guess-c1', 'KOLKU E CENATA NA STANOT ?', 'INFO_ASK', 'predict');
    routeLog('guess-c1', 'KOLKU E CENATA NA STANOT ?', 'ROUTE_UNKNOWN:unknown.property-price.ask');
    routeLog('guess-c1', 'KOLKU E CENATA NA STANOT ?', 'INFO_ASK');
  } finally {
    console.log = original;
  }
  assert.ok(!logs.some(l => l.includes('[route-gap] guess-c1') || l.includes('[route-drift] guess-c1')),
    `the guess carries no lane information: ${logs.join(' | ')}`);
  await flushRouteDrift();
  const rows = await readRouteDrift();
  assert.equal(rows.find(r => r.chatId === 'guess-c1'), undefined, 'nothing is persisted for the guess');
  await fs.rm(dir, { recursive: true, force: true });
});

test('PRICE_EVAL_CHEAP beats the fee ladder for a compliment on the quoted price', () => {
  assert.equal(resolveIntent('MNOGU EFTINA CENA E TOA', 'closing'), 'PRICE_EVAL_CHEAP');
  assert.equal(resolveIntent('MNOGU EFTINA CENA E TOA', 'property_query'), 'PRICE_EVAL_CHEAP');
  // a question or a search is not the remark lane
  assert.notEqual(resolveIntent('DALI E DOBRA CENATA?', 'closing'), 'PRICE_EVAL_CHEAP');
  assert.notEqual(resolveIntent('MNOGU EFTINA CENA E TOA', 'discovery'), 'PRICE_EVAL_CHEAP');
});

// ── THE PRICE FAMILY (Phase 4, slice 3) ────────────────────────────────────
// Every assertion below was RED before the rows existed: the mirror claimed a
// market band (or nothing at all) for turns the executor answers from the flat
// that is actually on the table.
test('a price ask about the flat on the table is the INFO block, never a market band', () => {
  const onTable = { propertyId: 78, presentedIds: [78], lastPrice: '185000' } as any;
  // the arm stood down here (anchored flat + rent-only wording) and the INFO
  // block answered with the flat's own rent — the mirror called it a market ask
  assert.equal(resolveIntent('KOLKU MU E KIRIJA ?', 'idle',
    { ...onTable, service: 'rent' } as any), 'INFO_ASK');
  assert.equal(resolveIntent('KOLKU E CENATA NA STANOT?', 'presentation', onTable), 'INFO_ASK');
  // a FACETLESS chat has no flat to quote
  assert.equal(resolveIntent('KOLKU E CENATA?', 'idle'), 'PRICE_ASK');
  // …and the market band itself is untouched
  assert.equal(resolveIntent('KAKO SE DVIZAT CENIVE ZA STANOVI VO AERODROM?', 'idle'), 'MARKET_PRICE');
});

test('PRICE_FRESHNESS owns «is the price still current»', () => {
  const onTable = { propertyId: 78, presentedIds: [78], lastPrice: '185000' } as any;
  for (const t of ['A DALI MU E USTE TAA CENA?', 'DALI CENATA E AKTUALNA?']) {
    assert.equal(resolveIntent(t, 'closing', onTable), 'PRICE_FRESHNESS', t);
  }
  // nothing on the table → no price that can be «still» current
  assert.notEqual(resolveIntent('A DALI MU E USTE TAA CENA?', 'idle'), 'PRICE_FRESHNESS');
});

test('the negative price evaluation is predicted through the arbiter, not a private gate', () => {
  const onTable = { propertyId: 78, presentedIds: [78], lastPrice: '185000' } as any;
  assert.equal(resolveIntent('SKAPA E CENATA', 'presentation', onTable), 'PRICE_EVAL_EXPENSIVE');
  // a bare valence without the price NOUN keeps its own lane (the arbiter's
  // evidence boundary), and a fee objection is never a price evaluation
  assert.notEqual(resolveIntent('SKAPA E CENATA', 'presentation'), 'PRICE_EVAL_EXPENSIVE');
  assert.notEqual(resolveIntent('PARI ZA POSETA ZEMATE ?', 'presentation', onTable), 'PRICE_EVAL_EXPENSIVE');
});

test('the rent-math and rent-terms lanes never fall to the fee or the band', () => {
  assert.equal(resolveIntent('kirijata e 400, polovina za vas?', 'closing'), 'RENT_MATH');
  assert.equal(resolveIntent('KAKVI SE USLOVITE ZA IZNAJMUVANJE ?', 'idle'), 'RENT_TERMS');
});

test('NEGOTIATE sits above the info block, as the executor orders them', () => {
  const n = ROUTING_ORDER.findIndex(x => x.intent === 'NEGOTIATE');
  const i = ROUTING_ORDER.findIndex(x => x.intent === 'INFO_ASK');
  assert.ok(n >= 0 && n < i, 'a price pushback is served before the info block');
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

// ── the year/renovation mirror row (Phase 4, describe family) ────────────────
// The executor serves a COLD year/renovation ask under its own tag
// (inbound.ts 8040–8049: no flat bound → the property-agnostic miss line) and a
// BOUND one under INFO_ASK. Without the row the cold case predicted INFO_ASK and
// the registry logged a gap on a correct serve (probe: .bench/year-mirror.ts).
test('a cold year/renovation ask is INFO_ASK_YEAR; a bound one stays INFO_ASK', () => {
  for (const t of ['od koja godina e zgradata?', 'КОЈА ГОДИНА Е ИЗГРАДЕНА?', 'koga e renovirana?']) {
    assert.equal(resolveIntent(t, 'idle'), 'INFO_ASK_YEAR', t);
    assert.equal(resolveIntent(t, 'closing', { propertyId: 78, interestedPropertyId: 78 }), 'INFO_ASK',
      `${t} with a flat bound`);
    assert.equal(resolveIntent(t, 'closing', { presentedIds: [79] }), 'INFO_ASK',
      `${t} with a presented flat`);
  }
});

// ── the enthusiasm and recommendation rows (Phase 4, place/reaction family) ──
// Both were `P(...)`; the replay probe (.bench/place-mirror.ts) is what settled
// their gates, and it caught two wrong drafts (detectEyeCatch instead of
// detectPositiveEval, and a slot-only binding test the executor does not use).
test('praise of a flat on the table is ENTHUSIASM; a bare compliment is not', () => {
  assert.equal(resolveIntent('ODLICNA LOKACIJA IMA', 'presentation', { presentedIds: [78] }), 'ENTHUSIASM');
  assert.notEqual(resolveIntent('ODLICNA LOKACIJA IMA', 'presentation'), 'ENTHUSIASM',
    'nothing on the table: the executor has no flat to praise');
  // «ova mi fati oko» is an eye-catch phrase, NOT the praise lane (the probe:
  // the executor served nothing for it) — the row must not claim it either.
  assert.notEqual(resolveIntent('OVA MI FATI OKO', 'presentation', { presentedIds: [78] }), 'ENTHUSIASM');
  // closing only with an owner check pending (the executor's own condition).
  assert.notEqual(resolveIntent('ODLICNA LOKACIJA IMA', 'closing', { presentedIds: [78] }), 'ENTHUSIASM');
});

test('a recommendation ask is RECOMMEND_ASK only where the executor admits it', () => {
  assert.equal(resolveIntent('koj bi mi go preporacale?', 'presentation'), 'RECOMMEND_ASK');
  assert.equal(resolveIntent('koj bi mi go preporacale?', 'closing'), 'RECOMMEND_ASK');
  assert.notEqual(resolveIntent('koj bi mi go preporacale?', 'contact_collection'), 'RECOMMEND_ASK',
    'past the funnel the pick has been made — the executor does not admit the state');
});

// ── the describe / price-extreme rows (Phase 4, describe family) ─────────────
// Both were `P(...)`; the replay probe (.bench/describe-probe.ts) settled them:
// 5/5 exact after two corrections (the slot set for DESCRIBE_TABLE, and
// PRICE_AVG_NASELBA reverted to P because its gate is the FEED's per-м² data —
// when the feed cannot rank, the executor serves PRICE_EXTREME, and a row for
// the aggregate would predict the answer that does not happen).
test('a describe ask over a table is DESCRIBE_TABLE; without a table it is not', () => {
  assert.equal(resolveIntent('OPISI MI GI ?', 'presentation', { describedEbs: [78, 63] }), 'DESCRIBE_TABLE');
  assert.equal(resolveIntent('OPISI MI GO 78', 'presentation', { presentedIds: [78, 63] }), 'DESCRIBE_TABLE');
  assert.notEqual(resolveIntent('OPISI MI GI ?', 'presentation'), 'DESCRIBE_TABLE',
    'nothing on the table: there is no card to describe');
});

// ── the locate funnel rows (Phase 4, locate family) ───────────────────────────
// All three were `P(...)`. Each row imports the executor's OWN gate now
// (`./locate-pick`): the funnel's gates lived in inbound.ts, which the router
// cannot import, so a mirror row could only have been a second copy. The
// negatives matter as much as the positives — they are the cases where the
// funnel must NOT take the turn (a bare «NE» with no hunt is the goodbye, a
// plain «DA» with no exhausted area is not a widen).
test('a pick among described flats is PICK_DESCRIBED', () => {
  const sl = { describedEbs: [78, 63] };
  assert.equal(resolveIntent('PRVATA', 'presentation', sl), 'PICK_DESCRIBED');
  assert.equal(resolveIntent('VTORATA', 'presentation', sl), 'PICK_DESCRIBED');
  // An EB picks ONLY when it is one of the described set (a stranger EB is a
  // fresh card, not a pick).
  assert.equal(resolveIntent('KAZI MI ZA 63', 'presentation', sl), 'PICK_DESCRIBED');
  assert.notEqual(resolveIntent('KAZI MI ZA 90', 'presentation', sl), 'PICK_DESCRIBED');
  assert.notEqual(resolveIntent('PRVATA', 'presentation'), 'PICK_DESCRIBED',
    'nothing described: there is no set to pick from');
});

test('a bare «NE» over a described batch is LOCATE_CONTINUE; without one it is the goodbye', () => {
  assert.equal(resolveIntent('NE', 'presentation', { describedEbs: [78, 63] }), 'LOCATE_CONTINUE');
  // «NE FALA» is a farewell even with the hunt open (the funnel's regex is a
  // BARE refusal on purpose).
  assert.notEqual(resolveIntent('NE FALA', 'presentation', { describedEbs: [78, 63] }), 'LOCATE_CONTINUE');
  assert.equal(resolveIntent('NE', 'presentation'), 'BYE');
});

test('«DA» after the exhausted-area question is LOCATE_WIDEN', () => {
  assert.equal(resolveIntent('DA', 'presentation', { describedEbs: [78], areaExhausted: true }), 'LOCATE_WIDEN');
  // The area lock is only released when the funnel ASKED about other parts of
  // town: a plain agreement mid-hunt is not a widen.
  assert.notEqual(resolveIntent('DA', 'presentation', { describedEbs: [78] }), 'LOCATE_WIDEN');
  assert.notEqual(resolveIntent('DOBRO', 'presentation', { presentedIds: [78], areaExhausted: true }), 'LOCATE_WIDEN',
    'an agreement with no described batch is not the funnel\'s answer');
});

test('an extreme price ask is PRICE_EXTREME', () => {
  assert.equal(resolveIntent('KOJ TI E TOJ STAN PO 1286E PO M2', 'closing', { presentedIds: [78] }), 'PRICE_EXTREME');
  // A SUPERLATIVE is the lane; a plain budget cap («DO 1000 EVRA KUCA») is not
  // (`extractPriceExtremeQuery` returns undefined — it is a criteria search).
  assert.equal(resolveIntent('NAJEVTINI STANOVI DO 500 EVRA', 'discovery'), 'PRICE_EXTREME');
  assert.notEqual(resolveIntent('DO 1000 EVRA KUCA', 'discovery'), 'PRICE_EXTREME');
  // A plain price question keeps the price lane.
  assert.notEqual(resolveIntent('KOLKU E CENATA?', 'closing', { propertyId: 78 }), 'PRICE_EXTREME');
});

// ── MORE_STOCK (Phase 4, stock family) ──────────────────────────────────────
// The row is the executor's ELEVEN-veto conjunction, so the branch at 9524 was
// flipped to read `routedLane()` in the same commit: the row and the branch are
// now one predicate. The negatives are the ones that made the lane necessary —
// the visit verb inside «сакам да видам уште» and a NEW criterion («уште нешто
// до 300 евра»), which is a fresh search and must not re-serve the old pool.
test('a stock ask after a served pair is MORE_STOCK; a new criterion is not', () => {
  const sl = { presentedIds: [78, 63] };
  assert.equal(resolveIntent('ШТО УШТЕ ИМАТЕ ?', 'presentation', sl), 'MORE_STOCK');
  assert.equal(resolveIntent('НЕ СЕ ЛОШИ АМА САКАМ ДА ВИДАМ УШТЕ АКО ИМАТЕ', 'presentation', sl), 'MORE_STOCK');
  // A new criterion is a NEW SEARCH (the 300 must be applied, not ignored).
  assert.notEqual(resolveIntent('уште нешто до 300 евра', 'presentation', sl), 'MORE_STOCK');
  // A visit ask keeps the visit lane.
  assert.notEqual(resolveIntent('сакам да ја видам во сабота', 'presentation', sl), 'MORE_STOCK');
  // Nothing served yet: there is no pair to continue from.
  assert.notEqual(resolveIntent('ШТО УШТЕ ИМАТЕ ?', 'presentation'), 'MORE_STOCK');
});

// ── the place lanes that turned out to be TEXT-only (Phase 4, place family) ──
// Both were filed as "map-gated" and that stopped being true when each branch
// gained an honest MISS arm: the map picks the WORDING, the wording test picks
// the lane. The pin below also holds the precedence that matters — a где-
// question about a place SHE named must not become the property rotation.
test('a district question about a named place is AREA_OF_PLACE; a where-question is WHERE_LANDMARK', () => {
  assert.equal(resolveIntent('TE PRASUVAM VO KOJA NASELBA E TC LEPTOKARIJA', 'property_query'), 'AREA_OF_PLACE');
  assert.equal(resolveIntent('KADE TI E TOA 26 JULI TC ?', 'property_query'), 'WHERE_LANDMARK');
  // A search that names an area is a search, not a place question.
  assert.notEqual(resolveIntent('DALI IMATE STAN VO KARPOS?', 'discovery'), 'AREA_OF_PLACE');
  // A price question keeps the price lane (the lane's own veto).
  assert.notEqual(resolveIntent('KOJA E CENATA NA STANOT?', 'closing'), 'WHERE_LANDMARK');
});

// ── the fee fast path (Phase 4, money family — the FLIP) ────────────────────
// The block at 10534 now READS these rows instead of recomputing its booleans,
// so the rows must be the booleans exactly. Two divergences the flip exposed:
// FEE_WHY was missing the money-state list and `!fsmRequired` (when the FSM
// forces the full path, its own fee.why leg serves — the fast block must not),
// and FEE_COMPLAINT vetoed on bare `detectFeeWhy` where the executor vetoes on
// `feeWhyFast`. With a consent phrase present the why leg stands down, so the
// arithmetic complaint takes the turn — the case that used to predict the wrong
// lane. Nothing here changes what is served; it pins WHICH row owns each turn.
test('the fee fast path rows are the executor booleans', () => {
  assert.equal(resolveIntent('KAKVI SE PRAVILATA NA AGENCIJATA?', 'closing'), 'FEE_RULES');
  assert.equal(resolveIntent('AKO GLEDAM 10 STANA TOA SE 5000 OD MOJ DJEB', 'closing'), 'FEE_COMPLAINT');
  // Consent does NOT move the arithmetic complaint back to the why leg.
  assert.equal(resolveIntent('AKO GLEDAM 10 STANA TOA SE 5000 OD MOJ DJEB, DOBRO SE SOGLASUVAM', 'closing'), 'FEE_COMPLAINT');
  // A why that forces the FSM path is not the FAST lane (the FSM leg serves it).
  assert.notEqual(resolveIntent('ZOSTO ZEMATE PARI ZA POSETA?', 'closing'), 'FEE_WHY');
  // …and rules never become a why.
  assert.notEqual(resolveIntent('KAKVI SE PRAVILATA NA AGENCIJATA?', 'closing'), 'FEE_WHY');
});
