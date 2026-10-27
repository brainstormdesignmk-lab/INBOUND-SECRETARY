// CAPTURE FIXTURES — every reported bug keeps a replayable transcript.
//
// tests/fixtures/transcripts/*.txt are real captures: one client line per turn,
// directives that seed the state the capture had (!eb / !arranged / !owner /
// !state / !rewind), and `# EXPECT` lines that state the verdict the fix
// promises. This test replays each one OFFLINE through the real pipeline and
// checks those verdicts, so "the owner was told EB 47 while the house is 62"
// can never come back without failing here.
//
// Live feed rows are irrelevant to these lanes (the assertions are about which
// visit is acted on, not about property cards), so the replay runs feedless and
// stays hermetic and fast. `npx tsx scripts/transcript-replay.ts <file>` prints
// the same transcript with every message, against the live feed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'fs';
import * as path from 'path';
import { checkExpectations, parseExpectations, parseTranscript, runTranscript } from '../scripts/transcriptReplay';

const DIR = path.join(__dirname, 'fixtures', 'transcripts');
const files = readdirSync(DIR).filter(f => f.endsWith('.txt')).sort();

test('capture fixtures: the directory is populated', () => {
  assert.ok(files.length >= 5, `fixtures found: ${files.join(', ')}`);
});

for (const file of files) {
  test(`capture fixture: ${file}`, async () => {
    const text = readFileSync(path.join(DIR, file), 'utf8');
    const expectations = parseExpectations(text);
    assert.ok(expectations.length > 0, `${file} carries no «# EXPECT» line — an unchecked fixture is a story, not a test`);
    const result = await runTranscript(parseTranscript(text), { now: new Date(2026, 9, 23, 21, 50) });
    const failures = checkExpectations(result, expectations);
    assert.deepEqual(failures, [], failures.join('; '));
  });
}

test('capture fixtures: no turn sends more than one client message unless it is a known relay', async () => {
  // `reply` is sent ONCE per turn; a lane that writes it and falls through can
  // hand the client a message the operator log never mentions — or two messages
  // for one turn. These captures are all single-message turns (no price relay,
  // no owner verdict), so any second message is a lane that stopped returning.
  for (const file of files) {
    const text = readFileSync(path.join(DIR, file), 'utf8');
    const result = await runTranscript(parseTranscript(text), { now: new Date(2026, 9, 23, 21, 50) });
    for (const turn of result.turns) {
      assert.ok(turn.clientMsgs.length <= 1,
        `${file}: ${turn.clientMsgs.length} client messages on «${turn.text}»: ${turn.clientMsgs.join(' || ')}`);
      assert.ok(turn.ownerMsgs.length <= 1,
        `${file}: ${turn.ownerMsgs.length} owner messages on «${turn.text}»`);
    }
  }
});

test('capture fixture: a cancelled visit stops the visit-day protocol for that appointment', async () => {
  // The strongest form of the [21:57] rule, end to end: once the client cancels,
  // the scheduler's later turns must not fire — no ДОГОВОРЕНА ПОСЕТА / ЛОКАЦИЈА
  // for a visit that no longer exists.
  const text = readFileSync(path.join(DIR, '2157-cancel-wrong-eb.txt'), 'utf8');
  const result = await runTranscript(parseTranscript(text), { now: new Date(2026, 9, 23, 21, 50) });
  const after = result.turns.slice(result.turns.findIndex(t => t.operatorLogs.some(l => /CANCELLED by/.test(l))) + 1);
  for (const turn of after) {
    assert.ok(!turn.clientMsgs.some(m => /ДОГОВОРЕНА ПОСЕТА|ЛОКАЦИЈА/.test(m)),
      `nothing after the cancellation: ${turn.clientMsgs.join(' | ')}`);
  }
});
