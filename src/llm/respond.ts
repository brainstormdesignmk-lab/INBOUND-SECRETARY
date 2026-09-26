import { LlmClient } from './types';
import { AppConfig } from '../config';
import { ChatSession, assistantTexts } from '../fsm/session';
import { Property } from '../data/properties';
import { State, isFeeAllowed } from '../fsm/machine';
import { fallbackVariant, pickVariant, retrieveVariant, getLearnedBank } from '../data/responseBank';
import { dynamicAnswer } from './dynamicFallback';
import { SYSTEM_PROMPT, stateTask, FALLBACKS, buildPropertyContext, buildPropertyCards, buildDiscoveryAsk, buildFeeAsk, buildContactAsk, feePersuasion, waiverAck, FIRST_QUESTIONS_PREFIX, LAST_INFO_PREFIX } from './prompts';
import { detectInvestmentOpinion, detectFeeWhy, detectRemark } from './deterministic';

// Anchored so a property price like "68.300 евра" never trips it — only a
// STANDALONE 300/500/600 in денари (the viewing fee; buy is 500, rent 300)
// matches. Units are денари/мкд only: a real rent price of "500 евра" (EB 56)
// must never be mistaken for the fee. Unicode-aware end boundary (JS \b fails
// after Cyrillic).
const FEE_RE = /(?<![\d.,])(300|500|600)\s*(мкд|ден\.?|денари)(?![\p{L}\p{N}])/iu;

// Owner-contact / phone-collection language is ONLY legal after the fee is
// agreed (contact_collection onward). Before that the LLM must never jump
// ahead — "морам да го контактирам сопственикот, дајте телефон" skips the
// fee disclosure the client must agree to first.
const OWNER_JUMP_RE = /(морам да го контактирам|ќе го контактирам|да го контактирам|контактирам со сопственикот|прашам го сопственикот|телефонски број|телефон за контакт|број за контакт|кажете ми го вашиот телефон|дајте ми го вашиот телефон|име и телефонски|име и презиме и телефон)/i;
const OWNER_JUMP_ALLOWED = new Set(['contact_collection', 'visit_scheduling', 'owner_checking', 'time_confirm', 'pending', 'queued']);

