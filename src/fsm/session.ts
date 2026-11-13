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
  /** EITHER RESIDENTIAL TYPE (the [23:49]/[23:50] capture): «за живеење» or
   *  «стан или куќа» — a flat OR a house will do. It answers the category
   *  question without pinning one, so the pool keeps both types and the copy
   *  never says «станот»; a later single type retires it. */
  residential?: boolean;
  budget?: string;
  /** THE PRICE FLOOR (the [01:50] field capture): «поскапи од 180.000» — the
   *  client names the money he wants to spend as a MINIMUM, so the search must
   *  start there. `budget` stays the ceiling; the pair is a WINDOW
   *  («поскапи од 180 000» then «до 200 000 може слободно»). Cleared when the
   *  client moves off it (a new cap below it, a new area, a fresh search). */
  priceMin?: string;
  /** THE €/m² CEILING (the [02:09] capture): «STANCE VO AERODROM PO 1500E ZA
   *  KVADRAT» caps the RATE. A money criterion of its own: the pool is filtered
   *  by price ÷ м² across EVERY type, and the copy speaks «до 1.500 евра за м²»
   *  — never a 1.500 € total the client never gave. */
  sqmRate?: number;
  /** ALTERNATIVE BUDGET (the [20:08] capture): «MOZE SO EDNA DO 80000 ILI DVE
   *  DO 140000» — ONE card up to `single`, OR TWO cards whose TOTAL stays
   *  inside `pair`. slots.budget carries `single` (the STRICTER figure every
   *  single-card lane already enforces), and the pair total is applied where a
   *  batch is carved (fitCountBudgetPair) so no lane can serve 55.000 + 133.000
   *  under a 140.000 "two" figure. */
  countBudget?: { single: string; pair: string };
  // DUAL-SERVICE MONEY (the [12:33] business capture): the client splits his
  // budget PER SERVICE in consecutive messages — «za kirija do 1000 evra»,
  // «za kupuvanje do 2000000». Each lands in its OWN slot; when both exist
  // the funnel is a dual-service search (rent AND buy), slots.budget is
  // retired (a single budget would silently govern both services) and the
  // serve pairs the two segments one-rent-one-buy.
  rentBudget?: string;          // the client's cap for RENT money alone
  buyBudget?: string;           // the client's cap for BUY money alone
  dualService?: boolean;        // both budgets are on file — serve rent+buy pairs
  /** THE MARKET WAS PINNED FROM A BATCH, NOT DECLARED (the [10:16] capture):
   *  a browse serve takes the first row's service so the pool and the protocols
   *  stay coherent, but that is the FEED's word — the client never said it. The
   *  funnel still owes the market question (buildDiscoveryAsk) and the
   *  classifier must not read «заинтересиран» as interest in that row. Cleared
   *  by the client's own declaration (applySlots). */
  serviceInferred?: boolean;
  /** PER-CATEGORY MONEY (the [19:14] capture): «DVOSOBEN MOZE DO 90000 I
   *  TROSOBEN DO 150000» — TWO room categories, each with ITS OWN cap, in one
   *  search near one place. Room count → cap (strings, like slots.budget).
   *  While it is armed (≥2 entries) the presentation serves PAIRS — one card
   *  per category, nearest to the named place first — and a drained category
   *  is NAMED instead of being silently swapped for the other one.
   *  bedroomsMin/Max (+bedroomsAlt) carry the categories themselves, and
   *  slots.budget carries the HIGHEST cap so every other lane still has one
   *  honest money figure. */
  categoryBudgets?: Record<string, string>;
  /** The room categories the CURRENT search has drained (nothing left in this
   *  area under that category's own cap) — presentation state, not discovery. */
  categoryDrained?: number[];
  /** Which drained announcement was already spoken (the once-per-fact key, the
   *  same discipline as dualEmptyTold): categories + area + the caps. */
  categoryDrainedTold?: string;
  /** The drained sentence DUE for the batch just carved (decided in loadProps,
   *  applied at the send choke): a batch holding one category of the pair means
   *  the other has nothing left here under its own cap. */
  categoryDrainNote?: string;
  /** The room categories this chat has actually SERVED a card of (the [03:45]
   *  contract): the difference between «Тоа е сè што имав» (he saw it and it ran
   *  out) and «Моментално во системот нема» (the category was never on the
   *  table at all). */
  categoriesServed?: number[];
  /** THE TYPES this chat has SERVED a card of in this geography — the same
   *  notebook for the categories that carry no room count (куќа/плац/деловен
   *  простор/гарсоњера). Without it a house search could never be «drained»:
   *  `rooms === undefined` meant «never served here», so a repeat search told
   *  the client «Моментално во системот нема куќи до 250 евра во Центар» about
   *  the house card still on his screen (the [05:13] capture). */
  categoriesServedKinds?: string[];
  /** THE SAME NOTE WITHOUT THE GEOGRAPHY LIMIT — «has this chat ever seen a card
   *  of this room tier / this type AT ALL?». «Моментално во системот нема …» is
   *  a claim about the WHOLE system, so any card ever served in this chat
   *  refutes it, however the area moved since (a widen clears `location`, which
   *  retires the geography-scoped notebook and used to reopen the system
   *  claim). «Тоа е сè што имав» needs the scoped note; this one guards the
   *  stronger sentence. */
  categoriesEver?: number[];
  categoriesEverKinds?: string[];
  /** The GEOGRAPHY `categoriesServed` belongs to (location + place anchor).
   *  «Was this category ever on the table?» is a question about THIS search: a
   *  pair served in Центар says nothing about the stock around a landmark the
   *  client names next. Without this key the [03:45] wording lied in both
   *  directions — a category never served near the new place was announced as
   *  «Тоа е сè што имав» (it was served, but somewhere else). */
  categoriesServedGeo?: string;
  /** EMPTY-LEG HONESTY (the [23:10] dual capture): the segment of a dual
   *  search that has NO stock at all. The turn serves the other leg and says
   *  so in one sentence — silence would claim a comparison that never
   *  happened. `dualEmptyKey` identifies that fact (leg + money + size) and
   *  `dualEmptyTold` remembers it, so the honesty line is spoken once per
   *  search instead of on every batch. */
  dualEmptyLeg?: 'rent' | 'buy' | 'both';
  /** A dual search whose stock is FULLY drained (every row of both legs was
   *  already served). The turn says «ги покажав сите» and offers the pivots
   *  instead of recycling cards the client has seen. */
  dualDrained?: boolean;
  dualEmptyKey?: string;
  dualEmptyTold?: string;
  /** The empty leg is empty of UNSHOWN rows only — its stock EXISTS and was
   *  already served (the [19:20] capture: the buy pair went out first, then
   *  the paired serve called the segment «немам»). Decides «сè што имав» vs
   *  «немам» in the dual opener. */
  dualEmptyShown?: boolean;
  anywhere?: boolean;           // "било каде" — no location preference (satisfies location)
  sizeWaived?: boolean;        // "големината не ми е битна" — skip bedrooms question
  waiverAcked?: boolean;       // the banked discovery.waiver.ack intro was served for THIS waiver
  exactLocationTurns?: number; // consecutive EXACT-address demands (turn 2 = agency protocol)
  pricePriority?: boolean;     // "што поевтино" — sort by price, skip budget question
  /** «BILO KOLKU» / «било која цена» — the client RELEASED the price. A released
   *  criterion is an ANSWER (the discovery contract), so the money question is
   *  never asked again and the search runs uncapped. Distinct from
   *  pricePriority (cheapest first): a waived price has no order at all. */
  budgetWaived?: boolean;
  garsonjera?: boolean;        // "гарсоњера mi treba" — explicit studio category (NOT "1 спална")
  /** The client NAMED a flat (стан/апартман/гарсоњера). Flats are the one
   *  category with no flag of their own, so without this slot the discovery ask
   *  could not tell «MI TREBA STAN» from a message that named no type at all —
   *  and guessed the flat for both (the [04:17] capture). Cleared when another
   *  category (куќа/деловен простор/плац) takes the search over. */
  flat?: boolean;
  plac?: boolean;              // "плац за градење" — land plot category
  yard?: boolean;              // "со двор/дворче/градина" — needs outdoor space (implies house)
  propertyId?: number;          // EB of the property currently discussed
  /** THE FLAT THE CLIENT NAMED (the [19:27] capture): an EB, a price, a type
   *  noun or a landmark mention — the mention binder writes it whenever it
   *  binds ONE property. It outranks `presentedIds[last]` in the location
   *  lanes (the batch tail answered «na koja adresa e?» about the OTHER card
   *  after the client had already chosen one), while every un-named ask keeps
   *  the established last-presented rule. */
  askedEb?: number;
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
  /** THE INVENTORY ASK WAITING FOR ITS TYPE (the [02:15] capture):
   *  «STO IMATE VO BUNJAKOVEC?» names a place and asks for stock, but neither a
   *  service nor a property type is on file — a pair of flats for a client who
   *  may want a shop is a guess. Lina asks the TYPE (стан/куќа/деловен
   *  простор/плац) and this flag makes the ANSWER a serve turn: the type + the
   *  place are enough to present a pair and ask that type's characteristics.
   *  Cleared the moment the client answers. */
  inventoryPending?: boolean;
  /** A BLANK OPTIONS SERVE WAS SHOWN (the [01:45] capture): «што имате
   *  интересно кај X» is answered with the rows near the place, while the TYPE
   *  is still unknown — so the batch on the table is NOT the type's pair. The
   *  next message that names BOTH the market and the type must serve that
   *  type's pair (never re-serve the blank batch, never re-ask the place); this
   *  flag is what lets the typed-answer lane fire after a batch was shown, and
   *  it clears the moment the typed serve happens. */
  inventoryOptionsServed?: boolean;
  /** The property the cheaper search anchors on — what he CHOSE. Filled from
   *  the focused EB when the two-way choice is asked; the "elsewhere" answer
   *  re-uses these characteristics verbatim in the other naselbi. */
  cheaperAnchor?: { bedrooms?: number; sqm?: number; house?: boolean; business?: boolean; price?: number };
  viewingFeeAgreed?: boolean;
  /** THE FEE HAS BEEN TOLD ONCE (the [20:40] capture): the visit-fee figure
   *  (300/500 денари) was disclosed and the client has not answered yet. This
   *  is what makes the NEXT «да» the agreement — without it the funnel
   *  re-disclosed the fee on the first «да» and only collected the contact on
   *  the second one. Cleared once the agreement is taken. */
  feeDisclosed?: boolean;
  // v2 — visit sub-funnel
  visitTime?: string;           // client's proposed time (free text)
  ownerTime?: string;           // owner's counter-proposal (from OwnerAgent)
  /** The canonical term LAST sent to the owner. A later, different client
   *  proposal is a SECOND owner turn — it relays "the client can't do X,
   *  here is Y" instead of repeating the first-time availability intro. */
  ownerAskTime?: string;
  /** THE CLEAN PRICE THE OWNER WAS ASKED TO CONFIRM (the owner's 2026-11-11
   *  brief). Set when the first availability ask carried the price question;
   *  the verdict seam then reads any figure in the owner's answer as a CLEAN
   *  price (recomputed into the final price through Ana's formula) instead of
   *  a final price dictated over the phone. Cleared with the check. */
  ownerAskCleanPrice?: number;
  /** A clean-price correction was relayed to the client in this exchange — a
   *  later complaint about the price gets the owners-may-reprice disclaimer. */
  priceChangePending?: boolean;
  /** THE DAY'S VISIT CHAIN (the owner's 2026-11-11 brief): several flats asked
   *  for a visit on one day are arranged as one non-stop, hour-by-hour route.
   *  Each stop carries the owner's answer; when every owner has answered, the
   *  solver lays the chain out and the client confirms it in one yes. */
  visitPlan?: import('../visits/chain').VisitPlanState;
  /** The client asked to see SEVERAL flats in one day (his own plural wording).
   *  It outlives one plan: after a route is abandoned (no owner could link the
   *  hours, or the client moved the day) his next term is the SAME route, not
   *  a sudden single visit — the brief's «several stays several». Cleared when
   *  the route is booked. */
  visitWanted?: boolean;
  /** How many stops the confirmed route has (>= 2 marks a chain for the visit
   *  protocol's plan line). Set when the route is booked. */
  chainSize?: number;
  /** THE DAY THE OWNER HIMSELF NAMED (the [10:24] capture). An owner answers a
   *  clock re-ask in TWO messages: «PETOK» and then «OKOLU 5 MOZAM». The clock
   *  arrives day-less, was dated to TODAY by the display normalizer, and reached
   *  the client as «Вторник, 03.11.2026 во 17:00» — a weekday and a date the
   *  owner never said — while the raw «Околу 5» was stored as ownerTime /
   *  ownerCounterTime (the term the client accepts, and the term the next owner
   *  ping calls "refused"). This seed donates HIS day to his own clock.
   *  Replaced by each clockless counter, consumed by the fixed counter/ok/gone. */
  ownerClockDay?: string;
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
  /** The FIXED term the owner last countered with (a time he proposed, not the
   *  client's). The next client proposal refuses THAT term, so the owner ping
   *  must name it — the [17:45] capture asked the owner about «18:30» after the
   *  owner himself had offered 16:00, so the follow-up accused the client of a
   *  refusal he never made. Consumed by the next owner ask. */
  ownerCounterTime?: string;
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
  poiAnchorTooFar?: boolean;      // the resolved anchor has NO in-pool property within the honest 1 km walk radius — the intro must say so
  /** THE ONE-KILOMETRE RING ASKS, IT DOES NOT DECIDE (the owner's [23:29]
   *  rule): nothing in the criteria sits within 1 km of the place the client
   *  named, so the turn asked «подалеку во истата населба, или друга
   *  населба?» and serves nothing until the client picks. */
  poiTooFarAsk?: boolean;
  /** WHICH place the ring ask was about. The ask is only answerable while the
   *  anchor is still that place — a place named in the meantime (or a pivot
   *  confirm) makes the pending ask about a geography the client has left. */
  poiTooFarAnchor?: string;
  /** The widen the client PICKED for the anchor: 'area' = farther inside the
   *  anchor's own naselba, 'city' = another naselba. While set, the ring no
   *  longer blocks the serve (the client released it). Cleared when a NEW
   *  place becomes the anchor. */
  poiWidenScope?: 'area' | 'city';
  /** The measured distance to the nearest in-criteria row on the last anchored
   *  load — the ask states it instead of saying «далеку». */
  poiNearestM?: number;
  /** WHICH row that distance belongs to (the [04:05] capture): the ring line
   *  says «најблиску што имам е на 1,4 km», and the client's next question is
   *  «кој е тој стан?». Without the row id the only answer was the same
   *  paragraph again. */
  poiNearestId?: number;
  /** The flat whose distance was LAST measured for a named place (the [04:46]
   *  capture). «48 NA KOLKU METRA E DO SITI MOL?» measures EB 48; the next
   *  sentence is only the destination («A DO LEPTOKARIJA?»), so the measurement
   *  lane needs to know which flat to measure from — otherwise the follow-up is
   *  answered with the card again. */
  lastDistanceEb?: number;
  /** The AREA the landmark anchor gave the locate funnel (Broz Cafe → Центар).
   *  While slots.location still equals it, later details ("околу 200.000 беше")
   *  keep ranking from that landmark; a NEW neighborhood in the message means
   *  a different search and the landmark stops steering it. */
  poiArea?: string;
  /** EVERY place the client named in ONE message, in the order he said them
   *  («SAKAM STANCE OKOLU UNIVERZALNA , BUNJAKOVEC» — the [18:48] capture). The
   *  pair then SPANS the places: one card near each, cycling two at a time
   *  (1/2, 3/1, 2/3 for three places). Absent or a single entry keeps the
   *  single-anchor serve (the two nearest to that place). */
  poiPlaces?: Array<{ name: string; lat: number; lon: number }>;
  /** id → the place THIS card was drawn for, so each card of a cross-place
   *  pair states its own distance ("на 220 m од Универзална Сала"). */
  pairAnchorOf?: Record<string, { name: string; lat: number; lon: number }>;
  /** id → the OTHER named places the SAME card stands within the honest radius
   *  of. Two places 1 km apart routinely share one flat (the only 2-room under
   *  budget near both) — that card answers for BOTH, and it says so ("на 240 m
   *  од Болница 8-ми Септември и на 720 m од Сити Мол") instead of the pair
   *  pretending one of the places has nothing. */
  pairAlsoNearOf?: Record<string, Array<{ name: string; lat: number; lon: number }>>;
  /** Places in the current search with NOTHING that matches the criteria —
   *  said plainly once each instead of silently dropping them from the pair. */
  pairEmpty?: string[];
  pairEmptySaid?: string[];
  /** A place the client named as a DIFFERENT search location («a neshto kaj
   *  X?»): the criteria were confirmed, the next agreement applies this place. */
  pendingPivot?: { name: string; lat: number; lon: number };
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
  /** The OWNER's own strike counter — the same 3-strike insult protocol the
   *  client runs, kept SEPARATE: a rude owner must never ban the client's
   *  chat, and the client's strikes must never silence the owner. */
  ownerStrikes?: number;
  /** Strike 3 on the owner side: his pane stops getting answers (the operator
   *  is alerted and takes over). Cleared with the rest of the slots. */
  ownerMuted?: boolean;
  /** THE OWNER ASKED WHO WILL RENT IT (the #4 field request, 2026-11-12):
   *  «КОЈ САКА ДА ЈА ИЗНАЈМИ?» is relayed to the client as «За кого би била
   *  изнајмена недвижноста?», and THIS flag marks the chat as waiting on that
   *  answer — the client's reply is forwarded to the owner and the turn ends.
   *  Cleared when the answer is relayed (or when it is not an answer at all). */
  ownerTenantAsk?: boolean;
  /** THE OWNER'S EXTRA CONDITIONS AS THEY REACHED THE CLIENT (the operator's
   *  2026-11-12 request): his own words about a deposit / first rent / advance.
   *  Kept for the confirmation copy and the record. */
  ownerConditions?: string;
  /** The conditions have been relayed and the client has NOT yet answered —
   *  the visit stays HIS decision (the same gate a moved price uses). Cleared
   *  when the visit is booked (or the chat moves off that term). */
  ownerConditionsPending?: boolean;
  /** THE PUBLISHED PRICE ASKED OF THE OWNER (the [02:03] field capture): rows
   *  without a clean price get the CONFIRM-the-ad-figure half instead of no
   *  price question at all — so a figure in his answer means "the ad is wrong"
   *  unless it equals this one (then it is a confirmation, not a change). */
  ownerAskPublishedPrice?: number;
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
