# ROUTING ARCHITECTURE AUDIT — 2026-10-23

The premise of this audit: the system's failures are ROUTING failures
(correct intent known, wrong lane served, or right lane in the wrong
state), not missing-phrase failures. Phrase gaps get misdiagnosed as
routing gaps because the routing layer is opaque; most "add the phrase"
fixes have been fixes to ORDER, or fixes to a lane that fired and then
served something that did not belong to it.

## Measured state of the routing layer

| Layer | Size | Role | Status |
|---|---|---|---|
| `src/fsm/machine.ts` | 207 l | 15 states, typed events, legality flags | clean; the FSM itself is NOT the problem |
| `src/llm/deterministic.ts` | 6,535 l, **112 exported detectors** | phrase/morphology detection | the vocabulary is fine; the ORDER of consumption is not |
| `src/handlers/inbound.ts` | 7,493 l, **70 routeLog gates, ~45 distinct lanes** | the actual router + every lane's serve | 90% of routing correctness lives here as ordered if/else |
| `src/handlers/router.ts` | 290 l | `ROUTING_ORDER` precedence mirror (24 intents), shadow-predict drift check, `SIMPLE_DISPATCH` (15 terminal lanes) | mirror only; not the executor |
| `tests/route-corpus.test.ts` | 136 l | golden misroute corpus (detector-level) | the pattern to scale |
| `src/scripts/routeHealth.ts` | 162 l | queue-based collision / frozen-misroute / orphan report | measures the BANK keys, not the lane serves |

Diagnosis in one line: **routing correctness is stored in the wrong
place** — in the execution order of a 7.5k-line file — and every
abstraction built around it (mirror, corpus, health report) only
*observes* the order instead of *being* it.

## The bug shapes recur; the fixes don't (evidence from this month)

- `EXACT_ADDRESS` capturing `WHERE_IS` — ordering bug, fixed by inserting
  a lane ABOVE another.
- `STANOT` read as `PROPERTY_ID_REQUESTED` in a distance question —
  a global detector fired without a serve-time state check.
- Cheap-price compliment → fee ladder — two lanes' detectors both
  matched the same words (value assertion); ordering again.
- Fee objection → served an `Евидентен број` card — detector picked the
  WRONG lane, but hide the complaint and a "more"-mention picked the
  OTHER wrong lane (serve without intent). Two bugs, one root: no
  per-state allowance.
- `predloži mi` after a not-found EB re-served the not-found line — the
  lane that owned the state (property_query) kept its serve; the pivot
  intent had no right of way.
- "NE GARSONJERI I KUKJI" armed the studio category — detector fired,
  serve-time negation of the same detector had to be bolted on later.

Every fix lands as a new inline `if` with a bespoke guard list (see
`NEARBY_THREAD`: `!hasProximityAnchor && !detectWidenIntent &&
!detectExplicitWiden && !detectAvailabilityAsk && !detectPriceAsk` —
that is already a 5-way mini `ROUTING_ORDER` inlined in the middle of
an interceptor).

## Recommendations (ordered by leverage)

### R1 — Make `ROUTING_ORDER` the executor, not the mirror

Move each of the ~45 inbound.ts top-of-handle lanes into
`ROUTING_ORDER` as a row of `{intent, detectors(true/false/array),
states, serve}` and loop. inbound.ts keeps only: FSM events, sub-funnels
(visit, closing), and bank-backed lanes that need persistent context.

Consequences:
- Ordering lives in ONE array; a lane move is a diff of one line.
- `router.test.ts` executes the SAME table the runtime executes —
  mirror-drift becomes structurally impossible, and the shadow-predict
  mechanism becomes a snapshot of absence, not a replica.
- The 15-lane `SIMPLE_DISPATCH` table merges into it.

Practical first step (low risk, no behavior change): a **coverage
test** — every distinct lane string logged by `routeLog` in inbound.ts
must have a row in `ROUTING_ORDER`. Today ~21 lanes have none; those
are exactly the lanes that can be reordered or shadowed silently. Land
the test RED, then move lanes in incrementally, one per PR, with the
corpus rows of that lane as the test payload.

