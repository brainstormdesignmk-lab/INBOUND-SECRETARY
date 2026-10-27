// ROUTE HEALTH — the queue collision report. The report is only useful if it
// fires on the FIELD case and stays quiet on legitimate fee traffic.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeRows, healthLine, healthRatesLine, frameCounts, framesLine, emitCorpusRows } from '../src/scripts/routeHealth';

const STAMP = { state: 'closing', eventType: 'FEE_PUSH_FAST' };

test('a price compliment filed under a frozen fee key is a frozen-misroute', () => {
  const { findings, counts } = analyzeRows([
    { id: 1, ...STAMP, bankKey: 'fee.persuade.1.buy', userMsg: 'MNOGU EFTINA CENA E TOA' },
  ]);
  assert.equal(counts['frozen-misroute'], 1);
  assert.equal(findings[0].kind, 'frozen-misroute');
  assert.equal(findings[0].id, 1);
});

test('genuine fee resistance under the same key is not flagged', () => {
  const { counts } = analyzeRows([
    { id: 2, ...STAMP, bankKey: 'fee.persuade.1.buy', userMsg: 'MNOGU NEKAKO 500DEN ZA OTVARANJE NA STAN' },
    { id: 3, ...STAMP, bankKey: 'fee.persuade.1.buy', userMsg: '50% E MNOGU' },
    { id: 4, ...STAMP, bankKey: 'fee.persuade.1.buy', userMsg: '10 evra ne e bas simbolichna cena' },
  ]);
  assert.equal(counts['frozen-misroute'], 0);
});

test('the same phrase reaching two keys is a collision', () => {
  const { findings, counts } = analyzeRows([
    { id: 1, ...STAMP, bankKey: 'fee.persuade.1.buy', userMsg: 'MNOGU EFTINA CENA E TOA' },
    { id: 5, ...STAMP, bankKey: 'remark.price.cheap', userMsg: 'mnogu  eftina cena e toa' },
  ]);
  assert.equal(counts.collision, 1);
  const c = findings.find(f => f.kind === 'collision')!;
  assert.match(c.detail, /fee\.persuade\.1\.buy/);
  assert.match(c.detail, /remark\.price\.cheap/);
});

test('a turn with no key is an orphan; the summary is one line', () => {
  const { counts } = analyzeRows([
    { id: 6, state: 'discovery', eventType: 'STAY', bankKey: null, userMsg: 'zdravo' },
  ]);
  assert.equal(counts.orphan, 1);
  assert.equal(healthLine(counts), 'frozen-misroute=0 collision=0 orphan=1');
});

test('market variants of one family are the same route, not a collision', () => {
  const { counts } = analyzeRows([
    { id: 8, state: 'closing', eventType: 'PROVISION_ASK', bankKey: 'provision.ask.buy', userMsg: 'kolku vi e provizijata?' },
    { id: 9, state: 'closing', eventType: 'PROVISION_ASK', bankKey: 'provision.ask.rent', userMsg: 'kolku vi e provizijata?' },
  ]);
  assert.equal(counts.collision, 0);
});

test('a re-homed row (review_key set) is no longer a standing misroute — evidence kept, gate green', () => {
  // The tui.db historical pair (#235, #65): the operator retarget moved the
  // QUESTION to its learn.* route; the original serve stays in bank_key as
  // history. The strict gate counts the EFFECTIVE route.
  const { findings, counts, rates } = analyzeRows([
    { id: 1, ...STAMP, bankKey: 'fee.persuade.1.buy', reviewKey: 'learn.mnogu-eftina-cena', userMsg: 'MNOGU EFTINA CENA E TOA' },
    { id: 2, ...STAMP, bankKey: 'investment.opinion', reviewKey: 'learn.mnogu-skapa-cena', userMsg: 'mnogu skapa cena ima' },
  ]);
  assert.equal(counts['frozen-misroute'], 0, 'a re-homed row must not keep the gate red');
  assert.equal(findings.length, 0, findings.map(f => f.detail).join('; '));
  assert.equal(rates.serves['fee.persuade.1'], 1, 'the serve evidence stays at its original family');
  // Without the retarget the same rows still block — the gate did not weaken.
  const before = analyzeRows([
    { id: 1, ...STAMP, bankKey: 'fee.persuade.1.buy', userMsg: 'MNOGU EFTINA CENA E TOA' },
  ]);
  assert.equal(before.counts['frozen-misroute'], 1);
});

