import { OwnerStore, OwnerStatus } from '../store/owners';
import { EventStore } from '../store/events';

// THE CONTRACT. Lina's LLM never decides availability — the OwnerAgent does.
// Phase 1: local (deterministic from the owners table) or deferred (TUI /owner commands).
// Phase 2: Hermes answers the same interface via the events bus.
export interface OwnerVerdict {
  /** `available` = the owner answered the AVAILABILITY half only («DOSTAPNA E
   *  DA»): the flat is free, the term is still open. It must never finalize a
   *  visit — the handler serves the availability ack and keeps the check open
   *  (the [23:41] contract). It exists so a caller that parses owner text
   *  OUTSIDE this repo (Hermes, a channel bot) has an honest shape to send
   *  instead of forcing a half-answer into `ok` (which means "agreed") or
   *  `counter` (which means "refused"). */
  status: 'ok' | 'counter' | 'gone' | 'available';
  ownerTime?: string; // counter-proposal, e.g. 'Петок 11.06.2026 во 18:30'
  /** The counter proposes a DAY with any hour accepted ("КЕ МОРа во сабота,
   *  било кое време") — the relay must ask the client to precise the exact
   *  clock instead of treating the day as a fixed term. */
  canAcceptWholeDay?: boolean;
  note?: string;
  /** New price the owner dictates (EUR) — the price can change, the owner is
   *  the source of truth. The handler stores it so Hermes corrects the public
   *  app (Lovable/Cloudflare) and relays the change to the client. */
  price?: number;
  /** THE OWNER'S EXTRA CONDITIONS, in his own words (the operator's 2026-11-12
   *  request): a deposit, the first month's rent, an advance — everything he
   *  attaches to his yes besides the term. Without this they died in the
   *  parser: the client booked a viewing under conditions he had never heard,
   *  and the operator only saw them in the owner's message. The handler
   *  relays them to the client BEFORE the visit is locked, and (like a moved
   *  price) the booking stays the CLIENT's decision. */
  conditions?: string[];
}

export interface OwnerAgent {
  readonly name: string;
  /** `askText` is the owner-facing ask Lina already composed for this check (the
   *  bank-served owner.ask / follow-up line). It rides the pending-check event
   *  so a remote deliverer (Hermes, /hermes/v1/work) sends LINA'S wording, not a
   *  re-composition of its own — one copy source for the owner channel. */
  check(chatId: string, eb: number, proposedTime: string, askText?: string): Promise<OwnerVerdict>;
}

function verdictFor(status: OwnerStatus, proposedTime: string, note?: string): OwnerVerdict {
  switch (status) {
    case 'sold':
      return { status: 'gone', note: note || 'недвижноста е продадена' };
    case 'rented':
      return { status: 'gone', note: note || 'недвижноста е издадена' };
    case 'under_option':
      return { status: 'gone', note: note || 'недвижноста е под опција — за жал не е достапна за посета во моментов' };
    case 'unknown':
      return { status: 'counter', ownerTime: undefined, note: note || 'сопственикот допрва треба да потврди термин' };
    case 'available':
    default:
      return { status: 'ok', ownerTime: proposedTime };
  }
}

/** Deterministic backend — placeholder for Hermes. Resolves instantly from the owners table. */
export class LocalOwnerAgent implements OwnerAgent {
  readonly name = 'local';

  constructor(private owners: OwnerStore, private events: EventStore) {}

  async check(chatId: string, eb: number, proposedTime: string, _askText?: string): Promise<OwnerVerdict> {
    const requestId = this.events.insert('owner_check_requested', chatId, eb, { proposedTime });
    const row = this.owners.get(eb);
    const status: OwnerStatus = row?.status ?? 'available'; // lazy default
    const verdict = verdictFor(status, proposedTime, row?.note);
    // The answer is immediate, so the check was NEVER waiting: leaving the
    // request pending made /hermes/v1/work list every check the local agent ever
    // answered as outstanding work for Hermes. A request row means "waiting".
    this.events.resolve(requestId);
    this.events.insert('owner_check_result', chatId, eb, { ...verdict, source: 'local' });
    return verdict;
  }
}

/**
 * Deferred backend for the interactive TUI: Lina says "ќе Ве известам штом потврдам"
 * and waits. The user answers with /owner <eb> ok|sold|rented|counter <time> —
 * the same seam Hermes will use in phase 2.
 */
