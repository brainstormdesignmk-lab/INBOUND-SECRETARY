# Visit route negotiation — the system (design, pre-code)

**Problem.** Lina can already build a *contiguous* route of several viewings on one
day (`src/visits/chain.ts`, `startChainIfNeeded` / `advanceChain` / `finishChain` in
`src/handlers/inbound.ts`). In the field it still fails in three ways, and the route
it does build is too rigid to hold the cases the owner actually described.

The [18:35] capture, defect by defect:

1. **The same hour is ping-ponged as its own alternative.**
   Owner 1 is asked 17:00, counters 18:00 — correctly relayed to the client. The
   client answers «mislam deka ke moze vo 6» (a yes to 18:00). Lina then asks the
   OWNER «Клиентот не е во можност за посета во 18:00. Има друг предлог: 18:00».
   The client's *acceptance* was read as a *new counter*, and the refusal sentence
   named a term the owner never refused.
2. **A plain confirmation word is not understood.** The owner answers the Turn-0
   address question («Дали адресата е точна?») with «tocno» and is asked again,
   because the address lane only knows «да / точна».
3. **The second flat's arrangement never starts.** A visit is booked on one flat
   while the other flat in the client's request is never asked about — the route
   only starts on an explicit plural phrase *in the same turn as the term*, and it
   is thrown away (`session.slots.visitPlan = undefined`) on the first rejection.

**Goal.** One negotiation loop that can arrange two or more viewings for one client
on one day, balancing several owners, with the client asked only at real decision
points — exactly the owner's examples:

* client wants 17, owner 1 wants 18 → ask owner 2 for 17; if yes, route 82@17, 84@18.
* owner 2 cannot do 17 but offers 16 → ask owner 2 for **19**; if yes, tell the
  client «18 за ЕБ 84, 19 за ЕБ 82» and let him accept or name another day.