test('unrelated frozen keys are left alone (contact rows are not price talk)', () => {
  const { counts } = analyzeRows([
    { id: 7, state: 'contact_collection', eventType: 'CONTACT_ASK', bankKey: 'contact.ask.name', userMsg: 'MARKO MARKOVSKI 070123456' },
  ]);
  assert.equal(counts['frozen-misroute'], 0);
});

// P5.1 — per-key rates: the finding says WHAT is wrong, the rate says whether
// it is a draining wound or stale history.
test('rates: misroute rate is per family, orphans and freeze-refusal are shares', () => {
  const { rates } = analyzeRows([
    { id: 1, ...STAMP, bankKey: 'fee.persuade.1.buy', userMsg: 'MNOGU EFTINA CENA E TOA' },
    { id: 2, ...STAMP, bankKey: 'fee.persuade.1.buy', userMsg: 'MNOGU NEKAKO 500DEN ZA OTVARANJE NA STAN' },
    { id: 3, state: 'contact_collection', eventType: 'CONTACT_ASK', bankKey: 'contact.ask.name', userMsg: 'MARKO MARKOVSKI 070123456' },
    { id: 4, state: 'discovery', eventType: 'STAY', bankKey: null, userMsg: 'zdravo' },
  ]);
  // fee family: 1 misroute out of 2 serves; its two market variants stay ONE family.
  assert.equal(rates.serves['fee.persuade.1'], 2);
  assert.equal(rates.misrouteRate['fee.persuade.1'], 0.5);
  assert.equal(rates.serves['contact.ask.name'], 1);
  assert.equal(rates.misrouteRate['contact.ask.name'], 0);
  assert.equal(rates.orphanRate, 0.25);
  assert.equal(rates.freezeRefusalRate, 0.333); // 1 misroute / 3 key-bearing
  assert.match(healthRatesLine(rates), /fee\.persuade\.1=50%\/2/);
  assert.match(healthRatesLine(rates), /orphan-rate=25%/);
});

test('rates: an empty queue has no division by zero', () => {
  const { rates } = analyzeRows([]);
  assert.deepEqual(rates.serves, {});
  assert.deepEqual(rates.misrouteRate, {});
  assert.equal(rates.orphanRate, 0);
  assert.equal(rates.freezeRefusalRate, 0);
});

// FRAME WATCH — the two [22:2x]/[02:4x] frames the corpus was just closed on
// stay under production surveillance: a drift row for either frame arrives
// pre-labeled, and the CLI health line carries its tally. Other lanes are
// invisible to the watch — it counts nothing it cannot name.
test('frame watch: the new fee frames are tallied and pre-label the corpus feed', () => {
  const fc = frameCounts([
    { userMsg: 'vazi, ke si platam za gledanjeto' },        // amountless-pay-view
    { userMsg: 'zoska 500 denari ?' },                      // why-fee-amount
    { userMsg: 'zoshto 1.430.000 denari za stanot?' },      // property sized — no frame
    { userMsg: 'ke platam 500 den za poseta' },             // consent (amount) — no frame
    { userMsg: 'kolku e za poseta?' },                      // kolku ask — no frame
  ]);
  assert.equal(fc['amountless-pay-view'], 1);
  assert.equal(fc['why-fee-amount'], 1);
  assert.equal(framesLine(fc), 'frame-watch:amountless-pay-view=1 why-fee-amount=1');

  const rows = emitCorpusRows([
    { at: Date.now(), chatId: 'c', text: 'resheno, ke si platem za posetata', predicted: 'STAY', actual: 'CAPTURE' },
    { at: Date.now(), chatId: 'c2', text: 'zoshto 500 denari ?', predicted: 'STAY', actual: 'OTHER' },
  ]);
  assert.equal(rows.length, 2);
  const labeled = rows.filter(r => /note: 'frame /.test(r));
  assert.equal(labeled.length, 2, `every watched frame must pre-label its corpus row:\n${rows.join('\n')}`);
  assert.ok(rows.some(r => /frame amountless-pay-view/.test(r)), rows.join('\n'));
  assert.ok(rows.some(r => /frame why-fee-amount/.test(r)), rows.join('\n'));
});
