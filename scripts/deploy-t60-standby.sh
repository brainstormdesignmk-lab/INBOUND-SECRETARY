#!/usr/bin/env bash
# deploy-t60-standby.sh — push the workstation code, dist/ and (optionally) the
# brain to the T60 STANDBY, restart it through its own supervisor, and verify it
# is actually serving.
#
# Why this is not a row in scripts/atoms.conf: the T60 is not an atom clone.
#   • it runs a PINNED Node 18 userland (~/.local/node18) because better-sqlite3
#     8.7.0 has no node-22 build and the box has no sudo — an atom ships node 16
#     and a prebuilt node_modules in its image;
#   • it has no @reboot/nohup contract: it is supervised by cron running
#     ~/t60/bin/supervise.sh, which also owns images + hub on that box, so the
#     restart goes THROUGH the supervisor (a bare nohup would leave the health
#     check and the reboot path disagreeing);
#   • deploy-atoms.sh's no-cron policy would DELETE that supervisor line. The
#     standby's cron is the point.
#
# The standby is passive: the relay routes to the ATOM, so this box answers
# nobody. It exists so a failed atom can be swapped for it in one edit, which is
# also why it carries the SAME brain — a standby with an older tui.db is a worse
# copy, not a backup.
#
# Usage:
#   npm run t60:deploy                  # code + dist, leave the brain alone
#   npm run t60:deploy -- --with-db     # also push the workstation tui.db
#   npm run t60:deploy -- --dry-run     # rsync -n + print the remote plan
#   npm run t60:deploy -- --no-restart  # push, leave the standby running
#
# Env overrides: T60_HOST T60_USER T60_KEY T60_RPATH T60_NODE T60_PORT T60_SUPERVISOR
#
# Exit code: 0 when the standby is healthy at the end, 1 otherwise.

set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.."   # project root, wherever we're called from

T60_HOST="${T60_HOST:-192.168.1.20}"
T60_USER="${T60_USER:-metropolis4}"
# The key must be passed EXPLICITLY: the standby only accepts this identity and
# ssh offers the default keys first, which fails auth instead of falling through.
T60_KEY="${T60_KEY:-$HOME/.ssh/id_ed25519_t60}"
T60_RPATH="${T60_RPATH:-/home/metropolis4/LINA}"
T60_NODE="${T60_NODE:-/home/metropolis4/.local/node18/bin/node}"
T60_PORT="${T60_PORT:-8080}"
T60_SUPERVISOR="${T60_SUPERVISOR:-/home/metropolis4/t60/bin/supervise.sh}"
DEPS_STAMP=".t60/lina-deps-hash"   # outside the tree, so rsync --delete cannot eat it

EXCLUDE_FROM="scripts/rsync-exclude.txt"
[ -f "$EXCLUDE_FROM" ] || { echo "FATAL: $EXCLUDE_FROM missing"; exit 1; }

DRY_RUN=0; DO_RESTART=1; DO_DB=0
for arg in "$@"; do
  case "$arg" in
    --dry-run)    DRY_RUN=1 ;;
    --no-restart) DO_RESTART=0 ;;
    --with-db)    DO_DB=1 ;;
    *) echo "FATAL: unknown argument: $arg"; exit 1 ;;
  esac
done

# ── build first: a compile error must abort before the standby is touched, and
#    the push is --delete (an incomplete dist/ would erase the remote's files).
echo "── building dist/ on the workstation ──"
if [ "$DRY_RUN" = "1" ]; then
  echo "[dry-run] skipping build"
else
  npm run build --silent || { echo "FATAL: build failed — standby untouched"; exit 1; }
fi
[ -f dist/index.js ] || { echo "FATAL: dist/index.js missing — build did not run"; exit 1; }

