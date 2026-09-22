#!/usr/bin/env tsx
/**
 * bank:fallback-census — P4 visibility: which orphan lines fired, how often.
 *
 * The P4 capture logs every inline ?? '…' fallback serve as FALLBACK_ORPHAN
 * (bankKey null). This census answers the operator question: "what is Lina
 * saying that exists nowhere in the bank?" — by reply text, by state, and
 * how many pending groups the nightly cron will turn into learn.* keys.
 *
 *   npm run bank:fallback-census            — text + state tables
 *   npm run bank:fallback-census -- --days 14
 */

import '../src/compat/node16';

import { Db } from '../src/store/db';
import { loadConfig } from '../src/config';

const db = new Db(loadConfig().dbPath);
const days = Number(process.argv[process.argv.indexOf('--days') + 1] ?? 30) || 30;
const since = Date.now() - days * 86400_000;

interface Row { replyText: string; state: string; userMsg: string; n: number }

const byText = db.db.prepare(`
  SELECT reply_text AS replyText, COUNT(*) AS n
  FROM enrichment_queue
  WHERE event_type = 'FALLBACK_ORPHAN' AND created_at >= ?
  GROUP BY reply_text ORDER BY n DESC LIMIT 20
`).all(since) as Row[];

const byState = db.db.prepare(`
  SELECT state, COUNT(*) AS n
  FROM enrichment_queue
  WHERE event_type = 'FALLBACK_ORPHAN' AND created_at >= ?
  GROUP BY state ORDER BY n DESC
`).all(since) as Row[];

const total = byState.reduce((a, r) => a + r.n, 0);
const pendingGroups = db.db.prepare(`
  SELECT COUNT(*) AS n FROM (
    SELECT DISTINCT state FROM enrichment_queue
    WHERE event_type = 'FALLBACK_ORPHAN' AND enriched = 0 AND created_at >= ?
  )
`).get(since) as { n: number };

if (total === 0) {
  console.log(`✓ fallback census (${days}d): no orphan serves logged — every reply had a bank identity.`);
  process.exit(0);
}

console.log(`═ FALLBACK CENSUS (${days}d) — ${total} orphan serve(s) ═\n`);
console.log('By reply text (the anonymous lines):');
for (const r of byText.slice(0, 10)) {
  console.log(`  ${String(r.n).padStart(3)}× [${r.replyText.length} ch] ${r.replyText.slice(0, 90)}${r.replyText.length > 90 ? '…' : ''}`);
}
console.log('\nBy state:');
for (const r of byState) console.log(`  ${String(r.n).padStart(3)}× ${r.state}`);
console.log(`\n${pendingGroups.n} state group(s) pending → nightly cron will bank frequent ones as learn.* keys (contract-gated).`);
console.log('Promote a banked learn.* key into a proper named key via bank:review once wording is approved.');
process.exit(0);
