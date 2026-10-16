#!/usr/bin/env bash
# deploy-atoms.sh — push workstation code to the LINA atom fleet, restart each
# bot, verify a healthy boot, and ENFORCE THE NO-CRON POLICY on every atom.
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
#   - NO CRONS ANYWHERE (2026-10-14): every atom is UNSCHEDULED by design. It
#     accumulates what it learned in its own data/lina.db and logs/enrich.log;
#     the workstation collects that later (collect-atoms.sh), a human reviews
#     it, and only then does anything change. This script removes scheduled
#     jobs from each atom and keeps only the @reboot autostart (boot recovery,
#     not a job). See scripts/install-cron.ts + scripts/cron-policy.ts in the
#     maps repo for the policy and its tests.
#
# Usage:
#   npm run atoms:deploy                    # all enabled atoms
#   npm run atoms:deploy -- --atoms atom01  # subset (comma-separated)
#   npm run atoms:deploy -- --dry-run       # rsync -n + print remote commands
#   npm run atoms:deploy -- --no-restart    # push code, leave the bot running
#   npm run atoms:deploy -- --skip-cron     # don't enforce the no-cron policy
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

# ── 0b) RETIRED DUPLICATES must not exist in this repo.
#        refresh-monthly.ts and geo-watcher.ts were pre-extraction forks of the
#        maps-realestate originals (cwd-relative logic, nothing referenced them).
#        They are excluded in rsync-exclude.txt so a stray copy cannot reach an
#        atom — but an exclusion ALSO protects a receiver file from --delete,
#        which is exactly why their absence is asserted here instead of assumed:
#        a copy that reappeared would sit excluded and silently diverge from the
#        real one on the source machine.
for f in scripts/refresh-monthly.ts scripts/geo-watcher.ts; do
  if [ -e "$f" ]; then
    echo "FATAL: retired duplicate is back: $f"
    echo "  maps-realestate owns this file (single source). Delete it here — it is"
    echo "  excluded from rsync, so shipping it would leave every atom on whatever"
    echo "  stale copy it already has while the source moved on."
    exit 1
  fi
done

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

  # 1b) recreate the machine-local src/geo link. The geo engine lives in the
  #     maps-realestate project (single source of truth) and rsync never carries
  #     it — the path differs per machine — so the target links it here, before
  #     anything tries to build or run against it.
  echo "  → linking src/geo → maps-realestate …"
  if [ "$DRY_RUN" = "1" ]; then
    # Record a result in dry-run too. RESULTS was only appended in the RESTART
    # branch, so a dry-run left it empty and the summary printed "no atoms
    # matched" with exit 1 — i.e. the pre-deploy check reported failure no
    # matter what. A dry-run that always fails is worse than none.
    echo "    [dry-run] would run node scripts/link-geo.js on the target"
    RESULTS+=("$id|DRY-RUN")
  else
    "${SSH[@]}" "cd '$rpath' && node scripts/link-geo.js" || { echo "    ✗ link-geo FAILED"; RESULTS+=("$id|LINK-FAIL"); continue; }
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

  # 4) NO MAP JOB MAY BE SCHEDULED — on the atom too (the policy applies ANYWHERE).
  #
  #    THE DECISION (2026-10-14): no MAP job is scheduled. The map is a fixed
  #    artifact and the learning loop is human-gated — the atom accumulates what
  #    it learned in its own data/lina.db, the WORKSTATION collects it
  #    (collect-atoms.sh), a human reviews it, and only then does anything
  #    change. An atom that enriches itself on a timer is exactly the automation
  #    this decision removes.
  #
  #    Three classes of line exist and they are NOT the same thing:
  #      • a scheduled MAP JOB (refresh-monthly, map pull, hermes-nightly,
  #        healthcheck, enrich) → REMOVED, and the count of survivors is printed.
  #      • the OWNER PRICE SYNC (`*/5 … hermes-price.sh`) → REQUIRED, never
  #        removed, and re-installed if missing. It is not map work: Lina asks
  #        owners for the current price, and each correction sits in
  #        `price_changes` as 'pending' until this job pushes it through the Hub
  #        to the app. A sweep that removed it (2026-10-14) silently froze every
  #        published price, so its presence is now verified on every deploy.
  #      • the `@reboot … # LINA_ATOM` autostart → KEPT. It runs no map work,
  #        spends nothing and learns nothing; it only brings the bot back after
  #        a power cut. Dropping it would leave a rebooted atom dead until
  #        somebody notices. (Removing it is one flag in the maps repo:
  #        `npm run cron:remove -- --remove-reboot`.)
  #
  #    The patterns mirror scripts/cron-policy.ts in the maps repo, which is the
  #    source of truth and is unit-tested there.
  if [ "$DO_CRON" = "1" ]; then
    echo "  → enforcing the policy (removing MAP jobs, keeping the owner sync + @reboot) …"
    if [ "$DRY_RUN" = "1" ]; then
      echo "    [dry-run] would strip MAP jobs and ensure the owner sync (*/5 hermes-price.sh) is installed"
    elif "${SSH[@]}" bash -s "$rpath" <<'REMOTE'
