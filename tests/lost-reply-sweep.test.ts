// LOST-REPLY SWEEP — the static half of "no client message is ever dropped".
//
// `reply` is one variable sent once at the end of the turn, so a lane that
// assigns it and falls through can be overwritten by a later lane. That is the
// shape the [21:57] cancel branch had. scripts/lost-reply-sweep.ts reports the
// pairs a human should read (`npm run reply:sweep`, `--lane <n>` for a block);
// these tests pin the sweep itself:
//
//   1. it CATCHES the known-bad shape (a tool nobody checks is a tool nobody
//      can trust),
//   2. it does not cry wolf on a lane that ends the turn or on one ladder's
//      exclusive branches,
//   3. the candidate list is a ratchet, so a new fall-through writer cannot
//      slip in unnoticed.
//
// Scope, stated plainly: the sweep reads `reply =` assignments in inbound.ts.
// Lanes that SEND directly (`sendRaw` + return) are outside it by design —
// their guarantee is dynamic, asserted where their message counts are known:
// the cancelling turn (tests/visits.test.ts), both queuing turns
// (tests/fee-nag-ladder.test.ts) and the strike-3 ban turn
// (tests/stuck.test.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'fs';
// The sweep resolves `src/handlers/inbound.ts` itself, from wherever it is
// loaded (tsx or the esbuild bundle in dist-test/) — a `__dirname`-relative
// path here broke the compiled suite, which is exactly what this pins.
import { candidates, SRC } from '../scripts/lost-reply-sweep';

const realLines = readFileSync(SRC, 'utf8').split('\n');

test('lost-reply sweep: it catches the [21:57] shape (a standalone lane a later one overwrites)', () => {
  // The old cancel branch: a top-level `if` assigns the farewell, then the FSM
  // chain's own lane assigns another reply on the same turn.
  const synthetic = [
    '  private async processMessage(): Promise<void> {',
    '    let reply: string | undefined;',
    '    if (cancelled) {',
    '      await this.deps.visits?.cancelVisit(id, by);',
    "      reply = 'Откажана посета по желба на клиент.';",
    '    }',
    "    if (next === 'owner_checking') {",
    '      reply = OWNER_CHECK_ACK;',
    '    }',
    '  }',
  ];
  const hits = candidates(synthetic);
  assert.ok(hits.some(h => h.a.text.includes('Откажана посета')),
    `the overwritten farewell must be reported: ${JSON.stringify(hits.map(h => h.a.line))}`);
});

test('lost-reply sweep: a reply that ends the turn, and ladder-exclusive replies, are NOT reported', () => {
  const safe = [
    '  private async processMessage(): Promise<void> {',
    '    let reply: string | undefined;',
    '    if (fastLane) {',
    "      reply = 'fast';",
    '      await this.sendRaw(session, reply);',
    '      return;',
    '    }',
    '    if (next === "a") {',
    "      reply = 'A';",
    '    } else if (next === "b") {',
    "      reply = 'B';",
    '    } else {',
    "      reply = 'C';",
    '    }',
    '  }',
  ];
  assert.deepEqual(candidates(safe), [], 'nothing in this snippet can be overwritten');
});

test('lost-reply sweep: the candidate list is finite and reviewed', () => {
  // A ratchet, not a verdict: the sweep reports candidates for a human to read,
  // and this pins the current set so a new fall-through lane cannot slip in
  // unnoticed. Lower the number when candidates are made provably safe; never
  // raise it without reading the new pair (`npm run reply:sweep -- --lane <n>`).
  const hits = candidates(realLines);
  assert.ok(hits.length > 0, 'the sweep found nothing — it stopped working');
  assert.ok(hits.length <= REVIEWED,
    `new overwrite candidates since the last reading: ${hits.slice(REVIEWED).map(h => `@${h.a.line}→@${h.b.line}`).join(', ')}`);
  assert.ok(hits.every(h => h.a.method === h.b.method), 'candidates must be within one method');
});

