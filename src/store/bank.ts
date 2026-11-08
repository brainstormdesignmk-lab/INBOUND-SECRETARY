import { Db } from './db';
import { normalizeMc } from '../llm/normalize';

/** The one canonical phrase form for negative rules: case- and whitespace-
 *  literal, so an F9 re-capture of the same wording normalizes to one row. */
function normPhrase(s: string): string {
  return (s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** SCRIPT FOLD for retrieval (the cross-script miss, 2026-10): clients type
 *  the same question in EITHER script, but bank_examples/bank_dynamic store
 *  whatever the turn said that day — case-folded, never script-folded. A
 *  Cyrillic phrasing therefore scored ~0 trigrams against a Latin-typed
 *  example ("AMA ZOSTO MORAM…") and every cross-script repeat fell through to
 *  the LLM. Folding BOTH sides through normalizeMc — the detector stack's own
 *  canonical form (memoized, lowercase, Latin→Cyrillic) — makes the matcher
 *  script-agnostic; each matcher's exactness rules stay untouched. */
function foldScript(s: string): string {
  return normalizeMc(s ?? '').replace(/\s+/g, ' ').trim();
}

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
  // The fee-resistance ladder ABOVE the first persuasion (see feeLadder): the
  // agency-rule statement and the binary decision question. Both are
  // funnel-critical (the decision line is what closes or advances the chat),
  // amount-free protocol wording — frozen, seeded-only.
  'fee.rule.hold', 'fee.decide',
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
  // The RENT-COMMISSION ladder (the second money topic, see provisionLadder):
  // one persuasion, the published agency rule, the binary decision. All three
  // are funnel-critical protocol wording with sanctioned figures only — frozen,
  // seeded-only, exactly like their fee-ladder twins.
  'provision.persuade.1.rent', 'provision.rule.hold', 'provision.decide',
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
  // The INFO-MISS lines (src/llm/infoAnswer.ts): "no such fact in the feed —
  // I will ask the owner". Policy wording composed in code, so the learning
  // loop must never grow them; listing them here is what makes the review
  // screen paint those rows as CODE and name their source file.
  'info.no.data', 'info.no.floors', 'info.no.year', 'info.no.renovation',
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
  // WHERE-LANDMARK ([12:48] protocol): the answer carries live map data —
  // the place name, the measured distance and the property's area ride the
  // typed {name}/{distance}/{loc} placeholders. Prose-only enrichment would
  // bake invented places/distances into served text.
  'where.landmark',
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

/** Word-bounded phrase match for the top-of-funnel recall. A stored phrase may
 *  only claim a whole token sequence: „kade ima reptil“ must NOT match
 *  „kade ima reptilche“, or a conservative exact recall turns into a loose one.
 *  Both sides are space-padded so the boundary check needs no regex escaping. */
function phraseMatch(low: string, stored: string): boolean {
  if (stored === low) return true;
  if (Math.min(low.length, stored.length) < 8) return false;
  return (` ${low} `).includes(` ${stored} `) || (` ${stored} `).includes(` ${low} `);
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
      CREATE TABLE IF NOT EXISTS bank_corrections_meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
    // Loop-A staging columns (2026-09): existing DBs get them via ALTER;
    // SQLite has no ADD COLUMN IF NOT EXISTS.
    const cols = this.db.db.prepare(`PRAGMA table_info(bank_corrections)`).all() as Array<{ name: string }>;
    if (!cols.some(c => c.name === 'status')) this.db.db.exec(`ALTER TABLE bank_corrections ADD COLUMN status TEXT NOT NULL DEFAULT 'new'`);
    // P2/P5 variant lifecycle: staged = generated by relearn, awaiting the
    // bank:review human gate; active = servable; retired = pulled from serve
    // (reversible — promote flips it back). Existing rows default to active.
    const vcols = this.db.db.prepare(`PRAGMA table_info(bank_variants)`).all() as Array<{ name: string }>;
    if (!vcols.some(c => c.name === 'lifecycle')) this.db.db.exec(`ALTER TABLE bank_variants ADD COLUMN lifecycle TEXT NOT NULL DEFAULT 'active'`);
    if (!vcols.some(c => c.name === 'note')) this.db.db.exec(`ALTER TABLE bank_variants ADD COLUMN note TEXT`);
    // P-runtime: bank_dynamic — the immediate store for questions the
    // deterministic layer could not route. Gemini answers under constraints;
    // the validated answer is stored HERE and served instantly on recall.
    // key = 'dynamic:<state>:<slug>' groups near-duplicate questions; msg is
    // UNIQUE per key so the same client phrasing never duplicates rows.
    this.db.db.exec(`
      CREATE TABLE IF NOT EXISTS bank_dynamic (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        key        TEXT NOT NULL,
        state      TEXT NOT NULL DEFAULT '',
        msg        TEXT NOT NULL,
        answer     TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        processed  INTEGER NOT NULL DEFAULT 0,
        UNIQUE(key, msg)
      );
      CREATE INDEX IF NOT EXISTS idx_bank_dynamic_key ON bank_dynamic(key);
    `);
    const dynamicCols = this.db.db.prepare(`PRAGMA table_info(bank_dynamic)`).all() as Array<{ name: string }>;
    if (!dynamicCols.some(c => c.name === 'processed')) {
      this.db.db.exec(`ALTER TABLE bank_dynamic ADD COLUMN processed INTEGER NOT NULL DEFAULT 0`);
    }
    // PLACE-TEMPLATED CAPTURES (A of the closed loop): a generated answer about
    // a NAMED PLACE is true only for that place, so the verbatim `answer` can
    // never serve another district. `tmpl` holds the same sentence with its
    // place span replaced by the literal `{place}` slot (`PLACE_SLOT` in
    // src/llm/placeTemplate.ts — not imported here, to keep this store free of
    // the llm layer's import graph), `place` is the anchor it was written for,
    // and `hits` counts CLEAN serves: the promotion trigger (B).
    if (!dynamicCols.some(c => c.name === 'tmpl')) this.db.db.exec(`ALTER TABLE bank_dynamic ADD COLUMN tmpl TEXT`);
    if (!dynamicCols.some(c => c.name === 'place')) this.db.db.exec(`ALTER TABLE bank_dynamic ADD COLUMN place TEXT`);
    if (!dynamicCols.some(c => c.name === 'hits')) this.db.db.exec(`ALTER TABLE bank_dynamic ADD COLUMN hits INTEGER NOT NULL DEFAULT 0`);
    if (!cols.some(c => c.name === 'family')) this.db.db.exec(`ALTER TABLE bank_corrections ADD COLUMN family TEXT`);
    if (!cols.some(c => c.name === 'resolved_at')) this.db.db.exec(`ALTER TABLE bank_corrections ADD COLUMN resolved_at INTEGER`);
    // OPERATOR CORRECTION (2026-10 transcript): the row used to hold only ONE
    // text — whichever branch wrote it — so the wrong reply and the human's
    // right wording were indistinguishable, and loop-a (which reads msg, not
    // reply) discarded the correction. `reply` is now always the text that
    // served; `corrected` is the operator's wording, the thing that must be
    // staged into the bank.
    if (!cols.some(c => c.name === 'corrected')) this.db.db.exec(`ALTER TABLE bank_corrections ADD COLUMN corrected TEXT`);
    // P5.1 NEGATIVE RULES (route corrections as first-class objects): when a
    // route correction moves a question from family X to a learn.* key, the
    // SAME utterance must never be claimable by family X again — XP served
    // and was wrong. Exact-utterance, family-scoped: a phrase may be legal
    // fee.* traffic for another client in another state; the rule only kills
    // the exact phrasing that already burned a serve.
    this.db.db.exec(`
      CREATE TABLE IF NOT EXISTS bank_negative_rules (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        phrase       TEXT NOT NULL,
        forbid_family TEXT NOT NULL,
        note         TEXT,
        created_at   INTEGER NOT NULL,
        UNIQUE(phrase, forbid_family)
      );
      CREATE INDEX IF NOT EXISTS idx_bank_negative_rules_phrase ON bank_negative_rules(phrase);
    `);
  }

  // ---------- READ (request path) ----------

  /** Learned variants for a key (may be empty — seed bank still applies).
   *  SERVE PATH: only lifecycle='active' rows — staged candidates awaiting
   *  the bank:review gate and retired rows never reach a client. */
  variants(key: string): string[] {
    const rows = this.db.db.prepare(
      `SELECT text FROM bank_variants WHERE key = ? AND lifecycle = 'active' ORDER BY id ASC`
    ).all(key) as Array<{ text: string }>;
    return rows.map(r => r.text);
  }

  /** Full variant rows incl. lifecycle — review CLI / meters / relearn. */
  variantsWithLifecycle(key: string): Array<{ id: number; text: string; source: string; lifecycle: string; note: string | null }> {
    return this.db.db.prepare(
      `SELECT id, text, source, lifecycle, note FROM bank_variants WHERE key = ? ORDER BY id ASC`
    ).all(key) as any;
  }

  /** Staged candidates (relearn output awaiting the human gate), optionally per key. */
  stagedVariants(key?: string): Array<{ id: number; key: string; text: string; source: string; note: string | null; created_at: number }> {
    const rows = key
      ? this.db.db.prepare(`SELECT id, key, text, source, note, created_at FROM bank_variants WHERE lifecycle = 'staged' AND key = ? ORDER BY id ASC`).all(key)
      : this.db.db.prepare(`SELECT id, key, text, source, note, created_at FROM bank_variants WHERE lifecycle = 'staged' ORDER BY id ASC`).all();
    return rows as any;
  }

  /** staged→active (or retired→active — retirement is reversible). */
  promoteVariant(id: number): boolean {
    return this.db.db.prepare(`UPDATE bank_variants SET lifecycle = 'active' WHERE id = ?`).run(id).changes > 0;
  }

  /** Pull a variant from serve (P5 auto-retire / review reject). Reversible. */
  retireVariant(id: number, note?: string): boolean {
    return this.db.db.prepare(
      `UPDATE bank_variants SET lifecycle = 'retired', note = COALESCE(?, note) WHERE id = ?`
    ).run(note ?? null, id).changes > 0;
  }

  /** Drop a staged candidate entirely (review reject = never banked). */
  deleteStagedVariant(id: number): boolean {
    return this.db.db.prepare(`DELETE FROM bank_variants WHERE id = ? AND lifecycle = 'staged'`).run(id).changes > 0;
  }

  /** Delete retrieval examples whose stored message violates a predicate.
   *  POISON SWEEP (the [09:25] transcript): examples teaching a learned key
   *  to fire on funnel traffic ("AKO E TAKA TOGAS DOGOVORI MI" → EB-69
   *  template) must go together with the retired variant, or the key stays
   *  reachable through retrieve(). Returns the number deleted. */
  purgeExamplesIf(predicate: (msg: string) => boolean): number {
    const rows = this.db.db.prepare(`SELECT id, msg FROM bank_examples`).all() as
      Array<{ id: number; msg: string }>;
    let n = 0;
    for (const r of rows) {
      if (predicate(r.msg)) {
        this.db.db.prepare(`DELETE FROM bank_examples WHERE id = ?`).run(r.id);
        n++;
      }
    }
    return n;
  }

  // ---------- bank_dynamic (runtime fallback store) ----------

  /** Store a validated dynamic answer. Idempotent per (key, msg).
   *
   *  `meta.template` / `meta.place` are the PLACE-TEMPLATED form of the same
   *  sentence and the anchor it was written for. A template without the slot is
   *  refused here (an un-substitutable "template" would serve a sentence about
   *  no place at all); a place without a template is meaningless and dropped. */
  addDynamic(
    key: string, state: string, msg: string, answer: string,
    meta?: { template?: string; place?: string },
  ): boolean {
    if (!key.startsWith('dynamic:')) return false;
    const m = msg.trim(); const a = answer.trim();
    if (!m || !a) return false;
    const tmpl = meta?.template && meta.template.includes('{place}') ? meta.template : null;
    const place = tmpl && meta?.place ? meta.place.trim() || null : null;
    try {
      const res = this.db.db.prepare(
        `INSERT INTO bank_dynamic (key, state, msg, answer, created_at, processed, tmpl, place, hits)
         VALUES (?, ?, ?, ?, ?, 0, ?, ?, 0)
         ON CONFLICT(key, msg) DO UPDATE SET state=excluded.state, answer=excluded.answer,
           created_at=excluded.created_at, processed=0, tmpl=excluded.tmpl, place=excluded.place,
           hits=0 WHERE bank_dynamic.processed=1`
      ).run(key, state, m, a, Date.now(), tmpl, place);
      return res.changes > 0;
    } catch { return false; }
  }

  /** F9 WRITE-BACK — the dynamic row that owns this exact question.
   *
   *  Match is exact after whitespace/case normalisation and scoped to the
   *  state: a correction must rewrite THE row that served, never a similar
   *  question in another state. The fuzzy recall is deliberately not used
   *  here — it is good at serving, too loose for overwriting. */
  findDynamicRow(state: string | undefined, msg: string): { id: number; key: string; msg: string; state: string } | undefined {
    const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const want = norm(msg);
    if (!want) return undefined;
    // `undefined` = search every state. The TUI uses it as a fallback because
    // the remembered state can be empty for a brand-new session (the exchange
    // is recorded before the session exists) — the message itself is still an
    // EXACT match, so this can never rewrite a different question.
    const rows = (state
      ? this.db.db.prepare(`SELECT id, key, state, msg FROM bank_dynamic WHERE state = ? AND processed = 0 ORDER BY id ASC`).all(state)
      : this.db.db.prepare(`SELECT id, key, state, msg FROM bank_dynamic WHERE processed = 0 ORDER BY id ASC`).all()
    ) as Array<{ id: number; key: string; state: string; msg: string }>;
    return rows.find(r => norm(r.msg) === want);
  }

  /** F9 WRITE-BACK — replace the answer IN PLACE, so the next identical ask
   *  recalls the corrected prose instead of the model's version. The caller
   *  validates the text first (validateDynamicAnswer). */
  rewriteDynamic(state: string | undefined, msg: string, answer: string): { ok: boolean; id?: number; key?: string; reason?: string } {
    const a = answer.trim();
    if (!a) return { ok: false, reason: 'empty answer' };
    const row = this.findDynamicRow(state, msg);
    if (!row) return { ok: false, reason: 'no matching dynamic row' };
    // Same rule as updateDynamicAnswer: the human corrected the prose, so the
    // place template built from it stops serving and the counter restarts.
    const res = this.db.db.prepare(
      `UPDATE bank_dynamic SET answer = ?, tmpl = NULL, place = NULL, hits = 0 WHERE id = ?`
    ).run(a, row.id);
    return res.changes > 0 ? { ok: true, id: row.id, key: row.key } : { ok: false, reason: 'update failed' };
  }

  /** Recall: best-matching stored dynamic answer for a client message.
   *  Exact/containment first (strongest signal), then trigram similarity —
   *  the same two-stage shape as retrieve(). */
  retrieveDynamic(userMsg: string, minScore = 0.55): { key: string; answer: string; msg: string } | undefined {
    const msg = userMsg.trim();
    if (msg.length < 4) return undefined;
    const rows = this.db.db.prepare(`SELECT key, msg, answer FROM bank_dynamic WHERE processed = 0`).all() as
      Array<{ key: string; msg: string; answer: string }>;
    if (rows.length === 0) return undefined;
    const low = foldScript(msg);
    for (const r of rows) {
      const m = foldScript(r.msg);
      if (m === low || (m.length >= 8 && (low.includes(m) || m.includes(low)))) return { key: r.key, answer: r.answer, msg: r.msg };
    }
    const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const tg = (s: string): Set<string> => {
      const t = norm(s); const set = new Set<string>();
      for (let i = 0; i <= t.length - 3; i++) set.add(t.slice(i, i + 3));
      return set;
    };
    const a = tg(foldScript(msg));
    if (a.size === 0) return undefined;
    let best: { key: string; answer: string; msg: string; score: number } | undefined;
    for (const r of rows) {
      const b = tg(foldScript(r.msg));
      let inter = 0;
      for (const t of a) if (b.has(t)) inter++;
      const score = inter / (a.size + b.size - inter);
      if (!best || score > best.score) best = { key: r.key, answer: r.answer, msg: r.msg, score };
    }
    return best && best.score >= minScore ? { key: best.key, answer: best.answer, msg: best.msg } : undefined;
  }

  /** EXACT-ONLY recall of a stored dynamic answer — used at the TOP of the
   *  funnel, before the classifier. Deliberately stricter than
   *  retrieveDynamic(): no trigram fuzz, so a stored answer can never hijack a
   *  reworded question, and an optional state scope keeps a `closing` answer
   *  out of `presentation`. Returns the row's state so the caller can audit. */
  retrieveDynamicExact(userMsg: string, state?: string): { key: string; state: string; msg: string; answer: string } | undefined {
    const msg = userMsg.trim();
    if (msg.length < 4) return undefined;
    const rows = state
      ? this.db.db.prepare(`SELECT key, state, msg, answer FROM bank_dynamic WHERE state = ? AND processed = 0`).all(state)
      : this.db.db.prepare(`SELECT key, state, msg, answer FROM bank_dynamic WHERE processed = 0`).all();
    const low = foldScript(msg);
    for (const r of rows as Array<{ key: string; state: string; msg: string; answer: string }>) {
      const m = foldScript(r.msg);
      if (!m) continue;
      // `msg` travels with the hit: the recall caller validates the answer
      // against the row's OWN question (the borrowed-place rule), and the
      // containment match can be a shorter stored phrase inside a longer
      // message, so the caller cannot reconstruct it from the input.
      if (phraseMatch(low, m)) return { key: r.key, state: r.state, msg: r.msg, answer: r.answer };
    }
    return undefined;
  }

  /** EXACT-ONLY example match (client phrasing → learned bank key). Same
   *  contract as retrieveDynamicExact: no trigram, optionally state-free, so
   *  the top-of-funnel recall serves only phrasings it has literally seen. */
  retrieveExact(userMsg: string): { key: string; msg: string } | undefined {
    const msg = userMsg.trim();
    if (msg.length < 4) return undefined;
    const rows = this.db.db.prepare(`SELECT key, msg FROM bank_examples`).all() as
      Array<{ key: string; msg: string }>;
    const low = foldScript(msg);
    for (const r of rows) {
      const m = foldScript(r.msg);
      if (!m) continue;
      if (phraseMatch(low, m)) return { key: r.key, msg: r.msg };
    }
    return undefined;
  }

  /** PENDING dynamic rows WITH their answers, oldest first — the nightly digest
   *  judges one ROW at a time (a group's first answer can be the broken one)
   *  and needs the id to remove a serviceable-but-poisoned capture. */
  dynamicPendingRows(): Array<{ id: number; key: string; state: string; msg: string; answer: string }> {
    return this.db.db.prepare(
      `SELECT id, key, state, msg, answer FROM bank_dynamic WHERE processed = 0 ORDER BY id ASC`
    ).all() as Array<{ id: number; key: string; state: string; msg: string; answer: string }>;
  }

  /** Dynamic groups for the nightly digest: key, state, msgs, first answer. */
  dynamicGroups(): Array<{ key: string; state: string; msgs: string[]; answer: string }> {
    const rows = this.db.db.prepare(`SELECT key, state, msg, answer FROM bank_dynamic WHERE processed = 0 ORDER BY id ASC`).all() as
      Array<{ key: string; state: string; msg: string; answer: string }>;
    const map = new Map<string, { key: string; state: string; msgs: string[]; answer: string }>();
    for (const r of rows) {
      let g = map.get(r.key);
      if (!g) { g = { key: r.key, state: r.state, msgs: [], answer: r.answer }; map.set(r.key, g); }
      g.msgs.push(r.msg);
    }
    return [...map.values()];
  }

  /** ROW-LEVEL dynamic captures for the review UI (newest first). The digest
   *  groups by key; editing needs the individual row. */
  dynamicRows(limit = 200): Array<{ id: number; key: string; state: string; msg: string; answer: string; createdAt: number; processed: number }> {
    return this.db.db.prepare(
      `SELECT id, key, state, msg, answer, created_at AS createdAt, processed
       FROM bank_dynamic ORDER BY processed ASC, id DESC LIMIT ?`
    ).all(limit) as Array<{ id: number; key: string; state: string; msg: string; answer: string; createdAt: number; processed: number }>;
  }

  /** Captures awaiting review/promotion. Processed rows remain visible as gray audit history. */
  dynamicRowCount(): number {
    return (this.db.db.prepare(`SELECT COUNT(*) AS c FROM bank_dynamic WHERE processed = 0`).get() as { c: number }).c;
  }

  /** Retain a capture as processed only if it still matches the promoted answer. */
  markDynamicProcessedIfMatches(id: number, msg: string, answer: string): boolean {
    return this.db.db.prepare(
      `UPDATE bank_dynamic SET processed = 1 WHERE id = ? AND msg = ? AND answer = ? AND processed = 0`
    ).run(id, msg, answer).changes > 0;
  }

  /** Update one dynamic capture by row id (bank:tui edit; validated by the caller).
   *
   *  A CORRECTION INVALIDATES THE TEMPLATE (B's "clean" condition): the operator
   *  just said that prose was wrong, so its place-templated copy is wrong too and
   *  must not keep serving for another place. The promotion counter restarts. */
  updateDynamicAnswer(id: number, answer: string): boolean {
    const a = answer.trim();
    if (!a) return false;
    return this.db.db.prepare(
      `UPDATE bank_dynamic SET answer = ?, tmpl = NULL, place = NULL, hits = 0 WHERE id = ?`
    ).run(a, id).changes > 0;
  }

  /** A+B: the place template stored for this anchor, cleanest row first. */
  retrievePlaceTemplate(place: string): { id: number; key: string; template: string } | undefined {
    const p = (place ?? '').trim();
    if (!p) return undefined;
    return this.db.db.prepare(
      `SELECT id, key, tmpl AS template FROM bank_dynamic
       WHERE tmpl IS NOT NULL AND place IS NOT NULL
         AND lower(place) = lower(?) AND processed = 0
       ORDER BY hits DESC, id ASC LIMIT 1`
    ).get(p) as { id: number; key: string; template: string } | undefined;
  }

  /** A+B BACKFILL: attach a {place} template to a row captured before the
   *  template layer existed. The caller derives it with the generation
   *  predicate (never a guess) and validates the rendered form first; this only
   *  refuses a template without the slot, and never touches a processed row
   *  (that row is already audit history). */
  setPlaceTemplate(id: number, template: string, place: string): boolean {
    const t = (template ?? '').trim();
    const p = (place ?? '').trim();
    if (!t.includes('{place}') || !p) return false;
    return this.db.db.prepare(
      `UPDATE bank_dynamic SET tmpl = ?, place = ?, hits = 0 WHERE id = ? AND processed = 0`
    ).run(t, p, id).changes > 0;
  }

  /** One clean serve of a templated row — the promotion counter (B). */
  bumpDynamicHits(id: number): number {
    this.db.db.prepare(`UPDATE bank_dynamic SET hits = hits + 1 WHERE id = ?`).run(id);
    const row = this.db.db.prepare(`SELECT hits FROM bank_dynamic WHERE id = ?`).get(id) as { hits: number } | undefined;
    return row?.hits ?? 0;
  }

  /** Reject a dynamic capture: stop serving it (bank:tui X). */
  deleteDynamic(id: number): boolean {
    return this.db.db.prepare(`DELETE FROM bank_dynamic WHERE id = ?`).run(id).changes > 0;
  }

  /** Remove a promoted dynamic capture only if it still matches the staged
   *  snapshot. A dynamic answer edited after staging remains intact. */
  deleteDynamicIfMatches(id: number, msg: string, answer: string): boolean {
    return this.db.db.prepare(
      `DELETE FROM bank_dynamic WHERE id = ? AND msg = ? AND answer = ?`
    ).run(id, msg, answer).changes > 0;
  }

  /** Learned ACTIVE variants, newest first — the bank:tui review list. Seeds
   *  live in responses.ts, so every row here is learned/reviewed prose. */
  activeVariants(limit = 200): Array<{ id: number; key: string; text: string; source: string; note: string | null; createdAt: number }> {
    return this.db.db.prepare(
      `SELECT id, key, text, source, note, created_at AS createdAt FROM bank_variants
       WHERE lifecycle = 'active' ORDER BY id DESC LIMIT ?`
    ).all(limit) as Array<{ id: number; key: string; text: string; source: string; note: string | null; createdAt: number }>;
  }

  activeVariantCount(): number {
    return (this.db.db.prepare(
      `SELECT COUNT(*) AS c FROM bank_variants WHERE lifecycle = 'active'`
    ).get() as { c: number }).c;
  }

  /** STAGED-only text edit (bank:tui E). Active variants are read-only by
   *  policy: changing live copy must go staged → reviewed → promoted. */
  updateVariantText(id: number, text: string): boolean {
    const t = text.trim();
    if (!t) return false;
    return this.db.db.prepare(
      `UPDATE bank_variants SET text = ? WHERE id = ? AND lifecycle = 'staged'`
    ).run(t, id).changes > 0;
  }

  /** FIFO purge beyond the cap — the dynamic store stays a fresh signal. */
  purgeDynamic(keep = 400): number {
    const processed = this.db.db.prepare(`SELECT COUNT(*) AS c FROM bank_dynamic WHERE processed = 1`).get() as { c: number };
    if (processed.c > 0) {
      this.db.db.prepare(`DELETE FROM bank_dynamic WHERE processed = 1`).run();
      return processed.c;
    }
    const row = this.db.db.prepare(`SELECT COUNT(*) AS c FROM bank_dynamic`).get() as { c: number };
    if (row.c <= keep) return 0;
    const res = this.db.db.prepare(
      `DELETE FROM bank_dynamic WHERE id IN (SELECT id FROM bank_dynamic ORDER BY id ASC LIMIT ?)`
    ).run(row.c - keep);
    return res.changes;
  }

  /** Dynamic rows still awaiting a verbatim key binding (oldest first). */
  pendingDynamic(limit = 50): Array<{ id: number; key: string; state: string; msg: string }> {
    return this.db.db.prepare(
      `SELECT id, key, state, msg FROM bank_dynamic WHERE processed = 0 ORDER BY id ASC LIMIT ?`
    ).all(limit) as Array<{ id: number; key: string; state: string; msg: string }>;
  }

  /**
   * VERBATIM PROMOTION — bind a stored client phrase to a REAL bank key.
   *
   * This is the free half of the loop: „this phrasing means that key" is a
   * ROUTING fact, so it costs no model call and writes no prose. The key must
   * come from a human (`bank:relearn --bind`) because nothing at the generation
   * seam knows it — that the deterministic layer could not name the intent is
   * precisely why the turn fell through in the first place.
   *
   * The dynamic row is DELETED on success. `retrieveDynamicExact` runs BEFORE
   * the example match at the top of the funnel, so leaving the row would keep
   * the generated prose winning and the binding would never take effect.
   */
  bindDynamic(id: number, key: string): { ok: boolean; added: boolean; reason?: string; msg?: string } {
    const row = this.db.db.prepare(`SELECT id, msg FROM bank_dynamic WHERE id = ? AND processed = 0`).get(id) as
      { id: number; msg: string } | undefined;
    if (!row) return { ok: false, added: false, reason: 'no such dynamic row' };
    if (!key || key.startsWith('dynamic:')) {
      return { ok: false, added: false, reason: 'target must be a deterministic bank key, not a dynamic group' };
    }
    if (isExcludedFromEnrichment(key)) {
      return { ok: false, added: false, reason: 'frozen/data-driven key — its wording is seeded and its routing is detector-owned' };
    }
    const msg = row.msg.trim();
    // Same floor as addExample()/retrieveExact(): a 3-letter phrase ("TWO") is
    // a detector's job, not an example's — say so instead of silently no-op'ing.
    if (msg.length < 4) {
      return { ok: false, added: false, reason: `phrase is ${msg.length} chars — too short to retrieve (min 4); teach a detector instead` };
    }
    const added = this.addExample(key, msg);
    this.db.db.prepare(`DELETE FROM bank_dynamic WHERE id = ?`).run(id);
    return added
      ? { ok: true, added: true, msg }
      : { ok: true, added: false, reason: 'already bound to that key', msg };
  }

  /** Every key that has at least one learned variant (learn.* audits, meters). */
  learnedKeys(): string[] {
    const rows = this.db.db.prepare(
      `SELECT DISTINCT key FROM bank_variants ORDER BY key ASC`
    ).all() as Array<{ key: string }>;
    return rows.map(r => r.key);
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

    // Exact / containment first — strongest signal, zero fuzz. Both sides are
    // script-folded, so the same question in either script compares as the
    // same string.
    const low = foldScript(msg);
    for (const r of rows) {
      const m = foldScript(r.msg);
      if (m === low || (m.length >= 8 && (low.includes(m) || m.includes(low)))) {
        return { key: r.key, text: '' };
      }
    }
    // Trigram similarity, best example wins. Scored on script-folded forms:
    // Cyrillic/Latin spellings of the same words overlap after the fold, not
    // before it.
    const norm = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
    const tg = (s: string): Set<string> => {
      const t = norm(s); const set = new Set<string>();
      for (let i = 0; i <= t.length - 3; i++) set.add(t.slice(i, i + 3));
      return set;
    };
    const a = tg(foldScript(msg));
    if (a.size === 0) return undefined;
    let best: { key: string; score: number } | undefined;
    for (const r of rows) {
      const b = tg(foldScript(r.msg));
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
      `SELECT COUNT(*) AS c FROM bank_variants WHERE key = ? AND lifecycle = 'active'`
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
      `SELECT COUNT(*) AS c FROM bank_variants WHERE key = ? AND lifecycle = 'active'`
    ).get(key) as { c: number }).c;
    if (count >= MAX_VARIANTS_PER_KEY) return false;
    try {
      const res = this.db.db.prepare(
        `INSERT OR IGNORE INTO bank_variants (key, text, source, created_at) VALUES (?, ?, ?, ?)`
      ).run(key, t, source, Date.now());
      return res.changes > 0; // 0 = duplicate ignored (idempotent)
    } catch { return false; }
  }

  /**
   * STAGED write — the relearn path. Unlike addVariant this MAY write for
   * frozen keys: a human correction unlocked the round (P2 design — the
   * correction is the only key that fits that lock). Nothing staged ever
   * serves: it waits in lifecycle='staged' until bank:review promotes it.
   * Data-driven keys stay rejected — property facts never become prose.
   */
  addStagedVariant(key: string, text: string, note?: string, source = 'relearn'): boolean {
    if (DATA_DRIVEN_KEYS.has(key)) return false;
    const t = text.trim();
    if (!t) return false;
    try {
      const res = this.db.db.prepare(
        `INSERT OR IGNORE INTO bank_variants (key, text, source, created_at, lifecycle, note) VALUES (?, ?, ?, ?, 'staged', ?)`
      ).run(key, t, source, Date.now(), note ?? null);
      return res.changes > 0;
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

  /** Retrieval examples for a key — the CLIENT QUESTIONS that reach it. The
   *  variant itself is wording only; this is the only place a question is
   *  stored, which is why the review screen has to read it from here. */
  examples(key: string): string[] {
    return (this.db.db.prepare(
      `SELECT msg FROM bank_examples WHERE key = ? ORDER BY id ASC`
    ).all(key) as Array<{ msg: string }>).map(r => r.msg);
  }

  /** Metrics: a bank-backed reply was served (hit) or a lookup failed (miss). */
  /** Serve accounting. `layer` is where the SERVED text came from: the seed
   *  bank (responses.ts) or the learned SQLite layer. Without it a serve is
   *  indistinguishable from a learned one, which is what made the old
   *  free-rate always 100% — the enrichment's payoff was unmeasurable. */
  metric(key: string, hit: boolean, layer?: 'seed' | 'learned'): void {
    this.db.db.prepare(`
      INSERT INTO bank_metrics (key, hits, misses, seed_serves, learned_serves, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET
        hits = hits + excluded.hits,
        misses = misses + excluded.misses,
        seed_serves = seed_serves + excluded.seed_serves,
        learned_serves = learned_serves + excluded.learned_serves,
        updated_at = excluded.updated_at
    `).run(
      key, hit ? 1 : 0, hit ? 0 : 1,
      layer === 'seed' ? 1 : 0,
      layer === 'learned' ? 1 : 0,
      Date.now(),
    );
  }

  /** LEARNED-SERVE RATE — the closed loop's actual scoreboard: of every answer
   *  the bank served, how many came from learned material rather than the seed
   *  file. `rate` is null until something has served. */
  learnedRate(): { learned: number; seed: number; rate: number | null } {
    const r = this.db.db.prepare(
      `SELECT COALESCE(SUM(learned_serves), 0) AS l, COALESCE(SUM(seed_serves), 0) AS s FROM bank_metrics`
    ).get() as { l: number; s: number };
    const total = r.l + r.s;
    return { learned: r.l, seed: r.s, rate: total > 0 ? r.l / total : null };
  }

  /** Quarantine: quality gate rejected this learned pair — human review.
   *  `corrected` = the operator's right wording, when a human fixed the reply. */
  correction(key: string | null, msg: string, reply: string, reason: string, corrected?: string | null): number {
    const res = this.db.db.prepare(
      `INSERT INTO bank_corrections (key, msg, reply, reason, corrected, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).run(key, msg, reply, reason, corrected?.trim() || null, Date.now());
    return Number(res.lastInsertRowid);
  }

  // ---------- P5.1: NEGATIVE RULES (mistakes refuse their own repeat) --------

  /** Record: this exact utterance must never serve this key family again.
   *  Written automatically by a route correction, replayed at serve time. */
  addNegativeRule(phrase: string, forbidFamily: string, note?: string): void {
    const p = normPhrase(phrase);
    if (!p || !forbidFamily.trim()) return;
    this.db.db.prepare(
      `INSERT OR IGNORE INTO bank_negative_rules (phrase, forbid_family, note, created_at) VALUES (?, ?, ?, ?)`
    ).run(p, forbidFamily.trim(), note?.trim() || null, Date.now());
  }

  /** The serve-time veto: TRUE when this utterance carries a negative rule
   *  whose family covers `familyPrefix` ("fee." kills fee.ask.*, fee.persuade…
   *  — the market suffix noise included). Whole-phrase match ONLY: rules are
   *  hand-taught, one utterance each; substring matching would poison noise
   *  into the funnel. Sub-second cost: one prepared statement on an indexed
   *  phrase, called only from the money-lane guards. */
  neverServes(phrase: string, familyPrefix: string): boolean {
    const p = normPhrase(phrase);
    if (!p || !familyPrefix.trim()) return false;
    const rows = this.db.db.prepare(
      `SELECT forbid_family FROM bank_negative_rules WHERE phrase = ?`
    ).all(p) as Array<{ forbid_family: string }>;
    return rows.some(r => familyPrefix.startsWith(r.forbid_family) || r.forbid_family.startsWith(familyPrefix));
  }

  /** Rules for review/introspection (tests, route:health). */
  negativeRules(): Array<{ id: number; phrase: string; forbid_family: string; note: string | null }> {
    return this.db.db.prepare(
      `SELECT id, phrase, forbid_family, note FROM bank_negative_rules ORDER BY id DESC`
    ).all() as any;
  }

  // ---------- Loop A: correction → trigger corpus (2026-09) ----------

  /** Newest-first corrections by status ('new' = unprocessed). */
  correctionsByStatus(status: string): Array<{ id: number; key: string | null; msg: string; reply: string; reason: string; status: string; family: string | null; corrected: string | null; created_at: number }> {
    return this.db.db.prepare(
      `SELECT id, key, msg, reply, reason, status, family, corrected, created_at FROM bank_corrections WHERE status = ? ORDER BY id DESC LIMIT 500`
    ).all(status) as any;
  }

  /** Queue counts for the review CLI dashboard. */
  correctionCounts(): Record<string, number> {
    const rows = this.db.db.prepare(`SELECT status, COUNT(*) as n FROM bank_corrections GROUP BY status`).all() as Array<{ status: string; n: number }>;
    return Object.fromEntries(rows.map(r => [r.status, r.n]));
  }

  /** Manual [F9] intake: capture a wrong answer with its conversation context.
   *  `reply` is the text that SERVED (the mistake), `corrected` is the human's
   *  replacement — both are kept so the audit shows what changed. */
  correctionManual(msg: string, reply: string, reason: string, key: string | null, corrected?: string | null): number {
    const res = this.db.db.prepare(
      `INSERT INTO bank_corrections (key, msg, reply, reason, corrected, status, created_at) VALUES (?, ?, ?, ?, ?, 'new', ?)`
    ).run(key, msg, reply, reason, corrected?.trim() || null, Date.now());
    return Number(res.lastInsertRowid);
  }

  /**
   * OPERATOR-AUTHORED VARIANT — the human's exact wording, straight into
   * STAGED. No LLM regeneration: the whole point of a correction is that the
   * phrasing is the operator's, not a paraphrase of the broken line. The
   * client message that triggered it becomes a retrieval example so the key
   * can be reached by the same question again.
   */
  stageOperatorVariant(key: string, text: string, msg: string, note: string): boolean {
    const added = this.addStagedVariant(key, text, note, 'operator');
    if (msg.trim()) this.addExample(key, msg);
    return added;
  }

  /** Existing audit row for the same (trigger, replacement). Re-running the
   *  same correction (F9 twice, teach --serve after teach) must not pile
   *  duplicate rows into the review tray. */
  findCorrectionId(msg: string, corrected: string): number | null {
    const row = this.db.db.prepare(
      `SELECT id FROM bank_corrections WHERE msg = ? AND corrected = ? ORDER BY id DESC LIMIT 1`
    ).get(msg, corrected.trim()) as { id: number } | undefined;
    return row?.id ?? null;
  }

  /** Attach the resolved trigger family + mark processed (nightly runner). */
  correctionResolve(id: number, family: string): void {
    this.db.db.prepare(
      `UPDATE bank_corrections SET status = 'processed', family = ?, resolved_at = ? WHERE id = ?`
    ).run(family, Date.now(), id);
  }

  /** Runner couldn't place it — hold for bank:review with a note. */
  correctionStage(id: number, note: string): void {
    this.db.db.prepare(
      `UPDATE bank_corrections SET status = 'staged', reason = ?, resolved_at = ? WHERE id = ?`
    ).run(note, Date.now(), id);
  }

  /** Aggregate stats for the TUI dashboard / health check. `dynamicPending` is
   *  the backlog the operator must act on: captures the loop generated but no
   *  bank key owns yet (bind them with bank:relearn --pending/--bind). */
  stats(): { totalVariants: number; keys: number; examples: number; corrections: number; dynamicPending: number; hitRate: number | null; learnedServes: number; seedServes: number; learnedRate: number | null } {
    const v = this.db.db.prepare(`SELECT COUNT(*) AS c FROM bank_variants`).get() as { c: number };
    const k = this.db.db.prepare(`SELECT COUNT(DISTINCT key) AS c FROM bank_variants`).get() as { c: number };
    const e = this.db.db.prepare(`SELECT COUNT(*) AS c FROM bank_examples`).get() as { c: number };
    const co = this.db.db.prepare(`SELECT COUNT(*) AS c FROM bank_corrections`).get() as { c: number };
    const dp = this.db.db.prepare(`SELECT COUNT(*) AS c FROM bank_dynamic WHERE processed = 0`).get() as { c: number };
    const m = this.db.db.prepare(`SELECT SUM(hits) AS h, SUM(misses) AS ms FROM bank_metrics`).get() as { h: number | null; ms: number | null };
    const h = m.h ?? 0, ms = m.ms ?? 0;
    const lr = this.learnedRate();
    return {
      totalVariants: v.c, keys: k.c, examples: e.c, corrections: co.c, dynamicPending: dp.c,
      hitRate: h + ms > 0 ? h / (h + ms) : null,
      learnedServes: lr.learned, seedServes: lr.seed, learnedRate: lr.rate,
    };
  }

  /** Boot self-test: every bank table must be queryable. Throws on corruption. */
  selfTest(): void {
    for (const t of ['bank_variants', 'bank_examples', 'bank_metrics', 'bank_corrections']) {
      this.db.db.prepare(`SELECT COUNT(*) FROM ${t}`).get();
    }
  }
}
