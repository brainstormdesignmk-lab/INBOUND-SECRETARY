import { AppConfig } from '../config';
import { Db } from '../store/db';
import {
  ChatSession, SessionStore, freshSession, isExpired, resetToIdle,
  touchInbound, touchOutbound, canSend, pushHistory, buildGreeting,
} from '../fsm/session';
import { transition, Event } from '../fsm/machine';
import { Classifier } from '../llm/classify';
import { Responder } from '../llm/respond';
import { PropertyService, Property, normalizeLocation } from '../data/properties';
import { AppointmentStore } from '../store/appointments';
import { EscalationStore } from '../store/escalations';
import { MetaStore } from '../store/meta';
import { OwnerStore } from '../store/owners';
import { AgentStore } from '../store/agents';
import { CustomerStore } from '../store/customers';
import { EventStore } from '../store/events';
import { ChannelRegistry } from '../channels/types';
import { applyStrike, OFFENSE_WARNINGS } from '../antiabuse/strikes';
import { OwnerAgent, DeferredOwnerAgent, LocalOwnerAgent, OwnerVerdict } from '../backoffice/ownerAgent';
import { AgentDispatcher } from '../backoffice/agentDispatcher';
import {
  serviceLabel, VISIT_TIME_QUESTION, OWNER_CHECK_ACK, PATIENCE_LINE,
  FEE_GRACEFUL_CLOSE, buildVisitConfirmation, feePersuasion, FALLBACKS,
  NO_MATCH_LINE, PROPERTY_NOT_FOUND_LINE, FEED_UNAVAILABLE_LINE,
  NO_MORE_ALTERNATIVES_LINE,
} from '../llm/prompts';

const NON_TEXT_REPLY = 'Ве молам, испратете ми текстуална порака за да можам да Ви помогнам.';
const QUEUED_STAY_LINE = 'Вашите критериуми се забележани. Ќе Ве контактирам штом најдам соодветен имот.';
const OWNER_COUNTER_RELAY = (t: string) =>
  `Сопственикот е достапен, но предложи поинаков термин: ${t}. Дали овој термин Ви одговара?`;
const OWNER_GONE_REPLY = (eb: number, note: string) =>
  `За жал, имотот со Евидентен број ${eb} ${note}. Дозволете ми да проверам што друго имаме што одговара на Вашите критериуми.`;

export interface HandleOpts {
  kind?: 'text' | 'other';
  senderName?: string;
}

export interface HandlerDeps {
  cfg: AppConfig;
  db: Db;
  sessions: SessionStore;
  classifier: Classifier;
  responder: Responder;
  properties: PropertyService;
  appointments: AppointmentStore;
  escalations: EscalationStore;
  meta: MetaStore;
  channels: ChannelRegistry;
}

export class InboundHandler {
  readonly ownerAgent: OwnerAgent;
  readonly agents: AgentStore;
  readonly customers: CustomerStore;
  readonly events: EventStore;
  readonly dispatcher: AgentDispatcher;

  private chains = new Map<string, Promise<void>>();

  constructor(private deps: HandlerDeps) {
    this.agents = new AgentStore(deps.db);
    this.agents.ensureDefault(deps.cfg.agentDefaultPhone);
    this.customers = new CustomerStore(deps.db);
    this.events = new EventStore(deps.db);
    const owners = new OwnerStore(deps.db);
    this.dispatcher = new AgentDispatcher(this.agents);
    this.ownerAgent = deps.cfg.ownerAgentMode === 'local'
      ? new LocalOwnerAgent(owners, this.events)
      : new DeferredOwnerAgent(owners, this.events, deps.cfg.ownerCheckTimeoutMinutes * 60_000);
  }

  private get cfg(): AppConfig {
    return this.deps.cfg;
  }

  // Per-chat serialized queue: preserves order inside one chat, parallel across chats.
  private enqueue(chatId: string, fn: () => Promise<void>): Promise<void> {
    const prev = this.chains.get(chatId) ?? Promise.resolve();
    const next = prev.then(fn).catch(e => console.error('[pipeline]', chatId, (e as Error).message));
    this.chains.set(chatId, next);
    return next;
  }

