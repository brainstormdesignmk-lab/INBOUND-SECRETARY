# Closed-Loop Bank — Phased Implementation Plan

**Problem.** The deterministic (skip-LLM) path serves bank answers instantly and free, but the bank
never learns: `bank_metrics`, `bank_corrections` and the enrichment loop exist in the schema and the
code, yet all three are empty in production. Every bad answer is corrected by hand, the correction is
thrown away, and the same mistake keeps serving. Meanwhile funnel-critical keys are FROZEN and
several protocol lines are hardcoded in `prompts.ts` — untouchable by any pipeline.

**Goal.** A bank that fixes itself: client traffic + operator corrections flow in, Gemini regenerates
variants *within per-key constraints*, a human approves protocol keys in one batch sitting, approved
variants go live immediately (no restart). Manual correction work drops from per-answer to per-batch.

**Non-goals / invariants (never violated, in any phase):**
- DATA_DRIVEN_KEYS (`price.ask`, `availability.ack`, `address.exact`, …): facts come from the property
  row. Gemini may only write the carrier sentence with `{price}`-style placeholders. No amounts, ever.
- Every serve site keeps its hardcoded fallback — an empty bank degrades to today's behavior, never
  to silence.
- `responses.ts` (the seed) stays human-driven via `npm run responses:generate`. The learning layer
  is SQLite (`bank_variants`) and stays live-reloadable.
- Strict Gemini only for anything that gets stored (the Groq-garbage purge rule stands).

---

## Phase 0 — Instrumentation: measure before regenerating  *(small, ~1 day)*

The bank has no feedback signal today. Build the meters first so every later phase is judged by data.

1. **Key-level hit/miss.** `pickVariant()` (src/data/responseBank.ts) already knows the key; add an
   optional metrics hook (settable like `setLearnedBank`). Record hit/miss + `key` into
   `bank_metrics`. Serve sites already log `bankKey` on enrichment — mirror the same field so the
   two stay consistent.
2. **Variant-level outcome.** The quality signal already exists (`answerWorked` — client re-asked
   within 10 min). Extend the enrichment record with the served variant id (bank_variants gets an id)
   so outcomes attach to the exact variant, not just the key.
3. **Fallback-literal census.** Grep-count the `?? '…'` inline literals in handlers/prompts (17 today
   + `feePersuasion`/`buildFeeAsk`/`buildFeeWhy` hardcoded). Instrument each to emit an enrichment
   record with `bankKey = null` + a `source: 'fallback-literal'` tag. This census *is* the worklist
   for Phase 4.
4. **Health report.** `npm run bank:status` — per key: served count, re-ask rate, corrections staged,
   variant count, frozen/data-driven flag. One page, read weekly.

**Acceptance:** after a day of real traffic, `bank_metrics` is populated; the report names the
worst keys by re-ask rate. This ranking decides regeneration priority in Phase 2.

## Phase 1 — The constraints layer: "Gemini within constraints"  *(medium, ~2 days)*

This is the core of your workflow: generation bounded by what the funnel may say.

1. **`bank_constraints` map** (code, in `src/store/bank.ts` next to FROZEN/DATA_DRIVEN). Per key:
   - `must`: facts that must appear (e.g. `fee.ask.buy`: 500 денари / 10 евра / 0% commission for buyers)
   - `forbid`: forbidden claims (never promise a price, availability, or a discount; never name streets)
   - `order`: funnel order rules (the fee ask ends with a question; the freshness disclaimer ends with
     the owner-contact ask; enthusiasm never discloses the fee)
   - `placeholders`: which `{vars}` may appear (`price.freshness`: exactly one `{price}`)
   - `tone`, `maxLen`, `script`: both scripts allowed, etc.
2. **`variantPassesConstraints(key, text)`** — pure validator: regex/keyword checks per rule.
   Existing seeds must all pass (run it across RESPONSE_BANK as a unit test — this also audits the
   current seed for contradictions).
3. **Wire into the two write paths:** `enrichBank.ts` acceptance (replacing bare `replyIsClean` as the
   *additional* gate) and the runtime read path (the bank cannot serve what the guard would reject —
   a violating learned variant is skipped at pick time and reported).
4. **Generator prompts become constraint-driven:** the cron's prompt includes `must`/`forbid`/`order`
   for the key it is filling. No more generic "generate 5 variations".

**Acceptance:** validator test over the whole seed passes; a deliberately violating variant is
rejected by both the cron and the runtime; per-key prompts demonstrably include the constraints.

## Phase 2 — Corrections-driven regeneration  *(medium, ~2–3 days)*

Turn your manual corrections into the training signal they should be.

1. **`npm run bank:relearn [--key <key>] [--all]`** — a focused script (separate from the midnight
   cron; the cron stays queue-driven):
   - Reads `bank_corrections` + failed enrichment records + Phase-2 fallback-literal records for the key.
   - Builds a regeneration prompt: *wrong answer → operator correction → constraints → existing
     variants as style anchors*. Gemini produces N candidate variants.
   - Validate (Phase 1 validator + hygiene) → **stage** (Phase 3), never auto-commit for frozen keys.
