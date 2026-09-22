/**
 * MISROUTE DETECTION — giving the router eyes (2026-09-22).
 *
 * The problem: a bank answer served under the WRONG key looks identical to a
 * right-key serve in every log we keep. The router is the only judge of intent,
 * so when the router is wrong, nothing downstream knows. Two deterministic
 * signals fix the blindness:
 *
 *  A. EXPLICIT CORRECTION — the client SAYS the answer was wrong:
 *     "не тоа прашав" / "ne toa prasav" / "prasav za cenata" / "ne za toa" /
 *     "drugo prasav" / "не одговори" / "ne odgovoras". When this fires, the
 *     LAST SERVED BANK PAIR is misfiled by definition — auto-filed into
 *     bank_corrections with reason 'client-said-wrong-answer'.
 *
 *  B. REPLY-CLASS MISMATCH — every bank key implies an expected reply class
 *     (fee.ask expects {agreement, fee-why, counter, refusal, negotiate};
 *     a bedrooms question expects {number}). If the client's next message
 *     belongs to NONE of the expected classes, the previous serve was
 *     probably misrouted — flag the pair for review (not auto-filed; a
 *     topic change is legal).
 *
 * Both feed the existing loop: bank_corrections → nightly loop-a → corpus →
 * detectors → gates. The intake stops depending on [F9] alone.
 */
import type { BankStore } from '../store/bank';
import { detectAgreement, detectFeeWhy, detectFeeComplaint, detectFeePaymentAgreement,
  detectNegotiate, detectRejection, detectVisitTime, detectBedrooms, detectPriceAsk,
  detectPriceFreshness, detectDefer, detectInvestmentOpinion, detectProvisionAsk,
  detectExhaustedFollowUp, detectSuggestAlternatives, detectCheaperSearch,
  detectWidenIntent, detectExplicitWiden, detectVisitInterest, detectPropertyInterest,
  detectService, isPropertyOffer } from './deterministic';

// ── A. Explicit correction ───────────────────────────────────────────────────
// The client's own words saying "you answered the wrong thing". Latin + Cyrillic
// via normalizeMc (detectors fold scripts), so stems suffice. NOT offtopic —
// these are the loudest routing feedback in the whole system.

const CORRECTION_STEMS: RegExp[] = [
  // "не тоа прашав" / "ne toa prasav" / "drugo prasav" / "прошарав" typo
  /(?:не|ne)\s+(?:тоа|toa|таа|taa|за\s+тоа|za\s+toa)/iu,
  /(?:друго|drugo|друга|druga)\s+(?:праш|прош|prasav|prosav|прашал|prasal)/iu,
  /(?:прашав|прашav|prasav|prosav|прошав|прашам|prasam|прaшав)\s+(?:за|za)/iu,
  // "не одговори / не одговараш" (you didn't answer) — not the escalation phrase
  // ("nema odgovor" style stays out; that's frustration, not routing feedback).
  /(?:не|ne)\s+(?:ми\s+)?(?:одговори|одговараш|odgovori|odgovarash)/iu,
  // "одговараш на друго" / "answer the other thing"
  /(?:одговараш|odgovarash)\s+(?:на\s+)?(?:друго|drugo|друга|druga)/iu,
  // "не сум прашал за ова" / "не за тоа беше прашањето"
  /(?:не\s+сум\s+прашал|ne\s+sum\s+prasal|не\s+прашав\s+за\s+ова|ne\s+prasav\s+za\s+ova)/iu,
  /(?:прашањето\s+(?:беше|е|e)\s+друго|прашањето\s+не\s+е\s+ова)/iu,
];

/** True when the client explicitly says the last answer answered the wrong thing. */
export function detectExplicitCorrection(text: string): boolean {
  const t = text.toLowerCase();
  return CORRECTION_STEMS.some(re => re.test(t));
}

// ── B. Reply-class expectations per key ─────────────────────────────────────
// Which reply classes each served key can legitimately elicit. If the next
// message matches NONE, the previous serve was probably misrouted. Deliberately
// PERMISSIVE — a legal topic change must not be flagged; this check exists to
// surface the "client keeps making their offer while we keep answering
// something else" pattern (10:54), not to police every turn.

type ReplyClassFn = (t: string) => boolean;

