# Deploying the Landmarks Pipeline (Steps 5–8)

This guide covers deploying the landmark resolution system — the Supabase edge
functions and the manual runs on the machine that owns the map.

> **NO MAP JOB IS SCHEDULED (2026-10-14):** the cron steps this document used to
> contain are gone — the landmark/map work is human-gated. One line must STAY
> installed and is not map work: the atom's **owner price sync**
> (`*/5 * * * * scripts/hermes-price.sh`). `npm run cron:check` must report
> COMPLIANT on every machine (add `--require-sync` on an atom);
> `scripts/install-cron.ts` refuses to install a NEW schedule and
> `npm run cron:remove` strips any MAP job that survived.

## Prerequisites

- **Supabase CLI** installed and authenticated (`supabase login`)
- **Node.js 18+** with npm
- **NVIDIA NIM API key** (free tier) for the reasoning LLM
- Access to the T60 machine (or wherever Hermes runs)

---

## Step 5: Deploy to Supabase

Run on a machine with the Supabase CLI linked to the project:

```bash
# One-command deploy: link assertion + migration + edge functions + secrets + verify
supabase link --project-ref qkgioqotxjxffiaufgwd    # the LIVE project — required once
HERMES_API_KEY=<your-token> npm run deploy:supabase
npm run verify:feed                                 # read-only proof the feed serves the geo fields
```

This will:
0. **Refuse to run** if the linked project is not the live one (a deploy into the
   empty FREEBUFF project used to "succeed" and change nothing Lina can see)
1. Run the `20260820_add_landmarks_and_audit.sql` migration
   (adds `landmarks` + `landmarks_resolved_at` columns, audit tables)
2. Deploy `update-property-landmarks` edge function
3. Deploy `update-property-price` edge function
4. Deploy `public-properties` — the feed Lina actually reads
5. Set the `HERMES_API_KEY` secret
6. Verify the live payload (version + lat/lon + landmarks)

After deploy, note the function URLs. They follow this pattern:
```
https://<project-ref>.supabase.co/functions/v1/update-property-landmarks
https://<project-ref>.supabase.co/functions/v1/update-property-price
```

---

## Step 6: Set up the T60 (Hermes) machine

### 6a. Copy the env template

```bash
mkdir -p ~/.lina && chmod 700 ~/.lina
cp scripts/t60-env.example ~/.lina/lina.env
chmod 600 ~/.lina/lina.env
nano ~/.lina/lina.env   # fill in the blanks
```

