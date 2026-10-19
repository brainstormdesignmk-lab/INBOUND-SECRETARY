import { ChatSession } from '../fsm/session';

/**
 * The `/state` notebook ON DISK — the WHOLE session, not a projection.
 *
 * `slots` is the session's OWN object (by identity), so a slot added to
 * SlotData can never be silently dropped from the record, and arrays/objects
 * (presentedIds, nearbyLandmarkCoords, nearCenter…) survive serialization
 * untouched. The pty check proves the LIVE command writes it; this module
 * exists so a unit test can prove nothing is trimmed on the way out without
 * driving a terminal — and without importing blessed.
 */
export interface SessionStateDump {
  at: string;
  chatId: string;
  state: string;
  slots: ChatSession['slots'];
}

export function sessionStateDump(chatId: string, s: ChatSession): SessionStateDump {
  return { at: new Date().toISOString(), chatId, state: s.state, slots: s.slots };
}

/**
 * The WIDEST row the chat pane can show without wrapping, at the narrowest
 * terminal the TUI supports (68 columns):
 *     floor(68 × CHAT_PANE_FRACTION 0.75) − 3 (2 borders + scrollbar) = 48.
 * A row wider than this is wrapped by blessed and a value can land on the next
 * visual line — the exact failure the notebook rows exist to prevent.
 */
export const STATE_ROW_MAX_WIDTH = 48;

/** Truncate a free-text value to `n` columns, saying so with an ellipsis. */
function clip(value: string, n: number): string {
  return value.length > n ? `${value.slice(0, n - 1)}…` : value;
}

/**
 * The `/state` PANE ROWS — the operator's live view, deliberately a projection.
 *
 * AUDIT (every SlotData field, and why it is or is not here). The operator
 * watching a live chat needs three questions answered at a glance: WHERE is the
 * funnel, WHAT does the bot know, and WHY is it stuck/widening/closing. Only
 * fields that change what the operator would say or do go on the pane; the
 * dump (`session-state.json`) carries the complete record, arrays included.
 *
 * ON THE PANE:
 *   state, service ............. funnel position + which money script runs
 *   feeRejections, provisionRejections, viewingFeeAgreed
 *                               the two money ladders and consent — the copy
 *                               the client saw is decided here
 *   anywhere, budget, location . the search intent the client actually gave
 *   propertyId / interestedPropertyId, lastGhostEb
 *                               WHICH flat is on the table; ghost explains a
 *                               not-found answer without opening the dump
 *   presentedIds (length) ..... how many properties were served — a repeat
 *                               after "nema poveke" reads here as shown=N
 *   visitTime / ownerTime ..... the appointment being negotiated
 *   name presence ............. whether contact collection produced anything
 *   areaExhausted / alternativesExhausted
 *                               why she is widening or saying there are none
 *   ownerContactPending, queueAfterContact
 *                               what happens next (owner check / re-engage)
 *   byeServed .................. why a second goodbye came back short
 *
 * IN THE DUMP ONLY (operational noise on a 10-row pane):
 *   presentedIds/currentBatch/ladderQueue/ladderKey (full arrays, not a count),
 *   nearCenter.ring, nearbyLandmarks + coords + placeIds + nearbyLandmarkEb,
 *   poiAnchor/poiArea/poiAnchorTooFar, landmarkIndex, addressProtocolIndex/Eb,
 *   lastPrice, soldEb, bothServices, exactLocationTurns, sizeWaived/
 *   waiverAcked, pricePriority, pomaloSize, exitCheckServed, bedrooms/
 *   bedroomsMin/Max/Alt, sqm, business/house/garsonjera/plac/yard,
 *   discoveryAsks/contactAsks, agentName/agentPhone.
 *   Each is either derivable from what IS shown, or only meaningful when
 *   debugging one specific turn — which is exactly what the dump is for.
 *
 * The dump row is LAST on purpose: the pty check reads it as the bottom of the
 * newest block, so the box has to follow the content to the last row.
 */
