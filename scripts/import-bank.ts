#!/usr/bin/env tsx
/**
 * import-bank — THE HUMAN-GATED MERGE POINT of the learning layer.
 *
 * Generalizes scripts/import-atom-queue.ts: accepts ANY source DB that owns a
 * learned bank (the TUI's data/tui.db, an atom snapshot from
 * data/atoms/<id>/lina.db.copy) and folds its ACTIVE variants + retrieval
 * examples into the WORKSTATION master bank (data/lina.db). From there the
 * existing flow ships them: `bash scripts/push-bank.sh <atomId>` →
 * `npm run atoms:deploy`. The workstation stays the only writer; nothing is
 * automatic — this tool runs when YOU decide, after reviewing what the source
 * learned.
 *
 * THE DUPLICATE-WORDING CONTRACT (three levels, cheapest first):
 *   L1 exact       — UNIQUE(key,text) + explicit SELECT (the DB layer)
 *   L2 normalized  — normalizedKey() identity (case/punct/spacing collapse,
 *                    x→кс + ks fold, digits intact): "До 160 000" ≡ "до 160000"
 *   L3 near-dup    — trigram similarity ≥ 0.85 within the same key: near-
 *                    identical wordings do not enter the rotation twice
 * Variants failing replyIsClean (EB-template/price prose — the 09:25 lesson)
 * import as lifecycle='retired' so they exist for audit but never serve.
 * Frozen/data-driven keys and the per-key cap are honored via the same rules
 * BankStore.addVariant uses — this importer never bypasses bank policy.
 *
 * Usage:
 *   npx tsx scripts/import-bank.ts data/tui.db [--dry]
 *   npx tsx scripts/import-bank.ts data/atoms/atom01/lina.db.copy [--dry]
 */
import '../src/compat/node16';
import * as fs from 'fs';
import * as path from 'path';
import { Db } from '../src/store/db';
import { BankStore } from '../src/store/bank';
import { replyIsClean } from '../src/llm/enrichQuality';
import { isExcludedFromEnrichment, MAX_VARIANTS_PER_KEY } from '../src/store/bank';
import { normalizedKey, trigramSimilarity, NEAR_DUP_THRESHOLD } from '../src/llm/dedupe';

export { normalizedKey, trigramSimilarity }; // re-exported for tests/scripts

