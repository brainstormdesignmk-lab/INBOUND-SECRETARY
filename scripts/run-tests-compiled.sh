#!/usr/bin/env bash
# run-tests-compiled.sh — thin delegate to scripts/test-run.mjs.
#
# The bundling lives in ONE place now. This script used to drive `node --test`
# over all bundles at once, which piped every file's TAP into one reporter: the
# children's output interleaved and a parallel run could print `# fail 3` with
# no `not ok` detail at all (2026-11-13). It also had no watchdog, so a hung
# file wedged the gate. Both are fixed in the runner, which gives every file its
# own TAP file and kills a file that overruns.
#
# Usage (unchanged):
#   scripts/run-tests-compiled.sh                 # every test file, sharded
#   scripts/run-tests-compiled.sh --skip-slow     # drop the PTY-funnel file
#   scripts/run-tests-compiled.sh tests/a.test.ts tests/b.test.ts
#
# Exit code: 0 only when every selected file passed.
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
exec node scripts/test-run.mjs "$@"
