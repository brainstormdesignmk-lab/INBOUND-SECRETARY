import { State, Service } from './machine';
import { randomGreeting } from '../data/greetings';
import { Db } from '../store/db';

export interface SlotData {
  service?: Service;
  location?: string;
  /** Rows a price LIST answer did not fit yet, in the lane's own order. A
   *  follow-up „уште?“ continues HERE — the discovery ladder never built a
   *  queue from this entry point, so the extra rows used to be unreachable. */
  extremeQueue?: number[];
  /** The wording the continuation reuses („во Аеродром“, „во сите населби“). */
  extremeWhere?: string;
  extremePlural?: string;
  extremeNoun?: string;
  bedrooms?: number;
  bedroomsMin?: number;         // bedroom RANGE (ROOMS): "edna ili dve" → 2…3
  bedroomsMax?: number;         // range high bound; set ⇒ the exact-category alternation ladder owns presentation
  bedroomsAlt?: boolean;        // alternating 1-спална/2-спални presentation active ([09:17] contract)
  sqm?: number;                 // commercial (деловен простор) — size instead of bedrooms
  business?: boolean;           // commercial property intent
  house?: boolean;              // куќа — a residential request that is NOT a стан
  budget?: string;
  // DUAL-SERVICE MONEY (the [12:33] business capture): the client splits his
  // budget PER SERVICE in consecutive messages — «za kirija do 1000 evra»,
  // «za kupuvanje do 2000000». Each lands in its OWN slot; when both exist
  // the funnel is a dual-service search (rent AND buy), slots.budget is
  // retired (a single budget would silently govern both services) and the
  // serve pairs the two segments one-rent-one-buy.
  rentBudget?: string;          // the client's cap for RENT money alone
  buyBudget?: string;           // the client's cap for BUY money alone
  dualService?: boolean;        // both budgets are on file — serve rent+buy pairs
  anywhere?: boolean;           // "било каде" — no location preference (satisfies location)
  sizeWaived?: boolean;        // "големината не ми е битна" — skip bedrooms question
  waiverAcked?: boolean;       // the banked discovery.waiver.ack intro was served for THIS waiver
  exactLocationTurns?: number; // consecutive EXACT-address demands (turn 2 = agency protocol)
  pricePriority?: boolean;     // "што поевтино" — sort by price, skip budget question
  garsonjera?: boolean;        // "гарсоњера mi treba" — explicit studio category (NOT "1 спална")
  plac?: boolean;              // "плац за градење" — land plot category
  yard?: boolean;              // "со двор/дворче/градина" — needs outdoor space (implies house)
  propertyId?: number;          // EB of the property currently discussed
  interestedPropertyId?: number; // EB the client praised/anchored (funnel-arming)
  lastGhostEb?: number;         // last EB served the not-found pivot — where-is
                                 // follow-ups still NAME it (the where-stuck fix);
                                 // never used to arm the funnel
   presentedIds?: number[];      // ALL EBs shown so far (excluded from later batches)
  currentBatch?: number[];      // EBs in the CURRENT presentation batch
  /** The EBs she just DESCRIBED in the which-one ask (the [09:59] capture).
   *  Two things read it: «опиши ми ги?» serves the bank's own data for THESE
   *  flats (the records she has — never «немам детали»), and a pick of one of
   *  them opens the availability answer instead of a card re-description. */
  describedEbs?: number[];
  /** The place the described flats sit near (the landmark the client named).
   *  It scopes the continuation of that hunt — the next options come from
   *  THERE, and only the client's «да» to the other-neighbourhoods question
   *  releases it (a place-locked hunt must not silently change places). */
  clarifyAnchor?: { name: string; lat: number; lon: number };
  alternativesExhausted?: boolean;
  ladderKey?: string;           // presentation ladder: the search key (loc|service|budget) the queue was built for
  ladderQueue?: number[];       // presentation ladder: remaining EB ids in ladder order (top → cheapest → middle → rest)
  areaExhausted?: boolean;      // the selected area(s) are drained and Lina ASKED
  /** Near-center ladder ("vo blizina na centar" — the 23:08 protocol):
   *  'ask' = Lina asked whether a specific neighborhood is in mind;
   *  'ring' = mixed pairs from the center-border ring (Карпош, Аеродром,
   *  Кисела Вода), with client-eliminated areas dropped from the ring. */
  nearCenter?: { stage: 'ask' | 'ring'; ring: string[] };
                                // whether to widen — agreement releases the lock
  name?: string;
  phone?: string;
  /** The cheaper-lane two-way choice (the [14:46] rule): nothing cheaper with
   *  the SAME characteristics exists in the chosen naselba, so Lina asked —
   *  smaller+cheaper HERE, or same characteristics in NEIGHBOURING naselbi?
   *  Set only while that question is the client's open context; the answer
   *  message routes on it. */
  cheaperChoicePending?: boolean;
  /** The [20:33] two-way choice: the criteria-fitting pool is exhausted and
   *  Lina asked whether the client wants something MORE EXPENSIVE in the same
   *  area or the SAME price in other neighborhoods — set while that question
   *  is the client's open context; the answer message routes on it. */
  moreChoicePending?: boolean;
  /** The property the cheaper search anchors on — what he CHOSE. Filled from
   *  the focused EB when the two-way choice is asked; the "elsewhere" answer
   *  re-uses these characteristics verbatim in the other naselbi. */
  cheaperAnchor?: { bedrooms?: number; sqm?: number; house?: boolean; business?: boolean; price?: number };
  viewingFeeAgreed?: boolean;
  // v2 — visit sub-funnel
  visitTime?: string;           // client's proposed time (free text)
  ownerTime?: string;           // owner's counter-proposal (from OwnerAgent)
  /** The canonical term LAST sent to the owner. A later, different client
   *  proposal is a SECOND owner turn — it relays "the client can't do X,
   *  here is Y" instead of repeating the first-time availability intro. */
  ownerAskTime?: string;
  /** The open WHOLE-DAY counter the owner just gave («ke mora vo ponedelnik,
   *  bilo koe vreme» — seeded into visitTime so the client's exact-clock answer
   *  completes the owner's own day). While it is set, the client's completed
   *  term is an ACCEPTANCE of the owner's counter, never a refusal — the owner
   *  follow-up must read acceptance («го прифати Вашиот предлог»), because a
   *  «не е во можност» ping for a term the owner himself proposed erased the
   *  coordination (the [01:07] capture: the client agreed to 17:00 and the
   *  owner was asked about «не е во можност… 05:00»). Cleared on any owner
   *  verdict (fixed counter / ok / goneclose the whole-day offer). */
  ownerCounterWholeDay?: string;
  feeRejections?: number;       // VISIT-FEE ladder: 1..3; 3 = graceful close + customer queued
  /** RENT-COMMISSION ladder (the second money topic, see provisionLadder): its
   *  own counter so resisting the commission never burns a visit-fee rung and
   *  vice versa. 1..3; 3 = graceful close + customer queued. Only the rent
   *  script uses it — a buyer pays 0% commission, so a "refusal" there is a
   *  misunderstanding answered with the 0%-clarification (no rung burned). */
  provisionRejections?: number;
  negotiationCount?: number;    // owner counter-proposals so far (cap)
  // Question-prefix counters ("once per funnel"): discoveryAsks counts criteria
  // questions actually asked, contactAsks counts contact asks sent. The first of
  // each carries its prefix (FIRST_QUESTIONS_PREFIX / LAST_INFO_PREFIX); retries
  // and later questions stay plain so the flourishes are never repeated.
  discoveryAsks?: number;
  contactAsks?: number;
  agentName?: string;           // assigned by AgentDispatcher (code, never LLM)
  agentPhone?: string;
  soldEb?: number;              // property known to be gone — excluded from alternatives
  /** EB the client was just told is GONE, together with the offer "shall I
   *  show you something else with similar characteristics?". The next inbound
   *  consumes it: an agreement serves the next matching pair (rooms, area,
   *  price band around the gone property), anything else clears it. */
  goneAlternativesEb?: number;
  queueAfterContact?: boolean;  // exhausted-options flow: collect contact, then queue
  ownerContactPending?: boolean; // availability ack sent — waiting for client to confirm they WANT owner contact (fee comes AFTER this)
  pendingVisitConfirm?: boolean; // a re-confirm ("Дали сè уште сте заинтересирани за посета?") is open — a bare "да" now OPENS the fee protocol (the [13:28] multi-question capture), never a card re-serve
  byeServed?: boolean;           // a farewell was already sent this session — a SECOND goodbye gets the short bye.again parting, not a repeated thank-you
  exitCheckServed?: boolean;      // the exit final-check („дали некоја понудена опција има шанса?“) was already asked this session — an exit-shaped repeat goes straight to the farewell lanes
  bothServices?: boolean;        // client wants BOTH buy and rent — ask property type first, then service
  nearbyLandmarks?: string[];     // top-3 nearby landmark names for rotation ("каде?" → first, "каде поточно?" → second, …)
  nearbyLandmarkCoords?: Array<{ lat: number; lon: number }>; // parallel coords for Google Maps links
  nearbyLandmarkPlaceIds?: Array<string | null>; // parallel Google place_ids → ?cid= place-card links
  nearbyLandmarkEb?: number;      // WHICH property the slots were resolved for — a served slot must never outlive its property (21:51: EB 57 got EB 56's Завод landmarks 3.2 km away)
  poiAnchor?: string;             // client's POI wish from the SEARCH phrase ("okolu Kapitol Biser") — presentation must find candidates NEAR this point, not just in the neighborhood
  poiAnchorTooFar?: boolean;      // the resolved anchor has NO in-pool property within the honest 1.5 km walk radius — the intro must say so
  /** The AREA the landmark anchor gave the locate funnel (Broz Cafe → Центар).
   *  While slots.location still equals it, later details ("околу 200.000 беше")
   *  keep ranking from that landmark; a NEW neighborhood in the message means
   *  a different search and the landmark stops steering it. */
  poiArea?: string;
  /** The [17:14] size-intent flag: "POMALO NESTO / нешто помало" means
   *  SMALLER-than-what-was-shown — could be a garsonjera OR a small 1-bedroom
   *  flat. The bedrooms slot alone must not decide the answer, so the pomalo
   *  ask fires and this flag stays set until the client names the size:
   *  "garsonjera" → slots.garsonjera (≤35 м² pool, 1-bedroom fallback),
   *  "edna spalna" → bedrooms 1; "2 spalni" → clears the flag (2+ is not
   *  "small" — the normal lane serves it). */
  pomaloSize?: boolean;
  landmarkIndex?: number;         // how many landmarks have been revealed so far
  /** The landmark NAME last served from the rotation. A client who answers
   *  "kade ima reptil tamu?" / "ne znam toa" is saying that anchor means
   *  nothing to them — the ladder serves the NEXT one instead of re-explaining
   *  the same name (or, worse, pivoting to the fee pitch). */
  lastLandmark?: string;
  addressProtocolIndex?: number;  // rotation index for address-privacy protocol variants
  addressProtocolEb?: number;     // WHICH property (Евидентен број) the protocol round count belongs to — the counter is PER PROPERTY: round 2 of EB 50 must never serve for EB 76
  lastPrice?: string;            // last price answered to the client (for "та цена" resolution)
  /** Generated (LLM) answers served in THIS session — the budget that stops a
   *  chatty client buying one Gemini call per message. Cleared with the rest of
   *  the slots on resetToIdle, so every new funnel gets a fresh allowance. */
  generatedAnswers?: number;
}

