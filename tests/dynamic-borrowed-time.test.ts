/**
 * THE [01:51] CAPTURE — «KOMPLICIRANI STE» and the borrowed Thursday.
 *
 * The generated answer promised «…дали му одговара четврток во 17:00 часот»
 * and passed every fact rule: a day and an hour are not an amount, an EB, an
 * area or a floor. The row was stored under
 * `dynamic:<state>:komplicirani-ste` and `retrieveDynamic()` is a fuzzy,
 * STATE-AGNOSTIC match (trigram ≥ 0.55), so any later client whose complaint
 * scored against that phrasing could be told the owner was being asked about
 * someone else's Thursday.
 *
 * Two fixes, both pinned here:
 *   1. A day or a clock the client never named is a violation — at generation,
 *      on recall, and in the row audit (one predicate). A time the CLIENT named
 *      is still echoed: «дали може четврток во 17?» keeps its answer.
 *   2. The ESCALATION door honours the protocol-state exclusion that
 *      `shouldTryDynamic` always had — the visit/fee/contact ladder is answered
 *      by its own copy, never by a paraphrase that can invent a term.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import {
  validateDynamicAnswer, recallDynamic, dynamicAllowedHere, dynamicRowViolations, dynamicSlug,
} from '../src/llm/dynamicFallback';
import { freshSession, ChatSession } from '../src/fsm/session';
import { Responder } from '../src/llm/respond';
import { loadConfig } from '../src/config';
import { LlmClient } from '../src/llm/types';

function fresh(): { bank: BankStore; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'dyn-time-'));
  const db = new Db(join(dir, 't.db'));
  return { bank: new BankStore(db), dir };
}

/** The exact stored shape from the capture. */
const BORROWED = 'Се извинувам доколку постапката изгледа комплицирана, желбата ми е само што побрзо и полесно да го договориме терминот. Веднаш ќе го контактирам сопственикот за да проверам дали му одговара четврток во 17:00 часот.\n\nДали да Ве известам штом добијам потврда од сопственикот?';

/** The same answer with no calendar in it — the shape that IS learnable. */
const TIMELESS = 'Се извинувам ако постапката изгледа комплицирана — желбата ми е само што побрзо да го договориме терминот. Дали да проверам кај сопственикот кој термин му одговара, па да Ви предложам?';

// ── 1. the borrowed commitment ──────────────────────────────────────────────

test('[01:51] the captured answer is refused: the client named no Thursday', () => {
  const v = validateDynamicAnswer(BORROWED, 'KOMPLICIRANI STE');
  assert.ok(v.some(x => x.includes('day/hour')), `the borrowed term must be named: ${JSON.stringify(v)}`);
  // …and it is a VIOLATION, so generateDynamic stores nothing and recall skips it.
  assert.ok(validateDynamicAnswer(BORROWED, 'KOMPLICIRANI STE').length > 0);
  // The timeless rewrite passes.
  assert.deepEqual(validateDynamicAnswer(TIMELESS, 'KOMPLICIRANI STE'), []);
});

test('[01:51] the CLIENT\'S OWN time is still echoed (Latin, Cyrillic, bare hour)', () => {
  const answer = 'Секако — проверувам кај сопственикот дали му одговара четврток во 17:00 часот. Дали да Ве известам штом добијам потврда?';
  for (const msg of ['DALI MOZE CETVRTOK VO 17 ?', 'дали може четврток во 17:00?', 'cetvrtok vo 17'])
    assert.deepEqual(validateDynamicAnswer(answer, msg), [], `the echo must survive: ${msg}`);
  // A bare hour means the same appointment hour as its 24h twin (6 ≡ 18:00).
  assert.deepEqual(validateDynamicAnswer('Проверувам кај сопственикот за во 18:00. Дали да Ве известам?', 'VO 6 ?'), []);
  // …while a time the client did NOT name is still refused.
  assert.ok(validateDynamicAnswer('Проверувам за сабота во 19:00. Дали да Ве известам?', 'DALI MOZE CETVRTOK VO 17 ?').length > 0,
    'a different day is a borrowed commitment');
  assert.ok(validateDynamicAnswer('Проверувам за четврток во 19:00. Дали да Ве известам?', 'DALI MOZE CETVRTOK VO 17 ?').length > 0,
    'a different hour is a borrowed commitment');
});