set -u
RPATH="${1:?remote path}"
PAT='refresh-monthly|healthcheck|hermes-nightly|skopje-map-weekly|enrich-cron|enrich-bank|cron-if-primary|LINA_ENRICH|map:pull'

cur="$(crontab -l 2>/dev/null || true)"
now="$(printf '%s\n' "$cur" | sed '/^[[:space:]]*$/d')"
clean="$(printf '%s\n' "$cur" | grep -vE "$PAT" | sed '/^[[:space:]]*$/d')"
if [ "$clean" != "$now" ]; then
  if [ -n "$clean" ]; then printf '%s\n' "$clean" | crontab -; else crontab -r; fi
  echo "    ✓ scheduled MAP job line(s) removed"
else
  echo "    cron: already compliant (no map jobs scheduled)"
fi

# The boot autostart, rebuilt onto one canonical log target (it historically
# wrote ~/lina.log). grep -v + append, NEVER sed: an '&' in a sed replacement
# expands to the whole match and silently corrupts the line (2026-09-24).
crontab -l 2>/dev/null | grep -v 'LINA_ATOM' | sed '/^[[:space:]]*$/d' > /tmp/lina-cron.new || true
echo "@reboot cd $RPATH && nohup node dist/index.js >> $RPATH/logs/lina-stdout.log 2>&1 & # LINA_ATOM" >> /tmp/lina-cron.new

# THE OWNER SYNC MUST BE THERE. Lina's owner price corrections sit in
# `price_changes` as 'pending' until this job pushes them through the Hub — so
# the deploy ENSURES the line exists instead of trusting drift. Without it,
# owners are told a new price and the public listing never changes.
if ! grep -q 'hermes-price.sh' /tmp/lina-cron.new; then
  echo "*/5 * * * * $RPATH/scripts/hermes-price.sh >/dev/null 2>&1" >> /tmp/lina-cron.new
  echo "    ✓ owner price sync installed (*/5 hermes-price.sh)"
else
  echo "    ✓ owner price sync already present (kept — it is required)"
fi

crontab /tmp/lina-cron.new

left="$(crontab -l 2>/dev/null | grep -cE "$PAT" || true)"
echo "    scheduled map jobs remaining: ${left:-0}"
if crontab -l 2>/dev/null | grep -q 'LINA_ATOM'; then
  echo "    ✓ @reboot autostart present (kept — it is not a job)"
else
  echo "    ⚠ @reboot autostart missing — a reboot will not bring Lina back"
fi
if crontab -l 2>/dev/null | grep -q 'hermes-price.sh'; then
  echo "    ✓ owner price sync running (owner corrections reach the app)"
else
  echo "    ✗ owner price sync MISSING — owner price corrections will NOT reach the app"
fi

# log hygiene: rotate a runaway enrich.log instead of letting it eat the disk
if [ -f "$RPATH/logs/enrich.log" ] && [ "$(stat -c%s "$RPATH/logs/enrich.log" 2>/dev/null || echo 0)" -gt 20971520 ]; then
  tail -n 5000 "$RPATH/logs/enrich.log" > "$RPATH/logs/enrich.log.tmp" && mv "$RPATH/logs/enrich.log.tmp" "$RPATH/logs/enrich.log"
  echo "    ✓ enrich.log rotated"
fi
REMOTE
    then
      :
    else
      echo "    ⚠ cron cleanup FAILED on the atom — check its crontab manually"
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
  case "$st" in OK|NOT-RESTARTED|DRY-RUN|SKIP*) ;; *) rc=1 ;; esac
done
[ ${#RESULTS[@]} -eq 0 ] && { echo "  (no atoms matched — check --atoms / atoms.conf)"; rc=1; }
exit $rc
