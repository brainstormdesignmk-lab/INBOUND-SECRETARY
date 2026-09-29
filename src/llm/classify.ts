import { LlmClient } from './types';
import { ChatSession } from '../fsm/session';
import { AppConfig } from '../config';
import { Event, EventType, isValidEvent } from '../fsm/machine';
import { PropertyService } from '../data/properties';
import { extractSlots, detectLocation, buildEvent, detectContact, detectVisitInterest, detectPropertyInterest, detectAgreement, detectVisitTime, detectTimeRejection, detectRejection, detectSeenProperty, detectLocatePick, detectSeeOffers, detectSuggestAlternatives, detectDrugAlternative, mentionsMore, detectAvailabilityAsk, detectFeeWhy, detectInvestmentOpinion, isPlausibleName, isValidPhone, isValidVisitTime, detectEyeCatch, detectWidenIntent, detectBedrooms, detectBedroomsRange, detectBudget, detectBusiness, detectHouse, detectGarsonjera, detectPlac, detectYardNeed, detectPriceAsk, detectService,  detectProvisionAsk, detectProvisionWho, hasDayWord, isWhereLandmarkQuestion, extractPoiWish, detectFeePaymentAgreement, detectConditionalFeeAccept, detectMetaClarify, detectMoreOptions, detectFeeComplaint, detectFeeSurprise, extractRentMath, detectTotalCostAsk, detectNegatedAgreement, GREETING_ONLY_RE } from './deterministic';
import { hasClockHint } from '../visits/time';

export interface Classified {
  event: Event;
  offensive: boolean;
  offenseLevel: number;
}

// Cold brain: pure intent extraction, never persona prose.
// v2: fee-refusal + visit-time negotiation events.
const CLASSIFY_SYSTEM = `You are the intent classifier for "Lina", a Macedonian real-estate sales assistant.
Classify the user's LATEST message based on the conversation history and the CURRENT STATE hint.
Output ONLY valid JSON (no markdown, no commentary), exactly matching this schema:
{
  "event": "INTENT_DECLARED" | "PROPERTY_ID_REQUESTED" | "SEEN_PROPERTY" | "DETAILS_PROVIDED" | "SEARCH_REQUESTED" | "INTERESTED" | "REJECTED" | "FEE_AGREED" | "FEE_REFUSED" | "VISIT_TIME_PROVIDED" | "TIME_ACCEPTED" | "TIME_REJECTED" | "CONTACT_PROVIDED" | "CONTACT_INCOMPLETE" | "ESCALATE" | "STAY",
  "service": "buy" | "rent" | null,
  "location": string | null,
  "bedrooms": integer | null,
  "sqm": integer | null,
  "business": boolean | null,
  "house": boolean | null,
  "budget": string | null,
  "propertyId": integer | null,
  "visitTime": string | null,
  "name": string | null,
  "phone": string | null,
  "reason": string | null,
  "offensive": false,
  "offenseLevel": 0
}
Rules:
- INTENT_DECLARED: user states they want to buy (купување) or rent (изнајмување/кирија). Set "service" accordingly.
- PROPERTY_ID_REQUESTED: user references an "евидентен број" / "evidenten broj" / "sifra" / "шифра" / "#N" / "број N" OR a bare number that clearly means a specific property (e.g. "заинтересирана сум за 78", "што е со 95?", "сакам да ја видам 74", "дали е достапен 82?"). Put the number in "propertyId".
- SEEN_PROPERTY: user saw a SPECIFIC property (an ad on the internet, "го гледав огласот за стан во Карпош", "тој конкретен стан", "кој стан беше?") but gives NO number — they don't know the Евидентен број. The system asks for the number first, then helps find the property from the DB by details (населба, цена, квадрати). Put any remembered details (location, budget, sqm) in the fields.
- DETAILS_PROVIDED: user gives location (which part of the city), bedrooms (спални соби), or budget. Extract into the fields; fill only what is present.
- business: true when the user wants COMMERCIAL space (деловен простор, канцеларија, локал, магацин, хала). For business requests, "sqm" (square meters) matters and bedrooms do NOT.
- house: true when the user wants a HOUSE (куќа, кука, house, kukja) and false when they explicitly say стан/apartment. Leave null when the property type is not mentioned.
- SEARCH_REQUESTED: user asks to see offers now, with enough details already given.
- INTERESTED: user wants to visit / schedule / see a specific property ("сакам да ја видам", "договори посета", "кога може да се погледне", "дали е достапен?" after a property was shown, "да" after a presentation).
- REJECTED: user declines offers, dislikes options, or disagrees with terms.
- REJECTED also when the user denies the current direction in idle/intent/discovery ("не барам стан", "не ми треба стан", "нешто друго") — the system pivots to ask what they DO want.
- FEE_AGREED: user EXPLICITLY agrees to pay the viewing fee ("се согласувам", "во ред", "да" in response to the fee question).
- FEE_REFUSED: user REFUSES the viewing fee ("не сакам да платам", "зошто надомест", "без надомест"). Only in response to the fee question.
- VISIT_TIME_PROVIDED: user proposes a time/date for the visit ("петок 11.06 во 17:30", "утре на пладне", "сабота попладне"). Put the free text in "visitTime".
- TIME_ACCEPTED: user ACCEPTS a time proposed by the assistant/owner ("во ред, тоа време е добро", "може, се согласувам").
- TIME_REJECTED: user REJECTS a time proposed by the assistant/owner ("не ми одговара", "имам друг термин").
- CONTACT_PROVIDED: user gives BOTH a full name and a phone number. Extract both.
- CONTACT_INCOMPLETE: user gives only a name OR only a phone.
- ESCALATE: user asks about legal, financial, contractual or other complex matters the assistant cannot answer, OR explicitly asks to speak with a manager/supervisor ("сакам да зборувам со менаџер", "повикајте претпоставен", "дајте ми некој надлежен").
- STAY: anything else (greetings, small talk, unclear messages, or messages that continue an existing flow without new information).
- The CURRENT STATE hint disambiguates: in state "closing", "да"/"во ред" means FEE_AGREED; in state "time_confirm", "да"/"во ред" means TIME_ACCEPTED.
- An availability question ("дали е достапен?") or a "when can I view it" ("кога може да се погледне?") in property_query/presentation is INTERESTED — never PROPERTY_ID_REQUESTED or STAY. The fee is disclosed first; the owner is contacted only after the client agrees.
- "offensive": true only for vulgar, sexual, harassing or insulting language. "offenseLevel": 1 for first offense, 2 if it repeats, 3 for severe abuse or threats.
- "reason": short Macedonian phrase summarizing why this event was chosen (max 15 words).
- The conversation is in Macedonian; keep extracted values in their original language.
- IMPORTANT: write "location" in standard Macedonian Cyrillic (e.g. "Центар", "Кисела Вода", "Капиштец", "Аеродром") even if the user typed Latin letters ("centar", "kisela voda", "kapistec"). Extract only the neighborhood name, not a full sentence.`;

function cleanJson(raw: string): string {
  const s = raw.trim();
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start !== -1 && end > start) return s.slice(start, end + 1);
  return s;
}

export function parseClassified(raw: string): Classified {
  let obj: Record<string, unknown> = {};
  try {
    obj = JSON.parse(cleanJson(raw)) as Record<string, unknown>;
  } catch {
    obj = {};
  }
  const rawEvent = String(obj.event ?? 'STAY').toUpperCase();
  const type: EventType = isValidEvent(rawEvent) ? rawEvent : 'STAY';
  const event: Event = { type };
  if (obj.service === 'buy' || obj.service === 'rent') event.service = obj.service;
  if (typeof obj.location === 'string' && obj.location.trim()) event.location = obj.location.trim();
  // bedrooms/sqm are numeric-only (Number() already drops phrases like
  // "кукја пофтина") — the bounds keep absurd LLM values (99 спални,
  // 99999 м²) from derailing the search into a nonsense no-match.
  const beds = Number(obj.bedrooms);
  if (Number.isFinite(beds) && beds >= 1 && beds <= 10) event.bedrooms = Math.floor(beds);
  const sqm = Number(obj.sqm);
  if (Number.isFinite(sqm) && sqm >= 10 && sqm <= 5000) event.sqm = Math.floor(sqm);
  if (obj.business === true) event.business = true;
  if (obj.house === true) event.house = true;
  // Budget must carry a REAL number — the LLM sometimes fills the field with
  // garbage ("кукја пофтина евра") when the message had no price; a digit-less
  // value is dropped so the deterministic detector fills the real budget and a
  // nonsense phrase is never echoed ("до кукја пофтина евра"). Worded amounts
  // are canonicalized like detectBudget: "80 илјади" -> "80000", "до 80.000"
  // -> "80000".
  const budget = String(obj.budget ?? '').trim();
  const budgetDigits = budget.replace(/[^\d]/g, '');
  if (budgetDigits) {
    let b = parseInt(budgetDigits, 10);
    if (/(илјади|хилјади)/i.test(budget)) b *= 1000;
    if (Number.isFinite(b) && b > 0) event.budget = String(b);
  }
  const pid = Number(obj.propertyId);
  if (Number.isFinite(pid) && pid > 0) event.propertyId = Math.floor(pid);
  // visitTime must carry a REAL time reference — the LLM sometimes fills it
  // with a sentence or garbage ("кукја пофтина"). isValidVisitTime accepts
  // only strings with an actual time/date token (including a bare "19:00");
  // anything else is dropped so the deterministic override fills the real time.
  if (typeof obj.visitTime === 'string' && obj.visitTime.trim()) {
    const t = obj.visitTime.trim();
    if (isValidVisitTime(t)) event.visitTime = t.slice(0, 80);
  }
  // name must look like a real name — "кукја пофтина" as a name must never
  // reach the appointment record (isPlausibleName rejects it: no capital,
  // stopword-heavy, sentence-length). Dropped -> deterministic detectContact
  // fills the clean capitalized name from the message.
  if (typeof obj.name === 'string' && isPlausibleName(obj.name)) event.name = obj.name.trim();
  // Phone normalized like detectContact (078/914 196 -> 078914196) AND
  // validated as digits — "кукја пофтина" (letters) is rejected outright.
  if (typeof obj.phone === 'string' && obj.phone.trim()) {
    const p = obj.phone.trim().replace(/[\s/.-]+/g, '');
    if (isValidPhone(p)) event.phone = p;
  }
  // An event whose REQUIRED payload failed validation is a hallucination:
  // CONTACT_PROVIDED must carry a real name AND phone, VISIT_TIME_PROVIDED a
  // real time. Downgrade to STAY so the deterministic intake paths
  // (detectContact / detectVisitTime overrides) re-extract the clean values
  // from the message — the funnel must never advance (or record) empty/garbage.
  if (type === 'CONTACT_PROVIDED' && (!event.name || !event.phone)) {
    event.type = 'STAY';
  } else if (type === 'VISIT_TIME_PROVIDED' && !event.visitTime) {
    event.type = 'STAY';
  }
  if (typeof obj.reason === 'string' && obj.reason.trim()) event.reason = obj.reason.trim();
  const level = Number(obj.offenseLevel);
  return {
    event,
    offensive: obj.offensive === true,
    offenseLevel: Number.isFinite(level) && level > 0 ? Math.floor(level) : 0,
  };
}