export function guardText(state: State, text: string, publicSiteUrl?: string, recent?: string[]): string {
  let out = text.trim();
  // Strip property links FIRST — the URL contains non-Cyrillic characters
  // that would trigger the language guard below if not removed first.
  // Property info is described IN THE CHAT with words from the database — links
  // to the public page are NEVER shown. Deterministically strip any link the
  // model still emits: "Повеќе информации: <url>" phrases (bold or plain),
  // full /property/ URLs, and bare /property/ paths.
  if (publicSiteUrl) {
    const host = publicSiteUrl.replace(/^https?:\/\//i, '').replace(/\/+$/, '')
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`https?:\\/\\/${host}(?:\\/[^\\s)\\]»]*)?`, 'gi'), '');
  }
  out = out
    .replace(/\*{0,2}Повеќе информации:\*{0,2}\s+\S+/gi, '') // label + whatever follows (URL / bare path / domain)
    .replace(/\*{0,2}Повеќе информации:\*{0,2}/gi, '')          // dangling label alone
    .replace(/https?:\/\/[^\s)\]»]*\/property\/[^\s)\]»]*/gi, '') // property URL without the label
    .replace(/\/property\/[0-9a-zA-Z-]{8,}/g, '')               // bare /property/ path
    .replace(/[ \t]{2,}/g, ' ');
  // LANGUAGE GUARD: Lina speaks Macedonian only. If the LLM emits
  // predominantly non-Cyrillic text (English hallucination, language
  // switching), reject the entire response and use the deterministic
  // fallback. The 30% threshold allows Latin-script Macedonian and short
  // English words (OK, EUR, MKD) that naturally appear.
  const cyrillicCount = (out.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  const charCount = out.replace(/\s/g, '').length;
  if (charCount > 20 && cyrillicCount / charCount < 0.3) {
    console.warn(`[guard] language rejected (${cyrillicCount}/${charCount} Cyrillic) — using fallback`);
    return fallbackVariant(state, recent) ?? FALLBACKS[state] ?? FALLBACKS.default;
  }
  // Hard rule: the viewing fee must NEVER appear before the client is interested.
  if (!isFeeAllowed(state) && FEE_RE.test(out)) {
    console.warn(`[guard] fee mention blocked in state "${state}"`);
    return fallbackVariant(state, recent) ?? FALLBACKS[state] ?? FALLBACKS.default;
  }
  // The owner ping-pong only starts AFTER the fee is agreed — before
  // contact_collection the LLM must never promise to contact the owner or ask
  // for the phone (that is the funnel's job, in order: fee -> contact -> time).
  if (!OWNER_JUMP_ALLOWED.has(state) && OWNER_JUMP_RE.test(out)) {
    console.warn(`[guard] owner-contact/phone ask blocked in state "${state}"`);
    return fallbackVariant(state, recent) ?? FALLBACKS[state] ?? FALLBACKS.default;
  }
  // Terminology: "ID"/"ИД" is forbidden in outbound chat. NOTE: JS \b only
  // knows ASCII word chars, so Cyrillic needs an explicit Unicode boundary.
  out = out.replace(/(?<![\p{L}\p{N}])ИД(?![\p{L}\p{N}])/gu, 'Евидентен број')
           .replace(/\bID\b/g, 'Евидентен број');
  // Casing of "Евидентен број" is enforced by the guard, not trusted to the LLM.
  out = out.replace(/евидентен\s+број/gi, 'Евидентен број');
  // The two question-prefix flourishes ("Супер. Уште неколку прашања.",
  // "Одлично, уште последниве информации и завршуваме.") are CODE-BUILT at
  // most once each — the LLM must never repeat them (that was the overuse:
  // every question in the collecting phase carried one). Strip any occurrence
  // from LLM prose; the code-built ask builders add them at the right spot.
  out = out
    .replace(/Супер[.,!]?\s*Уште неколку прашањ[ае]?[.,!]?\s*/gi, '')
    .replace(/Уште неколку прашањ[ае]?[.,!]?\s*/gi, '')
    .replace(/Одлично[.,]?\s*[Уу]ште последниве информации и завршуваме[.,!]?\s*/gi, '')
    .replace(/[Уу]ште последниве информации и завршуваме[.,!]?\s*/gi, '');
  // Known Russian intrusion the model has slipped — deterministic fix.
  out = out.replace(/использу(ется|ат|ва|ваат|е|јќи|јќи)\w*/gi, 'користење')
           .replace(/использован\w*/gi, 'користење');
  // Property prices are quoted in EUROS, never denars. The viewing fee
  // (300/500/600 денари) is always < 1000, so any "N денари" with N >= 1000 is a
  // mislabeled property price — fix the unit word. (Unicode boundary — JS \b
  // fails after Cyrillic.)
  out = out.replace(/(\d[\d\s.,]*)\s*(денари|ден\.)(?![\p{L}\p{N}])/giu, (m: string, num: string) => {
    const n = parseInt(num.replace(/[\s.,]/g, ''), 10);
    return Number.isFinite(n) && n >= 1000 ? `${num.trim()} евра` : m;
  });
  // Sanitize: strip anything outside Macedonian Cyrillic / Latin / numbers /
  // punctuation — kills tokenizer garbage (e.g. "顶") and mixed-script junk.
  // \n\r\t are kept explicitly: \n is a control char (not \p{Z}), so without
  // them the code-built property cards collapsed into one unreadable run-on.
  out = out.replace(/[^\p{Script=Cyrillic}\p{Script=Latin}\p{N}\p{P}\p{Z}\p{Sc}\n\r\t]/gu, '')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();
  // JUNK-PIVOT CUT: the model often tacks "Во меѓувреме, ги издвоив следните
  // достапни предлози…" (or "Со цел да Ви помогнам… еве ги следните достапни
  // опции…**Евидентен број 63**") onto an unrelated answer and starts listing
  // OTHER properties the client never asked about — the [10:50] GLUPOSTI
  // transcript: a policy complaint answered, then an EB-63 card bolted on.
  // That pivot is the presentation engine's job — strip it and everything
  // after it deterministically. Also strips the '**Евидентен број' bullet-list
  // spawn that followed it.
  // STATE AWARENESS: in presentation/property_locate a pivot into listings IS
  // the reply — there the cut stays conservative (not on line 1, or the
  // "Во меѓувреме" signature anywhere). In every OTHER state (closing,
  // discovery, contact_collection, owner_checking, …) the state's job is never
  // "list properties", so ANY pivot signature anywhere in the reply is junk —
  // the line-1 exemption would preserve a reply that is ENTIRELY a pivot.
  // EXEMPTION (presentation states): the code-built presentation OPENER
  // legitimately contains "ги издвоив следниве неколку опции:" ON LINE 1 of
  // the card reply. The cut therefore only fires when the match is NOT on
  // line 1, OR the junk pivot's signature "Во меѓувреме" appears anywhere (the
  // opener never contains it). Without the exemption the guard randomly ATE
  // the whole fallback card (opener rotated onto the matching phrase →
  // pivotIdx landed inside line 1 → EB card and closer sliced off) — the
  // sources.test.ts flake.
  const pivotIdx = out.search(/(?:Во\s+меѓувреме[^\n]{0,40}?(?:издво|претстав|подготв|пронајд)|ги\s+издвоив\s+следниве|(?:Со\s+цел(?:\s+да)?|За\s+да)\s+В[иі]\s+помогнам[^\n]{0,60}?(?:опции|предлози|имоти)|(?:еве|eve)\s+ги\s+(?:следните|следниве)[^\n]{0,30}?(?:опции|предлози))/iu);
  if (pivotIdx >= 0) {
    const presentationState = state === 'presentation' || state === 'property_locate';
    const firstLineEnd = out.indexOf('\n');
    const inFirstLine = firstLineEnd === -1 || pivotIdx < firstLineEnd;
    const cut = presentationState
      ? pivotIdx > 0 && (!inFirstLine || /во\s+меѓувреме/iu.test(out))
      : true;
    if (cut) {
      out = out.slice(0, pivotIdx).trim();
      if (!out) {
        // The whole reply was a pivot — serve the state's code-built line.
        return fallbackVariant(state, recent) ?? FALLBACKS[state] ?? FALLBACKS.default;
      }
    }
  }
  // TRUNCATED-ENDING REPAIR: an LLM answer that stops mid-sentence (token cap,
  // stream cut) reads broken and must never be served or banked. Cut back to
  // the last sentence-final mark. Punctuation-only fragments ("84 м², и") or
  // trailing link/markdown remnants are dropped with the fragment.
  // COMPLETE-ENDING WHITELIST — these are NOT truncations and pass untouched:
  //   • a URL ("Проверете на https://example.com/x" — ".com" is not a stop)
  //   • a price/amount ending ("…46.000 евра", "…за 5.000")
  //   • a terminal sentence mark
  // When the text HAS a sentence mark but ends unpunctuated (LLM cut), cut to
  // the last VALID mark — never inside a number ("46.000" is one amount),
  // never before a dangling conjunction ("…стан и" keeps cutting back).
  // When there is NO mark at all: a content-word ending is a complete short
  // phrase ("има и 5.000 евра кирија", "300 денари за разгледување") → pass;
  // a dangling ending (conjunction/copula/single letter: "…спални и",
  // "…дали ова е") is truly mid-clause → reject to the fallback line.
  const endsWithURL = /https?:\/\/\S+$/i.test(out);
  const endsWithAmount = /(?:[\d.,]+\s*(?:евра|евро|денари|ден\.|мкд|%|м²|м2|m²|m2)|\d|\))["')\]]?\s*$/iu.test(out);
  const terminal = /[.!?…]["')\]]?\s*$/.test(out);
  if (out.length > 0 && !endsWithURL && !endsWithAmount && !terminal) {
    const dangling = /(?:^|\s)(?:и|или|со|за|на|во|но|што|од|е|а|до|по|при|без|ke|i|ili|so|za|na|vo|no|shto|od|e|a)\s*$/iu.test(out)
      || /\s\p{L}\s*$/u.test(out);
    if (!/[.!?…]/.test(out)) {
      if (dangling) {
        console.warn(`[guard] truncated reply (no complete sentence) rejected`);
        return fallbackVariant(state, recent) ?? FALLBACKS[state] ?? FALLBACKS.default;
      }
      // short complete phrase — untouched
    } else {
      let lastStop = -1;
      for (const mark of ['.', '!', '?', '…']) {
        let from = out.length;
        for (;;) {
          const i = out.lastIndexOf(mark, from - 1);
          if (i < 0) break;
          const tail = out.slice(i + 1);
          // a stop followed by more digits/amount text is INSIDE a number — skip it
          if (/^\s*[\d.,]/.test(tail) && !/^\s*$/.test(tail)) { from = i; continue; }
          // a stop whose sentence tails off with a conjunction is mid-clause — skip it
          if (/(?:\s(?:и|или|со|за|на|во|но|што|од|ke|i|ili|so|za|na|vo|no|shto|od))\s*$/iu.test(tail)) { from = i; continue; }
          lastStop = Math.max(lastStop, i);
          break;
        }
      }
      if (lastStop >= 0) {
        out = out.slice(0, lastStop + 1).trim();
      } else if (dangling) {
        console.warn(`[guard] truncated reply (no complete sentence) rejected`);
        return fallbackVariant(state, recent) ?? FALLBACKS[state] ?? FALLBACKS.default;
      }
      // else: marks exist only inside numbers/URLs — treat as complete
    }
  }
  return out;
}

/** A reply plus where it came from — so the TUI can show which brain produced
 *  it: 'deterministic' (code-built, no LLM call), 'gemini:1..3'/'groq' (LLM
 *  prose), or 'fallback' (LLM attempted, failed, code-built line used).
 *  escalated=true marks a bank/detector miss that reached the LLM — the
 *  learning loop's signal for "novel question, retire into the bank". */
export interface RespondResult {
  text: string;
  source: string;
  escalated?: boolean;
}

export class Responder {
  private escalationLlm: LlmClient;

  constructor(private llm: LlmClient, private cfg: AppConfig) {
    // Escalation brain defaults to the boot brain; the TUI re-pins it so
    // /brain free never routes escalate() to NoLlm (knowledge-based dispatch).
    this.escalationLlm = llm;
  }

  /** Pin the brain that handles BANK/DETECTOR MISSES. Called once at boot
   *  with a real LLM and NEVER with NoLlm — a miss must reach real
   *  intelligence in every mode, or the system "answers" with a canned
   *  line it knows is wrong. */
  setEscalationLlm(llm: LlmClient): void {
    this.escalationLlm = llm;
  }

  /** Swap the serving brain at runtime (TUI chooser: gemini/groq/llm-free).
   *  This is a COST PREFERENCE for direct prose, never a knowledge ceiling:
   *  when the deterministic layer + bank have no answer, escalate() uses
   *  escalationLlm regardless of this swap. */
  setLlm(llm: LlmClient): void {
    this.llm = llm;
  }

  /**
   * Escalation path for messages the deterministic layer + bank could not
   * answer. Runs the real LLM in EVERY brain mode — including 'free' —
   * because "LLM-free" must mean "zero cost when we KNOW", never "canned
   * answer when we DON'T". The answered pair is queued so the midnight cron
   * retires the novelty into the bank (variants + example → next client
   * asks free). On LLM failure: code-built property cards / fallback line.
   */
  private async escalate(session: ChatSession, properties: Property[], userText: string): Promise<RespondResult> {
    // P-runtime DYNAMIC FALLBACK — the closed-loop bank's runtime half.
    // 1) RECALL: bank_dynamic may already hold a validated answer for this
    //    question shape (0 ms, offline, free).
    // 2) GENERATE: one constrained Gemini call (no facts, P1 baseline +
    //    hygiene validated) — clean answers serve AND store immediately.
    // 3) undefined → the pre-existing escalation path, unchanged.
    const bank = getLearnedBank();
    if (bank) {
      const dyn = await dynamicAnswer(this.escalationLlm, session, userText, bank);
      if (dyn) {
        console.log(`[timing] dynamic ${dyn.source} → ${dyn.key ?? '—'}`);
        return {
          text: guardText(session.state, dyn.text, this.cfg.publicSiteUrl, assistantTexts(session)),
          source: dyn.source,
          escalated: true,
        };
      }
    }
    const task = stateTask(session.state, session.slots);
    const propCtx = buildPropertyContext(properties);
    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      {
        role: 'system' as const,
        content: `CURRENT STATE TASK:\n${task}\n\nRELEVANT PROPERTY DATA (JSON, from the agency database):\n${propCtx}`,
      },
      ...session.history.slice(-10).map(m => ({ role: m.role, content: m.text })),
      { role: 'user' as const, content: userText },
    ];
    let provider: string | undefined;
    const t0 = Date.now();
    try {
      const text = await this.escalationLlm.complete({
        role: 'respond',
        messages,
        temperature: this.cfg.personaTemp,
        maxTokens: this.cfg.maxTokens,
        topP: this.cfg.topP,
        onProvider: p => { provider = p; },
      });
      const ms = Date.now() - t0;
      console.log(`[timing] respond ${ms}ms → ${provider ?? 'llm'}`);
      return {
        text: guardText(session.state, text, this.cfg.publicSiteUrl, assistantTexts(session)),
        source: provider ?? 'llm',
        escalated: true,
      };
    } catch (e) {
      const ms = Date.now() - t0;
      console.error(`[respond] LLM failed (${ms}ms):`, (e as Error).message);
      // LLM-less fallback: property data is code-built (never invented), so the
      // bot still presents REAL offers when every LLM is down.
      if ((session.state === 'property_query' || session.state === 'presentation') && properties.length > 0) {
        // closerIndex = conversation progress -> consecutive presentations get
        // DIFFERENT closing questions (the same one every time reads robotic).
        // "Било каде" searches pass anywhere+budget so the LLM-free cards open
        // with the descriptive offering ("…до {budget} евра, почнувајќи од
        // најбараните населби…") instead of the generic opener.
        // Size-waiver ack: same once-per-waiver contract as the FSM leg —
        // the ack prefixes only the FIRST post-waiver presentation (the flag
        // is SET here; the caller saves the session after this returns).
        const showWaiverAck = !!session.slots.sizeWaived && !session.slots.waiverAcked;
        if (showWaiverAck) session.slots.waiverAcked = true;
        return { text: guardText(session.state,
          (showWaiverAck
            ? `${waiverAck(session.slots.budget, assistantTexts(session))}\n\n`
            : '')
          + buildPropertyCards(properties, session.state, session.history.length, assistantTexts(session), {
            anywhere: session.slots.anywhere,
            budget: session.slots.budget,
            noOpener: showWaiverAck,
          }),
          this.cfg.publicSiteUrl, assistantTexts(session)), source: 'fallback' };
      }
      return {
        text: fallbackVariant(session.state, assistantTexts(session))
          ?? FALLBACKS[session.state] ?? FALLBACKS.default,
        source: 'fallback',
      };
    }
  }

  async respond(session: ChatSession, properties: Property[], userText: string): Promise<RespondResult> {
    // LAYER 0 — retrieval: every message that reaches respond() already missed
    // the deterministic detectors. Before paying for an LLM call, check the
    // learned bank's example messages — a similar question answered before is
    // served free. (Sub-ms SQLite read; miss costs nothing.)
    // PROTOCOL-STATE EXCLUSION (the [09:25] transcript): in the fee/contact/
    // visit sub-funnel the learned prose is never the right answer — a
    // stored location-confirm template ("Станот со Евидентен број 69 се
    // наоѓа во Центар…", learned from an old LLM slip) served VERBATIM on
    // "dogovori mi" because its example trigram-matched, right after the fee
    // was agreed. These states own deterministic serves (fee ask, contact
    // ask, patience line); retrieval answers only discovery/info states.
    const protocolState = ['closing', 'contact_collection', 'visit_scheduling',
      'owner_checking', 'time_confirm', 'pending', 'queued'].includes(session.state)
      || !!session.slots.viewingFeeAgreed || !!session.slots.ownerContactPending;
    const bankLine = protocolState
      ? undefined
      : retrieveVariant(userText, { recent: assistantTexts(session) });
    if (bankLine) {
      return { text: guardText(session.state, bankLine, this.cfg.publicSiteUrl, assistantTexts(session)), source: 'bank' };
    }
    // The discovery ask is deterministic: it only asks for what is still
    // missing and NEVER re-asks the intent once it is known — a client who
    // never said buy/rent ("ми треба станче") is asked the intent question
    // first, never told they want to buy.
    if (session.state === 'idle' || session.state === 'intent' || session.state === 'discovery') {
      // The discovery ask has NO recap and NO flourish ("Супер. Уште неколку
      // прашања. Разбрав — барате …" repeated what the client just said —
      // "RETARD REPEATING WHAT WAS ASKED"). Only the missing question(s),
      // bank-backed so the wording varies ("Дали може да знам во кој дел…?",
      // "Кажете ми во кој дел…?", "Дали имате дефинирано во која населба…?").
      const base = guardText(session.state, buildDiscoveryAsk(session.slots, assistantTexts(session)), this.cfg.publicSiteUrl, assistantTexts(session));
      return { text: base, source: 'deterministic' };
    }
    // The contact ask is deterministic (like the fee and the visit time): it is
    // phone-aware, always correct, and carries "Одлично, уште последниве
    // информации и завршуваме." ONCE — retries (client gave a bad name) repeat
    // the plain ask so the flourish is never overused.
    if (session.state === 'contact_collection') {
      const n = session.slots.contactAsks ?? 0;
      session.slots.contactAsks = n + 1;
      const base = buildContactAsk(session.slots, assistantTexts(session));
      return { text: n === 0 ? `${LAST_INFO_PREFIX} ${base}` : base, source: 'deterministic' };
    }
    // The fee disclosure is deterministic: the moment the client shows interest
    // in visiting (INTERESTED -> closing), the fee is asked CODE-BUILT — never
    // LLM prose, so it can't be skipped or paraphrased. Refusals use the
    // persuasion ladder; agreement moves to contact_collection (owner contact).
    if (session.state === 'closing') {
      // Digression guard: investment opinions, fee-why questions, conversational
      // remarks ("dobra lokacija ima") and other non-funnel messages must NOT
      // get the fee disclosure — they fall through to the LLM for a contextual
      // response. Without this, the closing state acts as a fee-disclosure
      // black hole that swallows every message (the 22:05 bug).
      const isDigression = detectInvestmentOpinion(userText) || detectFeeWhy(userText) || detectRemark(userText);
      if (!isDigression) {
      // The fee disclosure/persuasion is bank-backed but stays DETERMINISTIC in
      // spirit: every variant was validated at generation time to carry the
      // exact amounts (500/300 денари) and the 0%-commission / "Дали се
      // согласувате" anchors — so the fee can never be skipped or paraphrased
      // into something wrong. The code-built line remains the fallback.
      // The service comes from the slot OR the property itself: a client who
      // jumps straight to an Евидентен број ("sifra 62", "zainteresiran sum
      // za EB 62") never declared buy/rent — the property's own service is the
      // truth, and a RENT property must get the 300-денари script, never the
      // buy 500. (The handler also pins it onto the slot; this fallback keeps
      // the responder correct even when called standalone.)
      const service = session.slots.service ?? properties[0]?.service ?? 'buy';
      const rejects = session.slots.feeRejections ?? 0;
      const key = rejects === 0
        ? (service === 'rent' ? 'fee.ask.rent' : 'fee.ask.buy')
        : rejects === 1
          ? (service === 'rent' ? 'fee.persuade.1.rent' : 'fee.persuade.1.buy')
          : (service === 'rent' ? 'fee.persuade.2.rent' : 'fee.persuade.2.buy');
      const line = pickVariant(key, { recent: assistantTexts(session) })
        ?? (rejects > 0 ? feePersuasion(service, rejects) : buildFeeAsk(service));
      return { text: guardText(session.state, line, this.cfg.publicSiteUrl, assistantTexts(session)), source: 'deterministic' };
      } // end !isDigression — digressions fall through to the LLM below
    }
    // Digression (investment opinion / fee-why / conversational remark) in the
    // closing state falls through HERE and is answered by the LLM — never by a
    // canned line.
    return this.escalate(session, properties, userText);
  }
}
