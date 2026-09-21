import { Db } from './db';

/**
 * BankStore — the learned layer of the response bank.
 *
 * responses.ts stays the SEED layer (code, versioned, boot-fallback).
 * Everything the system LEARNS lives here in SQLite: live immediately,
 * no rebuild, no restart. Read-only in the request path (same rule as
 * the map — no work at client time beyond a keyed SELECT).
 *
 * Tables (created in Db, self-upgrading):
 *   bank_variants (key, text)        — learned variants per bank key
 *   bank_examples  (key, msg)        — example client messages per key (retrieval)
 *   bank_metrics   (key, hits, misses) — bank hit-rate accounting
 *   bank_corrections (key, msg, reply, reason) — quality-gate rejects, human review
 *
 * Frozen keys (fee.ask.*, contact — funnel invariants): reads from here are
 * allowed, but writes are REJECTED at this layer. Only regeneration can
 * change them, via the seed generator.
 */

/** Funnel-critical keys that must never be learned/modified at runtime.
 *  Amounts and funnel order are table-driven law, not phrasing. */
export const FROZEN_BANK_KEYS = new Set([
  'fee.ask.buy', 'fee.ask.rent',
  'fee.persuade.1.buy', 'fee.persuade.1.rent',
  'fee.persuade.2.buy', 'fee.persuade.2.rent',
  'fee.why', 'investment.opinion', 'price.ask',
  // Price-freshness disclaimer (08:50 protocol): system price + owner-relay
  // policy. Data-carrier ({price}) + funnel-critical wording.
  'price.freshness',
  // Bare "zosto?" push-back on the address-privacy rule — same family as
  // fee.why: fixed protocol answer, frozen pool, never enriched.
  'address.why',
  // The recommendation close ("koj da go preporacate?", "koj e podobar?"):
  // owner-approved wording only. Gemini-grown variants were removed by
  // request — the key serves the seeded clientela lines and never grows.
  'recommend.close',
  // Commission law + contact collection + owner-contact protocol:
  'provision.ask.buy', 'provision.ask.rent',
  'provision.who.buy', 'provision.who.rent', 'provision.who.danok.buy',
  'contact.ask.name', 'contact.ask.name.phone', 'contact.ask.phone', 'owner.contact.refusal',
  // Cheaper-search protocol (the 21:39 fix): price.shy intro + the
  // other-neighborhoods offer. Owner-approved wording — the clientela lines
  // serve real property batches and Gemini-grown variants were inconsistent
  // about promising prices the DB can't back. Frozen, seeded-only.
  'price.shy', 'price.shy.empty',
  // The 20:51 fix: where-is on a property MISSING from the feed → the honest
  // not-found pivot (with {eb} substitution). Data-carrying (the EB) + a
  // policy-critical dead-end breaker — frozen, seeded-only.
  'property.notfound',
  // The 21:05 fix: the visit-command accept close ("dogovori mi" after the
  // fee talk). Funnel-critical transition line — frozen, seeded-only.
  'visit.scheduled',
  // The 22:18 fix: TTL-expiry resume bridge for mid-funnel sessions. Keeps
  // the funnel alive across long gaps instead of resetting to the greeting.
  'session.resume',
]);

/** Data-driven keys: the answer's FACTS come from the property row, the owner
 *  verdict, or DB state (price, availability, address, queue position, owner
 *  time). The sentence is only a carrier for data — enriching it bakes stale
 *  EB-specific facts into bank prose (the learn.koja-cenata mistake: "EB 78
 *  чини 185.000 евра" served for the WRONG property). These stay DETERMINISTIC
 *  forever: never enriched, never learned, never served from the bank. */
export const DATA_DRIVEN_KEYS = new Set([
  'price.ask',          // price is read from the property row
  'availability.ack',   // availability comes from owner verdict / DB flag
  'address.exact',      // address privacy protocol
  'queued.confirm',     // queue position is live data
  'vague.time.owner',   // the owner's proposed time is live data
]);

/** Excluded from ALL enrichment/learning (union of both protection sets). */
export function isExcludedFromEnrichment(key: string | null | undefined): boolean {
  if (!key) return false;
  return FROZEN_BANK_KEYS.has(key) || DATA_DRIVEN_KEYS.has(key);
}