/** What a timed-out owner check looks like to the entry point that owns the
 *  operator channel. The check itself STAYS PENDING (a late answer is still
 *  welcome); the hook exists so the silence is not the client's problem alone:
 *  the operator is told and the client gets an honest re-ping (visit audit #5). */
export interface OwnerCheckTimeout {
  chatId: string;
  eb: number;
  proposedTime: string;
  waitedMs: number;
}

export class DeferredOwnerAgent implements OwnerAgent {
  readonly name = 'deferred';
  private pending = new Map<string, { eb: number; time: string; resolve: (v: OwnerVerdict) => void }>();

  constructor(
    private owners: OwnerStore,
    private events: EventStore,
    private timeoutMs: number,
    private pollMs = 2000,
    /** Fired ONCE per check when the window passes with no answer. */
    private onTimeout?: (info: OwnerCheckTimeout) => void | Promise<void>,
  ) {}

  /** ONE LIVE REQUEST PER CHAT. `owner_check_requested` is the bus's record of
   *  a check that is actually WAITING, and /hermes/v1/work hands those rows to
   *  Hermes as owner work. Every re-ask/re-arm inserted another row, so the
   *  queue grew by one per owner turn and listed closed checks forever. A new
   *  check supersedes the previous one for the same chat. */
  private settle(chatId: string, eb?: number): void {
    for (const ev of this.events.listPending('owner_check_requested')) {
      if (ev.chatId !== chatId) continue;
      if (eb !== undefined && ev.eb !== null && ev.eb !== undefined && ev.eb !== eb) continue;
      this.events.resolve(ev.id);
    }
  }

  /** The term this owner is currently being asked about, if a check is open. */
  pendingProposedTime(chatId: string): string | null {
    return this.pending.get(chatId)?.time ?? null;
  }

  check(chatId: string, eb: number, proposedTime: string, askText?: string): Promise<OwnerVerdict> {
    this.settle(chatId);
    this.events.insert('owner_check_requested', chatId, eb, { proposedTime, askText });
    const requestedAt = Date.now();
    // STALE-EVENT GUARD: a previous check for the same chatId+EB can leave an
    // owner_check_result on the bus (process died/restarted between insert and
    // poll). Without a guard the NEXT check consumes that leftover instantly —
    // Lina relays a "counter: 19:00" verdict the owner NEVER GAVE for THIS
    // visit. Events older than the request are junk from the past: consume AND
    // resolve them so they can never fire again, but never act on them.
    for (const stale of this.events.listPending('owner_check_result')
      .filter(r => r.chatId === chatId && r.eb === eb && (r.createdAt ?? 0) < requestedAt)) {
      this.events.resolve(stale.id);
      console.error(`[owner] dropped stale owner_check_result (id=${stale.id}) predating this check for chat=${chatId} eb=${eb}`);
    }
    return new Promise<OwnerVerdict>(resolve => {
      this.pending.set(chatId, { eb, time: proposedTime, resolve });
      // Cross-process: Hermes (machine B) answers through the /hermes/v1 API,
      // which writes an owner_check_result event on the shared bus. Poll the
      // bus so the answer resolves from ANY process holding this check — the
      // events table, not the process memory, is the real bus.
      const poll = setInterval(() => {
        const p = this.pending.get(chatId);
        if (!p || p.eb !== eb) {
          clearInterval(poll);
          return;
        }
        // ONLY events created AFTER this check was requested count — anything
        // older is a leftover from a previous visit (see the stale guard above;
        // belt-and-braces: double-checked at consumption time).
        // The bus can be GONE under a live poll (the DB was closed on shutdown,
        // or a test harness moved on). A background poll must never throw an
        // uncaught exception for that: stop polling and drop the check.
        let hit;
        try {
          hit = this.events.listPending('owner_check_result')
            .find(r => r.chatId === chatId && r.eb === eb && (r.createdAt ?? 0) >= requestedAt);
        } catch (e) {
          clearInterval(poll);
          this.pending.delete(chatId);
          console.error(`[owner] owner-check poll stopped for EB ${eb}: ${(e as Error).message}`);
          return;
        }
        if (!hit) return;
        clearInterval(poll);
        this.pending.delete(chatId);
        this.events.resolve(hit.id);
        // The check is answered — its request row is no longer waiting work.
        this.settle(chatId, eb);
        p.resolve(JSON.parse(hit.payload) as OwnerVerdict);
      }, this.pollMs);
      poll.unref();
      const timer = setTimeout(() => {
        // The check stays pending (a late answer still resolves it) — but a
        // timeout is no longer a console line nobody reads. The POLL keeps
        // running: clearing it here is what made a late Hermes answer
        // unreachable and the client parked forever.
        const live = this.pending.get(chatId);
        if (!live || live.eb !== eb) return;
        console.error(`[owner] no answer within ${this.timeoutMs}ms for EB ${eb} — check stays pending (event remains in bus)`);
        if (!this.onTimeout) return;
        try {
          void Promise.resolve(this.onTimeout({ chatId, eb, proposedTime, waitedMs: Date.now() - requestedAt }))
            .catch(e => console.error('[owner] timeout hook failed:', (e as Error).message));
        } catch (e) {
          console.error('[owner] timeout hook threw:', (e as Error).message);
        }
      }, this.timeoutMs);
      timer.unref();
    });
  }

