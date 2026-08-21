import { State, Service } from './machine';
import { randomGreeting } from '../data/greetings';
import { Db } from '../store/db';

export interface SlotData {
  service?: Service;
  location?: string;
  bedrooms?: number;
  sqm?: number;                 // commercial (деловен простор) — size instead of bedrooms
  business?: boolean;           // commercial property intent
  house?: boolean;              // куќа — a residential request that is NOT a стан
  budget?: string;
  anywhere?: boolean;           // "било каде" — no location preference (satisfies location)
  propertyId?: number;          // EB of the property currently discussed
  interestedPropertyId?: number;
  presentedIds?: number[];      // ALL EBs shown so far (excluded from later batches)
  currentBatch?: number[];      // EBs in the CURRENT presentation batch
  alternativesExhausted?: boolean;
  areaExhausted?: boolean;      // the selected area(s) are drained and Lina ASKED
                                // whether to widen — agreement releases the lock
  name?: string;
  phone?: string;
  viewingFeeAgreed?: boolean;
  // v2 — visit sub-funnel
  visitTime?: string;           // client's proposed time (free text)
  ownerTime?: string;           // owner's counter-proposal (from OwnerAgent)
  feeRejections?: number;       // 1..3; 3 = graceful close + customer queued
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
  queueAfterContact?: boolean;  // exhausted-options flow: collect contact, then queue
  ownerContactPending?: boolean; // availability ack sent — waiting for client to confirm they WANT owner contact (fee comes AFTER this)
  nearbyLandmarks?: string[];     // top-3 nearby landmark names for rotation ("каде?" → first, "каде поточно?" → second, …)
  nearbyLandmarkCoords?: Array<{ lat: number; lon: number }>; // parallel coords for Google Maps links
  landmarkIndex?: number;         // how many landmarks have been revealed so far
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
  s.state = 'idle';
  s.slots = {};
  s.strikes = 0;
  s.history = [];
  s.returnState = undefined;
  s.terminatedAt = undefined;
  s.resetGreeting = true; // next inbound gets a fresh greeting (prototype resetSession)
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
