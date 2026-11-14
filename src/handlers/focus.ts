// PROPERTY FOCUS — SUBJECT × PREDICATE × CERTAINTY (proposal Phase 3).
//
// Every reported identity defect (44/54/63) has the same shape: the client asks
// a PREDICATE about a SUBJECT, and the appliance answers it about a different
// property — or answers a different predicate about the right one. It happened
// because each lane re-derived "which flat do we mean?" from whatever field was
// nearest: `propertyId` here, `currentBatch` tail there, `presentedIds[last]`
// somewhere else, the mention binder somewhere else again. Five resolutions,
// five orders, five answers for one question.
//
// This module is the ONE resolution. It returns three things, explicitly:
//
//   predicate  — what is being asked ABOUT the property (availability, price,
//                €/m², location, area, rooms, floor, features, documents)
//   subject    — the evident number, when the turn binds to exactly one flat
//   certainty  — 'bound' | 'ambiguous' | 'none'
//
// CERTAINTY IS THE CONTRACT, not a hint:
//   bound      → answer about that flat.
//   ambiguous  → the message names something that could be either of the flats
//                on the table: ASK which one (§4b), never pick silently.
//   none       → nothing to be about: ask, or answer a market-level question.
//
// PRECEDENCE (pinned by tests/mention-resolve.test.ts and §4b):
//   1. an Евидентен број the client NAMES wins over everything;
//   2. a card she just SERVED outranks a stale slot pointer — the slot may hold
//      a flat the conversation has already left ([04:15] capture);
//   3. the slot pointers are the fallback (the flat under discussion when no
//      batch is on the table);
//   4. the batch tail is the last resort (sessions presented before the
//      `presentedIds` record was kept).
// A message carrying identity signals but no EB is 'ambiguous' by design: the
// mention binder (src/llm/mentionResolve.ts) scores those against the rows, and
// this module must not guess what the binder is about to resolve.

import { inferPropertyId } from '../llm/classify';
import { extractMentionSignals, hasIdentitySignals } from '../llm/mentionResolve';
import { normalizeMc } from '../llm/normalize';

export type FocusPredicate =
  | 'availability'
  | 'perM2'
  | 'price'
  | 'location'
  | 'area'
  | 'rooms'
  | 'floor'
  | 'features'
  | 'documents';

export type FocusCertainty = 'bound' | 'ambiguous' | 'none';

export type FocusSource = 'named' | 'last-presented' | 'slot' | 'batch' | 'none';

export interface FocusSlots {
  propertyId?: number;
  interestedPropertyId?: number;
  presentedIds?: number[];
  currentBatch?: number[];
}

export interface PropertyFocus {
  predicate?: FocusPredicate;
  certainty: FocusCertainty;
  /** Present when certainty is 'bound'. */
  eb?: number;
  /** The flats the turn could be about, in presentation order. */
  candidates: number[];
  source: FocusSource;
}

/** The predicate families, in the order they must be tested: the money rate
 *  beats the plain price («цена по квадрат» is not «колку чини»), and
 *  availability beats location («дали е слободна» is not «каде е»). Latin is
 *  covered by the caller's normalisation, so each family lists the surface
 *  forms that survive it. */