  pendingEb(chatId: string): number | null {
    return this.pending.get(chatId)?.eb ?? null;
  }

  /** The answer arrives (TUI /owner today, Hermes phase 2 via the API). */
  answer(chatId: string, eb: number, verdict: OwnerVerdict): boolean {
    const p = this.pending.get(chatId);
    if (!p || p.eb !== eb) return false;
    this.pending.delete(chatId);
    this.settle(chatId, eb);
    this.events.insert('owner_check_result', chatId, eb, { ...verdict, source: 'deferred' });
    p.resolve(verdict);
    return true;
  }

  /** TUI debug: set the truth in the store AND resolve a pending check if one exists.
   *  action 'price' = the owner is available but dictates a NEW price (the arg
   *  is the amount in EUR) — stored so Hermes corrects the public app. */
  simulate(chatId: string, eb: number, action: 'ok' | 'available' | 'sold' | 'rented' | 'counter' | 'price', ownerTime?: string): boolean {
    // THE OPERATOR'S «ok» NAMES ITS OBJECT (the [23:41] rule): `/owner 54 ok`
    // means "yes to the term you asked him about". It used to travel with NO
    // term, and the handler then adopted the CLIENT's proposed term on its own —
    // which is exactly the ambiguous consent the verdict contract now forbids
    // (an `ok` without a term reads as availability-only and never finalizes).
    // Stamping the pending proposed term keeps the operator shortcut working
    // while making the verdict say what it means.
    const proposed = ownerTime ?? this.pending.get(chatId)?.time ?? undefined;
    let verdict: OwnerVerdict;
    switch (action) {
      case 'ok':
        verdict = { status: 'ok', ownerTime: proposed };
        this.owners.setStatus(eb, 'available');
        break;
      case 'available':
        // The operator reproduces a HALF answer («DOSTAPNA E DA»): availability
        // confirmed, term still open. The funnel serves the ack and keeps
        // waiting — never a booking.
        verdict = { status: 'available' };
        this.owners.setStatus(eb, 'available');
        break;
      case 'sold':
        verdict = { status: 'gone', note: 'недвижноста е продадена' };
        // The note agrees with "недвижност" (feminine) — "продаден" leaked into
        // the client reply as "недвижноста … е продаден" (the [12:08] capture).
        this.owners.setStatus(eb, 'sold', 'продадена');
        break;
      case 'rented':
        verdict = { status: 'gone', note: 'недвижноста е издадена' };
        this.owners.setStatus(eb, 'rented', 'издадена');
        break;
      case 'price': {
        const n = Number((ownerTime ?? '').replace(/[^\d]/g, ''));
        verdict = { status: 'ok', ownerTime, price: Number.isFinite(n) && n > 0 ? n : undefined };
        this.owners.setStatus(eb, 'available', ownerTime ? `нова цена: ${ownerTime}` : 'нова цена');
        break;
      }
      case 'counter':
        // NO fabricated default: a counter without a time means the owner can't
        // do the proposed time (no alternative) — the handler relays the honest
        // refusal and asks the client for another time, never "по договор со
        // сопственикот" (a fake term whose accept confirmed the REFUSED time).
        verdict = { status: 'counter', ownerTime };
        this.owners.setStatus(eb, 'available', `counter: ${ownerTime ?? '?'}`);
        break;
    }
    return this.answer(chatId, eb, verdict);
  }
}
