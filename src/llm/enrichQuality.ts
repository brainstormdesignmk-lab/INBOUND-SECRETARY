/**
 * Bank enrichment quality gates — shared by the midnight cron (enrichBank.ts)
 * and targeted one-off gap-fills so every write into the bank passes the SAME
 * hygiene rules, no matter which tool performs it.
 *
 * Part 1 (answerWorked) is the OUTCOME check: a learned answer must have
 * WORKED. Heuristic: if the same client re-asked (similar message) within 10
 * minutes after this reply, the answer failed — the client had to try again.
 * Such records go to corrections, never the bank.
 *
 * Part 2 (replyIsClean) is REPLY HYGIENE, mirroring the runtime guard rules
 * (guardText subset, applied BEFORE storage so the bank cannot store what the
 * guard would reject).
 */

/** Trigram similarity over lowercased text (verbatim from enrichBank). */
export function similarity(a: string, b: string): number {
  const trigrams = (s: string): Set<string> => {
    const set = new Set<string>();
    for (let i = 0; i <= s.length - 3; i++) set.add(s.slice(i, i + 3));
    return set;
  };
  const ta = trigrams(a.toLowerCase());
  const tb = trigrams(b.toLowerCase());
  if (ta.size === 0 || tb.size === 0) return 0;
  let inter = 0;
  for (const t of ta) if (tb.has(t)) inter++;
  return inter / (ta.size + tb.size - inter);
}

/**
 * QUALITY GATE (part 1) — outcome check. A learned answer must have WORKED.
 */
export function answerWorked(
  rec: { chatId: string; userMsg: string; createdAt: number },
  all: Array<{ chatId: string; userMsg: string; createdAt: number }>,
): boolean {
  const windowMs = 10 * 60_000;
  for (const other of all) {
    if (other.chatId !== rec.chatId) continue;
    if (other.createdAt <= rec.createdAt || other.createdAt > rec.createdAt + windowMs) continue;
    if (similarity(other.userMsg, rec.userMsg) > 0.6) return false; // re-ask = failure
  }
  return true;
}

/**
 * QUALITY GATE (part 2) — reply hygiene, mirroring the runtime guard rules
 * (guardText subset, applied BEFORE storage so the bank cannot store what
 * the guard would reject). Returns false when the reply is rejectable.
 */
export function replyIsClean(reply: string): boolean {
  const out = reply.trim();
  if (out.length < 10 || out.length > 600) return false;
  // Language guard: predominantly Cyrillic (30% threshold, same as guardText).
  const cyr = (out.match(/\p{Script=Cyrillic}/gu) ?? []).length;
  const chars = out.replace(/\s/g, '').length;
  if (chars > 20 && cyr / chars < 0.3) return false;
  // Never store links, property paths, or Russian intrusions.
  if (/https?:\/\//.test(out)) return false;
  if (/использу/i.test(out)) return false;
  // MOJIBAKE GUARD: a U+FFFD replacement character means the text was
  // corrupted in transit (encoding/trim). Banking it would serve broken
  // words ("симбо\u{FFFD}\u{FFFD}ичен") to clients forever — reject.
  if (out.includes('\uFFFD')) return false;
  // MIXED-SCRIPT TOKEN GUARD: a single word that fuses Latin and Cyrillic
  // letters ("сеRETURNам", "доBre") is a degenerate LLM generation — the
  // fallback backend (groq) produced exactly such lines when the Gemini keys
  // were 429-exhausted. A Cyrillic-dominant line passes the 30% language
  // guard while still carrying broken tokens; this catches it structurally.
  // Tokens are split on non-letters; a token containing BOTH scripts rejects.
  {
    const mixed = out.split(/[^\p{L}]+/u).some(
      (tok) => /\p{Script=Cyrillic}/u.test(tok) && /\p{Script=Latin}/u.test(tok),
    );
    if (mixed) return false;
  }
  // ALL-CAPS LATIN GUARD: an all-caps Latin word of 4+ letters inside a
  // Cyrillic line ("други PONUDI во") is degenerate code-switching, not a
  // brand. Real Latin brands are short acronyms (TTK, KAM) or mixed-case
  // (Beverly Hills, TTK Banka, Hotel Tourist) — all stay. Split into words,
  // a lone caps-Latin word ≥4 chars rejects.
  {
    const words = out.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
    if (words.some((w) => w.length >= 4 && /^\p{Lu}+$|^\p{Lu}[\p{Lu}\p{Nd}]*$/u.test(w) && !/\p{Script=Cyrillic}/u.test(w))) {
      return false;
    }
  }
  // PRICE-DIGIT GUARD: a learned prose line must never carry a price. Facts
  // belong to the property row, which the deterministic layer quotes live.
  // A price in bank prose = a stale EB-specific fact waiting to be served for
  // the WRONG property (the learn.koja-cenata mistake class).
  if (/\d[\d\s.,]{2,}\s*(евра|денари|мкд|eur|evra)/i.test(out)) return false;
  // MARKDOWN GUARD: chat prose, not a formatted report. Reject bold/heading
  // markdown so the bank stores only natural chat lines (learn.kazi-nesto-nego
  // stored **Локација:** bullets — correct facts, wrong format for chat).
  if (/\*\*|^#|^-\\s/m.test(out)) return false;
  // JUNK-PIVOT GUARD: a line that pivots into presenting OTHER properties
  // ("Во меѓувреме, ги издвоив следните достапни предлози…", "Со цел да Ви
  // помогнам… еве ги следните достапни опции…") is presentation-engine
  // behavior, never bank prose — the runtime sanitizer cuts it from replies,
  // so the bank must not store it either. Same regex as the runtime pivot
  // signature in guardText (respond.ts) — keep them in sync.
  if (/(?:Во\s+меѓувреме[^\n]{0,40}?(?:издво|претстав|подготв|пронајд)|ги\s+издвоив\s+следниве|(?:Со\s+цел(?:\s+да)?|За\s+да)\s+В[иі]\s+помогнам[^\n]{0,60}?(?:опции|предлози|имоти)|(?:еве|eve)\s+ги\s+(?:следните|следниве)[^\n]{0,30}?(?:опции|предлози))/iu.test(out)) return false;
  // COMPLETENESS GUARD: a line that ends mid-sentence (no terminal mark) is a
  // truncation artifact (token cap / stream cut). Banking it would serve
  // broken sentences to clients forever. Reject — only complete sentences
  // enter the bank.
  if (!/[.!?…]["')\]]?\s*$/.test(out)) return false;
  return true;
}
