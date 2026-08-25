import { AppConfig } from '../config';
import { Db } from '../store/db';
import {
  ChatSession, SessionStore, freshSession, isExpired, resetToIdle,
  touchInbound, touchOutbound, canSend, pushHistory, buildGreeting, assistantTexts,
} from '../fsm/session';
import { pickVariant, noMatchLine, exhaustedLine, fallbackVariant } from '../data/responseBank';
import { transition, Event } from '../fsm/machine';
import { Classifier } from '../llm/classify';
import { Responder } from '../llm/respond';
import { PropertyService, Property, normalizeLocation, locMatches } from '../data/properties';
import { detectAgreement, detectWidenIntent, detectLocation, detectWhereIs, detectExactAddressAsk, isKadeTocno, detectOwnerContact, detectSeeOffers, detectAvailabilityAsk, detectFeeWhy, detectSuggestAlternatives, detectOfftopic, detectDefer, detectNegotiate, detectProvisionAsk, detectSchedulingFlex, detectEscalation, detectDocumentsAsk, detectMortgageAsk, detectNeighborhoodAsk, detectComparison, detectFeatureAsk, detectVisitCancellation, detectPropertyInterest, detectPropertyDescription, detectVisitInterest, detectBothServices, detectService, extractSlots } from '../llm/deterministic';
import { AppointmentStore } from '../store/appointments';
import { EscalationStore } from '../store/escalations';
import { MetaStore } from '../store/meta';
import { OwnerStore } from '../store/owners';
import { AgentStore } from '../store/agents';
import { CustomerStore } from '../store/customers';
import { EventStore } from '../store/events';
import { PriceChangeStore } from '../store/priceChanges';
import { BlocklistStore } from '../store/blocklist';
import { ChannelRegistry } from '../channels/types';
import { applyStrike, OFFENSE_WARNINGS, detectOffensive } from '../antiabuse/strikes';
import { OwnerAgent, DeferredOwnerAgent, LocalOwnerAgent, OwnerVerdict } from '../backoffice/ownerAgent';
import { AgentDispatcher } from '../backoffice/agentDispatcher';
import { LandmarkService } from '../geo/landmarks';
import { VisitScheduler } from '../visits/scheduler';
import {
  serviceLabel,  VISIT_TIME_QUESTION, OWNER_CHECK_ACK, PATIENCE_LINE,
  FEE_GRACEFUL_CLOSE, QUEUED_CONFIRM, buildVisitConfirmation, buildContactAsk,
  buildOwnerAsk, buildWhereIsAnswer, feePersuasion, FALLBACKS, NO_MATCH_LINE,
  PROPERTY_NOT_FOUND_LINE, FEED_UNAVAILABLE_LINE, NO_MORE_ALTERNATIVES_LINE,
  LAST_INFO_PREFIX, DIRECTION_PIVOT_LINE, LOCATE_FIRST_ASK, LOCATE_DETAILS_ASK,
  LOCATE_NUMBER_PROMPT, LOCATE_REFINE_ASK, buildLocateMatches,
  AVAILABILITY_ACK, buildPriceRelay, buildFeeAsk, buildFeeWhy,
  buildFeePivotNeighborhood, buildPropertyCard, buildPropertyCards, pickCloser, PRESENTATION_CLOSERS_ALL,
  buildExactAddressAnswer,
  OFFTOPIC_REDIRECT, FOLLOWUP_DEFER, PRICE_NEGOTIATE, PROVISION_ANSWER,
  SCHED_FLEX_ANSWER, ESCALATION_ANSWER, DOCUMENTS_ANSWER, MORTGAGE_ANSWER,
  NEIGHBORHOOD_ANSWER, COMPARISON_ANSWER, FEATURE_ANSWER,
} from '../llm/prompts';

const NON_TEXT_REPLY = 'Ве молам, испратете ми текстуална порака за да можам да Ви помогнам.';
const QUEUED_STAY_LINE = 'Вашите критериуми се забележани. Ќе Ве контактирам штом најдам соодветен имот.';
const OWNER_COUNTER_RELAY = (t: string) =>
  `Сопственикот е достапен, но предложи поинаков термин: ${t}. Дали овој термин Ви одговара?`;
// The owner CAN'T do the client's proposed time and gave NO alternative. Lina
// must never fabricate a term ("по договор со сопственикот" was relayed as a
// fake proposal the client was asked to accept — and an accept then fell back
// to the REFUSED time). Relay the refusal honestly and ask for another time;
// the new time re-asks the owner (the healthy ping-pong keeps looping).
const OWNER_CANT_TIME_RELAY = (t: string) =>
  `Сопственикот не може во тој термин (${t}). ${VISIT_TIME_QUESTION}`;
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
  /** Approximate-location resolver (address privacy). Defaults to the DB-only
   *  service (deterministic table layer) when not supplied. */
  landmarks?: LandmarkService;
  /** Visit-protocol scheduler (turns 2+3). Optional: without it the arranged
   *  message is skipped and only the client confirmation goes out. */
  visits?: VisitScheduler;
  /** Enrichment queue — stores LLM-backed responses for the midnight cron
   *  that generates bank variants. Optional: without it, the queue is silent. */
  enrichment?: import('../store/enrichment').EnrichmentStore;
}

export class InboundHandler {
  readonly ownerAgent: OwnerAgent;
  readonly agents: AgentStore;
  readonly customers: CustomerStore;
  readonly events: EventStore;
  readonly priceChanges: PriceChangeStore;
  readonly appointments: AppointmentStore;
  readonly dispatcher: AgentDispatcher;
  readonly landmarks: LandmarkService;
  readonly visits?: VisitScheduler;
  readonly owners: OwnerStore;
  readonly blocklist: BlocklistStore;

  /** Fired when Lina asks the OWNER about availability (owner_checking). The
   *  TUI renders this in the owner panel; Hermes consumes the same question
   *  from the owner_check_requested event in phase 2. */
  onOwnerAsk?: (chatId: string, eb: number, question: string) => void;

  private chains = new Map<string, Promise<void>>();

  constructor(private deps: HandlerDeps) {
    this.agents = new AgentStore(deps.db);
    this.agents.ensureDefault(deps.cfg.agentDefaultPhone);
    this.customers = new CustomerStore(deps.db);
    this.events = new EventStore(deps.db);
    this.blocklist = new BlocklistStore(deps.db);
    this.priceChanges = new PriceChangeStore(deps.db);
    this.appointments = deps.appointments;
    this.owners = new OwnerStore(deps.db);
    this.dispatcher = new AgentDispatcher(this.agents);
    this.landmarks = deps.landmarks ?? new LandmarkService(deps.db);
    this.visits = deps.visits;
    this.ownerAgent = deps.cfg.ownerAgentMode === 'local'
      ? new LocalOwnerAgent(this.owners, this.events)
      : new DeferredOwnerAgent(this.owners, this.events, deps.cfg.ownerCheckTimeoutMinutes * 60_000, deps.cfg.ownerBusPollMs);
  }

  private get cfg(): AppConfig {
    return this.deps.cfg;
  }

  /** Real Viber: the sender id IS the caller's phone number. Lina must KNOW the
   *  number that is contacting her — prefill it once so the contact step only
   *  collects the name and the appointment records the real number. */
  private prefillViberPhone(session: ChatSession, channel: string, chatId: string): void {
    if (!session.slots.phone && channel === 'viber' && /^\d{8,15}$/.test(chatId)) {
      session.slots.phone = chatId;
    }
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
        if (this.blocklist.isBlocked(chatId)) return;       // strike-3 blocked — no greeting either
        if (!session) session = freshSession(channel, chatId);
        session.channel = channel;
        this.prefillViberPhone(session, channel, chatId);
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

    // Persistent blocklist (strike-3, ANA parity): checked BEFORE the TTL reset
    // so a blocked chat can never be resurrected by expiry. Phone-backed only —
    // synthetic TUI/sim chatIds block nothing.
    if (this.blocklist.isBlocked(chatId, session.slots.phone)) return;

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
    this.prefillViberPhone(session, channel, chatId);

    if (opts.kind !== undefined && opts.kind !== 'text') {
      pushHistory(session, { role: 'user', text: '[non-text message]' }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: NON_TEXT_REPLY }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, NON_TEXT_REPLY);
      return;
    }

