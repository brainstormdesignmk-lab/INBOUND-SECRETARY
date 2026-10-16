#!/usr/bin/env bash
# deploy-supabase.sh — one-command deploy of the landmarks + price-sync + feed
# infrastructure to Supabase.
#
# Prerequisites:
#   - supabase CLI installed and authenticated (`supabase login`)
#   - Project linked TO THE LIVE PROJECT (`supabase link --project-ref <ref>`)
#   - HERMES_API_KEY env var set (or passed as first argument)
#
# Usage:
#   HERMES_API_KEY=nvapi-xxx ./scripts/deploy-supabase.sh
#   ./scripts/deploy-supabase.sh nvapi-xxx          # same, via arg
#
# What it does:
#   0. ASSERTS this checkout is linked to the LIVE project (fail closed)
#   1. Runs the landmarks migration (adds columns + audit tables)
#   2. Deploys the update-property-landmarks edge function
#   3. Deploys the update-property-price edge function
#   4. Deploys public-properties — the feed Lina actually reads
#   5. Sets the HERMES_API_KEY secret for the edge functions
#   6. VERIFIES the live feed (scripts/verify-feed.sh, read-only)
#
# Env overrides:
#   SUPABASE_PROJECT_REF=<ref>   change which project is expected (deliberate)
#
# WHY STEP 0: this checkout was once `supabase link`ed to METROPOLIS 2 FREEBUFF
# (empty — 0 properties) while Lina reads QKGIO. A deploy there exits 0, prints
# success, and publishes into the void. Never let that look green again.
#
# WHY STEP 4: public-properties was NOT in this script at all — which is exactly
# how it drifted into a version that emitted no landmarks and left Lina
# answering "во населбата Центар" for a property with 4 resolved landmarks.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"

# --- Resolve the API key ---
HERMES_API_KEY="${HERMES_API_KEY:-${1:-}}"
if [ -z "$HERMES_API_KEY" ]; then
  echo "ERROR: HERMES_API_KEY is required."
  echo "Usage: HERMES_API_KEY=nvapi-xxx $0"
  echo "   or: $0 nvapi-xxx"
  exit 1
fi

cd "$PROJECT_DIR"

# --- Pre-flight checks ---
if ! command -v supabase &>/dev/null; then
  echo "ERROR: supabase CLI not found. Install: https://supabase.com/docs/guides/cli"
  exit 1
fi

# --- Step 0: WHO is linked + THE LIVE-PROJECT ASSERTION (fail closed) -------
# This replaces the old `supabase status` gate, which was worse than useless
# here: it exits 1 on a machine with no local Docker stack even when the CLI is
# fine and the project IS linked (so the script could never reach its deploy
# steps), and it never looked at WHICH project was linked — which is the one
# thing that has actually gone wrong. linked-project.json exists only after a
# successful `supabase link`, so reading it is the honest linked-check.
if ! supabase status &>/dev/null 2>&1; then
  echo "  · note: 'supabase status' is unhappy (no local stack running?) — continuing;"
  echo "    what matters is the linked project ref, asserted next."
fi

LIVE_REF="${SUPABASE_PROJECT_REF:-qkgioqotxjxffiaufgwd}"
LINKED_REF="$(sed -n 's/.*"ref"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' supabase/.temp/linked-project.json 2>/dev/null | head -1)"
if [ -z "$LINKED_REF" ]; then
  echo "ERROR: cannot read the linked project ref (supabase/.temp/linked-project.json)."
  echo "  Run: supabase link --project-ref $LIVE_REF"
  exit 1
fi
if [ "$LINKED_REF" != "$LIVE_REF" ]; then
  echo "REFUSING TO DEPLOY — wrong Supabase project."
  echo "  this checkout is linked to : $LINKED_REF"
  echo "  Lina reads                 : $LIVE_REF"
  echo ""
  echo "  A deploy into '$LINKED_REF' would succeed and change nothing Lina sees."
  echo "  Fix the link first:"
  echo "    supabase link --project-ref $LIVE_REF"
  echo "  If '$LINKED_REF' really is the intended target, say so explicitly:"
  echo "    SUPABASE_PROJECT_REF=$LINKED_REF $0"
  exit 1
fi
echo "  ✓ linked to the LIVE project ($LINKED_REF)"

echo "=== deploy-supabase: $(date -Iseconds) ==="
echo ""

# --- Step 1: Run migration ---
echo "[1/5] Running landmarks migration..."
if supabase db push --linked 2>&1; then
  echo "  ✓ Migration applied."
else
  echo "  ⚠ Migration may have already been applied (continuing)."
fi
echo ""

# --- Step 2: Deploy edge functions ---
echo "[2/5] Deploying update-property-landmarks..."
supabase functions deploy update-property-landmarks --no-verify-jwt 2>&1
echo "  ✓ update-property-landmarks deployed."
echo ""

echo "[3/5] Deploying update-property-price..."
supabase functions deploy update-property-price --no-verify-jwt 2>&1
echo "  ✓ update-property-price deployed."
echo ""

# --- Step 4: the feed Lina reads --------------------------------------------
# Deploying it here is what stops it from drifting: it was maintained by hand,
# out of band, and nobody could tell that the deployed copy had stopped emitting
# landmarks. The version stamp in the response is asserted below.
echo "[4/5] Deploying public-properties (the feed Lina reads)..."
supabase functions deploy public-properties --no-verify-jwt 2>&1
echo "  ✓ public-properties deployed."
echo ""

# --- Step 5: Set secrets ---
echo "[5/6] Setting HERMES_API_KEY secret..."
supabase secrets set HERMES_API_KEY="$HERMES_API_KEY" 2>&1
echo "  ✓ Secret set."
echo ""

# --- Step 6: VERIFY the live feed (read-only) -------------------------------
# A deploy command's exit code is not proof the assistant can read the data.
echo "[6/6] Verifying the live feed..."
if bash "$SCRIPT_DIR/verify-feed.sh"; then
  echo "  ✓ feed verified."
else
  echo "  ✗ the feed verification FAILED — Lina cannot answer 'каде е X?' from it."
  echo "    Read the ✗ lines above. Do not call this deploy green."
  exit 1
fi
echo ""

# --- Done ---
echo "=== deploy-supabase: finished $(date -Iseconds) ==="
echo ""
echo "Next steps:"
echo "  1. Set HERMES_LANDMARKS_WRITE_URL in ~/.lina/lina.env to the deployed"
echo "     function URL (see docs/deploy-landmarks.md for the exact URL)."
echo "  2. On T60: npm run hermes:landmarks:feed"
echo "  3. Ask the bot \"КАЈ СЕ НАОЃА 76?\" — expect a landmark + a coordinate pin."
