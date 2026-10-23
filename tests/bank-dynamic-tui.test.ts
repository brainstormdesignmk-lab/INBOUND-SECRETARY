import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import Database from 'better-sqlite3';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { RESPONSE_BANK } from '../src/data/responses';
import { EnrichmentStore } from '../src/store/enrichment';
import { PtySession } from '../src/tui/pty';

const QUESTION = 'kakvi dokumenti se potrebni za kupuvanje?';
const ANSWER = 'Ќе го проверам кај сопственикот и ќе Ви кажам веднаш.';

function findProjectRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src', 'bank', 'run.ts'))) return dir;
    const parent = path.resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`bank-dynamic-pty: cannot find project root from ${from}`);
}

test('real bank:tui PTY: dynamic K persists, A stages, then STAGED A activates the learned route', { timeout: 60_000 }, async () => {
  const root = findProjectRoot(__dirname);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-dynamic-pty-'));
  const dbPath = path.join(dir, 'data', 'tui.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const setupDb = new Db(dbPath);
  new BankStore(setupDb).addDynamic('dynamic:property_query:dokumenti', 'property_query', QUESTION, ANSWER);
  setupDb.close();

  const pty = PtySession.start({
    command: `node ${JSON.stringify(path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'))} ${JSON.stringify(path.join(root, 'src', 'bank', 'run.ts'))} --db ${JSON.stringify(dbPath)}`, 
    cwd: root,
    env: { ...process.env, TERM: 'xterm-256color' },
    cols: 120,
    rows: 40,
  });
  try {
    await pty.waitForScreen(t => t.text().includes('MASTER') && t.text().includes('DYNAMIC (1)'), { timeoutMs: 20_000, label: 'bank review booted' });
    await pty.key('2');
    await pty.waitForScreen(t => t.text().includes('learn.kakvi-dokumenti-potrebni'), {
      timeoutMs: 5_000, label: 'dynamic tab and its suggested target key',
    });

    // K opens with the usable suggested key, not the internal dynamic: group.
    await pty.key('k');
    await pty.waitForScreen(t => t.text().includes('KEY:'), { timeoutMs: 5_000, label: 'dynamic key editor' });
    const suggestedKey = 'learn.kakvi-dokumenti-potrebni';
    await pty.key('\x7f'.repeat(suggestedKey.length));
    pty.write('learn.operator-picked');
    await pty.key('\r');
    await pty.waitForScreen(t => t.text().includes('learn.kakvi-dokumenti-potrebni → learn.operator-picked'), {
      timeoutMs: 5_000, label: 'custom K target saved and retained on the row',
    });

    // A on DYNAMIC pushes (does not activate); A on STAGED approves.
    await pty.key('a');
    await pty.waitForScreen(t => t.text().includes('3 STAGED (1)'), { timeoutMs: 5_000, label: 'dynamic answer staged' });
    await pty.key('3');
    await pty.waitForScreen(t => t.text().includes('STAGED (1)'), { timeoutMs: 5_000, label: 'staged tab opened' });
    await pty.key('a');
    await pty.waitForScreen(t => t.text().includes('4 ACTIVE (1)'), { timeoutMs: 5_000, label: 'approved answer active' });
    await pty.key('2');
    await pty.waitForScreen(t => t.text().includes('DYNAMIC') && !t.text().includes('DYNAMIC (0)') && t.text().includes('processed'), {
      timeoutMs: 5_000, label: 'processed capture remains as gray history without a zero pending badge',
    });
    assert.match(pty.raw.join(''), /\x1b\[90m/, 'processed dynamic row is rendered dark gray like the merge hint');
    assert.match(pty.screen(), /✓ #1/, 'processed row remains visibly checked in the audit list');

    const verify = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const variants = verify.prepare("SELECT key,text,lifecycle FROM bank_variants WHERE key=?").all('learn.operator-picked') as Array<{ key: string; text: string; lifecycle: string }>;
      assert.deepEqual(variants, [{ key: 'learn.operator-picked', text: ANSWER, lifecycle: 'active' }]);
      assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM bank_dynamic').get().n, 1, 'processed capture is retained for audit');
      assert.equal(verify.prepare('SELECT processed FROM bank_dynamic WHERE msg=?').get(QUESTION).processed, 1);
      assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM bank_examples WHERE key=? AND msg=?').get('learn.operator-picked', QUESTION).n, 1, 'approved example routes to the serving answer');
    } finally {
      verify.close();
    }
  } finally {
    await pty.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('real bank:tui PTY: #195 retargets a frozen fee answer, edits it, then stages and activates the attendance route', { timeout: 60_000 }, async () => {
  const root = findProjectRoot(__dirname);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-attendance-pty-'));
  const dbPath = path.join(dir, 'data', 'tui.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const setupDb = new Db(dbPath);
  const question = 'TI KE DOJDES SO MENE NA POSETA AKO ODBERAM STAN?';
  const oldFeeAnswer = 'Прекрасен избор на недвижност. Ве известувам дека во Метрополис купувачот НЕ плаќа агенциска провизија (0%), а единствениот трошок е симболични 500 денари (10 евра) за организација на посетата. Дали се согласувате со овој услов за да можеме да продолжиме понатаму?';
  const wantedAnswer = 'Да, агент на Метрополис ќе Ве придружува при разгледувањето на избраната недвижност. Кога ќе одлучите, ќе продолжиме со организирање на посетата — дали Ви одговара?';
  new EnrichmentStore(setupDb).insert({
    chatId: 'client-195', state: 'closing', eventType: 'VISIT_INTEREST',
    userMsg: question, replyText: oldFeeAnswer, replySource: 'deterministic', bankKey: 'fee.ask.buy',
  });
  setupDb.close();

  const pty = PtySession.start({
    command: `node ${JSON.stringify(path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs'))} ${JSON.stringify(path.join(root, 'src', 'bank', 'run.ts'))} --db ${JSON.stringify(dbPath)}`,
    cwd: root,
    env: { ...process.env, TERM: 'xterm-256color' },
    cols: 120,
    rows: 40,
  });
  try {
    await pty.waitForScreen(t => t.text().includes('ENRICHMENT (1)') && t.text().includes('TI KE DOJDES SO MENE NA POSETA'), {
      timeoutMs: 20_000, label: '#195 frozen fee queue row loaded',
    });

    // K changes the candidate's target without changing the original routing evidence.
    await pty.key('k');
    await pty.waitForScreen(t => t.text().includes('KEY:'), { timeoutMs: 5_000, label: '#195 target key editor' });
    await pty.key('\x15');
    pty.write('learn.agent-accompanies-viewing');
    await pty.key('\r');
    await pty.waitForScreen(t => t.text().includes('fee.ask.buy → learn.agent-accompanies-viewing'), {
      timeoutMs: 5_000, label: '#195 retarget saved while frozen source key remains visible',
    });
    await pty.waitForScreen(t => t.text().includes('КЛИЕНТСКОТО ПРАШАЊЕ Е ПРЕНАСОЧЕНО'), {
      timeoutMs: 5_000, label: 'retarget status shown rather than frozen refusal',
    });

    // E edits the frozen answer under the chosen learn key; Ctrl-U clears the old text.
    await pty.key('e');
    await pty.waitForScreen(t => t.text().includes('EDIT #1'), { timeoutMs: 5_000, label: '#195 answer editor' });
    await pty.key('\x15');
    pty.write(wantedAnswer);
    await pty.key('\x13');
    await pty.waitForScreen(t => t.text().includes('Да, агент на Метрополис'), {
      timeoutMs: 5_000, label: 'edited attendance answer saved in the queue',
    });

    // A stages only. The separate STAGED approval is what makes this answer serve.
    await pty.key('a');
    await pty.waitForScreen(t => t.text().includes('STAGED (1)'), { timeoutMs: 5_000, label: 'attendance answer staged for review' });
    await pty.key('3');
    await pty.waitForScreen(t => t.text().includes('STAGED (1)') && t.text().includes('Да, агент на Метрополис'), {
      timeoutMs: 5_000, label: 'staged attendance answer selected',
    });
    await pty.key('a');
    await pty.waitForScreen(t => t.text().includes('ACTIVE (1)'), { timeoutMs: 5_000, label: 'attendance answer activated' });

    const verify = new Database(dbPath, { readonly: true, fileMustExist: true });
    try {
      const variants = verify.prepare("SELECT key,text,lifecycle FROM bank_variants WHERE key=?").all('learn.agent-accompanies-viewing') as Array<{ key: string; text: string; lifecycle: string }>;
      assert.deepEqual(variants, [{ key: 'learn.agent-accompanies-viewing', text: wantedAnswer, lifecycle: 'active' }]);
      assert.equal(verify.prepare("SELECT COUNT(*) AS n FROM bank_variants WHERE key='fee.ask.buy'").get().n, 0, 'the frozen fee pool was not changed');
      assert.equal(verify.prepare('SELECT COUNT(*) AS n FROM bank_examples WHERE key=? AND msg=?').get('learn.agent-accompanies-viewing', question).n, 1, 'the original question now retrieves the attendance answer');
      const record = verify.prepare('SELECT bank_key,reply_text,enriched FROM enrichment_queue WHERE user_msg=?').get(question) as { bank_key: string; reply_text: string; enriched: number };
      assert.equal(record.bank_key, 'fee.ask.buy', 'original routing evidence remains intact');
      assert.equal(record.reply_text, wantedAnswer, 'operator correction is retained in the queue log');
      assert.equal(record.enriched, 1, 'the reviewed queue turn is marked processed');
    } finally {
      verify.close();
    }
  } finally {
    await pty.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});


test('real bank:tui PTY: #66 labels the generator prompt separately from absent client-question history', { timeout: 60_000 }, async () => {
  // findProjectRoot — the compiled bundle lives in dist-test/tests, so a
  // naive path.resolve(__dirname, '..') sees dist-test as the root and the
  // child exits 127 (no such tsx). The sibling tests use the walker.
  const root = findProjectRoot(__dirname);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bank-gapfill-context-pty-'));
  const dbPath = path.join(dir, 'data', 'tui.db');
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const setupDb = new Db(dbPath);
  const key = 'discovery.ask.budget.business';
  const answer = RESPONSE_BANK[key][0];
  new BankStore(setupDb).addVariant(key, answer);
  setupDb.close();

  const pty = PtySession.start({
    command: `node_modules/.bin/tsx src/bank/run.ts --db ${dbPath}`,
    cwd: root,
    env: { ...process.env, TERM: 'xterm-256color' },
    cols: 120,
    rows: 40,
  });
  try {
    await pty.waitForScreen(t => t.text().includes('MASTER'), { timeoutMs: 20_000, label: 'bank review booted for gapfill key' });
    await pty.key('4');
    await pty.waitForScreen(t => t.text().includes('GENERATOR CONTEXT')
      && t.text().includes('До која цена го барате?')
      && t.text().includes('ДЕЛОВНИОТ ПРОСТОР'), {
      timeoutMs: 5_000, label: '#66 generator reference and instruction shown',
    });
    assert.match(pty.screen(), /QUESTION: \(нема запишано клиентско прашање\)/,
      'do not claim the generator reference was an actual client question');
    assert.match(pty.screen(), /Reference: До која цена го барате/);
    assert.match(pty.screen(), /SERVING TEXT:/);
  } finally {
    await pty.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
