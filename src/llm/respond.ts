import { LlmClient } from './types';
import { AppConfig } from '../config';
import { ChatSession } from '../fsm/session';
import { Property } from '../data/properties';
import { State, isFeeAllowed } from '../fsm/machine';
import { SYSTEM_PROMPT, stateTask, FALLBACKS, buildPropertyContext, buildPropertyCards, buildDiscoveryAsk } from './prompts';

// Anchored so a property price like "68.300 евра" never trips it — only a
// STANDALONE 300/600 (the viewing fee) matches. Unicode-aware end boundary
// (JS \b fails after Cyrillic).
const FEE_RE = /(?<![\d.,])(300|600)\s*(мкд|ден\.?|денари|евра|eur)(?![\p{L}\p{N}])/iu;

export function guardText(state: State, text: string, publicSiteUrl?: string): string {
  let out = text.trim();
  // Customers need a CLICKABLE link — the feed only has the relative path, and
  // even with a full URL in context the model sometimes copies the bare path.
  // Deterministically prepend the public site to any bare /property/... path.
  if (publicSiteUrl) {
    out = out.replace(/(^|[\s(])\/property\/[0-9a-zA-Z-]{8,}/g,
      (m: string, pre: string) => `${pre}${publicSiteUrl.replace(/\/+$/, '')}${m.slice(pre.length)}`);
  }
  // Hard rule: the viewing fee must NEVER appear before the client is interested.
  if (!isFeeAllowed(state) && FEE_RE.test(out)) {
    console.warn(`[guard] fee mention blocked in state "${state}"`);
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
    const task = stateTask(session.state, session.slots);
    const propCtx = buildPropertyContext(properties, this.cfg.publicSiteUrl);
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
          buildPropertyCards(properties, session.state, this.cfg.publicSiteUrl, session.history.length),
          this.cfg.publicSiteUrl);
      }
      return FALLBACKS[session.state] ?? FALLBACKS.default;
    }
  }
}