**Required values:**
| Variable | Where to find it |
|---|---|
| `SUPABASE_URL` | `https://<project-ref>.supabase.co` from the Supabase dashboard |
| `HERMES_API_KEY` | Same key used during deploy |
| `HERMES_LANDMARKS_WRITE_URL` | `$SUPABASE_URL/functions/v1/update-property-landmarks` |
| `HERMES_WRITE_URL` | `$SUPABASE_URL/functions/v1/update-property-price` |
| `HERMES_LLM_API_KEY` | NVIDIA NIM API key (https://build.nvidia.com) |
| `PROPERTY_DATA_URL` | The public-properties edge function URL |
| `SKOPJE_POIS_DB` | Leave empty — will be populated by Step 7 |

### 6b. Install dependencies

```bash
cd /path/to/inbound_final
npm install
```

---

## Step 7: First run on T60

### 7a. Get the offline map — from its OWNER, or build it here if this IS the owner

```bash
npm run map:pull        # ⚠ REBUILDS data/skopje-pois.db from OSM
```

This downloads Skopje's named POIs + addresses from OSM into
`data/skopje-pois.db`. Takes ~30 seconds. The resolver reads from this file
instead of hitting live Overpass/Nominatim on the hot path.

**⚠ One producer only.** If another machine authors the map and ships it with
`scripts/deploy_map.sh` (checksum-verified), do NOT pull here — you would replace
the authored map with a local OSM build and silently disagree with every other
machine. The map is a fixed artifact between deliberate refreshes.

### 7b. Run the landmark feed resolver

```bash
npm run hermes:landmarks:feed
```

This will:
1. Find all properties without a `landmarks` field
2. Geocode each address (local SQLite first, OSM fallback)
3. Query the reasoning LLM for the nearest public landmarks
4. Push the ranked list to the `update-property-landmarks` edge function

**Expected output:**
```
[hermes-landmarks] FEED mode (import-time resolution → ranked list next to the property)
[hermes-landmarks] offline map: 3416 POIs / 7646 addresses — data/skopje-pois.db
[hermes-landmarks] 45 candidate(s) without a resolved landmark list.
  ✓ Црвена Вода (Центар) → „Кафе бар Ван Гог" (120м), „Градежен факултет" (340м)
  ...
[hermes-landmarks] done: 40 resolved, 5 skipped/failed.
```

**Rate limiting:** NVIDIA NIM free tier has strict limits (~1-2 req/s). The
script sleeps 2s between calls. If you see HTTP 429 errors, wait a minute
and re-run — already-resolved properties are skipped (idempotent).

**"нема јавни места" errors:** Some addresses geocode to locations outside
the Overpass POI coverage. These fall back to the deterministic neighborhood
table — not a problem.

### 7c. Verify

Check the Supabase dashboard or run:
```bash
curl -s "$HERMES_LANDMARKS_WRITE_URL" \
  -H "x-admin-token: $HERMES_API_KEY" | python3 -m json.tool
```

Or verify directly in the properties table that the `landmarks` column is populated.

---

## Step 8: NO MAP JOB IS SCHEDULED (this step used to install three cron jobs)

**NO MAP JOB IS SCHEDULED (2026-10-14).** The map is a fixed artifact, and
enrichment/landmarks are human-gated. The three lines this step used to install
are now forbidden, and `cron:remove` strips them.

The one schedule that MUST exist is the atom's owner price sync
(`*/5 * * * * scripts/hermes-price.sh`) — Lina asks owners for the current price
and that job carries each correction to the app. It is not map work, and
`npm run atoms:deploy` re-installs it if it is missing.

Prove it, and clean up any machine that still carries them:

```bash
npm run cron:check      # exit 0 = COMPLIANT. exit 1 = a schedule is installed
npm run cron:remove     # strips them (idempotent; keeps only the @reboot boot line)
```

Run these on **every** machine you have an account on — hub, workstation, each
atom — and after every restore from an old image. `npm run atoms:deploy`
enforces the policy on the whole fleet automatically.

The three jobs are now manual entry points, run when you decide:

| was | now |
|---|---|
| `17 3 * * 0 skopje-map-weekly.sh` | manual, and **only on the machine that owns the map** |
| `17 3 * * * hermes-nightly.sh` | `bash scripts/hermes-nightly.sh` when you want a landmark pass |
| `0 0 * * * enrich-bank.sh` | `bash scripts/enrich-cron.sh [--gapfill]` after you have reviewed what the fleet learned |

> The `@reboot … # LINA_ATOM` autostart is the ONE non-job line and is kept: it
> spends nothing and learns nothing, it only brings the bot back after a power
> cut. `npm run cron:remove -- --remove-reboot` if you want it gone as well.

---

## Troubleshooting

### "LLM HTTP 404"
The model name is wrong. Check `HERMES_LLM_MODEL` in `~/.lina/lina.env`.
Current correct value: `nvidia/nvidia-nemotron-nano-9b-v2`

### "LLM HTTP 429"
Rate limited by NVIDIA NIM free tier. Wait 60s and re-run. Already-resolved
properties are skipped, so only new/failed ones get retried.

### "не може да се геокодира"
The address couldn't be geocoded via OSM Nominatim or the offline map.
The property falls back to the deterministic neighborhood landmark table.
Check if the address is in the offline map: `npm run map:pull` first.

### "edge function HTTP 4xx"
Check that:
- `HERMES_LANDMARKS_WRITE_URL` is correct
- `HERMES_API_KEY` matches the secret set during deploy
- The edge function is deployed (`supabase functions list`)

### Re-running the feed
The feed is idempotent — re-running only processes properties without a
`landmarks` field. Already-resolved properties are skipped. Safe to run
multiple times.
