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
export function resolvePlaceMissDirFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const explicit = env.LINA_DATA_DIR?.trim();
  if (explicit) return path.resolve(explicit);
  if (env.NODE_TEST_CONTEXT) return path.join(os.tmpdir(), `lina-place-misses-test-${process.pid}`);
  return path.join(process.cwd(), 'data');
}

/** THE ENV IS READ AT WRITE TIME, NOT AT IMPORT TIME — and that is a field
 *  lesson, not tidiness. A probe/sweep script sets `LINA_DATA_DIR` at the top
 *  of its body, but ES module imports are hoisted ABOVE it: the old
 *  `const DEFAULT_DIR = resolvePlaceMissDirFromEnv()` ran first, captured
 *  `<repo>/data`, and the script appended its probe rows to the LIVE field file
 *  (three rows: «MADJAR MAALO SO DVE», «NEPOSTOECHKO MESTO XYZ», «EDNA» — the
 *  first two are rows the writer guard now refuses, so the leak was silent). A
 *  seam whose value depends on import ORDER is not a seam. The override
 *  (`setPlaceMissDir`, the tests' one) still wins — that is explicit intent
 *  rather than an environment that happened to exist. */
let dirOverride: string | undefined;
let dirMemo = '';
const lastWrite = new Map<string, number>();

function currentDir(): string {
  return dirOverride ?? resolvePlaceMissDirFromEnv();
}

/** Test seam — keeps tests out of the repo's real data/ dir. */
export function setPlaceMissDir(d: string): void {
  dirOverride = d;
  dirMemo = '';
  lastWrite.clear();
}

/** Drop the override and fall back to the environment, read live. The seam's
 *  own regression test needs it (the bug was an import-time capture, which an
 *  override would mask), and a sweep script that pinned a dir early can return
 *  to `LINA_DATA_DIR`/cwd without re-importing the module. */
export function clearPlaceMissDirOverride(): void {
  dirOverride = undefined;
  dirMemo = '';
  lastWrite.clear();
}
export function placeMissDir(): string {
  return currentDir();
}
/** The dir a fresh process would have chosen RIGHT NOW — so a test can assert
 *  the DEFAULT (a seam that only proves `setPlaceMissDir` works proves nothing
 *  about where an un-seamed, handler-driven test writes) and a script can print
 *  where it is about to write before it writes. */
export function defaultPlaceMissDir(): string {
  return resolvePlaceMissDirFromEnv();
}

function dayFile(at: number): string {
  return path.join(currentDir(), `place-misses-${new Date(at).toISOString().slice(0, 10)}.jsonl`);
}

const pending: Promise<void>[] = [];

