import { LlmClient } from './types';
import { AppConfig } from '../config';
import { ChatSession, assistantTexts } from '../fsm/session';
import { Property } from '../data/properties';
import { State, isFeeAllowed } from '../fsm/machine';
import { fallbackVariant, pickVariant } from '../data/responseBank';
import { SYSTEM_PROMPT, stateTask, FALLBACKS, buildPropertyContext, buildPropertyCards, buildDiscoveryAsk, buildFeeAsk, buildContactAsk, feePersuasion, FIRST_QUESTIONS_PREFIX, LAST_INFO_PREFIX } from './prompts';

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
  return out;
}

/** A reply plus where it came from — so the TUI can show which brain produced
 *  it: 'deterministic' (code-built, no LLM call), 'gemini:1..3'/'groq' (LLM
 *  prose), or 'fallback' (LLM attempted, failed, code-built line used). */
export interface RespondResult {
  text: string;
  source: string;
}

export class Responder {
  constructor(private llm: LlmClient, private cfg: AppConfig) {}

  /** Swap the brain at runtime (TUI chooser: gemini/groq/llm-free). */
  setLlm(llm: LlmClient): void {
    this.llm = llm;
  }

  async respond(session: ChatSession, properties: Property[], userText: string): Promise<RespondResult> {
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
    try {
      const text = await this.llm.complete({
        role: 'respond',
        messages,
        temperature: this.cfg.personaTemp,
        maxTokens: this.cfg.maxTokens,
        topP: this.cfg.topP,
        onProvider: p => { provider = p; },
      });
      return { text: guardText(session.state, text, this.cfg.publicSiteUrl, assistantTexts(session)), source: provider ?? 'llm' };
    } catch (e) {
      console.error('[respond] LLM failed:', (e as Error).message);
      // LLM-less fallback: property data is code-built (never invented), so the
      // bot still presents REAL offers when every LLM is down.
      if ((session.state === 'property_query' || session.state === 'presentation') && properties.length > 0) {
        // closerIndex = conversation progress -> consecutive presentations get
        // DIFFERENT closing questions (the same one every time reads robotic).
        // "Било каде" searches pass anywhere+budget so the LLM-free cards open
        // with the descriptive offering ("…до {budget} евра, почнувајќи од
        // најбараните населби…") instead of the generic opener.
        return { text: guardText(session.state,
          buildPropertyCards(properties, session.state, session.history.length, assistantTexts(session), {
            anywhere: session.slots.anywhere,
            budget: session.slots.budget,
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
}
