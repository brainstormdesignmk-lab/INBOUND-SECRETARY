// BANK REVIEW — the human gate's logic (bank:tui calls this service).
//
// Pinned here: the four categories list the right rows, edits are validated,
// a push writes a STAGED variant (never serving) + the retrieval example,
// approval promotes, rejection removes, and ACTIVE copy is read-only.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { EnrichmentStore } from '../src/store/enrichment';
import { BankReview, learnKeySlug, validateBankKey } from '../src/bank/review';

const Q = 'kade ima reptil tamu ?';
const GOOD = 'Ќе го проверам кај сопственикот и ќе Ви кажам веднаш.';
const OTHER = 'Оваа информација не е во моите записи, но сопственикот може да ја потврди.';
const INFO_NO_YEAR_TEXT = 'Немам податок во базата од која година е зградата — ќе го прашам сопственикот и ќе Ви потврдам.';

function setup() {
  const db = new Db(':memory:');
  const bank = new BankStore(db);
  const en = new EnrichmentStore(db);
  const review = new BankReview(db, bank, en);
  en.insert({
    chatId: 'c1', state: 'idle', eventType: 'LEARNED_RECALL',
    userMsg: Q, replyText: GOOD, replySource: 'dynamic',
  });
  bank.addDynamic('dynamic:idle:reptil', 'idle', Q, GOOD);
  bank.addStagedVariant('learn.staged', OTHER, 'test staged');
  bank.addVariant('learn.active', 'Активниот одговор е веќе во употреба.');
  return { db, bank, en, review };
}

test('counts and categories list the right rows', () => {
  const { review } = setup();
  const c = review.counts();
  assert.equal(c.enrichment, 1);
  assert.equal(c.dynamic, 1);
  assert.equal(c.staged, 1);
  assert.equal(c.active, 1);
  assert.equal(review.list('enrichment')[0].userMsg, Q);
  assert.equal(review.list('dynamic')[0].key, 'dynamic:idle:reptil');
  assert.equal(review.list('staged')[0].status, 'staged');
  assert.equal(review.list('active')[0].status, 'active');
});

test('suggested key: real keys survive, dynamic groups become a learn slug', () => {
  const { review } = setup();
  const dyn = review.list('dynamic')[0];
  assert.equal(review.suggestKey(dyn), learnKeySlug(Q));
  assert.match(review.suggestKey(dyn), /^learn\.ima-reptil-tamu$/);
  const staged = review.list('staged')[0];
  assert.equal(review.suggestKey(staged), 'learn.staged');
});

test('a frozen seed-backed enrichment turn can be edited under an explicit learn key', () => {
  const { review, en, bank } = setup();
  const item = review.list('enrichment')[0];
  const target = 'learn.agent-accompanies-viewing';
  const answer = 'Да, агент на Метрополис ќе Ве придружува при разгледувањето на избраната недвижност. Кога ќе одлучите, ќе продолжиме со организирање на посетата — дали Ви одговара?';
  const changed = review.edit(item, answer, target);
  assert.equal(changed.ok, true, changed.reason);
  assert.equal(en.byId(item.id)?.replyText, answer);
  assert.equal(item.key, null, 'the source row identity is not silently rewritten');
  assert.equal(bank.variants('fee.ask.buy').length, 0, 'the frozen fee pool stays untouched');
  assert.equal(bank.variants(target).length, 0, 'editing a queue row does not serve it');
  const pushed = review.push({ ...item, key: target, text: answer }, target, answer);
  assert.equal(pushed.ok, true, pushed.reason);
  const staged = review.list('staged').find(row => row.key === target)!;
  assert.equal(staged.userMsg, Q, 'the original attendance question is kept with the candidate');
  assert.equal(review.approve(staged).ok, true);
  assert.deepEqual(bank.variants(target), [answer]);
  assert.equal(bank.retrieveExact(Q)?.key, target);
});

