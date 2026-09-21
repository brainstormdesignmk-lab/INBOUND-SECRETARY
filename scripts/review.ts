#!/usr/bin/env tsx
/**
 * bank:review — the human gate of the closed loop.
 *
 * Queues:
 *   new       unprocessed corrections ([F9] intake, quality-gate rejects)
 *   staged    the runner couldn't resolve, or a gate failed
 *   processed resolved + gated (informational audit trail)
 *
 * This CLI is also the ONLY path that unlocks a frozen-key regeneration
 * (Loop B, phase P2 — wired when the constraints layer lands).
 *
 * Usage:
 *   npx tsx scripts/review.ts list [new|staged|processed|counts]
 *   npx tsx scripts/review.ts show <id>
 *   npx tsx scripts/review.ts resolve <id> <family>     # force-resolve
 *   npx tsx scripts/review.ts reject <id> [reason]      # mark human-rejected
 *   npx tsx scripts/review.ts rerun                     # retry all staged
 */

import '../src/compat/node16';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { FAMILIES } from './sweep-keys';

const bank = new BankStore(new Db(process.argv.includes('--db') ? process.argv[process.argv.indexOf('--db') + 1] : 'data/lina.db'));
const familyIds = FAMILIES.map(f => f.id);

function main(): void {
  const [cmd, arg, ...rest] = process.argv.slice(2);
  if (cmd === 'counts' || !cmd) {
    const counts = bank.correctionCounts();
    console.log('new:', counts.new ?? 0, ' staged:', counts.staged ?? 0, ' processed:', counts.processed ?? 0, ' rejected:', counts.rejected ?? 0);
    console.log('\nknown families:', familyIds.length, '— use `list new` to work the queue');
    // P0 meters digest: the review opens with the coverage picture, not an
    // empty queue you have to eyeball. Meters are read-only over bank_metrics.
    try {
      const { spawnSync } = require('child_process');
      const r = spawnSync('npx', ['tsx', 'scripts/bank-meters.ts', '--report'], { encoding: 'utf-8' });
      if (r.status === 0 && r.stdout) console.log('\n' + r.stdout.trim().split('\n').slice(-4).join('\n'));
      else if (r.stdout) console.log('\n' + r.stdout.trim().split('\n').slice(-4).join('\n'));
    } catch { /* meters are advisory — never block the queue view */ }
    return;
  }
  if (cmd === 'list') {
    const status = arg ?? 'new';
    const rows = bank.correctionsByStatus(status);
    if (rows.length === 0) { console.log(`(${status}: empty)`); return; }
    for (const r of rows) {
      console.log(`#${r.id} [${r.family ?? '—'}] "${r.msg.slice(0, 58)}"`);
      console.log(`      reply: "${r.reply.slice(0, 70)}" · reason: ${r.reason.slice(0, 50)}`);
    }
    return;
  }
  if (cmd === 'show') {
    const rows = [...bank.correctionsByStatus('new'), ...bank.correctionsByStatus('staged'), ...bank.correctionsByStatus('processed')];
    const r = rows.find(x => x.id === Number(arg));
    if (!r) { console.log(`#${arg}: not found`); return; }
    console.log(JSON.stringify(r, null, 2));
    // What would fire today?
    const hits = FAMILIES.filter(f => { try { return f.target(r.msg); } catch { return false; } }).map(f => f.id);
    console.log('families that fire on this msg today:', hits.length ? hits.join(', ') : '(none)');
    return;
  }
  if (cmd === 'resolve') {
    const id = Number(arg);
    const family = rest[0];
    if (!familyIds.includes(family)) { console.log(`unknown family "${family}" — known:\n  ${familyIds.join('\n  ')}`); return; }
    bank.correctionResolve(id, family);
    console.log(`#${id} → ${family} (append with the next loop-a run: add it to the corpus manually or rerun)`);
    return;
  }
  if (cmd === 'reject') {
    const id = Number(arg);
    new Db('data/lina.db').db.prepare(`UPDATE bank_corrections SET status = 'rejected', reason = ?, resolved_at = ? WHERE id = ?`)
      .run(`human-rejected: ${rest.join(' ') || 'no reason'}`, Date.now(), id);
    console.log(`#${id} rejected`);
    return;
  }
  if (cmd === 'rerun') {
    console.log('resetting staged → new for retry');
    const db = new Db(process.argv.includes('--db') ? process.argv[process.argv.indexOf('--db') + 1] : 'data/lina.db');
    db.db.exec(`UPDATE bank_corrections SET status = 'new' WHERE status = 'staged'`);
    console.log('run: npx tsx scripts/loop-a.ts');
    return;
  }
  console.log('usage: review.ts list|show|resolve|reject|rerun …');
}

main();
