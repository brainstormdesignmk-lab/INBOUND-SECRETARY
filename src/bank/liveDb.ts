/**
 * The operator/review master is always the workstation TUI database. The
 * appliance `data/lina.db` remains the runtime/export database, not a competing
 * review target; choosing by mtime is unsafe because opening a DB can touch it.
 */
import * as path from 'path';

/** Canonical operator/review database. `data/lina.db` is an export only. */
export const REVIEW_MASTER_DB = 'data/tui.db';

/** Resolve the sole database used by review and bank workflows. */
export function pickLiveDb(cwd: string): string {
  return path.resolve(cwd, REVIEW_MASTER_DB);
}
