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
  // VOCABULARY (owner rule, 2026-10-19): "имот" means land/a plot in this
  // agency's usage; the general noun in every client answer is "недвижност".
  // Keep the document term "имотен лист" out of the veto via the negative
  // lookahead on the stem ending.
  /(?:^|[^\p{L}])имот(?:от|ите|и)?(?![\p{L}])/iu,
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
  // The ladder rung ABOVE the first persuasion: the AGENCY RULE. It states
  // that the fee is the agency's published policy (ценовник/правило), the same
  // for every client — amount-free on purpose (the sum was already disclosed
  // in the fee.ask; repeating it here re-opens the price debate) and ending
  // with the agreement ask so the funnel keeps moving.
  'fee.rule.hold': {
    mustIncludeAny: [/(?:правил|политик|ценовник|деловник)/iu],
    mustEndWithQuestion: true,
    forbid: [/нотар|адвокат/],
    maxLength: BASELINE_MAX_LENGTH,
    allowedAmounts: FEE_ALLOWED_AMOUNTS,
    note: 'states the visit fee as the agency\'s published rule/price list, the same for every client; must end with a question; figures allowed but never required',
  },
  // The FINAL rung: the binary decision. Nothing to persuade — the client is
  // asked to decide, and the answer drives the funnel (yes → contact
  // collection, no → the graceful close). Owner-specified wording; no figures
  // and no new arguments live here. NOTE the shape: unlike every other fee key
  // the decision line does NOT end on the question — the question mark sits
  // mid-line and the line closes on the ownership statement (the owner's
  // "…или не? Одлуката е Ваша."), so mustEndWithQuestion is deliberately absent.
  'fee.decide': {
    mustInclude: [/дали\s+да\s+(?:ја\s+)?закажам/iu],
    mustIncludeAny: [/(?:одлуката е ваша|ваша е одлуката|вие одлучувате|решението е ваше)/iu],
    forbid: [/нотар|адвокат/],
    maxLength: BASELINE_MAX_LENGTH,
    allowedAmounts: FEE_ALLOWED_AMOUNTS,
    note: 'the binary decision question (book the visit under the stated conditions, or not) + the ownership of the decision; the answer decides the funnel — yes → contact collection, no → the graceful close',
  },
  // ── The RENT-COMMISSION ladder (the second money topic) ──────────────────
  // Same protocol shape as the fee ladder, its own copy and its own counter.
  // The rent tier rule may be restated (the client is arguing about a figure),
  // so 50% is REQUIRED on the persuasion rung; the only sanctioned figure
  // anywhere in this family is the 1.000 eur tier threshold — a filled-in
  // commission number would be a bug (the live amount lives in rent.math.*,
  // computed at serve time).
  'provision.persuade.1.rent': {
    mustIncludeAny: [/50\s*%|педесет\s*процент/i],
    mustEndWithQuestion: true,
    // The persuasion must state the value AND the tier rule — that reads
    // longer than the fee rung (the fee asks for one figure, this one for a
    // figure plus the whole service framing), so the key carries its own
    // budget. Contract follows the human seeds, never the reverse.
    maxLength: BASELINE_MAX_LENGTH + 140,
    allowedAmounts: ['1000:eur'],
    note: 'ONE value persuasion for the rent commission (a one-off that covers the whole rental process: vetted offers, owner coordination, legal check, contract); must restate the 50% tier and end with the agreement ask; the 1.000 eur tier threshold is the only sanctioned figure',
  },
  'provision.rule.hold': {
    mustIncludeAny: [/(?:правил|политик|ценовник|деловник)/iu],
    mustEndWithQuestion: true,
    maxLength: BASELINE_MAX_LENGTH,
    allowedAmounts: ['1000:eur'],
    note: 'the rent commission as the agency\'s published rule/price list, the same for every tenant, not the agent\'s personal decision; must end with a question',
  },
  // Same house sentence as fee.decide, for the commission: the binary
  // continue-or-not question (mid-line) and the ownership of the decision, kept
  // verbatim so the client hears ONE protocol. Only the opener before it may
  // vary (see the generation spec).
  'provision.decide': {
    mustInclude: [/дали\s+да\s+продолжиме\s+по\s+наведените\s+услови\s+или\s+не/iu],
    mustIncludeAny: [/одлуката\s+е\s+ваша/iu],
    maxLength: BASELINE_MAX_LENGTH,
    allowedAmounts: ['1000:eur'],
    note: 'the binary decision for the commission terms (continue under the stated conditions, or not) + ownership of the decision; the question mark sits mid-line, so mustEndWithQuestion is deliberately absent',
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
  // COMMISSION TIERS (owner rule): the textual rent-provision answer states
  // the WHOLE tier rule, so the 1.000 threshold is sanctioned vocabulary.
  // Live numbers ({r}/{c}/{d}/{t}) are computed at serve time and live only
  // in the rent.math.* keys — a filled number here would be a bug upstream.
  'provision.ask.rent': {
    mustIncludeAny: [/50\s*%|педесет процент|половин/i],
    allowedAmounts: ['1000:eur'],
    maxLength: BASELINE_MAX_LENGTH + 80,
    note: 'rent commission tiers: 50% below 1.000 eur, one full monthly rent at 1.000+ eur; owner payload (first month + deposit) unchanged; the only sanctioned figure is the 1.000 threshold',
  },
  // The rent-math breakdown keys: every real number arrives via {r}/{c}/{d}/{t}
  // placeholders (computed by computeRentMath); the only literal figure allowed
  // is the tier threshold 1.000 eur named in the wording.
  'rent.math.check': {
    allowedAmounts: ['1000:eur'],
    maxLength: BASELINE_MAX_LENGTH + 80,
    note: 'LOW tier math (< 1000 eur): agency = half the rent ({c}), owner = rent×2 ({d}), total = rent×2.5 ({t}); computed at serve time — never a hardcoded amount',
  },
  'rent.math.check.high': {
    allowedAmounts: ['1000:eur'],
    maxLength: BASELINE_MAX_LENGTH + 80,
    note: 'HIGH tier math (>= 1000 eur): agency = one full monthly rent ({c}), owner = rent×2 ({d}), total = rent×3 ({t}); computed at serve time — never a hardcoded amount',
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
  lines.push('- NEVER use the word „имот“ — it means land/a plot here. Write „недвижност“ for any property.');
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
