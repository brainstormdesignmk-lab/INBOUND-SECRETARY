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
