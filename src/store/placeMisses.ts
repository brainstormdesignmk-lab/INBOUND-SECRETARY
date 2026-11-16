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
import * as os from 'os';
import * as path from 'path';
import { toCyrillic } from '../geo/offlineMap';

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

/** THE SAME RULE AS `routeDrift.ts`: the day files are EVIDENCE, and a test run
 *  must not append to them. `node:test` marks its workers with
 *  `NODE_TEST_CONTEXT`, so a worker defaults to a per-process temp dir; the app
 *  (and the offline sweeps, which are supposed to write here) keep `data/`, and
 *  `LINA_DATA_DIR` overrides both for a harness that drives the shipped entry
 *  point. */
const DEFAULT_DIR = resolvePlaceMissDirFromEnv();
let dir = DEFAULT_DIR;

export function resolvePlaceMissDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.LINA_DATA_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  if (env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), `lina-place-misses-test-${process.pid}`);
  return path.join(process.cwd(), 'data');
}
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
/** The dir a fresh process would have chosen — so a test can assert the DEFAULT
 *  (a seam that only proves `setPlaceMissDir` works proves nothing about where
 *  an un-seamed handler-driven test writes). */
export function defaultPlaceMissDir(): string {
  return DEFAULT_DIR;
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

// ── THE WEEKLY DIGEST ───────────────────────────────────────────────────────
// The rows are useless one by one: the field corpus is 22k rows / ~300 distinct,
// and the top of it is `црногорска амбасада` typed a thousand ways plus every
// intent phrase the wish grammar produced. Grouping and triage live HERE rather
// than in the audit script so the operator CLI, the audit and the tests all read
// the corpus the same way (a second copy of the fold is how two reports start
// disagreeing).

export interface PlaceMissGroup {
  /** The spelling the corpus used most in this group — the clients' own words. */
  text: string;
  /** What the map OFFERED and the guard turned down (see `PlaceMiss.refused`). */
  refused?: string;
  turns: number;
}

/** IS THIS ROW A PLACE THE MAP COULD NOT PLACE, OR AN INTENT PHRASE?
 *
 *  The recorder logs every candidate the place-wish extractor produced, and that
 *  grammar yields phrases as well as names («sakam da kupam stan», «dve sobi»,
 *  «nebitno»). Over the field corpus that is ~82% of the rows, and a digest that
 *  ranks them together calls intent vocabulary a map gap. This is a REPORT-SIDE
 *  triage only — a lane must never read it: the shape rule is "no intent or
 *  question vocabulary, at most four words, no digits", which is the vocabulary
 *  of a request rather than of a name. Real misses («црногорска амбасада»,
 *  «зулуфтар», «дебаб маало») pass it; the map gaps stay above the noise.
 *
 *  Both scripts are in the set on purpose: matching only the Cyrillic fold made
 *  every Latin key dead («PRODAZBA» read as a place name). */
export const PLACE_MISS_INTENT_WORDS: readonly string[] = [
  // THE REQUEST FRAME
  'sakam', 'сакам', 'sakame', 'treba', 'треба', 'baram', 'барам', 'barame', 'iznajmam',
  'изнајмам', 'iznajmuvanje', 'изнајмување', 'kupam', 'купам', 'kupuvanje', 'купување',
  'prodazba', 'продажба', 'prodavam', 'продавам', 'opcii', 'опции', 'opcija', 'опција',
  'ponuda', 'понуда', 'imate', 'имате', 'dali', 'дали', 'nebitno', 'небитно', 'dobro',
  'добро', 'daj', 'дај', 'pokazi', 'покажи', 'pokazhi', 'nesto', 'нешто', 'uste', 'уште',
  'mislam', 'мислам', 'deka', 'дека', 'bese', 'беше', 'kontaktiraj', 'контактирај',
  'me', 'ме', 'tamu', 'таму', 'ova', 'ова', 'ovaa', 'оваа', 'ovoj', 'овој', 'toj', 'тој',
  'taa', 'таа', 'normalno', 'нормално', 'novo', 'ново', 'nov', 'нов',
  // THE PROPERTY / TERMS FRAME
  'edna', 'една', 'eden', 'еден', 'edno', 'едно', 'dve', 'две', 'dva', 'два', 'tri', 'три',
  'sobi', 'соби', 'soba', 'соба', 'stan', 'стан', 'stn', 'kukja', 'куќа', 'kukji', 'куќи',
  'dvosoben', 'двособен', 'garsonjera', 'гарсоњера', 'potkrovje', 'поткровје',
  'potkrovlje', 'поткровље', 'sum', 'сум', 'sme', 'ne', 'не', 'go', 'го', 'ja', 'ја',
  'mi', 'ми', 'za', 'за', 'vo', 'во', 'na', 'на', 'so', 'со', 'od', 'од', 'do', 'до',
  'ili', 'или',
  'cena', 'цена', 'ceni', 'цени', 'kiri', 'кири', 'kirija', 'кирија', 'kirijata',
  'renta', 'рента', 'kvadrati', 'квадрати', 'kvadrat', 'квадрат', 'triesetina',
  // THE QUESTION FRAME
  'sto', 'што', 'koj', 'кој', 'koja', 'која', 'koi', 'кои', 'kade', 'каде', 'kako', 'како',
  'koga', 'кога', 'kolku', 'колку', 'zosto', 'зошто', 'se', 'се', 'naogja', 'наоѓа',
  'ima', 'има', 'li', 'ли', 'da', 'да',
  // COMPARATIVES / QUANTIFIERS / OTHER
  'poskapo', 'поскапо', 'poeftino', 'поефтино', 'pomalo', 'помало', 'poveke', 'повеќе',
  'najevtini', 'најевтини', 'eftino', 'евтино', 'bilo', 'било', 'drugo', 'друго',
  'drugi', 'други',
  // THE NAV / SITE FRAME (the client is reading our page, not naming a place)
  'sajt', 'сајт', 'stranica', 'страница', 'vashata', 'вашата', 'vas', 'вас',
  // Place-type nouns with a determiner / a proximity word (asking to narrow)
  'naselba', 'населба', 'reon', 'реон', 'blizina', 'близина', 'blixina', 'близу',
];
const INTENT = new Set(PLACE_MISS_INTENT_WORDS);
/** A room-count adjective in ANY inflection («trosoben», «двособниот»): the size
 *  of a flat is a criterion, never a place name. */
const SIZE_SUFFIXES = ['soben', 'ѕобен', 'собен'];
function isIntentWord(w: string): boolean {
  if (INTENT.has(w)) return true;
  if (SIZE_SUFFIXES.some(s => w.endsWith(s))) return true;
  // An INFLECTED key («garsonjerata», «stanot», «cenata») — exact matching alone
  // let «GARSONJERATA KAJ» through as a place name. Keys shorter than four
  // letters (`go`, `ne`, `li`) are exact-only: a prefix rule on those would eat
  // real names.
  return PLACE_MISS_INTENT_WORDS.some(k => k.length >= 4 && w.length > k.length && w.length - k.length <= 4 && w.startsWith(k));
}
function wordsOf(text: string): string[] {
  return text.toLowerCase().replace(/[.,;:!?"“”„'’()]/gu, ' ').split(/\s+/u).filter(Boolean);
}

/** Case, SCRIPT, punctuation and spacing never make two rows: `<NAME>`, the
 *  Latin spelling and a trailing period are one gap, and script folds with the
 *  map's own transliterator so the digest cannot disagree with the resolver. */
export function placeMissKey(text: string): string {
  return toCyrillic(text).replace(/[.,;:!?"“”„'’()]/gu, ' ').replace(/\s+/gu, ' ').trim();
}

/** SPELLING IS NOT FOLDED HERE, on purpose: `soundKey` absorbs a misspelling at
 *  RESOLUTION time, so a miss that repeats verbatim is a missing POI, not a
 *  spelling problem, and merging near-spellings would hide which name to add.
 *  The bare adjective («CRNOGORSKA», no noun) stays its own row — it asks a
 *  different question (fold the word alone?) than the full name. */
export function looksPlaceShaped(text: string): boolean {
  const raw = wordsOf(text);
  if (raw.length === 0 || raw.length > 4) return false;
  if (/\d/u.test(text)) return false;
  const words = [...raw, ...placeMissKey(text).split(' ').filter(Boolean)];
  return !words.some(isIntentWord);
}

/** Grouped by (folded text, folded offered name), labelled with the most common
 *  spelling, busiest first. */
export function groupPlaceMisses(misses: readonly Pick<PlaceMiss, 'text' | 'refused'>[]): PlaceMissGroup[] {
  const groups = new Map<string, { refused?: string; turns: number; spell: Map<string, number> }>();
  for (const m of misses) {
    const key = `${placeMissKey(m.text)}|${placeMissKey(m.refused ?? '')}`;
    let g = groups.get(key);
    if (!g) {
      g = { refused: m.refused, turns: 0, spell: new Map() };
      groups.set(key, g);
    }
    g.turns += 1;
    g.spell.set(m.text, (g.spell.get(m.text) ?? 0) + 1);
  }
  const out: PlaceMissGroup[] = [];
  for (const g of groups.values()) {
    let best = '', bestN = -1;
    for (const [s, n] of g.spell) if (n > bestN) { best = s; bestN = n; }
    out.push({ text: best, refused: g.refused, turns: g.turns });
  }
  return out.sort((a, b) => b.turns - a.turns);
}
