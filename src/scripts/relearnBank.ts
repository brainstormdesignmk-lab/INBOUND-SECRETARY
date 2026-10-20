// bank:relearn-bank — the NO-MODEL half of the learning loop, compiled.
//
// `scripts/relearn.ts` (bank:relearn) needs tsx and can therefore only run on
// the workstation. The atoms run COMPILED code and have no tsx (the 2026-10-07
// `sh: 1: tsx: not found` lesson), so the housekeeping that spends no Gemini
// keys lives here, in src/, and ships as dist/scripts/relearnBank.js.
//
// Four commands, none of which calls a model:
//   --digest-dynamic        fold dynamic groups into examples + STAGED answers
//                           (a human still promotes prose with bank:review)
//   --pending               list captures still waiting for a key
//   --bind <id> <key>       bind ONE phrase verbatim to an existing bank key
//   --bind-file <path>      bind MANY: "<id> <key>" per line (or id=key)
//
// A bind writes no prose and answers no question: "this phrasing means that
// key" is a routing fact. The dynamic row is retired on success because
// `retrieveDynamicExact` runs BEFORE the example match — leaving it would keep
// the generated answer shadowing the binding.
//
// Usage:
//   node dist/scripts/relearnBank.js --pending [--db data/lina.db]
//   node dist/scripts/relearnBank.js --bind 12 visit.confirm.ask
//   node dist/scripts/relearnBank.js --bind-file binds.txt
//   node dist/scripts/relearnBank.js --digest-dynamic
//
// Exit code: 0 = everything applied / nothing to do, 1 = a bind was refused,
// read the file and said no, or the args are wrong.

import '../compat/node16';

import * as fs from 'fs';
import * as path from 'path';

import { loadConfig } from '../config';
import { Db } from '../store/db';
import { BankStore } from '../store/bank';
import { RESPONSE_BANK } from '../data/responses';
import { digestDynamic, bindMany, parseBindFile, BindEntry } from '../store/digest';

export interface BankCliCtx {
  bank: BankStore;
  db: Db;
}

/** Keys that can actually answer: a seed line or an active learned variant. */
function servable(bank: BankStore): (key: string) => boolean {
  return (key: string) => (RESPONSE_BANK[key]?.length ?? 0) > 0 || bank.variants(key).length > 0;
}

function printPending(bank: BankStore): void {
  const rows = bank.pendingDynamic();
  if (rows.length === 0) {
    console.log('[pending] no dynamic rows awaiting a binding');
    return;
  }
  for (const r of rows) {
    console.log(`  #${r.id}  [${r.state}]  "${r.msg.slice(0, 90)}${r.msg.length > 90 ? '…' : ''}"`);
  }
  console.log(`\n[${rows.length}] pending · bind: --bind <id> <key> (verbatim, no model call)`);
}

/** Apply entries, print one line each, return the number that failed. */
function applyBinds(bank: BankStore, entries: BindEntry[]): number {
  const outcomes = bindMany(bank, entries, servable(bank));
  let failed = 0;
  for (const o of outcomes) {
    if (!o.ok) {
      failed++;
      console.error(`✗ #${o.id} → ${o.key}: ${o.reason}`);
    } else if (o.added) {
      console.log(`✓ bound "${o.msg}" → ${o.key} (verbatim; dynamic row #${o.id} retired)`);
    } else {
      console.log(`• #${o.id} → ${o.key}: ${o.reason ?? 'already bound'} (row retired)`);
    }
  }
  return failed;
}

/**
 * Run one of this CLI's commands, or return undefined when `argv` names none of
 * them (so `scripts/relearn.ts` can fall through to its LLM commands).
 */
export function main(argv: string[], ctx?: BankCliCtx): number | undefined {
  const has = (flag: string) => argv.includes(flag);
  const after = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv.slice(i + 1).filter(a => !a.startsWith('--')) : [];
  };
  const ours = has('--digest-dynamic') || has('--pending') || has('--bind') || has('--bind-file');
  if (!ours) return undefined;

  let store = ctx;
  if (!store) {
    const dbArg = after('--db')[0];
    // realpath so a typo can never silently create a NEW empty bank next to the
    // real one (the Db class creates the file on open).
    const dbPath = dbArg ? fs.realpathSync(path.resolve(dbArg)) : loadConfig().dbPath;
    const db = new Db(dbPath);
    store = { bank: new BankStore(db), db };
  }
  const { bank, db } = store;

  if (has('--digest-dynamic')) {
    const r = digestDynamic(bank, db);
    console.log(
      `[digest] ${r.groups} dynamic group(s): +${r.examples} retrieval examples, ` +
      `${r.staged} answer variant(s) staged for review, ${r.purged} purged, ${r.marked} serve row(s) marked`,
    );
    return 0;
  }

  if (has('--bind-file')) {
    const file = after('--bind-file')[0];
    if (!file) {
      console.error('usage: --bind-file <path>   (one "<id> <key>" per line)');
      return 1;
    }
    let text: string;
    try {
      text = fs.readFileSync(path.resolve(file), 'utf8');
    } catch (e) {
      console.error(`✗ cannot read ${file}: ${(e as Error).message}`);
      return 1;
    }
    const { entries, errors } = parseBindFile(text);
    for (const err of errors) console.error(`✗ ${err}`);
    if (entries.length === 0) {
      console.error('[bind-file] nothing to bind');
      return 1;
    }
    const failed = applyBinds(bank, entries);
    console.log(`[bind-file] ${entries.length - failed}/${entries.length} bound, ${errors.length} bad line(s)`);
    return failed === 0 && errors.length === 0 ? 0 : 1;
  }

  if (has('--bind')) {
    const rest = after('--bind');
    if (rest.length < 2 || !/^\d+$/.test(rest[0])) {
      console.error('usage: --bind <dynamicId> <bankKey>');
      return 1;
    }
    return applyBinds(bank, [{ id: Number(rest[0]), key: rest[1] }]) === 0 ? 0 : 1;
  }

  printPending(bank);
  return 0;
}

// Entry-point guard: scripts/relearn.ts imports `main` for the same commands,
// and importing it must not run a command with the importer's argv.
if (require.main === module) {
  process.exit(main(process.argv.slice(2)) ?? 0);
}
