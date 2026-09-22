/**
 * bankConstraints — P1 of the closed-loop bank plan (docs/bank-closed-loop-plan.md).
 *
 * A per-key CONTRACT that constrains every Gemini generation that can touch
 * the bank: enrichBank (gapfill + learned variants + new learn.* keys), the
 * P2 relearn, P4 fallback-key writing, and the runtime fallback. Two sides:
 *
 *   MUST   — facts/shape the answer has to carry (checked post-generation)
 *   FORBID — claims that must never appear (hard vetoes)
 *   plus mustEndWithQuestion / maxLength / allowedAmounts
 *
 * Design rule: contracts are cut to fit the HUMAN SEEDS, never the reverse.
 * The seeds were audited before these numbers were frozen (see
 * scripts/audit-seeds.ts): every fee.* seed carries a sanctioned fee figure,
 * 100% of fee/contact seeds end in a question, none exceed 320 chars, and
 * fee.why deliberately carries NO figures (it explains the why, not the
 * amount). Keys without an entry get the BASELINE contract — there is no
 * generic unconstrained prompt anymore.
 *
 * The amount veto is code-level, not a regex list: any currency amount in a
 * candidate must belong to the key's `allowedAmounts` (empty for most keys —
 * data-driven carrier prose never contains digits; the actual price is
 * filled from the property row at serve time as {price}).
 */

export interface KeyConstraint {
  /** Every regex MUST match the candidate. */
  mustInclude?: RegExp[];
  /** At least ONE regex must match (e.g. either fee-figure wording). */
  mustIncludeAny?: RegExp[];
  /** Hard vetoes — any match rejects the candidate. */
  forbid?: RegExp[];
  /** Candidate must end with a question mark (funnel shape). */
  mustEndWithQuestion?: boolean;
  /** Character budget. */
  maxLength?: number;
  /** Normalized amounts the key may name, e.g. '500:den', '10:eur'. */
  allowedAmounts?: string[];
  /** Human explanation, shown in prompts and audit output. */
  note?: string;
}

// --- Shared regex fragments (Cyrillic-first, script-agnostic where possible) ---

/** Sanctioned fee figures — the ONLY amounts a fee key may name. */
const FEE_FIGURE_RE = /(?<!\d)(?:500\s*денари|10\s*евра|300\s*денари|5\s*евра)(?!\d)/iu;

/** The sanctioned fee amounts, normalized (see normalizeAmount). */
const FEE_ALLOWED_AMOUNTS = ['500:den', '10:eur', '300:den', '5:eur'];

/** Any currency amount: digits + currency unit (Cyrillic and Latin). */
const AMOUNT_RE = /(\d[\d.,]*)\s*(денари|ден|евра|евро|denari|den\.?|evra|evr|eur)(?![\p{L}])/giu;

/** BASELINE FORBID — applies to every key, on top of per-key forbids.
 *  Calibrated against the human seeds (audit-seeds run, 2026-09-22):
 *  — promise stems must not match inside по̄светуваме/посветен (attention
 *    framing is sanctioned seed vocabulary), so ветува/garantiram carry a
 *    not-preceded-by-letter guard;
 *  — the guarantee veto targets OUTCOME guarantees (availability, price,
 *    "гарантирам дека…") — service-quality framing ("Ви гарантира
 *    посветена услуга") is sanctioned seed wording and stays legal. */
const BASELINE_FORBID: RegExp[] = [
  /(?<![\p{L}])ветува|обеќавам|(?<![\p{L}])garantiram/iu,        // "I promise"
  /гарант[\p{L}]*\s+(?:дека\b|достап|слобод|најевтин|цен)/iu,     // guarantee + outcome
  /garant[\p{L}]*\s+(?:that\b|available|cheapest|price)/iu,
  /сто\s*%?\s*сигур|100%\s*сигур/i,                  // "100% sure"
  /сигурно\s+е\s+достапен|достапноста\s+е\s+100/i,   // availability promises
  // NOTE: no superlative veto — price.* seeds legitimately say
  // "најевтините во таа населба" (a data-backed, scoped claim from the
  // sorted offer). An UNSCOPED superlative promise would be caught by the
  // guarantee+outcome rules above.
];

const BASELINE_MAX_LENGTH = 420;

// --- Contracts ---

const FEE_CONTRACT: KeyConstraint = {
  mustIncludeAny: [FEE_FIGURE_RE],
  mustEndWithQuestion: true,
  forbid: [/нотар|адвокат|нотар/],
  maxLength: BASELINE_MAX_LENGTH,
  allowedAmounts: FEE_ALLOWED_AMOUNTS,
  note: 'must name the visit fee (500 денари / 10 евра, or the 300 денари / 5 евра wording), must end with a question; NEVER any other amount, promise, or notary/lawyer cost claims',
};

const CONTACT_REFUSAL_CONTRACT: KeyConstraint = {
  mustEndWithQuestion: true,
  forbid: [/тел[её]фон[от]?[:\s]*\d{3}/],
  maxLength: BASELINE_MAX_LENGTH,
  allowedAmounts: [],
  note: 'privacy refusal + offer to contact the owner and report back; must end with a question; NEVER include any phone number',
};

/**
 * Per-key contracts. Keys not listed here get BASELINE (see constraintsFor).
 */
