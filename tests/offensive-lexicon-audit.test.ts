// THE FALSE-POSITIVE GUARD over the whole response bank.
//
// Why this file exists: classifyOffensive runs DETERMINISTICALLY before every
// routing decision, and a hit spends one of the client's three strikes and
// serves the professional-tone warning instead of climbing the funnel. A
// lexicon stem that fires on the agency's OWN copy — or on ordinary client
// vocabulary — is therefore an appliance-grade defect, not a cosmetic one.
//
// It has already happened twice in the field:
//   • 'fakj' (the English swear in Macedonian spelling) matched "прифаќам"
//     (to accept) → "prifakjam" — so "не прифаќам" and "провизијата не ја
//     прифаќам" (the COMMISSION REFUSAL) were severity-3 sexual strikes.
//   • 'erot' matched "менаџерот" (the manager) → "menadzEROT", so asking for a
//     manager was a sexual strike; 'nosi se' matched across words in
//     "…ги носи сегашниот пазар".
// Every one of those was found by sweeping the bank. This test keeps sweeping
// it, so a future lexicon row that fires on shipped copy fails CI instead of
// striking a real client.
//
// The bank is DATA: the sweep needs no maintenance when copy changes, and the
// curated client list below covers the everyday phrasings the bank's copy does
// not contain ("менаџерот", "прифаќам", the money-ladder refusals).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyOffensive } from '../src/antiabuse/offensive';
import { RESPONSE_BANK } from '../src/data/responses';
import { QUICK_INTROS } from '../src/tui/intros';

test('every shipped bank variant is clean for the offensive classifier', () => {
  const flagged: string[] = [];
  for (const [key, variants] of Object.entries(RESPONSE_BANK)) {
    variants.forEach((v, i) => {
      const d = classifyOffensive(v);
      if (d.isOffensive) flagged.push(`bank[${key}]#${i} → ${d.reason}: ${v.slice(0, 80)}`);
    });
  }
  assert.deepEqual(flagged, []);
});

// The F2 menu pre-fills TEST inputs (you play the client), so it is not all
// clean copy: one entry is deliberately an angry client. The contract is
// two-sided — the neutral intros must never strike, and the angry-client probe
// must still reach the strike protocol (a guard for the 3-strike path itself).
test('the TUI quick-intro scripts: neutral ones are clean, the angry probe still strikes', () => {
  const flagged: string[] = [];
  const missed: string[] = [];
  for (const q of QUICK_INTROS) {
    const d = classifyOffensive(q.text);
    if (q.label.includes('Гневен')) {
      if (!d.isOffensive) missed.push(q.label);
      continue;
    }
    if (d.isOffensive) flagged.push(`${q.label} → ${d.reason}`);
  }
  assert.deepEqual(flagged, []);
  assert.deepEqual(missed, []);
});

// Everyday CLIENT vocabulary — the words a real client types while using the
// funnel. Nothing here is an insult, so nothing here may strike.
test('ordinary client vocabulary never strikes', () => {
  const legit = [
    // accept / refuse (the money ladders)
    'не прифаќам', 'НЕ ПРИФАЌАМ', 'прифаќам', 'да, прифаќам', 'не ја прифаќам понудата',
    'провизијата не ја прифаќам', 'ne ja prifakjam', 'prifakjam uslovite', 'ne prifakjam da plakjam provizija',
    'не, не ја прифаќам таа цена',
    // the manager / agency escalation lane
    'сакам да зборувам со менаџерот', 'кажете му на менаџерот', 'менаџерот не одговори',
    'не е во ред, барам менаџер', 'да го контактирате менаџерот',
    // market talk that must never read as "nosi se"
    'ги носи сегашниот пазар', 'пазарот не носи такви цени', 'свесна сум за предизвиците',
    // normal funnel traffic
    'здраво, сакам стан под кирија', 'bilo kade do 250', 'dali e sloboden?',
    'koga moze da se pogledne', 'sakam 2 spalni vo centar', 'koja e cenata?',
    'dali ima parking', 'sakam da prodadam stan', 'fakt e deka cenata e visoka',
    'analiza na lokacijata', 'kultura na ziveenje', 'dozvola za koristenje',
  ];
  const flagged: string[] = [];
  for (const t of legit) {
    const d = classifyOffensive(t);
    if (d.isOffensive) flagged.push(`${JSON.stringify(t)} → ${d.reason}`);
  }
  assert.deepEqual(flagged, []);
});

// The other half of the contract: the guard must not have neutered the
// detector. Real insults — including the standalone spellings of the very
// stems that were letter-bounded — still fire at the same severity.
test('real insults still fire after the boundary sweep', () => {
  // severity 3 — sexual / heavy
  for (const t of ['fakj', 'fakji!', 'fakju', 'FAKJ TI MATER', 'FUCK YOU', 'fucking hell',
    'picka ti mater', 'A DA TE POEBAM MALCE', 'масажа', 'erotski masazi', 'масажа и еротски услуги']) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, true, `${JSON.stringify(t)} must fire`);
    assert.equal(d.severity, 3, `${JSON.stringify(t)} severity: ${d.reason}`);
  }
  // severity 1 — the mild dismissals keep their own row ('begaj'/'nosi se')
  for (const t of ['begaj od tuka', 'nosi se!', 'gubi se']) {
    const d = classifyOffensive(t);
    assert.equal(d.isOffensive, true, `${JSON.stringify(t)} must fire`);
    assert.equal(d.severity, 1, `${JSON.stringify(t)} severity: ${d.reason}`);
  }
});
