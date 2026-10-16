# Hermes — manual jobs & the two-machine move

> **NO MAP JOB IS SCHEDULED (2026-10-14).** Every command below runs when a human
> runs it — with ONE exception that must never be removed: the **owner price
> sync**, `*/5 * * * * scripts/hermes-price.sh` on the bot atom. Lina asks owners
> for the current price and that timer is the only thing that carries each
> correction through the hub to the app. The historic cron lines for the MAP work
> are quoted only so an old crontab entry is recognisable — `npm run cron:check`
> must report COMPLIANT on every machine (add `--require-sync` on an atom), and
> `scripts/install-cron.ts` refuses to install any NEW schedule.

Hermes is the agency-side agent that runs on its own box (or, for now, the same
box as Lina). It owns the jobs Lina must not do itself: the **price sync** to
the public app and the **landmark resolution** (naming the nearest public place
for each property address via its own reasoning LLM — NVIDIA NIM, free tier).

## Landmark resolution — MANUAL

```bash
bash scripts/hermes-nightly.sh            # run it when YOU decide
bash scripts/hermes-nightly.sh --dry-run  # report-only: no LLM calls, no writes
```

- Wrapper: `scripts/hermes-nightly.sh` — logs to `data/logs/hermes-landmarks.log`,
  rotates at ~2 MB (keeps 2 old copies), and exits non-zero on a real failure.
- The name still says "nightly" from when it was scheduled; it is not.
- Under the hood it runs `npm run hermes:landmarks`
  (`src/scripts/hermesLandmarks.ts`): for every feed address that still has
  only the coarse table landmark, it geocodes (OSM Nominatim, free) and asks
  the NVIDIA LLM to name the true nearest landmark, validates the answer (the
  street can never leak), and writes it back as `source='hermes'`.
- Env comes from `~/.lina/lina.env` (loaded by `loadConfig`):
  `HERMES_LLM_BASE_URL`, `HERMES_LLM_API_KEY`, `HERMES_LLM_MODEL`.

## Offline map — MANUAL pull, and only on the machine that OWNS the map

The landmark resolver used to hit live Nominatim + Overpass per property (rate
limits, 429s, uptime). It now reads a LOCAL OSM map of Skopje instead — named
POIs + address rows in a small SQLite file (`data/skopje-pois.db`, a few MB).

```bash
bash scripts/skopje-map-weekly.sh   # manual only; NOT weekly any more
```

> **⚠ ONE PRODUCER.** This pulls and REBUILDS the map from OSM. If another
> machine authors `skopje-pois.db` and ships it here with `deploy_map.sh`, do
> NOT run this here — you would overwrite the authored map with a local build.
> The map is a fixed artifact between deliberate refreshes.

- Wrapper: `scripts/skopje-map-weekly.sh` — `npm run map:pull`
  (`src/scripts/skopjeMap.ts`), logs to `data/logs/skopje-map.log`, rotated at
  ~2 MB. The build is ATOMIC (temp file + rename): a failed pull keeps the
  previous map serving.
- The resolver (`hermesLandmarks.ts`, feed mode) uses the map for geocoding
  (Latin↔Cyrillic street match) and the 1000m POI ring — live Nominatim/Overpass
  remain the fallback when the map is missing, a street is unmatched, or a ring
  is empty.
- `SKOPJE_POIS_DB` overrides the path (default `data/skopje-pois.db`).
- The map contains ONLY what the resolver needs: named amenity/shop/leisure/
  tourism/office POIs + `addr:street` rows — no buildings, roads or geometry.
  The exact POI count and DB size are printed on every pull.

## Owner sync — SCHEDULED on the atom (the one job that stays)

`npm run hermes` / `src/scripts/hermes.ts` — one pass over TWO queues of
owner-dictated facts, each POSTed to its Lovable-built Supabase function and
resolved on 2xx:

| queue | what Lina asked the owner | function it lands in |
|---|---|---|
| `price_changes` | the CURRENT price — a different one becomes the public price | `update-property-price` (`HERMES_WRITE_URL`) |
| `address_changes` | the ADDRESS, confirmed before a visit (Turn 0) — a different street is the real one | `update-property-address` (`HERMES_ADDRESS_WRITE_URL`, derived from `HERMES_WRITE_URL` when unset) |

