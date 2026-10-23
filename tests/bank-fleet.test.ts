import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Database from 'better-sqlite3';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { BankReview } from '../src/bank/review';
import {
  buildFleetSources, countSourceApprovals, examplesFromImportNote, exportLinaDatabase,
  parseAtomSources, saveDatedMasterSnapshot, stageMissingBankRows, syncSharedBank,
} from '../src/bank/fleet';

function findProjectRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) return dir;
    const parent = path.resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`cannot find project root from ${from}`);
}
const ROOT = findProjectRoot(__dirname);
const ATOMS = fs.readFileSync(path.join(ROOT, 'scripts', 'atoms.conf'), 'utf8');
const GOOD = 'Ќе проверам со сопственикот и ќе Ви одговорам веднаш.';
const GOOD2 = 'Ќе побарам потврда и ќе Ви испратам точна информација.';

function memoryDb(): Db { return new Db(':memory:'); }
function putVariant(db: Db, key: string, text: string, lifecycle = 'active'): void {
  new BankStore(db);
  db.db.prepare('INSERT INTO bank_variants(key,text,source,created_at,lifecycle,note) VALUES(?,?,?,?,?,NULL)')
    .run(key, text, 'learned:test', Date.now(), lifecycle);
}

test('fleet selector always shows TUI then all three atoms, including unprovisioned entries', () => {
  const atoms = parseAtomSources(ATOMS);
  assert.deepEqual(atoms.map(atom => atom.id), ['atom01', 'atom02', 'atom03']);
  assert.equal(atoms[0].configured, true);
  assert.equal(atoms[1].configured, false);
  assert.equal(atoms[2].configured, false);
  const sources = buildFleetSources(ATOMS, ROOT);
  assert.deepEqual(sources.map(source => source.id), ['tui', 'atom01', 'atom02', 'atom03']);
  assert.match(sources[0].dbPath!, /data[\\/]tui\.db$/);
  assert.equal(sources[2].note, 'clone — enable when provisioned');
});

test('commented atom config entries stay visible but disabled; RELAY remains excluded', () => {
  const atoms = parseAtomSources('# atom01|h|u|KEY|/lina|disabled\natom02|h|u|KEY|/lina|enabled\natom4|h|u|KEY|/relay|RELAY');
  assert.equal(atoms[0].configured, false);
  assert.equal(atoms[1].configured, true);
  assert.equal(atoms.length, 3);
});

test('source merge stages unseen key+answer pairs once and carries source examples', () => {
  const master = memoryDb();
  const source = memoryDb();
  putVariant(master, 'learn.test', GOOD);
  putVariant(source, 'learn.test', GOOD);
  putVariant(source, 'learn.test', GOOD2);
  source.db.prepare('INSERT INTO bank_examples(key,msg,created_at) VALUES(?,?,?)').run('learn.test', 'кој може да потврди?', Date.now());
  const first = stageMissingBankRows(source.db, master, 'atom01');
  assert.equal(first.added, 1);
  assert.equal(first.duplicates, 1);
  assert.equal(countSourceApprovals(source.db, master, 'atom01'), 1, 'unresolved candidate count is machine-visible');
  const staged = master.db.prepare("SELECT * FROM bank_variants WHERE lifecycle='staged'").get() as { key: string; text: string; source: string; note: string };
  assert.equal(staged.text, GOOD2);
  assert.equal(staged.source, 'fleet:atom01');
  assert.deepEqual(examplesFromImportNote(staged.note), ['кој може да потврди?']);
  assert.equal(stageMissingBankRows(source.db, master, 'atom01').added, 0, 're-opening is idempotent');
  assert.equal(master.db.prepare("SELECT COUNT(*) n FROM bank_variants WHERE lifecycle='active' AND text=?").get(GOOD2).n, 0, 'staging does not serve');
  const review = new BankReview(master);
  assert.match(review.list('staged')[0].userMsg ?? '', /кој може да потврди/);
  const approved = review.approve(review.list('staged')[0]);
  assert.equal(approved.ok, true);
  assert.equal(master.db.prepare('SELECT COUNT(*) n FROM bank_examples WHERE key=? AND msg=?').get('learn.test', 'кој може да потврди?').n, 1);
  assert.equal(countSourceApprovals(source.db, master, 'atom01'), 0);
  source.close(); master.close();
});


test('dynamic source captures become staged learned answers with their client questions', () => {
  const master = memoryDb(), source = memoryDb();
  new BankStore(master);
  new BankStore(source).addDynamic('dynamic:idle:parking', 'idle', 'ima li parking?', GOOD);
  const count = countSourceApprovals(source.db, master, 'atom01');
  assert.equal(count, 1);
  const report = stageMissingBankRows(source.db, master, 'atom01');
  assert.equal(report.added, 1);
  new BankStore(master);
  const row = master.db.prepare("SELECT key,text,note FROM bank_variants WHERE lifecycle='staged'").get() as {key:string;text:string;note:string};
  assert.equal(row.key, 'learn.ima-parking');
  assert.equal(row.text, GOOD);
  assert.deepEqual(examplesFromImportNote(row.note), ['ima li parking?']);
  master.close(); source.close();
});

