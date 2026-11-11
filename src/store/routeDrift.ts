// ROUTE DRIFT PERSISTENCE (R3, docs/routing-audit-2026-10-23.md).
//
// The shadow router's [route-drift] findings used to die with the process:
// a 500-entry in-memory ring plus a console line. Every production misroute
// that this month's fixes were re-derived from transcribed captures by hand.
// This module makes each drift pair durable in a day-rotated JSONL so the
// route:health tool can replay it and EMIT corpus rows — the golden-corpus
// pattern fed from production instead of from memory.
//
// Contract: NOTHING HERE CAN THROW OR BLOCK THE CHAT PATH. The drift log is
// strictly a loss-allowed side-effect; SQL/SQLite was deliberately avoided —
// JSONL keeps the read side trivial for the CLI and the write side append-only.

import { promises as fs } from 'fs';
import * as path from 'path';

export interface DriftPair {
  /** Epoch ms of the ACTUAL serve (the drift moment). */
  at: number;
  chatId: string;
  /** The client's message, already truncated to the routeLog slice (80 chars). */
  text: string;
  /** What the ROUTING_ORDER mirror predicted. */
  predicted: string;
  /** What the inline chain actually served. */
  actual: string;
  /** `drift` = the mirror predicted a MIRRORED lane and another one served (a
   *  wrong prediction); `gap` = the served lane has no mirror row yet (the
   *  pending-migration backlog). Older rows predate the field and are drifts. */
  kind?: 'drift' | 'gap';
}

const DEDUPE_TTL_MS = 60 * 60 * 1000; // one row per identical tuple per hour
const DEDUPE_MAX = 500;

let driftDir = path.join(process.cwd(), 'data');
let dirMemo = '';
const lastWrite = new Map<string, number>();

/** Test seam — keeps tests out of the repo's real data/ dir. */
export function setRouteDriftDir(dir: string): void {
  driftDir = dir;
  dirMemo = '';
  lastWrite.clear();
}

export function routeDriftDir(): string {
  return driftDir;
}

function dayFile(at: number): string {
  const day = new Date(at).toISOString().slice(0, 10);
  return path.join(driftDir, `route-drift-${day}.jsonl`);
}

async function write(pair: DriftPair): Promise<void> {
  const p = (async () => {
    try {
      if (dirMemo !== driftDir) {
        await fs.mkdir(driftDir, { recursive: true });
        dirMemo = driftDir;
      }
      await fs.appendFile(dayFile(pair.at), JSON.stringify(pair) + '\n', 'utf8');
    } catch { /* a lost drift row is better than a broken chat turn */ }
  })();
  pending.push(p);
  try { await p; } finally { const i = pending.indexOf(p); if (i !== -1) pending.splice(i, 1); }
}

/** In-flight writes, tracked so a test/replay can flush deterministically.
 *  The chat path never calls this — it stays fire-and-forget. */
const pending: Promise<void>[] = [];
export async function flushRouteDrift(): Promise<void> {
  await Promise.allSettled([...pending]);
}

/** Fire-and-forget append with a per-tuple hourly dedupe. Never throws. */
export function recordRouteDrift(pair: DriftPair): void {
  if (!pair.predicted || !pair.actual || !pair.text) return;
  const tuple = `${pair.chatId}|${pair.predicted}|${pair.actual}|${pair.text}`;
  const at = lastWrite.get(tuple);
  if (at !== undefined && pair.at - at < DEDUPE_TTL_MS) return;
  if (lastWrite.size > DEDUPE_MAX) lastWrite.clear(); // crude but loss-allowed
  lastWrite.set(tuple, pair.at);
  void write(pair);
}

/** Read every drift file under the drift dir, newest first, days-limited. */
export async function readRouteDrift(opts: { days?: number } = {}): Promise<DriftPair[]> {
  let files: string[];
  try {
    files = (await fs.readdir(driftDir))
      .filter(n => n.startsWith('route-drift-') && n.endsWith('.jsonl'))
      .sort()
      .reverse(); // newest day first
  } catch {
    return [];
  }
  const cutoff = opts.days && opts.days > 0 ? Date.now() - opts.days * 86_400_000 : undefined;
  const out: DriftPair[] = [];
  for (const f of files) {
    try {
      const raw = await fs.readFile(path.join(driftDir, f), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as DriftPair;
          if (cutoff === undefined || (typeof parsed.at === 'number' && parsed.at >= cutoff)) out.push(parsed);
        } catch { /* a torn line (crash mid-append) must not kill the read */ }
      }
    } catch { /* unreadable day file — skip */ }
  }
  return out;
}
