#!/usr/bin/env bash
# push-bank.sh — return the WORKSTATION's enriched learned bank to an atom
# (the 2026-09-26 workflow: enrichment runs on the workstation's 3 Gemini
# keys; the atom's single key starves on 503s).
#
#   bash scripts/push-bank.sh [atomId]      # default: atom01
#
# Mechanics: the workstation lina.db's bank_* tables are exported to SQL and
# replayed inside a transaction on the atom:
#   - bank_variants: INSERT OR IGNORE (UNIQUE key,text) — atom-side rows the
#     workstation lacks survive; active workstation rows the atom lacks land.
#   - lifecycle WINS over the atom's copy for the SAME (key,text): a variant
#     retired on the workstation (poison sweep) stays retired on the atom.
#   - bank_examples: INSERT OR IGNORE — retrieval teaching follows the bank.
#   - enrichment_queue: the atom's OWN queue rows are marked enriched=1
#     (they were processed on the workstation; the atom keeps the audit trail).
# The atom DB is snapshotted to a .bak first; the replay is transactional.
set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ATOMS_CONF="scripts/atoms.conf"
ID="${1:-atom01}"
WS_DB="${DB_PATH:-data/lina.db}"

[ -f "$WS_DB" ] || { echo "FATAL: workstation db $WS_DB missing"; exit 1; }

while IFS='|' read -r aid host user key rpath note; do
  case "$aid" in ''|\#*) continue;; esac
  [ "$aid" = "$ID" ] || continue
  base="${key%_KEY}"; base="${base,,}"; base="${base//_}"
  keyfile="$HOME/.ssh/id_ed25519_$base"
  [ -f "$keyfile" ] || { echo "FATAL: no ssh key at $keyfile"; exit 1; }

  echo "── push-bank → $aid ($host) ──"
  ssh -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=8 -i "$keyfile" "$user@$host" \
    "cd '$rpath' && sqlite3 data/lina.db '.backup \"data/lina.db.bak-pushbank-$(date +%s)\"'" \
    && echo "  ✓ atom db backed up" || { echo "FATAL: backup failed — aborting"; exit 1; }

  TMP=$(mktemp /tmp/lina-bank-XXXX.sql)
  {
    echo "BEGIN TRANSACTION;"
    # Variants: insert missing rows, then let the workstation lifecycle win
    # for rows that already existed on the atom.
    sqlite3 "$WS_DB" "SELECT printf('INSERT OR IGNORE INTO bank_variants (key,text,source,lifecycle,note,created_at) VALUES (%Q,%Q,%Q,%Q,%Q,%s);', key, text, source, lifecycle, COALESCE(note,''), created_at) FROM bank_variants;"
    sqlite3 "$WS_DB" "SELECT printf('UPDATE bank_variants SET lifecycle=%Q, note=COALESCE(%Q,note) WHERE key=%Q AND text=%Q;', lifecycle, COALESCE(note,''), key, text) FROM bank_variants;"
    # Examples: insert-or-ignore (key,msg) — retrieval teaching follows.
    sqlite3 "$WS_DB" "SELECT printf('INSERT OR IGNORE INTO bank_examples (key,msg) VALUES (%Q,%Q);', key, msg) FROM bank_examples;"
    # The atom's pending queue was processed workstation-side.
    echo "UPDATE enrichment_queue SET enriched=1 WHERE enriched=0;"
    echo "COMMIT;"
  } > "$TMP"

  scp -q -o BatchMode=yes -o IdentitiesOnly=yes -i "$keyfile" "$TMP" "$user@$host:/tmp/lina-bank.sql" \
    && ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "$keyfile" "$user@$host" \
       "cd '$rpath' && sqlite3 data/lina.db < /tmp/lina-bank.sql && rm -f /tmp/lina-bank.sql" \
    && echo "  ✓ bank replayed" || { echo "FATAL: replay failed"; rm -f "$TMP"; exit 1; }
  rm -f "$TMP"

  counts=$(ssh -o BatchMode=yes -o IdentitiesOnly=yes -i "$keyfile" "$user@$host" \
    "sqlite3 '$rpath/data/lina.db' 'SELECT COUNT(*) FROM bank_variants; SELECT COUNT(*) FROM bank_examples; SELECT COUNT(*) FROM enrichment_queue WHERE enriched=0;' | tr '\n' ' '")
  echo "  → atom now: variants/examples/pending = $counts"
  exit 0
done < "$ATOMS_CONF"
echo "FATAL: atom '$ID' not found or not enabled in $ATOMS_CONF"
exit 1
