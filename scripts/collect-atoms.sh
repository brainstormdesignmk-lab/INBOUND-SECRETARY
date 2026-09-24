#!/usr/bin/env bash
# collect-atoms.sh — the reverse path of deploy-atoms.sh: the workstation PULLS
# each atom's self-enrichment artifacts into data/atoms/<atomId>/ so they can
# be reviewed and promoted into the repo corpus (data/hardening/, bank) by
# hand. Atoms never push; the workstation is the only git writer.
#
# What is collected per atom (see rsync-exclude.txt "learned state" block):
#   data/enrichment-log.json     → data/atoms/<id>/enrichment-log.json
#   data/address-overrides.json  → data/atoms/<id>/address-overrides.json
#   data/feed-corrections.md     → data/atoms/<id>/feed-corrections.md
#   data/hardening/*.json        → data/atoms/<id>/hardening/   (atom-appended GAP rows)
#   logs/enrich.log (tail 500)   → data/atoms/<id>/enrich.tail.log
#   crontab LINA_* lines         → data/atoms/<id>/crontab.txt  (ops visibility)
#
# Nothing here is committed automatically. Review, promote winners into the
# repo corpus, commit — the next atoms:deploy teaches every atom at once.
#
# Usage:
#   npm run atoms:collect                    # all enabled atoms
#   npm run atoms:collect -- --atoms atom01  # subset
#   npm run atoms:collect -- --dry-run
#
# Exit code: 0 if every targeted atom was collected, 1 otherwise.

set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ATOMS_CONF="scripts/atoms.conf"
DRY_RUN=0; WANT=""
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --atoms)   WANT="SET" ;;
    --atoms=*) WANT="${arg#--atoms=}" ;;
    *) if [ "$WANT" = "SET" ]; then WANT="$arg"; fi ;;
  esac
done

[ -f "$ATOMS_CONF" ] || { echo "FATAL: $ATOMS_CONF missing"; exit 1; }
mkdir -p data/atoms

declare -a RESULTS=()
while IFS='|' read -r id host user key rpath note; do
  case "$id" in ''|\#*) continue;; esac
  [ -n "$WANT" ] && [[ ",$WANT," != *",$id,"* ]] && continue
  if [[ "$note" == *RELAY* || "$note" == *relay* ]]; then
    echo "· $id: RELAY — skipped by design ($note)"; continue
  fi
  base="${key%_KEY}"; base="${base,,}"; base="${base//_}"
  keyfile="$HOME/.ssh/id_ed25519_$base"
  [ -f "$keyfile" ] || { echo "· $id: no ssh key at $keyfile — skipped"; RESULTS+=("$id|SKIP(no-key)"); continue; }
  ping -c1 -W2 "$host" >/dev/null 2>&1 || { echo "· $id ($host): DOWN — skipped"; RESULTS+=("$id|DOWN"); continue; }

  SSH=(ssh -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=8 -i "$keyfile" "$user@$host")
  RSYNC_SSH="ssh -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=8 -i $keyfile"
  dest="data/atoms/$id"
  mkdir -p "$dest/hardening"
  echo "── $id ($host) ──"

  # Availability probe before any file moves.
  if ! "${SSH[@]}" "test -d '$rpath/data'" 2>/dev/null; then
    echo "  ✗ unreachable or missing $rpath/data — skipped"
    RESULTS+=("$id|UNREACHABLE"); continue
  fi

  pull() { # pull <relative-path> [dest-name]
    local rel="$1" name="${2:-$(basename "$1")}"
    if [ "$DRY_RUN" = "1" ]; then echo "  [dry-run] $rel → $dest/$name"; return 0; fi
    if rsync -az -e "$RSYNC_SSH" --timeout=60 \
        "$user@$host:$rpath/$rel" "$dest/$name" 2>/dev/null; then
      echo "  ✓ $rel"
    else
      echo "  · $rel (absent — ok)"
    fi
  }

  pull data/enrichment-log.json
  pull data/address-overrides.json
  pull data/feed-corrections.md

  # Per-atom hardening corpora (GAP rows the atom appended itself).
  if [ "$DRY_RUN" = "1" ]; then
    echo "  [dry-run] data/hardening/*.json → $dest/hardening/"
  else
    if rsync -az -e "$RSYNC_SSH" --timeout=60 \
        "$user@$host:$rpath/data/hardening/" "$dest/hardening/" 2>/dev/null; then
      n=$(find "$dest/hardening" -name '*.json' | wc -l)
      echo "  ✓ data/hardening/ ($n file(s))"
    else
      echo "  · data/hardening/ (absent — ok)"
    fi
  fi

  # Human-readable enrich log tail + crontab snapshot for ops review.
  if [ "$DRY_RUN" = "1" ]; then
    echo "  [dry-run] logs/enrich.log tail → $dest/enrich.tail.log"
    echo "  [dry-run] crontab LINA_* → $dest/crontab.txt"
  else
    "${SSH[@]}" "tail -n 500 '$rpath/logs/enrich.log' 2>/dev/null" > "$dest/enrich.tail.log" 2>/dev/null \
      && echo "  ✓ enrich.tail.log ($(wc -l < "$dest/enrich.tail.log") lines)" \
      || echo "  · enrich.tail.log (absent — ok)"
    "${SSH[@]}" "crontab -l 2>/dev/null | grep LINA_" > "$dest/crontab.txt" 2>/dev/null \
      && echo "  ✓ crontab.txt" || echo "  · crontab.txt (no LINA lines)"
  fi

  # Stamp the collection metadata.
  if [ "$DRY_RUN" = "0" ]; then
    printf '{\n  "atomId": "%s",\n  "host": "%s",\n  "collectedAt": "%s"\n}\n' \
      "$id" "$host" "$(date -Iseconds)" > "$dest/collect-meta.json"
  fi
  RESULTS+=("$id|OK")
  echo ""
done < "$ATOMS_CONF"

echo "══ collect summary ══"
rc=0
for r in "${RESULTS[@]:-}"; do
  [ -z "$r" ] && continue
  id="${r%%|*}"; st="${r#*|}"
  echo "  $id: $st — review data/atoms/$id/ and promote winners into the repo corpus"
  [ "$st" != "OK" ] && rc=1
done
[ ${#RESULTS[@]} -eq 0 ] && { echo "  (no atoms matched — check --atoms / atoms.conf)"; rc=1; }
exit $rc