test('a frozen-origin turn suggests a learn route — the QUESTION stays capturable', () => {
  const db = new Db(':memory:');
  const bank = new BankStore(db);
  const en = new EnrichmentStore(db);
  const review = new BankReview(db, bank, en);
  const q = 'MNOGU EFTINA CENA E TOA';
  en.insert({
    chatId: 'c1', state: 'closing', eventType: 'FEE_PUSH_FAST',
    userMsg: q, replyText: GOOD, replySource: 'deterministic', bankKey: 'fee.persuade.1.buy',
  });
  const item = review.list('enrichment')[0];
  assert.equal(item.key, 'fee.persuade.1.buy', 'the served key stays as provenance');
  const target = review.suggestKey(item);
  assert.match(target, /^learn\./, `a frozen route must not suggest itself: ${target}`);

  // The bad fee answer is rewritten, then the QUESTION is staged under the
  // learn route — copy stays frozen, routing stays open.
  const r = review.push({ ...item, key: target }, target, OTHER);
  assert.equal(r.ok, true, r.reason);
  const staged = review.list('staged').find(x => x.key === target)!;
  assert.equal(staged.userMsg, q, 'the original question rides the candidate');
  assert.equal(review.approve(staged).ok, true);
  assert.equal(bank.retrieveExact(q)?.key, target, 'the phrasing now routes deterministically');
  assert.equal(bank.variants('fee.persuade.1.buy').length, 0, 'the frozen pool was not touched');
});

test('a code-owned answer is not re-homed — there is no wording to bank', () => {
  const db = new Db(':memory:');
  const bank = new BankStore(db);
  const en = new EnrichmentStore(db);
  const review = new BankReview(db, bank, en);
  en.insert({
    chatId: 'c1', state: 'property_query', eventType: 'INFO_ASK',
    userMsg: 'od koja godina e zgradata?', replyText: INFO_NO_YEAR_TEXT, replySource: 'deterministic', bankKey: 'info.no.year',
  });
  const item = review.list('enrichment')[0];
  assert.equal(review.suggestKey(item), 'info.no.year');
});

test('edit validates and updates enrichment, dynamic and staged in place', () => {
  const { review, en, bank } = setup();
  const enriched = review.edit(review.list('enrichment')[0], OTHER);
  assert.equal(enriched.ok, true);
  assert.equal(en.listRecent(1)[0].replyText, OTHER);

  const dyn = review.edit(review.list('dynamic')[0], OTHER);
  assert.equal(dyn.ok, true);
  assert.equal(bank.dynamicRows(1)[0].answer, OTHER);

  const st = review.edit(review.list('staged')[0], GOOD);
  assert.equal(st.ok, true);
  assert.equal(bank.stagedVariants('learn.staged')[0].text, GOOD);
});

