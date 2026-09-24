#!/usr/bin/env bash
# deploy-atoms.sh — push workstation code to the LINA atom fleet, restart each
# bot, verify a healthy boot, and make sure the per-atom enrichment cron exists.
#
# The fleet contract (see scripts/atoms.conf + scripts/rsync-exclude.txt):
#   - Atoms are clonezilla clones of atom01: node 16.20 + a working
#     node_modules (ABI 93) ship with the image. ONLY code + dist/ are pushed.
#     NEVER push the workstation's node_modules (node 18 / ABI 108 would brick
#     every atom at boot).
#   - The atom's own state (data/*.db, learned files, ~/.lina/lina.env, logs)
#     is excluded from the push — code flows down, state never moves.
#   - The bot runs via @reboot + nohup (no pm2, by decision). Restart =
#     path-anchored kill + the exact same relaunch. The pattern is anchored to
#     PROJECTS/LINA/dist so ANA running on the same box is never touched.
#   - Every atom self-enriches on its own nightly cron and appends to its own
#     logs/enrich.log. The workstation collects artifacts later
#     (collect-atoms.sh); atoms never push anywhere.
#
# Usage:
#   npm run atoms:deploy                    # all enabled atoms
#   npm run atoms:deploy -- --atoms atom01  # subset (comma-separated)
#   npm run atoms:deploy -- --dry-run       # rsync -n + print remote commands
#   npm run atoms:deploy -- --no-restart    # push code, leave the bot running
#   npm run atoms:deploy -- --skip-cron     # don't touch the enrichment cron
#
# Exit code: 0 if every targeted atom is healthy at the end, 1 otherwise.

set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."   # project root, wherever we're called from

ATOMS_CONF="scripts/atoms.conf"
EXCLUDE_FROM="scripts/rsync-exclude.txt"
DRY_RUN=0; DO_RESTART=1; DO_CRON=1; WANT=""
for arg in "$@"; do
  case "$arg" in
    --dry-run)   DRY_RUN=1 ;;
    --no-restart) DO_RESTART=0 ;;
    --skip-cron) DO_CRON=0 ;;
    --atoms)     WANT="SET";; # value read below via next arg
    --atoms=*)   WANT="${arg#--atoms=}" ;;
    *) if [ "$WANT" = "SET" ]; then WANT="$arg"; fi ;;
  esac
done

[ -f "$ATOMS_CONF" ] || { echo "FATAL: $ATOMS_CONF missing"; exit 1; }
[ -f "$EXCLUDE_FROM" ] || { echo "FATAL: $EXCLUDE_FROM missing"; exit 1; }

# ── 0) Build fresh on the workstation FIRST — a compile error must abort the
#       deploy before any atom is touched, and dist/ must be complete because
#       the push is --delete (an incomplete dist would erase atom-side files).
echo "── building dist/ on the workstation ──"
if [ "$DRY_RUN" = "1" ]; then echo "[dry-run] skipping build"; else npm run build --silent || { echo "FATAL: build failed — deploy aborted, atoms untouched"; exit 1; }; fi
[ -f dist/index.js ] || { echo "FATAL: dist/index.js missing — build did not run"; exit 1; }

# ── key token → real file (ATOM01_KEY → ~/.ssh/id_ed25519_atom01) ──
keyfile() {
  local token="$1"
  local base="${token%_KEY}"; base="${base,,}"; base="${base//_}"
  echo "$HOME/.ssh/id_ed25519_$base"
}

echo ""
declare -a NAMES=() RESULTS=()
while IFS='|' read -r id host user key rpath note; do
  case "$id" in ''|\#*) continue;; esac
  [ -n "$WANT" ] && [[ ",$WANT," != *",$id,"* ]] && continue
  if [[ "$note" == *RELAY* || "$note" == *relay* ]]; then
    echo "· $id: RELAY — skipped by design ($note)"; continue
  fi
  key=$(keyfile "$key")
  [ -f "$key" ] || { echo "· $id: no ssh key at $key — skipped (add the key, enable in atoms.conf)"; RESULTS+=("$id|SKIP(no-key)"); continue; }

  SSH=(ssh -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=8 -i "$key" "$user@$host")
  RSYNC_SSH="ssh -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=8 -i $key"
  ping -c1 -W2 "$host" >/dev/null 2>&1 || { echo "· $id ($host): DOWN — skipped"; RESULTS+=("$id|DOWN"); continue; }
  echo "── $id ($host) ──"

  # 1) push code (workstation tree minus excluded state) — --delete makes the
  #    atom's code an exact mirror; excluded paths are invisible to rsync.
  RSYNC_FLAGS=(-az --delete --exclude-from="$EXCLUDE_FROM" -e "$RSYNC_SSH" --timeout=120)
  [ "$DRY_RUN" = "1" ] && RSYNC_FLAGS+=(-n)
  echo "  → rsync code+dist …"
  if rsync "${RSYNC_FLAGS[@]}" ./ "$user@$host:$rpath/" >/tmp/rsync-$id.log 2>&1; then
    echo "    ✓ rsync ok ($(grep -c '^[<>ch.]' /tmp/rsync-$id.log 2>/dev/null || echo '?') entries changed)"
  else
    echo "    ✗ rsync FAILED — tail of log:"; tail -5 /tmp/rsync-$id.log | sed 's/^/      /'
    RESULTS+=("$id|RSYNC-FAIL"); continue
  fi

  if [ "$DO_RESTART" = "1" ]; then
    # 2) restart: the bot's cmdline is RELATIVE ("node dist/index.js", from the
    #    @reboot line) and ANA on the same box may look identical — so LINA
    #    processes are identified by /proc/PID/cwd == the LINA dir. Kill only
    #    those, wait for the port to free, then relaunch exactly like @reboot.
    echo "  → restarting bot (nohup, @reboot-style) …"
    if [ "$DRY_RUN" = "1" ]; then
      echo "    [dry-run] would kill cwd-matched 'node dist/index.js' && nohup node dist/index.js"
    else
      "${SSH[@]}" bash -s <<EOF || { echo "    ✗ restart FAILED"; RESULTS+=("$id|RESTART-FAIL"); continue; }
