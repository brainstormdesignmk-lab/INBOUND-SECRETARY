#!/usr/bin/env tsx
/**
 * bank:tui — run the dedicated enrichment review screen.
 *
 * It opens the database IN PLACE (WAL is read through), so the facts are the
 * machine's current ones: no snapshots, no "did I copy the latest file?".
 *
 *   npm run bank:tui                      (data/tui.db — the review master)
 *   npm run bank:tui -- --db data/lina.db (explicit diagnostic override)
 *
 * The default is the workstation review master. Atom databases are selected
 * as read-only sources; their missing bank entries are staged here for review.
 *
 * ORDERING WARNING (regression 2026-10-23): the project imports below are
 * dynamic on purpose. src/bank/tui.ts → loopB → src/config calls
 * `dotenv.config({ path: ~/.lina/lina.env })` AT IMPORT TIME, which silently
 * sets `process.env.DB_PATH` (lina.env carries DB_PATH=data/lina.db). If the
 * static imports ran first, run.ts read DB_PATH after that side effect and
 * every plain `npm run bank:tui` opened the appliance export instead of the
 * review master. The path is therefore resolved BEFORE anything that can
 * touch process.env loads; only a genuinely exported DB_PATH is honored here.
 */
import * as fs from 'fs';
import * as path from 'path';
// liveDb imports nothing project-side — safe to load before the resolution.
import { REVIEW_MASTER_DB } from './liveDb';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const dbI = args.indexOf('--db');
  if (dbI >= 0 && !args[dbI + 1]) {
    console.error('[bank:tui] --db needs a path');
    process.exit(1);
  }

  // Read argv/env BEFORE importing the TUI chain — see ORDERING WARNING.
  const explicit = dbI >= 0 ? args[dbI + 1] : process.env.DB_PATH;
  const dbPath = explicit ? path.resolve(process.cwd(), explicit) : path.resolve(process.cwd(), REVIEW_MASTER_DB);

  if (!fs.existsSync(dbPath)) {
    console.error(`[bank:tui] no such database: ${dbPath}`);
    process.exit(1);
  }

  await import('../compat/node16');
  const { Db } = await import('../store/db');
  const { BankReview } = await import('./review');
  const { BankReviewTui } = await import('./tui');

  // blessed needs a real terminal. Without one it enters and leaves the
  // alt-screen immediately, so a piped/redirected run used to look like "it does
  // not run": exit 0, no output, nothing said. Say it instead.
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error('[bank:tui] needs an interactive terminal — stdin/stdout is not a TTY (run it directly, not through a pipe or `... | tee`)');
    process.exit(1);
  }

  try {
    const db = new Db(dbPath);
    new BankReviewTui(new BankReview(db), dbPath, { projectRoot: process.cwd() }).start();
  } catch (e) {
    console.error(`[bank:tui] ${(e as Error).message}`);
    process.exit(1);
  }
}

main().catch(error => { console.error('[bank:tui] fatal:', error); process.exit(1); });
