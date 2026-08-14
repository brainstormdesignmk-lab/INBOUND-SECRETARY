import { OwnerStore, OwnerStatus } from '../store/owners';
import { EventStore } from '../store/events';

// THE CONTRACT. Lina's LLM never decides availability — the OwnerAgent does.
// Phase 1: local (deterministic from the owners table) or deferred (TUI /owner commands).
// Phase 2: Hermes answers the same interface via the events bus.
export interface OwnerVerdict {
  status: 'ok' | 'counter' | 'gone';
  ownerTime?: string; // counter-proposal, e.g. 'Петок 11.06.2026 во 18:30'
  note?: string;
}

export interface OwnerAgent {
  readonly name: string;
  check(chatId: string, eb: number, proposedTime: string): Promise<OwnerVerdict>;
}

function verdictFor(status: OwnerStatus, proposedTime: string, note?: string): OwnerVerdict {
  switch (status) {
    case 'sold':
      return { status: 'gone', note: note || 'имотот е продаден' };
    case 'rented':
      return { status: 'gone', note: note || 'имотот е издаден' };
    case 'under_option':
      return { status: 'gone', note: note || 'имотот е под опција — за жал не е достапен за посета во моментов' };
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

  async check(chatId: string, eb: number, proposedTime: string): Promise<OwnerVerdict> {
    this.events.insert('owner_check_requested', chatId, eb, { proposedTime });
    const row = this.owners.get(eb);
    const status: OwnerStatus = row?.status ?? 'available'; // lazy default
    const verdict = verdictFor(status, proposedTime, row?.note);
    this.events.insert('owner_check_result', chatId, eb, { ...verdict, source: 'local' });
    return verdict;
  }
}

/**
 * Deferred backend for the interactive TUI: Lina says "ќе Ве известам штом потврдам"
 * and waits. The user answers with /owner <eb> ok|sold|rented|counter <time> —
 * the same seam Hermes will use in phase 2.
 */
export class DeferredOwnerAgent implements OwnerAgent {
  readonly name = 'deferred';
  private pending = new Map<string, { eb: number; resolve: (v: OwnerVerdict) => void }>();

  constructor(private owners: OwnerStore, private events: EventStore, private timeoutMs: number) {}

  check(chatId: string, eb: number, proposedTime: string): Promise<OwnerVerdict> {
    this.events.insert('owner_check_requested', chatId, eb, { proposedTime });
    return new Promise<OwnerVerdict>(resolve => {
      this.pending.set(chatId, { eb, resolve });
      const timer = setTimeout(() => {
        if (this.pending.has(chatId)) {
          console.error(`[owner] no answer within ${this.timeoutMs}ms for EB ${eb} — check stays pending (event remains in bus)`);
        }
      }, this.timeoutMs);
      timer.unref();
    });
  }

  pendingEb(chatId: string): number | null {
    return this.pending.get(chatId)?.eb ?? null;
  }

  /** The answer arrives (TUI /owner today, Hermes phase 2). */
  answer(chatId: string, eb: number, verdict: OwnerVerdict): boolean {
    const p = this.pending.get(chatId);
    if (!p || p.eb !== eb) return false;
    this.pending.delete(chatId);
    this.events.insert('owner_check_result', chatId, eb, { ...verdict, source: 'deferred' });
    p.resolve(verdict);
    return true;
  }

  /** TUI debug: set the truth in the store AND resolve a pending check if one exists. */
  simulate(chatId: string, eb: number, action: 'ok' | 'sold' | 'rented' | 'counter', ownerTime?: string): boolean {
    let verdict: OwnerVerdict;
    switch (action) {
      case 'ok':
        verdict = { status: 'ok', ownerTime };
        this.owners.setStatus(eb, 'available');
        break;
      case 'sold':
        verdict = { status: 'gone', note: 'имотот е продаден' };
        this.owners.setStatus(eb, 'sold', 'продаден');
        break;
      case 'rented':
        verdict = { status: 'gone', note: 'имотот е издаден' };
        this.owners.setStatus(eb, 'rented', 'издаден');
        break;
      case 'counter':
        verdict = { status: 'counter', ownerTime: ownerTime ?? 'по договор со сопственикот' };
        this.owners.setStatus(eb, 'available', `counter: ${ownerTime ?? '?'}`);
        break;
    }
    return this.answer(chatId, eb, verdict);
  }
}
