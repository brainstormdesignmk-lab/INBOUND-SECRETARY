/**
 * Source selector and shared-bank workflow for bank:tui.
 *
 * The local TUI database is the review master; the appliance data/lina.db
 * exports its reviewed shared bank. Atom databases are read-only sources whose
 * active bank material is staged for approval, with no client/session/queue
 * data copied. The approved master can then be backed up and synchronized.
 */
import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { Db } from '../store/db';
import { BankStore, isExcludedFromEnrichment } from '../store/bank';
import { RESPONSE_BANK } from '../data/responses';
import { normalizedKey } from '../llm/dedupe';
import { learnKeySlug } from './review';
import { EnrichmentRecord, EnrichmentStore } from '../store/enrichment';

const execFileAsync = promisify(execFile);
export const TUI_DB_PATH = 'data/tui.db';
export const MASTER_DB_PATH = TUI_DB_PATH;
export const LINA_EXPORT_PATH = 'data/lina.db';
const ATOM_IDS = ['atom01', 'atom02', 'atom03'] as const;
export type FleetSourceId = 'tui' | typeof ATOM_IDS[number];

export interface AtomSource {
  id: typeof ATOM_IDS[number];
  label: string;
  host?: string;
  user?: string;
  keyToken?: string;
  remotePath?: string;
  note: string;
  configured: boolean;
}
export interface FleetSource {
  id: FleetSourceId;
  label: string;
  dbPath?: string;
  configured: boolean;
  note?: string;
  remote?: AtomSource;
}
export interface MergeReport {
  added: number;
  duplicates: number;
  excluded: number;
  sourceVariants: number;
  sourceId: string;
}