export const BANK_CONSTRAINTS: Record<string, KeyConstraint> = {
  'fee.ask.buy': FEE_CONTRACT,
  'fee.ask.rent': FEE_CONTRACT,
  'fee.persuade.1.buy': FEE_CONTRACT,
  'fee.persuade.1.rent': FEE_CONTRACT,
  'fee.persuade.2.buy': FEE_CONTRACT,
  'fee.persuade.2.rent': FEE_CONTRACT,
  // fee.why explains WHY the fee exists — its seeds carry no figures, so
  // requiring one would force the generator off-family.
  'fee.why': {
    mustEndWithQuestion: true,
    forbid: [/нотар|адвокат/],
    maxLength: BASELINE_MAX_LENGTH,
    allowedAmounts: FEE_ALLOWED_AMOUNTS,
    note: 'explains why the visit fee exists (filter for serious clients); must end with a question; figures allowed but never required',
  },
  'owner.contact.refusal': CONTACT_REFUSAL_CONTRACT,
  'owner.contact.protocol': CONTACT_REFUSAL_CONTRACT,
  // The provision family's JOB is to name the buyer's side: 0% commission,
  // the visit fee, and the buyer's own notary/advocate/legal obligations —
  // so the FEE_CONTRACT notary veto must NOT apply here.
  'provision.ask.buy': {
    mustIncludeAny: [FEE_FIGURE_RE],
    maxLength: BASELINE_MAX_LENGTH + 80,   // seeds enumerate the buyer obligations
    allowedAmounts: FEE_ALLOWED_AMOUNTS,
    note: 'buyer pays 0% commission; the only cost is the visit fee (sanctioned figures); may enumerate the buyer\'s own legal obligations; never any other amount',
  },
};

// --- API ---

/** The contract for a key — baseline for anything unlisted. */
export function constraintsFor(key: string): KeyConstraint {
  return BANK_CONSTRAINTS[key] ?? {
    forbid: [],
    maxLength: BASELINE_MAX_LENGTH,
    allowedAmounts: [],
    note: 'baseline: no promises, no amounts, no guarantees',
  };
}

/** Normalize an amount match to 'number:unit' for allow-list comparison. */
function normalizeAmount(digits: string, unit: string): string {
  const n = parseInt(digits.replace(/[.,\s]/g, ''), 10);
  const u = /денари|ден|den/i.test(unit) ? 'den' : 'eur';
  return `${n}:${u}`;
}

/**
 * All violations of the key's contract by `text` — empty array = pass.
 * Human-readable reasons, suitable for corrections trays and logs.
 */
export function violationsFor(text: string, key: string): string[] {
  const c = constraintsFor(key);
  const v: string[] = [];
  if (c.maxLength && text.length > c.maxLength) v.push(`length ${text.length} > ${c.maxLength}`);
  if (c.mustEndWithQuestion && !/\?\s*$/.test(text.trim())) v.push('does not end with a question');
  if (c.mustIncludeAny && !c.mustIncludeAny.some(re => re.test(text))) v.push('missing required fact (fee figure)');
  for (const re of c.mustInclude ?? []) if (!re.test(text)) v.push(`missing required: /${re.source.slice(0, 40)}/`);
  for (const re of [...BASELINE_FORBID, ...(c.forbid ?? [])]) {
    if (re.test(text)) v.push(`forbidden content: /${re.source.slice(0, 40)}/`);
  }
  for (const m of text.matchAll(AMOUNT_RE)) {
    const norm = normalizeAmount(m[1], m[2]);
    if (!(c.allowedAmounts ?? []).includes(norm)) v.push(`unsanctioned amount "${m[0].trim()}"`);
  }
  return v;
}

/**
 * The instruction block injected into every generation prompt for this key.
 * This is what replaces the generic prompt — "Gemini within constraints".
 */
export function renderPromptBlock(key: string): string {
  const c = constraintsFor(key);
  const lines: string[] = ['HARD CONSTRAINTS for this response (violations are rejected before storage):'];
  if (c.mustIncludeAny?.length) lines.push('- You MUST mention the visit fee: 500 денари (10 евра), or the wording 300 денари (5 евра).');
  for (const re of c.mustInclude ?? []) lines.push(`- You MUST include: ${re.source.slice(0, 60)}`);
  if (c.mustEndWithQuestion) lines.push('- The response MUST end with a question to the client.');
  if ((c.allowedAmounts ?? []).length > 0) {
    lines.push('- These are the ONLY amounts allowed: ' + (c.allowedAmounts ?? []).map(a => a.replace(':den', ' денари').replace(':eur', ' евра')).join(', ') + '.');
  } else {
    lines.push('- NEVER state any specific price or amount. If a price is needed, use the {price} placeholder — it is filled from the property record.');
  }
  lines.push('- NEVER promise availability, a discount, a guarantee, or a future action you cannot control.');
  if (c.forbid?.length) lines.push('- NEVER mention: ' + c.forbid.map(re => re.source.slice(0, 30)).join(', ') + '.');
  lines.push(`- Maximum ${c.maxLength} characters.`);
  return lines.join('\n');
}

/** Validate a batch of candidates; partition into kept / rejected-with-reasons. */
export function validateBatch(key: string, candidates: string[]): {
  kept: string[];
  rejected: Array<{ text: string; reasons: string[] }>;
} {
  const kept: string[] = [];
  const rejected: Array<{ text: string; reasons: string[] }> = [];
  for (const text of candidates) {
    const reasons = violationsFor(text, key);
    if (reasons.length === 0) kept.push(text);
    else rejected.push({ text, reasons });
  }
  return { kept, rejected };
}