export type HistoryMsg = { role: 'user' | 'assistant'; text: string };

export interface ChatSession {
  chatId: string;
  channel: string;
  state: State;
  slots: SlotData;
  strikes: number;
  lastInboundAt: number;
  lastOutboundAt: number;
  outboundCount: number; // consecutive outbound since last inbound (Viber 100/hr rule)
  history: HistoryMsg[];
  returnState?: State;
  createdAt: number;
  terminatedAt?: number;
  resetGreeting?: boolean;
  /** Set when the reset came from strike-3 termination expiry — the next
   *  inbound ALWAYS gets the greeting, even a business-shaped message (the
   *  [12:32] no-eat rule applies only to ordinary idle resets). */
  resetFromTerminated?: boolean;
}

export function freshSession(channel: string, chatId: string): ChatSession {
  return {
    chatId, channel,
    state: 'idle',
    slots: {},
    strikes: 0,
    lastInboundAt: Date.now(),
    lastOutboundAt: 0,
    outboundCount: 0,
    history: [],
    createdAt: Date.now(),
    resetGreeting: false,
  };
}

export function isExpired(s: ChatSession, ttlMinutes: number): boolean {
  return Date.now() - s.lastInboundAt > ttlMinutes * 60_000;
}

export function touchInbound(s: ChatSession): void {
  s.lastInboundAt = Date.now();
  s.outboundCount = 0; // user replied -> Viber resets the 100/hr budget
}

