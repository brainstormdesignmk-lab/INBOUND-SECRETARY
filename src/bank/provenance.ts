/**
 * THE QUESTION LOG IS NOT ALWAYS IN THE DB YOU OPENED.
 *
 * Legacy deployments may keep the review bank and chat log in different files.
 * ACTIVE rows for detector-owned keys (vague.time, price.ask, …) can then show
 * `(нема клиентско прашање)` even though the questions exist in a sibling DB.
 * Asking the operator to open another DB defeats the screen's purpose.
 *
 * So: when the open DB has no turn for the key, look in the OTHER `*.db` files
 * in the same directory, READ-ONLY, newest first, and use the first log that
 * remembers that key. Nothing is ever written and no WAL is created; a locked
 * or corrupt sibling is skipped, not fatal.
 *
 * Results are cached briefly (the TUI repaints every 2 s and lists hundreds of
 * rows) — 30 s is long enough to avoid hammering the files, short enough that a
 * fresh turn shows up while the operator is looking.
 */

import Database from 'better-sqlite3';
import * as fs from 'fs';
import * as path from 'path';

export interface SiblingQuestions {
  /** The sibling file the questions came from (basename only, for the UI). */
  db: string;
  questions: string[];
}

const TTL_MS = 30_000;
const cache = new Map<string, { at: number; hit: SiblingQuestions | null }>();

/** Candidate files: same directory, `*.db`, excluding the open one. SQLite
 *  sidecars (-wal/-shm) are not candidates; journals are not either. */
function candidates(dbFile: string): string[] {
  const dir = path.dirname(dbFile);
  const self = path.resolve(dbFile);
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter(n => n.endsWith('.db'))
    .map(n => path.resolve(dir, n))
    .filter(f => f !== self)
    .map(f => ({ f, m: fs.statSync(f).mtimeMs }))
    .sort((a, b) => b.m - a.m)
    .map(x => x.f);
}

/** Questions that reached `key`, from the first sibling log that has them. */
export function siblingQuestions(dbFile: string, key: string, limit = 3): SiblingQuestions | null {
  if (!key) return null;
  // ':memory:' and other non-file handles have no siblings to search.
  if (!dbFile || dbFile === ':memory:' || !path.isAbsolute(path.resolve(dbFile))) return null;
  const cacheKey = `${path.resolve(dbFile)}\u0000${key}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.hit;

  const questions: string[] = [];
  let from: string | null = null;
  for (const f of candidates(dbFile)) {
    let d: Database.Database | null = null;
    try {
      d = new Database(f, { readonly: true, fileMustExist: true });
      const table = d.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='enrichment_queue'").get();
      if (!table) continue;
      const rows = d.prepare(
        `SELECT user_msg AS msg FROM enrichment_queue
         WHERE bank_key = ? AND user_msg IS NOT NULL AND user_msg <> ''
         ORDER BY id DESC LIMIT ?`,
      ).all(key, limit) as Array<{ msg: string }>;
      if (rows.length) {
        questions.push(...rows.map(r => r.msg));
        from = path.basename(f);
        break;
      }
    } catch {
      // locked / corrupt / not a DB — the next candidate may still help
    } finally {
      try { d?.close(); } catch { /* already closed */ }
    }
  }

  const out = from ? { db: from, questions } : null;
  cache.set(cacheKey, { at: Date.now(), hit: out });
  return out;
}

/** Test/ops hook: forget the cached lookups (e.g. after importing a batch). */
export function clearProvenanceCache(): void {
  cache.clear();
}