/** Keys an operator reaches for first, in that order, when they ask for the
 *  WHOLE notebook. Everything else follows alphabetically. */
const FULL_PRIORITY = [
  'service', 'location', 'budget', 'anywhere',
  'propertyId', 'interestedPropertyId', 'presentedIds', 'currentBatch',
  'feeRejections', 'provisionRejections', 'viewingFeeAgreed',
  'visitTime', 'ownerTime', 'name', 'phone',
];

function formatSlotValue(v: unknown): string {
  return typeof v === 'string' ? v : JSON.stringify(v);
}

/**
 * THE WHOLE NOTEBOOK, on the pane — `/state full`.
 *
 * The compact rows are a projection because a 10-row chat pane cannot hold 46
 * slots; this is the answer to "but I need the rest NOW, on the call". It
 * prints every DEFINED slot, one per row, arrays and objects JSON-encoded, so
 * no JSON file is needed to answer an operator's question. It is taller than
 * the pane on purpose (that is why it is opt-in): the box follows the content
 * to the bottom, and the rows are ordered by what an operator reaches for
 * first, so the scroll-off tail is the least important keys.
 */
export function sessionStateFullRows(s: ChatSession | null | undefined, dumpStatus: string): string[] {
  if (!s) return ['[slots] (нема сесија)'];
  const defined = Object.keys(s.slots).filter(k => s.slots[k as keyof typeof s.slots] !== undefined);
  const ordered = [
    ...FULL_PRIORITY.filter(k => defined.includes(k)),
    ...defined.filter(k => !FULL_PRIORITY.includes(k)).sort(),
  ];
  return [
    `[slots] full state=${s.state} svc=${s.slots.service ?? '-'} n=${ordered.length}`,
    ...ordered.map(k => `[slots] ${k}=${formatSlotValue(s.slots[k as keyof typeof s.slots])}`),
    `[slots] dump=${clip(dumpStatus, 34)}`,
  ];
}

export function sessionStateRows(s: ChatSession | null | undefined, dumpStatus: string): string[] {
  if (!s) return ['[slots] (нема сесија)'];
  const sl = s.slots;
  const anchor = sl.propertyId ?? sl.interestedPropertyId;
  const exh = [sl.areaExhausted ? 'area' : '', sl.alternativesExhausted ? 'alt' : '']
    .filter(Boolean).join('+') || '-';
  // visitTime is the client's FREETEXT proposal; ownerTime is the structured
  // counter-proposal. The client's word is what the operator hears on the call,
  // so it wins, clipped — the dump keeps it whole.
  const visit = sl.visitTime ?? sl.ownerTime ?? '-';
  return [
    `[slots] state=${s.state} svc=${sl.service ?? '-'}`,
    `[slots] fee=${sl.feeRejections ?? 0} prov=${sl.provisionRejections ?? 0} agreed=${sl.viewingFeeAgreed ? 'yes' : 'no'}`,
    `[slots] any=${sl.anywhere === true ? 'true' : 'false'} bud=${clip(sl.budget ?? '-', 8)} loc=${clip(sl.location ?? '-', 12)}`,
    `[slots] eb=${anchor ?? '-'} ghost=${sl.lastGhostEb ?? '-'} shown=${sl.presentedIds?.length ?? 0}`,
    `[slots] visit=${clip(visit, 10)} name=${sl.name ? 'y' : 'n'}`,
    `[slots] exh=${exh} owner=${sl.ownerContactPending ? 'pend' : '-'} queue=${sl.queueAfterContact ? 'y' : 'n'} bye=${sl.byeServed ? 'y' : 'n'}`,
    // 8 ('[slots] ') + 5 ('dump=') + 34 = 47 ≤ 48, even for an error message.
    `[slots] dump=${clip(dumpStatus, 34)}`,
  ];
}
