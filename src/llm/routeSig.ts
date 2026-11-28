// THE CONTEXT SIGNATURE — what a route must match on, besides the text.
//
// Measured on the shipped corpus (docs/classifier-build-runbook.md §4): the
// classifier verdict is NOT a function of (text, state). `DOGOVORI MI` in the
// same state produced FEE_AGREED, FEE_REFUSED and INTERESTED on different
// turns — the difference was the fee-rung depth and what the previous ask was,
// not the sentence. A route keyed on text+state alone therefore cannot be made
// safe by tuning a similarity threshold (top-1 42.4 %).
//
// So the key is `(normalized text, state, signature)`, and the signature
// carries exactly the facts that flip a lane:
//
//   negated          "ne moze" vs "moze" — char trigrams read these as ~0.85
//                    similar, and in routing the negation IS the message.
//   digit            a bare number is an Евидентен број (the availability
//                    funnel) in intake states; the same sentence worded
//                    without it is a different lane.
//   moneyWord        fee / commission / price vocabulary — the two money
//                    ladders are the most expensive area to get wrong.
//   propertyOnTable  the same "kade e?" is a landmark answer with a flat on
//                    the table and a fresh search without one (§4b).
//   feeRung          rung depth decides whether "dogovori mi" is consent
//                    (rung 0, after disclosure) or a visit order (rung 1+).
//   awaiting         the kind of question the last assistant line ended with:
//                    "da" answers a contact ask, a fee ask and a location ask
//                    completely differently.
//   service          buy vs rent picks the script and the amount (500/300).
//
// This module is PURE: no I/O, no LLM, no side effects. It is also deliberately
// conservative — every flag is a veto on route reuse, never a licence to serve.

import { ChatSession } from '../fsm/session';

/** The kind of answer the previous assistant turn is still waiting for. */
export type AwaitingKind =
  | 'none'
  | 'service'
  | 'location'
  | 'budget'
  | 'bedrooms'
  | 'fee'
  | 'contact'
  | 'time'
  | 'property'
  | 'confirm';

export interface RouteSig {
  negated: boolean;
  digit: boolean;
  moneyWord: boolean;
  propertyOnTable: boolean;
  feeRung: boolean;
  awaiting: AwaitingKind;
  service: 'buy' | 'rent' | 'unknown';
}

/** Standalone negators only: `ne` must not match `nekolku`, and `ни` must not
 *  match `ниту` (both are negators anyway, but `низ` — "through" — is not). */
const NEGATION_RE =
  /(?<![\p{L}])(?:не|ne|ниту|nitu|ни|ni|без|bez|нема|nema|nikoj|никој|никогаш|nikogas|nisto|ништо)(?![\p{L}])/iu;

/** Money vocabulary — fee, commission, price, rent. Inflections are matched by
 *  stem, so `провизијата` / `provizijata` are both money. */
const MONEY_RE =
  /(?:цена|cena|ценовник|пари|pari|евра|evra|евро|evro|денари|denari|денар|denar|надомест|nadomest|провизи|provizi|посета|poseta|такс|taks|буџет|budzet|кириј|kirij|рента|renta|50\s*%|50%|500|300)/iu;

/** The last assistant line, as the previous question. Ordered: the most
 *  expensive mistake first (fee), then contact, then the funnel asks. These are
 *  HINTS for the signature, not copy decisions — a wrong hint can only make a
 *  route abstain, never serve. */