/** Hard cap on variants per key — prevents unbounded growth. */
export const MAX_VARIANTS_PER_KEY = 15;

export interface BankHit {
  key: string;
  text: string;
}

export class BankStore {
  private db: Db;

  constructor(db: Db) {
    this.db = db;
    this.migrate();
  }

  private migrate(): void {
    this.db.db.exec(`
      CREATE TABLE IF NOT EXISTS bank_variants (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        key        TEXT NOT NULL,
        text       TEXT NOT NULL,
        source     TEXT NOT NULL DEFAULT 'learned',
        created_at INTEGER NOT NULL,
        UNIQUE(key, text)
      );
      CREATE INDEX IF NOT EXISTS idx_bank_variants_key ON bank_variants(key);
      CREATE TABLE IF NOT EXISTS bank_examples (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        key        TEXT NOT NULL,
        msg        TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        UNIQUE(key, msg)
      );
      CREATE INDEX IF NOT EXISTS idx_bank_examples_key ON bank_examples(key);
      CREATE TABLE IF NOT EXISTS bank_metrics (
        key    TEXT PRIMARY KEY,
        hits   INTEGER NOT NULL DEFAULT 0,
        misses INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE IF NOT EXISTS bank_corrections (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        key        TEXT,
        msg        TEXT NOT NULL,
        reply      TEXT NOT NULL,
        reason     TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
    `);
  }

  // ---------- READ (request path) ----------

  /** Learned variants for a key (may be empty — seed bank still applies). */
  variants(key: string): string[] {
    const rows = this.db.db.prepare(
      `SELECT text FROM bank_variants WHERE key = ? ORDER BY id ASC`
    ).all(key) as Array<{ text: string }>;
    return rows.map(r => r.text);
  }

  /** Retrieval: best-matching key for a client message, or undefined.
   *  Jaccard similarity on character 3-grams over normalized text — same
   *  machinery the cron's grouper uses, now in the REQUEST path (offline,
   *  sub-ms at this table size). Falls back to trigram scoring when no
   *  exact/substring example matches. */
  retrieve(userMsg: string, minScore = 0.55): BankHit | undefined {
    const msg = userMsg.trim();
    if (msg.length < 4) return undefined;
    const rows = this.db.db.prepare(
      `SELECT key, msg FROM bank_examples`
    ).all() as Array<{ key: string; msg: string }>;
    if (rows.length === 0) return undefined;

    // Exact / containment first — strongest signal, zero fuzz.
    const low = msg.toLowerCase();
    for (const r of rows) {
      const m = r.msg.toLowerCase().trim();
      if (m === low || (m.length >= 8 && (low.includes(m) || m.includes(low)))) {
        return { key: r.key, text: '' };
      }
    }
    // Trigram similarity, best example wins.
    const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const tg = (s: string): Set<string> => {
      const t = norm(s); const set = new Set<string>();
      for (let i = 0; i <= t.length - 3; i++) set.add(t.slice(i, i + 3));
      return set;
    };
    const a = tg(msg);
    if (a.size === 0) return undefined;
    let best: { key: string; score: number } | undefined;
    for (const r of rows) {
      const b = tg(r.msg);
      let inter = 0;
      for (const t of a) if (b.has(t)) inter++;
      const score = inter / (a.size + b.size - inter);
      if (!best || score > best.score) best = { key: r.key, score };
    }
    return best && best.score >= minScore ? { key: best.key, text: '' } : undefined;
  }

  // ---------- WRITE (cron / learning loop only) ----------

