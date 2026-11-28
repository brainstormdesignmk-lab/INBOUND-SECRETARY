# CLASSIFIER BUILD RUNBOOK — the LLM-free route

**Read this before touching the classifier. It exists so no future session re-asks
what was already decided, re-measures what was already measured, or re-derives a
phase that is already specified.**

Owner's standing directive (AGENTS.md §0) applies to every task here: fix the
cause, sweep the sibling cases, never weaken a test, verify through the real
interface, report unrun checks as limitations.

---

## 1. Objective (one paragraph)

Lina must reach the point where the **classifier tier** stops needing a remote
LLM: the deterministic detectors keep their ~86 % of turns, a **learned route
table** absorbs the repeat traffic, a **tiny local model** covers the residual,
and the remote Gemini/Groq classifier becomes a fallback that is *observed* and
*shrinking*. The classifier may only ever emit an **event** — never prose, never
a slot, never consent.

---

## 2. State ledger (update this section, never silently)

| item | state |
| --- | --- |
| Repo HEAD | `760481a` (main, pushed to `origin` on 2026-11-28) |
| Uncommitted source | none |
| Untracked, MUST stay uncommitted | `data/place-misses-*.jsonl`, `data/route-drift-*.jsonl`, `logs/` |
| Phase 0 | **code+test green** (`ClassifyTurnStore`, `routeSig`, deadline, degraded, teach/measure split) |
| Phase 1 | **code+test green** (`routeOutcome`, `routeCorpus`, `route:link`, `route:corpus`) |
| Phase 2 | **code+test green** (`route_table`, `RouteStore`, shadow/serve, 3 modes) |
| Phase 3 | **code+test green** (promote/retire/conflict, corrections) |
| Phase 4 | **code+test green** (`localFeatures`, `localModel`, `localClassify`, `route:train`) |
| Phase 5 | **in progress** (`/status` row added; backup/cron/kill-switch tests pending) |
| Production deploy | both hosts at `760481a` |

Phase status values: `not started` → `in progress` → `code+test green` →
`gates green` → `deployed`. A phase is only `done` at `deployed`.

---

## 3. Non-negotiables (violating one of these is a bug, not a shortcut)

1. **Commitment events are NEVER learned.** `FEE_AGREED`, `CONTACT_PROVIDED`,
   `TIME_ACCEPTED`, `VISIT_TIME_PROVIDED` come from detectors only. A wrong
   route there is a false consent, not a misroute.
2. **Every tier abstains upward.** Abstain → the next tier runs. Abstain is a
   success, never a miss.
3. **Every verdict is recorded with its context signature.** No tier may be
   evaluated without it; a calibration that has to pair log lines by
   millisecond is not a calibration.
4. **Degradation is visible.** A failed/timed-out classify is `degraded = 1`,
   counted, and shown. Never a silent `STAY`.
5. **Labels come from outcomes, reviewers or detectors — never from the model's
   own verdict.** Grading a router against its predecessor is circular.
6. **Triggers are exact match only in v1.** Trigram similarity serves as a
   *candidate generator for review*, never as a serving threshold.
7. **Kill switches exist and are tested**: `LINA_ROUTES=off`, `LINA_LOCAL=off`
   restore today's behaviour with no deploy.

---

## 4. Baselines already measured (do NOT re-run to re-decide)

Measured 2026-11-27/28 from `data/tui.db`, `data/tui-capture.jsonl`,
`data/tui.log` (read-only).

**Traffic shape**
- 948 logged turns: deterministic 747, owner-relay 135, dynamic 41,
  gemini:* 16, place-template 3, bank 2, groq 2, dynamic-recall 2.
- 299 fallthrough captures; 133 joined to the serve log = **14.0 %** of logged
  turns reach the classifier.
- Answer source on those 133: deterministic 89, dynamic 29, bank 4, gemini 6,
  groq 1, dynamic-recall 1 → model prose survives on **~5.3 %** of fired turns.

**Cost / latency**
- 513 `[timing] classify` calls (2026-08-31 → 11-27).
- median 2 424 ms, p90 **22 519 ms**, max **396 919 ms**; 56 calls > 20 s,
  15 > 60 s.
- One verdict can burn 9 Gemini HTTP attempts (3 × 3 keys) + 3 Groq.
- Verdict mix: STAY 161 (31.4 %), SEARCH_REQUESTED 88, DETAILS_PROVIDED 57,
  INTERESTED 46, PROPERTY_ID_REQUESTED 43, INTENT_DECLARED 37, FEE_REFUSED 28,
  FEE_AGREED 25, VISIT_TIME_PROVIDED 12, REJECTED 8, TIME_ACCEPTED 7,
  ESCALATE 1.

**Why trigram routing was rejected (the decisive measurement)**
266 capture↔verdict pairs (pairing by nearest preceding `classify` line ≤ 60 s;
median 432 ms). Top-1 accuracy **42.4 %**.