async function write(miss: PlaceMiss): Promise<void> {
  const p = (async () => {
    try {
      const d = currentDir();
      if (dirMemo !== d) {
        await fs.mkdir(d, { recursive: true });
        dirMemo = d;
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

/** Fire-and-forget append with a per-(chat,text) hourly dedupe. Never throws.
 *
 *  THE WRITER REFUSES A ROW THAT NAMES NO PLACE. The place-wish grammar hands
 *  the resolver phrases as well as names («sakam da kupam stan», «edna», «drugi
 *  opcii») and every failed candidate was written down; over the field corpus
 *  that was 82% of the file, so the digest spent its ranking on intent
 *  vocabulary and the real gaps (`црногорска амбасада`) sat beside them. The
 *  rule here is the CONSERVATIVE half of `looksPlaceShaped`: a row is refused
 *  only when EVERY word is request/quantity vocabulary (it names nothing at
 *  all) or the row is a probe. A mixed phrase («MADJAR MAALO SO DVE») is still
 *  written — the place in it is exactly what the digest must look up in the
 *  map (the map's own spelling is «Маџир Маало»), and the report-side triage
 *  already ranks it. Losing a real gap is worse than one noisy row. */
export function recordPlaceMiss(miss: Omit<PlaceMiss, 'text'> & { text: string }): void {
  const text = (miss.text ?? '').trim().slice(0, MAX_TEXT);
  if (!text || text.length < 3) return;
  if (namesNoPlace(text)) return;
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
  const dir = currentDir();
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
  /** Which lane the row belongs to: a name the map does not know, a request
   *  phrase that names nothing, or a probe the sweeps wrote. */
  lane: 'place' | 'intent' | 'probe';
}

/** A PROBE NAME IS NOT A MAP GAP (the field corpus carries `NEPOSTOECHKO MESTO
 *  XYZ` 369 times — the sweep script's own `непостоечко` = "nonexistent"). A
 *  client never names a place by saying it does not exist, so the digest keeps
 *  these in their own lane instead of counting them as unknown places the map
 *  should learn. */
export const PLACE_MISS_PROBE_WORDS: readonly string[] = [
  'nepostoechko', 'непостоечко', 'nepostoechko', 'nonexistent', 'nonexisting',
  'qwerty', 'asdf', 'asdfgh', 'dummy', 'probe', 'xyz',
];
const PROBE = new Set(PLACE_MISS_PROBE_WORDS);

/** True when the row is a probe/synthetic name, not a client's place. */
export function looksLikeProbeName(text: string): boolean {
  return wordsOf(text).some(w => PROBE.has(w));
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
  // THE ANSWER/DISCOURSE FRAME, found by replaying the 2026-11-16 day file: the
  // wish grammar logs the client's filler as a "place" («МОЖЕ» = maybe, «СЛИЧНО»
  // = similar, «ПОЗНАТО» = familiar, «БРОЈОТ» = the number, «ЖИВО» from «живо ме
  // интересира»). Each is a whole-message fragment on its own, and ranking it
  // as a map gap is instrument noise the operator cannot close.
  'mozhe', 'може', 'slicno', 'слично', 'poznato', 'познато', 'broj', 'број',
  'zivo', 'живо', 'vakvo', 'вакво', 'takvo', 'такво', 'veke', 'веќе',
  // A PHRASE IS NOT A NAME, and the same replay showed the wish grammar logging
  // whole ones: a criterion after the area («CENTAR . SPALNI»), a conjunction
  // joining TWO places the map can never bind as one («капитол и бисер»), and
  // pure time/comment talk («pred nekoe vreme» = some time ago, «prekrasen
  // izbor» = lovely choice). None of them is a place the operator could add.
  'i', 'и', 'e', 'е', 'po', 'по', 'nad', 'над', 'pred', 'пред', 'oko', 'око',
  'spalni', 'спални', 'spalna', 'спална', 'spalna', 'kupuvam', 'купувам',
  'seuste', 'сеуште', 'nekoe', 'некое', 'vreme', 'време',
  'prekrasen', 'прекрасен', 'izbor', 'избор', 'imas', 'имаш', 'имас',
  'hmm', 'hmmm', 'interesno', 'интересно', 'okolu', 'околу', 'a', 'а',
  // …and a VENUE-TYPE noun with a definite article is the category, not a name
  // («КАФИЧОТ» = the café they are standing in, «ЌЕБАПОТ», «ПИЦЕРИЈАТА»). A real
  // venue name carries another word, and then this list cannot fire.
  'kafic', 'кафич', 'kebab', 'кебап', 'picerija', 'пицерија', 'pekara', 'пекара',
  // Place-type nouns with a determiner / a proximity word (asking to narrow)
  'naselba', 'населба', 'reon', 'реон', 'blizina', 'близина', 'blixina', 'близу',
];
const INTENT = new Set(PLACE_MISS_INTENT_WORDS);
/** A room-count adjective in ANY inflection («trosoben», «двособниот»): the size
 *  of a flat is a criterion, never a place name. */
const SIZE_SUFFIXES = ['soben', 'soбni', 'sobni', 'ѕобен', 'собен', 'собни', 'ѕобни'];
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
  if (looksLikeProbeName(text)) return false;
  const words = [...raw, ...placeMissKey(text).split(' ').filter(Boolean)];
  return !words.some(isIntentWord);
}

/** Does this text name NOTHING but request/quantity words (or a probe)? The
 *  writer's guard — see `recordPlaceMiss`. Both scripts are checked, exactly as
 *  in `looksPlaceShaped`, so «PRODAZBA» cannot slip through as a place. */
export function namesNoPlace(text: string): boolean {
  if (looksLikeProbeName(text)) return true;
  const words = [...wordsOf(text), ...placeMissKey(text).toLowerCase().split(' ').filter(Boolean)];
  return words.length > 0 && words.every(isIntentWord);
}

/** ONE NAME IS ONE FINDING, even when the corpus recorded it with and without a
 *  refused row: the group key carries the offered name (a different finding for
 *  the report), but the COUNTS answer "how many names does the map not hold?" —
 *  and «ујп» was printed twice, once as a map gap and once as resolving, because
 *  two groups shared the name. Keeps the busiest group per name. */
export function distinctPlaceMissNames<T extends { text: string; turns: number }>(groups: readonly T[]): T[] {
  const best = new Map<string, T>();
  for (const g of groups) {
    const k = placeMissKey(g.text);
    const prev = best.get(k);
    if (!prev || g.turns > prev.turns) best.set(k, g);
  }
  return [...best.values()].sort((a, b) => b.turns - a.turns);
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
    out.push({
      text: best,
      refused: g.refused,
      turns: g.turns,
      lane: looksLikeProbeName(best) ? 'probe' : looksPlaceShaped(best) ? 'place' : 'intent',
    });
  }
  return out.sort((a, b) => b.turns - a.turns);
}