/** States where a bare number can only mean an Евидентен број (property intake). */
const PROP_INTAKE_STATES = new Set(['idle', 'intent', 'discovery', 'property_locate', 'property_query', 'presentation']);

/**
 * True when a concrete property is on the table (presented batch, current
 * search batch, or a known/interested EB). Property interest ("mi e
 * interesna") only outranks the seen-property/search machinery when there
 * is something to be interested IN — a cold interest line must not invent
 * a binding. Also used by the handler's PROPERTY_DESCRIPTION interceptor.
 */
export function propertyOnTable(s: ChatSession): boolean {
  return (s.slots.presentedIds?.length ?? 0) > 0
    || (s.slots.currentBatch?.length ?? 0) > 0
    || s.slots.propertyId !== undefined
    || s.slots.interestedPropertyId !== undefined;
}

/**
 * Deterministic safety net: a bare 2-3 digit number in a property-intake state
 * is an Евидентен број even when the LLM doesn't say PROPERTY_ID_REQUESTED
 * ("заинтересирана сум за 78" — the user KNOWS what they want; Lina must not
 * ask buy/rent). Guarded against times (18:30), phones (078/…), bedroom counts,
 * prices (евра/денари) and sizes (м2).
 */
export function inferPropertyId(text: string): number | undefined {
  // WHERE-THE-LANDMARK-IS ("KADE TI E TOA 26 JULI TC ?"): the number is part
  // of a PLACE NAME Lina herself echoed ("1,3 километри од Kipper Market - ТЦ
  // 26 Јули") — a landmark question, never an Евидентен-број probe (the
  // [12:48] transcript: "не можам да го најдам 26 во нашата евиденција").
  if (isWhereLandmarkQuestion(text)) return undefined;
  if (/\b\d{1,2}[:.]\d{2}\b/.test(text)) return undefined;           // 18:30 / 18.30 — time
  if (/0\d{1,2}\s*[/.]\s*\d{2,}/.test(text)) return undefined;       // 078/914 196 — phone
  // A budget-cap word before the number ("до 250", "околу 250", "под 250")
  // means a PRICE, not an Евидентен број — "bilo kade do 250" is a rent
  // budget, and treating the 250 as an EB produced the bogus "не можам да го
  // најдам имотот со Евидентен број 250". "sifra 250" / "број 250" still
  // name an EB — the cap word is what disambiguates.
  // EXCEPTION: the eye-catch idiom ("mi fati oko 94") contains "око" as part
  // of "caught my EYE", not "approximately" — there the number IS the EB.
  if (!detectEyeCatch(text)
    && /(спални|соби|евра|евро|evra|evro|денари|ден\.|хилјади|\beur\b|\bmkd\b|м2|м²|m2|m²|кв\.?м|kvadrat|саат|часа|часот|spalna|spalni|(?:до|околу|под|do|okolu|oko|pod)\s*\d{2,3}\b)/i.test(text)) return undefined;
  const m = text.match(/\b(\d{2,3})\b(?!\s*[.,]\d)/);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return n >= 10 && n <= 999 ? n : undefined;
}

export class Classifier {
  constructor(
    private llm: LlmClient,
    private cfg: AppConfig,
    private properties?: PropertyService,
  ) {}

  /**
   * PRICE-ECHO RULE (the 21:16 bug): a bare number that ECHOES the property
   * on the table — its price, the last quoted price, or the standing budget —
   * is a BUDGET correction ("A ZA 250?" right after EB 41 @ 250 evra rent),
   * never an Евидентен број. A number that echoes nothing ("SUM ZA 78" cold)
   * stays an EB reference. Budget extraction keeps its own "za" cap-word so
   * the echoed number actually lands in slots.budget.
   */
  private async resolveBarePid(text: string, session: ChatSession): Promise<number | undefined> {
    const pid = inferPropertyId(text);
    if (pid === undefined) return undefined;
    if (String(pid) === session.slots.budget || String(pid) === session.slots.lastPrice) return undefined;
    const onTable = session.slots.propertyId ?? session.slots.interestedPropertyId
      ?? session.slots.currentBatch?.[session.slots.currentBatch.length - 1]
      ?? session.slots.presentedIds?.[session.slots.presentedIds.length - 1];
    if (onTable != null && this.properties) {
      const p = await this.properties.getById(onTable).catch(() => undefined);
      if (p?.price === pid) return undefined;
    }
    return pid;
  }

  /** Swap the brain at runtime (TUI chooser: gemini/groq/llm-free). */
  setLlm(llm: LlmClient): void {
    this.llm = llm;
  }

  /**
   * Pure deterministic classifier — no LLM call. Replicates the full
   * classify() logic (slot extraction, event type, funnel overrides) using
   * only regex detectors + buildEvent. Returns undefined when the message
   * is truly novel and needs the LLM (no detector fires).
   *
   * The caller uses this as the primary path. Groq only fires when this
   * returns undefined — the truly novel messages that no detector catches.
   */
  /** Rebuild a bare SEARCH_REQUESTED WITH the message's own criteria — the
   *  [17:14] fix. Funnel overrides (see-offers, suggest-alternatives,
   *  mentionsMore) previously rebuilt the event as { type: 'SEARCH_REQUESTED' },
   *  silently discarding the slots the ORIGINAL event carried: "POMALO NESTO
   *  DO 300EVRA" (see-offers phrase + budget) lost its budget, applySlots had
   *  nothing to store, and the presentation ran budget-less — a 380€ card
   *  served against an explicit ≤300 ask. Deterministic slots are the single
   *  source of truth: fill what the first pass did not already put on the event.
   *
   *  TWO modes (the 09:17 ladder regression taught the difference):
   *  - reExtract=true (SEE-OFFERS: "pomalo nesto do 300evra") — the message IS
   *    the criteria statement; re-extract everything from the text.
   *  - reExtract=false (suggest-alternatives / mentionsMore: "ushte edna",
   *    "nesto drugo?") — a MORE-ask. Never re-extract bedrooms/sqm/service:
   *    the number-word in "ushte EDNA" would read as an exact-category
   *    refinement and wrongly retire the client's range mid-ladder. Carry the
   *    event's own fields and re-read ONLY the budget (a number on a more-ask
   *    is a money correction, "A ZA 250?", never a category). */
  private async recomputeSearchEvent(
    ev: Classified['event'], text: string, session: ChatSession, reExtract: boolean,
  ): Promise<Classified['event']> {
    if (!reExtract) {
      // MORE-ASK ("ushte edna", "nesto drugo?", "predlozi mi"): strip the
      // criteria the base event may have misread from the message itself
      // ("edna" reads as an exact-category ask and would wrongly retire the
      // client's range mid-ladder). The stored session slots already carry
      // the client's criteria — the ladder rebuilds from those. Only the
      // event's own budget survives (a money correction rides anywhere).
      return {
        type: 'SEARCH_REQUESTED',
        propertyId: undefined,
        budget: ev.budget,
        location: ev.location,
      };
    }
    const slots = extractSlots(text);
    const merged = {
      ...ev,
      type: 'SEARCH_REQUESTED' as const,
      propertyId: undefined,
      budget: ev.budget ?? slots.budget,
      bedrooms: ev.bedrooms ?? slots.bedrooms,
      bedroomsMin: ev.bedroomsMin ?? slots.bedroomsMin,
      bedroomsMax: ev.bedroomsMax ?? slots.bedroomsMax,
      sqm: ev.sqm ?? slots.sqm,
      service: ev.service ?? slots.service,
      garsonjera: ev.garsonjera ?? (slots.garsonjera ? true : undefined),
      sizeWaived: ev.sizeWaived ?? (slots.sizeWaived ? true : undefined),
      plac: ev.plac ?? (slots.plac ? true : undefined),
      yard: ev.yard ?? (slots.yard ? true : undefined),
      business: ev.business ?? slots.business,
      house: ev.house ?? slots.house,
      anywhere: ev.anywhere ?? (slots.anywhere ? true : undefined),
    } as Classified['event'];
    // Location: the raw-script neighborhood token normalizes away inside
    // extractSlots on Latin input ("VO AERODROM") — resolve it the same way
    // the recompute block does, against the live feed's area list.
    if (merged.location === undefined) {
      try {
        const loc = detectLocation(text, this.properties ? await this.properties.locations() : []);
        if (loc) merged.location = loc;
      } catch { /* feed hiccup — location stays unset */ }
    }
    void session; // kept for call-site symmetry; policy lives in the slots
    return merged;
  }