# ── brain snapshot (.backup, not cp: the live brain is in WAL mode and a plain
#    copy loses everything still in data/tui.db-wal). Verified before any push.
DB_SNAPSHOT=""; DB_SHA=""
if [ "$DO_DB" = "1" ]; then
  echo "── snapshotting the workstation brain (data/tui.db) ──"
  command -v sqlite3 >/dev/null 2>&1 || { echo "FATAL: sqlite3 is not installed — cannot snapshot the WAL brain"; exit 1; }
  [ -f data/tui.db ] || { echo "FATAL: data/tui.db missing on the workstation"; exit 1; }
  DB_SNAPSHOT="$(mktemp /tmp/lina-brain-XXXXXX.db)"
  trap 'rm -f "$DB_SNAPSHOT"' EXIT
  sqlite3 data/tui.db ".backup '$DB_SNAPSHOT'" || { echo "FATAL: sqlite3 .backup failed — standby untouched"; exit 1; }
  integrity="$(sqlite3 "$DB_SNAPSHOT" 'pragma integrity_check;' 2>&1)"
  [ "$integrity" = "ok" ] || { echo "FATAL: snapshot integrity_check = $integrity — standby untouched"; exit 1; }
  DB_SHA="$(sha256sum "$DB_SNAPSHOT" | cut -d' ' -f1)"
  # Three columns, one line — the sqlite3 CLI separates them with '|'. Building
  # the line with SQL concatenation needs quotes inside a shell-quoted query and
  # silently produced an empty summary before (an "ok" with no numbers).
  counts_raw="$(sqlite3 "$DB_SNAPSHOT" \
    'select (select count(*) from bank_variants), (select count(*) from bank_examples), (select count(*) from events);' \
    2>/dev/null || true)"
  [ -n "$counts_raw" ] || { echo "FATAL: the snapshot has no bank tables — wrong file? standby untouched"; exit 1; }
  echo "    ✓ snapshot $(stat -c %s "$DB_SNAPSHOT") bytes — integrity ok, variants/examples/events=$(echo "$counts_raw" | tr '|' '/')"
  echo "      sha256 ${DB_SHA:0:16}…"
fi

[ -f "$T60_KEY" ] || { echo "FATAL: no ssh key at $T60_KEY — the standby cannot be reached without it"; exit 1; }

# THE TRANSPORT DECIDES REACHABILITY, NOT ICMP. The gate used to be `ping -c1`,
# and on 2026-11-27 a live standby (ssh fine, rsync fine, /health ok) was
# reported "does not answer ping — standby unreachable" while the box was
# serving traffic: the network drops ICMP, so the deploy refused to run and the
# standby silently stayed one commit behind. Probe what the deploy actually uses.
if ! ssh -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=8 -i "$T60_KEY" \
    "$T60_USER@$T60_HOST" true 2>/dev/null; then
  echo "FATAL: $T60_USER@$T60_HOST does not accept ssh — standby unreachable"; exit 1
fi
SSH=(ssh -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=8 -i "$T60_KEY" "$T60_USER@$T60_HOST")
RSYNC_SSH="ssh -o BatchMode=yes -o IdentitiesOnly=yes -o ConnectTimeout=8 -i $T60_KEY"

# ── 1) code + dist -----------------------------------------------------------
RSYNC_FLAGS=(-az --delete --exclude-from="$EXCLUDE_FROM" -e "$RSYNC_SSH" --timeout=120)
[ "$DRY_RUN" = "1" ] && RSYNC_FLAGS+=(-n -i)
echo "── $T60_HOST:$T60_RPATH ──"
echo "  → rsync code+dist …"
if rsync "${RSYNC_FLAGS[@]}" ./ "$T60_USER@$T60_HOST:$T60_RPATH/" >/tmp/rsync-t60.log 2>&1; then
  changed=$(grep -c '^[<>ch.]' /tmp/rsync-t60.log 2>/dev/null || true)
  echo "    ✓ rsync ok (${changed:-0} entries changed)"
else
  echo "    ✗ rsync FAILED — tail of log:"; tail -5 /tmp/rsync-t60.log | sed 's/^/      /'; exit 1
fi