  /**
   * HUMAN-DIRECTED write — the ONLY way a frozen key can grow. For explicit
   * one-off scripts the human has reviewed and approved (gap-fill passes).
   * The cron/learning loop must NEVER call this; it uses addVariant, which
   * keeps frozen keys untouched. Cap and dedupe still apply.
   */
  forceAddVariant(key: string, text: string, source = 'gapfill'): boolean {
    const t = text.trim();
    if (!t) return false;
    const count = (this.db.db.prepare(
      `SELECT COUNT(*) AS c FROM bank_variants WHERE key = ?`
    ).get(key) as { c: number }).c;
    if (count >= MAX_VARIANTS_PER_KEY) return false;
    try {
      const res = this.db.db.prepare(
        `INSERT OR IGNORE INTO bank_variants (key, text, source, created_at) VALUES (?, ?, ?, ?)`
      ).run(key, t, source, Date.now());
      return res.changes > 0; // 0 = duplicate ignored (idempotent)
    } catch { return false; }
  }

  /** Add a learned variant. Frozen + data-driven keys are rejected. Idempotent. */
  addVariant(key: string, text: string, source = 'learned'): boolean {
    if (isExcludedFromEnrichment(key)) return false;
    const t = text.trim();
    if (!t) return false;
    const count = (this.db.db.prepare(
      `SELECT COUNT(*) AS c FROM bank_variants WHERE key = ?`
    ).get(key) as { c: number }).c;
    if (count >= MAX_VARIANTS_PER_KEY) return false;
    try {
      const res = this.db.db.prepare(
        `INSERT OR IGNORE INTO bank_variants (key, text, source, created_at) VALUES (?, ?, ?, ?)`
      ).run(key, t, source, Date.now());
      return res.changes > 0; // 0 = duplicate ignored (idempotent)
    } catch { return false; }
  }

  /** Add an example client message for a key (retrieval). Idempotent.
   *  Data-driven keys get NO examples — retrieval must never serve their
   *  property-specific prose; the deterministic template answers instead. */
  addExample(key: string, msg: string): boolean {
    if (isExcludedFromEnrichment(key)) return false;
    const m = msg.trim();
    if (!m || m.length < 4) return false;
    try {
      const res = this.db.db.prepare(
        `INSERT OR IGNORE INTO bank_examples (key, msg, created_at) VALUES (?, ?, ?)`
      ).run(key, m, Date.now());
      return res.changes > 0;
    } catch { return false; }
  }

  /** Metrics: a bank-backed reply was served (hit) or a lookup failed (miss). */
  metric(key: string, hit: boolean): void {
    this.db.db.prepare(`
      INSERT INTO bank_metrics (key, hits, misses) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        hits = hits + excluded.hits,
        misses = misses + excluded.misses
    `).run(key, hit ? 1 : 0, hit ? 0 : 1);
  }

  /** Quarantine: quality gate rejected this learned pair — human review. */
  correction(key: string | null, msg: string, reply: string, reason: string): void {
    this.db.db.prepare(
      `INSERT INTO bank_corrections (key, msg, reply, reason, created_at) VALUES (?, ?, ?, ?, ?)`
    ).run(key, msg, reply, reason, Date.now());
  }

  /** Aggregate stats for the TUI dashboard / health check. */
  stats(): { totalVariants: number; keys: number; examples: number; corrections: number; hitRate: number | null } {
    const v = this.db.db.prepare(`SELECT COUNT(*) AS c FROM bank_variants`).get() as { c: number };
    const k = this.db.db.prepare(`SELECT COUNT(DISTINCT key) AS c FROM bank_variants`).get() as { c: number };
    const e = this.db.db.prepare(`SELECT COUNT(*) AS c FROM bank_examples`).get() as { c: number };
    const co = this.db.db.prepare(`SELECT COUNT(*) AS c FROM bank_corrections`).get() as { c: number };
    const m = this.db.db.prepare(`SELECT SUM(hits) AS h, SUM(misses) AS ms FROM bank_metrics`).get() as { h: number | null; ms: number | null };
    const h = m.h ?? 0, ms = m.ms ?? 0;
    return {
      totalVariants: v.c, keys: k.c, examples: e.c, corrections: co.c,
      hitRate: h + ms > 0 ? h / (h + ms) : null,
    };
  }

  /** Boot self-test: every bank table must be queryable. Throws on corruption. */
  selfTest(): void {
    for (const t of ['bank_variants', 'bank_examples', 'bank_metrics', 'bank_corrections']) {
      this.db.db.prepare(`SELECT COUNT(*) FROM ${t}`).get();
    }
  }
}
