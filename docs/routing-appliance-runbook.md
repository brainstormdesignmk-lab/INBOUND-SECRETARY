# Routing appliance runbook

**Goal:** an appliance-grade router that is safe without an operator. Serve
decisions are made and checked in code; the bank keeps growing even when a route
is wrong. No new timers — this repo's no-cron policy stands. "Automatic" here
means *decided at serve time and proven by tests*, not *scheduled*.

**Trigger case:** `MNOGU EFTINA CENA E TOA` (client says the quoted flat is
cheap) → routed to the visit-fee ladder (`fee.persuade.1.buy`) → fee copy served
→ the review bank refused the turn as frozen. Three independent failures:

1. **Sense collision** — `цена` is both the property price and a fee-charge noun.
2. **No valence** — a compliment is the opposite of a fee complaint.
3. **Capture welded to the route** — the question dies with the wrong key, even
   though refusing that answer was correct.

Prevention and salvage are separate investments. Classification will never be
perfect, so the bank must get richer from mistakes.

---

## Target model

Route on a **tuple**, not keywords:

| axis | values |
|---|---|
| **Topic** | property price / fee / commission / property fact / logistics / small talk |
| **Act** | ask / assert / evaluate / complain / accept / refuse / command |
| **Valence** | positive / negative / neutral |
| **Target** | the object on the table (this flat's price, the visit fee, the commission, the agent) |

`evaluate + price + positive + property 53` → `remark.price.cheap`.

The key namespace encodes the taxonomy (`remark.price.cheap`, `ask.fee.visit`,
`objection.fee.why`). An unclassifiable turn lands in an explicit `unknown.*`
bucket carrying the nearest tuple — never in `fee.*` by accident.

---

## Hard invariants (must hold regardless of detector quality)

1. **Fee lanes require a fee referent.** Explicit fee object (`посета`,
   `гледање`, `провизија`, `такса`, `500 денари`, `10 евра`) **or** an anaphor
   (`тие пари`, `тоа`) **and** the preceding assistant turn actually disclosed a
   fee. Otherwise no fee script may serve.
2. **Valence veto.** A positive/cheap price evaluation can never route to
   fee-nag, fee-complaint, fee-traffic, fee-persuasion, or cheaper-search. A
   complaint is not "многу ефтино".
3. **No money reply without a target.** If topic is money and the target is
   unresolved, serve a clarification or neutral ack — never a protocol script.
4. **Ambiguity defaults down, not sideways.** When two lanes claim a message,
   answer the narrower lane (informational remark) and log the collision; never
   escalate to the heaviest script.

---

## Phase 0 — Safety net (gate: corpus exists and was red before the fix)

**Objective:** make the misroute reproducible before touching a detector.

1. `tests/route-corpus.test.ts`: table of `(text, state, context) → expected
   intent/key`. Include the trigger family:
   - `MNOGU EFTINA CENA E TOA`, `CENATA E MNOGU EFTINA`, `mnogu eftina cena e toa`
     → `PRICE_EVAL_CHEAP`, never `FEE_*`, never `SUGGEST_ALTERNATIVES`.
   - `50% E MNOGU`, `MNOGU NEKAKO 500DEN ZA OTVARANJE NA STAN` → still fee.
   - `SKAPO E TOA` → unchanged lane (ambiguous; not the cheap lane).
2. Run it red for the right reason (the fee detector fires), then keep it as the
   permanent gate.

**Automation:** runs in `npm test`; every production misroute becomes a row.
**Status:** done. `tests/route-corpus.test.ts` was red exactly on
`detectFeeNag(trigger) === true`; it is green now and runs in `npm test`.

---

## Phase 1 — Hard invariants (gate: corpus green; fee-ladder suite unchanged)

1. **Cheap-price valence class** (`isCheapPriceEval`): `ефтин/евтин/поволна
   цена/добра цена/ниска цена` + Latin typings.
2. **Veto wiring:** `detectFeeNag`, `detectFeeComplaint`, `isFeeTraffic`,
   `detectCheaperSearch` return false for it.
3. **Prefix collisions:** short fragments in big alternations (`многу е`,
   `mnogu e`, `скапо е`) must be boundary-closed. `многу ефтина` is not `многу е`.
4. **Fee-referent separation:** the shared noun `цена` is fee evidence only with
   a fee referent; a price praise with no referent is property traffic.

**Rollback:** the vetoes are one-line guards; reverting restores the old lanes.
**Automation:** corpus + existing `fee-nag-ladder` / `fee-serve-routing` suites.
**Status:** done. `isCheapPriceEval` is the veto; the value arm now requires a
fee referent, so `PREVISOKA CENA` is a price objection, not a fee complaint.

---

## Phase 2 — The missing lane (gate: e2e proves reply source, key, untouched funnel)

1. `detectPriceEval(text) → 'cheap' | 'expensive' | undefined`.
   - cheap fires as above.
   - expensive is **detected but not wired**: with the fee on the table it is
     genuinely ambiguous, and negotiation/cheaper already own it.
   - No fee referent, no fee-sized figure, no comparative (`поевтино`), no search
     criteria (`do 500`, `vo Karpos`) → no fire.
2. Keys `remark.price.cheap` (+ `remark.price.expensive` reserved) with
   hand-written seeds in `FIXED_SEEDS` and a code fallback. No generator
   dependency, no external LLM.
3. Handler lane **before** fee/commission/nag lanes; gated to states
   `property_query | presentation | closing`, a bound property/price on the
   table (`propertyId | interestedPropertyId | lastPrice | presentedIds`), a
   non-question, and no budget/service/type/negotiation wording. No state
   change, no slot writes, logs `PRICE_EVAL_CHEAP` + bank key.
4. Must not steal: budget statements, service/type requests, genuine price asks.

**Automation:** bank-first serve (seed + learned), so the wording grows through
review without code changes.
**Status:** done. `detectPriceEval`, `PRICE_EVAL_CHEAP_KEY`, seeds in
`FIXED_SEEDS`, the handler lane, the router mirror and the e2e all landed.
`remark.price.expensive` is reserved but NOT wired (ambiguous with the fee in
`closing`; negotiation/cheaper keep it until arbitration exists).

---

## Phase 3 — Salvage: every question gets a home (gate: review test)

Split the welded flags:

| axis | values | meaning |
|---|---|---|
| **copy** | `frozen` / `seeded` / `learned` | may the wording be edited? |
| **routing** | `detector-owned` / `example-routable` / `open` | may the question be re-homed? |

1. **Frozen copy ≠ frozen question.** A frozen seed-backed policy pool forbids
   editing the answer; it does not forbid re-homing the question to `learn.*`.
2. **Auto-suggestion:** `suggestKey` returns `learn.<slug>` for enrichment /
   dynamic turns whose served key is frozen-but-routable. Code constants
   (`info.no.*`, `price.ask`) and data-carried keys (`address.exact`,
   `availability.ack`) stay refused — there is no wording to bank.
3. **TUI one path:** `K` opens on the usable key, `E` rewrites the answer, `A`
   stages, `STAGED` approval writes the original question into `bank_examples`.
4. **Route correction is first-class:** the operator action is "this question
   meant Y", not "edit X". The bad answer stays quarantined (refused), the
   question moves to Y, and the detector regression is queued as a corpus row.
5. **Capture by utterance:** every turn is stored with text/state/entities/served
   key (already `enrichment_queue`); a wrong route leaves an addressable record.
6. **Orphan queue:** rows with no viable key are `unresolved — needs a home`, not
   `processed`. They resurface as the taxonomy grows.
7. **Template families (deferred):** token-pattern examples
   (`[degree] + [price word] + copula`) scoped by state/bound object, so
   paraphrases route without a model. Exact examples remain the precision layer.

**Automation:** no operator is needed to keep the capture; the operator only
decides the destination when the auto-suggestion is wrong.
**Status:** done for 1–5. Item 6 (orphans) is exposed by `route:health` and the
queue rows stay actionable, but there is no separate `unresolved` table — the
report is the queue. Item 7 is deferred to Phase 5.

---

## Phase 4 — Observability (gate: `npm run route:health` + drift log)

1. **Golden corpus** (Phase 0) in every test run.
2. **Shadow router:** `routeLog` compares predicted (`[route?]`) with actual
   (`[route]`) per chat and emits `[route-drift]`. Real traffic finds collisions
   without serving them.
3. **Collision report:** `scripts/route-health.ts` (`npm run route:health`)
   scans every `data/*.db`:
   - frozen-key captures whose text is a PRICE evaluation (misroute alarm),
   - rows with no key (orphans),
   - the same phrase under more than one key family (collision evidence;
     `.buy`/`.rent` variants of one family are one route, not a collision).
   `--days N` scopes to recent traffic; `--strict` exits non-zero.
   Run `route:health --days 7 --strict` in CI/pre-deploy, not on a timer.
4. **Per-key metrics:** misroute rate, freeze-refusal rate, orphan rate
   (`bank_metrics` already records serves/misses).
5. **Fuzz the corpus** by substituting synonyms (`ефтино↔скапо`,
   `цена↔такса`) to hunt collisions automatically.

**Status:** 1–5 done. 4 (rates) landed in P5.1 (`misrouteRate` per family,
`orphanRate`, `freezeRefusalRate` — see below); 5 (synonym fuzz) is a corpus
test, not a generator — the pairs that matter are pinned by substitution:
a `ефтино→скапо` swap must flip to `expensive` and stay out of the cheap lane,
a `цена→такса` swap must resolve to fee traffic. Run it in `npm test`.

---

## Phase 5 — Architecture evolution (after P0–P4 have traffic)

P5.0 status: the SCAFFOLD landed 2026-10-22 (see "P5.1 — zero-misroute
hardening"); **P5.1 and P5.2 are both LANDED** (see their sections below) —
the extractor/arbiter chain is live code with parity pinned by the corpus.

1. **Evidence-based arbitration:** each lane returns why it fired (matched
   tokens, state, bound object) and declares vetoes; resolve collisions by
   evidence + state, not array order.
2. **Tuple extraction** as a first-class object feeding the key namespace.
3. **Narrow learned arbiter** for ambiguous tuples (logistic regression / tiny
   embedding) with a restricted key menu; deterministic vetoes stay sovereign.
4. **LLM as last-resort arbiter only:** returns the tuple + a key from the
   allowed list; validated, then stored as a labeled example so the next
   occurrence is deterministic. It may never author money copy.
5. **Negative examples** (`phrase → never fee.*`) written automatically by route
   corrections and replayed by the corpus.
6. **Template families** for paraphrase routing.

---

## Phase 6 — Scale-out (multi-market)

- Key namespace per market; shared tuple vocabulary.
- Per-market lexicons and shadow scoring; the invariants (referent, valence,
  target) are universal.
- Metrics and collision reports partitioned by market.
- Deployment gate: corpus + route-health strict must pass before a market ships.

---

## Current evidence (2026-10-22, live `data/tui.db`)

`route:health --days 3` found exactly the field failure and a sibling of it:

- `#235` `fee.persuade.1.buy` · **MNOGU EFTINA CENA E TOA** — the trigger.
- `#65` `investment.opinion` · **mnogu skapa cena ima** — same valence/sense
  collision against another frozen key.

The trigger is now served by `PRICE_EVAL_CHEAP` (e2e asserts the reply comes
from `remark.price.cheap`, the funnel is untouched, and the queue row carries
the key). The historical rows stay visible until re-homed — that is the report
doing its job, and `--strict` fails on them by design.

Gates at the end of this pass: `npm run typecheck` clean; `npm test` 1301 pass,
0 fail; `route:health --days 3 --strict` exits 1 on the one remaining historical
misroute and 0 on the report run.

## P5.1 — Zero-misroute hardening (2026-10-22, second slice)

The first slice (P0–P4) made the field bug impossible and visible. This slice
closes the remaining audit gaps so the invariants section describes CODE, not
intent:

1. **Invariant 3 has its lane now.** `detectMoneyWithoutTarget` + the
   `ask.money.clarify` handler lane — money vocabulary whose object is
   unresolved (no fee referent, no property noun, nothing bound) serves the
   clarify question and NEVER a protocol script. Deliberately placed LAST
   among the money lanes (after fee-amount-ask and provision): it catches only
   the residue. Pure-regex probes only: negated pay (`ne sakam da platam`),
   bare money nouns ("немам пари"), budget/cheaper shapes and investment
   OPINION remarks are state-resolved traffic and are explicitly excluded.
   Gated to `closing | presentation`, fee not agreed, no property on the table.
2. **Invariant 4 has records now.** Two `routeLog` probes beside the
   price-eval block: `LANE_COLLISION:<claim>` when the cheap-price vocabulary
   overlaps the pre-veto fee-claim grammar (a predicate-drift alarm), and
   `PRICE_EVAL_EXPENSIVE_UNWIRED` when a "скапо" turn hits an ambiguous
   money-script state — the arbitration phase starts from real counts.
3. **Route corrections write negative rules automatically.**
   `applyOperatorCorrection` #5: when the question moved ACROSS key families,
   a `bank_negative_rules` row (exact utterance × family prefix, source
   auditable to the correction id) is written, and the money lanes consult
   `BankStore.neverServes(text, 'fee.' | 'provision.')` before serving — the
   exact phrasing that already burned a serve can never climb that ladder
   again. Whole-phrase match only: substring vetoes would poison the funnel.
4. **Per-key rates in route:health.** `healthRatesLine` prints
   `family=misroute%/serves · orphan-rate · freeze-refusal-rate` per DB;
   `--json` carries the full object for a dashboard.
5. **Corpus fuzz is in `npm test`.** The two dangerous synonym runs are
   pinned as substitutions: valence flips cleanly, fee nouns resolve.

**Gates:** `npm run typecheck` clean; `npm test` green (route-corpus now 9
tests; operator-correction 14; route-health 8).

## Pushing further — the discussion (options, cheapest → deepest)

- **Option 1 — evidence-based arbitration (next code slice).** Each money lane
  returns WHY it fired (matched grammar × state × bound object) and the chain
  resolves by evidence strength instead of array order. The P5.1 probes are the
  data collector; the resolver is a few hundred lines around the money
  region only.
- **Option 2 — tuple extractor + narrow learned arbiter (Phase 5 core).**
  Extract `topic × act × valence × target` per turn; when the deterministic
  score is decisive, route; when ambiguous, hand the tuple to a small local
  classifier with a RESTRICTED key menu — vetoes and negative rules stay
  sovereign. Offline, sub-ms, every decision becomes training data.
- **Option 3 — LLM as last-resort arbiter only.** For genuinely novel tuples,
  an LLM may pick from the allowed key list and MUST return the tuple; the
  validated choice is stored as a labeled example so the next occurrence is
  deterministic. It must never author money copy (the bankConstraints veto
  layer already enforces this for every generation that touches the bank).

Recommendation (resolved 2026-10-22): Option 1 + the expensive-lane boundary
landed in P5.2 below; Option 2 stays deferred until the `unknown.*` residue
exceeds what the regex families absorb (the addresses are already the training
data); Option 3 landed ONLY as the last-resort router with a closed menu —
never as an author.

## Open items (deliberately deferred)

1. ~~Wire `remark.price.expensive` once Option 1's evidence arbitration exists~~
   **DONE (P5.2):** wired under the arbiter's evidence boundary — explicit
   price noun + property on the table + non-question + no negotiation shape;
   everything else still logs `PRICE_EVAL_EXPENSIVE_UNWIRED` (the data
   collector keeps counting).
2. ~~Re-home the two historical frozen rows through `bank:tui`~~
   **DONE (P5.2):** executed with `scripts/rehome-frozen-rows.ts --apply --db
   data/tui.db` — #235 → `review_key=learn.mnogu-eftina-cena`, #65 →
   `learn.mnogu-skapa-cena`; the original `bank_key` evidence is preserved and
   backup files (`*.pre-rehome-*.bak`) were taken first. `route:health
   --strict` now exits 0 (orphan findings are non-blocking by design).
3. ~~Tuple extractor + evidence arbitration (Phase 5, Options 1–2)~~
   **DONE (P5.2):** `src/llm/moneyArbitration.ts` — claims + evidence chips +
   veto validation + the `unknown.<topic>.<act>` bucket, wired into the money
   lanes in `inbound.ts` and pinned by `tests/money-arbitration.test.ts`.
4. ~~Wire route-correction negative rules into the REVIEW UI as evidence chips~~
   **DONE (P5.2):** `BankReview.evidenceChips()` + the `ЕВИДЕНЦ:` line in the
   bank:tui detail pane (`src/bank/tui.ts`), pinned by
   `tests/review-evidence-chips.test.ts`.
5. The `unknown.*` bucket is now ADDRESSED (named in the logs and the review
   chips) but not yet a serve; when the residue exceeds what the regex
   families absorb, the narrow learned arbiter (Option 2's tiny classifier) is
   the next step — the address IS the training data.

## P5.2 — Evidence arbitration (2026-10-22, third slice — "DO ALL")

The three Options of the discussion phase are now CODE, not argument:

- **Option 1 — evidence-based arbitration.** `arbitrateMoney()` turns every
  money lane into a CLAIM: the handler's own predicate as the detector, an
  evidence chip list, an evidence strength. Resolution is by strength; ties
  fall back to the legacy array order, so every serve the old chain made, the
  new chain makes byte-identical (parity pinned in
  `tests/money-arbitration.test.ts`). The valence axiom now REIGNS above the
  resolution: a surviving cheap claim (strength 8) outranks every fee lane.
  Ties at the top log `LANE_COLLISION:<a>|<b>`; an unclaimed money turn logs
  its explicit `ROUTE_UNKNOWN:<topic>.<act>` address. The DB-state vetoes
  (`BankStore.neverServes`) move INTO the claim list as pre-resolved
  booleans, so a decision is replayable from a corpus row.
- **Option 2 — tuple extractor.** `extractTuple()` classifies every money
  turn on `topic × act × valence × target`; `unknown.<topic>.<act>` is the
  residue ADDRESS (never a serve). The review UI shows the tuple and the
  residue address as evidence chips.
- **Option 1+ — the expensive lane, WIRED.** The boundary the evidence makes:
  `remark.price.expensive` serves ONLY on a negative evaluation whose object
  is the explicit price noun, on a property on the table, in
  `property_query | presentation`, non-question, no negotiation shape, no
  other claim. Bare "скапо" (no price noun), `closing` state, questions and
  negotiating shapes keep their lanes. Copy is hand-written policy seeds
  (`PRICE_EVAL_EXPENSIVE_SEEDS` + fallback): acknowledge the objection, state
  the owner-set price, invite the live viewing — never an amount, never a
  discount, never fee talk.
- **Option 3 — LLM as last-resort arbiter, IMPLEMENTED.**
  `src/llm/arbiterLlm.ts`: on arbiter RESIDUE only (lane null + bucket set),
  the escalation LLM picks ONE key from a CLOSED menu (`MONEY_ARBITER_MENU`),
  must return JSON, and the deterministic vetoes re-run on the pick
  (`vetoPickedKey`): cheap requires a positive evaluation, expensive a
  negative property-price tuple, fee/provision keys a fee frame in the TEXT.
  The serve is bank seeds only (the LLM never authors money copy) and the
  answered pair is stored as a labeled example (`BankStore.addExample`). Any
  veto, parse failure or LLM outage falls through to the pre-existing
  escalation path unchanged.
- **Negative rules in the review UI.** `BankReview.evidenceChips()` renders
  the serve-time `neverServes` veto (whole-phrase, same normalization), the
  route tuple and the residue address as chips in the bank:tui detail pane.
- **The historical rows re-homed.** `scripts/rehome-frozen-rows.ts` (dry-run
  default, `--apply` writes, backup per pass) retargets frozen-misroute rows
  via `review_key` — the TUI operator path, scriptable. The two blockers
  cleared; `route:health --strict` is green.

Gates at the end of this slice: `npm run typecheck` clean; full suite green
including the three new suites (`money-arbitration`, `arbiter-llm`,
`review-evidence-chips`) and the extended `route-corpus` / `route-health`
pins; `route:health --strict` exits 0 on live data.

## P5.3 — The auto-passes + Loop B's batch face (2026-10-22, fourth slice)

The buffer between a serve and the human gate is now two mechanical filters
plus a regeneration loop, so the operator approves copy instead of triaging
plumbing (the 2026-10 review rows that motivated this: #235 genre mismatch,
#197 fee hygiene, #236 thin identity, #193 duplicate).

- **Pass 1 — `npm run bank:autoreject`** (`scripts/autopass.ts reject`, pure
  rule in `src/bank/autoPass.ts: autoRejectDecision`). A pending queue row a
  MONEY-lane key served, whose text the arbiter parses as a RESOLVED price
  evaluation (`property-price·evaluate·positive/negative·property`), is
  bounce-only: dismissed from the queue and recorded in `bank_corrections`
  (status `new`) — unlike the review UI's X, the signal survives. Only
  provable disagreements bounce; unresolved turns (e.g. fee-lane serves of
  no-vocabulary texts) stay with the operator. **Dry by default; `--apply`
  writes; `--db` overrides the review master.**
- **Pass 2 — `npm run bank:rekey`** (`scripts/autopass.ts rekey`). Pending
  rows whose wording validates under the RESOLVED key (the same `keyOf()`
  the TUI binds to: suggestion first, frozen+capturable → `learn.*`) with a
  different key are staged automatically via `review.push` — the #236 shape.
  Refused keys and failing texts stay visible (the duplicate row #193 and
  the amount-failing #197 are exactly what stays). Dry by default.
- **Pass 3 — Loop B's batch face: `npm run bank:relearn -- --from-corrections
  [--dry] [--limit N]`** (`scripts/relearn.ts`). Every `new` correction with
  a non-data-driven key under the variant cap becomes ONE regeneration job
  per key (planner: `autoPass: relearnPlan`): newest correction is the
  signal, strict Gemini drafts 5 candidates under the key's P1 contract,
  `validateBatch` gates them, they land STAGED; succeeded keys mark their
  corrections `processed` (family `answer-regen`), failed keys stay `new`.
  The generation core was extracted so per-key failures never kill the run.
- **First live application (`--apply --db data/tui.db`, 2026-10-22):**
  #235 bounced → correction #10; 19 rows staged by rekey (incl. #236 →
  `learn.koja-agencija-ste`); Loop B staged 9 candidates (4 ×
  `fee.persuade.1.buy` — with the gate visibly rejecting one Gemini line for
  `does not end with a question` — and 5 × `property.notfound` after a
  transient Gemini 503 retry) and marked corrections #5/#10 `answer-regen`.
  Everything awaits the normal `bank:tui` / `bank:relearn --promote` gate.
- **Not changed:** no new cron (repo policy); frozen keys stay
  push-refused; `learn.*` keys stay amount-hostile (`allowedAmounts: []`) —
  fee prose can never be re-homed under them; the quality gates are
  unchanged, only the rows that would bounce anyway are moved to where the
  bounce is a record.
- **Pinned by** `tests/autopass.test.ts` (8 tests): the #235 bounce, the
  #197 keep, the #236 auto-stage-through-push, the #193 duplicate staying
  visible, the end-to-end dismissal→corrections write, and the planner's
  grouping/skip rules.

## Operating loop

1. Serve decisions are code; no review step is required for safety.
2. A misroute either auto-rehomes (Phase 3) or surfaces in `route:health`
   (Phase 4) — nothing sits silent in a frozen bucket.
3. New vocabulary collision = new corpus row first, then the guard.
4. No new cron. Checks run in `npm test` / CI / pre-deploy.
