// THE ROUTE TABLE (Phase 2/3) — learned intent routes, keyed on identity.
//
// A row is `(norm, state, sigKey) → event`, plus the evidence that lets it be
// trusted or withdrawn. The lifecycle is deliberately the bank's: nothing
// serves on the day it is written.
//
//   staged  written from the corpus (clean outcomes) or a reviewer; never serves.
//           It accumulates SHADOW evidence: every turn where the route would
//           have fired and the remote classifier agreed.
//   active  promoted after N shadow agreements with no correction. Serves.
//   frozen  two rows share an identity and disagree — neither may serve until a
//           human says which one is right (a conflict is evidence, not a vote).
//   retired withdrawn by a correction, a reviewer, or a failed audit.
//
// THE COMMITMENT BAN IS ENFORCED HERE, at the only door rows come through. A
// route may never emit FEE_AGREED / CONTACT_PROVIDED / TIME_ACCEPTED /
// VISIT_TIME_PROVIDED: those advance the money ladder and the visit protocol,
// and a wrong one is a false consent, not a misroute.
//
// Two more refusals, both learned from the calibration (runbook §4):
//   • a payload-dependent event (PROPERTY_ID_REQUESTED needs an EB) is not
//     servable — the row stores an event, not a property;
//   • a row whose signature is not parseable is dead on arrival.

import { Db } from './db';

export const SAFE_EVENTS = new Set([
  'STAY', 'DETAILS_PROVIDED', 'SEARCH_REQUESTED', 'INTERESTED', 'REJECTED',
]);

export const COMMITMENT_EVENTS = new Set([
  'FEE_AGREED', 'CONTACT_PROVIDED', 'TIME_ACCEPTED', 'VISIT_TIME_PROVIDED',
]);

/** Events that carry a payload the table cannot reconstruct. */
const PAYLOAD_EVENTS = new Set(['PROPERTY_ID_REQUESTED']);

export type RouteLifecycle = 'staged' | 'active' | 'frozen' | 'retired';

export interface RouteRow {
  id: number;
  norm: string;
  state: string;
  sig: string;
  sigKey: string;
  event: string;
  source: string;
  lifecycle: RouteLifecycle;
  hits: number;
  misses: number;
  shadowHits: number;
  shadowMisses: number;
  lastServed: number | null;
  validatorVersion: string;
  note: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RouteIdentity {
  norm: string;
  state: string;
  sig: string;
  sigKey: string;
}

export type UpsertResult =
  | { action: 'inserted'; id: number }
  | { action: 'exists'; id: number }
  | { action: 'conflict'; ids: number[] }
  | { action: 'refused'; reason: string };

const SELECT = `
  SELECT id, norm, state, sig, sig_key AS sigKey, event, source, lifecycle,
         hits, misses, shadow_hits AS shadowHits, shadow_misses AS shadowMisses,
         last_served AS lastServed, validator_version AS validatorVersion,
         note, created_at AS createdAt, updated_at AS updatedAt
  FROM route_table`;

export class RouteStore {
  /** Shadow agreements needed before a staged row may serve. Three is enough
   *  to catch a mislabelled corpus row without waiting a month; the operator
   *  can always promote by hand. */
  static readonly PROMOTE_AFTER = 3;

  constructor(private db: Db) {}

  /** The one door rows come through. Refuses commitment and payload events. */
  upsertFromCorpus(input: RouteIdentity & { event: string; source?: string; note?: string }): UpsertResult {
    const event = input.event.trim().toUpperCase();
    if (COMMITMENT_EVENTS.has(event)) {
      return { action: 'refused', reason: `${event} is a commitment event — it is never learned` };
    }
    if (PAYLOAD_EVENTS.has(event)) {
      return { action: 'refused', reason: `${event} carries a payload the table cannot reconstruct` };
    }
    if (!SAFE_EVENTS.has(event)) {
      return { action: 'refused', reason: `${event} is not in the servable set` };
    }
    if (!input.norm || !input.state || !input.sigKey) {
      return { action: 'refused', reason: 'identity incomplete' };
    }
    const existing = this.db.db.prepare(
      `${SELECT} WHERE norm = ? AND state = ? AND sig_key = ?`,
    ).all(input.norm, input.state, input.sigKey) as RouteRow[];

    const same = existing.find(r => r.event === event);
    if (same) return { action: 'exists', id: same.id };

    if (existing.length > 0) {
      // CONFLICT: the same identity already maps to a different event. Freeze
      // both, file ONE correction, and let a human decide. Serving either
      // would be a coin flip on the client's intent.
      const now = Date.now();
      this.db.db.prepare(
        `UPDATE route_table SET lifecycle = 'frozen', updated_at = ? WHERE norm = ? AND state = ? AND sig_key = ?`,
      ).run(now, input.norm, input.state, input.sigKey);
      this.db.db.prepare(
        'INSERT INTO route_corrections (norm, state, sig_key, served_event, expected, reason, created_at) VALUES (?,?,?,?,?,?,?)',
      ).run(input.norm, input.state, input.sigKey, existing[0]!.event, event, 'conflicting rules for one identity', now);
      const id = Number(this.db.db.prepare(
        `INSERT INTO route_table (norm, state, sig, sig_key, event, source, lifecycle, note, created_at, updated_at)
         VALUES (?,?,?,?,?,?,'frozen',?,?,?)`,
      ).run(input.norm, input.state, input.sig, input.sigKey, event, input.source ?? 'corpus',
        'frozen by a conflicting rule', now, now).lastInsertRowid);
      return { action: 'conflict', ids: [...existing.map(r => r.id), id] };
    }

    const now = Date.now();
    const id = Number(this.db.db.prepare(
      `INSERT INTO route_table (norm, state, sig, sig_key, event, source, lifecycle, note, created_at, updated_at)
       VALUES (?,?,?,?,?,?,'staged',?,?,?)`,
    ).run(input.norm, input.state, input.sig, input.sigKey, event,
      input.source ?? 'corpus', input.note ?? null, now, now).lastInsertRowid);
    return { action: 'inserted', id };
  }