    // 0) Insult protocol (3 strikes, ANA parity): the DETERMINISTIC lexicon
    // scan runs BEFORE any other processing — an insult is a strike no matter
    // which brain is live (even the LLM-free path, where "DA SE EBETE VO
    // GAZOT" used to slip through as an agreement and close the deal). All
    // offenses escalate equally: 1 = warning, 2 = final warning, 3 = terminate
    // + permanent blocklist. Strike 1 decays on the next clean message; strike
    // 2 never decays. applyStrike is called on EVERY message (offenses strike,
    // clean messages decay).
    const offense = detectOffensive(text);
    const outcome = applyStrike(session, offense);
    if (outcome !== 'none') {
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      if (outcome === 'terminate') {
        this.blocklist.add(chatId, offense.category ?? 'offensive_behavior', session.slots.phone);
        session.state = 'terminated';
        session.terminatedAt = Date.now();
        this.deps.sessions.set(session);
        console.error(`[EVENT] TERMINATE_SESSION ${JSON.stringify({ chatId, channel, strikes: session.strikes, reason: offense.reason })}`);
        return; // ZERO OUTPUT — the sim asserts this
      }
      // Bank-backed warnings (warn.1/warn.2): same 3-strike protocol, varied
      // wording. Falls back to the exact code-built lines.
      const warning = pickVariant(`warn.${session.strikes}`, { recent: assistantTexts(session) })
        ?? OFFENSE_WARNINGS[session.strikes] ?? OFFENSE_WARNINGS[2];
      pushHistory(session, { role: 'assistant', text: warning }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, warning);
      return;
    }