2. **Frozen keys unfreeze on correction.** `FROZEN_BANK_KEYS` keeps blocking the *cron* and runtime
   learning. A human-authored correction (or an explicit `--key` relearn invocation) is the only key
   that unlocks one regeneration round for it. Freeness without a correction stays frozen — the
   funnel invariants remain operator-owned.
3. **Seed propagation (manual).** After a reviewed regeneration proves itself, the operator may fold
   approved variants into the seed via `responses:generate` so a wiped DB doesn't lose the learning.

**Acceptance:** running `bank:relearn --key fee.ask.buy` after one logged correction yields ≥3
constraint-passing, meaningfully different candidates; a frozen key with zero corrections is refused.

## Phase 3 — Approval workflow: the review CLI  *(medium, ~2 days)*

**Default model (recommended): hybrid.** Protocol/funnel keys (fee.*, price.freshness, contact.*,
recommend.close, visit.*) → staged + human-approved. Everything else → auto-promote behind the
Phase-1 validator + quality gate (config flag, off by default until Phase 1 is trusted).

1. **Staging.** `bank_variants` gains a `status` column (`staged | active | retired`) + `origin`
   (gapfill | learned | relearn | operator). `pickVariant` reads `active` only.
2. **`npm run bank:review`** — interactive terminal flow over staged candidates:
   - shows key, constraints, the triggering user messages, the wrong answer + your correction,
   - keys: `a`pprove / `r`eject (reason) / `e`dit-inline / `s`kip / `q`uit; batch mode
     `--key <key>` and a `--dry` diff mode that prints what would go live.
   - Approved → `active` immediately (live, no restart). Rejected → `bank_corrections` with the reason,
     feeding the next relearn.
3. **Undo:** `npm run bank:retire --id <variantId>` — a bad live variant is one command away from out.

**Acceptance:** a 20-candidate batch reviewed in minutes; approved wording serves in the very next
message; rejected candidates are visible as corrections.

## Phase 4 — Fallback-literal capture & upward growth  *(medium, ~2–3 days)*

Kill the "correct every 2nd answer" class: no client-visible reply may lack a bank identity.

1. **`serveFallback(key, text)` helper** — wraps the inline `?? '…'` literals and the prompts.ts fee
   strings; serves today's text unchanged but *logs* the serve as an enrichment record. Replace all
   17+ literals mechanically (same text, same fallback semantics).
2. **`prompts.ts` fee strings → bank keys** (`fee.persuade.1.*` / `fee.persuade.2.*` / `fee.why`
   already exist as keys for two of them; the persuasion ladder and `buildFeeAsk` become
   bank-backed with the current strings as seed). Phase 2 then regenerates them like any other key
   (they're frozen → correction-gated).
3. **Cron upward growth stays:** novel questions still create `learn.*` keys (existing behavior), but
   now they pass the constraint validator and land staged (or auto per the Phase 3 flag), and the
   Phase-0 census shows when an unmapped question recurs → operator decides: new key vs. map onto
   an existing key's constraints.

**Acceptance:** zero serve sites without a bankKey; the fee persuasion wording is regenerable through
the same pipeline as everything else.

## Phase 5 — The loop closes: pruning + monthly health  *(small, ~1 day)*

1. **Variant-level pruning:** variants whose serves repeatedly correlate with re-asks (Phase 0 data)
   are auto-`retired` (threshold, reported, reversible). The bank stops being decorative.
2. **Monthly report:** per key — serve volume, re-ask rate trend, corrections in/out, variant churn.
   The number that matters: **corrections per 100 answers**, week over week.

---

## Rollout order & dependencies

```
P0 (meters) ──► P1 (constraints) ──► P2 (relearn) ──► P3 (review CLI) ──► P4 (capture) ──► P5 (prune)
                     │                                        │
                     └──────── P3's auto-approve flag needs P1 trusted ────────┘
```
P2 and P3 can swap order if you want the CLI before the regeneration script; P4 depends on P0's
census + P3's staging; P5 needs a week of P0 data.

## Risks & mitigations
- **A plausible-but-wrong variant spreads** → constraints validator at write AND read time; hybrid
  approval for protocol keys; one-command retire.
- **Frozen-key philosophy eroded** → only operator corrections unlock regeneration; the cron still
  cannot touch frozen keys; every unlock is logged in the enrichment log.
- **Gemini drifts in Macedonian quality** → strict backend only (existing rule), hygiene gate kept,
  both-scripts check in constraints.
- **Silent regression in serving** → bank empty / all-staged → seed + hardcoded fallbacks, byte-identical
  to today.

## What I need from you
1. Approve the phase order (or reorder P2/P3).
2. Confirm the **hybrid approval model** (auto for non-protocol keys off until Phase 1 proven).
3. Green-light to start **Phase 0** — it touches no client-visible behavior.
