import { LlmClient } from './types';
import { ChatSession } from '../fsm/session';
import { AppConfig } from '../config';
import { Event, EventType, isValidEvent } from '../fsm/machine';
import { PropertyService } from '../data/properties';
import { extractSlots, detectLocation, buildEvent, detectContact, detectVisitInterest, detectAgreement, detectVisitTime, detectTimeRejection, detectRejection } from './deterministic';

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
  "event": "INTENT_DECLARED" | "PROPERTY_ID_REQUESTED" | "DETAILS_PROVIDED" | "SEARCH_REQUESTED" | "INTERESTED" | "REJECTED" | "FEE_AGREED" | "FEE_REFUSED" | "VISIT_TIME_PROVIDED" | "TIME_ACCEPTED" | "TIME_REJECTED" | "CONTACT_PROVIDED" | "CONTACT_INCOMPLETE" | "ESCALATE" | "STAY",
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
- DETAILS_PROVIDED: user gives location (which part of the city), bedrooms (спални соби), or budget. Extract into the fields; fill only what is present.
- business: true when the user wants COMMERCIAL space (деловен простор, канцеларија, локал, магацин, хала). For business requests, "sqm" (square meters) matters and bedrooms do NOT.
- house: true when the user wants a HOUSE (куќа, кука, house, kukja) and false when they explicitly say стан/apartment. Leave null when the property type is not mentioned.
- SEARCH_REQUESTED: user asks to see offers now, with enough details already given.
- INTERESTED: user wants to visit / schedule / see a specific property ("сакам да ја видам", "договори посета", "кога може да се погледне", "дали е достапен?" after a property was shown, "да" after a presentation).
- REJECTED: user declines offers, dislikes options, or disagrees with terms.
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
  if (typeof obj.visitTime === 'string' && obj.visitTime.trim()) event.visitTime = obj.visitTime.trim();
  if (typeof obj.name === 'string' && obj.name.trim()) event.name = obj.name.trim();
  if (typeof obj.phone === 'string' && obj.phone.trim()) event.phone = obj.phone.trim();
  if (typeof obj.reason === 'string' && obj.reason.trim()) event.reason = obj.reason.trim();
  const level = Number(obj.offenseLevel);
  return {
    event,
    offensive: obj.offensive === true,
    offenseLevel: Number.isFinite(level) && level > 0 ? Math.floor(level) : 0,
  };
}

/** States where a bare number can only mean an Евидентен број (property intake). */
const PROP_INTAKE_STATES = new Set(['idle', 'intent', 'discovery', 'property_query', 'presentation']);

/**
 * Deterministic safety net: a bare 2-3 digit number in a property-intake state
 * is an Евидентен број even when the LLM doesn't say PROPERTY_ID_REQUESTED
 * ("заинтересирана сум за 78" — the user KNOWS what they want; Lina must not
 * ask buy/rent). Guarded against times (18:30), phones (078/…), bedroom counts,
 * prices (евра/денари) and sizes (м2).
 */