/** Candidates read and judged benign (each is a `next`/state lane whose guard
 *  cannot co-fire with its neighbour) — lower this when one is made provably
 *  safe. Read the list with `npm run reply:sweep`.
 *
 * 23rd read 2026-10-29: @7382 `reply = buildLocateSeenConfirm(factProp)` — the
 * first arm of the property_locate ladder (`if (factProp) … else if …`), so it
 * is exclusive with the serve lanes beside it. The sweep still reports it
 * because later, unrelated lanes in `processMessage` assign `reply`; that is
 * the same shape as every candidate above, and the arm sets state to closing
 * and answers the turn's question in full (the 02:19 Водно capture). */
// 24th read 2026-10-31: @9584 `reply = r.text` — the LLM-responder arm of the
// `dispatchSimple` else; the next writer @9674 is the money+fee lane, which
// only fires when `bankKey` is `fee.ask.*`, and this arm leaves `bankKey`
// unset. Exclusive in practice: the responder reply is never overwritten by
// that lane. The adjacency appears because later fee lanes were added above
// it; no new fall-through was introduced.
//
// 25th read 2026-10-31: @9986→@10076 — the SAME pair as the 24th read, moved
// down by the value-ranking lanes added above it in the working tree. @9986 is
// the LLM-responder arm (`reply = r.text`, `bankKey` unset); @10076 is the
// MONEY QUESTION + FEE lane's price prepend, gated on `bankKey` being
// `fee.ask.rent|buy` and on a price/rent ask in the same message — it EXTENDS
// the fee reply with the figure the client asked for, and never runs on the
// responder arm's key. Benign by the same guard, not a new fall-through.
//
// 26th read 2026-11-01: @10025→@10115 — the SAME pair again (it has now been
// read three times under three line numbers), shifted down by the [02:38]
// anchor work above it: `isRecallTurn`, the blank-acquisition guard in
// `bindMention`, and the room/price ask appended to the anchored serve. @10025
// is the LLM-responder arm (`reply = r.text`, `bankKey` unset); @10115 is the
// MONEY QUESTION + FEE lane, gated on `bankKey` being `fee.ask.rent|buy` AND a
// price ask in the same message — it prepends the figure to a fee reply and
// cannot run on the responder arm's key. Benign by the same guard; no new
// fall-through was introduced.
//
// 27th read 2026-11-01: @10134→@10224 — the SAME pair a fifth time, shifted by
// the [19:14] PER-CATEGORY serve (the banded pair queue in loadProps, the
// drain note at the send choke, and the all-drained branch in the empty-pool
// lane). The pair itself is unchanged: @10134 is the LLM-responder arm
// (`reply = r.text`, `bankKey` unset) and @10224 is the MONEY QUESTION + FEE
// lane's price prepend, gated on `bankKey` being `fee.ask.rent|buy` AND a price
// ask in the same message. Benign by the same guard; the new per-category
// lanes are `sendRaw` + return lanes and never write `reply`.
// 28th read 2026-11-04: two pairs joined the list with the [17:30]/[17:43]
// lanes, both READ and both benign:
//   @7523→@8025 — @7523 is the `dispatchSimple` bank-miss literal
//     (`reply = simpleFast.fallback`) inside `if (simpleFast) { … }`, which
//     sends the reply and RETURNS at the end of that block. The sweep reads
//     `returns` on the innermost branch only, so the enclosing lane's return
//     is invisible to it; @8025 (`reply = taught.text`) is another lane that
//     only runs when `simpleFast` is undefined.
//   @10807→@10816 — both are branches of ONE ladder inside the empty-pool
//     lane (`if (dualDrained) … else if (categoryBudgets) … else if (doneAsk)
//     … else`), so they can never both run; the sweep's block parser ends the
//     first branch early on the sibling indentation and cannot see that.
const REVIEWED = 28;
