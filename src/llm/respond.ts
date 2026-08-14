import { LlmClient } from './types';
import { AppConfig } from '../config';
import { ChatSession } from '../fsm/session';
import { Property } from '../data/properties';
import { State, isFeeAllowed } from '../fsm/machine';
import { SYSTEM_PROMPT, stateTask, FALLBACKS, buildPropertyContext, buildPropertyCards, buildDiscoveryAsk, buildFeeAsk, feePersuasion } from './prompts';

// Anchored so a property price like "68.300 евра" never trips it — only a
// STANDALONE 300/600 (the viewing fee) matches. Unicode-aware end boundary
// (JS \b fails after Cyrillic).
const FEE_RE = /(?<![\d.,])(300|600)\s*(мкд|ден\.?|денари|евра|eur)(?![\p{L}\p{N}])/iu;

// Owner-contact / phone-collection language is ONLY legal after the fee is
// agreed (contact_collection onward). Before that the LLM must never jump
// ahead — "морам да го контактирам сопственикот, дајте телефон" skips the
// fee disclosure the client must agree to first.
const OWNER_JUMP_RE = /(морам да го контактирам|ќе го контактирам|да го контактирам|контактирам со сопственикот|прашам го сопственикот|телефонски број|телефон за контакт|број за контакт|кажете ми го вашиот телефон|дајте ми го вашиот телефон|име и телефонски|име и презиме и телефон)/i;
const OWNER_JUMP_ALLOWED = new Set(['contact_collection', 'visit_scheduling', 'owner_checking', 'time_confirm', 'pending', 'queued']);

export function guardText(state: State, text: string, publicSiteUrl?: string): string {
  let out = text.trim();
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
  // Hard rule: the viewing fee must NEVER appear before the client is interested.
  if (!isFeeAllowed(state) && FEE_RE.test(out)) {
    console.warn(`[guard] fee mention blocked in state "${state}"`);
    return FALLBACKS[state] ?? FALLBACKS.default;
  }
  // The owner ping-pong only starts AFTER the fee is agreed — before
  // contact_collection the LLM must never promise to contact the owner or ask
  // for the phone (that is the funnel's job, in order: fee -> contact -> time).
  if (!OWNER_JUMP_ALLOWED.has(state) && OWNER_JUMP_RE.test(out)) {
    console.warn(`[guard] owner-contact/phone ask blocked in state "${state}"`);
    return FALLBACKS[state] ?? FALLBACKS.default;
  }
  // Terminology: "ID"/"ИД" is forbidden in outbound chat. NOTE: JS \b only
  // knows ASCII word chars, so Cyrillic needs an explicit Unicode boundary.
  out = out.replace(/(?<![\p{L}\p{N}])ИД(?![\p{L}\p{N}])/gu, 'Евидентен број')
           .replace(/\bID\b/g, 'Евидентен број');
  // Casing of "Евидентен број" is enforced by the guard, not trusted to the LLM.
  out = out.replace(/евидентен\s+број/gi, 'Евидентен број');
  // Known Russian intrusion the model has slipped — deterministic fix.
  out = out.replace(/использу(ется|ат|ва|ваат|е|јќи|јќи)\w*/gi, 'користење')
           .replace(/использован\w*/gi, 'користење');
  // Property prices are quoted in EUROS, never denars. The viewing fee
  // (300/600 денари) is always < 1000, so any "N денари" with N >= 1000 is a
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

export class Responder {
  constructor(private llm: LlmClient, private cfg: AppConfig) {}

  async respond(session: ChatSession, properties: Property[], userText: string): Promise<string> {
    // The discovery ask is deterministic: it only asks for what is still
    // missing and NEVER re-asks the intent once it is known — "ми треба стан"
    // means BUY, so the generic buy/rent battery never fires.
    if (session.state === 'idle' || session.state === 'intent' || session.state === 'discovery') {
      return guardText(session.state, buildDiscoveryAsk(session.slots), this.cfg.publicSiteUrl);
    }
    // The fee disclosure is deterministic: the moment the client shows interest
    // in visiting (INTERESTED -> closing), the fee is asked CODE-BUILT — never
    // LLM prose, so it can't be skipped or paraphrased. Refusals use the
    // persuasion ladder; agreement moves to contact_collection (owner contact).
    if (session.state === 'closing') {
      const rejects = session.slots.feeRejections ?? 0;
      const line = rejects > 0
        ? feePersuasion(session.slots.service, rejects)
        : buildFeeAsk(session.slots.service);
      return guardText(session.state, line, this.cfg.publicSiteUrl);
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
    try {
      const text = await this.llm.complete({
        role: 'respond',
        messages,
        temperature: this.cfg.personaTemp,
        maxTokens: this.cfg.maxTokens,
        topP: this.cfg.topP,
      });
      return guardText(session.state, text, this.cfg.publicSiteUrl);
    } catch (e) {
      console.error('[respond] LLM failed:', (e as Error).message);
      // LLM-less fallback: property data is code-built (never invented), so the
      // bot still presents REAL offers when every LLM is down.
      if ((session.state === 'property_query' || session.state === 'presentation') && properties.length > 0) {
        // closerIndex = conversation progress -> consecutive presentations get
        // DIFFERENT closing questions (the same one every time reads robotic).
        return guardText(session.state,
          buildPropertyCards(properties, session.state, session.history.length),
          this.cfg.publicSiteUrl);
      }
      return FALLBACKS[session.state] ?? FALLBACKS.default;
    }
  }
}