# ── 1a-bis) THE GEO ENGINE IS A SECOND TREE. rsync carries LINA only, so a fix
#          in src/geo/offlineMap.ts would reach the standby as a link to the
#          OLD vocabulary while this script reported a clean deploy. Ship the
#          tree the standby's own link resolves to — the dev box's fleet deploy
#          (deploy-atoms.sh) carries the same step.
GEO_SRC=$(readlink -f ./src/geo)
if [ -d "$GEO_SRC" ]; then
  if [ "$DRY_RUN" = "1" ]; then
    echo "  [dry-run] would rsync $GEO_SRC → the standby's src/geo target"
  else
    # The path is REMOTE: an empty answer means the link does not resolve.
    GEO_DST=$("${SSH[@]}" "readlink -f '$T60_RPATH/src/geo'" 2>/dev/null || true)
    if [ -z "$GEO_DST" ]; then
      echo "  ✗ the standby's src/geo does not resolve (run node scripts/link-geo.js there) — the geo fix would NOT be live"; exit 1
    fi
    if rsync -az --delete -e "$RSYNC_SSH" --timeout=120 "$GEO_SRC/" "$T60_USER@$T60_HOST:$GEO_DST/" >/tmp/rsync-geo-t60.log 2>&1; then
      echo "  ✓ geo engine synced ($GEO_DST)"
    else
      echo "  ✗ geo rsync FAILED — tail:"; tail -5 /tmp/rsync-geo-t60.log | sed 's/^/      /'; exit 1
    fi
  fi
fi

# ── 1b) dependencies ONLY when the lockfile actually changed. npm ci rebuilds
#        node_modules from scratch; running it on every deploy is how a box with
#        no compiler ends up with a native module built for the wrong ABI.
LOCK_SHA="$(sha256sum package-lock.json | cut -d' ' -f1)"
REMOTE_LOCK="$("${SSH[@]}" "sha256sum '$T60_RPATH/package-lock.json' 2>/dev/null | cut -d' ' -f1" || true)"
REMOTE_STAMP="$("${SSH[@]}" "cat ~/$DEPS_STAMP 2>/dev/null" || true)"
if [ "$REMOTE_LOCK" != "$LOCK_SHA" ]; then
  echo "  ✗ package-lock.json did not reach the standby intact (local ${LOCK_SHA:0:16}… vs remote ${REMOTE_LOCK:0:16}…)"; exit 1
fi
if [ "$REMOTE_STAMP" = "$LOCK_SHA" ]; then
  echo "  → dependencies unchanged (lock ${LOCK_SHA:0:16}…) — skipping npm ci"
elif [ "$DRY_RUN" = "1" ]; then
  echo "  [dry-run] would run npm ci on the standby (lock changed)"
else
  echo "  → lockfile changed — npm ci on the standby …"
  # npm MUST run under the pinned node 18: better-sqlite3 8.7.0 ships no node-22
  # build, so the box's default npm (node 22) falls through to node-gyp — and
  # this box has no compiler, so the install dies (measured 2026-11-17). npm is
  # a `#!/usr/bin/env node` script, so putting node 18 first on PATH is what
  # pins it; `npm ci` installs for the runtime that runs it.
  if "${SSH[@]}" "cd '$T60_RPATH' && PATH=\$HOME/.local/node18/bin:\$PATH npm ci --omit=dev --no-audit --no-fund >/tmp/npm-ci-t60.log 2>&1" ; then
    # PROVE the native module loads under the runtime that will run the bot, not
    # under whatever npm used: an ABI mismatch is invisible until the bot opens
    # the brain, i.e. exactly at swap time.
    if "${SSH[@]}" "cd '$T60_RPATH' && '$T60_NODE' -e 'require(\"better-sqlite3\")' " >/tmp/bs3-t60.log 2>&1; then
      "${SSH[@]}" "mkdir -p ~/$(dirname "$DEPS_STAMP") && echo '$LOCK_SHA' > ~/$DEPS_STAMP"
      echo "    ✓ npm ci ok — better-sqlite3 loads under $T60_NODE"
    else
      echo "    ✗ npm ci finished but better-sqlite3 will not load under $T60_NODE:"
      tail -5 /tmp/bs3-t60.log | sed 's/^/      /'
      echo "      (the standby was NOT stopped — its running process is untouched)"
      exit 1
    fi
  else
    echo "    ✗ npm ci FAILED — tail:"; "${SSH[@]}" "tail -8 /tmp/npm-ci-t60.log" | sed 's/^/      /'; exit 1
  fi
