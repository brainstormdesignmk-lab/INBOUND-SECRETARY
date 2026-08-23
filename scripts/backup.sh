#!/usr/bin/env bash
# backup.sh — Full backup of Supabase FREEBUFF project to local storage.
# On-demand (not cron). Run manually when you want a snapshot.
#
# Usage:
#   ./scripts/backup.sh                     # backup to default dir
#   ./scripts/backup.sh /path/to/backup     # custom backup dir
#
# Requires:
#   - SUPABASE_URL (or FREEBUFF env var) — project REST API base
#   - SUPABASE_ANON_KEY — anon key for public storage access
#   - Management API access token (from ~/.supabase/access-token)
#   - curl, jq, sqlite3

set -euo pipefail

# --- Config ---
PROJECT_REF="${SUPABASE_PROJECT_REF:-euuaycmxfqiruspwjxhd}"
BACKUP_DIR="${1:-/home/metropolis2/Documents/NEKRETNINI/backup}"
REST_URL="https://${PROJECT_REF}.supabase.co/rest/v1"
STORAGE_URL="https://${PROJECT_REF}.supabase.co/storage/v1/object/public/property-images"
MGMT_TOKEN=$(cat ~/.supabase/access-token 2>/dev/null || echo "")
DATE=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Tables to back up (all public tables)
TABLES=(
  "properties"
  "property_images"
  "property_contacts"
  "customer_leads"
  "hermes_events"
  "landmark_resolution_log"
  "owner_lookup_log"
  "price_change_log"
  "price_changes"
  "profiles"
)

# Parse anon key from Management API if not set
if [ -z "${SUPABASE_ANON_KEY:-}" ]; then
  echo "[backup] Fetching anon key from Management API..."
  SUPABASE_ANON_KEY=$(curl -s "https://api.supabase.com/v1/projects/${PROJECT_REF}/api-keys" \
    -H "Authorization: Bearer $MGMT_TOKEN" | \
    python3 -c "import json,sys; data=json.load(sys.stdin); print(next(k['api_key'] for k in data if k['name']=='anon'))")
  export SUPABASE_ANON_KEY
fi

echo "=== Supabase Full Backup ==="
echo "Project:   $PROJECT_REF"
echo "Backup to: $BACKUP_DIR"
echo "Date:      $DATE"
echo ""

# --- Create directory structure ---
mkdir -p "$BACKUP_DIR/json"
mkdir -p "$BACKUP_DIR/images"

