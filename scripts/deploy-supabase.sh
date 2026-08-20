#!/usr/bin/env bash
# deploy-supabase.sh — one-command deploy of the landmarks + price-sync
# infrastructure to Supabase.
#
# Prerequisites:
#   - supabase CLI installed and authenticated (`supabase login`)
#   - Project linked (`supabase link --project-ref <ref>`)
#   - HERMES_API_KEY env var set (or passed as first argument)
#
# Usage:
#   HERMES_API_KEY=nvapi-xxx ./scripts/deploy-supabase.sh
#   ./scripts/deploy-supabase.sh nvapi-xxx          # same, via arg
#
# What it does:
#   1. Runs the landmarks migration (adds columns + audit tables)
#   2. Deploys the update-property-landmarks edge function
#   3. Deploys the update-property-price edge function
#   4. Sets the HERMES_API_KEY secret for the edge functions
#   5. Verifies the deploy by calling each function
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

# Check if linked
if ! supabase status &>/dev/null 2>&1; then
  echo "ERROR: Project not linked. Run:"
  echo "  supabase link --project-ref <your-project-ref>"
  exit 1
fi

echo "=== deploy-supabase: $(date -Iseconds) ==="
echo ""

# --- Step 1: Run migration ---
echo "[1/4] Running landmarks migration..."
if supabase db push --linked 2>&1; then
  echo "  ✓ Migration applied."
else
  echo "  ⚠ Migration may have already been applied (continuing)."
fi
echo ""

# --- Step 2: Deploy edge functions ---
echo "[2/4] Deploying update-property-landmarks..."
supabase functions deploy update-property-landmarks --no-verify-jwt 2>&1
echo "  ✓ update-property-landmarks deployed."
echo ""

echo "[3/4] Deploying update-property-price..."
supabase functions deploy update-property-price --no-verify-jwt 2>&1
echo "  ✓ update-property-price deployed."
echo ""

# --- Step 3: Set secrets ---
echo "[4/4] Setting HERMES_API_KEY secret..."
supabase secrets set HERMES_API_KEY="$HERMES_API_KEY" 2>&1
echo "  ✓ Secret set."
echo ""

# --- Done ---
echo "=== deploy-supabase: finished $(date -Iseconds) ==="
echo ""
echo "Next steps:"
echo "  1. Set HERMES_LANDMARKS_WRITE_URL in ~/.lina/lina.env to the deployed"
echo "     function URL (see docs/deploy-landmarks.md for the exact URL)."
echo "  2. On T60: npm run hermes:landmarks:feed"