| Dice threshold | served | accuracy when served | abstain |
| --- | --- | --- | --- |
| 0.50 | 59 | 69.5 % | 76.9 % |
| 0.60 | 40 | 72.5 % | 84.3 % |
| 0.65 | 31 | 74.2 % | 87.8 % |
| 0.70 | 24 | 75.0 % | 90.6 % |
| 0.80 | 13 | 61.5 % | 94.9 % |
| 0.90 | 9 | 77.8 % | 96.5 % |

Counter-examples (do not "tune" past these):
`sim 1.00 "DOGOVORI MI"` → FEE_AGREED / FEE_REFUSED / INTERESTED in the same
state. `sim 0.84` truth STAY → INTERESTED. `sim 0.82` truth STAY → FEE_REFUSED.

**Conclusion:** the label is not a function of (text, state). It needs the
**context signature** (fee-rung depth, property on table, what was just asked,
negation). Char trigrams are negation-blind ("ne moze" ≈ "moze").

**Known corpus bias:** the capture file dedupes per phrasing per day, so
verbatim repeats are invisible — the table above measures *generalization*, not
repeat-hit savings. Repeat savings can only be measured once verdicts are
stored (Phase 0).

---

## 5. Phases

Each task: **what**, **where**, **test**, **gate**. Do not skip a gate because
the code "looks right".

### Phase 0 — Make the instrument honest (blocking everything)

| id | task | file | test |
| --- | --- | --- | --- |
| P0.1 | `classify_turns` table + index | `src/store/db.ts` | migration test on fresh + existing DB |
| P0.2 | `ClassifyTurnStore` (insert/list/stats/updateOutcome) | `src/store/classifyTurns.ts` (new) | unit |
| P0.3 | context signature builder `buildRouteSig()` + `sigKey()` | `src/llm/routeSig.ts` (new) | unit: negation, digits, money words, fee rung, awaiting, service |
| P0.4 | `Classified` gains `degraded?`, `tier?`, `latencyMs?`, `attempts?` | `src/llm/classify.ts` | typecheck + unit |
| P0.5 | classify **deadline** (`classifyTimeoutMs`, default 8 000) — abandon, return `STAY + degraded` | `src/llm/classify.ts`, `src/config.ts` | unit with a hanging client |
| P0.6 | split policy: `shouldTeachBank()` (old rule) vs `shouldRecordTurn()` (always true) | `src/llm/enrichPolicy.ts` | unit: `free` mode records, does not teach |
| P0.7 | record every classify-tier turn at the seam | `src/handlers/inbound.ts` (~13 779) | e2e: `FailingLlm` turn → row exists, `degraded=1` |
| P0.8 | wire store in server + TUI deps | `src/index.ts`, `src/tui/app.ts` | typecheck |

**Gate P0:** `npm run typecheck` + `npm test` green; a forced-LLM-failure turn
lands a row with `degraded=1` and still answers the client.

### Phase 1 — Outcome linker and corpus

| id | task | file |
| --- | --- | --- |
| P1.1 | outcome linker: corrected / reask / regression / clean | `src/scripts/routeLink.ts` (new) |
| P1.2 | `route:link` + `route:corpus` CLIs | `scripts/route-link.ts`, `scripts/route-corpus.ts` |
| P1.3 | label rules: reviewer > detector > clean-outcome; never the model | P1.1 |
| P1.4 | corpus break-down by state × week printed | P1.2 |

**Gate P1:** corpus emits rows with zero `unknown` outcomes in the accepted set;
`route:corpus --stats` prints state × week.

### Phase 2 — Route table (shadow first)

| id | task | file |
| --- | --- | --- |
| P2.1 | `route_table` schema | `src/store/db.ts` |
| P2.2 | `RouteStore` (upsert/findExact/recordHit/lifecycle) | `src/store/routes.ts` (new) |
| P2.3 | serve fn: exact `norm + sigKey`, active, **safe events only** | `src/llm/routeServe.ts` (new) |
| P2.4 | modes `LINA_ROUTES=off\|shadow\|serve` | `src/config.ts` |
| P2.5 | seam integration BEFORE `classify()` | `src/handlers/inbound.ts` |
| P2.6 | config timeout/route wiring in TUI `/status` | `src/tui/app.ts` |

**Gate P2:** shadow run ≥ 1 week (or synthetic replay ≥ 1 000 turns); served
accuracy ≥ 95 %, ≥ 99 % on safe events; **zero** commitment events served from
a route; deterministic turns byte-identical.

### Phase 3 — Supervisor

| id | task | file |
| --- | --- | --- |
| P3.1 | promotion `staged → active` after N clean serves | `src/store/routes.ts` |
| P3.2 | retirement on correction; conflicting rows freeze + file correction | same |
| P3.3 | `route:health --routes` collision/coverage report | `src/scripts/routeHealth.ts` |
| P3.4 | nightly cron: link + promote + prune | `scripts/install-cron.ts` |

**Gate P3:** one operator correction retires a corrupted route (test); nightly
job idempotent when run twice.

### Phase 4 — Local model (only for the residual)