* if a contiguous route is impossible but a route with a 1–2 h pause is possible,
  **ask the client** whether the pause is acceptable, and book it if he agrees
  (1 h preferred, 2 h tolerated — the owner's answer of 2026-11-19).
* if he refuses the day, the same stops start over on the day he names.
* **nobody is dropped.** When the owners' frames differ too much, the property
  that fits the client's hour is arranged and the other property is asked for
  ANOTHER day/hour on its own — a second route, not an omission.
* an **earlier start** is a legitimate option *when it chain-links* with the
  others: it is offered to the client to accept or refuse, never applied
  silently.

**Non-negotiables (all pre-existing contracts, must survive the redesign):**

- Nothing incomplete reaches an owner or the client (`isCompleteVisitTerm`).
- Visit window 09:00–21:00; agency working days Mon–Fri (the owner's standing rule).
- One plan, one client decision — never a per-owner relay during negotiation.
- Street address only in Turn 3 (2 h before); owner always gets street + map.
- Fee per property (`buildFeePerProperty`), never a rounded "for the route".
- An owner is asked at most 3 times per route, and never the same hour twice.
- `visitPlan` is durable session state: it must survive restarts, late owner
  answers and timeouts (`DeferredOwnerAgent` already resolves from the bus).

---

## Phase 0 — the three defects (SHIPPED, each with a regression test)

> 0.1 and 0.2 are closed (`tests/capture-1835-same-hour-pingpong.test.ts`,
> `tests/assent-family.test.ts`). 0.3's first half — a plural wish that survives
> turns — already shipped in `af3eda6` (`visitWanted` sticks, `visitEbs`
> remembers the named set); what remained (the route surviving a refusal and the
> deferred flat getting its own term) is closed in Phase 4.

### 0.1 Same-instant ping-pong

Root cause is string comparison where instants are meant, at two places:

- `src/handlers/inbound.ts:17461`
  `isFollowup = !!priorAsk && !!askTime && priorAsk !== askTime`
  — `ownerCounterTime` may be stored in display form while `askTime` is
  `normalizeOwnerTime(...)`. Different strings, same instant ⇒ a "refusal +
  alternative" sentence whose two halves are the same hour.
- `src/llm/classify.ts:76` `timeConfirmCounterEvent` compares
  `normalizeOwnerTime(t)` with `normalizeOwnerTime(ownerTerm)` **before** the
  missing day is merged, so «vo 6» ≠ «Понеделник, 23.11.2026 во 18:00» and a
  restated hour becomes `VISIT_TIME_PROVIDED` instead of `TIME_ACCEPTED`.

Fix, in this order:

1. One helper `sameVisitInstant(a: string, b: string, donors: string[]): boolean`
   in `src/visits/time.ts`: merge the missing day into each term (the same
   `mergeVisitTerm` the lanes already use), parse both, compare `getTime()`.
2. `timeConfirmCounterEvent` uses it (with the session's terms as donors) →
   the restated hour is `TIME_ACCEPTED`.
3. `runOwnerCheck` refuses to compose a follow-up whose two ends are the same
   instant. When the term equals the instant the owner already agreed to or
   offered (`ownerCounterTime` / `ownerTime`), there is **nothing to ask** — the
   lane books instead of pinging. This is an invariant at the seam, not a patch:
   whatever the classifier does, an owner never reads "не може во X … предлог: X".
4. Remember refused instants (`slots.ownerRefusedTimes`, per day) so a client
   who re-proposes an hour the owner already refused gets the honest line, not a
   third ping at the same hour.

Test `tests/capture-1835-same-hour-pingpong.test.ts`: scripted owner (17:00
asked → counter 18:00), client «mislam deka ke moze vo 6»; assert **no** owner
message after the acceptance, the visit booked at 18:00, and — the contract
level assertion — no owner-facing line in the whole exchange contains the same
date+hour as both the refused and the proposed term.

### 0.2 The confirmation family

Root cause: `ADDR_CONFIRM_RE` (`src/llm/deterministic.ts:6410`) lists
«да / точна / ok / во ред / исто / потврдувам» but not «точно» / «tocno», so the
owner's one-word yes is `undefined` and the TUI re-asks
(`src/tui/app.ts:986`). The same word is missing from the client-side time
lanes (`AGREE_PHRASES`, `src/llm/deterministic.ts:4690`).

Fix: one family module `src/llm/assent.ts`

```ts
type Polarity = 'yes' | 'no' | undefined;
detectPolarity(text, { lane: 'address' | 'time' | 'fee' | 'generic' }): Polarity
```

- Built as `stems + \p{L}*` after `normalizeMc`, both scripts (the §4 rule), so
  word order, clitics and инflections do not matter.
- Yes: да, da, ok, ок, во ред, vo red, добро, dobro, **точно, tocno, tochno**,
  така е, taka e, се согласувам, se soglasuvam/saglasuvam, согласен, soglasen,
  потврдувам, potvrduvam, важи, vazi, може, moze, супер, super, нема проблем.
- No: не, ne, no, не е точно, ne e tocno, грешно, gresno, не е така, не може,
  ne moze, нема, nema, не ми одговара, ne mi odgovara.
- Precedence: a negated yes-span is a **no** («ne e tocno» must never confirm);
  when both appear, the clause that answers the question wins (trailing «ama/
  ama/но» flips it).
- **Per-lane exclusions are data with a comment**, not silence: «може» confirms a
  term but does not confirm a street address; «добро» does not confirm a
  commission. The table is the documentation.

`detectOwnerAddressReply`, `detectAgreement` and `detectTimeRejection` keep their
lane logic and vetoes but read their token families from this one module, so a
new word is added once. Tests: `tests/assent-family.test.ts` — a table over the
whole family in both scripts, every lane, plus the negated-yes cases, plus the
regression that «tocno» confirms the address (fails on HEAD).

### 0.3 The second stop must start

Root cause: `startChainIfNeeded` needs `visitWanted`, which is only set by
`detectMultiVisitIntent` / `detectPluralViewingWish` **in that turn**, and the
route needs a complete term in the same turn. A client who arranged flat A and
then says «и 82, сакам да ја видам» has plural evidence on a turn with no term;
the term arrives later («во понеделник во 6») with no plural word — and the
second arrangement never starts. `slots.visitEbs` already remembers the named
set, so the evidence exists; nothing resumes it.

Fix: a **pending route** is not a transient object:

- `slots.visitEbs` (already durable) is the set; when a visit is being arranged
  and the set holds ≥2 flats, the route is created even without a plural word in
  that turn (`visitWanted` stops being the only gate: ≥2 named/remembered flats
  + a visit term is the same evidence).
- A `TIME_REJECTED` on the route keeps the stops and clears the day, instead of
  `visitPlan = undefined` (`src/handlers/inbound.ts:13148`). The same stops are
  re-negotiated for the new day — the owner's rule.
- A stop that ends `dropped` is remembered (`slots.routeDropped`) and named when
  the chat later schedules that flat alone, so it is not silently forgotten.

Test `tests/route-second-stop.test.ts`: two flats named, term given on two
turns; assert both owners were asked (two pending requests, one per EB), the
client got one plan, and the appointments are on the books for both EBs.

---

## Phase 1 — the solver learns the two directions (SHIPPED)

`src/visits/chain.ts` is pure arithmetic; it stays pure. It gains:

1. **Gaps.** `SolveInput.maxGap` (default 2, the tolerance the owner set;
   `preferredGap` 1). A placement is a sequence of hours `h1 < … < hn` with
   `h(i+1) − h(i) ∈ [1, 1 + maxGap]`, inside 09–21, avoiding `busy`.
   `maxGap: 0` reproduces today's contiguous behaviour exactly.
2. **One lexicographic objective** instead of the current "contiguous, then drop
   the last stop": maximise stops placed → minimise `|start − target|` (later
   preferred at equal distance) → prefer 1 h gaps over 2 h ones (smaller total
   gap) → keep the client's order. Implemented as a DFS over (stop order, hour
   cursor) — n ≤ 4 over a 13-hour window, so it is cheap and exhaustive, and the
   drop cases fall out of the objective rather than a second hand-written loop.
3. **Search ±3 h always** (the current `flexible` flag silently refuses a shifted
   route). The shift is not hidden: `buildChainAsk` already states it, and the
   plan is only booked after the client's yes. `flexible` becomes a tie-break
   preference, not a permission bit. An EARLIER start that chain-links is a
   first-class option in the client's answer (owner's 2026-11-19 answer):
   `stops`, `shiftedBy` and the question go to him; nothing moves without his
   yes.