  /** Exact identity lookup — the ONLY serving lookup (never fuzzy). */
  findExact(norm: string, state: string, sigKey: string): RouteRow | null {
    const rows = this.db.db.prepare(
      `${SELECT} WHERE norm = ? AND state = ? AND sig_key = ? ORDER BY id DESC LIMIT 1`,
    ).all(norm, state, sigKey) as RouteRow[];
    return rows[0] ?? null;
  }

  byId(id: number): RouteRow | null {
    return (this.db.db.prepare(`${SELECT} WHERE id = ?`).get(id) as RouteRow | undefined) ?? null;
  }

  list(lifecycle?: RouteLifecycle, limit = 200): RouteRow[] {
    return lifecycle
      ? this.db.db.prepare(`${SELECT} WHERE lifecycle = ? ORDER BY id DESC LIMIT ?`).all(lifecycle, limit) as RouteRow[]
      : this.db.db.prepare(`${SELECT} ORDER BY id DESC LIMIT ?`).all(limit) as RouteRow[];
  }

  recordServe(id: number, clean: boolean): void {
    const now = Date.now();
    this.db.db.prepare(
      `UPDATE route_table SET hits = hits + 1, misses = misses + ?, last_served = ?, updated_at = ? WHERE id = ?`,
    ).run(clean ? 0 : 1, now, now, id);
  }

  /** Shadow evidence: the route would have fired; did the remote agree? */
  recordShadow(id: number, agreed: boolean): void {
    this.db.db.prepare(
      `UPDATE route_table SET ${agreed ? 'shadow_hits' : 'shadow_misses'} =
         ${agreed ? 'shadow_hits' : 'shadow_misses'} + 1, updated_at = ? WHERE id = ?`,
    ).run(Date.now(), id);
  }

  /** Promotion is evidence-driven and reversible. */
  promoteEligible(after = RouteStore.PROMOTE_AFTER): number {
    return this.db.db.prepare(
      `UPDATE route_table SET lifecycle = 'active', updated_at = ?
       WHERE lifecycle = 'staged' AND shadow_hits >= ? AND shadow_misses = 0`,
    ).run(Date.now(), Math.max(1, after)).changes;
  }

  /** A correction withdraws the row AND files the evidence. */
  retireByCorrection(id: number, reason: string, expected?: string): boolean {
    const row = this.byId(id);
    if (!row) return false;
    const now = Date.now();
    this.db.db.prepare(`UPDATE route_table SET lifecycle = 'retired', note = ?, updated_at = ? WHERE id = ?`)
      .run(reason, now, id);
    this.db.db.prepare(
      'INSERT INTO route_corrections (norm, state, sig_key, served_event, expected, reason, created_at) VALUES (?,?,?,?,?,?,?)',
    ).run(row.norm, row.state, row.sigKey, row.event, expected ?? null, reason, now);
    return true;
  }

  retireByIdentity(norm: string, state: string, sigKey: string, reason: string): number {
    return this.db.db.prepare(
      `UPDATE route_table SET lifecycle = 'retired', note = ?, updated_at = ?
       WHERE norm = ? AND state = ? AND sig_key = ? AND lifecycle != 'retired'`,
    ).run(reason, Date.now(), norm, state, sigKey).changes;
  }

  corrections(limit = 100): Array<{ id: number; norm: string; state: string; sigKey: string; servedEvent: string; expected: string | null; reason: string; createdAt: number }> {
    return this.db.db.prepare(`
      SELECT id, norm, state, sig_key AS sigKey, served_event AS servedEvent,
             expected, reason, created_at AS createdAt
      FROM route_corrections ORDER BY id DESC LIMIT ?`).all(limit) as never;
  }

  stats(): { total: number; active: number; staged: number; frozen: number; retired: number; hits: number } {
    const rows = this.db.db.prepare(
      'SELECT lifecycle, COUNT(*) AS n, SUM(hits) AS hits FROM route_table GROUP BY lifecycle',
    ).all() as Array<{ lifecycle: string; n: number; hits: number | null }>;
    const out = { total: 0, active: 0, staged: 0, frozen: 0, retired: 0, hits: 0 };
    for (const r of rows) {
      out.total += r.n;
      out.hits += r.hits ?? 0;
      if (r.lifecycle in out) (out as unknown as Record<string, number>)[r.lifecycle] = r.n;
    }
    return out;
  }
}
