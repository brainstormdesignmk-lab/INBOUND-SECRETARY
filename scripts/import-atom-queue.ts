#!/usr/bin/env tsx
/**
 * import-atom-queue — pull the enrichment queue from a collected atom DB copy
 * into the workstation bank DB, so the WORKSTATION runs the enrichment
 * (3 Gemini keys) instead of the atom's single starved key.
 *
 *   npx tsx scripts/import-atom-queue.ts data/atoms/atom01/lina.db.copy
 *
 * Copy semantics:
 *   enrichment_queue rows with enriched=0 are INSERTED into the workstation
 *   queue (new ids; created_at preserved). bank_variants / bank_examples from
 *   the atom are imported too (dedup by UNIQUE(key,text) — INSERT OR IGNORE),
 *   so atom-side learning survives when the atom's own cron is starved.
 *   LIFECYCLE GUARD: learned variants whose source text fails replyIsClean
 *   (price/EB-template guards) are imported as 'retired' — a poisoned atom
 *   row must not become active on the workstation either.
 *
 * The workstation then runs: npx tsx src/scripts/enrichBank.ts
 * Finally push the enriched bank back: bash scripts/push-bank.sh atom01
 */
import '../src/compat/node16';
import * as fs from 'fs';
import { Db } from '../src/store/db';
import { replyIsClean } from '../src/llm/enrichQuality';

function main() {
  const srcPath = process.argv[2];
  if (!srcPath || !fs.existsSync(srcPath)) {
    console.error('usage: npx tsx scripts/import-atom-queue.ts <atom-db-copy>');
    process.exit(1);
  }
  const src = new Db(srcPath);
  const dst = new Db(process.env.DB_PATH || 'data/lina.db');

  const q = (db: Db, sql: string): any[] => db.db.prepare(sql).all() as any[];
  const run = (db: Db, sql: string, ...args: unknown[]): void => { db.db.prepare(sql).run(...args); };

  // 1. Pending enrichment-queue rows → workstation queue (new ids).
  const pending = q(src, `SELECT chat_id, state, event_type, user_msg, reply_text, reply_source, bank_key, created_at FROM enrichment_queue WHERE enriched=0`);
  let qIns = 0;
  for (const r of pending) {
    const dup = dst.db.prepare(
      `SELECT 1 FROM enrichment_queue WHERE user_msg=? AND reply_text=? AND enriched=0 LIMIT 1`
    ).get(r.user_msg, r.reply_text);
    if (dup) continue;
    run(dst,
      `INSERT INTO enrichment_queue (chat_id, state, event_type, user_msg, reply_text, reply_source, bank_key, created_at, enriched) VALUES (?,?,?,?,?,?,?,?,0)`,
      r.chat_id, r.state, r.event_type, r.user_msg, r.reply_text, r.reply_source, r.bank_key, r.created_at);
    qIns++;
  }

  // 2. Learned bank rows → workstation (variants deduped by the UNIQUE key;
  //    poison-guarded: EB-template/price prose arrives as retired).
  const variants = q(src, `SELECT key, text, source, note FROM bank_variants WHERE lifecycle='active'`);
  let vNew = 0, vRetired = 0;
  for (const v of variants) {
    const exists = dst.db.prepare(`SELECT 1 FROM bank_variants WHERE key=? AND text=? LIMIT 1`).get(v.key, v.text);
    if (exists) continue;
    const clean = replyIsClean(v.text);
    run(dst,
      `INSERT OR IGNORE INTO bank_variants (key, text, source, lifecycle, note, created_at) VALUES (?,?,?,?,?,?)`,
      v.key, v.text, `learned:${srcPath.split('/').slice(-2, -1)[0] || 'atom'}`,
      clean ? 'active' : 'retired',
      clean ? null : 'imported-retired: fails replyIsClean (EB-template/price guard)',
      Date.now());
    if (clean) vNew++; else vRetired++;
  }

  // 3. Retrieval examples → workstation (they teach retrieve() what maps to
  //    which key; without them the imported learn.* keys stay unreachable).
  const examples = q(src, `SELECT key, msg FROM bank_examples`);
  let eNew = 0;
  for (const e of examples) {
    const exists = dst.db.prepare(`SELECT 1 FROM bank_examples WHERE key=? AND msg=? LIMIT 1`).get(e.key, e.msg);
    if (exists) continue;
    // Never import examples that would teach a poisoned shape.
    if (/Евидентен\s+број/i.test(e.msg) || /\b(?:стан|stan|куќ|kukj|имот|imot)[а-яa-z]{0,3}\s+(?:со|so|број|broj)\s*\d/iu.test(e.msg)) continue;
    run(dst, `INSERT INTO bank_examples (key, msg) VALUES (?,?)`, e.key, e.msg);
    eNew++;
  }

  console.log(`imported: ${qIns} queue row(s), ${vNew} new variant(s), ${vRetired} retired-on-arrival, ${eNew} example(s)`);
  console.log(`next:     npx tsx src/scripts/enrichBank.ts   # workstation Gemini enrichment`);
  console.log(`then:     bash scripts/push-bank.sh atom01    # push the enriched bank back`);
  src.close(); dst.close();
}
main();
