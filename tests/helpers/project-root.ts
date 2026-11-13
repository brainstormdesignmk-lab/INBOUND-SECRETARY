// findProjectRoot — resolve the REPO root from a test file's own directory.
//
// WHY THIS EXISTS: twelve source-scanning tests (route coverage, the bank code
// guards, the pool-rotation sweep) read `src/*.ts` TEXT at test time. A naive
// `path.resolve(__dirname, '..')` is right under tsx (`tests/`) and WRONG under
// the bundled runner, where the file lives in `dist-test/tests/` and `..` is
// `dist-test` — the sweep then died with ENOENT: dist-test/src (2026-11-13,
// surfaced the moment each file got its own TAP file and the failure detail
// stopped being shredded by the parallel reporter).
//
// The marker is the pair (package.json, src/): dist-test has neither, the repo
// root has both, and a linked copy of a geo test inside another atom's tree
// still resolves to whatever root actually contains the sources.
import * as path from 'path';
import { existsSync } from 'fs';

export function findProjectRoot(from: string = __dirname): string {
  let dir = path.resolve(from);
  for (let i = 0; i < 6 && dir !== path.dirname(dir); i++) {
    if (existsSync(path.join(dir, 'package.json')) && existsSync(path.join(dir, 'src'))) return dir;
    dir = path.dirname(dir);
  }
  // Nothing found: hand back the historical answer so the caller's own
  // readFileSync/readdirSync throws its clear ENOENT instead of a silent ''.
  return path.resolve(from, '..');
}
