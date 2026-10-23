// QUESTIONS ACROSS THE TWO FILES — the review DB and the chat log DB.
//
// The chat database owns both the review bank and client-turn log, but legacy
// deployments can still have a separate sibling log. Pinned here: local rows
// take precedence and a sibling remains a fallback for imported legacy data.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { EnrichmentStore } from '../src/store/enrichment';
import { BankReview } from '../src/bank/review';

const QUESTIONS = ['MOZAM ZADUTRE POSLE 5', 'MOZAM VO VTORNIK POSLE 5'];

function seed(dir: string) {
  const bankDb = path.join(dir, 'bank.db');
  const logDb = path.join(dir, 'chatlog.db');
  {
    const db = new Db(bankDb);
    new BankStore(db).addVariant('vague.time', 'Одлично. Во колку часот точно би сакале?');
    db.db.close();
  }
  {
    const db = new Db(logDb);
    const en = new EnrichmentStore(db);
    for (const q of QUESTIONS) {
      en.insert({
        chatId: 'c1', state: 'idle', eventType: 'VISIT_TIME_PROVIDED',
        userMsg: q, replyText: 'Одлично.', replySource: 'deterministic', bankKey: 'vague.time',
      });
    }
    db.db.close();
  }
  return { bankDb, logDb };
}

test('ACTIVE row shows the questions logged in the sibling chat DB', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-prov-'));
  try {
    const { bankDb } = seed(dir);
    const db = new Db(bankDb);
    const row = new BankReview(db).list('active')[0];
    assert.equal(row.key, 'vague.time');
    assert.ok(row.userMsg, 'the question is filled in, not "(нема …)"');
    assert.match(row.userMsg!, /MOZAM ZADUTRE POSLE 5/);
    assert.match(row.userMsg!, /MOZAM VO VTORNIK POSLE 5/);
    db.db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a turn in the OPEN DB wins over the sibling log', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lina-prov-'));
  try {
    const { bankDb } = seed(dir);
    {
      const db = new Db(bankDb);
      new EnrichmentStore(db).insert({
        chatId: 'c2', state: 'idle', eventType: 'VISIT_TIME_PROVIDED',
        userMsg: 'VO PETOK POSLE 5', replyText: 'Одлично.', replySource: 'deterministic', bankKey: 'vague.time',
      });
      db.db.close();
    }
    const db = new Db(bankDb);
    const row = new BankReview(db).list('active')[0];
    assert.equal(row.userMsg, 'VO PETOK POSLE 5');
    db.db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('an in-memory DB has no siblings to consult (and never throws)', () => {
  const db = new Db(':memory:');
  new BankStore(db).addVariant('vague.time', 'Одлично. Во колку часот точно би сакале?');
  const row = new BankReview(db).list('active')[0];
  assert.equal(row.userMsg, null);
  assert.equal(new BankReview(db).questionSources(row).sibling, 0);
  db.db.close();
});