const PREDICATE_RULES: Array<{ predicate: FocusPredicate; re: RegExp }> = [
  {
    predicate: 'perM2',
    re: /(?:^|[\s,.;:!?„“"'(])(?:по|за|на|po|za|na)\s*(?:м2|м²|m2|m²|квадрат\p{L}*|kvadrat\p{L}*)/iu,
  },
  {
    predicate: 'availability',
    // STEMS, not nominatives: «достапен»/«достапна»/«достапни» are one family,
    // and a stem that stops at the -н- matched none of the first two.
    re: /(?:достап\p{L}*|слобод\p{L}*|продаа\p{L}*|продава\p{L}*|продаден\p{L}*|издава\p{L}*)/iu,
  },
  {
    predicate: 'location',
    re: /(?:каде|кај|локациј\p{L}*|адрес\p{L}*|населб\p{L}*|kade|kaj|lokacij\p{L}*|adres\p{L}*|naselb\p{L}*)/iu,
  },
  {
    predicate: 'documents',
    re: /(?:документ\p{L}*|имотен\p{L}*|лист\p{L}*|договор\p{L}*|dokument\p{L}*|imoten\p{L}*|dogovor\p{L}*)/iu,
  },
  {
    predicate: 'floor',
    re: /(?:спрат\p{L}*|кат\p{L}*|sprat\p{L}*|kat\p{L}*)/iu,
  },
  {
    predicate: 'rooms',
    re: /(?:соби\p{L}*|спалн\p{L}*|соб\p{L}*|sobi\p{L}*|spalni\p{L}*)/iu,
  },
  {
    predicate: 'features',
    re: /(?:парно|лифт|терас\p{L}*|двор\p{L}*|гараж\p{L}*|паркинг\p{L}*|опремен\p{L}*|renovir\p{L}*|реновир\p{L}*|parno|lift|teras\p{L}*|dvor\p{L}*|garaz\p{L}*|parking\p{L}*)/iu,
  },
  {
    predicate: 'area',
    re: /(?:квадрат\p{L}*|м2|м²|m2|m²|sqm|kvadrat\p{L}*)/iu,
  },
  {
    predicate: 'price',
    // «цена»/«цени»/«цената» are the same stem; the nominative missed «цени».
    re: /(?:цен\p{L}*|чин\p{L}*|вред\p{L}*|евра)/iu,
  },
];

export function detectFocusPredicate(text: string): FocusPredicate | undefined {
  // Cyrillic-canonical, like every other detector: a Latin client typing is
  // transliterated first, so «DALI E SEUSTE DOSTAPEN?» and «дали е уште
  // достапна?» reach the SAME family (a Latin-only stem list silently missed
  // «DOSTAPEN» — the stem is «dostapen», not «dostapn»).
  const norm = normalizeMc(text);
  for (const rule of PREDICATE_RULES) if (rule.re.test(norm)) return rule.predicate;
  return undefined;
}

const uniq = (ids: Array<number | undefined>): number[] => {
  const out: number[] = [];
  for (const id of ids) {
    if (typeof id === 'number' && !out.includes(id)) out.push(id);
  }
  return out;
};

/**
 * Resolve what this turn is about. Pure: no I/O, no feed access — the caller
 * still fetches the row and decides the copy.
 */
export function resolvePropertyFocus(text: string, slots: FocusSlots): PropertyFocus {
  const predicate = detectFocusPredicate(text);
  const signals = extractMentionSignals(text);
  // «ЕБ 66» is a NAMED flat even when the bare-number parser declines it: the
  // mention resolver owns the prefixed form, and treating it as an anonymous
  // identity signal turned a named flat into an ambiguous one.
  const named = inferPropertyId(text) ?? signals.eb;
  const presented = slots.presentedIds ?? [];
  const batch = slots.currentBatch ?? [];
  const candidates = uniq([...presented, ...batch, slots.propertyId, slots.interestedPropertyId]);

  if (named !== undefined) {
    return { predicate, certainty: 'bound', eb: named, candidates, source: 'named' };
  }

  // Identity signals without an EB: the binder must score them. Guessing here
  // is exactly the [23:09] defect (EB 70 vs EB 76 answered from the tail).
  if (hasIdentitySignals(signals) && candidates.length > 1) {
    return { predicate, certainty: 'ambiguous', candidates, source: 'last-presented' };
  }

  // A card she just served outranks a stale pointer.
  if (presented.length > 0) {
    return { predicate, certainty: 'bound', eb: presented[presented.length - 1], candidates, source: 'last-presented' };
  }
  const pointer = slots.propertyId ?? slots.interestedPropertyId;
  if (pointer !== undefined) {
    return { predicate, certainty: 'bound', eb: pointer, candidates, source: 'slot' };
  }
  if (batch.length > 0) {
    return { predicate, certainty: 'bound', eb: batch[batch.length - 1], candidates, source: 'batch' };
  }
  return { predicate, certainty: 'none', candidates, source: 'none' };
}

/** The one-line ask when a predicate needs a subject the turn does not bind. */
export function focusClarifyAsk(focus: PropertyFocus): string {
  const named = focus.candidates.slice(-4).map(eb => `Евидентен број ${eb}`).join(', ');
  return named
    ? `За која од понудите да Ви одговорам — ${named}?`
    : 'За која недвижност да Ви одговорам? Знаете ли го Евидентниот број?';
}
