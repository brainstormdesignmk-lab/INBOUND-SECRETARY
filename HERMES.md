# Hermes — nightly jobs & the two-machine move

Hermes is the agency-side agent that runs on its own box (or, for now, the same
box as Lina). It owns the jobs Lina must not do itself: the **price sync** to
the public app and the **landmark resolution** (naming the nearest public place
for each property address via its own reasoning LLM — NVIDIA NIM, free tier).

## Nightly cron (landmark resolution)

Installed entry (03:17 nightly — off-peak):

```
17 3 * * * <PROJECT_DIR>/scripts/hermes-nightly.sh
```

- Wrapper: `scripts/hermes-nightly.sh` — logs to `data/logs/hermes-landmarks.log`,
  rotates at ~2 MB (keeps 2 old copies), and exits non-zero on a real failure
  (so cron can alert). `--dry-run` for a report-only pass.
- Under the hood it runs `npm run hermes:landmarks`
  (`src/scripts/hermesLandmarks.ts`): for every feed address that still has
  only the coarse table landmark, it geocodes (OSM Nominatim, free) and asks
  the NVIDIA LLM to name the true nearest landmark, validates the answer (the
  street can never leak), and writes it back as `source='hermes'`.
- Env comes from `~/.lina/lina.env` (loaded by `loadConfig`):
  `HERMES_LLM_BASE_URL`, `HERMES_LLM_API_KEY`, `HERMES_LLM_MODEL`.

## Offline map (T60 plan) — weekly Sunday pull

The landmark resolver used to hit live Nominatim + Overpass per property (rate
limits, 429s, uptime). It now reads a LOCAL OSM map of Skopje instead — named
POIs + address rows in a small SQLite file (`data/skopje-pois.db`, a few MB):

```
17 3 * * 0  <PROJECT_DIR>/scripts/skopje-map-weekly.sh
```

- Wrapper: `scripts/skopje-map-weekly.sh` — `npm run map:pull`
  (`src/scripts/skopjeMap.ts`), logs to `data/logs/skopje-map.log`, rotated at
  ~2 MB like the nightly. The build is ATOMIC (temp file + rename): a failed
  pull keeps the previous map serving.
- The resolver (`hermesLandmarks.ts`, feed mode) uses the map for geocoding
  (Latin↔Cyrillic street match) and the 1000m POI ring — live Nominatim/Overpass
  remain the fallback when the map is missing, a street is unmatched, or a ring
  is empty.
- `SKOPJE_POIS_DB` overrides the path (default `data/skopje-pois.db`).
- The map contains ONLY what the resolver needs: named amenity/shop/leisure/
  tourism/office POIs + `addr:street` rows — no buildings, roads or geometry.
  The exact POI count and DB size are printed on every pull.

## Price sync (same pattern, same box or the cron above)

`npm run hermes` / `src/scripts/hermes.ts` — POSTs pending `price_changes`
rows to the Lovable-built `update-property-price` Supabase function
(`HERMES_WRITE_URL` / `HERMES_TOKEN`) and resolves them on 2xx. Add it to the
nightly wrapper when the price-cron is wanted:

```
# in scripts/hermes-nightly.sh, after the landmarks run:
#   npm run hermes >> "$LOG_FILE" 2>&1
```

## Logs

| job | log |
|---|---|
| landmarks (nightly) | `data/logs/hermes-landmarks.log` (+ `.1`, `.2` rotated) |
| price sync | same wrapper log when added, or `data/hermes.log` for a manual pass |
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
- The nightly wrapper (`scripts/hermes-nightly.sh`) runs unchanged on machine B
  — the log/rotation stay identical.

### Testing the whole system in parallel

1. **One box first:** run the TUI and the API server against the same scratch
   DB: `DB_PATH=data/test.db npm start` (API on :8080) alongside the TUI.
   Simulate Hermes with curl: `curl -X POST …/hermes/v1/landmarks -H "x-admin-token: …" …`.
2. **Two boxes:** point machine B's `LINA_API_URL` at Lina's tunnel; run both
   Hermes scripts with a scratch DB on Lina first, then flip production.
3. Owner answers from the API (e.g. via curl) resolve pending checks through
   the bus poll — watch the TUI funnel move from `owner_checking` to `pending`.