const REPLY_CLASSES: Record<string, ReplyClassFn> = {
  agreement: detectAgreement,
  feeWhy: detectFeeWhy,
  feeComplaint: detectFeeComplaint,
  feePayment: detectFeePaymentAgreement,
  negotiate: detectNegotiate,
  rejection: detectRejection,
  visitTime: t => !!detectVisitTime(t),
  bedrooms: t => detectBedrooms(t) !== undefined,
  priceAsk: detectPriceAsk,
  freshness: detectPriceFreshness,
  defer: detectDefer,
  invest: detectInvestmentOpinion,
  provision: detectProvisionAsk,
  exhausted: detectExhaustedFollowUp,
  alternatives: t => detectSuggestAlternatives(t) || detectCheaperSearch(t) || detectWidenIntent(t) || detectExplicitWiden(t),
  visitInterest: t => detectVisitInterest(t) || detectPropertyInterest(t),
  criteria: t => detectService(t) !== undefined,
  correction: detectExplicitCorrection,
};

/** Keys whose answers are QUESTIONS back to the client, and the reply classes
 *  each legitimately accepts. Keys not listed here are statements — anything
 *  the client says next is fine, no expectation.
 *
 *  The fee asks deliberately OMIT `negotiate`: since the counter-offer fix,
 *  `detectNegotiate` claims "dali moze za 150 e" — but after a fee ask that
 *  phrasing is the 08:20 misroute signature (the client kept making their
 *  property offer while Lina kept answering the fee). The special case in
 *  checkMisroute catches it BEFORE the expected-class check would swallow it. */
const KEY_EXPECTATIONS: Record<string, ReplyClassFn[]> = {
  // Fee asks: property-sized offers and freshness questions are the exact
  // mismatch classes from 08:20/10:54 — the client kept making their offer
  // while Lina kept talking about the fee. Fee-sized amounts ARE legal
  // replies ("ok, ke platam 500 denari" = consent). A plain price re-ask is a
  // legal topic pivot (the harmful freshness class is caught separately); an
  // availability/interest re-confirm is likewise a normal follow-up.
  'fee.ask.buy': [REPLY_CLASSES.agreement, REPLY_CLASSES.feeWhy, REPLY_CLASSES.feeComplaint,
    REPLY_CLASSES.feePayment, REPLY_CLASSES.negotiate, REPLY_CLASSES.rejection,
    REPLY_CLASSES.defer, REPLY_CLASSES.priceAsk, REPLY_CLASSES.visitInterest,
    REPLY_CLASSES.correction],
  'fee.ask.rent': [REPLY_CLASSES.agreement, REPLY_CLASSES.feeWhy, REPLY_CLASSES.feeComplaint,
    REPLY_CLASSES.feePayment, REPLY_CLASSES.negotiate, REPLY_CLASSES.rejection,
    REPLY_CLASSES.defer, REPLY_CLASSES.priceAsk, REPLY_CLASSES.visitInterest,
    REPLY_CLASSES.correction],
  'bedrooms.ask': [REPLY_CLASSES.bedrooms, REPLY_CLASSES.criteria, REPLY_CLASSES.defer,
    REPLY_CLASSES.rejection, REPLY_CLASSES.correction],
  'bedrooms.ask.rent': [REPLY_CLASSES.bedrooms, REPLY_CLASSES.criteria, REPLY_CLASSES.defer,
    REPLY_CLASSES.rejection, REPLY_CLASSES.correction],
  'bedrooms.ask.buy': [REPLY_CLASSES.bedrooms, REPLY_CLASSES.criteria, REPLY_CLASSES.defer,
    REPLY_CLASSES.rejection, REPLY_CLASSES.correction],
  'visit.when': [REPLY_CLASSES.visitTime, REPLY_CLASSES.defer, REPLY_CLASSES.rejection,
    REPLY_CLASSES.correction],
  'location.ask': [REPLY_CLASSES.criteria, REPLY_CLASSES.criteria, REPLY_CLASSES.defer,
    REPLY_CLASSES.rejection, REPLY_CLASSES.correction],
  'price.ask': [REPLY_CLASSES.priceAsk, REPLY_CLASSES.freshness, REPLY_CLASSES.negotiate,
    REPLY_CLASSES.visitInterest, REPLY_CLASSES.correction],
};

