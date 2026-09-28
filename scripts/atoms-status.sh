#!/usr/bin/env bash
# atoms-status.sh — THE REMINDERS SURFACE (reminders, not automation).
#
# One command answers every "what state is the fleet in?" question the
# human-gated workflow depends on. It CHANGES nothing: no pushes, no deploys,
# no collects — it reads and reports, so the operator decides. Per atom:
#
#   runtime      health endpoint + serving PID + uptime (is it even alive?)
#   dist drift   md5 of the atom's dist trio vs the workstation's dist/ —
#                catches the Sep-15 stale-runtime class (deploy reported OK,
#                runtime never changed) BEFORE it bites
#   bank drift   atom's active bank_variants vs the workstation master —
#                the push-bank.sh staleness reminder (63 vs 107 right now)
#   queue        atom's unprocessed enrichment_queue rows (pending review fuel)
#   captures     atom-side frontier captures: lines on the atom (uncollected)
#                + lines already pulled into data/atoms/<id>/capture/ (unmined)
#   last push    newest data/lina.db.bak-pushbank-* on the atom (the last
#                time the workstation returned the enriched bank)
#
# Workstation footer: master bank size, TUI capture backlog (unmined), and
# the dist md5 baseline the atoms are compared against.
#
# Usage:
#   npm run atoms:status                    # all enabled atoms
#   npm run atoms:status -- --atoms atom01  # subset
#
# Exit code: 0 if every targeted atom was probed (drift is a REMINDER, not a
# failure), 1 if an atom is unreachable or a probe could not run.

set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ATOMS_CONF="scripts/atoms.conf"
WANT=""
for arg in "$@"; do
  case "$arg" in
    --atoms)   WANT="SET" ;;
    --atoms=*) WANT="${arg#--atoms=}" ;;
    *) if [ "${WANT:-}" = "SET" ]; then WANT="$arg"; fi ;;
  esac
done

[ -f "$ATOMS_CONF" ] || { echo "FATAL: $ATOMS_CONF missing"; exit 1; }
command -v md5sum >/dev/null || { echo "FATAL: md5sum missing"; exit 1; }