set -u
cd '$rpath'
mkdir -p logs
for pid in \$(pgrep -f 'node .*dist/index\.js' 2>/dev/null); do
  [ "\$(readlink /proc/\$pid/cwd 2>/dev/null)" = '$rpath' ] && kill "\$pid" 2>/dev/null && echo "killed \$pid"
done
for i in \$(seq 1 10); do
  busy=0
  for pid in \$(pgrep -f 'node .*dist/index\.js' 2>/dev/null); do
    [ "\$(readlink /proc/\$pid/cwd 2>/dev/null)" = '$rpath' ] && busy=1
  done
  [ "\$busy" = "0" ] && break
  sleep 1
done
for pid in \$(pgrep -f 'node .*dist/index\.js' 2>/dev/null); do
  if [ "\$(readlink /proc/\$pid/cwd 2>/dev/null)" = '$rpath' ]; then echo 'OLD PROCESS STILL ALIVE — not starting a second one'; exit 3; fi
done
: > logs/lina-stdout.log
nohup node dist/index.js >> logs/lina-stdout.log 2>&1 &
echo \$! > data/lina.pid
EOF
      # 3) boot verification: cwd-matched process alive AND boot-check lines.
      sleep 5
      alive=$("${SSH[@]}" "n=0; for pid in \$(pgrep -f 'node .*dist/index\.js' 2>/dev/null); do [ \"\$(readlink /proc/\$pid/cwd 2>/dev/null)\" = '$rpath' ] && n=\$((n+1)); done; echo \$n")
      if [ "${alive:-0}" = "1" ]; then
        echo "    ✓ process alive (cwd-matched: 1)"
        checks=$("${SSH[@]}" "grep -E 'Lina online|boot-check' '$rpath/logs/lina-stdout.log' 2>/dev/null | tail -10 || true")
        if [ -n "$checks" ]; then
          echo "$checks" | sed 's/^/      /'
          if echo "$checks" | grep -q '❌'; then echo "    ⚠ boot-check reports failures above (non-fatal for deploy)"; fi
        else
          echo "    ⚠ no boot lines yet — check logs/lina-stdout.log if the bot looks quiet"
        fi
        RESULTS+=("$id|OK")
      else
        echo "    ✗ bot did not come up (processes: ${alive:-0}) — inspect:"
        "${SSH[@]}" "tail -15 '$rpath/logs/lina-stdout.log'" 2>/dev/null | sed 's/^/      /'
        RESULTS+=("$id|BOOT-FAIL")
      fi
    fi
  else
    RESULTS+=("$id|NOT-RESTARTED")
  fi

  # 4) enrichment cron: one nightly line per atom, logged to its own file.
  #    Runs the COMPILED script (plain node) — atoms have no tsx.
  if [ "$DO_CRON" = "1" ]; then
    echo "  → ensuring enrichment cron (03:30 nightly → logs/enrich.log) …"
      CRON_LINE="30 3 * * * cd $rpath && node dist/scripts/enrichBank.js >> $rpath/logs/enrich.log 2>&1 # LINA_ENRICH"
      if [ "$DRY_RUN" = "1" ]; then
        echo "    [dry-run] $CRON_LINE"
      else
        if "${SSH[@]}" "crontab -l 2>/dev/null | grep -q 'LINA_ENRICH'"; then
          echo "    cron already present"
        else
          "${SSH[@]}" "{ crontab -l 2>/dev/null; echo '$CRON_LINE'; } | crontab -" && echo "    ✓ enrich cron added (03:30 nightly)"
        fi
        # One log path everywhere: rebuild the @reboot line with a canonical
        # single log target (logs/lina-stdout.log; it historically wrote
        # ~/lina.log). No sed here — a '&' in a sed replacement expands to the
        # whole match and silently corrupts the line (lesson of 2026-09-24).
        "${SSH[@]}" "crontab -l 2>/dev/null | grep -v 'LINA_ATOM' > /tmp/lina-cron.new; echo '@reboot cd $rpath && nohup node dist/index.js >> $rpath/logs/lina-stdout.log 2>&1 & # LINA_ATOM' >> /tmp/lina-cron.new; crontab /tmp/lina-cron.new" >/dev/null
        # log hygiene: rotate a runaway enrich.log instead of letting it eat the disk
        "${SSH[@]}" "if [ -f '$rpath/logs/enrich.log' ] && [ \$(stat -c%s '$rpath/logs/enrich.log' 2>/dev/null || echo 0) -gt 20971520 ]; then tail -n 5000 '$rpath/logs/enrich.log' > '$rpath/logs/enrich.log.tmp' && mv '$rpath/logs/enrich.log.tmp' '$rpath/logs/enrich.log'; echo rotated; fi" >/dev/null
      fi
  fi
  echo ""
done < "$ATOMS_CONF"

echo "══ deploy summary ══"
rc=0
for r in "${RESULTS[@]:-}"; do
  [ -z "$r" ] && continue
  id="${r%%|*}"; st="${r#*|}"
  echo "  $id: $st"
  case "$st" in OK|NOT-RESTARTED|SKIP*) ;; *) rc=1 ;; esac
done
[ ${#RESULTS[@]} -eq 0 ] && { echo "  (no atoms matched — check --atoms / atoms.conf)"; rc=1; }
exit $rc