    // The client asks for the EXACT street/address ("потoчно која улица?",
    // "точно која адреса?", "на која адреса е?") — address PRIVACY is
    // absolute: answered deterministically (bank-backed address.exact: "Точната
    // адреса ќе ја добиете 2 часа пред посетата"), NEVER with the street. Must
    // Explicit address demands ("кажи ми точно адреса", "дај ми ја точната адреса")
    // go to the privacy protocol. But "каде точно се наоѓа?" is a WHERE_IS question
    // that should get a nearby landmark first — only protocol if the client persists.
    // Also: "каде му е адресата?" matches EXACT_ADDRESS but is really a WHERE_IS
    // question — the client wants to know WHERE it is, not the exact address.
    // WHERE_IS takes priority: landmark rotation first, protocol on follow-ups.
    if (detectExactAddressAsk(text) && !isKadeTocno(text) && !detectWhereIs(text)) {
      const answer = buildExactAddressAnswer(assistantTexts(session));
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, answer);
      return;
    }

    // Owner contact refusal: the client asks for the owner's phone/contact.
    // The agency NEVER shares owner contacts before a visit is arranged.
    if (detectOwnerContact(text)) {
      const answer = pickVariant('owner.contact.refusal', { recent: assistantTexts(session) })
        ?? 'Контактот на сопственикот не се споделува директно. Можам да организирам посета каде ќе се сретнете со сопственикот. Дали би сакале да закажеме термин?';
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, answer);
      return;
    }

    // "каде е X?" — a question about a PLACE's whereabouts ("каде е Палома
    // Бјанка?", "каде се наоѓа тој стан?"), NEVER a search for properties IN X.
    // Answer code-built from DB facts (address/neighborhood) so it can never
    // derail into a bogus "exhausted all properties in X" reply — the classifier
    // never even sees it, so the LLM can't misread the place as a location.
    const whereIs = detectWhereIs(text);
    if (whereIs) {
      const all = await this.deps.properties.getAll();
      const shownIds = new Set(session.slots.presentedIds ?? []);
      const shown = all.filter(p => shownIds.has(p.id));
      let hit: Property | undefined;
      if (whereIs.generic) {
        // The client asks about the current property ("каде е?", "сто има во
        // близина?"). If shown[] is empty (property looked up by EB number,
        // not via presentation), fall back to the property the client is
        // currently discussing via session slots.
        hit = shown[shown.length - 1]
          ?? (session.slots.propertyId
            ? await this.deps.properties.getByEb(session.slots.propertyId)
            : undefined)
          ?? (session.slots.interestedPropertyId
            ? await this.deps.properties.getByEb(session.slots.interestedPropertyId)
            : undefined);
      } else {
        const p = whereIs.place;
        // EB number: "каде се наоѓа 89?" — look up directly by evidence number.
        const ebNum = parseInt(p, 10);
        if (Number.isFinite(ebNum) && ebNum > 0) {
          hit = await this.deps.properties.getByEb(ebNum);
        }
        if (!hit) {
          hit = [...shown, ...all].find(pr =>
            (!!pr.address && locMatches(p, pr.address)) || (!!pr.location && locMatches(p, pr.location)));
        }
      }
      let answer: string;
      if (hit) {
        // Address privacy: "каде е X?" is answered with the nearest PUBLIC
        // landmark ("во близина на City Mall"), never the street.
        await this.landmarks.enrich([hit]);
        // Pre-resolve nearby landmarks for rotation if not yet done.
        if (!session.slots.nearbyLandmarks?.length) {
          const nearby = await this.landmarks.nearbyLandmarks(hit);
          if (nearby.length > 0) {
            session.slots.nearbyLandmarks = nearby.map(n => n.landmark);
            session.slots.nearbyLandmarkCoords = nearby.map(n => ({ lat: n.lat, lon: n.lon }));
            session.slots.landmarkIndex = 0;
          }
        }
        // Rotation: L1 → L2 → L3 → Protocol → Protocol → Protocol → ...
        // Show ALL landmarks first, then privacy protocol after they're exhausted.
        const lm = session.slots.nearbyLandmarks;
        const idx = session.slots.landmarkIndex ?? 0;
        const hasLandmarks = lm && lm.length > 0;
        // Protocol ONLY after all landmarks exhausted
        const isProtocolTurn = hasLandmarks && idx >= lm.length;
        if (isProtocolTurn) {
          const protoIdx = session.slots.addressProtocolIndex ?? 0;
          const protoLines = [
            'Адресата на имотот ќе ја споделам со Вас два часа пред нашата средба, согласно политиките на Агенцијата.',
            'Точната адреса се открива на денот на посетата, за безбедност на сопственикот — тоа е правило на Агенцијата.',
            'Агенцијата ги штити информациите за имотот. Точната адреса ќе ја дознаете кога ќе се договориме за термин.',
            'Заради приватноста на сопственикот, адресата се споделува само по закажување на посета. Сте во можност да закажеме?',
          ];
          answer = protoLines[protoIdx % protoLines.length];
          session.slots.addressProtocolIndex = protoIdx + 1;
          session.slots.landmarkIndex = idx + 1;
          pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
          pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
          this.deps.sessions.set(session);
          await this.sendRaw(session, answer);
          return;
        }
        // Landmark turns: idx=0→L1, idx=1→L2, idx=2→L3. If no landmarks resolved,
        // just use hit.landmark (the pre-resolved one from the table/feed).
        const lmSlot = lm ? Math.min(idx, lm.length - 1) : 0;
        const landmark = lm?.[lmSlot] ?? hit.landmark;
        session.slots.landmarkIndex = idx + 1;
        // Google Maps link: always included so the client never needs a
        // follow-up asking for directions.
        const coords = session.slots.nearbyLandmarkCoords?.[lmSlot];
        const gmapsLine = coords
          ? `\nhttps://www.google.com/maps/search/?api=1&query=${coords.lat},${coords.lon}`
          : '';
        answer = `${buildWhereIsAnswer(whereIs.place, {
          location: hit.location, eb: hit.eb, business: hit.business, landmark,
        })}${gmapsLine}`;
      } else if (whereIs.place) {
        // (a) The client asks about a landmark WE just gave ("kade e toa
        // Helen Doron?") — match against the rotation slots before anything
        // else; claiming ignorance of our own answer is worse than any miss.
        const q = whereIs.place.toLowerCase();
        const lmList = session.slots.nearbyLandmarks ?? [];
        let givenIdx = -1;
        for (let i = 0; i < lmList.length; i++) {
          const n = lmList[i].toLowerCase();
          if ((n.includes(q) || q.includes(n)) && Math.min(n.length, q.length) >= 4) { givenIdx = i; break; }
        }
        if (givenIdx >= 0) {
          const nm = lmList[givenIdx];
          const c = session.slots.nearbyLandmarkCoords?.[givenIdx];
          answer = `Ова е местото што Ви го спомнав — ${nm}.${c ? `\nhttps://www.google.com/maps/search/?api=1&query=${c.lat},${c.lon}` : ''}`;
        } else {
          // (b) Any known POI ("kade e Ramstor?") — answer from the offline map.
          const poi = this.landmarks.findPlace(whereIs.place);
          if (poi) {
            answer = `${poi.name}:\nhttps://www.google.com/maps/search/?api=1&query=${poi.lat},${poi.lon}`;
          } else {
            // (c) Neighborhood / unknown — property-neighborhood or honest miss.
            const locs = await this.deps.properties.locations();
            const loc = detectLocation(whereIs.place, locs);
            answer = buildWhereIsAnswer(whereIs.place, loc ? { location: loc } : undefined);
          }
        }
      } else {
        answer = buildWhereIsAnswer('');
      }
      pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
      pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
      this.deps.sessions.set(session);
      await this.sendRaw(session, answer);
      return;
    }

    // 0) Property DESCRIPTION without service type: the client remembers a
    // specific property they saw ("гарсоњерата кaj crnogorska ambasada") but
    // doesn't know the EB number. Route to property_locate for guided search.
    // Must come BEFORE the classifier so the FSM doesn't go to discovery.
    // Exclude service intents ("sakam da kupam/iznajmam") — those go to discovery.
    if (detectPropertyDescription(text) && !session.slots.service
        && !detectService(text) && !detectBothServices(text)) {
      const slots = extractSlots(text);
      if (!slots.service) {
        // No service declared — route to property_locate for guided search
        // extractSlots doesn't resolve feed neighborhoods — use detectLocation
        let loc = slots.location;
        if (!loc) {
          try {
            const locs = await this.deps.properties.locations();
            loc = detectLocation(text, locs) ?? undefined;
          } catch { /* ignore */ }
        }
        if (loc) session.slots.location = loc;
        if (slots.bedrooms) session.slots.bedrooms = slots.bedrooms;
        if (slots.sqm) session.slots.sqm = slots.sqm;
        if (slots.budget) session.slots.budget = slots.budget;
        session.state = 'property_locate';
        const answer = LOCATE_FIRST_ASK;
        pushHistory(session, { role: 'user', text }, this.cfg.maxHistory);
        pushHistory(session, { role: 'assistant', text: answer }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, answer);
        return;
      }
      // Service declared — fall through to classifier/discovery
    }

    // 1) Cold-brained intent extraction (Groq, JSON mode)
    const classified = await this.deps.classifier.classify(session, text);

    // 2) Slots + FSM transition
    const ev = classified.event;
    this.applySlots(session, ev);
    // Did THIS message explicitly name a neighborhood ("што имаш во Карпош?")?
    // If so, the presentation must stay inside that area — and an area with no
    // matches gets the honest no-match line, never a silent different-area spill.
    let areaRequested = false;
    try {
      const locs = await this.deps.properties.locations();
      areaRequested = !!detectLocation(text, locs);
    } catch {
      areaRequested = false;
    }
    const before = session.state;
    let next = transition(before, ev);

    // Mid-discovery the client asks to SEE current offers before the criteria
    // are complete ("што имате во понуда?", "помало нешто", "покажи ми") —
    // Lina ANSWERS with real DB offers (smallest м² first, area-locked) instead
    // of repeating the missing question. The classifier routes this to
    // SEARCH_REQUESTED; the incomplete-criteria guard is bypassed so the offers
    // are presented, and an area with nothing gets the honest no-match line.
    const seeOffers = before === 'discovery' && detectSeeOffers(text);
    if (seeOffers) next = 'presentation';

    if (before === 'discovery' && ev.type === 'DETAILS_PROVIDED' && this.slotsComplete(session)) {
      next = 'presentation';
    }
    // property_locate: the client saw a specific property but has no number.
    // Details keep coming while Lina tries to identify it; once the remembered
    // criteria are complete, the closest DB matches are presented (the reply
    // strategy below decides ask vs. present based on what is known).
    if (before === 'property_locate' && ev.type === 'SEARCH_REQUESTED') {
      next = 'property_locate';
    }
    if (before === 'discovery' && ev.type === 'SEARCH_REQUESTED' && !this.slotsComplete(session) && !seeOffers) {
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

    // Fee refusal ladder (deterministic, in closing only). A WHY question
    // ("зошто наплаќате посета?", "никој не го прави тоа") is NOT a refusal —
    // Lina answers it with the agency's rationale (the fee is a filter for real
    // clients) and the funnel STAYS at the fee question: no persuasion rung is
    // burned, and a classifier misread (closing + REJECTED would exit to
    // presentation) is corrected back to closing.
    // Fee-why can appear in ANY state after the fee was disclosed (closing)
    // or even mid-property-viewing ("nikoj ne naplakja za poseti" in
    // property_query). Widen the check so the pivot always fires.
    const feeWhyQuestion = detectFeeWhy(text) && ['closing', 'property_query', 'presentation', 'discovery', 'intent', 'idle'].includes(before);
    if (ev.type === 'FEE_REFUSED' && before === 'closing' && !feeWhyQuestion) {
      session.slots.feeRejections = (session.slots.feeRejections ?? 0) + 1;
      next = (session.slots.feeRejections ?? 0) >= 3 ? 'queued' : 'closing';
    }
    if (feeWhyQuestion) next = 'closing';

    // Negotiation loop bound (deterministic, in time_confirm only)
    if (ev.type === 'TIME_REJECTED' && before === 'time_confirm') {
      session.slots.negotiationCount = (session.slots.negotiationCount ?? 0) + 1;
      if (session.slots.negotiationCount >= this.cfg.negotiationCap) next = 'escalated';
    }

    // Exhausted-options agreement: after every matching property was shown, an
    // agreement ("добро", "контактирај ме") registers the criteria instead of
    // looping the exhausted line forever ("DOBRO" -> contact collection).
    // BUT: if the client IS interested in a specific property (propertyId /
    // interestedPropertyId), the flow must proceed to visit_scheduling — the
    // queue is only for "no specific property, register my criteria".
    const hasProperty = !!(session.slots.propertyId || session.slots.interestedPropertyId);
    if (ev.type === 'CONTACT_PROVIDED' && session.slots.queueAfterContact && !hasProperty) {
      next = 'queued';
    }

    session.state = next;

    // Suggest-alternatives pivot from a FAILED EB lookup: the client answered
    // the not-found line ("predlozi mi", "drugi lokaciii") and the funnel moved
    // to presentation — the bad propertyId must be cleared so a later INTERESTED
    // ("sakam da ja vidam") never grabs the non-existent EB.
    if (before === 'property_query' && next === 'presentation'
      && session.slots.propertyId !== undefined && detectSuggestAlternatives(text)) {
      session.slots.propertyId = undefined;
    }

    // Contact complete when the phone is already known (Viber sender id) and
    // the client gave their name — deterministic, no LLM needed: "GORAN MOZE NA
    // OVOJ BROJ" means name + the number he is writing from.
    // Also fire when queueAfterContact is set BUT a specific property was shown:
    // the client wants to VISIT it, not queue criteria.
    if (session.state === 'contact_collection'
      && session.slots.name
      && session.slots.phone
      && (!session.slots.queueAfterContact || hasProperty)) {
      next = 'visit_scheduling';
      session.state = next;
    }

    // Post-transition side effects
    if (next === 'queued') {
      this.queueCustomer(session, session.slots.queueAfterContact ? 'исцрпени опции — регистрирани барања' : '3x одбиен надомест');
    }
    if (next === 'escalated') this.raiseEscalation(session, text);

    // Visit cancellation: client or owner says they can't make it.
    // Works in visit_scheduling, owner_checking, time_confirm, pending.
    const visitStates = ['visit_scheduling', 'owner_checking', 'time_confirm', 'pending', 'queued'];
    if (detectVisitCancellation(text) && visitStates.includes(session.state)) {
      // Find the active appointment for this chat
      const appts = this.deps.appointments.listByChat(session.chatId)
        .filter(a => a.status === 'finalized');
      const appt = appts.length > 0 ? appts[appts.length - 1] : undefined;
      if (appt) {
        const by: 'client' | 'owner' = (session.chatId === this.cfg.viberOperatorId)
          ? 'owner' : 'client';
        await this.deps.visits?.cancelVisit(appt.id, by);
        reply = by === 'client'
          ? 'Откажана посета по желба на клиент. Метрополис се извинува за непланираните околности.Ќе бидеме во контакт.'
          : 'Откажана посета по желба на сопственикот. Метрополис се извинува за непланираните околности.Ќе бидеме во контакт.';
        session.state = 'terminated';
      }
    }

    // 4) Property context (responder only needs it for LLM-driven states)
    let props = await this.loadProps(session, areaRequested, seeOffers);

    // Service pinning: a client who jumps straight to an Евидентен број
    // ("zainteresiran sum za sifra 62") never declared buy/rent — the property's
    // OWN service is the truth. Pinning it here makes the whole downstream flow
    // consistent: the fee script (300 vs 500 денари), the agent pool, the
    // stored appointment fee and the visit protocol all follow the property's
    // market, never a missing slot.
    if (!session.slots.service && props[0]?.service) {
      session.slots.service = props[0].service;
    }

    // Exhausted-area pivot: the selected area(s) are drained and Lina just asked
    // whether to widen ("…или да погледнеме во друга населба?"). A pure
    // agreement (no register/contact intent, no NEW area named in the same
    // message) releases the area lock and presents the next batch from the REST
    // of the city — options come only AFTER the ask, never silently. Register
    // intents ("контактирај ме") fall through to the queue escape below.
    if (next === 'presentation' && props.length === 0
      && session.slots.areaExhausted && detectWidenIntent(text) && !ev.location) {
      session.slots.areaExhausted = false;
      session.slots.location = undefined;
      props = await this.loadProps(session, false, false);
    }

    // Exhausted dead-end escape: once every option is shown (props empty), an
    // agreement message must move to contact collection, never loop the same
    // exhausted line. (Runs after the state transition above.)
    if (next === 'presentation' && props.length === 0 && detectAgreement(text)) {
      next = 'contact_collection';
      session.state = next;
      session.slots.queueAfterContact = true;
    }

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
    // Which brain produced the reply — default deterministic; only the
    // responder path can be LLM-driven ('gemini:1..3' / 'groq' / 'fallback').
    let replySource = 'deterministic';
    // Locate-a-seen-property funnel (deterministic, like the no-match lines):
    // the client saw a specific property but has no Евидентен број. First ask
    // for the number (known -> easy property_query lookup); then collect
    // identifying details (населба / цена / квадрати) and present the CLOSEST
    // DB matches code-built — the LLM must never invent them. "не е тој" pulls
    // the next closest batch; only when every match was shown do we ask for
    // more details.
    if (next === 'property_locate') {
      const price = session.slots.budget ? Number(session.slots.budget.replace(/[^\d]/g, '')) : undefined;
      const locateOpts = {
        location: session.slots.location,
        price,
        sqm: session.slots.sqm,
        business: session.slots.business,
        house: session.slots.house,
        service: session.slots.service,
      };
      const present = (matches: Property[]): string => {
        // Mark the batch as shown ONLY when it is actually presented, so the
        // next "не е тој" pulls the NEXT closest ones (never re-shows).
        session.slots.presentedIds = [...(session.slots.presentedIds ?? []), ...matches.map(p => p.id)];
        session.slots.currentBatch = matches.map(p => p.id);
        return buildLocateMatches(matches, session.history.length);
      };
      if (before !== 'property_locate') {
        // Just entered — ask the number first (the easy path when known).
        reply = LOCATE_FIRST_ASK;
      } else if (/го\s+знам|знам\s+го|znam\s+go|го\s+знам\s+бројот/i.test(text)) {
        // "да, го знам" — the client knows the number; prompt for it instead
        // of looping the first ask (the number itself routes to property_query).
        reply = LOCATE_NUMBER_PROMPT;
      } else if (ev.type === 'REJECTED') {
        // "не е тој" — pull the NEXT closest batch (never re-show what was
        // just rejected); ask for more details when the DB is exhausted.
        const nextBatch = (await this.deps.properties.closestMatches({
          ...locateOpts, exclude: session.slots.presentedIds ?? [],
        })).slice(0, 2);
        reply = nextBatch.length > 0 ? present(nextBatch) : LOCATE_REFINE_ASK;
      } else if (session.slots.location || session.slots.sqm || session.slots.budget) {
        // A NEW identifying detail (населба / цена / квадрати) re-ranks the
        // WHOLE candidate pool — excluding already-shown matches here would
        // hide the property the client is actually narrowing toward.
        const matches = (await this.deps.properties.closestMatches(locateOpts)).slice(0, 2);
        reply = matches.length > 0 ? present(matches) : LOCATE_REFINE_ASK;
      } else {
        // No identifying details yet — collect населба / цена / квадрати.
        reply = LOCATE_DETAILS_ASK;
      }
    } else if (next === 'queued') {
      reply = session.slots.queueAfterContact ? QUEUED_CONFIRM : FEE_GRACEFUL_CLOSE;
    } else if (session.slots.queueAfterContact && session.state === 'contact_collection') {
      // Same once-per-funnel rule as the regular contact ask: the first one
      // carries "Одлично, уште последниве информации и завршуваме.", retries stay plain.
      const n = session.slots.contactAsks ?? 0;
      session.slots.contactAsks = n + 1;
      reply = (n === 0 ? `${LAST_INFO_PREFIX} ` : '') + buildContactAsk(session.slots, assistantTexts(session));
    } else if (next === 'closing'
        && detectPropertyInterest(text)
        && before !== 'closing'
        && (before === 'property_query' || before === 'presentation' || before === 'discovery')) {
      // Enthusiasm: the client said 'mi se svigja 89' / 'zainteresiran sum' /
      // 'go sakam' — general interest (NOT explicit scheduling like 'кога
      // може да се погледне' / 'договори ми'). Send enthusiasm + visit offer,
      // NOT the fee yet. The fee is disclosed ONLY after the client confirms ('да').
      // Availability asks ('дали е достапен?') are caught by detectPropertyInterest
      // exclusion (PROPERTY_INTEREST_RE doesn't match them), so they go to the
      // availability ack path below.
      const eb = session.slots.propertyId ?? session.slots.interestedPropertyId ?? props[0]?.eb;
      if (eb) {
        session.slots.interestedPropertyId = eb;
        session.slots.ownerContactPending = true;
        session.state = 'closing';
      }
      reply = pickVariant('property.liked', { recent: assistantTexts(session) })
        ?? 'Одличен избор! Дали би сакале да организирам посета, за да го погледнете во живо?';

    } else if (next === 'closing'
        && (ev.type === 'INTERESTED' || detectVisitInterest(text))
        && before !== 'closing'
        && !session.slots.viewingFeeAgreed
        && !detectAvailabilityAsk(text)
        && !detectPropertyInterest(text)
        && !detectFeeWhy(text)
        && (before === 'property_query' || before === 'presentation' || before === 'discovery')) {
      // Explicit visit interest: 'sakam da ja vidam', 'koga moze da se
      // pogledne', 'dogovori mi' — the client wants to SEE the property.
      // Show the fee disclosure directly (NOT enthusiasm — that's for general
      // interest like 'mi se svigja'). This is the main fee-disclosure gate.
      if (session.slots.propertyId) session.slots.interestedPropertyId = session.slots.propertyId;
      session.state = 'closing';
      const service = session.slots.service ?? props[0]?.service ?? 'buy';
      const fee = pickVariant(service === 'rent' ? 'fee.ask.rent' : 'fee.ask.buy', { recent: assistantTexts(session) })
        ?? buildFeeAsk(service);
      reply = fee;

    } else if (detectFeeWhy(text) && ['closing', 'property_query', 'presentation', 'discovery', 'intent', 'idle'].includes(before)) {
      // "Зошто наплаќате?" / "Никој не наплаќа за посета" / "Како тоа да платам?"
      // — the client QUESTIONS the fee, they don't REFUSE it. Always answer
      // with the agency rationale (fee.why) and stay at closing. The pivot
      // to alternatives is only for actual fee REFUSALS (FEE_REFUSED below),
      // not for why-questions. Answering WHY first, then re-asking the fee,
      // lets the client make an informed decision.
      reply = pickVariant('fee.why', { recent: assistantTexts(session) }) ?? buildFeeWhy();
    } else if ((next === 'closing')
        && ev.type === 'FEE_REFUSED') {
      // Fee resistance: the client pushes back on the viewing fee.
      // 1st refusal → one more persuasion attempt (Macedonian clients aren't
      //   used to paying; empathy + value framing often wins them over).
      // 2nd+ refusal → pivot to alternative properties in other neighborhoods,
      //   or the persuasion ladder if nothing else is available.
      const rejections = session.slots.feeRejections ?? 1;
      if (rejections <= 1) {
        reply = feePersuasion(session.slots.service, rejections);
      } else {
        const cur = props[0];
        const shown = [...(session.slots.presentedIds ?? [])];
        if (cur) shown.push(cur.id);
        if (session.slots.soldEb) shown.push(session.slots.soldEb);
        const all = await this.deps.properties.candidates({
          service: session.slots.service ?? cur?.service,
          business: session.slots.business,
          house: session.slots.house,
          bedrooms: session.slots.bedrooms,
          sqm: session.slots.sqm,
          budget: session.slots.budget,
          exclude: shown,
        });
        const curLoc = cur?.location;
        const pool = curLoc
          ? all.filter(p => !locMatches(curLoc, p.location ?? ''))
          : all;
        const batch = pool.slice(0, 2);
        if (batch.length > 0) {
          session.slots.presentedIds = [...shown, ...batch.map(p => p.id)];
          session.slots.currentBatch = batch.map(p => p.id);
          session.slots.alternativesExhausted = pool.length === 0;
          session.slots.feeRejections = undefined;
          session.slots.service = session.slots.service ?? cur?.service;
          session.state = 'presentation';
          await this.landmarks.enrich(batch);
          reply = `${pickVariant('fee.pivot.neighborhood', { recent: assistantTexts(session) })
            ?? buildFeePivotNeighborhood()}\n\n${batch.map(p => buildPropertyCard(p)).join('\n\n')}\n\n${pickCloser(PRESENTATION_CLOSERS_ALL, session.history.length)}`;
        } else {
          reply = feePersuasion(session.slots.service, session.slots.feeRejections ?? 1);
        }
      }
    } else if (ev.type === 'REJECTED' && ['idle', 'intent', 'discovery'].includes(before)) {
      // The client denies the current direction ("не барам стан", "нешто
      // друго") before anything was shown — pivot to what they DO want
      // instead of re-asking the same discovery question.
      reply = DIRECTION_PIVOT_LINE;
    } else if (next === 'visit_scheduling') {
      reply = VISIT_TIME_QUESTION;
    } else if (next === 'owner_checking') {
      const eb = session.slots.interestedPropertyId ?? session.slots.propertyId ?? 0;
      const t = session.slots.visitTime ?? '';
      if (before === 'owner_checking' && ev.type === 'TIME_REJECTED') {
        // The client can't do the proposed time ("не можам во 18:00", "може
        // покасно?") — collect a NEW concrete time instead of keeping the owner
        // check on a time the client already rejected.
        session.state = 'visit_scheduling';
        reply = VISIT_TIME_QUESTION;
      } else if (before === 'owner_checking' && ev.type === 'VISIT_TIME_PROVIDED') {
        // The client changed the proposed time mid-check — re-ask the owner
        // with the NEW time (the ping-pong continues with the new proposal).
        reply = OWNER_CHECK_ACK;
        if (eb && t) void this.runOwnerCheck(session, eb, t);
      } else if (before === 'owner_checking') {
        // Bank-backed: patience variants rotate, never the same sentence twice.
        reply = pickVariant('patience.line', { recent: assistantTexts(session) }) ?? PATIENCE_LINE;
      } else {
        reply = OWNER_CHECK_ACK; // first transition into owner_checking
        if (eb && t) void this.runOwnerCheck(session, eb, t);
      }
    } else if (next === 'escalated') {
      reply = fallbackVariant('escalated', assistantTexts(session))
        ?? FALLBACKS.escalated ?? 'Ќе Ве контактира менаџер.';
    } else if (session.state === 'owner_checking') {
      // client wrote while the owner check is in flight — bank-backed patience line
      reply = pickVariant('patience.line', { recent: assistantTexts(session) }) ?? PATIENCE_LINE;
    } else if (session.state === 'queued') {
      reply = QUEUED_STAY_LINE;
    } else if (next === 'presentation' && props.length === 0) {
      // Deterministic empty-result lines — never let the LLM invent properties.
      // A search that names an area but has nothing there -> honest no-match;
      // follow-up rejections after every candidate was shown -> "exhausted" line.
      // Either way the area lock is marked drained: the client's next pure
      // agreement widens the search to the rest of the city (options come only
      // AFTER the ask), while register/contact intents go to the queue.
      // The exhausted line is bank-backed (exhausted.location/plain) so the
      // widen question varies like the other protocol lines; the code-built
      // line stays the fallback.
      session.slots.areaExhausted = true;
      reply = !this.deps.properties.healthy
        ? FEED_UNAVAILABLE_LINE
        : (before === 'discovery' || areaRequested
          ? noMatchLine(session.slots.location ?? ev.location, assistantTexts(session))
            ?? NO_MATCH_LINE(session.slots.location ?? ev.location)
          : exhaustedLine(session.slots.location, assistantTexts(session))
            ?? NO_MORE_ALTERNATIVES_LINE(session.slots.location));
    } else if (next === 'property_query' && props.length > 0
        && !detectAvailabilityAsk(text)
        && !session.slots.ownerContactPending) {
      // The client asked about a known EB ("кажи ми нешто за 57", "што е со
      // 62?"): show the property card deterministically. No LLM needed — the
      // card is code-built with all the property details + landmark.
      // Availability asks ("дали е сеуште достапен?") are excluded — they
      // route to the closing/fee path below. Also excluded when
      // ownerContactPending ("да" after availability ack) — the agreement
      // handler below shows the fee instead of re-showing the card.
      reply = buildPropertyCard(props[0]);
      // Pre-resolve top-3 nearby landmarks for rotation ("каде?" → first,
      // "каде поточно?" → second, …) + Google Maps links. Cached on the
      // session so repeated asks don't re-geocode.
      if (!session.slots.nearbyLandmarks?.length && props[0]) {
        const nearby = this.landmarks.nearbyLandmarks(props[0]);
        if (nearby.length > 0) {
          session.slots.nearbyLandmarks = nearby.map(n => n.landmark);
          session.slots.nearbyLandmarkCoords = nearby.map(n => ({ lat: n.lat, lon: n.lon }));
          session.slots.landmarkIndex = 0;
        }
      }
    } else if (next === 'property_query' && props.length === 0) {
      // The EB doesn't exist. The not-found line itself asks whether the
      // client wants similar properties from other locations — an agreement
      // ("да") or an alternatives request ("predlozi mi", "drugi lokaciii")
      // must PIVOT to a REAL city-wide presentation instead of repeating the
      // not-found line forever (the stuck loop: every follow-up re-rendered
      // "не можам да го најдам имотот со Евидентен број 250"). The bad EB is
      // cleared so a later INTERESTED ("sakam da ja vidam") never grabs it.
      const pivot = detectAgreement(text) || detectSuggestAlternatives(text);
      if (pivot && this.deps.properties.healthy) {
        session.slots.propertyId = undefined;
        session.state = 'presentation';
        props = await this.loadProps(session, false, false);
      }
      if (props.length > 0) {
        const requestedBeds = session.slots.bedrooms;
        const exactMatch = requestedBeds ? props.some(p => p.bedrooms === requestedBeds) : true;
        let prefix = '';
        if (requestedBeds && !exactMatch) {
          const requestedLabel = requestedBeds === 1 ? 'една спална' : requestedBeds === 2 ? 'две спални' : `${requestedBeds} спални`;
          const hasBigger = props.some(p => p.bedrooms && p.bedrooms > requestedBeds);
          const hasSmaller = props.some(p => p.bedrooms && p.bedrooms < requestedBeds);
          if (hasBigger && !hasSmaller) {
            prefix = `Во моментов нема стан со ${requestedLabel} во ${session.slots.location ?? 'оваа населба'} во Вашата цена, но има поголеми станови кои би можеле да Ви одговараат:\n\n`;
          } else if (hasSmaller && !hasBigger) {
            prefix = `Во моментов нема стан со ${requestedLabel} во ${session.slots.location ?? 'оваа населба'} во Вашата цена, но има помали станови кои би можеле да Ви одговараат:\n\n`;
          } else {
            prefix = `Во моментов нема стан со ${requestedLabel} во ${session.slots.location ?? 'оваа населба'} во Вашата цена. Еве ги најблиските опции:\n\n`;
          }
        }
        reply = prefix + buildPropertyCards(props, 'presentation', session.history.length,
          assistantTexts(session), { anywhere: session.slots.anywhere, budget: session.slots.budget });
      } else {
        reply = this.deps.properties.healthy
          ? PROPERTY_NOT_FOUND_LINE(session.slots.propertyId ?? 0)
          : FEED_UNAVAILABLE_LINE;
      }
    } else if (detectAvailabilityAsk(text)
      && (next === 'property_query' || next === 'closing')
      && (session.slots.propertyId ?? session.slots.interestedPropertyId ?? props[0]?.eb)) {
      // Availability question about a KNOWN property ("дали е сеуште достапен?",
      // "dali e seuste dostapen?"): the client saw the ad on the website and
      // knows the details — Lina does NOT re-describe it. She answers that it
      // should still be available and ASKS if the client wants her to contact
      // the owner. The fee is NOT disclosed yet — it comes AFTER the client
      // confirms they want to proceed. The ack is bank-backed (varied), with
      // the code-built line as fallback.
      const eb = session.slots.propertyId ?? session.slots.interestedPropertyId ?? props[0]?.eb!;
      session.state = 'closing';
      session.slots.interestedPropertyId = eb;
      session.slots.ownerContactPending = true;
      // Pre-resolve nearby landmarks for when the client asks "каде се наоѓа?"
      if (!session.slots.nearbyLandmarks?.length && props[0]) {
        const nearby = this.landmarks.nearbyLandmarks(props[0]);
        if (nearby.length > 0) {
          session.slots.nearbyLandmarks = nearby.map(n => n.landmark);
          session.slots.nearbyLandmarkCoords = nearby.map(n => ({ lat: n.lat, lon: n.lon }));
          session.slots.landmarkIndex = 0;
        }
      }
      const ack = pickVariant('availability.ack', { recent: assistantTexts(session) })
        ?? AVAILABILITY_ACK;
      // NO landmark line here — location is revealed ONLY when the client
      // explicitly asks ("каде се наоѓа?"). The availability ack is just
      // about contacting the owner.
      reply = ack;
    } else if ((next === 'closing' || before === 'closing')
        && session.slots.ownerContactPending
        && detectAgreement(text)) {
      // Client confirmed they WANT the owner contacted ("да" / "согласен" after
      // the availability ack). NOW disclose the fee — the client knows the
      // property, wants it checked, and the fee is the last gate before the
      // owner ping-pong starts. Override next AND state to stay in closing —
      // the fee has not been agreed yet, only the permission to contact.
      next = 'closing';
      session.state = 'closing';
      session.slots.ownerContactPending = false;
      const service = session.slots.service ?? props[0]?.service ?? 'buy';
      const fee = pickVariant(service === 'rent' ? 'fee.ask.rent' : 'fee.ask.buy', { recent: assistantTexts(session) })
        ?? buildFeeAsk(service);
      reply = fee;
    } else if (next === 'closing' && before === 'closing'
        && detectAgreement(text)
        && !session.slots.ownerContactPending
        && (session.slots.viewingFeeAgreed || props[0]?.eb)) {
      // Fee already disclosed + client says "да" / "moze" / "dogovori" / etc.
      // → proceed to visit scheduling (owner contact). The fee block above set
      //   ownerContactPending=false; this catch-all moves the conversation
      //   forward instead of re-showing the fee or falling to the LLM.
      next = 'visit_scheduling';
      session.state = 'visit_scheduling';
    } else if (detectOfftopic(text) && !['owner_checking', 'pending'].includes(session.state)) {
      reply = pickVariant('offtopic.redirect', { recent: assistantTexts(session) })
        ?? OFFTOPIC_REDIRECT;
    } else if (detectDefer(text) && ['closing', 'presentation', 'property_query', 'property_locate'].includes(session.state)) {
      reply = pickVariant('followup.defer', { recent: assistantTexts(session) })
        ?? FOLLOWUP_DEFER;
    } else if (detectNegotiate(text) && ['closing', 'presentation', 'property_query'].includes(session.state)) {
      reply = pickVariant('price.negotiate', { recent: assistantTexts(session) })
        ?? PRICE_NEGOTIATE;
    } else if (detectProvisionAsk(text) && ['closing', 'presentation', 'property_query', 'discovery', 'intent', 'idle'].includes(session.state)) {
      reply = pickVariant('provision.ask', { recent: assistantTexts(session) })
        ?? PROVISION_ANSWER;
    } else if (detectEscalation(text)) {
      reply = pickVariant('escalation.polite', { recent: assistantTexts(session) })
        ?? ESCALATION_ANSWER;
    } else if (detectDocumentsAsk(text) && ['closing', 'presentation', 'property_query', 'discovery', 'intent', 'idle'].includes(session.state)) {
      reply = pickVariant('documents.info', { recent: assistantTexts(session) })
        ?? DOCUMENTS_ANSWER;
    } else if (detectMortgageAsk(text) && ['closing', 'presentation', 'property_query', 'discovery', 'intent', 'idle'].includes(session.state)) {
      reply = pickVariant('mortgage.info', { recent: assistantTexts(session) })
        ?? MORTGAGE_ANSWER;
    } else if (detectNeighborhoodAsk(text) && ['idle', 'intent', 'discovery'].includes(session.state)) {
      reply = pickVariant('neighborhood.general', { recent: assistantTexts(session) })
        ?? NEIGHBORHOOD_ANSWER;
    } else if (detectComparison(text) && ['presentation', 'property_query'].includes(session.state)) {
      reply = pickVariant('comparison.help', { recent: assistantTexts(session) })
        ?? COMPARISON_ANSWER;
    } else if (detectFeatureAsk(text) && ['property_query', 'presentation', 'closing'].includes(session.state)) {
      reply = pickVariant('feature.after.show', { recent: assistantTexts(session) })
        ?? FEATURE_ANSWER;
    } else if (detectSchedulingFlex(text) && ['visit_scheduling', 'owner_checking', 'time_confirm'].includes(session.state)) {
      reply = pickVariant('scheduling.flex', { recent: assistantTexts(session) })
        ?? SCHED_FLEX_ANSWER;
    } else if (next === 'presentation' && props.length > 0
        && (ev.type === 'DETAILS_PROVIDED' || ev.type === 'SEARCH_REQUESTED')) {
      // LLM-free: the client refined criteria mid-presentation ("една спална",
      // "гарсоњера", "во Карпош") — re-present with the updated filters using
      // the code-built cards. The LLM would just wrap the same cards in a
      // conversational shell at the cost of a Gemini call.
      // If the client asked for specific bedrooms but none exist, explain and
      // offer alternatives (bigger/smaller in same area, or matching elsewhere).
      const requestedBeds = session.slots.bedrooms;
      const exactMatch = requestedBeds ? props.some(p => p.bedrooms === requestedBeds) : true;
      const allSameArea = session.slots.location ? props.every(p => locMatches(session.slots.location!, p.location ?? '')) : true;
      let prefix = '';
      if (requestedBeds && !exactMatch) {
        const requestedLabel = requestedBeds === 1 ? 'една спална' : requestedBeds === 2 ? 'две спални' : `${requestedBeds} спални`;
        const hasBigger = props.some(p => p.bedrooms && p.bedrooms > requestedBeds);
        const hasSmaller = props.some(p => p.bedrooms && p.bedrooms < requestedBeds);
        if (hasBigger && !hasSmaller) {
          prefix = `Во моментов нема стан со ${requestedLabel} во ${session.slots.location ?? 'оваа населба'} во Вашата цена, но има поголеми станови кои би можеле да Ви одговараат:\n\n`;
        } else if (hasSmaller && !hasBigger) {
          prefix = `Во моментов нема стан со ${requestedLabel} во ${session.slots.location ?? 'оваа населба'} во Вашата цена, но има помали станови кои би можеле да Ви одговараат:\n\n`;
        } else {
          prefix = `Во моментов нема стан со ${requestedLabel} во ${session.slots.location ?? 'оваа населба'} во Вашата цена. Еве ги најблиските опции:\n\n`;
        }
      }
      reply = prefix + buildPropertyCards(props, 'presentation', session.history.length,
        assistantTexts(session), { anywhere: session.slots.anywhere, budget: session.slots.budget });
    } else if (detectBothServices(text)
        && ['idle', 'intent'].includes(before)
        && !session.slots.service) {
      // Both buy + rent: client said 'I TOA I TOA' / 'za dvete' — ask
      // what TYPE of property they want (stan, kukja, business, plac).
      // The bothServices flag persists so the next message (type) triggers
      // the buy-vs-rent question instead of the normal discovery flow.
      session.slots.bothServices = true;
      session.state = 'intent';
      reply = pickVariant('both.ask.type', { recent: assistantTexts(session) })
        ?? 'Ќе ми треба типот на недвижност што Ве интересира, за да Ви понудам соодветни опции — стан, куќа, деловен простор или плац?';
    } else if (session.slots.bothServices
        && before === 'intent'
        && (detectBusiness(text) || detectHouse(text)
            || /(?:стан|stan(?:ot)?|куќа|kukj[ae]|дуќан|dukj[ae]n|локал|lokal|деловен|deloven|канцеларија|plac|плац)/iu.test(text))) {
      // Type chosen after both-services: 'DUKJAN' / 'stan' / 'kuќa' /
      // 'plac'. Now ask buy vs rent with the type baked in.
      // Keep state = 'intent' so the buy/rent answer goes through the normal
      // INTENT_DECLARED path into discovery.
      session.state = 'intent';
      if (detectBusiness(text)) session.slots.business = true;
      const h = detectHouse(text);
      if (h !== undefined) session.slots.house = h;
      const typeLabel = detectBusiness(text) ? 'Деловен простор'
        : h ? 'Куќа'
        : /(?:плац|plac)/iu.test(text) ? 'Плац'
        : 'Стан';
      reply = (pickVariant('both.ask.service', { recent: assistantTexts(session) })
        ?? `{type} — одлично. Дали сакате да купите или да изнајмите?`)
        .replace('{type}', typeLabel);
    } else if (session.slots.bothServices
        && before === 'intent'
        && !session.slots.service
        && !session.slots.business && !session.slots.house) {
      // Still undecided on property type after both-services: "не сум се одлучил",
      // "не знам", "кажете ми опции" — re-ask the type question.
      session.state = 'intent';
      reply = pickVariant('both.ask.type', { recent: assistantTexts(session) })
        ?? 'Ќе ми треба типот на недвижност што Ве интересира, за да Ви понудам соодветни опции — стан, куќа, деловен простор или плац?';
    } else {
      const r = await this.deps.responder.respond(session, props, text);
      reply = r.text;
      replySource = r.source;
    }

    pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
    this.deps.sessions.set(session);

    // Enrichment queue: log LLM-backed responses for the midnight cron job.
    // Only logs when the enrichment store is configured AND the reply came
    // from an LLM (not deterministic/fallback — those are already bank-backed).
    if (this.deps.enrichment && replySource !== 'deterministic' && replySource !== 'fallback') {
      try {
        this.deps.enrichment.insert({
          chatId: session.chatId,
          state: before,
          eventType: ev.type,
          userMsg: text,
          replyText: reply,
          replySource,
        });
      } catch (e) {
        console.error('[enrichment] log failed:', (e as Error).message);
      }
    }

    await this.sendRaw(session, reply, replySource);
  }

  // ---------------- owner check continuation ----------------

  /** Resolve a pending owner check with a verdict (plain-text owner reply or
   *  the TUI /owner command — the same seam Hermes will use). */
  ownerAnswer(chatId: string, eb: number, verdict: OwnerVerdict): boolean {
    const agent = this.ownerAgent as unknown as {
      answer?: (c: string, e: number, v: OwnerVerdict) => boolean;
    };
    return agent.answer?.(chatId, eb, verdict) ?? false;
  }

  private async runOwnerCheck(session: ChatSession, eb: number, proposedTime: string): Promise<void> {
    try {
      // The ping-pong starts HERE: Lina asks the owner whether the property is
      // available right now and whether he accepts the client's proposed time.
      // The answer (ok/counter/gone) is relayed to the client; a counter loops
      // back until the visit date+time are arranged.
      this.onOwnerAsk?.(session.chatId, eb, buildOwnerAsk(eb, proposedTime));
      const verdict = await this.ownerAgent.check(session.chatId, eb, proposedTime);
      this.enqueue(session.chatId, () => this.applyOwnerVerdict(session.chatId, eb, verdict));
    } catch (e) {
      console.error('[owner] check failed:', (e as Error).message);
    }
  }

  private async applyOwnerVerdict(chatId: string, eb: number, verdict: OwnerVerdict): Promise<void> {
    const session = this.deps.sessions.get(chatId);
    if (!session || session.state !== 'owner_checking') return; // stale/reset — drop

    // The owner dictates the CURRENT price ("цената е променета на 60.000") —
    // the owner is the source of truth and the price can change. Store it so
    // Hermes corrects the public app (Lovable/Cloudflare) AND relay the change
    // to the client (our price must follow the owner's word).
    let priceRelay = '';
    if (verdict.price !== undefined) {
      const old = (await this.deps.properties.getById(eb))?.price;
      this.priceChanges.insert({ eb, oldPrice: old ?? null, newPrice: verdict.price, chatId, source: 'owner' });
      this.events.insert('price_changed', chatId, eb, { oldPrice: old ?? null, newPrice: verdict.price, source: 'owner' });
      console.log(`[EVENT] PRICE_CHANGED ${JSON.stringify({ eb, oldPrice: old ?? null, newPrice: verdict.price })}`);
      priceRelay = buildPriceRelay(eb, verdict.price, old);
    }

    if (verdict.status === 'ok') {
      session.state = 'pending';
      session.slots.ownerTime = verdict.ownerTime ?? session.slots.visitTime;
      // The price relay goes FIRST (if any), then the confirmation — the client
      // must hear the new price before the visit is locked in.
      if (priceRelay) {
        pushHistory(session, { role: 'assistant', text: priceRelay }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, priceRelay);
      }
      await this.confirmVisit(session, eb, session.slots.ownerTime ?? '');
      return;
    }

    if (verdict.status === 'counter') {
      // Bare counter = the owner can't do the proposed time, NO alternative
      // given. There is no term for the client to accept — routing to
      // time_confirm fabricated "по договор со сопственикот" (and accepting
      // it fell back to the REFUSED time). Ask the client for another time;
      // the new proposal re-asks the owner.
      if (!verdict.ownerTime) {
        session.state = 'visit_scheduling';
        const reply = `${priceRelay ? `${priceRelay} ` : ''}${OWNER_CANT_TIME_RELAY(session.slots.visitTime ?? '')}`;
        pushHistory(session, { role: 'assistant', text: reply }, this.cfg.maxHistory);
        this.deps.sessions.set(session);
        await this.sendRaw(session, reply);
        return;
      }
      session.state = 'time_confirm';
      session.slots.ownerTime = verdict.ownerTime;
      const reply = `${priceRelay ? `${priceRelay} ` : ''}${OWNER_COUNTER_RELAY(verdict.ownerTime)}`;
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
    const apptId = this.finalizeAppointment(session, time, agentPhone);
    // The visit is LOCKED IN (owner ok'd, client accepted) — the appointment is
    // finalized so the visit protocol's timed turns can schedule against it.
    this.deps.appointments.markFinalized(apptId, time);
    this.events.insert('agent_assigned', session.chatId, eb, {
      agentId: agent?.id ?? null, agentPhone, time,
    });
    this.events.insert('visit_confirmed', session.chatId, eb, {
      appointmentId: apptId, time, agentPhone,
      customerName: session.slots.name ?? '', customerPhone: session.slots.phone ?? '',
    });
    this.promoteCustomer(session);

    await this.sendRaw(session, reply);

    // The visit protocol, turn 1: the moment the visit is confirmed, BOTH the
    // owner and the client get ДОГОВОРЕНА ПОСЕТА, the operator gets the
    // ARRANGED log line, and turns 2+3 (morning confirmation / exact location)
    // are scheduled by the VisitScheduler.
    if (this.visits) {
      const owner = this.owners.get(eb);
      await this.visits.arrange({
        appointmentId: apptId,
        chatId: session.chatId,
        eb,
        time,
        agentPhone,
        clientName: session.slots.name ?? 'Непознат клиент',
        clientPhone: session.slots.phone ?? 'Непознат телефон',
        owner: owner && (owner.name || owner.phone)
          ? { name: owner.name || 'Сопственик', phone: owner.phone || '?' }
          : undefined,
      });
    }
  }

  // ---------------- side-effect helpers ----------------

  private finalizeAppointment(session: ChatSession, time?: string, agentPhone = ''): number {
    const fee = session.slots.service === 'rent' ? '300 MKD' : '500 MKD';
    const propertyId = session.slots.interestedPropertyId ?? session.slots.propertyId ?? 0;
    const rowId = this.deps.appointments.insert({
      chatId: session.chatId,
      clientName: session.slots.name ?? 'Непознат клиент',
      clientPhone: session.slots.phone ?? 'Непознат телефон',
      propertyId,
      service: serviceLabel(session.slots.service),
      viewingFee: fee,
      time: time ?? null,
      agentPhone,
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
    if (ev.service) { session.slots.service = ev.service; session.slots.bothServices = undefined; }
    // Clients type Latin ("centar", "kapistec"); canonicalize to Cyrillic so
    // replies and the deterministic no-match lines read naturally.
    if (ev.location) session.slots.location = normalizeLocation(ev.location);
    if (ev.bedrooms) session.slots.bedrooms = ev.bedrooms;
    if (ev.sqm) session.slots.sqm = ev.sqm;
    if (ev.business !== undefined) session.slots.business = ev.business;
    if (ev.house !== undefined) session.slots.house = ev.house;
    if (ev.budget) session.slots.budget = ev.budget;
    if (ev.anywhere) session.slots.anywhere = true;
    if (ev.propertyId) session.slots.propertyId = ev.propertyId;
    if (ev.visitTime) session.slots.visitTime = ev.visitTime;
    if (ev.name) session.slots.name = ev.name;
    if (ev.phone) session.slots.phone = ev.phone;
  }

  private slotsComplete(s: ChatSession): boolean {
    // "Било каде" (anywhere) satisfies the location criterion AND waives the
    // bedroom requirement — a flexible client gets the budget-driven city-wide
    // presentation ("bilo kade do 250" → rent options till 250) instead of a
    // location/bedrooms loop they explicitly didn't care about.
    const loc = !!s.slots.location || !!s.slots.anywhere;
    // Commercial spaces complete with size (м²) instead of bedrooms.
    if (s.slots.business) {
      return !!s.slots.service && loc && !!s.slots.sqm && !!s.slots.budget;
    }
    return !!s.slots.service && loc && (!!s.slots.bedrooms || !!s.slots.anywhere) && !!s.slots.budget;
  }

  private async loadProps(session: ChatSession, areaRequested = false, seeOffers = false): Promise<Property[]> {
    const s = session.state;
    if (s === 'property_query') {
      const id = session.slots.propertyId;
      if (!id) return [];
      const p = await this.deps.properties.getById(id);
      if (!p) return [];
      await this.landmarks.enrich([p]); // approximate location, never the street
      return [p];
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
        sqm: session.slots.sqm,
        business: session.slots.business,
        house: session.slots.house,
        service: session.slots.service,
        budget: session.slots.budget,
        exclude: shown,
        // see-offers ("помало нешто"): SMALLEST м² first, going up — Lina
        // answers the "what do you have?" question with the smallest offer,
        // then progressively larger ones, instead of re-asking the missing sqm.
        sortBySqm: seeOffers,
        // "било каде": city-wide presentation starts from the most popular
        // neighborhoods (Центар, Капиштец, Карпош, Аеродром, …), then the rest.
        sortByPopularity: !!session.slots.anywhere && !session.slots.location,
      });
      // candidates() already locks to the selected area(s) and never spills —
      // an exhausted area returns [] here, which routes to the "different area?"
      // ask instead of silently offering another neighborhood.
      const batch = candidates.slice(0, 2);
      session.slots.presentedIds = [...shown, ...batch.map(p => p.id)];
      session.slots.currentBatch = batch.map(p => p.id);
      session.slots.alternativesExhausted = candidates.length === 0;
      await this.landmarks.enrich(batch); // cards name a landmark, never a street
      return batch;
    }
    if (['closing', 'contact_collection', 'visit_scheduling', 'owner_checking', 'time_confirm'].includes(s)) {
      const id = session.slots.interestedPropertyId ?? session.slots.propertyId;
      if (!id) return [];
      const p = await this.deps.properties.getById(id);
      if (!p) return [];
      await this.landmarks.enrich([p]);
      return [p];
    }
    return [];
  }

  // ---------------- outbound ----------------

  private async sendRaw(session: ChatSession, text: string, source = 'deterministic'): Promise<void> {
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
    await this.deps.channels.send(session.channel, session.chatId, text, source);
  }
}
