// PLACE-MISS TELEMETRY — the record is what turns the NEXT unknown name into a
// weekly line instead of a lost client. Contract: append-only, day-rotated,
// deduped per hour, never throws.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  recordPlaceMiss, readPlaceMisses, flushPlaceMisses, setPlaceMissDir,
  groupPlaceMisses, looksPlaceShaped, looksLikeProbeName, namesNoPlace, placeMissKey,
} from '../src/store/placeMisses';

test('a miss is recorded once per hour and read back in order', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'place-misses-'));
  setPlaceMissDir(dir);
  const at = Date.now();
  recordPlaceMiss({ at, chatId: 'c1', text: 'цитy мол апартман' });
  recordPlaceMiss({ at: at + 1000, chatId: 'c1', text: 'цитy мол апартман' }); // same hour → deduped
  recordPlaceMiss({ at: at + 2000, chatId: 'c2', text: 'некоја непозната населба', refused: 'Некое地方' });
  await flushPlaceMisses();

  const rows = await readPlaceMisses();
  assert.equal(rows.length, 2, `dedupe must keep one row per hour, got ${rows.length}`);
  const texts = rows.map(r => r.text).sort();
  assert.deepEqual(texts, ['некоја непозната населба', 'цитy мол апартман'].sort());
  // The refused row is preserved: "the map HAS a row and the guard discarded it"
  // is a different finding from "no such place".
  assert.equal(rows.find(r => r.text.startsWith('некоја'))?.refused, 'Некое地方');
  // Day-rotated file naming, so the weekly report can walk days.
  const files = fs.readdirSync(dir).filter(n => n.startsWith('place-misses-'));
  assert.equal(files.length, 1);
  assert.match(files[0], /^place-misses-\d{4}-\d{2}-\d{2}\.jsonl$/);
});

// ── THE WEEKLY DIGEST (route:gap-audit + scripts/place-misses.ts) ────────────
// The corpus is 20k+ rows whose top is one name typed a dozen ways plus every
// intent phrase the wish grammar produced. These pin the two rules the digest
// lives on: ONE gap is one row whatever the script/case/punctuation, and an
// intent phrase is noise rather than a map gap.

test('one gap is one row: case, script and punctuation fold; the label is the corpus spelling', () => {
  const rows = [
    ...Array(6).fill({ text: 'Црногорска амбасада' }),
    ...Array(3).fill({ text: 'CRNOGORSKA AMBASADA' }),
    ...Array(2).fill({ text: 'crnogorska ambasada.' }),
    { text: 'Карпош 1', refused: 'Карпош' },
  ];
  const groups = groupPlaceMisses(rows);
  assert.equal(groups.length, 2, `expected one group per place, got ${groups.map(g => g.text).join(' | ')}`);
  assert.equal(groups[0].turns, 11, 'every spelling must count into the same gap');
  assert.equal(groups[0].text, 'Црногорска амбасада', 'the busiest spelling labels the group');
  assert.equal(groups[1].refused, 'Карпош', 'the offered name survives the fold');
  // Two rows that name DIFFERENT places must never merge, whatever the fold does.
  assert.equal(groups[1].turns, 1);
  assert.equal(placeMissKey('ЦРНОГОРСКА  АМБАСАДА .'), placeMissKey('crnogorska ambasada'));
});

test('an intent phrase is not a map gap, and a real name is never mistaken for one', () => {
  const noise = [
    'sakam da kupam stan',        // the request frame
    'SAKAM DA IZNAJMAM STAN',
    'dve sobi',                   // the property frame
    'nebitno',                    // the release answer
    'KOLKU MU E KIRIJATA',        // a question about a place, not a name
    'kade ima reptil tamu',
    'BILO KOJA',
    'GARSONJERATA KAJ',           // an INFLECTED type noun
    'TROSOBEN MISLAM DEKA BESE',  // a size adjective in another inflection
    'PRODAZBA',                   // Latin key, after the script fold
    'ВАШАТА СТРАНИЦА',
    'DAJ NESTO POSKAPO',
  ];
  for (const t of noise) assert.equal(looksPlaceShaped(t), false, `«${t}» must not be ranked as a map gap`);
  const shaped = [
    'црногорска амбасада', 'скопје север', 'KARPOS', 'зулуфтар', 'дебаб маало',
    'броз кафе. бесе около', 'сјо', 'butel',
  ];
  for (const t of shaped) assert.equal(looksPlaceShaped(t), true, `«${t}» is a name the map must learn`);
  // Digits are identity, never a place name (the map's own soundKey rule).
  assert.equal(looksPlaceShaped('Бит Пазар 1'), false);
});

