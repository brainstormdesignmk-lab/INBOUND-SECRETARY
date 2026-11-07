/**
 * THE GENERATOR MUST NOT EAT THE BANK FILE'S OWN NOTES.
 *
 * `src/data/responses.ts` is generated, and its writer re-serialises the WHOLE
 * file from parsed data. That is safe for variants (they are data) but it was
 * silently destructive for the `//` blocks above them — and several owner rules
 * are documented ONLY there:
 *
 *   - the stock-at-a-place ask ([17:30]) and its no-stock-claim rule ([20:38]);
 *   - the owner-approved one-sentence line (2026-10-21);
 *   - the GONE relay ending with the offer ([12:08]);
 *   - EVERY FIGURE CARRIES ITS UNIT (the [19:12] «за кирија од 350» capture);
 *   - the note above RESPONSE_GENERATION_CONTEXT (provenance, not questions).
 *
 * A targeted `--only=rent.math.check,…` run erased four of those blocks even
 * though it was not supposed to touch those keys at all. The contract pinned
 * here:
 *
 *   1. ROUND TRIP: rendering the shipped file from its own parse + comments
 *      reproduces it BYTE FOR BYTE. A no-op regeneration therefore writes the
 *      file back unchanged — that is what makes a targeted run safe.
 *   2. CARRY: when a key IS regenerated (its variants replaced), its own
 *      comment block and every other key's block survive, and no unrelated key
 *      changes.
 *
 * The helpers live in the generator script itself (exported, with `main()`
 * guarded by `require.main === module`) so the real writer is what is tested —
 * a copy of the serialiser here would drift from the one that ships.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  parseExistingBank, extractKeyComments, extractContextHeaderComments, renderBankFile,
} from '../src/scripts/generateResponses';

/** The REAL bank source lives in the repo root, which is NOT this file's
 *  parent when the compiled harness runs the suite: `dist-test/tests` resolves
 *  `..` to `dist-test/`, where no `src/` exists — so this test failed under
 *  `npm run test:c` while passing under `npm test`, and the compiled run
 *  reported it as a product failure. Every other source-reading test
 *  (route-coverage, bank-code-source, bank-fleet, bank-dynamic-tui,
 *  place-lookup-cache) already walks up to the package.json; this one had been
 *  left behind. */
function findProjectRoot(from: string): string {
  let dir = from;
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'src'))) return dir;
    const parent = path.resolve(dir, '..');
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`cannot find project root from ${from}`);
}

const ROOT = findProjectRoot(__dirname);
const BANK = path.join(ROOT, 'src', 'data', 'responses.ts');
const src = fs.readFileSync(BANK, 'utf8');

/** The context map as the file holds it (the generator writes it one key per
 *  line, so this reader is the same shape it emits). */
function contextFrom(text: string): Record<string, { reference: string[]; instruction: string }> {
  const out: Record<string, { reference: string[]; instruction: string }> = {};
  let inCtx = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('export const RESPONSE_GENERATION_CONTEXT')) { inCtx = true; continue; }
    if (!inCtx) continue;
    const m = /^ {2}"(.+)": (\{.*\}),$/.exec(line);
    if (m) out[m[1]] = JSON.parse(m[2]);
  }
  return out;
}

/** Every documented rule note, by the key it belongs to. */
const NOTE_KEYS = [
  'place.stock.ask', //    THE STOCK-AT-A-PLACE ASK + NO STOCK CLAIM
  'session.resume', //     Owner-approved line (2026-10-21)
  'rent.math.check', //    EVERY FIGURE CARRIES ITS UNIT
  'owner.relay:gone', //   The GONE relay must END WITH THE OFFER
];

test('the bank file round-trips through its own writer BYTE FOR BYTE', () => {
  const bank = parseExistingBank(src);
  const comments = extractKeyComments(src);
  const header = extractContextHeaderComments(src);
  assert.ok(Object.keys(bank).length > 100, 'the shipped bank parsed');
  const rendered = renderBankFile(bank, contextFrom(src), comments, header);
  assert.equal(rendered, src, 'a regeneration that changes nothing must write the file back unchanged');
});

test('every key note and the context note are carried by the writer', () => {
  const comments = extractKeyComments(src);
  for (const key of NOTE_KEYS) {
    assert.ok(comments[key]?.length, `the note above "${key}" is not a carried comment block anymore`);
  }
  assert.ok(extractContextHeaderComments(src).length > 0,
    'the note above RESPONSE_GENERATION_CONTEXT disappeared');
  // The four documented owner rules must still be IN the file, wherever the
  // writer put them (grep-level, so a re-wrapped note still counts).
  for (const marker of ['STOCK-AT-A-PLACE', 'GONE relay', 'EVERY FIGURE CARRIES', 'Generator context is not']) {
    assert.ok(src.includes(marker), `note lost from src/data/responses.ts: ${marker}`);
  }
});

test('a targeted regeneration replaces ONLY its key and never drops a note', () => {
  const bank = parseExistingBank(src);
  const comments = extractKeyComments(src);
  const header = extractContextHeaderComments(src);
  const ctx = contextFrom(src);

  const NEW = [
    'За месечна кирија од {r} евра, нашата провизија е {c} евра.',
    'За сопственикот се издвојуваат {d} евра, вкупно {t} евра.',
  ];
  const before = bank['rent.math.check'];
  assert.ok(before?.length, 'the regenerated key exists in the shipped bank');
  const merged = { ...bank, 'rent.math.check': NEW };
  const rendered = renderBankFile(merged, ctx, comments, header);

  // 1. the regenerated key carries the new variants …
  assert.deepEqual(parseExistingBank(rendered)['rent.math.check'], NEW);
  // 2. … its own note survives …
  assert.ok(rendered.includes('EVERY FIGURE CARRIES ITS UNIT'),
    'the note on the regenerated key was erased');
  // 3. … and the keys the run did not touch are untouched, notes included.
  const after = parseExistingBank(rendered);
  for (const [key, variants] of Object.entries(bank)) {
    if (key === 'rent.math.check') continue;
    assert.deepEqual(after[key], variants, `a key the run did not regenerate changed: ${key}`);
  }
  for (const key of NOTE_KEYS) {
    if (key === 'rent.math.check') continue;
    for (const line of comments[key] ?? []) {
      assert.ok(rendered.includes(line), `a foreign key's note was erased: ${key}`);
    }
  }
});