/** Classify a message into reply classes (for tests and the audit report). */
export function replyClassesOf(text: string): string[] {
  return Object.entries(REPLY_CLASSES).filter(([, fn]) => fn(text)).map(([k]) => k);
}

export interface MisrouteCheck {
  /** 'correction' = A (client said so); 'mismatch' = B (class expectation);
   *  null = nothing suspicious. */
  kind: 'correction' | 'mismatch' | null;
  reason: string;
}

/** Fresh-session opener: a greeting + property number means the client
 *  RESTARTED the conversation — the previous serve is ancient history, never
 *  evidence of a misroute (sequence-layer finding: #61→#62, #26→#28). */
const RESTART_RE = /(?:^|\n)\s*(?:zdravo|dobar\s+den|dobre|pozdrav|hello|zdr)\b[^\n]*\b\d{1,4}\b/i;

/**
 * Check whether the client's NEWEST message invalidates the PREVIOUS served
 * bank pair. `last` = the previous exchange from the enrichment log for this
 * chat (already keyed), or null when nothing was served before.
 */
export function checkMisroute(
  text: string,
  last: { userMsg: string; bankKey: string | null; replyText: string; createdAt?: number } | null,
): MisrouteCheck {
  if (RESTART_RE.test(text)) return { kind: null, reason: '' }; // session restart — not evidence
  // A — explicit correction always wins.
  if (detectExplicitCorrection(text)) {
    return { kind: 'correction', reason: 'client-said-wrong-answer' };
  }
  // B — reply-class mismatch against the previous serve.
  if (!last?.bankKey) return { kind: null, reason: '' };
  const expected = KEY_EXPECTATIONS[last.bankKey];
  // Fee-ask special case runs BEFORE the expected-class check: negotiate
  // normally counts as a legal fee-talk move, but a PROPERTY-sized offer or a
  // price-freshness question after a fee ask is the 08:20/10:54 misroute
  // signature — the client kept making their offer while Lina kept answering
  // the fee.
  if (/^fee\.ask\./.test(last.bankKey)
    && (isPropertyOffer(text) || detectPriceFreshness(text))) {
    return { kind: 'mismatch', reason: `property-offer-after-fee-ask on ${last.bankKey}` };
  }
  if (!expected) return { kind: null, reason: '' }; // statement key — no expectation
  if (expected.some(fn => fn(text))) return { kind: null, reason: '' }; // expected class — healthy
  const classes = replyClassesOf(text);
  if (classes.length === 0) return { kind: null, reason: '' }; // unclassifiable — not evidence
  return {
    kind: 'mismatch',
    reason: `expected ${last.bankKey} to elicit expected classes, got [${classes.join(',')}]`,
  };
}

/**
 * File the previous pair into bank_corrections when the newest message proves
 * it was misrouted. Called from the serving path BEFORE the new reply lands
 * (latestForChat still points at the previous exchange).
 *
 * Guards against noise: the client repeating themselves is not new evidence,
 * and class-mismatch flags expire (30 min) because a stale "flagged" pair
 * mostly means the topic moved on legally.
 */
const MISMATCH_MAX_AGE_MS = 30 * 60_000;
export function fileMisrouteCorrection(
  bank: BankStore | undefined,
  text: string,
  last: { userMsg: string; bankKey: string | null; replyText: string; createdAt?: number } | null,
): void {
  if (!bank || !last) return;
  if (text.trim() === last.userMsg.trim()) return; // client repeating — already filed
  const verdict = checkMisroute(text, last);
  if (verdict.kind === 'correction') {
    bank.correction(last.bankKey, last.userMsg, last.replyText, verdict.reason);
  } else if (verdict.kind === 'mismatch'
    && last.createdAt !== undefined
    && Date.now() - last.createdAt <= MISMATCH_MAX_AGE_MS) {
    // Mismatches are SUSPICION, not proof — staged for review (key: null,
    // suspect key lives in the reason). The stored msg is the client's NEWEST
    // message: that is the evidence phrase, and loop-a mines row.msg for
    // trigger corpora — storing the previous pair's msg ("da") would grow
    // families with junk. With the evidence phrase, loop-a resolves it into
    // its real family (counter-offer etc.) and the corpus absorbs the miss.
    bank.correction(null, text, last.replyText, verdict.reason);
  }
}
