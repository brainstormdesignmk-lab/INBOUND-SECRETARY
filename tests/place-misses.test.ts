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
  groupPlaceMisses, looksPlaceShaped, placeMissKey,
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