fi

# ── 1c) stage the brain beside the live file (installed during the restart) ---
if [ "$DO_DB" = "1" ]; then
  echo "  → staging the brain (data/tui.db.incoming) …"
  if [ "$DRY_RUN" = "1" ]; then
    echo "    [dry-run] would rsync the snapshot to $T60_RPATH/data/tui.db.incoming"
  elif rsync -az -e "$RSYNC_SSH" --timeout=120 "$DB_SNAPSHOT" "$T60_USER@$T60_HOST:$T60_RPATH/data/tui.db.incoming"; then
    remote_sha="$("${SSH[@]}" "sha256sum '$T60_RPATH/data/tui.db.incoming' | cut -d' ' -f1")"
    if [ "$remote_sha" = "$DB_SHA" ]; then
      echo "    ✓ brain staged and verified byte-for-byte"
    else
      echo "    ✗ brain arrived CORRUPT (sha ${remote_sha:0:16}… ≠ ${DB_SHA:0:16}…) — not installing"; exit 1
    fi
  else
    echo "    ✗ brain push FAILED"; exit 1
  fi
fi

if [ "$DO_RESTART" = "0" ]; then
  echo "  ⚠ --no-restart: code is live on disk but the running standby still uses the old process"
  [ "$DO_DB" = "1" ] && echo "    (the brain is staged as data/tui.db.incoming and installs on the next restart)"
  exit 0
fi

# ── 2) stop → install brain → start through the supervisor -------------------
echo "  → restarting the standby (supervised: kill cwd+exe matched, then supervise.sh) …"
if [ "$DRY_RUN" = "1" ]; then
  echo "    [dry-run] would kill the cwd+exe-matched node, install the staged brain, run $T60_SUPERVISOR"
else
  if ! "${SSH[@]}" bash -s "$T60_RPATH" "$T60_NODE" "$T60_SUPERVISOR" "${DB_SHA:--}" <<'REMOTE'
set -u
RPATH="${1:?remote path}"; NODE="${2:?node binary}"; SUP="${3:?supervisor}"; SHA_EXPECT="${4:--}"
# EVERY relative path below (data/tui.db.incoming, -wal/-shm) is meaningless
# without this: the ssh session starts in the login home, so "data/…" pointed at
# ~/data/… and the install silently matched nothing while still reporting a
# healthy standby (caught 2026-11-17: the live brain kept sha 22526… instead of
# the pushed 79f15…, and only the row counts matched).
cd "$RPATH" || { echo "cannot enter $RPATH"; exit 5; }
# A bot is cwd (this dir) AND exe (the pinned node) — a wrapper shell that merely
# has "node dist/index.js" in its command line is not a bot (measured 2026-11-17:
# the pid file pointed at the wrapper). Same rule as deploy-atoms.sh.
botpids() {
  for pid in $(pgrep -f 'node .*dist/index\.js' 2>/dev/null); do
    [ "$(readlink /proc/$pid/cwd 2>/dev/null)" = "$RPATH" ] || continue
    [ "$(readlink /proc/$pid/exe 2>/dev/null)" = "$NODE" ] || continue
    echo "$pid"
  done
}
for pid in $(botpids); do kill "$pid" 2>/dev/null && echo "killed $pid"; done
for i in $(seq 1 30); do [ -z "$(botpids)" ] && break; sleep 1; done
if [ -n "$(botpids)" ]; then
  for pid in $(botpids); do kill -9 "$pid" 2>/dev/null && echo "SIGKILL $pid (would not close)"; done
  for i in $(seq 1 5); do [ -z "$(botpids)" ] && break; sleep 1; done