  async deterministicClassify(session: ChatSession, text: string): Promise<Classified | undefined> {
    const t0 = Date.now();

    // --- Bare-number override ---
    // WHERE-THE-LANDMARK-IS guard: "KADE TI E TOA 26 JULI TC ?" carries a
    // number inside a PLACE NAME — never an Евидентен број (the [12:48]
    // transcript), so the bare-number path stands down entirely for these.
    let barePid: number | undefined;
    if (PROP_INTAKE_STATES.has(session.state) && !isWhereLandmarkQuestion(text)) {
      barePid = await this.resolveBarePid(text, session);
    }

    // --- Pure greeting ownership (idle/intent — the 15:12 TUI capture: "ZDRAVO") ---
    // The reply is deterministic either way (respond() serves greeting.open for
    // empty slots), so the pre-classify OWNS the turn: an LLM classify round
    // only adds latency and a SEEN_PROPERTY hallucination risk that GUARD 1b
    // then has to clean up. GREETING_ONLY_RE is the handler's reset-consumer
    // whitelist, now shared (deterministic.ts) so both layers agree on what a
    // "pure" hello is — no digits, no property vocabulary, no content questions.
    if (['idle', 'intent'].includes(session.state) && !barePid
      && GREETING_ONLY_RE.test(text.trim())) {
      console.log(`[timing] det-classify ${Date.now() - t0}ms → GREETING_STAY`);
      return { event: { type: 'STAY' }, offensive: false, offenseLevel: 0 };
    }

    // --- Seen-property override ---
    // Only in intake states, and only when no bare number was extracted
    // (a number means the client knows the EB — easy lookup path).
    // EXCEPTION: property interest with a property on the table is NOT a
    // seen-property probe — "GARSONJERAVA ... MI E INTERESNA" (00:09) must
    // reach the INTERESTED funnel override below, not property_locate.
    if (['idle', 'intent', 'discovery'].includes(session.state)
      && !barePid && detectSeenProperty(text)
      && !(detectPropertyInterest(text) && propertyOnTable(session))) {
      // GUARD: an availability ask is NEVER a seen-property probe, no matter
      // what the LLM said ("DALI SEUSTE E DOSTAPEN?" about the property the
      // client JUST named by EB — asking "do you know the EB?" back is the
      // [19:28] field bug). LLM verdicts never override detectors.
      if (detectAvailabilityAsk(text)) {
        console.log(`[timing] det-classify ${Date.now() - t0}ms → availability-guard STAY`);
        return undefined; // the LLM/classify() guards handle the routing
      }
      const slots = extractSlots(text);
      let location = slots.location;
      if (!location && this.properties) {
        try {
          const locs = await this.properties.locations();
          location = detectLocation(text, locs) ?? undefined;
        } catch { /* ignore */ }
      }
      console.log(`[timing] det-classify ${Date.now() - t0}ms → SEEN_PROPERTY`);
      return {
        event: {
          type: 'SEEN_PROPERTY', service: slots.service, location,
          bedrooms: slots.bedrooms, sqm: slots.sqm, business: slots.business,
          house: slots.house, budget: slots.budget, anywhere: slots.anywhere,
          garsonjera: slots.garsonjera,
        }, offensive: false, offenseLevel: 0,
      };
    }

    // --- Slot extraction + buildEvent (the deterministic core) ---
    const slots = extractSlots(text);
    let location = slots.location;
    if (!location && this.properties) {
      try {
        const locs = await this.properties.locations();
        const loc = detectLocation(text, locs);
        if (loc) location = loc;
      } catch { /* ignore */ }
    }
    let ev = buildEvent(session.state, {
      service: slots.service, location, bedrooms: slots.bedrooms,
      sqm: slots.sqm, business: slots.business, house: slots.house,
      budget: slots.budget, anywhere: slots.anywhere,
      need: slots.need, rejected: slots.rejected,
      // These three previously leaked only through the LLM-down recompute
      // path — the pure-deterministic path silently dropped them, so the
      // funnel re-asked bedrooms after "garsonjera mi treba" (19:34).
      sizeWaived: slots.sizeWaived, pricePriority: slots.pricePriority,
      garsonjera: slots.garsonjera,
      plac: slots.plac, yard: slots.yard,
    });

    // Bare-number: set propertyId on event BEFORE funnel overrides so
    // visit interest can read it ("ДОГОВОРИ MI ЗА ОВОЈ СО БРОЈ 89" →
    // INTERESTED with propertyId=89, not a bare INTERESTED).
    if (barePid && ev.type === 'STAY') {
      ev = { type: 'PROPERTY_ID_REQUESTED', propertyId: barePid };
    }

    // Session-merge completeness: buildEvent sees only THIS message's slots,
    // but the funnel accumulates criteria across messages (rent + Центар on
    // msg 1, "garsonjera mi treba do 250" on msg 2). When the MERGED criteria
    // are complete, the funnel must PRESENT — discovery with complete criteria
    // that only says "Во ред, ги забележав" dead-ends the client. The LLM used
    // to do this merge silently; the deterministic layer now owns it.
    if (session.state === 'discovery' && (ev.type === 'STAY' || ev.type === 'DETAILS_PROVIDED')) {
      const merged = buildEvent(session.state, {
        service: slots.service ?? session.slots.service,
        location: location ?? session.slots.location,
        bedrooms: slots.bedrooms ?? session.slots.bedrooms,
        bedroomsMin: slots.bedroomsMin ?? session.slots.bedroomsMin,
        bedroomsMax: slots.bedroomsMax ?? session.slots.bedroomsMax,
        sqm: slots.sqm ?? session.slots.sqm,
        business: slots.business ?? session.slots.business,
        house: slots.house ?? session.slots.house,
        budget: slots.budget ?? session.slots.budget,
        anywhere: slots.anywhere || session.slots.anywhere,
        sizeWaived: slots.sizeWaived || session.slots.sizeWaived,
        pricePriority: slots.pricePriority || session.slots.pricePriority,
        garsonjera: slots.garsonjera || session.slots.garsonjera,
        plac: slots.plac || session.slots.plac,
        yard: slots.yard || session.slots.yard,
        need: slots.need, rejected: slots.rejected,
      });
      if (merged.type === 'SEARCH_REQUESTED') ev = merged;
    }

    // --- Contact intake (contact_collection state) ---
    // Always fire in contact_collection — phone/name digits must not be
    // eaten as budget/bedrooms by extractSlots.
    if (session.state === 'contact_collection' && ev.type !== 'CONTACT_PROVIDED' && ev.type !== 'CONTACT_INCOMPLETE') {
      const c = detectContact(text);
      const phone = c.phone ?? session.slots.phone;
      if (phone || c.name) {
        ev = phone && c.name
          ? { type: 'CONTACT_PROVIDED', name: c.name, phone }
          : phone
            ? { type: 'CONTACT_INCOMPLETE', phone }
            : { type: 'CONTACT_INCOMPLETE', name: c.name };
      }
    }

    // --- Funnel overrides ---

    // Visit interest in property states → INTERESTED
    // In property_query/presentation any visit phrase fires; in the intake
    // states (idle/intent/discovery/property_locate) it must also NAME a
    // property (bare EB via inferPropertyId) — "organiziraj poseta za 69" on
    // a fresh session is a visit command for EB 69, never a card request.
    if (['property_query', 'presentation'].includes(session.state)
      && ev.type !== 'REJECTED' && ev.type !== 'ESCALATE'
      && detectVisitInterest(text)) {
      const pid = ev.propertyId ?? session.slots.propertyId;
      ev = pid ? { type: 'INTERESTED', propertyId: pid } : { type: 'INTERESTED' };
    }
    if (['idle', 'intent', 'discovery', 'property_locate'].includes(session.state)
      && ev.type !== 'REJECTED' && ev.type !== 'ESCALATE'
      && detectVisitInterest(text)
      && inferPropertyId(text) !== undefined) {
      ev = { type: 'INTERESTED', propertyId: inferPropertyId(text) };
    }
    // Property interest in a property context ("mi se svigja", "mi e
    // interesna") — the client LIKES a property already on the table, they
    // are not searching again. Without this, an LLM-down interest line that
    // also carries a type word ("GARSONJERAVA ... MI E INTERESNA", 00:09)
    // extracts garsonjera:true → DETAILS_PROVIDED → the presentation engine
    // re-searches and shows a DIFFERENT property. Interest wins over slots —
    // but only when a property is actually in play (presented batch, current
    // batch, or a known EB), never on a cold "mi e interesna" with nothing
    // on the table. Negations ("ne mi e interesna") are excluded inside
    // detectPropertyInterest itself.
    // A fresh Евидентен број that DIFFERS from the bound one ("me interesira
    // 99" while EB 58 is on the table) is the client SWITCHING properties —
    // the override used to stomp the fresh pid with session.slots.propertyId
    // and Lina closed the fee funnel on a property no longer under
    // discussion. A matching pid ("mi se svigja 76" with 76 bound) or no pid
    // keeps the like-lane into closing.
    const freshPid = ev.type === 'PROPERTY_ID_REQUESTED' ? ev.propertyId : undefined;
    const isSwitch = freshPid !== undefined && freshPid !== session.slots.propertyId;
    if (!isSwitch && ev.type !== 'REJECTED' && ev.type !== 'ESCALATE' && ev.type !== 'INTERESTED'
      && detectPropertyInterest(text)
      && PROP_INTAKE_STATES.has(session.state)
      && propertyOnTable(session)) {
      ev = { type: 'INTERESTED', propertyId: freshPid ?? session.slots.propertyId };
    }

    // Pure-agreement answer to the openness/location ask ("otvoren sum",
    // "спремна сум", "добро") in discovery = "no preference" → city-wide
    // (anywhere). Without this the funnel loops "Во кој дел од градот…?" at a
    // client who just said yes. Event-independent (fires whatever the model
    // picked) and only when the message carries NO other slot (a named
    // neighborhood or a bedroom/budget detail is a search, not an answer).
    // detectWidenIntent already excludes register/contact phrasings, which
    // keep flowing to the queue escape.
    if (session.state === 'discovery'
      && (ev.type === 'STAY' || ev.type === 'DETAILS_PROVIDED')
      && !ev.location && !ev.bedrooms && !ev.budget && !ev.sqm
      && detectWidenIntent(text)) {
      ev = { type: 'SEARCH_REQUESTED', service: session.slots.service,
        house: session.slots.house, business: session.slots.business, anywhere: true };
    }
    // Agreement in closing → FEE_AGREED.
    // Guard: ev.type must NOT already be REJECTED/ESCALATE/FEE_REFUSED, but
    // DETAILS_PROVIDED is allowed — a false-positive location ("да" matches
    // a location substring like "Кисела Вода") can inflate ev to DETAILS_PROVIDED
    // and silently block the agreement override, leaving the client stuck in
    // closing with a broken funnel.
    // NEGATED agreement flips to refusal — own branch BEFORE the consent
    // overrides (detectNegatedAgreement makes detectAgreement false, so the
    // overrides below can't catch it; the deterministic path must refuse
    // exactly like the LLM-down path).
    if ((ev.type === 'STAY' || ev.type === 'DETAILS_PROVIDED') && session.state === 'closing'
      && detectNegatedAgreement(text) && !detectFeeWhy(text)
      && !detectRejection(text) && !detectInvestmentOpinion(text)) {
      ev = { type: 'FEE_REFUSED' };
    }

    // "STAPI VO KONTAKT I INFORMIRAJ ME" — an explicit order to contact + be
    // informed. The contact-request family (стапи/влези во контакт) IS an
    // agreement (AGREE_PHRASES), but the LLM was inventing bogus events for it
    // (e.g. routing the inform-stem to SEEN_PROPERTY). Closing + agreement =
    // the client wants the owner contacted → the fee gate, always.
    if (session.state === 'closing' && ev.type !== 'FEE_AGREED'
      && ev.type !== 'REJECTED' && ev.type !== 'ESCALATE' && ev.type !== 'FEE_REFUSED'
      && detectAgreement(text) && !detectFeeWhy(text)
      && !detectRejection(text) && !detectInvestmentOpinion(text)) {
      ev = { type: 'FEE_AGREED' };
    }

    // Fee WHY guard — agreement overridden to STAY when WHY-question
    if (session.state === 'closing' && ev.type === 'FEE_AGREED' && detectFeeWhy(text)) {
      ev = { type: 'STAY' };
    }

    // [21:28] CONDITIONAL FEE CONSENT (closing + knock-out recovery): the fee
    // was asked and the client conditionally accepts — "AKO VI SE TAKVI
    // USLOVITE", "AKO E USTE DOSTAPEN MOZDA I KE VI DADAM 500 DEN ZA DA GO
    // VIDAM". The condition does NOT retract the acceptance: fee-sized
    // give-verbs ("ke dadam 500 den", now with dative clitics — "ke VI dadam")
    // and the ако+услови/такви conditional-accept family are FEE_AGREED. The
    // funnel proceeds (contact collection → owner ping-pong, where availability
    // gets confirmed anyway) — never the price-relay lane (price.negotiate),
    // which previously swallowed the fee-sized conditional as a property
    // counter-offer and answered with "Крајната цена зависи од сопственикот…".
    // Scope: a fee context only — the fee was asked (viewingFeeAgreed not yet
    // set, or ownerContactPending) or the state is closing. Property-sized
    // counter-offers ("dali moze za 140000") are excluded by
    // counterOfferFeeSized inside the detectors themselves.
    if ((session.state === 'closing'
        || (session.slots.viewingFeeAgreed || (session.slots.feeRejections ?? 0) >= 1))
      && !session.slots.viewingFeeAgreed
      // ownerContactPending WITHOUT a disclosed fee (the availability-ack
      // flow, 21:05b) stays fee-first: a visit command there must DISCLOSE
      // the fee before any consent reclassification.
      && !session.slots.ownerContactPending
      && ev.type !== 'FEE_AGREED' && ev.type !== 'REJECTED' && ev.type !== 'ESCALATE'
      && ev.type !== 'FEE_REFUSED' && ev.type !== 'PROPERTY_ID_REQUESTED'
      && (detectFeePaymentAgreement(text) || detectConditionalFeeAccept(text))) {
      ev = { type: 'FEE_AGREED' };
    }

    // Visit time in visit_scheduling → VISIT_TIME_PROVIDED. A BARE clock with
    // no day ("6", "6 SAAT", "во 18:00") COMPLETES the day already stored
    // ("PONEDELIK 6" → re-asked → client answers "6") instead of REPLACING
    // it: the old overwrite resolved the bare clock to TODAY and the owner
    // was asked for the wrong day entirely (the [12:42] transcript — owner
    // ping-pong fired for Сабота when the client had said PONEDELNIK).
    if (session.state === 'visit_scheduling'
      && ev.type !== 'VISIT_TIME_PROVIDED' && ev.type !== 'ESCALATE' && ev.type !== 'REJECTED') {
      let t = detectVisitTime(text);
      // BARE-DIGIT COMPLETION ("6" after "VO PONEDELNIK MOZAM" — the [12:43]
      // transcript): a standalone 1–2-digit hour answering the exact-hour ask
      // is only unambiguous when a day is already armed in the slot. Same
      // guard family as the DAY_TRAILING_HOUR form (no clock/date/money tail).
      if (!t && /^с?\s*["'„]*(\d{1,2})\s*[.?!]*$/iu.test(text)
        && hasDayWord(session.slots.visitTime ?? '')) {
        t = text.trim();
      }
      if (t) {
        const storedT = session.slots.visitTime ?? '';
        let mergedT = t;
        if (!hasDayWord(t) && hasDayWord(storedT) && !hasClockHint(t) && hasClockHint(storedT)) {
          mergedT = `${storedT.trim()} ${t.trim()}`;
        }
        ev = { type: 'VISIT_TIME_PROVIDED', visitTime: mergedT };
      }
    }

    // Time confirm: rejection / agreement / new time
    if (ev.type === 'STAY' && session.state === 'time_confirm') {
      const bareNo = /^(?:не|ne|no)\s*[.!?]*$/iu.test(text.trim());
      if (detectTimeRejection(text) || bareNo) {
        ev = { type: 'TIME_REJECTED' };
      } else if (detectAgreement(text)) {
        ev = { type: 'TIME_ACCEPTED' };
      } else {
        const t = detectVisitTime(text);
        if (t) ev = { type: 'VISIT_TIME_PROVIDED', visitTime: t };
      }
    }

    // Owner checking: time rejection or new time. An EXACT repeat of the
    // phrase already on the table ("6 SAAT" twice in a row — the client's
    // [14:35] double-send) must not restart the owner check: the slot is
    // compared WHOLE (day+clock) so "во 18:00" re-sent after "6 SAAT" still
    // fires (its raw text differs) while an identical re-send stays silent.
    // A bare clock with no day ("6 SAAT" alone) is a COMPLETION of the day
    // already on the table — prepended so the owner ask reads one phrase, and
    // normalizeOwnerTime resolves the day+clock pair.
    if (session.state === 'owner_checking'
      && ev.type !== 'ESCALATE' && ev.type !== 'REJECTED') {
      if (detectTimeRejection(text)) {
        ev = { type: 'TIME_REJECTED' };
      } else {
        const t = detectVisitTime(text);
        const stored = session.slots.visitTime ?? '';
        const dupClock = !!t && !hasDayWord(t) && hasClockHint(stored)
          && (text.trim().toLowerCase() === stored.split(',')[0].trim().toLowerCase()
            || stored.trim().toLowerCase().endsWith(text.trim().toLowerCase()));
        if (t && !dupClock && t.trim().toLowerCase() !== stored.trim().toLowerCase()) {
          let merged = t;
          if (!hasDayWord(t) && hasDayWord(stored)) {
            // DAY-FIRST merge everywhere ([12:43] contract) — and only when
            // the stored phrase lacks its own clock (a stored clock must
            // never resurrect under a new bare proposal).
            if (!hasClockHint(stored)) merged = `${stored.trim()} ${t.trim()}`;
          }
          ev = { type: 'VISIT_TIME_PROVIDED', visitTime: merged };
        }
        // else: a duplicate re-send (whole phrase, or the bare clock after a
        // merge) or no time at all — ev unchanged, the check stays in flight.
      }
    }

    // See offers in discovery → SEARCH_REQUESTED (criteria-preserving — the
    // [17:14] fix: "помало нешто до 300евра" keeps its budget).
    if (session.state === 'discovery'
      && ev.type !== 'REJECTED' && ev.type !== 'ESCALATE' && ev.type !== 'PROPERTY_ID_REQUESTED'
      && detectSeeOffers(text)) {
      ev = await this.recomputeSearchEvent(ev, text, session, true);
    }

    // Suggest alternatives in property_query → SEARCH_REQUESTED (criteria-preserving).
    if ((session.state === 'property_query' || session.state === 'presentation')
      && ev.type !== 'REJECTED' && ev.type !== 'ESCALATE'
      && ev.type !== 'PROPERTY_ID_REQUESTED' && ev.type !== 'INTERESTED'
      && (detectSuggestAlternatives(text) || detectDrugAlternative(text))) {
      ev = await this.recomputeSearchEvent(ev, text, session, false);
    }
    // Presentation state: ANY bare "more/other" ask ("sto uste ima?", "nesto
    // drugo?") means the client wants the NEXT batch of matching properties —
    // the options engine re-presents with new EBs. Availability asks are
    // excluded: "dali uste e dostapen?" is about the CURRENT property (the
    // "усте" inside it must never read as a new search).
    if (session.state === 'presentation'
      && ev.type !== 'REJECTED' && ev.type !== 'ESCALATE'
      && ev.type !== 'PROPERTY_ID_REQUESTED' && ev.type !== 'INTERESTED'
      && !detectAvailabilityAsk(text) && mentionsMore(text)) {
      ev = await this.recomputeSearchEvent(ev, text, session, false);
    }

    // Property locate pick → INTERESTED
    if (session.state === 'property_locate'
      && ev.type !== 'PROPERTY_ID_REQUESTED' && ev.type !== 'REJECTED' && ev.type !== 'ESCALATE') {
      const batch = session.slots.currentBatch ?? [];
      const pick = detectLocatePick(text);
      if (pick !== undefined && batch[pick] !== undefined) {
        ev = { type: 'INTERESTED', propertyId: batch[pick] };
      } else if (batch.length === 1 && detectAgreement(text) && !/знам|znam/i.test(text)) {
        ev = { type: 'INTERESTED', propertyId: batch[0] };
      }
    }

    // Availability ask with a known EB — the property under discussion is
    // already named; route it into the property funnel even with no digits
    // in THIS message ("dali e dostapen?" right after "stan 90").
    if (ev.type === 'STAY' && detectAvailabilityAsk(text)
      && PROP_INTAKE_STATES.has(session.state)) {
      const known = session.slots.propertyId ?? session.slots.interestedPropertyId;
      if (known !== undefined) ev = { type: 'PROPERTY_ID_REQUESTED', propertyId: known };
    }

    // MORE-OPTIONS mid-funnel (the [22:2x] Viber transcript): in closing the
    // client asks for alternatives ("a drugi stanovi do taa cena imate?",
    // "drugi nemate vo celo skopje", "nesto novo") — the shopping intent wins
    // over the fee re-pitch: the relay joins bursts ("pari za poseta" +
    // "nesto novo" 6s apart = ONE turn), and the fee is already on the table.
    // Recompute to a search event so the FSM's closing→presentation edge
    // serves the NEXT BATCH; the fee debate resumes when a new property
    // catches him. Guards: fee DECISIONS keep their lanes (agreement,
    // refusal/complaint, why, surprise), amount-bearing questions keep
    // rent-math/total-cost, visit scheduling keeps visit-time, availability
    // keeps the property funnel, and a bare price ask stays a price ask.
    if (session.state === 'closing'
      && ev.type === 'STAY' && detectMoreOptions(text)
      && !detectAvailabilityAsk(text)
      && !detectFeeWhy(text) && !detectFeeComplaint(text) && !detectFeeSurprise(text)
      && !detectFeePaymentAgreement(text) && !detectAgreement(text)
      && !detectRejection(text) && !detectVisitTime(text)
      && !extractRentMath(text) && !detectTotalCostAsk(text)
      && !detectPriceAsk(text)) {
      ev = await this.recomputeSearchEvent(ev, text, session, false);
    }

    // If event is still STAY and no slots were extracted → truly novel, needs LLM.
    const hasSlots = !!(slots.service || location || slots.bedrooms || slots.bedroomsMin || slots.budget || slots.sqm || slots.anywhere);
    const hasDetail = !!(location || slots.bedrooms || slots.bedroomsMin || slots.budget || slots.sqm || slots.anywhere);
    if (ev.type === 'STAY' && !hasSlots) {
      // CLOSING INTEREST RE-AFFIRMATION (the 19:25 TUI capture: "PA VIDI STO E
      // SO NEGO\nZAINTERESIRAN SUM" — deferred-interest tail while the fee
      // funnel is live). detectPropertyInterest only owned the intake states;
      // in closing the line fell through to the LLM, which (correctly, but at
      // a round-trip) kept the funnel. Own it here — AFTER the deferral gate,
      // with a direct return: slots are empty by construction, so the STAY
      // deferral above would otherwise fire first. With a property still on
      // the table and the fee not yet settled, re-affirmed interest is a
      // STAY — the fee ask re-serves. Rejections, agreements, fee asks and
      // escalations keep their own lanes (ev.type guard below).
      if (session.state === 'closing'
        && ev.type === 'STAY' && !detectInvestmentOpinion(text)
        && propertyOnTable(session) && detectPropertyInterest(text)) {
        console.log(`[timing] det-classify ${Date.now() - t0}ms → CLOSING_INTEREST_STAY`);
        return { event: { type: 'STAY' }, offensive: false, offenseLevel: 0 };
      }
      // META-CLARIFICATION STAY (the [22:30] TUI capture: "NE MISLEV NISTO
      // VULGARNO"). After an abrupt deterministic serve the client defends
      // their own words — no question, no criteria, no property (the detector
      // topic-vetoes property/price/service words so real content keeps its
      // lanes). The reply was deterministic downstream anyway; this only
      // removes the LLM round-trip. Funnel states keep re-asking the next
      // missing criterion; closing re-serves the fee ask (intact guard —
      // rejections/agreements never reach here: their events aren't STAY).
      if (ev.type === 'STAY' && detectMetaClarify(text)) {
        console.log(`[timing] det-classify ${Date.now() - t0}ms → META_CLARIFY_STAY`);
        return { event: { type: 'STAY' }, offensive: false, offenseLevel: 0 };
      }
      // MORE-OPTIONS (the [22:2x] Viber transcript): mid-fee-funnel asks for
      // alternatives ("a drugi stanovi do taa cena imate?", "drugi nemate vo
      // celo skopje", "nesto novo") are a SEARCH_REQUESTED — the FSM's
      // closing→presentation edge (added same commit) serves the NEXT BATCH;
      // the fee debate resumes when a new property catches him. Guards:
      // fee traffic keeps its lanes (surprise/why/complaint/agreement/refusal),
      // amount-bearing questions keep rent-math/total-cost, and price-ask
      // facets without the more-marker ("kolku e cenata?") stay price asks.
      if (ev.type === 'STAY' && detectMoreOptions(text)
        && !detectFeeWhy(text) && !detectFeeComplaint(text) && !detectFeeSurprise(text)
        && !detectFeePaymentAgreement(text) && !detectAgreement(text)
        && !detectRejection(text) && !detectVisitTime(text)
        && !extractRentMath(text) && !detectTotalCostAsk(text)
        && (mentionsMore(text) || !detectPriceAsk(text))) {
        console.log(`[timing] det-classify ${Date.now() - t0}ms → MORE_OPTIONS_SEARCH`);
        return { event: { type: 'SEARCH_REQUESTED' }, offensive: false, offenseLevel: 0 };
      }
      return undefined; // signals caller to fire Groq
    }
    // INTENT_DECLARED with an explicit SERVICE is OWNED here (the 15:12 TUI
    // capture: "SAKAM DA ZEMAM STAN POD KIRIJA" — explicit rent need, no
    // location). The service is stated fact, not enrichment material: the
    // discovery ask picks up the missing pieces (location → bedrooms →
    // budget), and the funnel must not depend on an LLM round-trip to repeat
    // what the client already said (with the LLM down, the ask degenerated to
    // "купување или изнајмување?" — the exact question just answered). Only
    // intents with NO slot at all still defer ("ми треба стан" — buy/rent is
    // genuinely unknown and the LLM may enrich it from history).
    if (ev.type === 'INTENT_DECLARED' && !hasDetail && !slots.service) {
      return undefined; // signals caller to fire Groq
    }
    // Property-directed traffic keeps the classic path: a bare EB in the text
    // must reach the PROPERTY_ID_REQUESTED override (the availability funnel
    // depends on it — "DALI USTE E NA PRODAZBA 78?" carries PRODAZBA, which
    // extracts service='buy', but the number is the real payload). Defer to
    // the LLM-down recompute, whose bare-number override owns the routing.
    if (ev.type === 'INTENT_DECLARED' && inferPropertyId(text) !== undefined) {
      return undefined; // signals caller to fire Groq
    }

    console.log(`[timing] det-classify ${Date.now() - t0}ms → ${ev.type}`);
    return { event: ev, offensive: false, offenseLevel: 0 };
  }

  async classify(session: ChatSession, text: string): Promise<Classified> {
    const messages = [
      { role: 'system' as const, content: CLASSIFY_SYSTEM },
      { role: 'system' as const, content: `CURRENT STATE: ${session.state}` },
      ...session.history.slice(-8).map(m => ({ role: m.role, content: m.text })),
      { role: 'user' as const, content: text },
    ];
    let parsed: Classified;
    let llmDown = false;
    const t0 = Date.now();
    try {
      const raw = await this.llm.complete({
        role: 'classify',
        messages,
        temperature: this.cfg.classifyTemp,
        maxTokens: 300,
        topP: this.cfg.topP,
        json: true,
      });
      parsed = parseClassified(raw);
    } catch (e) {
      console.error('[classify] LLM failed:', (e as Error).message);
      llmDown = true;
      parsed = { event: { type: 'STAY' }, offensive: false, offenseLevel: 0 };
    }
    console.log(`[timing] classify ${Date.now() - t0}ms → ${parsed.event.type}`);
    // Bare-number override (see inferPropertyId): in property-intake states a
    // 2-3 digit number always means an Евидентен број, even when the LLM chose
    // another event (e.g. INTERESTED) or when the LLM is DOWN — so "SIFRA 82"
    // still routes to property_query instead of dead-ending in idle.
    if (PROP_INTAKE_STATES.has(session.state)) {
      const id = inferPropertyId(text);
      if (id) parsed.event = { type: 'PROPERTY_ID_REQUESTED', propertyId: id };
      // A PROPERTY_ID_REQUESTED with NO number is a hallucination ("A NESTO
      // POSKAPO DO 1000 EVRA" → PROPERTY_ID_REQUESTED with no EB). There is
      // no property to look up — downgrade to STAY so the deterministic slot
      // path extracts the budget and the discovery funnel continues.
      // Same when the claimed number is a budget-capped PRICE, not an EB
      // ("bilo kade do 250" — the LLM may put propertyId 250 on the event,
      // which must NOT route to property_query "не можам да го најдам имотот
      // со Евидентен број 250"): downgrade and let the deterministic slot
      // path extract the budget + anywhere. ONLY the specific claimed number
      // is tested — "дај ми 78, до 250 евра" keeps its genuine EB 78.
      else if (parsed.event.type === 'PROPERTY_ID_REQUESTED') {
        const pid = parsed.event.propertyId;
        const cappedPid = pid !== undefined
          && new RegExp(`(?:до|околу|под|do|okolu|oko|pod)\\s*${pid}\\b`, 'i').test(text);
        if (pid === undefined || cappedPid) parsed.event = { type: 'STAY' };
      }
    }
    // Seen-property override: "го гледав огласот за стан во Карпош", "тој
    // конкретен стан", "кој стан беше?" — the client saw a SPECIFIC property
    // but gives no number. This is NOT a fresh search: Lina must ask for the
    // Евидентен број first, then help find the property by details. Fires in
    // the intake states even when the LLM read it as DETAILS_PROVIDED (the
    // deterministic detector owns the funnel here). A known number
    // (PROPERTY_ID_REQUESTED) wins — that is the easy path.
    // ALSO: if inferPropertyId extracts a number ("stanot so broj 61"),
    // the event is already PROPERTY_ID_REQUESTED — skip SEEN_PROPERTY so
    // the property_query path handles it directly (availability, price, etc.).
    const inferPid = await this.resolveBarePid(text, session);
    // GUARD 1 — availability asks are never seen-property probes (the [19:28]
    // field bug: "DALI SEUSTE E DOSTAPEN?" right after naming EB 90 was
    // mislabeled SEEN_PROPERTY by the LLM → property_locate asked "do you know
    // the EB?" the client JUST gave). LLM verdicts never override detectors.
    if (parsed.event.type === 'SEEN_PROPERTY' && detectAvailabilityAsk(text)) {
      parsed.event = { type: 'STAY' };
    }
    // GUARD 1b — a pure greeting/small-talk opener is never a seen-property
    // probe ("ZDRAVO" alone: the LLM's SEEN_PROPERTY verdict sent the client
    // to property_locate, which fired "do you know the EB?" out of nowhere).
    if (parsed.event.type === 'SEEN_PROPERTY'
      && /^(?:zdravo|dobar\s*den|dobro\s*utro|zdr|pozz|poz|hello|hi|selam|hey|здраво|добар\s*ден|добро\s*утро|привет|селам)[\s!.,?]*$/iu.test(text.trim())) {
      parsed.event = { type: 'STAY' };
    }
    // GUARD 2 — the client NAMED an EB earlier in this session (slots carry
    // it) and the LLM now says "seen property" for a digit-less follow-up:
    // the number they gave IS the property under discussion. Fall back to the
    // deterministic core (buildEvent + overrides), which routes the ask
    // correctly (availability → closing ack; interest → closing; etc.).
    if (parsed.event.type === 'SEEN_PROPERTY'
      && !detectSeenProperty(text) // a literal "go gledav stan na internet" still enters property_locate
      && (session.slots.propertyId ?? session.slots.interestedPropertyId) !== undefined) {
      const s = extractSlots(text);
      let loc: string | undefined;
      if (this.properties) {
        try {
          const locs = await this.properties.locations();
          loc = detectLocation(text, locs) ?? undefined;
        } catch { /* ignore */ }
      }
      const ev = buildEvent(session.state, {
        service: s.service, location: loc, bedrooms: s.bedrooms,
        sqm: s.sqm, business: s.business, house: s.house,
        budget: s.budget, anywhere: s.anywhere, need: s.need, rejected: s.rejected,
        plac: s.plac, yard: s.yard,
      });
      console.log(`[classify] seen-property guard: EB ${session.slots.propertyId ?? session.slots.interestedPropertyId} already known → ${ev.type}`);
      parsed.event = ev;
    }
    // GUARD 3 — an availability ask with a known EB is ALWAYS about the
    // property under discussion, even with no digits in THIS message
    // ("dali e dostapen?" right after "stan 90"). STAY verdicts promote to
    // PROPERTY_ID_REQUESTED so the FSM enters the property funnel and the
    // handler's availability-ack branch fires (never the LLM's improvisation).
    if (parsed.event.type === 'STAY' && detectAvailabilityAsk(text)
      && PROP_INTAKE_STATES.has(session.state)) {
      const known = session.slots.propertyId ?? session.slots.interestedPropertyId;
      if (known !== undefined) {
        console.log(`[classify] availability-with-known-EB guard: EB ${known}`);
        parsed.event = { type: 'PROPERTY_ID_REQUESTED', propertyId: known };
      }
    }
    // GUARD 3b — the RENT-PRICE question with NO digits ("KOLKU MU E RENTA?",
    // "kolku e kirijata?") after an EB is funnel traffic about THAT property:
    // the [14:22] transcript re-rendered the full card because the STAY
    // verdict skipped the price-ask promotion. Mirrors the availability
    // promotion above — the property_query branch's price fast path answers.
    if (parsed.event.type === 'STAY' && detectPriceAsk(text)
      && !detectProvisionAsk(text) && !detectProvisionWho(text)
      && PROP_INTAKE_STATES.has(session.state)) {
      const known = session.slots.propertyId ?? session.slots.interestedPropertyId;
      if (known !== undefined) {
        console.log(`[classify] price-with-known-EB guard: EB ${known}`);
        parsed.event = { type: 'PROPERTY_ID_REQUESTED', propertyId: known };
      }
    }
    // FUNNEL-SLIP GUARD (the [14:14] transcript): a search opener carrying
    // criteria ("SKM DA IZNAJMAM DVOSOBEN STAN" — explicit rent marker +
    // room word) must NEVER reach the funnel outside the discovery family.
    // An LLM blunder (INTERESTED on the "sakam" shape, a hallucinated
    // REJECTED) skipped the deterministic recompute below, the service slot
    // never filled and Lina re-asked "купување или изнајмување?" the client
    // had just answered. Pin the event into the family so the deterministic
    // slot extraction always runs on criteria-bearing openers. True
    // rejections (detectRejection), EB asks and seen-property probes keep
    // their own funnels.
    if (['idle', 'intent', 'discovery'].includes(session.state)
      && ['INTERESTED', 'REJECTED', 'FEE_AGREED', 'FEE_REFUSED',
        'VISIT_TIME_PROVIDED', 'TIME_ACCEPTED', 'TIME_REJECTED'].includes(parsed.event.type)
      && (detectService(text) || detectBedrooms(text) || detectBedroomsRange(text) || detectBudget(text)
        || detectBusiness(text) || detectHouse(text) === true
        || detectGarsonjera(text) || detectPlac(text) || detectYardNeed(text))
      && !detectRejection(text)) {
      console.log(`[classify] funnel-slip guard: criteria-bearing opener pinned to DETAILS_PROVIDED (was ${parsed.event.type})`);
      parsed.event = { type: 'DETAILS_PROVIDED' };
    }
    if (['idle', 'intent', 'discovery'].includes(session.state)
      && parsed.event.type !== 'PROPERTY_ID_REQUESTED'
      && parsed.event.type !== 'REJECTED'
      && !inferPid
      && detectSeenProperty(text)
      && !(detectPropertyInterest(text) && propertyOnTable(session))) {
      const slots = extractSlots(text);
      // extractSlots leaves location empty (the feed's neighborhoods fill it) —
      // resolve it here so "oglasot za stan vo karpos" already carries Карпош.
      let location = slots.location;
      if (!location && this.properties) {
        try {
          const locs = await this.properties.locations();
          location = detectLocation(text, locs) ?? undefined;
        } catch (e) {
          console.error('[classify] location lookup failed:', (e as Error).message);
        }
      }
      parsed.event = {
        type: 'SEEN_PROPERTY',
        service: slots.service,
        location,
        bedrooms: slots.bedrooms,
        sqm: slots.sqm,
        business: slots.business,
        house: slots.house,
        budget: slots.budget,
        anywhere: slots.anywhere,
      };
    }
    // Deterministic slot extraction + gap-fill: the discovery funnel must not
    // depend on the LLM's mood. It fires when the LLM is DOWN (the whole
    // discovery->presentation path survives without any LLM) or when the model
    // returned a discovery-family event (STAY / INTENT_DECLARED /
    // DETAILS_PROVIDED / SEARCH_REQUESTED) — in that case deterministic rules
    // extract whatever the message actually says (service only from EXPLICIT
    // buy/rent markers — "ми треба стан" without one stays unknown, never an
    // assumed buy) and fill only the FIELDS the LLM left empty, then recompute
    // the funnel event. Meaningful LLM decisions (INTERESTED,
    // FEE_AGREED, REJECTED, PROPERTY_ID_REQUESTED, …) are kept untouched.
    // "сакам стан во Centar, 2 spalni, do 80.000 евра" -> SEARCH_REQUESTED
    // with or without a single LLM call.
    // LLM-down contact intake: in contact_collection a name+phone can be pulled
    // deterministically, so the queue/visit flow completes without any LLM.
    // The phone may ALREADY be known — in real Viber the sender id IS the
    // caller's number (prefilled into slots.phone), so the name alone completes
    // the contact ("GORAN MOZE NA OVOJ BROJ" = name + the number he writes from).
    if ((llmDown || parsed.event.type === 'STAY') && session.state === 'contact_collection') {
      const c = detectContact(text);
      const phone = c.phone ?? session.slots.phone;
      if (phone || c.name) {
        parsed.event = phone && c.name
          ? { type: 'CONTACT_PROVIDED', name: c.name, phone }
          : phone
            ? { type: 'CONTACT_INCOMPLETE', phone }
            : { type: 'CONTACT_INCOMPLETE', name: c.name };
      }
    }
    const RECOMPUTE_EVENTS: EventType[] = ['STAY', 'INTENT_DECLARED', 'DETAILS_PROVIDED', 'SEARCH_REQUESTED'];
    // Contact events are excluded exactly like PROPERTY_ID_REQUESTED /
    // SEEN_PROPERTY: the contact intake above OWNS contact_collection. Without
    // the exclusion, an LLM-down "078914198" gets rebuilt as DETAILS_PROVIDED
    // with budget 78914198 (extractSlots reads the digits as a price) and the
    // phone never reaches slots.
    if (parsed.event.type !== 'PROPERTY_ID_REQUESTED'
      && parsed.event.type !== 'SEEN_PROPERTY' // the seen-property override owns the intake funnel
      && parsed.event.type !== 'CONTACT_PROVIDED'
      && parsed.event.type !== 'CONTACT_INCOMPLETE' // the contact intake owns contact_collection
      && (llmDown || RECOMPUTE_EVENTS.includes(parsed.event.type))) {
      // GLOBAL FIX: When Groq fires (not LLM-down), strip its slot values.
      // Only the event type survives. The deterministic layer is the single
      // source of truth for slots — Groq's job is event classification, not
      // slot extraction. This prevents Groq from leaking slots inferred from
      // conversation history (e.g. "Скопje" from a previous "vo skopje")
      // into the deterministic flow, which would skip the neighbourhood question.
      if (!llmDown) {
        const keptType = parsed.event.type;
        parsed.event = { type: keptType };
      }
      const slots = extractSlots(text);
      if (this.properties) {
        try {
          const locs = await this.properties.locations();
          const loc = detectLocation(text, locs);
          if (loc) slots.location = loc;
        } catch (e) {
          console.error('[classify] location lookup failed:', (e as Error).message);
        }
      }
      // Gap-fill: deterministic slots are the source of truth.
      // When Groq fired, its slots were stripped — deterministic fills everything.
      // When LLM was down, deterministic fills gaps the LLM left empty.
      const ev = parsed.event;
      // POI WISH ("okolu Kapitol Biser"): the proximity anchor inside a SEARCH
      // phrase. Extracted from the raw text BEFORE location normalizes it away.
      const poiWish = extractPoiWish(text);
      if (ev.service === undefined && slots.service) ev.service = slots.service;
      if (ev.location === undefined && slots.location) ev.location = slots.location;
      if (poiWish) (ev as { poiAnchor?: string }).poiAnchor = poiWish;
      if (ev.bedrooms === undefined && slots.bedrooms) ev.bedrooms = slots.bedrooms;
      if (ev.bedroomsMin === undefined && slots.bedroomsMin) ev.bedroomsMin = slots.bedroomsMin;
      if (ev.bedroomsMax === undefined && slots.bedroomsMax) ev.bedroomsMax = slots.bedroomsMax;
      if (ev.garsonjera === undefined && slots.garsonjera) ev.garsonjera = true;
      if (!ev.sizeWaived && slots.sizeWaived) ev.sizeWaived = true;
      if (ev.plac === undefined && slots.plac) ev.plac = true;
      if (!ev.yard && slots.yard) ev.yard = true;
      if (ev.sqm === undefined && slots.sqm) ev.sqm = slots.sqm;
      if (ev.business === undefined && slots.business !== undefined) ev.business = slots.business;
      if (ev.house === undefined && slots.house !== undefined) ev.house = slots.house;
      if (ev.budget === undefined && slots.budget) ev.budget = slots.budget;
      if (ev.anywhere === undefined && slots.anywhere) ev.anywhere = true;
      const det = buildEvent(session.state, {
        service: ev.service, location: ev.location, bedrooms: ev.bedrooms,
        sqm: ev.sqm, business: ev.business, house: ev.house, budget: ev.budget,
        anywhere: ev.anywhere, need: slots.need, rejected: slots.rejected,
        sizeWaived: ev.sizeWaived || undefined, pricePriority: ev.pricePriority || undefined,
        garsonjera: ev.garsonjera || undefined,
        plac: ev.plac || undefined, yard: ev.yard || undefined,
      });
      if (det.type !== 'STAY') parsed.event = det;
      // Same session-merge completeness as the deterministic path (LLM-down
      // mirrors it): merged criteria complete → SEARCH_REQUESTED, never a
      // dead-end "Во ред, ги забележав" in discovery.
    // Bedroom RANGE ([09:17]): the deterministic layer owns the capture
    // ("edna ili dve\ndo 140000" — one multi-line message). When the LLM
    // produced a discovery-family event but left the range out, gap-fill it
    // so the funnel never re-asks an answered question.
    if ((llmDown || RECOMPUTE_EVENTS.includes(parsed.event.type))
      && parsed.event.bedroomsMin === undefined && parsed.event.bedroomsMax === undefined) {
      const r = detectBedroomsRange(text);
      if (r) {
        // A range is NOT a minimum: an exact bedrooms slot on the same event
        // (a noun branch reading the lower end) would fight the alternation
        // ladder — drop it in favor of the range.
        parsed.event = { ...parsed.event, bedrooms: undefined, bedroomsMin: r.min, bedroomsMax: r.max };
      }
    }
    if (session.state === 'discovery'
      && (parsed.event.type === 'STAY' || parsed.event.type === 'DETAILS_PROVIDED')) {
      const merged = buildEvent(session.state, {
        service: ev.service ?? session.slots.service,
          location: ev.location ?? session.slots.location,
          bedrooms: ev.bedrooms ?? session.slots.bedrooms,
          bedroomsMin: ev.bedroomsMin ?? session.slots.bedroomsMin,
          bedroomsMax: ev.bedroomsMax ?? session.slots.bedroomsMax,
          sqm: ev.sqm ?? session.slots.sqm,
          business: ev.business ?? session.slots.business,
          house: ev.house ?? session.slots.house,
          budget: ev.budget ?? session.slots.budget,
          anywhere: ev.anywhere || session.slots.anywhere || undefined,
          sizeWaived: ev.sizeWaived || session.slots.sizeWaived || undefined,
          pricePriority: ev.pricePriority || session.slots.pricePriority || undefined,
          garsonjera: ev.garsonjera || session.slots.garsonjera || undefined,
          plac: ev.plac || session.slots.plac || undefined,
          yard: ev.yard || session.slots.yard || undefined,
          need: slots.need, rejected: slots.rejected,
        });
        if (merged.type === 'SEARCH_REQUESTED') parsed.event = merged;
      }
    }
    // --- funnel overrides (run AFTER recompute so nothing clobbers them) ---
    // Visit interest in property states -> INTERESTED: "кога може да се
    // погледне?", "дали е достапен?", "сакам да ја видам", "договори ми…" all
    // mean the client wants to SEE the property — which routes to closing,
    // where the fee is disclosed (code-built, never skippable) before the
    // owner ping-pong. Availability questions are the owner's job, and the
    // owner is only contacted AFTER the fee is agreed.
    // Visit intent WINS over a bare-number property query: "ДОГОВОРИ МИ ЗА
    // ОВОЈ СО БРОЈ 89" means "arrange a visit for 89", not "tell me about 89"
    // — the number only supplies the propertyId (the inferPropertyId override
    // above may have turned the message into PROPERTY_ID_REQUESTED, and that
    // must not swallow the explicit visit request). Deliberate non-visit
    // decisions (REJECTED, ESCALATE) are respected.
    // Intake states (idle/intent/discovery/property_locate): the visit phrase
    // must NAME the property (bare EB) — "organiziraj poseta za 69" (22:19)
    // is a visit command for EB 69, never a card dump.
    if (['property_query', 'presentation'].includes(session.state)
      && parsed.event.type !== 'REJECTED'
      && parsed.event.type !== 'ESCALATE'
      && detectVisitInterest(text)) {
      const pid = parsed.event.propertyId ?? session.slots.propertyId;
      parsed.event = pid ? { type: 'INTERESTED', propertyId: pid } : { type: 'INTERESTED' };
    }
    if (['idle', 'intent', 'discovery', 'property_locate'].includes(session.state)
      && parsed.event.type !== 'REJECTED'
      && parsed.event.type !== 'ESCALATE'
      && detectVisitInterest(text)
      && inferPropertyId(text) !== undefined) {
      parsed.event = { type: 'INTERESTED', propertyId: inferPropertyId(text) };
    }
    // Property interest in a property context — mirror of the deterministic
    // override: even a fired-up model may label "GARSONJERAVA ... MI E
    // INTERESNA" as DETAILS_PROVIDED/SEARCH_REQUESTED (the type word reads as
    // a new search). The client is pointing at a property ALREADY on the
    // table; the FSM turns INTERESTED into the enthusiasm + visit-offer flow
    // with the NAMED property bound (the handler's mention resolver).
    if (parsed.event.type !== 'REJECTED' && parsed.event.type !== 'ESCALATE'
      && parsed.event.type !== 'INTERESTED'
      && detectPropertyInterest(text)
      && PROP_INTAKE_STATES.has(session.state)
      && propertyOnTable(session)) {
      parsed.event = { type: 'INTERESTED',
        propertyId: parsed.event.propertyId ?? session.slots.propertyId };
    }
    // Pure-agreement answer to the openness/location ask ("otvoren sum") in
    // discovery = "no preference" → city-wide (anywhere). Mirror of the
    // deterministic-path override: the funnel must complete with what is
    // already collected, never loop the location question.
    if (session.state === 'discovery'
      && (parsed.event.type === 'STAY' || parsed.event.type === 'DETAILS_PROVIDED')
      && !parsed.event.location && !parsed.event.bedrooms
      && !parsed.event.budget && !parsed.event.sqm
      && detectWidenIntent(text)) {
      parsed.event = { type: 'SEARCH_REQUESTED', service: session.slots.service,
        house: session.slots.house, business: session.slots.business, anywhere: true };
    }
    // LLM-down agreement in closing -> FEE_AGREED ("да, се согласувам" after
    // the fee question). Without it, an LLM outage would loop the fee question
    // forever and never reach the owner. A fee WHY-question ("како тоа? да
    // платам за посета?", "зошто наплаќате?") is NEVER agreement — the bare
    // "да" in "да платам" must not close the deal — and neither is a denial.
    // NEGATED agreement ("ne sum soglasen", "ne se soglasuvam") is the
    // OPPOSITE — FEE_REFUSED, so the persuasion rungs run with the LLM down
    // exactly as they do with it up (the [22:2x] fee-refusal gap: the agree-
    // word inside the negation read as consent and the funnel advanced to
    // contact collection). OWN BRANCH: detectNegatedAgreement makes
    // detectAgreement false, so the consent override below cannot catch it.
    if ((llmDown || parsed.event.type === 'STAY') && session.state === 'closing'
      && detectNegatedAgreement(text)
      && !detectFeeWhy(text) && !detectRejection(text)
      && !detectInvestmentOpinion(text)) {
      parsed.event = { type: 'FEE_REFUSED' };
    }
    if ((llmDown || parsed.event.type === 'STAY') && session.state === 'closing'
      && detectAgreement(text) && !detectFeeWhy(text) && !detectRejection(text)
      && !detectInvestmentOpinion(text)) {
      parsed.event = { type: 'FEE_AGREED' };
    }
    // Fee WHY-question guard (applies even when the LLM is UP): a model that
    // labels "како тоа? да платам за посета?" as FEE_AGREED (the "да" token)
    // must be corrected — the handler answers fee resistance, the funnel stays
    // at the fee question, never advances to contact collection.
    if (session.state === 'closing' && parsed.event.type === 'FEE_AGREED' && detectFeeWhy(text)) {
      parsed.event = { type: 'STAY' };
    }
    // Visit time in visit_scheduling -> VISIT_TIME_PROVIDED, so the owner
    // ping-pong starts ("утре на пладне", "после 6"). The override is
    // event-independent: a time-bearing message in this state is a time
    // proposal, whatever event the model happened to pick (STAY, but also
    // DETAILS_PROVIDED/SEARCH_REQUESTED misreads). Only deliberate events
    // (rejection, escalation) are exempt.
    if (session.state === 'visit_scheduling'
      && parsed.event.type !== 'VISIT_TIME_PROVIDED'
      && parsed.event.type !== 'ESCALATE'
      && parsed.event.type !== 'REJECTED') {
      const t = detectVisitTime(text);
      if (t) {
        const storedTs = session.slots.visitTime ?? '';
        let mergedTs = t;
        if (!hasDayWord(t) && hasDayWord(storedTs) && !hasClockHint(t) && hasClockHint(storedTs)) {
          mergedTs = `${storedTs.trim()} ${t.trim()}`;
        }
        parsed.event = { type: 'VISIT_TIME_PROVIDED', visitTime: mergedTs };
      }
    }
    // LLM-down time_confirm: the owner counter-proposed a time — "во ред, тоа
    // време е добро" -> TIME_ACCEPTED (pending), "не ми одговара" ->
    // TIME_REJECTED (back to visit_scheduling, capped by negotiationCap).
    // Uses detectTimeRejection (not detectRejection) because Latin patterns
    // like "ne mozam" / "ne toj termin" live in TIME_REJECT_RE, not the
    // general REJECT_RE. A standalone "NE" is also a time rejection in this
    // state (the client declines the owner's counter-time). A NEW concrete
    // time ("okolu 18:00", "после 19") re-asks the owner with it — same as
    // the owner_checking override below. A bare clock merges onto the stored
    // day (the [12:42] lesson — never resolve a bare "6" to TODAY).
    if ((llmDown || parsed.event.type === 'STAY') && session.state === 'time_confirm') {
      const bareNo = /^(?:не|ne|no)\s*[.!?]*$/iu.test(text.trim());
      if (detectTimeRejection(text) || bareNo) {
        parsed.event = { type: 'TIME_REJECTED' };
      } else if (detectAgreement(text)) {
        parsed.event = { type: 'TIME_ACCEPTED' };
      } else {
        const t = detectVisitTime(text);
        if (t) {
          const storedTc = session.slots.visitTime ?? '';
          let mergedTc = t;
          if (!hasDayWord(t) && hasDayWord(storedTc) && !hasClockHint(t) && hasClockHint(storedTc)) {
            mergedTc = `${storedTc.trim()} ${t.trim()}`;
          }
          parsed.event = { type: 'VISIT_TIME_PROVIDED', visitTime: mergedTc };
        }
      }
    }
    // Owner check in flight, but the client changed their mind about the time —
    // deterministic (event-independent, like the visit_scheduling override) so
    // the ping-pong survives any LLM mood: a rejection ("не можам во 18:00",
    // "може покасно?") goes back to collecting a NEW concrete time; a NEW
    // concrete time ("MOZAM VO 19:00") re-asks the owner with it. Deliberate
    // events (ESCALATE, REJECTED) are respected. An EXACT re-send of the term
    // already on the table (the [14:35] double-send) stays STAY; a bare clock
    // completes the day-only phrase already stored ("6 SAAT" after
    // "VO PONEDELNIK MOZAM" → "6 saat, vo ponedelnik mozam").
    if (session.state === 'owner_checking'
      && parsed.event.type !== 'ESCALATE'
      && parsed.event.type !== 'REJECTED') {
      if (detectTimeRejection(text)) {
        parsed.event = { type: 'TIME_REJECTED' };
      } else {
        const t = detectVisitTime(text);
        const stored = session.slots.visitTime ?? '';
        const dupClock = !!t && !hasDayWord(t) && hasClockHint(stored)
          && (text.trim().toLowerCase() === stored.split(',')[0].trim().toLowerCase()
            || stored.trim().toLowerCase().endsWith(text.trim().toLowerCase()));
        if (t && !dupClock && t.trim().toLowerCase() !== stored.trim().toLowerCase()) {
          let merged = t;
          if (!hasDayWord(t) && hasDayWord(stored)) {
            // DAY-FIRST merge order everywhere ([12:43] contract): the stored
            // day is the context, the new clock is the news — and
            // hasClockHint/normalizeOwnerTime read the day-then-hour form.
            // The clock-carrying-store guard: a stored phrase with its own
            // clock never donates the day (the rejected 18:00 must not
            // resurrect under a new proposal).
            if (!hasClockHint(stored)) merged = `${stored.trim()} ${t.trim()}`;
          }
          parsed.event = { type: 'VISIT_TIME_PROVIDED', visitTime: merged };
        }
      }
    }
    // See-offers override: mid-discovery the client asks to SEE current offers
    // ("што имате во понуда?", "помало нешто", "покажи ми") BEFORE the
    // criteria are complete — Lina must ANSWER with real DB offers (smallest м²
    // first, area-locked) instead of repeating the missing question. Routes
    // discovery -> presentation (SEARCH_REQUESTED); the handler bypasses the
    // incomplete-criteria guard for see-offers so real offers are presented.
    if (session.state === 'discovery'
      && parsed.event.type !== 'REJECTED'
      && parsed.event.type !== 'ESCALATE'
      && parsed.event.type !== 'PROPERTY_ID_REQUESTED'
      && detectSeeOffers(text)) {
      parsed.event = await this.recomputeSearchEvent(parsed.event, text, session, true);
    }
    // Suggest-alternatives override: in property_query the client answers the
    // not-found line ("predlozi mi", "drugi lokaciii", "да, предложи") — the
    // EB lookup failed, so the reply MUST pivot to real city-wide alternatives
    // (SEARCH_REQUESTED -> presentation), never repeat "не можам да го најдам
    // имотот со Евидентен број X" forever. Deterministic (event-independent),
    // like the see-offers override — "predlozi mi" after a failed lookup is a
    // fresh search, whatever the LLM mood.
    if ((session.state === 'property_query' || session.state === 'presentation')
      && parsed.event.type !== 'REJECTED'
      && parsed.event.type !== 'ESCALATE'
      && parsed.event.type !== 'PROPERTY_ID_REQUESTED'
      && parsed.event.type !== 'INTERESTED'
      && (detectSuggestAlternatives(text) || detectDrugAlternative(text))) {
      parsed.event = { type: 'SEARCH_REQUESTED' };
    }
    // Presentation state: bare "more/other" ask → next options batch (see the
    // deterministic twin above for the availability exclusion).
    if (session.state === 'presentation'
      && parsed.event.type !== 'REJECTED'
      && parsed.event.type !== 'ESCALATE'
      && parsed.event.type !== 'PROPERTY_ID_REQUESTED'
      && parsed.event.type !== 'INTERESTED'
      && !detectAvailabilityAsk(text) && mentionsMore(text)) {
      parsed.event = { type: 'SEARCH_REQUESTED' };
    }
    // property_locate pick: the client chooses among the presented closest
    // matches by position ("првиот" / "вториот") — the system maps that to
    // INTERESTED on the picked EB (fee -> owner flow). Deterministic, so the
    // locate funnel never needs an LLM to understand "да, првиот е тој".
    // A bare number was already turned into PROPERTY_ID_REQUESTED above (the
    // client knows the number — the easy lookup path).
    if (session.state === 'property_locate'
      && parsed.event.type !== 'PROPERTY_ID_REQUESTED'
      && parsed.event.type !== 'REJECTED'
      && parsed.event.type !== 'ESCALATE') {
      const batch = session.slots.currentBatch ?? [];
      const pick = detectLocatePick(text);
      if (pick !== undefined && batch[pick] !== undefined) {
        parsed.event = { type: 'INTERESTED', propertyId: batch[pick] };
      } else if (batch.length === 1 && detectAgreement(text) && !/знам|znam/i.test(text)) {
        // One match shown and the client agrees ("да, тој е") — that is the one.
        // "да, го знам" (I know the number) is NOT an agreement — keep it STAY.
        parsed.event = { type: 'INTERESTED', propertyId: batch[0] };
      }
    }
    return parsed;
  }
}