  /** Viber conversation_started: welcome greeting (user-initiated, so allowed). */
  startConversation(channel: string, chatId: string, senderName?: string): Promise<void> {
    return new Promise(resolve => {
      this.enqueue(chatId, async () => {
        void senderName;
        let session = this.deps.sessions.get(chatId);
        if (session && session.history.length > 0) return; // already chatting — stay silent
        if (!session) session = freshSession(channel, chatId);
        session.channel = channel;
        session.state = 'idle';
        const greeting = buildGreeting(session);
        pushHistory(session, { role: 'assistant', text: greeting }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, greeting);
      }).then(resolve);
    });
  }

  handle(channel: string, chatId: string, text: string, opts: HandleOpts = {}): Promise<void> {
    return new Promise(resolve => {
      this.enqueue(chatId, () => this.processMessage(channel, chatId, text, opts)).then(resolve);
    });
  }

  // ---------------- main message path ----------------

  private async processMessage(channel: string, chatId: string, text: string, opts: HandleOpts): Promise<void> {
    let session = this.deps.sessions.get(chatId) ?? freshSession(channel, chatId);
    session.channel = channel;

    if (session.state === 'terminated') {
      if (isExpired(session, this.cfg.chatTtlMinutes)) {
        resetToIdle(session);
        this.deps.sessions.set(session);
      }
      return; // absolute silence
    }

    if (isExpired(session, this.cfg.chatTtlMinutes)) resetToIdle(session);

    if (session.resetGreeting) {
      session.resetGreeting = false;
      touchInbound(session);
      const greeting = buildGreeting(session);
      pushHistory(session, { role: 'assistant', text: greeting }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, greeting);
      return;
    }

    touchInbound(session);

    if (opts.kind !== undefined && opts.kind !== 'text') {
      pushHistory(session, { role: 'user', text: '[non-text message]' }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: NON_TEXT_REPLY }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, NON_TEXT_REPLY);
      return;
    }

    // 1) Cold-brained intent extraction (Groq, JSON mode)
    const classified = await this.deps.classifier.classify(session, text);

    // 2) 3-strikes protocol
    const outcome = applyStrike(session, classified);
    if (outcome !== 'none') {
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      if (outcome === 'terminate') {
        session.state = 'terminated';
        session.terminatedAt = Date.now();
        this.deps.sessions.set(session);
        console.error(`[EVENT] TERMINATE_SESSION ${JSON.stringify({ chatId, channel, strikes: session.strikes })}`);
        return; // ZERO OUTPUT — the sim asserts this
      }
      const warning = OFFENSE_WARNINGS[session.strikes] ?? OFFENSE_WARNINGS[2];
      pushHistory(session, { role: 'assistant', text: warning }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, warning);
      return;
    }

    // 3) Slots + FSM transition
    const ev = classified.event;
    this.applySlots(session, ev);
    const before = session.state;
    let next = transition(before, ev);

    if (before === 'discovery' && ev.type === 'DETAILS_PROVIDED' && this.slotsComplete(session)) {
      next = 'presentation';
    }
    if (before === 'discovery' && ev.type === 'SEARCH_REQUESTED' && !this.slotsComplete(session)) {
      next = 'discovery';
    }
    // A FIRST message with the full criteria set (service+location+bedrooms+budget)
    // skips discovery entirely — "сакам стан во Центар, 2 спални, до 80.000 евра"
    // goes straight to presentation without asking anything.
    if (before === 'idle'
      && (ev.type === 'SEARCH_REQUESTED' || ev.type === 'DETAILS_PROVIDED')
      && this.slotsComplete(session)) {
      next = 'presentation';
    }
    if (ev.type === 'INTERESTED') {
      if (ev.propertyId) session.slots.interestedPropertyId = ev.propertyId;
      else if (session.slots.propertyId) session.slots.interestedPropertyId = session.slots.propertyId;
      else if (session.slots.currentBatch?.length) session.slots.interestedPropertyId = session.slots.currentBatch[0];
      else if (session.slots.presentedIds?.length) session.slots.interestedPropertyId = session.slots.presentedIds[0];
    }
    if (ev.type === 'FEE_AGREED') session.slots.viewingFeeAgreed = true;