test('different sources contribute distinct unseen answers, duplicate wording is not re-staged', () => {
  const master = memoryDb(), a1 = memoryDb(), a2 = memoryDb();
  putVariant(a1, 'learn.shared', GOOD);
  putVariant(a2, 'learn.shared', GOOD);
  putVariant(a2, 'learn.shared', GOOD2);
  assert.equal(stageMissingBankRows(a1.db, master, 'atom01').added, 1);
  assert.equal(stageMissingBankRows(a2.db, master, 'atom02').added, 1);
  assert.equal(master.db.prepare("SELECT COUNT(*) n FROM bank_variants WHERE lifecycle='staged'").get().n, 2);
  const review = new BankReview(master);
  for (const row of review.list('staged')) assert.equal(review.approve(row).ok, true);
  assert.equal(countSourceApprovals(a1.db, master, 'atom01'), 0);
  assert.equal(countSourceApprovals(a2.db, master, 'atom02'), 0);
  a1.close(); a2.close(); master.close();
});

test('rejecting an imported candidate clears its source pending count and does not import examples', () => {
  const master = memoryDb(), source = memoryDb();
  putVariant(source, 'learn.reject', GOOD);
  source.db.prepare('INSERT INTO bank_examples(key,msg,created_at) VALUES(?,?,?)').run('learn.reject', 'прашање од клиент', Date.now());
  stageMissingBankRows(source.db, master, 'atom03');
  const review = new BankReview(master);
  const staged = review.list('staged')[0];
  assert.equal(countSourceApprovals(source.db, master, 'atom03'), 1);
  assert.equal(review.reject(staged).ok, true);
  assert.equal(countSourceApprovals(source.db, master, 'atom03'), 0);
  assert.equal(master.db.prepare('SELECT COUNT(*) n FROM bank_examples').get().n, 0);
  source.close(); master.close();
});

test('export backs up existing appliance data and exports only the active shared bank', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-export-'));
  const master = new Db(path.join(dir, 'data', 'tui.db'));
  const appliance = new Db(path.join(dir, 'data', 'lina.db'));
  try {
    putVariant(master, 'learn.export', GOOD);
    putVariant(master, 'learn.export', GOOD2, 'staged');
    putVariant(appliance, 'learn.old', 'Старата appliance варијанта.');
    appliance.db.prepare('INSERT INTO sessions(chat_id,channel,data,updated_at) VALUES(?,?,?,?)').run('keep-client','viber','{}',7);

    await assert.rejects(() => exportLinaDatabase(master, appliance.file), /1 staged answer/);
    assert.equal(appliance.db.prepare('SELECT text FROM bank_variants WHERE key=?').get('learn.old').text, 'Старата appliance варијанта.');

    new BankStore(master).promoteVariant(master.db.prepare("SELECT id FROM bank_variants WHERE lifecycle='staged'").get().id);
    const report = await exportLinaDatabase(master, appliance.file);
    assert.equal(report.variants, 2);
    assert.equal(appliance.db.prepare("SELECT COUNT(*) n FROM bank_variants WHERE lifecycle='active'").get().n, 2);
    assert.equal(appliance.db.prepare('SELECT COUNT(*) n FROM bank_variants WHERE key=?').get('learn.old').n, 0);
    assert.equal(appliance.db.prepare('SELECT chat_id FROM sessions').get().chat_id, 'keep-client');
    const snapshots = fs.readdirSync(path.join(dir, 'data', 'master-snapshots'));
    assert.ok(snapshots.some(name => name.startsWith('lina-before-export-')));
    await assert.rejects(() => exportLinaDatabase(master, master.file), /must not overwrite/);
    const alias = path.join(dir, 'data', 'master-alias.db');
    fs.symlinkSync(master.file, alias);
    await assert.rejects(() => exportLinaDatabase(master, alias), /resolves to the TUI master/);
  } finally {
    appliance.close(); master.close(); fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('dated master backup is a consistent whole-file snapshot; shared-bank sync leaves local rows untouched', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-fleet-'));
  const master = memoryDb(), target = memoryDb();
  putVariant(master, 'learn.shared', GOOD);
  putVariant(target, 'learn.shared', GOOD2);
  master.db.prepare('INSERT INTO sessions(chat_id,channel,data,updated_at) VALUES(?,?,?,?)').run('master-client','tui','{}',1);
  target.db.prepare('INSERT INTO sessions(chat_id,channel,data,updated_at) VALUES(?,?,?,?)').run('atom-client','viber','{}',2);
  const snapshot = await saveDatedMasterSnapshot(master, dir, new Date(2026, 9, 21, 12, 34, 56).getTime());
  assert.match(snapshot, /lina-master-20261021-123456\.db$/);
  const read = new Database(snapshot, { readonly: true });
  assert.equal((read.pragma('quick_check') as Array<{quick_check:string}>)[0].quick_check, 'ok');
  read.close();
  const counts = syncSharedBank(master, target);
  assert.equal(counts.variants, 1);
  assert.deepEqual((target.db.prepare('SELECT key,text FROM bank_variants').get() as {key:string;text:string}), {key:'learn.shared',text:GOOD});
  assert.equal(target.db.prepare('SELECT chat_id FROM sessions').get().chat_id, 'atom-client');
  assert.equal(master.db.prepare('SELECT chat_id FROM sessions').get().chat_id, 'master-client');
  target.close(); master.close(); fs.rmSync(dir,{recursive:true,force:true});
});