# --- Pull all tables as JSON ---
echo "--- Pulling tables ---"
for TABLE in "${TABLES[@]}"; do
  echo -n "  $TABLE... "
  # Pull all rows (pagination: use offset/limit to get everything)
  OFFSET=0
  LIMIT=1000
  ALL_ROWS="[]"
  while true; do
    BATCH=$(curl -s "${REST_URL}/${TABLE}?select=*&order=created_at&offset=${OFFSET}&limit=${LIMIT}" \
      -H "apikey: ${SUPABASE_ANON_KEY}" \
      -H "Authorization: Bearer ${SUPABASE_ANON_KEY}" \
      -H "Prefer: return=representation" 2>/dev/null || echo "[]")
    COUNT=$(echo "$BATCH" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
    if [ "$COUNT" -eq 0 ]; then
      break
    fi
    ALL_ROWS=$(python3 -c "
import json, sys
existing = json.loads('''${ALL_ROWS}''') if '''${ALL_ROWS}''' != '[]' else []
new = json.loads(sys.stdin.read())
existing.extend(new)
print(json.dumps(existing))
" <<< "$BATCH")
    OFFSET=$((OFFSET + LIMIT))
    if [ "$COUNT" -lt "$LIMIT" ]; then
      break
    fi
  done
  echo "$ALL_ROWS" > "$BACKUP_DIR/json/${TABLE}.json"
  ROW_COUNT=$(echo "$ALL_ROWS" | python3 -c "import json,sys; print(len(json.load(sys.stdin)))" 2>/dev/null || echo "0")
  echo "$ROW_COUNT rows"
done

# --- Download images ---
echo ""
echo "--- Downloading images ---"
IMAGES_JSON="$BACKUP_DIR/json/property_images.json"
if [ -f "$IMAGES_JSON" ]; then
  # Extract unique property numbers from properties.json
  PROPS_JSON="$BACKUP_DIR/json/properties.json"
  python3 << 'PYEOF'
import json, os, subprocess, sys

backup_dir = os.environ.get("BACKUP_DIR", ".")
images_json = os.path.join(backup_dir, "json/property_images.json")
props_json = os.path.join(backup_dir, "json/properties.json")
images_dir = os.path.join(backup_dir, "images")
storage_url = os.environ.get("STORAGE_URL", "")

try:
    with open(images_json) as f:
        images = json.load(f)
except:
    images = []

try:
    with open(props_json) as f:
        props = json.load(f)
except:
    props = []

# Build property_number → id mapping
id_to_pn = {}
for p in props:
    id_to_pn[p.get("id", "")] = p.get("property_number", "unknown")

downloaded = 0
skipped = 0
failed = 0

for img in images:
    prop_id = img.get("property_id", "")
    image_url = img.get("image_url", "")
    if not image_url:
        continue

    pn = id_to_pn.get(prop_id, prop_id[:8])
    prop_dir = os.path.join(images_dir, str(pn))
    os.makedirs(prop_dir, exist_ok=True)

    # Extract filename from URL
    filename = image_url.split("/")[-1].split("?")[0]
    dest = os.path.join(prop_dir, filename)

    if os.path.exists(dest):
        skipped += 1
        continue

    # Download
    try:
        full_url = f"{storage_url}/{image_url}" if not image_url.startswith("http") else image_url
        result = subprocess.run(
            ["curl", "-sL", "-o", dest, full_url],
            timeout=30, capture_output=True
        )
        if result.returncode == 0 and os.path.exists(dest) and os.path.getsize(dest) > 100:
            downloaded += 1
        else:
            failed += 1
            if os.path.exists(dest):
                os.remove(dest)
    except:
        failed += 1

print(f"  Downloaded: {downloaded}, Skipped (exists): {skipped}, Failed: {failed}")
PYEOF
  echo ""
else
  echo "  No images to download."
fi

# --- Create local SQLite mirror ---
echo ""
echo "--- Creating local SQLite mirror ---"
DB_PATH="$BACKUP_DIR/lina.db"
rm -f "$DB_PATH"

python3 << PYEOF
import json, sqlite3, os

backup_dir = "$BACKUP_DIR"
db_path = "$DB_PATH"

conn = sqlite3.connect(db_path)
c = conn.cursor()

# Read properties and create table
with open(os.path.join(backup_dir, "json/properties.json")) as f:
    props = json.load(f)

if props:
    # Create properties table from first row
    cols = list(props[0].keys())
    col_defs = ", ".join(f'"{col}" TEXT' for col in cols)
    c.execute(f"CREATE TABLE IF NOT EXISTS properties ({col_defs})")
    for p in props:
        placeholders = ", ".join("?" * len(cols))
        vals = [json.dumps(v) if isinstance(v, (dict, list)) else v for v in [p.get(col) for col in cols]]
        c.execute(f"INSERT INTO properties VALUES ({placeholders})", vals)

# Read property_images
with open(os.path.join(backup_dir, "json/property_images.json")) as f:
    images = json.load(f)

if images:
    cols = list(images[0].keys())
    col_defs = ", ".join(f'"{col}" TEXT' for col in cols)
    c.execute(f"CREATE TABLE IF NOT EXISTS property_images ({col_defs})")
    for img in images:
        placeholders = ", ".join("?" * len(cols))
        vals = [json.dumps(v) if isinstance(v, (dict, list)) else v for v in [img.get(col) for col in cols]]
        c.execute(f"INSERT INTO property_images VALUES ({placeholders})", vals)

# Read other tables
for table_name in ["customer_leads", "hermes_events", "price_changes", "profiles"]:
    filepath = os.path.join(backup_dir, f"json/{table_name}.json")
    if os.path.exists(filepath):
        with open(filepath) as f:
            rows = json.load(f)
        if rows:
            cols = list(rows[0].keys())
            col_defs = ", ".join(f'"{col}" TEXT' for col in cols)
            c.execute(f"CREATE TABLE IF NOT EXISTS {table_name} ({col_defs})")
            for row in rows:
                placeholders = ", ".join("?" * len(cols))
                vals = [json.dumps(v) if isinstance(v, (dict, list)) else v for v in [row.get(col) for col in cols]]
                c.execute(f"INSERT INTO {table_name} VALUES ({placeholders})", vals)

conn.commit()
conn.close()

prop_count = len(props)
img_count = len(images)
print(f"  SQLite created: {db_path}")
print(f"  Properties: {prop_count}, Images: {img_count}")
PYEOF

# --- Write sync state ---
echo ""
echo "--- Writing sync state ---"
python3 << PYEOF
import json, os

state = {
    "lastSync": "$DATE",
    "projectRef": "$PROJECT_REF",
    "backupDir": "$BACKUP_DIR",
    "tables": {}
}

backup_dir = "$BACKUP_DIR"
for table in ${TABLES[@]};  # note: this is bash array expansion
    filepath = os.path.join(backup_dir, f"json/{table}.json")
    if os.path.exists(filepath):
        with open(filepath) as f:
            state["tables"][table] = len(json.load(f))

with open(os.path.join(backup_dir, "sync-state.json"), "w") as f:
    json.dump(state, f, indent=2)

print(f"  Sync state written: {os.path.join(backup_dir, 'sync-state.json')}")
PYEOF

# --- Summary ---
echo ""
echo "=== Backup Complete ==="
echo "Location: $BACKUP_DIR"
echo "Tables: ${#TABLES[@]}"
echo "SQLite: $DB_PATH"
echo ""
echo "To serve locally:"
echo "  cd $BACKUP_DIR && python3 -m http.server 3000"
echo ""
echo "To restore to Supabase:"
echo "  ./scripts/restore.sh $BACKUP_DIR"