| id | task | file |
| --- | --- | --- |
| P4.1 | feature extractor: char 3–5-grams + sig flags | `src/llm/localFeatures.ts` (new) |
| P4.2 | trainer: multinomial logistic regression, pure TS, JSON weights | `scripts/train-route-model.ts` |
| P4.3 | inference: `predict()` → `{event, confidence}`; `UNKNOWN` class | `src/llm/localClassify.ts` |
| P4.4 | temperature scaling + confidence floor → abstain to remote | P4.3 |
| P4.5 | mode `LINA_LOCAL=off\|shadow\|serve` | `src/config.ts` |

**NOT Tiny 2.1.** It is a 367 k-param char-level *fact recall* net ("outside
those it makes things up confidently"). Wrong tool for a 16-class decision with
an abstain requirement. Do not port it.

**Gate P4:** held-out **by week AND by state**; ≥ 95 % overall, ≥ 99 % on safe
events, cost-weighted error below the remote baseline; one week in shadow
before `serve`.

### Phase 5 — Appliance hardening

| id | task | file |
| --- | --- | --- |
| P5.1 | backup/restore cover `classify_turns`, `route_table` | `scripts/backup.ts` (`TABLES`), `scripts/restore.ts` |
| P5.2 | `/status` row: active routes, shadow agreement %, degraded today | `src/tui/app.ts` |
| P5.3 | `exam:offline` reports what the stack answered with `NoLlm` | `scripts/offline-exam.ts` |
| P5.4 | kill-switch tests | `tests/*` |
| P5.5 | alarm when `degraded > 20/day` | health script |

**Gate P5:** pty funnel asserts the `/status` route row; kill switch verified by
a real TUI run.

---

## 6. Decisions already made — do NOT re-ask these

- **Order:** route table before local model. A table on ~40 shapes is memory; a
  model trained on 40 shapes is the "confidently wrong" failure in miniature.
- **Key:** `(norm, state, sig)` — never text+state alone.
- **`sig` flags (v1, extend only with an incident):** `negated`, `digit`,
  `moneyWord` (fee/provision/price vocabulary), `propertyOnTable`, `feeRung`
  (`feeRejections + provisionRejections > 0`), `awaiting` (the kind of ask the
  last assistant turn ended with), `service` (known/unknown).
- **Safe events (servable from a route):** `STAY`, `DETAILS_PROVIDED`,
  `SEARCH_REQUESTED`, `PROPERTY_ID_REQUESTED`, `INTERESTED`, `REJECTED`.
- **Commitment events (never learned):** `FEE_AGREED`, `CONTACT_PROVIDED`,
  `TIME_ACCEPTED`, `VISIT_TIME_PROVIDED`.
- **Serving:** exact match only; trigram = review candidate generator.
  Two rows with the same `(norm, sig)` and different events **freeze both** and
  file a correction instead of guessing.
- **Timeout default:** 8 000 ms (`CLASSIFY_TIMEOUT_MS`).
- **Local model:** logistic regression over char n-grams + sig, JSON weights,
  pure TS inference, no native deps, `UNKNOWN` class, temperature-scaled.
- **Route rows are `bank_variants`-shaped:** `norm, sig, event, source,
  lifecycle, hits, misses, last_served, validator_version, correction_id`.

---

## 7. Commands

```bash
npm run typecheck                       # tsc --noEmit
npm test                                # authoritative suite
npx tsx --test tests/<file>.test.ts     # fast loop on one file
npm run test:fast                       # compiled, no PTY file
npm run bank:audit-seeds                # contracts + offensive sweep
npx tsx scripts/tui-frame-check.ts      # headless layout/painter
npx tsx scripts/tui-pty-check.ts        # real TUI under a real pty
npm run llm:live-check:fast             # keys + brain modes (needs network)
npm run route:health                    # read-only routing report
npm run replay -- <file>                # transcript replay
```

`npm run test:c` exceeds a 600 s tool timeout — run BACKGROUND with a log.

---

## 8. Git and hygiene

- Commit and push to `origin main` only when asked; the user has authorized
  pushes for this build.
- **Never stage** `data/place-misses-*`, `data/route-drift-*`, `logs/`, `tmp/`.
- **No AI attribution footer, no `Co-Authored-By`** in this repo.
- One commit per phase task group; message states *why*, not just *what*.

---

## 9. Deliberately deferred (raise only if asked)

- Whether routes should also propose **slots** (v1: no — event only).
- Whether the review queue should auto-file from trigram collisions (v1: file
  candidates, human decides).
- Porting Tiny 2.1 for **prose** (never for routing).
- A second route table per **channel** (Viber vs TUI) — measure first.

---

## 10. Change log

- 2026-11-28 — runbook created. Baseline measurements and the trigram
  rejection recorded. Phase 0 specified; HEAD pushed at `760481a`.
- 2026-11-28 — Phases 0–4 implemented and green: verdict ledger + signature +
  classify deadline/degraded, outcome linker + corpus CLIs, route table with
  shadow/serve and the commitment ban, promotion/retirement/conflict, and the
  pure-TS local model with an abstain floor. Tests: `classify-turns`,
  `route-outcome`, `route-table`, `local-model`. Remaining: full-suite gate,
  Phase 5 backup/cron wiring, and a real shadow run before any `serve` mode.