test('edit REPLACES an ACTIVE variant: old retired, new promoted, nothing silently mutated', () => {
  const { review, bank, db } = setup();
  const item = review.list('active')[0];
  const oldText = item.text;
  const r = review.edit(item, OTHER);
  assert.equal(r.ok, true, r.reason);
  const active = bank.variants(item.key ?? '');
  assert.deepEqual(active, [OTHER], 'the new wording is the only serving variant');
  const retired = db.db.prepare("SELECT text, lifecycle, note FROM bank_variants WHERE key = ? AND lifecycle = 'retired'").all(item.key) as any[];
  assert.equal(retired.length, 1);
  assert.equal(retired[0].text, oldText, 'the old wording is kept for the audit');
  assert.match(retired[0].note ?? '', /replaced by learn variant #\d+/);
});

test('edit refuses machine identities and forbidden keys, ACTIVE included', () => {
  const { review } = setup();
  const bad = review.edit(review.list('dynamic')[0], 'Јас сум дигитален асистент, па немам години.');
  assert.equal(bad.ok, false);
  assert.match(bad.reason ?? '', /hygiene|identity|fails/i);
  const activeBad = review.edit(review.list('active')[0], 'Станот чини 120.000 евра и е одличен избор.');
  assert.equal(activeBad.ok, false, 'a price never enters serving copy');
  assert.match(validateBankKey('price.ask') ?? '', /frozen|data-driven/i);
  assert.match(validateBankKey('dynamic:idle:x') ?? '', /not a bank key/i);
});

test('ENRICHMENT is a LOG: digested turns stay listed, with a pushability verdict', () => {
  const { review, en } = setup();
  en.insert({
    chatId: 'c2', state: 'idle', eventType: 'DETERMINISTIC_FAST',
    userMsg: 'cenata?', replyText: 'Станот чини 120.000 евра.', replySource: 'deterministic',
  });
  en.insert({
    chatId: 'c3', state: 'idle', eventType: 'DETERMINISTIC_FAST',
    userMsg: 'dali e dostapen?', replyText: GOOD, replySource: 'deterministic', bankKey: 'price.ask',
  });
  const list = review.list('enrichment');
  assert.equal(list.length, 3, 'pending AND digested rows are in the log');

  const failed = list.find(i => i.text.includes('120.000'))!;
  assert.equal(failed.flag, 'fail', 'text that fails the gates is refused');
  assert.match(failed.verdict ?? '', /hygiene|price|фигур|eur/i);

  const keyBlocked = list.find(i => i.key === 'price.ask')!;
  assert.equal(keyBlocked.flag, 'key', 'frozen/data-driven key: nothing to bank');

  const clean = list.find(i => i.id === 1)!;
  assert.equal(clean.flag, 'ok');

  en.markEnriched([clean.id]);
  const after = review.list('enrichment').find(i => i.id === 1)!;
  assert.equal(after.status, 'logged', 'a digested turn stays in the log');
  assert.match(after.meta, /digested/);
});

test('ENRICHMENT rows show the QUESTION that produced the answer', () => {
  const { review } = setup();
  const row = review.list('enrichment')[0];
  assert.equal(row.userMsg, Q);
});

test('STAGED/ACTIVE carry the QUESTION behind the wording', () => {
  const { review, bank, en } = setup();
  en.insert({
    chatId: 'c1', state: 'idle', eventType: 'DETERMINISTIC_FAST',
    userMsg: 'kade e stanot 26 ?', replyText: 'стариот одговор', replySource: 'deterministic',
  });
  const row = en.listRecent(1)[0];
  bank.addStagedVariant('learn.provenance', OTHER, `operator correction of ENRICHMENT #${row.id}`);
  const st = review.list('staged').find(v => v.key === 'learn.provenance')!;
  assert.equal(st.userMsg, 'kade e stanot 26 ?', 'the exact question of the corrected turn');

  // A variant with no queue row falls back to the key's retrieval examples.
  bank.addExample('learn.examples', Q);
  bank.addVariant('learn.examples', OTHER);
  const act = review.list('active').find(v => v.key === 'learn.examples')!;
  assert.equal(act.userMsg, Q);

  // …and when the key has no examples at all, the queue turns that reached
  // that key are the surviving provenance (gapfill variants).
  bank.addVariant('learn.from-queue', OTHER);
  en.insert({
    chatId: 'c9', state: 'idle', eventType: 'DETERMINISTIC_FAST',
    userMsg: 'PA I TOA I TOA\nSE MISLAM', replyText: 'ok', replySource: 'deterministic',
    bankKey: 'learn.from-queue',
  });
  const gap = review.list('active').find(v => v.key === 'learn.from-queue')!;
  assert.equal(gap.userMsg, 'PA I TOA I TOA\nSE MISLAM');
});

test('push stages (not serves), holds its example until approval, and clears the queue row', () => {
  const { review, en, bank, db } = setup();
  const item = review.list('enrichment')[0];
  assert.equal(review.push(item, 'learn.pushed', GOOD).ok, true);
  assert.equal(bank.variants('learn.pushed').length, 0, 'a push must NOT become active');
  assert.equal(bank.stagedVariants('learn.pushed').length, 1);
  const ex = db.db.prepare('SELECT COUNT(*) AS c FROM bank_examples WHERE key = ? AND msg = ?')
    .get('learn.pushed', Q) as { c: number };
  assert.equal(ex.c, 0, 'an unapproved candidate must not teach retrieval');
  assert.equal(en.pendingCount(), 0, 'the reviewed turn leaves the queue');
  const staged = review.list('staged').find(row => row.key === 'learn.pushed')!;
  assert.equal(review.approve(staged).ok, true);
  const approvedExample = db.db.prepare('SELECT COUNT(*) AS c FROM bank_examples WHERE key = ? AND msg = ?')
    .get('learn.pushed', Q) as { c: number };
  assert.equal(approvedExample.c, 1, 'approval enables the question-to-answer route');
});

test('dynamic K target can be pushed and approved; approved route replaces the dynamic answer', () => {
  const { review, bank, db } = setup();
  const dynamic = review.list('dynamic')[0];
  const target = learnKeySlug(Q);
  assert.equal(target, 'learn.ima-reptil-tamu');

  const push = review.push(dynamic, target, GOOD);
  assert.equal(push.ok, true, push.reason);
  const staged = review.list('staged').find(item => item.key === target)!;
  assert.ok(staged, 'A on DYNAMIC creates a visible STAGED row under the selected K key');
  assert.equal(staged.userMsg, Q, 'the original client question survives in the stage note');
  assert.equal(bank.dynamicRows(1).length, 1, 'staging does not remove the immediate dynamic fallback');
  assert.equal(bank.variants(target).length, 0, 'staging does not serve as an active learned variant');

  const approved = review.approve(staged);
  assert.equal(approved.ok, true, approved.reason);
  assert.deepEqual(bank.variants(target), [GOOD], 'approved wording is active under the K target');
  assert.equal(bank.dynamicRows(1).length, 1, 'approved dynamic capture remains available for gray audit history');
  assert.equal(bank.dynamicRows(1)[0].processed, 1, 'approval marks the matching capture processed');
  assert.equal(review.list('dynamic')[0].status, 'processed', 'the retained review row is visibly processed');
  assert.equal(review.counts().dynamic, 0, 'processed captures do not count as pending work');
  assert.equal(bank.pendingDynamic().length, 0, 'processed captures leave the binding backlog');
  assert.equal(bank.retrieveDynamicExact(Q, 'idle'), undefined, 'processed dynamic recall no longer intercepts this question');
  assert.equal(bank.retrieveExact(Q)?.key, target, 'approved example now routes to the approved learned key');
});

test('dynamic approval preserves a capture edited after staging', () => {
  const { review, bank } = setup();
  const dynamic = review.list('dynamic')[0];
  const stagedText = dynamic.text;
  const push = review.push(dynamic, 'learn.ima-reptil-tamu', stagedText);
  assert.equal(push.ok, true, push.reason);
  const staged = review.list('staged').find(item => item.key === 'learn.ima-reptil-tamu')!;
  const changedCapture = OTHER;
  assert.equal(bank.updateDynamicAnswer(dynamic.id, changedCapture), true);

  const approved = review.approve(staged);
  assert.equal(approved.ok, true, approved.reason);
  assert.equal(bank.dynamicRows(1)[0].answer, changedCapture, 'approval never alters a newer dynamic edit');
  assert.equal(bank.dynamicRows(1)[0].processed, 0, 'a changed capture remains pending instead of being marked processed');
  assert.equal(review.counts().dynamic, 1);
  assert.ok(bank.variants('learn.ima-reptil-tamu').includes(stagedText));
});

test('push refuses duplicates, excluded keys and dirty prose', () => {
  const { review } = setup();
  const item = review.list('enrichment')[0];
  assert.equal(review.push(item, 'learn.pushed', GOOD).ok, true);
  const dup = review.push(item, 'learn.pushed', GOOD);
  assert.equal(dup.ok, false);
  assert.match(dup.reason ?? '', /duplicate/i);
  assert.equal(review.push(item, 'price.ask', OTHER).ok, false);
  assert.equal(review.push(item, 'learn.pushed2', 'Станот чини 120.000 евра.').ok, false);
});

test('gapfill review rows show generation reference and instruction without fabricating a client question', () => {
  const db = new Db(':memory:');
  const bank = new BankStore(db);
  const key = 'discovery.ask.budget.business';
  bank.addVariant(key, 'Која е највисоката цена што би била прифатлива за просторот за вашиот бизнис?');
  const row = new BankReview(db, bank).list('active')[0];
  assert.equal(row.key, key);
  assert.equal(row.userMsg, null, 'generation prompt text is not mislabeled as a client quote');
  assert.deepEqual(row.generationContext?.reference, ['До која цена го барате?']);
  assert.match(row.generationContext?.instruction ?? '', /ДЕЛОВНИОТ ПРОСТОР/);
  db.db.close();
});

test('approve promotes only staged; reject removes the right way', () => {
  const { review, bank } = setup();
  const st = review.list('staged')[0];
  assert.equal(review.approve(st).ok, true);
  assert.ok(bank.variants('learn.staged').includes(OTHER), 'approved text serves');

  const dyn = review.list('dynamic')[0];
  assert.equal(review.reject(dyn).ok, true);
  assert.equal(bank.dynamicRows(1).length, 0);

  // Re-stage, then discard.
  bank.addStagedVariant('learn.discard', OTHER, 'to discard');
  const st2 = review.list('staged')[0];
  assert.equal(review.reject(st2).ok, true);
  assert.equal(bank.stagedVariants('learn.discard').length, 0);

  // Active copy can only be retired (reversible), never edited.
  const active = review.list('active')[0];
  assert.equal(review.reject(active).ok, true);
  assert.equal(bank.variants(active.key ?? '').length, 0);
});

// THE GRAY RULE (solved through the enrichment lane): a pair solved via an
// ENRICHMENT row closes the same dynamic evidence as a pair solved in the
// dynamic lane — the capture goes gray in the dynamic tab and its
// dynamic-recall audit turns go gray in the enrichment bar.
test('solving through the enrichment lane grays the dynamic evidence too', () => {
  const { review, bank, en } = setup();
  // The capture SERVED at least once: that is the dynamic-recall row the bar shows.
  en.insert({ chatId: 'c1', state: 'idle', eventType: 'LEARNED_RECALL',
    userMsg: Q, replyText: GOOD, replySource: 'dynamic-recall', bankKey: 'learn.ima-reptil-tamu' });
  en.insert({ chatId: 'c1', state: 'idle', eventType: 'LEARNED_RECALL',
    userMsg: Q, replyText: GOOD, replySource: 'dynamic', bankKey: 'learn.ima-reptil-tamu' });

  const item = review.list('enrichment')[0]; // the dynamic-recall turn, userMsg = Q
  assert.equal(item.userMsg, Q);
  const target = 'learn.ima-reptil-tamu';
  const push = review.push(item, target, GOOD);
  assert.equal(push.ok, true, push.reason);
  const staged = review.list('staged').find(i => i.key === target)!;
  assert.ok(staged, 'the enrichment push produced a STAGED row');

  const approved = review.approve(staged);
  assert.equal(approved.ok, true, approved.reason);
  assert.equal(bank.dynamicRows(1)[0].processed, 1,
    'the live capture grays in the dynamic tab, even though the pair entered through the bar');
  for (const r of en.listLog(10)) {
    assert.equal(r.enriched, 1, `audit turn left pending: #${r.id} ${r.replySource}`);
  }
});

test('a bank-owned refusal (duplicate/similarity) is code-class; dirty text is bankable-red', () => {
  const { review, bank, en } = setup();
  const dupeKey = 'learn.dupe-class';
  bank.addVariant(dupeKey, GOOD); // the pool already holds the exact wording
  en.insert({ chatId: 'd1', state: 'presentation', eventType: 'LEARNED_RECALL',
    userMsg: Q, replyText: GOOD, replySource: 'deterministic', bankKey: dupeKey });
  const dirtyKey = 'learn.dirty-class';
  en.insert({ chatId: 'd2', state: 'presentation', eventType: 'LEARNED_RECALL',
    userMsg: 'kolku cinat', replyText: 'Станот чини 120.000 евра.', replySource: 'deterministic', bankKey: dirtyKey });

  const items = review.list('enrichment');
  const dupe = items.find(i => i.key === dupeKey)!;
  assert.equal(dupe.flag, 'fail');
  assert.match(dupe.verdict ?? '', /duplicate/);
  assert.equal(dupe.bankOwned, true, 'duplicate causes = bank-owned → orange (code class)');
  const dirty = items.find(i => i.key === dirtyKey)!;
  assert.equal(dirty.flag, 'fail');
  assert.equal(dirty.bankOwned, false, 'dirty prose stays red — an E edit can clean it');
});

test('composed serves (card batch / owner-relay) classify code-side, never bankable-red', () => {
  const { review, en } = setup();
  // A cheaper-lane card serve: text embeds served rows (#248 shape).
  en.insert({ chatId: 'c8', state: 'presentation', eventType: 'CHEAPER_SEARCH',
    userMsg: 'daj mi nesto poeftino vo toj reon',
    replyText: 'Станот под Евидентен број 63 е гарсоњера во Центар. Цената е 36.000 евра.\n\nКуќата под Евидентен број 55 е во Влае. Цена 40.000 евра.',
    replySource: 'deterministic', bankKey: 'price.shy' });
  // Owner-relay artifact: the logged reply is the owner-bound ping (#242 shape).
  en.insert({ chatId: 'c9', state: 'closing', eventType: 'OWNER_ASK',
    userMsg: 'okolu 6', replyText: 'Здраво. Ве контактирам во врска со проявен интерес од сериозен клиент.',
    replySource: 'owner-relay', bankKey: 'owner.ask' });
  // The #244 shape: an owner-bound counter relay that PASSES the gates —
  // clean protocol copy, must still not read as pending bankable work.
  en.insert({ chatId: 'c11', state: 'closing', eventType: 'OWNER_ASK',
    userMsg: 'mozam vo 5\nnakoe mesto bi se cekale ?',
    replyText: 'Клиентот не е во можност за посета во Петок, 23.10.2026 во 06:00. Има друг предлог: Петок, 23.10.2026 во 05:00. Дали би Ви одговарал тој термин?',
    replySource: 'owner-relay', bankKey: 'owner.ask' });
  // A client-voice opponent: no cards, no relay — stays bankable-red on dirt.
  en.insert({ chatId: 'c10', state: 'presentation', eventType: 'LEARNED_RECALL',
    userMsg: 'kolku cinat', replyText: 'Станот чини 120.000 евра.',
    replySource: 'deterministic', bankKey: 'learn.dirty-class' });
  const items = review.list('enrichment');
  for (const it of items) {
    if (it.userMsg === 'daj mi nesto poeftino vo toj reon') {
      assert.equal(it.composed, true, `card serve must classify composed: ${it.id}`);
    } else if (it.userMsg === 'okolu 6') {
      assert.equal(it.composed, true, `owner-relay ping must classify composed: ${it.id}`);
      assert.equal(it.bankOwned ?? false, false, 'relay ping is composed, not bank-owned');
    } else if (it.userMsg === 'kolku cinat') {
      assert.equal(it.composed ?? false, false, 'plain client-voice copy is not composed');
    } else if (it.userMsg?.startsWith('mozam vo 5')) {
      assert.equal(it.flag, 'ok', 'the gates pass the relay protocol text');
      assert.equal(it.composed, true, `and the composed class still claims it: ${it.id}`);
      const refused = review.push(it, 'learn.counter-relay', it.text);
      assert.equal(refused.ok, false, 'a clean-looking relay ping must not push to STAGED');
      assert.match(refused.reason ?? '', /composed/i);
    }
  }
});

test('an enrichment-solved pair never grays a capture edited after staging', () => {
  const { review, bank } = setup();
  const dyn = review.list('dynamic')[0];
  assert.equal(bank.updateDynamicAnswer(dyn.id, OTHER), true, 'capture now answers newer wording');

  const item = review.list('enrichment')[0];
  const push = review.push(item, 'learn.ima-reptil-tamu', GOOD);
  assert.equal(push.ok, true, push.reason);
  const staged = review.list('staged').find(i => i.key === 'learn.ima-reptil-tamu')!;
  const approved = review.approve(staged);
  assert.equal(approved.ok, true, approved.reason);
  assert.equal(bank.dynamicRows(1)[0].processed, 0,
    'a capture whose answer no longer matches keeps serving and stays pending');
});