On the atom this is the REQUIRED `*/5 scripts/hermes-price.sh` cron entry — the
wrapper is named after its first queue, but it carries both. Do not remove it:
a no-cron sweep did once (2026-10-14) and every published price froze while
corrected addresses piled up unread. `npm run cron:check -- --require-sync`
fails if it is missing, and `npm run atoms:deploy` re-installs it.

Run it by hand any time (`bash scripts/hermes-price.sh`, or `npm run hermes
-- --dry-run` to report only). A failed push leaves the row `pending`, so an
outage delays a correction — it never loses one.

## Logs

| job | log |
|---|---|
| landmarks (manual) | `data/logs/hermes-landmarks.log` (+ `.1`, `.2` rotated) |
| owner sync (price + address) | `data/logs/hermes-price.log`, or `data/hermes.log` for a bare pass |
| TUI console | `data/tui.log` |
| bot (pm2) | `pm2 logs metropolis-lina` |

All `*.log` are gitignored.

## Moving Hermes to its own machine (phase 2 — BUILT)

The bridge is implemented. Lina serves a token-guarded `/hermes/v1` API on the
same `:8080` Express server as the Viber webhook; the Hermes scripts run in
REMOTE mode the moment `LINA_API_URL` + `HERMES_TOKEN` are set — no code
change, the same commands (`npm run hermes`, `npm run hermes:landmarks`).

### Lina side (the bot box)

- `registerHermesApi` mounts the API (`src/hermes/api.ts`):
  - `GET  /hermes/v1/work` — one pull: landmark candidates (feed addresses
    without a precise row), pending price changes, pending owner checks,
    upcoming visits.
  - `POST /hermes/v1/landmarks` — Hermes' named landmarks, written as
    `source='hermes'`; the STREET is re-rejected here (defense in depth).
  - `POST /hermes/v1/prices/:id/result` — ok/fail → resolves/keeps the row.
  - `POST /hermes/v1/owners/:chatId/answer` — Hermes' owner verdict. Written to
    the events bus AND fast-pathed to `ownerAnswer`.
  - `GET  /hermes/v1/visits` — monitoring.
- Every route requires `x-admin-token: <HERMES_TOKEN>`; with no token set the
  API is disabled (503) — never unauthenticated. `HERMES_TOKEN` must therefore
  be set in `~/.lina/lina.env` for the bridge.
- **Cross-process owner answers:** `DeferredOwnerAgent` now polls the events
  bus (`OWNER_BUS_POLL_MS`, default 2000) for `owner_check_result` events, so
  an answer written by ANY process (the TUI's `/owner`, the API, Hermes on
  machine B) resolves the pending check. The events table — not process memory
  — is the real bus.

### Hermes side (machine B)

```
LINA_API_URL=https://<tunnel-or-domain>      # Lina's public :8080
HERMES_TOKEN=<the shared token>              # same as Lina's
HERMES_WRITE_URL=…                           # Supabase update-property-price fn
HERMES_LLM_API_KEY=nvapi-…                   # NVIDIA NIM (landmarks)
HERMES_LLM_MODEL=deepseek-ai/deepseek-r1
```

- `src/hermes/client.ts` — `pullWork` / `pushLandmarks` / `reportPriceResult` /
  `answerOwner`, all `x-admin-token`-authed.
- `hermesLandmarks.ts` + `hermes.ts` auto-detect REMOTE mode from
  `LINA_API_URL`; local mode (no URL) still reads `data/lina.db` directly.
  In REMOTE mode no local DB is created or touched.
- The wrapper (`scripts/hermes-nightly.sh`) runs unchanged on machine B — the
  log/rotation stay identical. It is a manual entry point, not a schedule.

### Testing the whole system in parallel

1. **One box first:** run the TUI and the API server against the same scratch
   DB: `DB_PATH=data/test.db npm start` (API on :8080) alongside the TUI.
   Simulate Hermes with curl: `curl -X POST …/hermes/v1/landmarks -H "x-admin-token: …" …`.
2. **Two boxes:** point machine B's `LINA_API_URL` at Lina's tunnel; run both
   Hermes scripts with a scratch DB on Lina first, then flip production.
3. Owner answers from the API (e.g. via curl) resolve pending checks through
   the bus poll — watch the TUI funnel move from `owner_checking` to `pending`.
