// THE TURN RECORD — per-turn values and ONE audit object per turn (proposal
// Phase 2).
//
// WHY THIS EXISTS. Three values were stored as FIELDS on the `InboundHandler`
// instance: the raw inbound text (`lastUserText`), the deterministic
// classifier's gave-up flag (`detGaveUp`) and the service the message itself
// declared (`feeServiceHint`). The TUI runs ONE handler for EVERY chat
// (`src/tui/app.ts`), and the per-chat queue only serializes turns INSIDE one
// chat — so the moment two clients are mid-turn at the same time (both waiting
// on the classifier), the second turn overwrites the first turn's values and
// the first turn's lanes read the other client's text. Flow B's answer built
// from flow A's message is invisible in the reply and impossible to reproduce
// from a capture.
//
// The fix is not "reset the fields more carefully" (that is still one slot for
// N concurrent turns): the values live in an AsyncLocalStorage record that is
// created once per turn and inherited by everything that turn awaits, so
// concurrency cannot cross them — including a lane that a future commit adds,
// because it reads the same accessors.
//
// The same record is the AUDIT. The proposal's claim G was that the console /
// audit record could disagree with the text actually sent; the funnel had
// per-lane `enrichment.insert()` calls that each pass their own idea of the
// reply. Here the reply is appended by `sendRaw` — the ONE function that hands
// bytes to the transport — so the record can only ever hold what the client
// received, in order.
//
// It is deliberately small: it is persisted on the session (`lastTurn`), rides
// every `sessions.set()`, and the next turn reads it as its `previous`. That is
// what lets a "why did you tell me X?" turn explain the answer it is being
// asked about instead of guessing.

import { AsyncLocalStorage } from 'node:async_hooks';
import type { Service } from '../fsm/machine';

/** One audit record per inbound turn. Everything here is measured at the seam
 *  it describes — never reconstructed afterwards from a lane's own belief. */
export interface TurnAudit {
  /** Epoch ms the turn started. */
  at: number;
  chatId: string;
  channel: string;
  /** The raw inbound text, verbatim (whitespace included). */
  text: string;
  /** FSM state when the turn began / when it ended. A factual question must
   *  leave these EQUAL: the funnel does not move on an answer. */
  stateBefore: string;
  stateAfter: string;
  /** What the shadow router predicted (`resolveIntent`), when a prediction ran. */
  predicted?: string;
  /** Every actual lane that logged itself this turn, in order (`[route]`). */
  lanes: string[];
  /** How the reply was chosen: 'bank', 'deterministic', 'llm', … (sendRaw's own
   *  `source`, first write wins — later sends are follow-ups of the same turn). */
  source?: string;
  bankKey?: string;
  /** The property the session was pointing at when the turn ended, if any. */
  targetEb?: number;
  /** Facts the answer leaned on, as `key=value` strings (price, sqm, m² rate,
   *  availability, distance …). Populated by the lane that served; a claim the
   *  client can point at must appear here, or the explanation lane has nothing
   *  truthful to explain. */
  facts: string[];
  /** EVERY text the client received this turn, verbatim and in order. */
  replies: string[];
  /** The previous turn's record — the answer the client may be asking about. */
  previous?: TurnAudit;
}

/** The per-turn values, scoped by AsyncLocalStorage. */
export interface TurnContext {
  audit: TurnAudit;
  /** True while THIS turn's deterministic pre-classify gave up (undefined →
   *  the LLM classifier fired). Set at the classify seam, read at the turn-end
   *  capture hook. */
  detGaveUp: boolean;
  /** The service the message ITSELF declares; undefined = says nothing about
   *  market, NOT "buy" (the [09:0x] fee-script-for-a-rent-client bug). */
  feeServiceHint?: Service;
}

const MAX_REPLY_CHARS = 600;

/** Truncation is a storage guard (the record is persisted with the session on
 *  every set()), never a copy rule: the transport always gets the full text. */
function clip(text: string): string {
  return text.length > MAX_REPLY_CHARS ? `${text.slice(0, MAX_REPLY_CHARS)}…` : text;
}

export function startTurn(input: {
  chatId: string;
  channel: string;
  text: string;
  stateBefore: string;
  previous?: TurnAudit;
}): TurnContext {
  return {
    audit: {
      at: Date.now(),
      chatId: input.chatId,
      channel: input.channel,
      text: input.text,
      stateBefore: input.stateBefore,
      stateAfter: input.stateBefore,
      lanes: [],
      facts: [],
      replies: [],
      previous: input.previous,
    },
    detGaveUp: false,
  };
}

const TURN = new AsyncLocalStorage<TurnContext>();

export function currentTurn(): TurnContext | undefined {
  return TURN.getStore();
}

/** For `routeLog` and any other module the turn calls into: the audit of the
 *  turn in flight, or undefined when the call is not part of a turn. */
export function currentTurnAudit(): TurnAudit | undefined {
  return TURN.getStore()?.audit;
}

export function runInTurn<T>(ctx: TurnContext, fn: () => Promise<T>): Promise<T> {
  return TURN.run(ctx, fn);
}

/** Append a fact once (`key=value`), bounded: the record rides every session
 *  write and an unbounded list would grow the row forever. */
export function noteTurnFact(audit: TurnAudit, key: string, value: string | number | undefined): void {
  if (value === undefined || value === '') return;
  const entry = `${key}=${value}`;
  if (audit.facts.includes(entry) || audit.facts.length >= 12) return;
  audit.facts.push(entry);
}

/** A context for calls that are NOT a client turn (owner-message seams, direct
 *  helper calls in tests): the accessors must never throw, and this one is
 *  per-handler so it cannot leak between handlers. */
export function ambientTurn(): TurnContext {
  return startTurn({ chatId: '', channel: '', text: '', stateBefore: '' });
}

export { clip as clipReply };
