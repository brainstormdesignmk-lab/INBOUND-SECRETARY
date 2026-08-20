# Deploying the Landmarks Pipeline (Steps 5–8)

This guide covers deploying the landmark resolution system — from the Supabase
edge functions to the T60 (Hermes) machine's cron jobs.

## Prerequisites

- **Supabase CLI** installed and authenticated (`supabase login`)
- **Node.js 18+** with npm
- **NVIDIA NIM API key** (free tier) for the reasoning LLM
- Access to the T60 machine (or wherever Hermes runs)

---

## Step 5: Deploy to Supabase

Run on a machine with the Supabase CLI linked to the project:

```bash
# One-command deploy: migration + edge functions + secrets
chmod +x scripts/deploy-supabase.sh
HERMES_API_KEY=<your-token> ./scripts/deploy-supabase.sh
```

This will:
1. Run the `20260820_add_landmarks_and_audit.sql` migration
   (adds `landmarks` + `landmarks_resolved_at` columns, audit tables)
2. Deploy `update-property-landmarks` edge function
3. Deploy `update-property-price` edge function
4. Set the `HERMES_API_KEY` secret

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

### 7a. Build the offline map

```bash
npm run map:pull
```

This downloads Skopje's named POIs + addresses from OSM into
`data/skopje-pois.db`. Takes ~30 seconds. The resolver reads from this
file instead of hitting live Overpass/Nominatim on the hot path.

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

## Step 8: Set up cron jobs

### 8a. Weekly offline map pull (Sunday 03:17)

```bash
chmod +x scripts/skopje-map-weekly.sh
crontab -e
# Add:
17 3 * * 0 /path/to/scripts/skopje-map-weekly.sh
```

### 8b. Nightly landmark resolver (daily 03:17)

```bash
chmod +x scripts/hermes-nightly.sh
crontab -e
# Add:
17 3 * * * /path/to/scripts/hermes-nightly.sh
```

### 8c. Daily response bank enrichment (midnight)

```bash
chmod +x scripts/enrich-bank.sh
crontab -e
# Add:
0 0 * * * /path/to/scripts/enrich-bank.sh
```

### Full crontab (all three):

```
# Lina/Hermes cron jobs
0 0 * * * /path/to/scripts/enrich-bank.sh >> /path/to/data/enrich-cron.log 2>&1
17 3 * * 0 /path/to/scripts/skopje-map-weekly.sh
17 3 * * * /path/to/scripts/hermes-nightly.sh
```

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
