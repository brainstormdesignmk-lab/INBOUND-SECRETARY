import { Service, State, Event } from '../fsm/machine';
import { locMatches } from '../data/properties';

// LLM-independent intent/slot extraction. When every LLM is down (or the model
// says STAY), these deterministic rules still pull service, bedrooms and budget
// out of the client's text — location comes from the feed's neighborhoods
// (see PropertyService.matchLocation). This keeps the discovery->presentation
// path alive without any LLM.

export interface DetectedSlots {
  service?: Service;
  location?: string;   // filled by the caller (needs the feed's neighborhoods)
  bedrooms?: number;
  budget?: string;     // canonical digits, e.g. "80000"
  rejected?: boolean;
}

// Latin spellings included — Macedonian clients type in Latin more often than Cyrillic.
const BUY_RE = /(купува|купам|купи|купн|куп|продажба|продава|\bbuy\b|kupuvam|kupam|kupi|kupn|prodazba|prodava)/i;
const RENT_RE = /(изнајмува|изнајмам|изнајми|изнајм|кирија|под кирија|издава|издад|\brent\b|iznajmuvam|iznajmam|iznajmi|iznajm|kirija|pod kirija|izdava|izdad)/i;

const BED_NUM_RE = /(\d+)[-\s]*(?:спални|спална|соби|соба|спа|собен|собни|sob|sobi|soben|sobni|spalni|spalna)/i;
const BED_WORDS: Array<[RegExp, number]> = [
  [/(еднособен|еднособна|една соба|ednosoben|ednosobna|edna soba)/i, 1],
  [/(двособен|двособна|две соби|dvosoben|dvosobna|dve sobi)/i, 2],
  [/(трисобен|трисобна|три соби|trisoben|trisobna|tri sobi)/i, 3],
  [/(четирисобен|четирисобна|четири соби|cetirisoben|cetirisobna|chetiri sobi)/i, 4],
];

const REJECT_RE =
  /(не ми се допаѓа|не ми одговара|не го сакам|не ја сакам|не сакам (овој|оваа|тие|овие|ниту еден)|не ме интересира|нешто друго|друга населба|други опции|ne mi se dopaga|ne mi odgovara|ne go sakam|ne ja sakam|ne sakam|ne me interesira|nestо drugo|druga naselba|drugi opcii)/i;

export function detectService(text: string): Service | undefined {
  const b = text.search(BUY_RE);
  const r = text.search(RENT_RE);
  if (b >= 0 && (r < 0 || b < r)) return 'buy';
  if (r >= 0) return 'rent';
  return undefined;
}

export function detectBedrooms(text: string): number | undefined {
  const m = text.match(BED_NUM_RE);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 6) return n;
  }
  for (const [re, n] of BED_WORDS) {
    if (re.test(text)) return n;
  }
  return undefined;
}

/**
 * Budget = the highest figure mentioned (with currency context or >= 1000, so
 * "2 спални" or a bare Евидентен број "78" never becomes a budget). "80
 * илјади" → 80000.
 */
export function detectBudget(text: string): string | undefined {
  // Strip phone numbers first — "078/914 196" must never glue into "914196".
  const cleaned = text.replace(/\b0\d{1,2}\s*[/.]\s*\d{2,4}(?:\s*\d{2,4})?\b/g, ' ');
  const re = /\b(\d[\d\s.,]*)\s*(илјади|хилјади)?\s*(евра|евро|eur|€)?/gi;
  let m: RegExpExecArray | null;
  let bestN = 0;
  while ((m = re.exec(cleaned)) !== null) {
    const digits = m[1].replace(/[\s.,]/g, '');
    let n = parseInt(digits, 10);
    if (!Number.isFinite(n) || n <= 0) continue;
    if (m[2]) n *= 1000; // "80 илјади" -> 80000
    const hasCur = !!m[3];
    // 1900-2100 without currency is a construction year, not a budget
    if (n >= 1900 && n <= 2100 && !hasCur) continue;
    if ((n >= 1000 || hasCur) && n > bestN) bestN = n;
  }
  return bestN > 0 ? String(bestN) : undefined;
}

export function detectRejection(text: string): boolean {
  return REJECT_RE.test(text);
}

/**
 * Best matching canonical feed location for a query, or undefined. Feed
 * locations come from PropertyService.locations() (longest first); the same
 * transliteration-aware matcher as the property search decides the hit, so
 * "centar" finds "Центар" and "kisela voda" finds "Кисела Вода".
 */
export function detectLocation(text: string, feedLocations: string[]): string | undefined {
  for (const loc of feedLocations) {
    if (locMatches(text, loc)) return loc;
  }
  return undefined;
}

/**
 * Build the classifier event from deterministic slots. STAY when nothing was
 * detected; REJECTED only against shown offers (property states); a full
 * criteria set becomes SEARCH_REQUESTED (straight to presentation); service
 * alone is INTENT_DECLARED; anything partial is DETAILS_PROVIDED so discovery
 * asks for the missing pieces.
 */
export function buildEvent(state: State, slots: DetectedSlots): Event {
  const { service, location, bedrooms, budget, rejected } = slots;
  const has = !!(service || location || bedrooms || budget);
  if (!has) return { type: 'STAY' };
  if (rejected && ['property_query', 'presentation', 'closing'].includes(state)) {
    return { type: 'REJECTED', service, location, bedrooms, budget };
  }
  if (service && location && bedrooms && budget) {
    return { type: 'SEARCH_REQUESTED', service, location, bedrooms, budget };
  }
  if (service && !location && !bedrooms && !budget) {
    return { type: 'INTENT_DECLARED', service };
  }
  return { type: 'DETAILS_PROVIDED', service, location, bedrooms, budget };
}

export function extractSlots(text: string): DetectedSlots {
  const out: DetectedSlots = {};
  const service = detectService(text);
  if (service) out.service = service;
  const beds = detectBedrooms(text);
  if (beds) out.bedrooms = beds;
  const budget = detectBudget(text);
  if (budget) out.budget = budget;
  if (detectRejection(text)) out.rejected = true;
  return out;
}