export function inferPropertyId(text: string): number | undefined {
  if (/\b\d{1,2}[:.]\d{2}\b/.test(text)) return undefined;           // 18:30 / 18.30 — time
  if (/0\d{1,2}\s*[/.]\s*\d{2,}/.test(text)) return undefined;       // 078/914 196 — phone
  if (/(спални|соби|евра|евро|evra|evro|денари|ден\.|хилјади|\beur\b|\bmkd\b|м2|м²|m2|m²|кв\.?м|kvadrat|саат|часа|часот|spalna|spalni)/i.test(text)) return undefined;
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

  async classify(session: ChatSession, text: string): Promise<Classified> {
    const messages = [
      { role: 'system' as const, content: CLASSIFY_SYSTEM },
      { role: 'system' as const, content: `CURRENT STATE: ${session.state}` },
      ...session.history.slice(-8).map(m => ({ role: m.role, content: m.text })),
      { role: 'user' as const, content: text },
    ];
    let parsed: Classified;
    let llmDown = false;
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
      else if (parsed.event.type === 'PROPERTY_ID_REQUESTED' && parsed.event.propertyId === undefined) {
        parsed.event = { type: 'STAY' };
      }
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
    if (parsed.event.type !== 'PROPERTY_ID_REQUESTED'
      && (llmDown || RECOMPUTE_EVENTS.includes(parsed.event.type))) {
      const slots = extractSlots(text);
      if (this.properties) {
        try {
          const locs = await this.properties.locations();
          const loc = detectLocation(text, locs);
          if (loc) slots.location = loc;
          // The LLM's location can be sloppy ("во Кисела Вода кај пазар") or
          // garbage ("кукја пофтина") — canonicalize it against the feed's
          // neighborhoods ("Кисела Вода") or drop it (undefined) so the
          // gap-fill below supplies the deterministic match. A garbage phrase
          // must never reach the reply ("…во кукја пофтина").
          if (typeof parsed.event.location === 'string') {
            parsed.event.location = detectLocation(parsed.event.location, locs) ?? undefined;
          }
        } catch (e) {
          console.error('[classify] location lookup failed:', (e as Error).message);
        }
      }
      // Gap-fill: deterministic never overrides a field the LLM already set.
      const ev = parsed.event;
      if (ev.service === undefined && slots.service) ev.service = slots.service;
      if (ev.location === undefined && slots.location) ev.location = slots.location;
      if (ev.bedrooms === undefined && slots.bedrooms) ev.bedrooms = slots.bedrooms;
      if (ev.sqm === undefined && slots.sqm) ev.sqm = slots.sqm;
      if (ev.business === undefined && slots.business !== undefined) ev.business = slots.business;
      if (ev.house === undefined && slots.house !== undefined) ev.house = slots.house;
      if (ev.budget === undefined && slots.budget) ev.budget = slots.budget;
      const det = buildEvent(session.state, {
        service: ev.service, location: ev.location, bedrooms: ev.bedrooms,
        sqm: ev.sqm, business: ev.business, house: ev.house, budget: ev.budget, rejected: slots.rejected,
      });
      if (det.type !== 'STAY') parsed.event = det;
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
    if (['property_query', 'presentation'].includes(session.state)
      && parsed.event.type !== 'REJECTED'
      && parsed.event.type !== 'ESCALATE'
      && detectVisitInterest(text)) {
      const pid = parsed.event.propertyId ?? session.slots.propertyId;
      parsed.event = pid ? { type: 'INTERESTED', propertyId: pid } : { type: 'INTERESTED' };
    }
    // LLM-down agreement in closing -> FEE_AGREED ("да, се согласувам" after
    // the fee question). Without it, an LLM outage would loop the fee question
    // forever and never reach the owner.
    if ((llmDown || parsed.event.type === 'STAY') && session.state === 'closing' && detectAgreement(text)) {
      parsed.event = { type: 'FEE_AGREED' };
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
      if (t) parsed.event = { type: 'VISIT_TIME_PROVIDED', visitTime: t };
    }
    // LLM-down time_confirm: the owner counter-proposed a time — "во ред, тоа
    // време е добро" -> TIME_ACCEPTED (pending), "не ми одговара" ->
    // TIME_REJECTED (back to visit_scheduling, capped by negotiationCap).
    // Without this, an outage would repeat the counter-time question forever.
    if ((llmDown || parsed.event.type === 'STAY') && session.state === 'time_confirm') {
      if (detectRejection(text)) parsed.event = { type: 'TIME_REJECTED' };
      else if (detectAgreement(text)) parsed.event = { type: 'TIME_ACCEPTED' };
    }
    // Owner check in flight, but the client changed their mind about the time —
    // deterministic (event-independent, like the visit_scheduling override) so
    // the ping-pong survives any LLM mood: a rejection ("не можам во 18:00",
    // "може покасно?") goes back to collecting a NEW concrete time; a NEW
    // concrete time ("MOZAM VO 19:00") re-asks the owner with it. Deliberate
    // events (ESCALATE, REJECTED) are respected.
    if (session.state === 'owner_checking'
      && parsed.event.type !== 'ESCALATE'
      && parsed.event.type !== 'REJECTED') {
      if (detectTimeRejection(text)) {
        parsed.event = { type: 'TIME_REJECTED' };
      } else {
        const t = detectVisitTime(text);
        if (t) parsed.event = { type: 'VISIT_TIME_PROVIDED', visitTime: t };
      }
    }
    return parsed;
  }
}
