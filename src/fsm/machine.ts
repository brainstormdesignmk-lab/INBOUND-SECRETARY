// THE FUNNEL, FORMALIZED. Every rule from the Google Studio prototype is a
// transition, a guard, or a legality flag. The LLM can never skip a phase.
// v2: visit-scheduling sub-funnel (fee -> contact -> time -> owner check -> confirm).
export type Service = 'buy' | 'rent';

export type State =
  | 'idle' | 'intent' | 'discovery' | 'property_query' | 'presentation'
  | 'closing' | 'contact_collection' | 'visit_scheduling' | 'owner_checking'
  | 'time_confirm' | 'pending' | 'queued' | 'escalated' | 'terminated';

export type EventType =
  | 'INTENT_DECLARED' | 'PROPERTY_ID_REQUESTED' | 'DETAILS_PROVIDED'
  | 'SEARCH_REQUESTED' | 'INTERESTED' | 'REJECTED' | 'FEE_AGREED'
  | 'FEE_REFUSED' | 'VISIT_TIME_PROVIDED' | 'OWNER_OK' | 'OWNER_COUNTER'
  | 'OWNER_UNAVAILABLE' | 'TIME_ACCEPTED' | 'TIME_REJECTED'
  | 'CONTACT_PROVIDED' | 'CONTACT_INCOMPLETE' | 'ESCALATE' | 'RESOLVED'
  | 'TIMEOUT' | 'RESET' | 'STAY';

export interface Event {
  type: EventType;
  service?: Service;
  location?: string;
  bedrooms?: number;
  sqm?: number;             // commercial space — size instead of bedrooms
  business?: boolean;       // деловен простор / канцеларија / локал
  house?: boolean;          // куќа — a residential request that is NOT a стан
  budget?: string;
  propertyId?: number;      // = Евидентен број (EB)
  visitTime?: string;       // free-text time proposed by the client
  name?: string;
  phone?: string;
  reason?: string;
  ownerStatus?: 'ok' | 'counter' | 'gone';   // from OwnerAgent
  ownerTime?: string;                          // owner's counter-proposal
  note?: string;
}