function main(): void {
  const srcPath = process.argv[2];
  const dry = process.argv.includes('--dry');
  if (!srcPath || !fs.existsSync(srcPath)) {
    console.error('usage: npx tsx scripts/import-bank.ts <source-db> [--dry]');
    console.error('  source: data/tui.db | data/atoms/<id>/lina.db.copy');
    process.exit(1);
  }
  const dstPath = process.env.DB_PATH || 'data/lina.db';
  const src = new Db(srcPath);
  const dst = new Db(dstPath);
  // The lifecycle/note columns arrive with BankStore.migrate() in the app;
  // a standalone script must ensure them itself (source snapshots can be old).
  new BankStore(dst);
  void src.db.prepare("SELECT 1 FROM bank_variants LIMIT 1").get(); // source must have a bank

  const label = srcPath.includes('atoms') ? `atom:${srcPath.split('/')[2] ?? 'x'}` : 'tui';
  const srcVariants = src.db.prepare(
    `SELECT key, text, source, note FROM bank_variants WHERE lifecycle='active'`
  ).all() as Array<{ key: string; text: string; source: string; note?: string }>;
  const dstVariants = dst.db.prepare(
    `SELECT key, text FROM bank_variants WHERE lifecycle IN ('active','staged')`
  ).all() as Array<{ key: string; text: string }>;

  // Index the destination ONCE (L2 identity per key) — O(1) per candidate.
  const dstByKey = new Map<string, { exact: Set<string>; norm: Set<string>; trigrams: Array<{ norm: string; set: Set<string> }> }>();
  const gram = (s: string): Set<string> => {
    const out = new Set<string>();
    const t = ` ${s} `;
    for (let i = 0; i < t.length - 2; i++) out.add(t.slice(i, i + 3));
    return out;
  };
  for (const v of dstVariants) {
    let e = dstByKey.get(v.key);
    if (!e) { e = { exact: new Set(), norm: new Set(), trigrams: [] }; dstByKey.set(v.key, e); }
    e.exact.add(v.text);
    const nk = normalizedKey(v.text);
    e.norm.add(nk);
    e.trigrams.push({ norm: nk, set: gram(nk) });
  }

  const cap = dst.db.prepare(`SELECT COUNT(*) c FROM bank_variants WHERE key=? AND lifecycle='active'`);
  const ins = dst.db.prepare(
    `INSERT OR IGNORE INTO bank_variants (key, text, source, lifecycle, note, created_at) VALUES (?,?,?,?,?,?)`
  );
  const dupIns = dst.db.prepare(
    `INSERT INTO bank_examples (key, msg, created_at) VALUES (?,?,?)`
  );
  const exExists = dst.db.prepare(`SELECT 1 FROM bank_examples WHERE key=? AND msg=? LIMIT 1`);

  let added = 0, retired = 0, skippedExact = 0, skippedNorm = 0, skippedNear = 0, skippedFrozen = 0, skippedCap = 0;
  const pendingExamples: Array<{ key: string; msg: string }> = [];

  for (const v of srcVariants) {
    const text = v.text.trim();
    if (!text) continue;
    if (isExcludedFromEnrichment(v.key)) { skippedFrozen++; continue; }
    const e = dstByKey.get(v.key);
    if (e?.exact.has(text)) { skippedExact++; continue; }              // L1
    const nk = normalizedKey(text);
    if (e?.norm.has(nk)) { skippedNorm++; continue; }                  // L2
    // L3 near-dup — only against this key's existing wordings.
    if (e) {
      const set = gram(nk);
      let twin = false;
      for (const t of e.trigrams) {
        let inter = 0;
        for (const g of set) if (t.set.has(g)) inter++;
        if ((2 * inter) / (set.size + t.set.size) >= NEAR_DUP_THRESHOLD) { twin = true; break; }
      }
      if (twin) { skippedNear++; continue; }
    }
    // Bank policy: the per-key cap (same limit addVariant enforces).
    const active = (cap.get(v.key) as { c: number }).c;
    if (active >= MAX_VARIANTS_PER_KEY) { skippedCap++; continue; }
    // Poison guard: EB-template/price prose imports RETIRED (audit trail
    // only) — the 09:25 learned-slip lesson.
    const clean = replyIsClean(text);
    if (!dry) {
      ins.run(v.key, text, `learned:${label}`, clean ? 'active' : 'retired',
        clean ? (v.note ?? null) : 'imported-retired: fails replyIsClean (EB-template/price guard)',
        Date.now());
      if (!e) { dstByKey.set(v.key, { exact: new Set(), norm: new Set(), trigrams: [] }); }
      const e2 = dstByKey.get(v.key)!;
      e2.exact.add(text); e2.norm.add(nk); e2.trigrams.push({ norm: nk, set: gram(nk) });
      // Retrieval example rides along (same poison rules as the old importer).
      const exMsg = v.source.startsWith('learned') ? text : null;
      if (exMsg && !exExists.get(v.key, exMsg)) pendingExamples.push({ key: v.key, msg: exMsg });
    }
    if (clean) added++; else retired++;
  }

  if (!dry) {
    const exTx = dst.db.transaction(() => {
      for (const ex of pendingExamples) dupIns.run(ex.key, ex.msg, Date.now());
    });
    exTx();
  }

  console.log(`import-bank ${dry ? '(DRY)' : ''} ${srcPath} → ${dstPath}`);
  console.log(`  variants: +${added} added, ${retired} retired-on-arrival (replyIsClean)`);
  console.log(`  skipped:  ${skippedExact} exact · ${skippedNorm} normalized · ${skippedNear} near-dup · ${skippedFrozen} frozen/data-driven · ${skippedCap} at per-key cap`);
  console.log(`  examples: +${pendingExamples.length} retrieval example(s)`);
  if (!dry) console.log(`next: bash scripts/push-bank.sh atom01   # when YOU decide to ship`);
  src.close(); dst.close();
}

// CLI guard — importing this file (tests) must not execute the merge.
const invoked = process.argv[1] ? path.resolve(process.argv[1]) : '';
const thisFile = import.meta.url.startsWith('file:') ? import.meta.url.slice('file://'.length) : '';
if (invoked && thisFile && invoked === path.resolve(thisFile)) {
  main();
}