export function touchOutbound(s: ChatSession): void {
  s.lastOutboundAt = Date.now();
  s.outboundCount += 1;
}

export function canSend(s: ChatSession): boolean {
  return s.outboundCount < 100; // Viber hard limit without user reply
}

export function resetToIdle(s: ChatSession): void {
  const fromTerminated = s.terminatedAt !== undefined; // capture BEFORE the clear below
  s.state = 'idle';
  s.slots = {};
  s.strikes = 0;
  s.history = [];
  s.returnState = undefined;
  s.terminatedAt = undefined;
  s.resetGreeting = true; // next inbound gets a fresh greeting (prototype resetSession)
  s.resetFromTerminated = fromTerminated;
}

export function pushHistory(s: ChatSession, msg: HistoryMsg, max: number): void {
  s.history.push(msg);
  if (s.history.length > max) s.history = s.history.slice(s.history.length - max);
}

/** Assistant texts already sent in this session — the response bank uses these
 *  to avoid repeating a sentence that was just used. */
export function assistantTexts(s: ChatSession): string[] {
  return s.history.filter(m => m.role === 'assistant').map(m => m.text);
}

export function buildGreeting(s: ChatSession): string {
  return randomGreeting(assistantTexts(s));
}

export class SessionStore {
  constructor(private db: Db) {}

  get(chatId: string): ChatSession | null {
    const row = this.db.db.prepare('SELECT data FROM sessions WHERE chat_id = ?').get(chatId) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as ChatSession) : null;
  }

  set(s: ChatSession): void {
    this.db.db.prepare(
      `INSERT INTO sessions (chat_id, channel, data, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(chat_id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
    ).run(s.chatId, s.channel, JSON.stringify(s), Date.now());
  }

  delete(chatId: string): void {
    this.db.db.prepare('DELETE FROM sessions WHERE chat_id = ?').run(chatId);
  }
}