// State table. Missing event = illegal -> STAY in current state.
const T: Record<State, Partial<Record<EventType, State>>> = {
  // Lina is inbound: the CLIENT sends the first message. A search/details on
  // the first message must not dead-end in idle (where the LLM could invent
  // availability) — route it into discovery so Lina asks for the missing
  // details (service, bedrooms, budget) before any search runs.
  idle: {
    INTENT_DECLARED: 'discovery',
    PROPERTY_ID_REQUESTED: 'property_query',
    SEARCH_REQUESTED: 'discovery',
    DETAILS_PROVIDED: 'discovery',
    STAY: 'idle',
  },
  intent: {
    INTENT_DECLARED: 'discovery',
    PROPERTY_ID_REQUESTED: 'property_query',
    SEARCH_REQUESTED: 'discovery',
    DETAILS_PROVIDED: 'discovery',
    STAY: 'intent',
  },
  // ESCALATE is legal from every conversational state: a client can ask for a
  // manager at any point (prototype NEEDS_MANAGER_ASSISTANCE), not only after pending.
  discovery: {
    DETAILS_PROVIDED: 'discovery',
    SEARCH_REQUESTED: 'presentation',
    PROPERTY_ID_REQUESTED: 'property_query',
    ESCALATE: 'escalated',
    STAY: 'discovery',
  },
  // Rejections never restart discovery — they pull the NEXT batch of
  // alternatives (same area first, then other areas), always 2 at a time.
  property_query: {
    INTERESTED: 'closing',
    REJECTED: 'presentation',          // "не сакам ова" -> next closest options
    SEARCH_REQUESTED: 'presentation',  // "што има во X?" -> alternatives for X
    DETAILS_PROVIDED: 'presentation',  // "друго помало во X" -> alternatives for X
    PROPERTY_ID_REQUESTED: 'property_query',
    ESCALATE: 'escalated',
    STAY: 'property_query',
  },
  presentation: {
    INTERESTED: 'closing',
    REJECTED: 'presentation',          // next batch of 2 (until exhausted)
    PROPERTY_ID_REQUESTED: 'property_query',
    ESCALATE: 'escalated',
    STAY: 'presentation',
  },
  closing: {
    FEE_AGREED: 'contact_collection',   // fee OK -> collect name+phone
    FEE_REFUSED: 'closing',             // 1st/2nd refusal -> persuasion; 3rd -> 'queued' (pipeline guard)
    REJECTED: 'presentation',           // "не го сакам овој стан" -> next options
    PROPERTY_ID_REQUESTED: 'property_query',
    ESCALATE: 'escalated',
    STAY: 'closing',
  },
  contact_collection: {
    CONTACT_PROVIDED: 'visit_scheduling', // name+phone -> ask preferred time
    CONTACT_INCOMPLETE: 'contact_collection',
    REJECTED: 'discovery',
    PROPERTY_ID_REQUESTED: 'property_query',
    ESCALATE: 'escalated',
    STAY: 'contact_collection',
  },
  visit_scheduling: {
    VISIT_TIME_PROVIDED: 'owner_checking', // "ќе Ве известам штом потврдам" + owner event fired
    REJECTED: 'discovery',
    ESCALATE: 'escalated',
    STAY: 'visit_scheduling',
  },
  owner_checking: {
    OWNER_OK: 'pending',          // -> assign agent + code-built confirmation
    OWNER_COUNTER: 'time_confirm',// relay owner's time to client
    OWNER_UNAVAILABLE: 'presentation', // sold/rented -> honest message + alternatives
    ESCALATE: 'escalated',
    STAY: 'owner_checking',       // client messages while waiting -> patience line
  },
  time_confirm: {
    TIME_ACCEPTED: 'pending',
    TIME_REJECTED: 'visit_scheduling', // loop, capped by pipeline (negotiationCap)
    ESCALATE: 'escalated',
    STAY: 'time_confirm',
  },
  pending: { RESET: 'idle', TIMEOUT: 'idle', ESCALATE: 'escalated', STAY: 'pending' },
  queued: { RESET: 'idle', TIMEOUT: 'idle', STAY: 'queued' }, // graceful close after 3rd fee refusal
  escalated: { RESOLVED: 'pending', ESCALATE: 'escalated', STAY: 'escalated' },
  terminated: { RESET: 'idle', STAY: 'terminated' },
};

// Legality flags per state. Used by the responder guard and the sim assertions.
export const LEGAL: Record<State, { fee: boolean; maxProps: number }> = {
  idle: { fee: false, maxProps: 0 },
  intent: { fee: false, maxProps: 0 },
  discovery: { fee: false, maxProps: 0 },
  property_query: { fee: false, maxProps: 1 },
  presentation: { fee: false, maxProps: 2 },
  closing: { fee: true, maxProps: 1 },
  contact_collection: { fee: true, maxProps: 1 },
  visit_scheduling: { fee: true, maxProps: 1 },
  owner_checking: { fee: true, maxProps: 1 },
  time_confirm: { fee: true, maxProps: 1 },
  pending: { fee: true, maxProps: 0 },
  queued: { fee: false, maxProps: 0 },
  escalated: { fee: false, maxProps: 0 },
  terminated: { fee: false, maxProps: 0 },
};

export function transition(current: State, ev: Event): State {
  const next = T[current]?.[ev.type];
  if (!next) return current;
  return next;
}

export function isFeeAllowed(s: State): boolean {
  return LEGAL[s]?.fee ?? false;
}

export function maxProperties(s: State): number {
  return LEGAL[s]?.maxProps ?? 0;
}

export function isValidEvent(t: string): t is EventType {
  return ['INTENT_DECLARED','PROPERTY_ID_REQUESTED','DETAILS_PROVIDED','SEARCH_REQUESTED',
          'INTERESTED','REJECTED','FEE_AGREED','FEE_REFUSED','VISIT_TIME_PROVIDED',
          'OWNER_OK','OWNER_COUNTER','OWNER_UNAVAILABLE','TIME_ACCEPTED','TIME_REJECTED',
          'CONTACT_PROVIDED','CONTACT_INCOMPLETE','ESCALATE','RESOLVED','TIMEOUT','RESET','STAY']
    .includes(t);
}