    // Fee refusal ladder (deterministic, in closing only)
    if (ev.type === 'FEE_REFUSED' && before === 'closing') {
      session.slots.feeRejections = (session.slots.feeRejections ?? 0) + 1;
      next = (session.slots.feeRejections ?? 0) >= 3 ? 'queued' : 'closing';
    }

    // Negotiation loop bound (deterministic, in time_confirm only)
    if (ev.type === 'TIME_REJECTED' && before === 'time_confirm') {
      session.slots.negotiationCount = (session.slots.negotiationCount ?? 0) + 1;
      if (session.slots.negotiationCount >= this.cfg.negotiationCap) next = 'escalated';
    }

    session.state = next;

    // Post-transition side effects
    if (next === 'queued') this.queueCustomer(session, '3x одбиен надомест');
    if (next === 'escalated') this.raiseEscalation(session, text);

    // 4) Property context (responder only needs it for LLM-driven states)
    const props = await this.loadProps(session);

    // 5) Reply strategy — deterministic where exactness matters
    pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);

    // Client accepted the owner's counter-time -> code-built confirmation
    if (next === 'pending' && before === 'time_confirm') {
      const eb = session.slots.interestedPropertyId ?? session.slots.propertyId ?? 0;
      const time = session.slots.ownerTime ?? session.slots.visitTime ?? '';
      await this.confirmVisit(session, eb, time);
      return;
    }

    let reply: string;
    if (next === 'queued') {
      reply = FEE_GRACEFUL_CLOSE;
    } else if (before === 'closing' && ev.type === 'FEE_REFUSED') {
      reply = feePersuasion(session.slots.service, session.slots.feeRejections ?? 1);
    } else if (next === 'visit_scheduling') {
      reply = VISIT_TIME_QUESTION;
    } else if (next === 'owner_checking') {
      reply = OWNER_CHECK_ACK;
      const eb = session.slots.interestedPropertyId ?? session.slots.propertyId ?? 0;
      const t = session.slots.visitTime ?? '';
      if (eb && t) void this.runOwnerCheck(session, eb, t);
    } else if (next === 'escalated') {
      reply = FALLBACKS.escalated ?? 'Ќе Ве контактира менаџер.';
    } else if (session.state === 'owner_checking') {
      reply = PATIENCE_LINE; // client wrote while owner check is in flight
    } else if (session.state === 'queued') {
      reply = QUEUED_STAY_LINE;
    } else if (next === 'presentation' && props.length === 0) {
      // Deterministic empty-result lines — never let the LLM invent properties.
      // First search with an empty feed -> no-match; follow-up rejections after
      // every candidate was shown -> honest "exhausted" line.
      reply = !this.deps.properties.healthy
        ? FEED_UNAVAILABLE_LINE
        : (before === 'discovery'
          ? NO_MATCH_LINE(session.slots.location)
          : NO_MORE_ALTERNATIVES_LINE(session.slots.location));
    } else if (next === 'property_query' && props.length === 0) {
      reply = this.deps.properties.healthy
        ? PROPERTY_NOT_FOUND_LINE(session.slots.propertyId ?? 0)
        : FEED_UNAVAILABLE_LINE;
    } else {
      reply = await this.deps.responder.respond(session, props, text);
    }

    pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
    this.deps.sessions.set(session);
    await this.sendRaw(session, reply);
  }

  // ---------------- owner check continuation ----------------

  private async runOwnerCheck(session: ChatSession, eb: number, proposedTime: string): Promise<void> {
    try {
      const verdict = await this.ownerAgent.check(session.chatId, eb, proposedTime);
      this.enqueue(session.chatId, () => this.applyOwnerVerdict(session.chatId, eb, verdict));
    } catch (e) {
      console.error('[owner] check failed:', (e as Error).message);
    }
  }

  private async applyOwnerVerdict(chatId: string, eb: number, verdict: OwnerVerdict): Promise<void> {
    const session = this.deps.sessions.get(chatId);
    if (!session || session.state !== 'owner_checking') return; // stale/reset — drop

    if (verdict.status === 'ok') {
      session.state = 'pending';
      session.slots.ownerTime = verdict.ownerTime ?? session.slots.visitTime;
      await this.confirmVisit(session, eb, session.slots.ownerTime ?? '');
      return;
    }

    if (verdict.status === 'counter') {
      session.state = 'time_confirm';
      session.slots.ownerTime = verdict.ownerTime;
      const reply = OWNER_COUNTER_RELAY(verdict.ownerTime ?? 'по договор со сопственикот');
      pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, reply);
      return;
    }

    // gone (sold / rented / under option)
    session.state = 'presentation';
    session.slots.soldEb = eb; // exclude from alternatives
    const note = verdict.note ? `е ${verdict.note}` : 'веќе не е достапен';
    const reply = OWNER_GONE_REPLY(eb, note);
    pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
    this.deps.sessions.set(session);
    await this.sendRaw(session, reply);
  }

  /** Agent assignment (quota-balanced) + code-built confirmation + persistence. */
  private async confirmVisit(session: ChatSession, eb: number, time: string): Promise<void> {
    const agent = this.dispatcher.pick(session.slots.service ?? 'buy');
    const agentPhone = agent?.phone ?? this.cfg.agentDefaultPhone;
    const agentName = agent?.name ?? 'Агент';
    session.slots.agentName = agentName;
    session.slots.agentPhone = agentPhone;

    const reply = buildVisitConfirmation(eb, time, agentPhone);
    pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
    this.deps.sessions.set(session);

    if (agent) this.dispatcher.recordVisit(agent.id, session.slots.service ?? 'buy');
    const apptId = this.finalizeAppointment(session, time);
    this.events.insert('agent_assigned', session.chatId, eb, {
      agentId: agent?.id ?? null, agentPhone, time,
    });
    this.events.insert('visit_confirmed', session.chatId, eb, {
      appointmentId: apptId, time, agentPhone,
      customerName: session.slots.name ?? '', customerPhone: session.slots.phone ?? '',
    });
    this.promoteCustomer(session);

    await this.sendRaw(session, reply);
  }

  // ---------------- side-effect helpers ----------------

  private finalizeAppointment(session: ChatSession, time?: string): number {
    const fee = session.slots.service === 'rent' ? '300 MKD' : '600 MKD';
    const propertyId = session.slots.interestedPropertyId ?? session.slots.propertyId ?? 0;
    const rowId = this.deps.appointments.insert({
      chatId: session.chatId,
      clientName: session.slots.name ?? 'Непознат клиент',
      clientPhone: session.slots.phone ?? 'Непознат телефон',
      propertyId,
      service: serviceLabel(session.slots.service),
      viewingFee: fee,
      time: time ?? null,
    });
    console.log(`[EVENT] APPOINTMENT_PENDING ${JSON.stringify({
      id: rowId, chatId: session.chatId,
      clientName: session.slots.name, clientPhone: session.slots.phone,
      propertyId, service: serviceLabel(session.slots.service), viewingFee: fee, time,
    })}`);
    return rowId;
  }

  private queueCustomer(session: ChatSession, reason: string): void {
    const id = this.customers.upsert({
      chatId: session.chatId,
      phone: session.slots.phone,
      name: session.slots.name,
      service: serviceLabel(session.slots.service),
      location: session.slots.location,
      bedrooms: session.slots.bedrooms,
      budget: session.slots.budget,
      refusedEb: session.slots.interestedPropertyId ?? session.slots.propertyId,
      reason,
    });
    this.events.insert('customer_reengage', session.chatId, null, { customerId: id });
    console.log(`[EVENT] CUSTOMER_QUEUED ${JSON.stringify({ id, chatId: session.chatId, reason })}`);
  }

  private promoteCustomer(session: ChatSession): void {
    const existing = this.customers.getByChat(session.chatId);
    if (existing) this.customers.upsert({ chatId: session.chatId }, 'client');
  }

  private raiseEscalation(session: ChatSession, lastText: string): void {
    const history = [...session.history, { role: 'user' as const, text: lastText }];
    const rowId = this.deps.escalations.insert({
      chatId: session.chatId,
      customer: session.slots.name ?? 'Непознат клиент',
      history: JSON.stringify(history),
    });
    console.log(`[EVENT] NEEDS_MANAGER_ASSISTANCE ${JSON.stringify({
      id: rowId, chatId: session.chatId, customer: session.slots.name ?? 'Непознат клиент',
    })}`);
  }

  // ---------------- slots / props ----------------

  private applySlots(session: ChatSession, ev: Event): void {
    if (ev.service) session.slots.service = ev.service;
    // Clients type Latin ("centar", "kapistec"); canonicalize to Cyrillic so
    // replies and the deterministic no-match lines read naturally.
    if (ev.location) session.slots.location = normalizeLocation(ev.location);
    if (ev.bedrooms) session.slots.bedrooms = ev.bedrooms;
    if (ev.budget) session.slots.budget = ev.budget;
    if (ev.propertyId) session.slots.propertyId = ev.propertyId;
    if (ev.visitTime) session.slots.visitTime = ev.visitTime;
    if (ev.name) session.slots.name = ev.name;
    if (ev.phone) session.slots.phone = ev.phone;
  }

  private slotsComplete(s: ChatSession): boolean {
    return !!s.slots.service && !!s.slots.location && !!s.slots.bedrooms && !!s.slots.budget;
  }

  private async loadProps(session: ChatSession): Promise<Property[]> {
    const s = session.state;
    if (s === 'property_query') {
      const id = session.slots.propertyId;
      if (!id) return [];
      const p = await this.deps.properties.getById(id);
      return p ? [p] : [];
    }
    if (s === 'presentation') {
      // Alternatives engine: every presentation shows the NEXT 2 candidates —
      // same area first (price-closest to budget), then other areas — and every
      // shown EB is excluded from later batches. Never re-asks discovery.
      const shown = session.slots.presentedIds ?? [];
      if (session.slots.propertyId) shown.push(session.slots.propertyId); // already discussed
      if (session.slots.soldEb) shown.push(session.slots.soldEb);
      const candidates = await this.deps.properties.candidates({
        location: session.slots.location,
        bedrooms: session.slots.bedrooms,
        service: session.slots.service,
        budget: session.slots.budget,
        exclude: shown,
      });
      const batch = candidates.slice(0, 2);
      session.slots.presentedIds = [...shown, ...batch.map(p => p.id)];
      session.slots.currentBatch = batch.map(p => p.id);
      session.slots.alternativesExhausted = candidates.length === 0;
      return batch;
    }
    if (['closing', 'contact_collection', 'visit_scheduling', 'owner_checking', 'time_confirm'].includes(s)) {
      const id = session.slots.interestedPropertyId ?? session.slots.propertyId;
      if (!id) return [];
      const p = await this.deps.properties.getById(id);
      return p ? [p] : [];
    }
    return [];
  }

  // ---------------- outbound ----------------

  private async sendRaw(session: ChatSession, text: string): Promise<void> {
    if (!canSend(session)) {
      console.error(`[budget] ${session.channel} 100/hr per-chat limit reached for ${session.chatId} — send dropped`);
      return;
    }
    if (this.deps.meta.get('monthly_initiated') >= this.cfg.monthlyInitiatedLimit) {
      console.error('[budget] monthly initiated-message limit reached — send blocked');
      return;
    }
    touchOutbound(session);
    this.deps.meta.increment('monthly_initiated');
    await this.deps.channels.send(session.channel, session.chatId, text);
  }
}