# The dist trio both sides hash — index + the two most behavior-critical
# stores. Three files make an accidental half-deploy visible, not just a
# missing file.
DIST_FILES="dist/index.js dist/handlers/inbound.js dist/store/bank.js"
ws_md5=$(md5sum $DIST_FILES 2>/dev/null | md5sum | cut -d' ' -f1)
ws_variants=$(sqlite3 data/lina.db 'SELECT COUNT(*) FROM bank_variants WHERE lifecycle="active"' 2>/dev/null || echo '?')
tui_captures=$(cat data/tui-capture.jsonl 2>/dev/null | grep -c . || true)

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
  ping -c1 -W2 "$host" >/dev/null 2>&1 || { echo "· $id ($host): DOWN"; RESULTS+=("$id|DOWN"); continue; }

  SSH=(ssh -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=8 -i "$keyfile" "$user@$host")
  echo "── $id ($host) ──"

  # ── runtime: health + serving PID + uptime ──
  rt=$("${SSH[@]}" "curl -s -o /dev/null -m 3 -w '%{http_code}' http://localhost:8080/health 2>/dev/null; echo; pid=\$(pgrep -f 'node dist/index.js' | head -1); echo \$pid; [ -n \"\$pid\" ] && ps -o etime= -p \$pid 2>/dev/null" 2>/dev/null)
  code=$(echo "$rt" | sed -n 1p | tr -d '[:space:]')
  pid=$(echo "$rt" | sed -n 2p | tr -d '[:space:]')
  up=$(echo "$rt" | sed -n 3p | tr -d '[:space:]')
  if [ "$code" = "200" ]; then
    echo "  ✓ health 200 · pid ${pid:-?}${up:+ (up $up)}"
  else
    echo "  ✗ health $code${pid:+ · pid $pid (up ${up:-?})} — BOT NOT SERVING"
  fi

  # ── dist drift ──
  atom_md5=$("${SSH[@]}" "cd '$rpath' && md5sum $DIST_FILES 2>/dev/null | md5sum | cut -d' ' -f1" 2>/dev/null)
  if [ -z "$atom_md5" ]; then
    echo "  ✗ dist: probe failed"
    RESULTS+=("$id|PROBE-FAIL"); continue
  elif [ "$atom_md5" = "$ws_md5" ]; then
    echo "  ✓ dist current (md5 ${atom_md5:0:8}…)"
  else
    echo "  ⚠ dist STALE — atom md5 ${atom_md5:0:8}… vs workstation ${ws_md5:0:8}… → run: npm run atoms:deploy -- --atoms $id"
  fi

  # ── bank drift + pending queue ──
  counts=$("${SSH[@]}" "sqlite3 '$rpath/data/lina.db' 'SELECT COUNT(*) FROM bank_variants WHERE lifecycle=\"active\"; SELECT COUNT(*) FROM enrichment_queue WHERE enriched=0;' 2>/dev/null" 2>/dev/null)
  a_variants=$(echo "$counts" | sed -n 1p | tr -d '[:space:]')
  a_pending=$(echo "$counts" | sed -n 2p | tr -d '[:space:]')
  if [ -n "$a_variants" ] && [ "$a_variants" != "$ws_variants" ]; then
    echo "  ⚠ bank drift: atom $a_variants vs master $ws_variants active variants → run: bash scripts/push-bank.sh $id"
  else
    echo "  ✓ bank in sync ($a_variants active variants)"
  fi
  [ -n "$a_pending" ] && [ "$a_pending" != "0" ] && echo "  ⚠ $a_pending unprocessed enrichment_queue rows → npm run atoms:collect -- --atoms $id, then review"

  # ── frontier captures: uncollected (on the atom) + unmined (pulled) ──
  a_cap=$("${SSH[@]}" "cat '$rpath/data/capture/'*.jsonl 2>/dev/null | grep -c ." 2>/dev/null | tail -1 | tr -d '[:space:]')
  a_cap=${a_cap:-0}
  l_cap=$(cat "data/atoms/$id/capture/"*.jsonl 2>/dev/null | grep -c . || true)
  l_cap=${l_cap:-0}
  [ "$a_cap" != "0" ] && echo "  ⚠ $a_cap capture line(s) on the atom, uncollected → npm run atoms:collect -- --atoms $id"
  [ "$l_cap" != "0" ] && echo "  ⏳ $l_cap pulled capture line(s) unmined → data/atoms/$id/capture/ → mine into data/hardening/"
  [ "$a_cap" = "0" ] && [ "$l_cap" = "0" ] && echo "  · no captures pending (uncollected 0 · unmined 0)"

  # ── last bank push (newest push-bank backup on the atom) ──
  lastpush=$("${SSH[@]}" "f=\$(ls -1t '$rpath/data/'lina.db.bak-pushbank-* 2>/dev/null | head -1); [ -n \"\$f\" ] && date -r \"\$f\" +%F" 2>/dev/null | tail -1 | tr -d '[:space:]')
  if [ -n "$lastpush" ]; then
    echo "  · last bank push: $lastpush"
  else
    echo "  ⚠ never pushed since bak-pushbank backups exist — bank may never have been returned"
  fi

  RESULTS+=("$id|OK")
  echo ""
done < "$ATOMS_CONF"

echo "══ workstation ══"
echo "  master bank: $ws_variants active variants · dist md5 ${ws_md5:0:8}…"
[ "$tui_captures" != "0" ] && echo "  ⏳ $tui_captures TUI capture line(s) unmined → data/tui-capture.jsonl → mine into data/hardening/ or import-bank"

echo "══ status summary ══"
rc=0
for r in "${RESULTS[@]:-}"; do
  [ -z "$r" ] && continue
  id="${r%%|*}"; st="${r#*|}"
  echo "  $id: $st"
  { [ "$st" != "OK" ] && [ "$st" != "DOWN" ]; } && rc=1
done
[ ${#RESULTS[@]} -eq 0 ] && { echo "  (no atoms matched — check --atoms / atoms.conf)"; rc=1; }
exit $rc
