#!/usr/bin/env tsx
/**
 * bank-place-templates — A+B, APPLIED TO ROWS THAT PREDATE THEM.
 *
 * The runtime stores a {place} template beside every stock-at-a-place answer
 * (A), and promotes it into the copy layer after three clean serves (B). Rows
 * captured BEFORE that shipped carry the prose only, so they can answer the one
 * phrasing they were taught and nothing else.
 *
 * This tool derives the template for such a row with the SAME predicate the
 * generation seam uses — no guessing, no model:
 *
 *   detectInventoryAsk(msg)              is this a stock-at-a-place ask?
 *   extractInventoryPlace(msg) → map     which place does it name, and is it real?
 *   placeTemplateFrom(answer, forms)     the sentence with that place → {place}
 *                                        (refuses a DISTRICT-BOUND sentence)
 *   validateDynamicAnswer(rendered, msg) the SAME serve-time contract
 *
 * A row that fails any leg is reported with its reason and left untouched.
 *
 * Usage:
 *   npm run bank:place-templates -- --db data/tui.db           (report only)
 *   npm run bank:place-templates -- --db data/tui.db --apply   (write)
 *
 * Exit code: 0 = done (including nothing to do), 1 = bad args / DB error.
 */

import '../src/compat/node16';

import * as fs from 'fs';
import * as path from 'path';
import { Db } from '../src/store/db';
import { loadConfig } from '../src/config';
import { SessionStore } from '../src/fsm/session';
import { BankStore } from '../src/store/bank';
import { Classifier } from '../src/llm/classify';
import { Responder } from '../src/llm/respond';
import { PropertyService } from '../src/data/properties';
import { AppointmentStore } from '../src/store/appointments';
import { EscalationStore } from '../src/store/escalations';
import { MetaStore } from '../src/store/meta';
import { EnrichmentStore } from '../src/store/enrichment';
import { ChannelRegistry } from '../src/channels/types';
import { InboundHandler } from '../src/handlers/inbound';
import { LlmClient } from '../src/llm/types';
import { LandmarkService } from '../src/geo/landmarks';
import { OfflineMapStore } from '../src/geo/offlineMap';

/** No model may be called by a backfill. */
class NoLlm implements LlmClient {
  async complete(): Promise<string> { throw new Error('the backfill never calls a model'); }
}

/** The derivation needs the POI map, not the feed — no network here. */
class NoFeed extends PropertyService {
  constructor() { super('http://backfill.invalid'); }
  async getAll(): Promise<[]> { return []; }
  get healthy(): boolean { return false; }
}

const args = process.argv.slice(2);
const apply = args.includes('--apply');
const dbArg = (() => {
  const i = args.indexOf('--db');
  return i >= 0 ? args[i + 1] : 'data/lina.db';
})();

if (!dbArg) {
  console.error('[place-templates] --db needs a path');
  process.exit(1);
}

const dbFile = path.resolve(process.cwd(), dbArg);
// Never CREATE a database: a mistyped path would look like a clean sweep.
if (!fs.existsSync(dbFile)) {
  console.error(`[place-templates] no such database: ${dbFile}`);
  process.exit(1);
}

let db: Db;
try {
  db = new Db(dbFile);
} catch (e) {
  console.error(`[place-templates] cannot open ${dbFile}: ${(e as Error).message}`);
  process.exit(1);
}

const cfg = loadConfig();
const channels = new ChannelRegistry();
channels.register({ name: 'backfill', send: async () => undefined });
const props = new NoFeed();
const bank = new BankStore(db);

const handler = new InboundHandler({
  cfg, db, sessions: new SessionStore(db), bank,
  classifier: new Classifier(new NoLlm(), cfg, props),
  responder: new Responder(new NoLlm(), cfg),
  properties: props,
  appointments: new AppointmentStore(db),
  escalations: new EscalationStore(db),
  meta: new MetaStore(db),
  channels,
  landmarks: new LandmarkService(db, { osm: false, offlineMap: new OfflineMapStore(cfg.skopjePoisDb) }),
  enrichment: new EnrichmentStore(db),
});

const clip = (s: string, n = 70): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

async function main(): Promise<void> {
  console.log(`[place-templates] db=${dbFile} mode=${apply ? 'APPLY' : 'dry-run'}`);
  const report = await handler.backfillPlaceTemplates({ apply });
  // ALREADY TEMPLATED is NOT "can carry one": after an --apply run the row is
  // done, and a report that keeps counting it reads as work still pending (the
  // exact kind of misleading operator output this round exists to remove).
  const already = new Set(
    (db.db.prepare(`SELECT id FROM bank_dynamic WHERE tmpl IS NOT NULL`).all() as Array<{ id: number }>)
      .map(r => r.id),
  );
  const ready = report.filter(r => r.template && !already.has(r.id));
  const done = report.filter(r => r.template && already.has(r.id));
  const skipped = report.filter(r => !r.template);
  console.log(`[place-templates] ${ready.length} row(s) can carry a template now,`
    + ` ${done.length} already carry one, ${skipped.length} cannot`);
  for (const r of ready) {
    console.log(`  #${r.id} → place=${r.anchor}${apply ? (r.written ? ' (written)' : ' (NOT written)') : ''}`);
    console.log(`     Q: ${clip(r.msg)}`);
    console.log(`     T: ${clip(r.template ?? '')}`);
  }
  for (const r of skipped) {
    console.log(`  #${r.id} — ${r.reason}`);
    console.log(`     Q: ${clip(r.msg)}`);
  }
  if (!apply) {
    console.log('[place-templates] report only — re-run with --apply to write');
  } else if (ready.length > 0 && ready.every(r => !r.written)) {
    console.log('[place-templates] nothing written — rows are processed or already templated');
  }
  db.db.close();
}

main().catch(e => {
  console.error(`[place-templates] ${(e as Error).message}`);
  try { db.db.close(); } catch { /* already closed */ }
  process.exit(1);
});