const AWAITING_RULES: Array<{ kind: AwaitingKind; re: RegExp }> = [
  { kind: 'fee', re: /(?:посет|poset|надомест|nadomest|провизи|provizij|одржа|500\s*ден|300\s*ден)/iu },
  { kind: 'contact', re: /(?:телефон|telefon|број|broj|вашето име|vaseto ime|контакт|kontakt)/iu },
  { kind: 'bedrooms', re: /(?:колку соби|kolku sobi|спални|spalni|гарсоњер|garsonjer)/iu },
  { kind: 'budget', re: /(?:буџет|budzet|цена до|cena do|до колку|do kolku|колку евра|kolku evra|до\s*\d)/iu },
  { kind: 'location', re: /(?:кој дел|koj del|која населба|koja naselba|населба|naselba|каде|kade)/iu },
  { kind: 'service', re: /(?:купување|kupuvanje|изнајмување|iznajmuvanje|купам|iznajmam|под кирија|pod kirija)/iu },
  { kind: 'time', re: /(?:кога|koga|кој ден|koj den|во колку|vo kolku|термин|termin)/iu },
  { kind: 'property', re: /(?:евидентен|evidenten|кој имот|koj imot|кој стан|koj stan)/iu },
  { kind: 'confirm', re: /(?:дали|dali|договорено|dogovoreno|потврдувате|potvrduvate)/iu },
];

/** Build the signature from the CURRENT session — read only, never mutates. */
export function buildRouteSig(session: ChatSession, text: string): RouteSig {
  const slots = session.slots ?? {};
  const lastAssistant = [...(session.history ?? [])]
    .reverse()
    .find(m => m.role === 'assistant')?.text ?? '';
  const feeRung = ((slots.feeRejections ?? 0) + (slots.provisionRejections ?? 0)) > 0;
  return {
    negated: NEGATION_RE.test(text),
    digit: /\d/.test(text),
    moneyWord: MONEY_RE.test(text),
    propertyOnTable:
      slots.propertyId !== undefined
      || slots.interestedPropertyId !== undefined
      || slots.askedEb !== undefined,
    feeRung,
    awaiting: lastAssistant ? awaitingKind(lastAssistant) : 'none',
    service: slots.service === 'buy' || slots.service === 'rent' ? slots.service : 'unknown',
  };
}

export function awaitingKind(assistantText: string): AwaitingKind {
  if (!assistantText) return 'none';
  // Only a QUESTION is an ask. The last assistant line may be a statement
  // (a card, an acknowledgement) that expects no answer shape at all.
  const isQuestion = /[?？]\s*$/u.test(assistantText.trim());
  if (!isQuestion) return 'none';
  for (const rule of AWAITING_RULES) if (rule.re.test(assistantText)) return rule.kind;
  return 'none';
}

/** Stable, index-friendly encoding of the signature. Key ORDER IS FIXED — two
 *  signatures that differ only by object key order must produce the same key,
 *  or the route table silently splits into twins. */
export function sigKey(sig: RouteSig): string {
  return [
    sig.negated ? 'n1' : 'n0',
    sig.digit ? 'd1' : 'd0',
    sig.moneyWord ? 'm1' : 'm0',
    sig.propertyOnTable ? 'p1' : 'p0',
    sig.feeRung ? 'f1' : 'f0',
    `a:${sig.awaiting}`,
    `s:${sig.service}`,
  ].join('|');
}

/** Parse a stored `sig` column back into a RouteSig (defensive: a corrupted row
 *  returns undefined, so the caller abstains instead of serving garbage). */
export function parseRouteSig(json: string): RouteSig | undefined {
  try {
    const v = JSON.parse(json) as Partial<RouteSig>;
    if (typeof v !== 'object' || v === null) return undefined;
    if (typeof v.negated !== 'boolean' || typeof v.digit !== 'boolean'
      || typeof v.moneyWord !== 'boolean' || typeof v.propertyOnTable !== 'boolean'
      || typeof v.feeRung !== 'boolean') return undefined;
    return {
      negated: v.negated, digit: v.digit, moneyWord: v.moneyWord,
      propertyOnTable: v.propertyOnTable, feeRung: v.feeRung,
      awaiting: (v.awaiting ?? 'none') as AwaitingKind,
      service: v.service === 'buy' || v.service === 'rent' ? v.service : 'unknown',
    };
  } catch { return undefined; }
}