export function parseAtomSources(config: string): AtomSource[] {
  const parsed = new Map<string, AtomSource>();
  for (const raw of config.split(/\r?\n/)) {
    const rawLine = raw.trim();
    const enabled = !rawLine.startsWith('#');
    const fields = rawLine.replace(/^#\s*/, '').split('|').map(value => value.trim());
    const id = fields[0];
    if (!(ATOM_IDS as readonly string[]).includes(id) || fields.length < 6) continue;
    const [, host, user, keyToken, remotePath, note] = fields;
    if (/relay/i.test(note)) continue;
    parsed.set(id, {
      id: id as AtomSource['id'], label: `${id.toUpperCase()} LINA`,
      host, user, keyToken, remotePath, note, configured: enabled,
    });
  }
  return ATOM_IDS.map(id => parsed.get(id) ?? {
    id, label: `${id.toUpperCase()} LINA`, note: 'not configured in scripts/atoms.conf', configured: false,
  });
}

export function buildFleetSources(config: string, root: string): FleetSource[] {
  const sources: FleetSource[] = [{
    id: 'tui', label: 'WORKSTATION1 LINA (TUI)', dbPath: path.join(root, TUI_DB_PATH),
    configured: fs.existsSync(path.join(root, TUI_DB_PATH)),
  }];
  for (const atom of parseAtomSources(config)) {
    const reviewDir = path.join(root, 'data', 'atoms', atom.id, 'review');
    const snapshots = fs.existsSync(reviewDir)
      ? fs.readdirSync(reviewDir).filter(name => /^latest-.*\.db$/.test(name)).map(name => path.join(reviewDir, name))
      : [];
    snapshots.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
    const collected = path.join(root, 'data', 'atoms', atom.id, 'lina.db.copy');
    sources.push({
      id: atom.id, label: atom.label,
      dbPath: snapshots[0] ?? (fs.existsSync(collected) ? collected : undefined),
      configured: atom.configured, note: atom.note, remote: atom,
    });
  }
  return sources;
}

function shQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
function sshArgs(key: string): string[] {
  return ['-o', 'BatchMode=yes', '-o', 'IdentitiesOnly=yes', '-o', 'ConnectTimeout=8', '-i', key];
}

/**
 * Snapshot an atom's current data/lina.db using SQLite's online backup API via
 * the remote sqlite3 CLI, then retrieve a fully local DB copy. No ssh action
 * writes to the atom's live DB. A .part file is renamed only after quick_check.
 */
export async function fetchAtomSnapshot(
  atom: AtomSource,
  root: string,
  opts: { home?: string; now?: number; timeoutMs?: number } = {},
): Promise<string> {
  if (!atom.configured || !atom.host || !atom.user || !atom.keyToken || !atom.remotePath) {
    throw new Error(`${atom.label}: not configured in scripts/atoms.conf`);
  }
  const keyBase = atom.keyToken.replace(/_KEY$/, '').toLowerCase().replace(/_/g, '');
  const key = path.join(opts.home ?? os.homedir(), '.ssh', `id_ed25519_${keyBase}`);
  if (!fs.existsSync(key)) throw new Error(`${atom.label}: SSH key missing (${key})`);
  const target = `${atom.user}@${atom.host}`;
  const stamp = opts.now ?? Date.now();
  const dir = path.join(root, 'data', 'atoms', atom.id, 'review');
  fs.mkdirSync(dir, { recursive: true });
  const remotePath = `/tmp/lina-review-${atom.id}-${stamp}-${process.pid}.db`;
  const localPart = path.join(dir, `latest-${stamp}.db.part`);
  const localFinal = path.join(dir, `latest-${stamp}.db`);
  const timeout = opts.timeoutMs ?? 30_000;
  const args = sshArgs(key);
  try {
    const remoteDb = `${atom.remotePath}/data/lina.db`;
    await execFileAsync('ssh', [...args, target,
      `sqlite3 ${shQuote(remoteDb)} ${shQuote(`.backup ${remotePath}`)}`], { timeout });
    await execFileAsync('scp', ['-q', ...args, `${target}:${remotePath}`, localPart], { timeout });
    const local = new Database(localPart, { readonly: true, fileMustExist: true });
    try {
      const checks = local.pragma('quick_check') as Array<{ quick_check: string }>;
      if (checks.some(row => row.quick_check !== 'ok')) throw new Error('sqlite quick_check failed');
    } finally { local.close(); }
    fs.renameSync(localPart, localFinal);
    return localFinal;
  } catch (error) {
    const e = error as NodeJS.ErrnoException & { stderr?: string };
    const why = (e.stderr || e.message || 'SSH snapshot failed').trim().split('\n').slice(-2).join(' ');
    throw new Error(`${atom.label}: snapshot failed — ${why}`);
  } finally {
    try { fs.rmSync(localPart, { force: true }); } catch { /* best-effort */ }
    void execFileAsync('ssh', [...args, target, `rm -f ${shQuote(remotePath)}`], { timeout: 5_000 }).catch(() => undefined);
  }
}

interface Variant { key: string; text: string; lifecycle?: string; }
interface DynamicAnswer { msg: string; answer: string; }
interface Example { key: string; msg: string; }

const encodeExamples = (values: string[]): string => encodeURIComponent(JSON.stringify(values.slice(0, 12)));
export function sourceIdFromImportNote(note?: string | null): string | null {
  return /fleet-import:([^\n ·]+)/.exec(note ?? '')?.[1] ?? null;
}
export function examplesFromImportNote(note?: string | null): string[] {
  const match = /fleet-import:[^\n ·]+\nexamples:([^\n]*)/.exec(note ?? '');
  if (!match) return [];
  try {
    const decoded: unknown = JSON.parse(decodeURIComponent(match[1]));
    return Array.isArray(decoded) ? decoded.filter((item): item is string => typeof item === 'string' && item.trim().length >= 4) : [];
  } catch { return []; }
}

function activeAnswerIndex(masterDb: Db): Map<string, Map<string, string>> {
  const index = new Map<string, Map<string, string>>();
  const add = (key: string, text: string, lifecycle: string): void => {
    let byAnswer = index.get(key);
    if (!byAnswer) { byAnswer = new Map(); index.set(key, byAnswer); }
    const normalized = normalizedKey(text);
    const previous = byAnswer.get(normalized);
    if (previous !== 'active') byAnswer.set(normalized, lifecycle);
  };
  for (const row of masterDb.db.prepare('SELECT key,text,lifecycle FROM bank_variants').all() as Array<{key:string;text:string;lifecycle?:string}>) {
    add(row.key, row.text, row.lifecycle ?? 'active');
  }
  for (const [key, values] of Object.entries(RESPONSE_BANK)) for (const text of values) add(key, text, 'active');
  return index;
}

/** Count active source answers not yet resolved by the master: missing and
 * staged are pending; active means already incorporated; retired means the
 * operator explicitly rejected it and cleared that source's count. */
function ensureReviewLedger(db: Db): void {
  db.db.exec(`CREATE TABLE IF NOT EXISTS bank_source_reviews (
    source_id TEXT NOT NULL, bank_key TEXT NOT NULL, normalized_text TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('staged','approved','rejected')), updated_at INTEGER NOT NULL,
    PRIMARY KEY(source_id, bank_key, normalized_text)
  )`);
}

function sourceCandidates(sourceDb: Database.Database): Array<{key:string;text:string;examples:string[]}> {
  const results: Array<{key:string;text:string;examples:string[]}> = [];
  const exists = (name: string): boolean => !!sourceDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
  const variantExists = exists('bank_variants');
  if (variantExists) {
    const columns = sourceDb.prepare('PRAGMA table_info(bank_variants)').all() as Array<{name:string}>;
    if (!columns.some(column => column.name === 'key') || !columns.some(column => column.name === 'text')) {
      throw new Error('source bank_variants table is missing key/text columns');
    }
    const lifecycle = columns.some(c => c.name === 'lifecycle');
    const rows = sourceDb.prepare(`SELECT key,text${lifecycle ? ',lifecycle' : ''} FROM bank_variants${lifecycle ? " WHERE lifecycle='active'" : ''}`).all() as Variant[];
    const examplesTable = exists('bank_examples');
    const examples = examplesTable ? sourceDb.prepare('SELECT key,msg FROM bank_examples ORDER BY id').all() as Example[] : [];
    const examplesByKey = new Map<string,string[]>();
    for (const example of examples) {
      const values = examplesByKey.get(example.key) ?? [];
      if (!values.includes(example.msg)) values.push(example.msg);
      examplesByKey.set(example.key, values);
    }
    for (const row of rows) results.push({ key: row.key, text: row.text, examples: examplesByKey.get(row.key) ?? [] });
  }
  const dynamicExists = exists('bank_dynamic');
  if (dynamicExists) {
    const columns = sourceDb.prepare('PRAGMA table_info(bank_dynamic)').all() as Array<{name:string}>;
    if (!columns.some(column => column.name === 'msg') || !columns.some(column => column.name === 'answer')) {
      throw new Error('source bank_dynamic table is missing msg/answer columns');
    }
    // Processed captures have already become live learned routes; do not
    // re-import their old generated answers as new source candidates.
    const hasProcessed = columns.some(column => column.name === 'processed');
    const rows = sourceDb.prepare(
      `SELECT msg,answer FROM bank_dynamic ${hasProcessed ? 'WHERE processed = 0' : ''} ORDER BY id`
    ).all() as DynamicAnswer[];
    for (const row of rows) {
      const key = learnKeySlug(row.msg);
      const existing = results.find(candidate => candidate.key === key && normalizedKey(candidate.text) === normalizedKey(row.answer));
      if (existing) { if (!existing.examples.includes(row.msg)) existing.examples.push(row.msg); }
      else results.push({ key, text: row.answer, examples: [row.msg] });
    }
  }
  return results;
}

/** Read enrichment rows from a source DB without mutating that DB. */
export function readEnrichmentLog(sourceDb: Database.Database): EnrichmentRecord[] {
  const exists = sourceDb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='enrichment_queue'").get();
  if (!exists) return [];
  const columns = sourceDb.prepare('PRAGMA table_info(enrichment_queue)').all() as Array<{ name: string }>;
  const required = ['id','chat_id','state','event_type','user_msg','reply_text','reply_source','bank_key','created_at','enriched'];
  const missing = required.filter(name => !columns.some(column => column.name === name));
  if (missing.length > 0) throw new Error(`source enrichment_queue is missing columns: ${missing.join(', ')}`);
  const has = (name: string): boolean => columns.some(column => column.name === name);
  const select = (name: string, alias: string, fallback: string): string => `${has(name) ? name : fallback} AS ${alias}`;
  return sourceDb.prepare(`
    SELECT id, chat_id AS chatId, state, event_type AS eventType, user_msg AS userMsg,
      reply_text AS replyText, reply_source AS replySource, bank_key AS bankKey,
      created_at AS createdAt, enriched,
      ${select('source_id', 'origin', "'local'")},
      ${select('source_record_id', 'sourceRecordId', 'NULL')},
      ${select('review_key', 'reviewKey', 'NULL')},
      ${select('review_status', 'reviewStatus', "'pending'")},
      ${select('review_reason', 'reviewReason', 'NULL')}
    FROM enrichment_queue ORDER BY id ASC
  `).all() as EnrichmentRecord[];
}

/** Import only source audit rows, preserving the original key and row ID. */
export function importSourceEnrichmentLog(sourceDb: Database.Database, masterDb: Db, sourceId: string): { added: number; duplicates: number } {
  if (!sourceId || sourceId === 'local') throw new Error('import sourceId must identify a machine');
  const      rows = readEnrichmentLog(sourceDb);
  if (rows.length === 0) return { added: 0, duplicates: 0 };
  const imported = new EnrichmentStore(masterDb).importRecords(sourceId, rows);
  return imported;
}

/** Remaining source-only learned answers, including dynamic captures. */
export function countSourceApprovals(sourceDb: Database.Database, masterDb: Db, sourceId: string): number {
  ensureReviewLedger(masterDb);
  const known = activeAnswerIndex(masterDb);
  const ledger = masterDb.db.prepare('SELECT status FROM bank_source_reviews WHERE source_id=? AND bank_key=? AND normalized_text=?');
  let pending = 0;
  for (const row of sourceCandidates(sourceDb)) {
    if (!row.key || !row.text?.trim() || isExcludedFromEnrichment(row.key)) continue;
    const normalized = normalizedKey(row.text.trim());
    const resolved = ledger.get(sourceId, row.key, normalized) as {status:string}|undefined;
    if (resolved?.status === 'rejected' || resolved?.status === 'approved') continue;
    const status = known.get(row.key)?.get(normalized);
    if (status !== 'active' && status !== 'retired') pending++;
    else if (status === 'active') {
      masterDb.db.prepare(`INSERT INTO bank_source_reviews(source_id,bank_key,normalized_text,status,updated_at) VALUES(?,?,?,'approved',?) ON CONFLICT(source_id,bank_key,normalized_text) DO UPDATE SET status='approved',updated_at=excluded.updated_at`).run(sourceId,row.key,normalized,Date.now());
    }
  }
  return pending;
}

/** Stage unseen active key+answer pairs in the master only. Similarity is
 * exact after project normalization; each candidate remains non-serving until
 * BankReview.approve promotes it. Its question examples live in the staged
 * note and are added to master retrieval only after that approval. */
export function stageMissingBankRows(sourceDb: Database.Database, masterDb: Db, sourceId: string): MergeReport {
  const sourceRows = sourceCandidates(sourceDb);
  if (sourceRows.length === 0) throw new Error(`${sourceId}: no bank_variants or bank_dynamic data`);

  ensureReviewLedger(masterDb);
  const bank = new BankStore(masterDb);
  const current = masterDb.db.prepare('SELECT key,text,lifecycle FROM bank_variants').all() as Array<{ key: string; text: string; lifecycle?: string }>;
  const existing = new Map<string, Map<string, string>>();
  const mark = (key: string, text: string, state: string): void => {
    let texts = existing.get(key);
    if (!texts) { texts = new Map(); existing.set(key, texts); }
    const normalized = normalizedKey(text);
    const previous = texts.get(normalized);
    if (previous !== 'active') texts.set(normalized, state);
  };
  for (const row of current) mark(row.key, row.text, row.lifecycle ?? 'active');
  for (const [key, values] of Object.entries(RESPONSE_BANK)) for (const value of values) mark(key, value, 'active');

  let added = 0, duplicates = 0, excluded = 0;
  const tx = masterDb.db.transaction(() => {
    for (const row of sourceRows) {
      if (!row.key || !row.text?.trim()) continue;
      if (isExcludedFromEnrichment(row.key)) { excluded++; continue; }
      const normalized = normalizedKey(row.text.trim());
      const decision = masterDb.db.prepare('SELECT status FROM bank_source_reviews WHERE source_id=? AND bank_key=? AND normalized_text=?').get(sourceId,row.key,normalized) as {status:string}|undefined;
      if (decision?.status === 'rejected' || decision?.status === 'approved') { duplicates++; continue; }
      const currentState = existing.get(row.key)?.get(normalized);
      if (currentState === 'active' || currentState === 'retired') {
        masterDb.db.prepare(`INSERT INTO bank_source_reviews(source_id,bank_key,normalized_text,status,updated_at) VALUES(?,?,?,'approved',?) ON CONFLICT(source_id,bank_key,normalized_text) DO UPDATE SET status='approved',updated_at=excluded.updated_at`).run(sourceId,row.key,normalized,Date.now());
        duplicates++; continue;
      }
      if (currentState === 'staged') {
        masterDb.db.prepare(`INSERT INTO bank_source_reviews(source_id,bank_key,normalized_text,status,updated_at) VALUES(?,?,?,'staged',?) ON CONFLICT(source_id,bank_key,normalized_text) DO UPDATE SET status='staged',updated_at=excluded.updated_at`).run(sourceId,row.key,normalized,Date.now());
        duplicates++; continue;
      }
      const candidate = row;
      const note = `fleet-import:${sourceId}\nexamples:${encodeExamples(candidate.examples)}`;
      if (bank.addStagedVariant(row.key, row.text, note, `fleet:${sourceId}`)) {
        mark(row.key, row.text, 'staged');
        masterDb.db.prepare(`INSERT INTO bank_source_reviews(source_id,bank_key,normalized_text,status,updated_at) VALUES(?,?,?,'staged',?) ON CONFLICT(source_id,bank_key,normalized_text) DO UPDATE SET status='staged',updated_at=excluded.updated_at`).run(sourceId,row.key,normalized,Date.now());
        added++;
      } else duplicates++;
    }
  });
  tx();
  return { added, duplicates, excluded, sourceVariants: sourceRows.length, sourceId };
}

export function markImportDecision(db: Db, sourceId: string, key: string, text: string, status: 'approved' | 'rejected'): void {
  ensureReviewLedger(db);
  const normalized = normalizedKey(text);
  db.db.prepare(`INSERT INTO bank_source_reviews(source_id,bank_key,normalized_text,status,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(source_id,bank_key,normalized_text) DO UPDATE SET status=excluded.status,updated_at=excluded.updated_at`).run(sourceId,key,normalized,status,Date.now());
  // One decision resolves the same key+answer wherever it was learned.
  db.db.prepare('UPDATE bank_source_reviews SET status=?,updated_at=? WHERE bank_key=? AND normalized_text=?').run(status,Date.now(),key,normalized);
}

/** Backup any opened SQLite DB to the shared dated snapshot directory. */
export async function saveDatedDatabaseSnapshot(database: Database.Database, root: string, prefix: string, now = Date.now()): Promise<string> {
  const out = path.join(root, 'data', 'master-snapshots');
  fs.mkdirSync(out, { recursive: true });
  const date = new Date(now);
  const stamp = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}-${String(date.getHours()).padStart(2, '0')}${String(date.getMinutes()).padStart(2, '0')}${String(date.getSeconds()).padStart(2, '0')}`;
  let dest = path.join(out, `${prefix}-${stamp}.db`);
  for (let i = 1; fs.existsSync(dest); i++) dest = path.join(out, `${prefix}-${stamp}-${i}.db`);
  await database.backup(dest);
  const check = new Database(dest, { readonly: true, fileMustExist: true });
  try {
    const result = check.pragma('quick_check') as Array<{ quick_check: string }>;
    if (result.some(row => row.quick_check !== 'ok')) throw new Error(`database snapshot integrity check failed: ${dest}`);
  } finally { check.close(); }
  return dest;
}

/** Save a dated, transaction-consistent copy of the entire master DB locally. */
export async function saveDatedMasterSnapshot(master: Db, root: string, now = Date.now()): Promise<string> {
  return saveDatedDatabaseSnapshot(master.db, root, 'lina-master', now);
}

/** Sync only shared learned bank content; machine-local data is preserved. */
export function syncSharedBank(master: Db, destination: Db): { variants: number; examples: number } {
  new BankStore(master);
  new BankStore(destination);
  const columns = master.db.prepare('PRAGMA table_info(bank_variants)').all() as Array<{name:string}>;
  const hasLifecycle = columns.some(column => column.name === 'lifecycle');
  const hasNote = columns.some(column => column.name === 'note');
  if (!hasLifecycle || !hasNote) new BankStore(master);
  const variants = master.db.prepare("SELECT key,text,source,created_at,lifecycle,note FROM bank_variants WHERE lifecycle='active' ORDER BY id").all() as Array<{
    key: string; text: string; source: string; created_at: number; lifecycle: string; note: string | null;
  }>;
  const targetColumns = destination.db.prepare('PRAGMA table_info(bank_variants)').all() as Array<{name:string}>;
  if (!targetColumns.some(column => column.name === 'lifecycle') || !targetColumns.some(column => column.name === 'note')) new BankStore(destination);
  const examples = master.db.prepare('SELECT key,msg,created_at FROM bank_examples ORDER BY id').all() as Array<{ key: string; msg: string; created_at: number }>;
  const tx = destination.db.transaction(() => {
    destination.db.prepare('DELETE FROM bank_variants').run();
    const putVariant = destination.db.prepare('INSERT INTO bank_variants (key,text,source,created_at,lifecycle,note) VALUES (?,?,?,?,?,?)');
    for (const v of variants) putVariant.run(v.key, v.text, v.source, v.created_at, v.lifecycle, v.note);
    destination.db.prepare('DELETE FROM bank_examples').run();
    const putExample = destination.db.prepare('INSERT INTO bank_examples (key,msg,created_at) VALUES (?,?,?)');
    for (const e of examples) putExample.run(e.key, e.msg, e.created_at);
  });
  tx();
  return { variants: variants.length, examples: examples.length };
}

/** Export only the shared bank from the reviewed TUI master. The destination
 *  must be separate so sessions, captures, and audit rows remain machine-local. */
export async function exportLinaDatabase(master: Db, outputPath = LINA_EXPORT_PATH): Promise<{ path: string; variants: number; examples: number }> {
  const targetPath = path.resolve(outputPath);
  const masterPath = master.file === ':memory:' ? null : path.resolve(master.file);
  if (masterPath && targetPath === masterPath) throw new Error('export target must not overwrite the TUI master database');
  if (masterPath && fs.existsSync(targetPath) && fs.realpathSync(targetPath) === fs.realpathSync(masterPath)) {
    throw new Error('export target resolves to the TUI master database');
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  const staged = master.db.prepare("SELECT COUNT(*) AS n FROM bank_variants WHERE lifecycle='staged'").get() as {n:number};
  if (staged.n > 0) throw new Error(`${staged.n} staged answer(s) still need approval`);
  if (fs.existsSync(targetPath)) {
    const before = new Database(targetPath);
    try {
      const backupDir = path.join(path.dirname(targetPath), 'master-snapshots');
      fs.mkdirSync(backupDir, { recursive: true });
      const backupPath = path.join(backupDir, `lina-before-export-${Date.now()}.db`);
      await before.backup(backupPath);
      const backup = new Database(backupPath, { readonly: true, fileMustExist: true });
      try {
        const check = backup.pragma('quick_check') as Array<{ quick_check: string }>;
        if (check.some(row => row.quick_check !== 'ok')) throw new Error(`pre-export backup integrity check failed: ${backupPath}`);
      } finally { backup.close(); }
    } finally { before.close(); }
  }
  const out = new Db(targetPath);
  try {
    const synced = syncSharedBank(master, out);
    const check = out.db.pragma('quick_check') as Array<{ quick_check: string }>;
    if (check.some(row => row.quick_check !== 'ok')) throw new Error(`export integrity check failed: ${targetPath}`);
    return { path: targetPath, ...synced };
  } finally { out.close(); }
}