4. **No stops are thrown away.** When the whole set cannot share one day, the
   solver returns the route it CAN arrange (`stops`) plus `deferred` — the flats
   that keep their own negotiation for another day/hour. The client hears the
   arranged route AND that the remaining flat will be arranged separately; the
   `deferred` set goes back into the route state and is re-driven on the day the
   owners can do. `dropped` stays as the vocabulary for a flat the client
   himself refuses or that turns out unavailable.

Test `tests/chain-solver.test.ts`, table-driven with the owner's two examples and
the degenerate ones (one stop, owner hour outside the window, busy hour, 4
stops, no solution).

## Phase 2 — the question chooser (SHIPPED)

New pure module `src/visits/negotiate.ts` — no messages, no sessions:

```ts
type StopView = { eb: number; can: number[] | null; no: number[]; asked: Array<{hour: number; dayMs: number}>; asks: number; dropped: boolean };
type View = { dayMs: number; targetHour: number; maxGap: number; gapAllowed: boolean; stops: StopView[]; busy: number[] };

decide(view):
  | { kind: 'ask', eb, hour, why: 'first' | 'need' | 'changed' }
  | { kind: 'offer-plan', stops, deferred, startHour, totalGap }
  | { kind: 'offer-gap', stops, totalGap }
  | { kind: 'give-up', deferred }
```

