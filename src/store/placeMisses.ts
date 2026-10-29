// PLACE-MISS TELEMETRY.
//
// Three place-binding bugs in a row ([18:34] CITY MALL, [18:47] ДРЖАВНА
// БОЛНИЦА, [20:49] CITY MOL) were all found the same way: a client hit them and
// somebody transcribed the transcript. The name-variant fold (soundKey in the
// geo engine) now covers spelling, the map-wide sweep test covers what we
// already know — this module covers what we do NOT know yet: every place the
// extractor heard and the map could not place is written down, so the next gap
// shows up as a weekly list of words instead of a lost client.
//
// Contract, copied from routeDrift.ts on purpose:
//   • append-only JSONL, day-rotated, one row per (chat, text) per hour;
//   • NOTHING HERE CAN THROW OR BLOCK THE CHAT PATH — a lost row is fine;
//   • the read side is a plain file scan, so a cron job can group the words
//     without touching SQLite.
//
// Read it with: npx tsx scripts/place-misses.ts [--days N]

import { promises as fs } from 'fs';
import * as path from 'path';

export interface PlaceMiss {
  /** Epoch ms of the failed resolution. */
  at: number;
  chatId: string;
  /** What the extractor heard (the place-wish), truncated. */
  text: string;
  /** What the map lookup returned, when it returned something the guard refused. */
  refused?: string;
}

const DEDUPE_TTL_MS = 60 * 60 * 1000;
const DEDUPE_MAX = 500;
const MAX_TEXT = 120;

let dir = path.join(process.cwd(), 'data');
let dirMemo = '';
const lastWrite = new Map<string, number>();

/** Test seam — keeps tests out of the repo's real data/ dir. */
export function setPlaceMissDir(d: string): void {
  dir = d;
  dirMemo = '';
  lastWrite.clear();
}
export function placeMissDir(): string {
  return dir;
}

function dayFile(at: number): string {
  return path.join(dir, `place-misses-${new Date(at).toISOString().slice(0, 10)}.jsonl`);
}

const pending: Promise<void>[] = [];

async function write(miss: PlaceMiss): Promise<void> {
  const p = (async () => {
    try {
      if (dirMemo !== dir) {
        await fs.mkdir(dir, { recursive: true });
        dirMemo = dir;
      }
      await fs.appendFile(dayFile(miss.at), JSON.stringify(miss) + '\n', 'utf8');
    } catch { /* a lost telemetry row is better than a broken chat turn */ }
  })();
  pending.push(p);
  try { await p; } finally { const i = pending.indexOf(p); if (i !== -1) pending.splice(i, 1); }
}

/** In-flight writes, so a test can flush deterministically. */
export async function flushPlaceMisses(): Promise<void> {
  await Promise.allSettled([...pending]);
}

/** Fire-and-forget append with a per-(chat,text) hourly dedupe. Never throws. */
export function recordPlaceMiss(miss: Omit<PlaceMiss, 'text'> & { text: string }): void {
  const text = (miss.text ?? '').trim().slice(0, MAX_TEXT);
  if (!text || text.length < 3) return;
  const tuple = `${miss.chatId}|${text}`;
  const at = lastWrite.get(tuple);
  if (at !== undefined && miss.at - at < DEDUPE_TTL_MS) return;
  if (lastWrite.size > DEDUPE_MAX) lastWrite.clear();
  lastWrite.set(tuple, miss.at);
  void write({ ...miss, text });
}

/** Every miss in the last `days` days (default: all). Newest first. */
export async function readPlaceMisses(opts: { days?: number } = {}): Promise<PlaceMiss[]> {
  let files: string[];
  try {
    files = (await fs.readdir(dir))
      .filter(n => n.startsWith('place-misses-') && n.endsWith('.jsonl'))
      .sort()
      .reverse();
  } catch {
    return [];
  }
  const cutoff = opts.days && opts.days > 0 ? Date.now() - opts.days * 86_400_000 : undefined;
  const out: PlaceMiss[] = [];
  for (const f of files) {
    try {
      const raw = await fs.readFile(path.join(dir, f), 'utf8');
      for (const line of raw.split('\n')) {
        if (!line.trim()) continue;
        try {
          const parsed = JSON.parse(line) as PlaceMiss;
          if (cutoff === undefined || (typeof parsed.at === 'number' && parsed.at >= cutoff)) out.push(parsed);
        } catch { /* torn line from a crash — skip */ }
      }
    } catch { /* unreadable day file — skip */ }
  }
  return out.sort((a, b) => b.at - a.at);
}
