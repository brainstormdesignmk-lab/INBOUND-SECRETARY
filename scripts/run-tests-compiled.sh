#!/usr/bin/env bash
# run-tests-compiled.sh — the FAST suite: bundle each test file with esbuild and
# run plain `node --test`, instead of paying tsx boot + transpile per file.
#
# WHY: with `tsx --test tests/*.test.ts` every one of the 116 files pays
# ~0.9 s of tsx boot + ~2.7 s transpiling the handler graph before a single
# assertion runs — ~100 s of wall time on this 4-core box. Bundling is
# type-check-free and fast (~0.2 s per file), and a bundle loads in ~1.3 s.
#
# Type safety is NOT given up: `npm run typecheck` (tsc --noEmit) still gates
# `src/`. The tests were never type-checked by it (tsconfig.json excludes
# tests/), so nothing is lost relative to the tsx run.
#
# Usage:
#   scripts/run-tests-compiled.sh                 # every test file
#   scripts/run-tests-compiled.sh --skip-slow     # drop the PTY-funnel file
#   scripts/run-tests-compiled.sh tests/a.test.ts tests/b.test.ts
#
# Exit code: the `node --test` exit code (1 on any failure).
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

ESBUILD="node_modules/.bin/esbuild"
OUT="dist-test"
SKIP_SLOW=0
FILES=()
for arg in "$@"; do
  case "$arg" in
    --skip-slow) SKIP_SLOW=1 ;;
    *) FILES+=("$arg") ;;
  esac
done

if [ "${#FILES[@]}" -eq 0 ]; then
  while IFS= read -r f; do FILES+=("$f"); done < <(ls tests/*.test.ts)
fi

# The PTY funnel boots the real TUI twice (~60 s of wall, little CPU): it is the
# pre-deploy check, not the inner-loop one.
if [ "$SKIP_SLOW" = "1" ]; then
  FILTERED=()
  for f in "${FILES[@]}"; do
    case "$f" in *tui-pty-funnel*) continue ;; esac
    FILTERED+=("$f")
  done
  FILES=("${FILTERED[@]}")
fi

rm -rf "$OUT"
# --define:require.main=undefined — hermesLandmarks.ts (and anything else with a
# CLI body) guards its main() with `require.main === module`. Inside a bundle the
# bundle IS the main module, so that guard turns true and the script's whole CLI
# runs (live LLM calls, a hang) every time a test imports so much as one helper
# from it. Neutralizing the guard for the bundled test run is what keeps the
# suite hermetic; the real CLI runs unbundled and is unaffected.
"$ESBUILD" "${FILES[@]}" \
  --bundle --platform=node --format=cjs --packages=external \
  --define:require.main=undefined \
  --outbase=. --outdir="$OUT" --log-level=error || exit 1

# Fixture files are read relative to __dirname by some tests.
[ -d tests/fixtures ] && cp -r tests/fixtures "$OUT/tests/"

BUNDLES=()
for f in "${FILES[@]}"; do BUNDLES+=("$OUT/${f%.ts}.js"); done

# CONCURRENCY: the suite is LATENCY-bound, not CPU-bound (a full run measures
# ~1.8 of 4 cores busy — server tests, timers, the PTY harness all wait).
# Oversubscribing the cores therefore shortens the wall, while node's default
# (= cpu count) leaves three quarters of the machine idle during the waits.
# Override with TEST_CONCURRENCY=n.
CONCURRENCY="${TEST_CONCURRENCY:-$(( $(nproc) * 2 ))}"

node --test --test-concurrency="$CONCURRENCY" "${BUNDLES[@]}"