### R2 — Per-state lane allowance (the structural rule this month keeps re-deriving)

After the lane resolves, ask one question the FSM can already answer:
**is this lane allowed to serve in this state?** Keep a
`STATE_LANES: Record<State, Intent[]>` map. If the resolved lane is not
allowed locally, do not serve the lane's full text — serve ONE generic
acknowledge and route down the funnel. This collapses the whole family
"fee objection served a property card / 'more' served a batch /
predloži served the not-found line" into ONE rule instead of N
per-case negation guards. It also gives `stuck.test.ts`-style regressions
a one-line characterization: lane X is not in STATE_LANES[state], so
the serve must be the generic acknowledge.

### R3 — Persist the drift log; feed the corpus from production

`ROUTE_LOG` is a 500-entry in-memory ring that dies with the process
and only three lines reach `console.log`. Every `[route-drift]` is
being thrown away. Minimum viable persistence: append
`{at, chatId, text, predictedIntent, actualIntent}` to a rotated
JSONL in `data/` (and, where flights already write, reuse the queue
table with `kind='drift'`). Then extend `route-health` to (a) replay
drift pairs as detector assertions, (b) auto-emit **corpus test rows**
for each unresolved finding — `route-corpus.test.ts`'s golden pattern,
fed by production instead of by memory. The two months of transcribed
captures cited in the lane notes deserve to live as data, not prose.

### R4 — Two-tier detection: families + corpus, phrases stay seeds

The detectors that keep needing rescues are either (a) shared-word
collisions (`цена`, `многу`, `тоа`, bare numerals) or (b) new renderings
of the SAME intent (`predloži mi / drugi lokacii / στους γειτόνους`-class).
For (a), the collision detector already exists in seed form
(`detectCriteriaStatement`, `isMoneyWithoutTarget`, `cheapLaneConflict`)
— move ALL such cross-lane vetoes into one place (a `collisions.ts`)
instead of sprinkling them at 6 call sites, and give each veto a corpus
row both directions. For (b), prefer morphology families + qualifier
scoping over literal arms. Keep a written rule in AGENTS.md: a detector
landing without a corpus row in BOTH polarity directions (fires / must
not fire) does not merge.

### R5 — Extract lane serves into modules

`inbound.ts` is 7.5k lines because ~45 lanes' SERVE code sits inline
after its detection. Mechanical split: `lanes/whereIs.ts`,
`lanes/feeNag.ts`, `lanes/nearby.ts`, `lanes/searchPivot.ts`, …, each
exporting `serve(ctx)`. This is the precondition for R1 to be a
mechanical, low-risk migration rather than a rewrite, and for the lane
ordering to become visible in a single diff.

### R6 (small, but removes a marked family of ambiguity) — End the
"one detector, many states, different serve" pattern

`detectNegotiate`, `detectProvisionAsk`, `detectEscalation`,
`NEGOTIATE:fast`, `PROVISION_PUSH:fast`, `FEE_*:fast` and friends
currently mean "different text, same intent, state changes serve."
Keep the detector pure; keep the STATE gate as data on the lane row
(R1); never let a detector's own body contain a state check — every
state check so far (`!isKadeTocno`, `state-gated lanes`,
`!detectNegotiate(t) && !detectInvestmentOpinion(t)`) is instead a
manual negation of ANOTHER lane, which is ordering re-derived, the
source of most bugs in this audit.

## Reality check

- Doing R1 fully is a multi-session migration. TheEditors step order
  (coverage-red → per-lane moves) makes it incremental throughout.
- R2 and R3 are each a single session and are already where the recent
  fixes cluster (`predloži` pivot, negated garsonjera, `STANOT`,
  cheap-price valence) — they would have been structural instead of
  patchwork.
- The FSM (`machine.ts`) needs no change; none of these bugs are FSM
  bugs. The funnel itself is the healthiest layer here and should keep
  its size.