The decision order, with the anti-loop guarantees:

1. A full route exists from known hours → if a stop's planned hour was never
   asked *and* is not his own offer, ask him that hour (a window is not a slot);
   else `offer-plan`.
2. No full route → **lookahead**: for every stop and every hour in the tolerance
   window that is neither asked nor refused, simulate adding it and re-solve.
   Ask the single question that unlocks the most (full contiguous route > full
   gapped route > one more stop), breaking ties by the most constrained owner
   (fewest `can` hours), then by the hour closest to the position the client
   asked for. **This is the owner's example 2**: owner 1 at 18, owner 2 refused
   17 and offered 16 → the analyser finds that asking owner 2 for 19 completes
   {18, 19}, and asks exactly that.
3. Nothing unlocks a contiguous route but a gapped route with known hours
   exists → `offer-gap` (the client decides; this is the "1–2 hours free" rule).
4. Nothing unlocks anything on this day → `offer-plan` for the stops that fit
   and `deferred` for the rest (each is then negotiated on its own day, never
   silently forgotten), or `give-up` when even one stop cannot be placed — the
   client is asked for another day and the same stops restart there.

Termination: every `ask` adds `(stop, hour)` to `asked`; hours in `no` are never
asked again; 3 asks per stop is the budget — after which the stop is `dropped`
and named. The candidate set is finite and strictly shrinks, so the loop ends.

**Stop-scoped owner context (mandatory once asks can overlap).** In route mode
the terms the owner answers are merged against **the stop's own asked hour**,
never `session.slots.ownerAskTime` (which is per chat). Today `advanceChain`
already clears those slots between stops; the redesign makes it structural:
`applyChainVerdict` passes `{ eb, askedHour }` into the merge, and the follow-up
composer for a route uses `owner.routeAsk` / `owner.routeFollowup` bank keys
(both ending in a question, both naming exactly the hour needed).

## Phase 3 — parallel owner asks (medium, DECIDED: parallel)

`DeferredOwnerAgent` holds **one** pending check per chat (`pending` keyed by
`chatId`, `settle(chatId)`), so a round can only ask one owner at a time. That is
why the capture's route took minutes per stop.

The owner's answer of 2026-11-19: **contact them in parallel**, and while the
answers are in, chain-link each owner's starting point; where the propositions
differ, hand the client the combined option.

Implementation: key the pending map by `chatId + eb`, `settle(chatId, eb)`
resolves only that stop, `pendingEb(chatId)` becomes `pendingEbs(chatId):
number[]`, and the TUI/`/owner` routes by EB (it already receives it). One ask
per owner per round, then one re-solve. Every answer is merged against ITS OWN
stop (`askedHour`), never the chat-global `ownerAskTime`, and the client hears
the result once, not a per-owner census.

## Phase 4 — client decision points (SHIPPED, see the status block at the end)

- `offer-gap` gets its own line: the two hours, the pause stated, and the
  question («со 1 час пауза — дали Ви одговара?»). Consent sets
  `route.gapAllowed` for that round only.
- `offer-plan` for a partial route names the flat that will be arranged
  separately (never "dropped"): «Оваа посета ја закажувам за ЕБ 84; за ЕБ 82
  барам посебен термин и ќе Ви се јавам».
- A refusal restarts the **same stops** on the day he names (Phase 0.3), with
  per-day ask history so yesterday's hours are not "already asked".
- The deferred stops are re-driven as their own route as soon as the arranged
  one is confirmed (one route per day; a deferred flat is never left silent).
- The client hears one holding line while owners are being balanced, never a
  per-owner relay. Chain mode already does this; it is a contract to keep.

Backfill needs no new lane: a gap is a genuinely free slot, so another client's
«кога може?» already sees it via `freeHours` / `buildSlotTakenLine`. The only
rule is: never mark a gap busy.

---

## Tests that gate the whole thing

