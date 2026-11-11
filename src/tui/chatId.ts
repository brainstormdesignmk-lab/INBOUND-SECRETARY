// CHAT IDENTITY IS PER RUN, NOT PER SLOT.
//
// data/tui.db persists across TUI runs while the client counter restarts at 1,
// so the first client of every run used to share `chat_id = 'client-1'` with
// the first client of every PREVIOUS run. The session row was cleared on claim
// (see App.confirmName), but every operational record keyed by chat id —
// appointments, events, escalations, enrichment — stayed, and the [20:54]
// capture proved the cost: a brand-new client asked what was being arranged and
// was read an EB 79 visit booked on 2026-11-09 by a different person, from the
// same `client-1`.
//
// The identity therefore carries the RUN it was minted in: `client-1@<stamp>`.
// This is a property of the TUI's demo channel, whose ids are a counter: a REAL
// channel (WhatsApp/Telegram) mints an id that is stable per human, and there
// the epoch must not be applied — a client who returns tomorrow is the same
// client, and the blocklist/customers rows rightly follow them. The stamp is
// minted by the caller (App.confirmName), never inside the stores.
// The display half stays what an operator types (`/state client-1`), the stamp
// makes two runs distinct, and every store that keys on the session's chatId is
// separated by construction instead of by remembering to delete rows.

/** A short, sortable marker for THIS process. Base36 of the start time, last 5
 *  digits: unique per millisecond run stamp (36^5 ≈ 60M values) and short enough
 *  for the lead row and a `/state` argument. */
export function runStamp(now: number = Date.now()): string {
  return now.toString(36).slice(-5);
}

/** The chat id a new client gets in this run. */
export function newClientId(seq: number, stamp: string): string {
  return `client-${seq}@${stamp}`;
}

/** The operator-facing half of a chat id — what `/state <id>` accepts and what
 *  the lead row shows as the client's name. */
export function displayChatId(chatId: string): string {
  const at = chatId.indexOf('@');
  return at === -1 ? chatId : chatId.slice(0, at);
}