fi
if [ -n "$(botpids)" ]; then echo 'OLD PROCESS STILL ALIVE AFTER SIGKILL — not starting a second one'; exit 3; fi
# No bot holds the old file now: this is the only safe instant to swap the brain.
# The previous -wal/-shm belong to a different file and would be replayed onto it.
if [ -f data/tui.db.incoming ]; then
  rm -f data/tui.db-wal data/tui.db-shm
  if ! mv -f data/tui.db.incoming data/tui.db; then echo 'BRAIN INSTALL FAILED — still on the previous tui.db'; exit 6; fi
  echo "installed fresh brain: $(stat -c %s data/tui.db) bytes"
  # Compare CONTENT, not counts: two different brains can hold the same number of
  # rows, which is exactly how a skipped install passed the check before.
  if [ "$SHA_EXPECT" != "-" ]; then
    got="$(sha256sum data/tui.db | cut -d' ' -f1)"
    [ "$got" = "$SHA_EXPECT" ] || { echo "installed brain is NOT the pushed one ($got ≠ $SHA_EXPECT)"; exit 7; }
    echo "brain sha verified: ${got:0:16}…"
  fi
fi
# The supervisor owns start AND health; calling it (cron does the same every 5
# min) keeps one code path for "how LINA comes up on this box".
bash "$SUP" || { echo "supervisor exited non-zero"; exit 4; }
REMOTE
  then
    echo "    ✗ restart FAILED"; exit 1
  fi
fi

# ── 3) prove it, from on the box --------------------------------------------
sleep 5
alive=$("${SSH[@]}" "n=0; for pid in \$(pgrep -f 'node .*dist/index\.js' 2>/dev/null); do [ \"\$(readlink /proc/\$pid/cwd 2>/dev/null)\" = '$T60_RPATH' ] || continue; [ \"\$(readlink /proc/\$pid/exe 2>/dev/null)\" = '$T60_NODE' ] || continue; n=\$((n+1)); done; echo \$n")
# "not up yet" and "never came up" must be told apart: the boot opens the DB,
# checks the bank and loads the offline map before listen().
health=$("${SSH[@]}" "for i in \$(seq 1 20); do body=\$(curl -fsS --max-time 3 'http://127.0.0.1:$T60_PORT/health' 2>/dev/null); [ -n \"\$body\" ] && { echo \"\$body\"; exit 0; }; sleep 1; done; exit 1" || true)
if [ "${alive:-0}" = "1" ] && echo "$health" | grep -q '"ok":true'; then
  echo "    ✓ process alive (cwd+exe-matched: 1)"
  echo "    ✓ /health on 127.0.0.1:$T60_PORT — $health"
else
  echo "    ✗ standby is not serving (pid-matched: ${alive:-0}, /health: ${health:-no answer}) — last boot lines:"
  "${SSH[@]}" "tail -15 '$T60_RPATH/logs/lina-stdout.log'" | sed 's/^/      /'; exit 1
fi

# The brain the STANDBY holds must be the brain we pushed (a standby on an old
# brain fails exactly when it is needed). Read through better-sqlite3, i.e. the
# same engine the bot uses, so an ABI mismatch surfaces here and not at swap time.
if [ "$DO_DB" = "1" ]; then
  got=$("${SSH[@]}" "cd '$T60_RPATH' && '$T60_NODE' -e '
    const D=require(\"better-sqlite3\"); const d=new D(process.argv[1],{readonly:true});
    const c=(t)=>d.prepare(\"select count(*) c from \"+t).get().c;
    console.log(\"variants=\"+c(\"bank_variants\")+\" examples=\"+c(\"bank_examples\")+\" events=\"+c(\"events\"));
  ' data/tui.db" 2>&1)
  echo "    ✓ standby brain: $got"
  echo "$got" | grep -q 'variants=0' && { echo "    ✗ standby brain is EMPTY — the push did not land"; exit 1; }
fi

boot=$("${SSH[@]}" "grep -E 'offline-map|Lina online|llmProvider' '$T60_RPATH/logs/lina-stdout.log' | tail -3")
[ -n "$boot" ] && echo "$boot" | sed 's/^/      /'
echo "✓ standby healthy at $T60_HOST:$T60_RPATH"