Every phase ships an e2e through the real `InboundHandler` with a scripted owner
channel (the existing harness style), asserting **both** server state
(`slots.visitPlan.*`, `appointments.listByChat`) and the served copy at contract
level:

- `capture-1835-same-hour-pingpong` — 0.1
- `assent-family` — 0.2 (address, time, fee lanes; negated yes)
- `route-second-stop` — 0.3
- `chain-solver` — 1 (examples 1 and 2, gaps, drops)
- `chain-negotiation` — 2: owner script `17→counter 18`, `17→counter 16`, then
  assert the second owner is asked **19**, and only then does the client get
  «18:00 — ЕБ 84, 19:00 — ЕБ 82».
- `chain-gap-consent` — 4: no contiguous route, client asked about the pause,
  his no leaves nothing booked, his yes books both hours.
- `chain-budget` — never the same hour twice, never >3 asks, dropped named.

Plus the standing gates: `npm run typecheck`, `npm test`,
`scripts/tui-frame-check.ts`, `scripts/tui-pty-check.ts`,
`npm run bank:audit-seeds`. New bank keys (`owner.routeAsk`,
`owner.routeFollowup`, `chain.gapAsk`) go through the constraints sweep like the
rest.

## Deliberately unchanged

- The one-plan-one-decision shape, the per-property fee, the Turn 0–3 protocol,
  the 09–21 window, the working-days rule, and the "address only 2 h before"
  discipline — all already correct and all covered by tests.
- `LocalOwnerAgent`'s deterministic answers.
- The calendar's meaning of "busy".

## Implementation status (2026-11-19)

Shipped in this tree, with tests:

| piece | file | test |
| --- | --- | --- |
| same-instant comparison | `src/visits/time.ts` (`sameVisitInstant`) | `capture-1835-same-hour-pingpong` |
| assent family (one yes/no table, both scripts) | `src/llm/assent.ts` | `assent-family` |
| solver: gaps 0–2, ±3 h always, `deferred`, one objective | `src/visits/chain.ts` | `chain-solver`, `visit-calendar-chain` |
| negotiator: which owner, which hour, lookahead | `src/visits/negotiate.ts` | `chain-negotiation` |
| parallel asks, per-stop merge, budget | `src/handlers/inbound.ts`, `src/backoffice/ownerAgent.ts` | `chain-owner-examples`, `chain-gap-and-deferral` |
| pause offered for consent / deferred flat gets its own term | `src/visits/messages.ts`, `confirmChain` | `chain-gap-and-deferral` |
| a refused route keeps its stops for the next day | `inbound.ts` TIME_REJECTED | `visit-chain-flow` |

Known limits, on purpose and named:

- A route owner is asked with the EXISTING `owner.ask` copy (the first-ask flag
  keeps it from reading as a refusal). Dedicated `owner.routeAsk` /
  `owner.routeFollowup` bank keys are still the right next step — they need a
  constraints sweep of their own.
- `armOwnerCheck` (the availability-ack re-arm) still proposes
  `session.slots.visitTime`, which in a parallel round is whichever stop was
  asked last. A route re-arm must pass the stop's own term.
- The deferred flat's own term is collected as a normal single visit; if two or
  more flats are deferred they restart as a route (`visitWanted` survives).

## Decisions taken (owner, 2026-11-19)

1. **Parallel owner asks.** Contact the owners in parallel, chain-link each
   owner's starting point while the answers come in, and where the propositions
   differ, give the client the combined option.
2. **Gap cap 2 hours, 1 hour preferred.** The solver never proposes a longer
   pause; a 1 h gap wins over a 2 h gap at equal stop count and shift.
3. **Earlier start is offered, not applied.** If an earlier start chain-links
   with the others' frames, it is presented to the client as an option to accept
   or refuse.
4. **Nobody is dropped.** When the frames differ too much, the property that
   fits the client's hour is arranged and the other is asked for another
   day/hour and arranged separately if agreement is possible.