// ── THE WRITER REFUSES WHAT NAMES NOTHING ──────────────────────────────────
// The report side can label intent rows, but the file still grew by ~18k of
// them. The recorder is where the noise is created, so the rule lives there
// too — and it is the CONSERVATIVE half: a row is dropped only when EVERY word
// is request/quantity vocabulary (or the row is a probe). A mixed phrase keeps
// its place word, which is exactly what the digest must look up in the map.

test('the recorder drops a row that names nothing at all', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'place-misses-'));
  setPlaceMissDir(dir);
  const at = Date.now();
  // Pure request/quantity phrases — the wish grammar's own tails.
  recordPlaceMiss({ at, chatId: 'c1', text: 'EDNA' });
  recordPlaceMiss({ at: at + 1, chatId: 'c1', text: 'SAKAM DA KUPAM STAN' });
  recordPlaceMiss({ at: at + 2, chatId: 'c1', text: 'ZA KUPUVANJE SUM' });
  recordPlaceMiss({ at: at + 3, chatId: 'c1', text: 'DRUGI OPCII' });
  recordPlaceMiss({ at: at + 4, chatId: 'c1', text: 'NEBITNO' });
  recordPlaceMiss({ at: at + 5, chatId: 'c1', text: 'DVE SOBI' });
  // Probes the sweeps write on purpose.
  recordPlaceMiss({ at: at + 6, chatId: 'c1', text: 'NEPOSTOECHKO MESTO XYZ' });
  recordPlaceMiss({ at: at + 7, chatId: 'c1', text: 'NEPOSTOECHKO' });
  // …and one real gap, which must survive.
  recordPlaceMiss({ at: at + 8, chatId: 'c1', text: 'црногорска амбасада' });
  // A MIXED phrase is a gap (the place word is in it: the map spells it
  // «Маџир Маало», so the client's «маџар маало» is a real alias to learn).
  recordPlaceMiss({ at: at + 9, chatId: 'c1', text: 'MADJAR MAALO SO DVE' });
  await flushPlaceMisses();

  const texts = (await readPlaceMisses()).map(r => r.text).sort();
  assert.deepEqual(texts, ['MADJAR MAALO SO DVE', 'црногорска амбасада'].sort(),
    `only rows that name something may be written, got ${texts.join(' | ')}`);
  // The predicates the recorder uses, pinned directly.
  assert.equal(namesNoPlace('EDNA'), true);
  assert.equal(namesNoPlace('SAKAM DA KUPAM STAN'), true);
  assert.equal(namesNoPlace('ПРОВИЗИЈАТА НЕ ЈА ПРИФАЌАМ'), false, 'a sentence with real words is not "nothing"');
  assert.equal(namesNoPlace('црногорска амбасада'), false);
  assert.equal(looksLikeProbeName('NEPOSTOECHKO MESTO XYZ'), true);
  assert.equal(looksLikeProbeName('Црногорска амбасада'), false);
});

test('the digest files a probe row in its own lane, never as a map gap', () => {
  const groups = groupPlaceMisses([
    ...Array(62).fill({ text: 'NEPOSTOECHKO MESTO XYZ' }),
    ...Array(5).fill({ text: 'црногорска амбасада' }),
    ...Array(8).fill({ text: 'EDNA' }),
  ]);
  const lane = (t: string) => groups.find(g => g.text === t)?.lane;
  assert.equal(lane('NEPOSTOECHKO MESTO XYZ'), 'probe', 'a name that means "nonexistent" is not a map gap');
  assert.equal(lane('црногорска амбасада'), 'place');
  assert.equal(lane('EDNA'), 'intent');
  assert.equal(looksPlaceShaped('NEPOSTOECHKO MESTO XYZ'), false,
    'the shape rule must keep the probe out of the map-gap list too');
});