test('[01:51] the rule is narrow: durations, floors and units are not appointments', () => {
  for (const ok of [
    'Ќе проверам кај сопственикот и во 5 минути ќе Ве известам. Дали е во ред?',
    'Недвижноста е достапна во текот на работните денови. Дали да закажеме посета?',
    'Депозитот се плаќа на денот на потпишување на договорот. Дали имате дополнителни прашања?',
    'Има лифт, парно и јавен паркинг, а зградата е одржавана. Дали да го погледнеме?',
  ]) assert.deepEqual(validateDynamicAnswer(ok), [], `over-eager veto: ${ok}`);
});

test('[01:51] a stored row can never be recalled for another client', () => {
  const { bank, dir } = fresh();
  const key = dynamicSlug('visit_scheduling', 'KOMPLICIRANI STE');
  assert.equal(bank.addDynamic(key, 'visit_scheduling', 'KOMPLICIRANI STE', BORROWED), true);
  // The row is on disk, so this is recall-time enforcement, not storage refusal:
  // a stored answer with a calendar in it stops serving the moment the rule lands.
  assert.equal(recallDynamic(bank, 'KOMPLICIRANI STE'), undefined);
  assert.equal(recallDynamic(bank, 'VI STE KOMPLICIRANI'), undefined, 'the fuzzy door is closed too');
  assert.ok(dynamicRowViolations({ msg: 'KOMPLICIRANI STE', answer: BORROWED }).length > 0,
    'the nightly purge sweep sees the same violation');
  // A timeless row still serves, so the loop keeps its purpose.
  assert.equal(bank.addDynamic(dynamicSlug('presentation', 'VI STE KOMPLICIRANI'), 'presentation', 'VI STE KOMPLICIRANI', TIMELESS), true);
  assert.equal(recallDynamic(bank, 'VI STE KOMPLICIRANI')?.text, TIMELESS);
  rmSync(dir, { recursive: true, force: true });
});

// ── 2. the protocol door on the escalation path ─────────────────────────────

test('[01:51] generation is refused inside the visit/fee/contact ladder', () => {
  const protocol = ['closing', 'contact_collection', 'visit_scheduling', 'owner_checking', 'time_confirm', 'pending', 'queued'];
  for (const state of protocol) {
    const s = freshSession('test', `proto-${state}`);
    s.state = state as ChatSession['state'];
    assert.equal(dynamicAllowedHere(s), false, `generated prose must not own ${state}`);
  }
  for (const state of ['idle', 'discovery', 'presentation', 'property_locate', 'property_query']) {
    const s = freshSession('test', `free-${state}`);
    s.state = state as ChatSession['state'];
    assert.equal(dynamicAllowedHere(s), true, `${state} keeps the learning loop`);
  }
  // A fee agreement or a pending owner check is protocol traffic even in `idle`.
  const agreed = freshSession('test', 'agreed');
  agreed.slots.viewingFeeAgreed = true;
  assert.equal(dynamicAllowedHere(agreed), false);
  const pending = freshSession('test', 'pending-owner');
  pending.slots.ownerContactPending = true;
  assert.equal(dynamicAllowedHere(pending), false);
});

/** An LLM that answers every prompt with the captured sentence. */
class TimePromisingLlm implements LlmClient {
  calls = 0;
  async complete(): Promise<string> { this.calls++; return BORROWED; }
}

test('[01:51] e2e: a protocol-state turn never serves the promised termine', async () => {
  const cfg = loadConfig();
  const { bank, dir } = fresh();
  // Pre-seeded row, exactly the shape the capture stored.
  bank.addDynamic(dynamicSlug('visit_scheduling', 'KOMPLICIRANI STE'), 'visit_scheduling',
    'KOMPLICIRANI STE', BORROWED);
  const llm = new TimePromisingLlm();
  const s = freshSession('test', 'proto-e2e');
  s.state = 'visit_scheduling';
  s.slots.service = 'rent';
  const saved = process.env.LINA_BANK_DB;
  void saved;
  const r = await new Responder(llm, cfg).respond(s, [], 'KOMPLICIRANI STE');
  assert.notEqual(r.source, 'dynamic', `a protocol turn was answered by generated prose: ${r.source}`);
  assert.doesNotMatch(r.text, /четврток/iu, `a term nobody proposed reached the client: ${r.text}`);
  rmSync(dir, { recursive: true, force: true });
});
