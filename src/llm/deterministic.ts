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
  sqm?: number;        // commercial spaces: size instead of bedrooms
  business?: boolean;  // деловен простор / канцеларија / локал
  budget?: string;     // canonical digits, e.g. "80000"
  rejected?: boolean;
}

// Latin spellings included — Macedonian clients type in Latin more often than Cyrillic.
const BUY_RE = /(купува|купам|купи|купн|куп|продажба|продава|\bbuy\b|kupuvam|kupam|kupi|kupn|prodazba|prodava)/i;
const RENT_RE = /(изнајмува|изнајмам|изнајми|изнајм|кирија|под кирија|издава|издад|\brent\b|iznajmuvam|iznajmam|iznajmi|iznajm|kirija|pod kirija|izdava|izdad)/i;

// No explicit buy/rent word, but "ми треба стан" / "барам стан" / "сакам стан"
// (need/looking-for/want + apartment, no rent marker) is a BUY in Macedonian
// real estate: renting is always marked (под кирија, изнајмување, за издавање).
// NOTE: no \b around Cyrillic — JS \b only knows ASCII word chars.
const NEED_STAN_RE = /((треба|барам|ми треба|потребен ми е|сакам|need|treba|baram|sakam)[\s\S]{0,50}(стан|станче|стани|stan|stance|apartment))/i;

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
  if (NEED_STAN_RE.test(text)) return 'buy';
  return undefined;
}

// "мало станче" / "гарсоњера" / "студио" is a 1-bedroom request — only when
// no explicit bedroom was mentioned (explicit numbers/words win). Latin and
// Cyrillic variants (clients type "MALO STANCE" more often than "мало станче").
const SMALL_STAN_RE = /(мал[оаи]?\s+(стан|станче|стани)|mal[oa]?\s+(stan|stance|stani)|гарсоњера|garsonjera|студио|studio)/i;

export function detectBedrooms(text: string): number | undefined {
  const m = text.match(BED_NUM_RE);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 6) return n;
  }
  for (const [re, n] of BED_WORDS) {
    if (re.test(text)) return n;
  }
  if (SMALL_STAN_RE.test(text)) return 1;
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
  // Cyrillic AND Latin currency spellings — clients type "500 EVRA" in Latin
  // far more often than "евра"; /i does NOT fold Latin E into Cyrillic е.
  const re = /\b(\d[\d\s.,]*)\s*(илјади|хилјади)?\s*(евра|евро|evra|evro|eur|€)?/gi;
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

// Visit interest: the client wants to SEE the property. In property states
// (property_query/presentation) this is INTERESTED — "кога може да се
// погледне?", "сакам да ја видам", "организирај посета" and availability
// questions ("дали е достапен?") all mean "I want to visit it". Latin and
// Cyrillic (clients type "KOGA BI MOZELO DA SE POGLEDNE STANOT?" more often
// than Cyrillic). The negation guard keeps "не сакам да ја видам" out.
const VISIT_INTEREST_RE =
  /(кога[^.!?\n]{0,40}(може|би можело|би можела)[^.!?\n]{0,25}(погледн|видам|разгледам|посета)|(сакам|би сакал|би сакала|посакувам)[^.!?\n]{0,40}(погледн|видам|разгледам|посета)|организира(ј|јте)?\s+посета|закаж(и|е)(те)?\s+посета|дали[^.!?\n]{0,30}достапен|дали[^.!?\n]{0,30}достапна|koga[^.!?\n]{0,40}(moze|bi mozelo|bi mozela)[^.!?\n]{0,25}(pogledn|vidam|razgledam|poseta)|sakam[^.!?\n]{0,40}(da ja vidam|da go vidam|da go poglednam|da go razgledam|poseta)|organiziraj(te)?\s+poseta|zakaz(e|i)(te)?\s+poseta|dali[^.!?\n]{0,30}dostapen|dali[^.!?\n]{0,30}dostapna)/i;

const VISIT_NEGATION_RE = /(не\s+(сакам|сакаме|би сакал|би сакала|посакувам|организира)|ne\s+(sakam|sakame|bi sakal|bi sakala|posakuvam|organizira))/i;

export function detectVisitInterest(text: string): boolean {
  if (VISIT_NEGATION_RE.test(text)) return false;
  return VISIT_INTEREST_RE.test(text);
}

// A proposed visit time (LLM-down path for visit_scheduling -> owner check).
// Anything with a time/date reference: "утре на пладне", "после 6", "петок
// во 17:30", "сабота попладне". Returns the raw phrase (used verbatim in the
// owner check + confirmation).
const VISIT_TIME_RE =
  /(утре|задутре|денес|денеска|вечерва|попладне|напладне|претпладне|утрово|наутро|вечер|викенд|во\s*\d{1,2}([.:]\d{2})?|околу\s*\d{1,2}|после\s*\d{1,2}|по\s*\d{1,2}|после\s+\d{1,2}|понеделник|вторник|среда|четврток|петок|сабота|недела|понеделни|вторни|среди|четврто|петочни|саботи|недели|utre|zadutre|denes|vecer|popladne|napladne|utrovo|vikend|posle\s*\d{1,2}|vo\s*\d{1,2}([.:]\d{2})?|ponedelnik|vtornik|sreda|cetvrtok|petok|sabota|nedela)/i;

export function detectVisitTime(text: string): string | undefined {
  if (!VISIT_TIME_RE.test(text)) return undefined;
  return text.trim().slice(0, 80);
}

// Commercial-property intent: деловен простор / канцеларија / локал / магацин /
// дуќан / продавница… ("за стан" searches must never ask or match these — and
// vice versa). The vocabulary mirrors Ana's proven COMMERCIAL_TITLE_RE
// (outbound project). STRONG terms (unambiguous property types) match bare;
// WEAK terms (кафе/ресторан/салон/хотел are often LANDMARKS — "сакам стан до
// кафе") require a need/transaction context so a landmark mention never
// flips a residential search into a business one.
const BUSINESS_STRONG_RE = /(деловен|деловни|деловна|деловно|канцелар|локал|магацин|склад|хала|бизнис|офис|дукјан|дукан|дуќан|продавниц|ателје|deloven|delovni|delovna|kancelari|kancelariski|lokal|magacin|sklad|hala|biznis|ofis|dukjan|dukan|prodavnic|atelje|posloven|poslovn|office|business|commercial)/i;
const BUSINESS_WEAK_RE = /(ресторан|кафуле|кафич|кафе|салон|хотел|restoran|kafule|kafic|kafe|salon|hotel)/i;
const BUSINESS_NEED_RE = /(ми треба|барам|сакам|треба|потребен|потребна|need|treba|baram|sakam|за изнајмување|за издавање|под кирија|за изнајмува|za iznajmuvanje|za izdavanje|pod kirija|za iznajmuv|rent|изнајмувам)/i;
// An explicit RESIDENTIAL word (стан/куќа/гаража стамбен) means the weak
// term is a LANDMARK, not the property type: "сакам стан до кафе" is an
// apartment search, "барам локал до кафе" is a business search.
const RESIDENTIAL_WORD_RE = /(стан|стани|станче|куќ|кука|house|stan|stance|apartment|гаража|garaza|стамбен|stamben)/i;

export function detectBusiness(text: string): boolean {
  // An explicit residential word ("стан", "куќа") wins over EVERY business
  // term: "стан до кафе" and "стан со дуќан" are residential searches — the
  // business word is a landmark/feature, not the property type.
  if (RESIDENTIAL_WORD_RE.test(text)) return false;
  if (BUSINESS_STRONG_RE.test(text)) return true;
  if (!BUSINESS_WEAK_RE.test(text)) return false;
  // Weak term (кафе/ресторан/салон) is business only WITH a need context:
  // "барам ресторан под кирија" = business; bare "кафе" = nothing.
  return BUSINESS_NEED_RE.test(text);
}

/** Square meters for a commercial space: "40 м2", "40 квадрати", "150 kvadrata". */
export function detectSqm(text: string): number | undefined {
  const m = text.match(/(\d{2,4})\s*(м2|м²|m2|m²|кв\.?\s*м|квадрат(и)?|kvadrat(a|i)?)/i);
  if (!m) return undefined;
  const n = parseInt(m[1], 10);
  return n >= 10 && n <= 5000 ? n : undefined;
}

// Agreement/contact-intent phrases — the escape hatch from the exhausted
// dead-end ("добро", "контактирај ме" after every option was shown).
const AGREE_PHRASES = ['во ред', 'vo red', 'се согласувам', 'se soglasuvam',
  'контактирај ме', 'контактирајте ме', 'kontaktiraj me', 'kontaktirajte me',
  'запиши ме', 'запишете ме', 'prijavete me'];
const AGREE_WORDS = new Set(['добро', 'ок', 'да', 'може', 'согласен', 'согласна',
  'согласувам', 'запиши', 'запишете', 'контактирај', 'контактирајте', 'регистрирај',
  'ok', 'dobro', 'moze', 'da', 'soglasen', 'soglasna', 'kontaktiraj', 'kontaktirajte', 'registriraj']);

export function detectAgreement(text: string): boolean {
  const low = text.toLowerCase();
  if (AGREE_PHRASES.some(p => low.includes(p))) return true;
  const tokens = low.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  return tokens.some(t => AGREE_WORDS.has(t));
}

// Minimal name+phone intake for the LLM-down path (contact_collection).
const NAME_STOPWORDS = new Set(['моето', 'мое', 'име', 'јас', 'сум', 'се', 'викам',
  'нарекувам', 'тел', 'телефон', 'телефонот', 'број', 'бројот', 'контакт', 'контактниот',
  'ми', 'е', 'и', 'на', 'со', 'ве', 'го', 'ги', 'за', 'ова', 'оваа',
  'evt', 'tel', 'phone', 'broj', 'kontakt', 'moeto', 'ime', 'jas', 'sum', 'vikam',
  'здраво', 'zdravo', 'како', 'kako', 'добар', 'dobar', 'ден', 'den', 'извинете',
  'izvinete', 'ве молам', 've molam', 'посакувам', 'posakuvam', 'господине',
  'gospodine', 'госпоѓа', 'gospogja', 'благодарам', 'blagodaram', 'ова', 'тоа', 'toa']);

export function detectContact(text: string): { name?: string; phone?: string } {
  let t = text.trim();
  // 078/914 196, 078 914 196, 078914196, 02 3123 456 — 3 or 4 number groups
  const phoneRe = /(0\d{1,2})[\s/.-]*(\d{2,4})[\s/.-]*(\d{2,4})(?:[\s/.-]*(\d{2,4}))?/;
  const m = t.match(phoneRe);
  let phone: string | undefined;
  if (m) {
    phone = m[0].replace(/[\s/.-]+/g, '');
    t = t.replace(m[0], ' ');
  }
  const words = t.split(/[^\p{L}]+/u)
    .map(w => w.toLowerCase())
    .filter(w => w.length >= 3 && !NAME_STOPWORDS.has(w));
  const name = words.length
    ? words.slice(0, 2).map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ')
    : undefined;
  return { name, phone };
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
  const { service, location, bedrooms, sqm, business, budget, rejected } = slots;
  const has = !!(service || location || bedrooms || budget || sqm);
  if (!has) return { type: 'STAY' };
  if (rejected && ['property_query', 'presentation', 'closing'].includes(state)) {
    return { type: 'REJECTED', service, location, bedrooms, sqm, business, budget };
  }
  // Commercial spaces complete with size (м²) instead of bedrooms.
  const complete = service && location && (business ? sqm : bedrooms) && budget;
  if (complete) {
    return { type: 'SEARCH_REQUESTED', service, location, bedrooms, sqm, business, budget };
  }
  if (service && !location && !bedrooms && !budget && !sqm) {
    return { type: 'INTENT_DECLARED', service, business };
  }
  return { type: 'DETAILS_PROVIDED', service, location, bedrooms, sqm, business, budget };
}

export function extractSlots(text: string): DetectedSlots {
  const out: DetectedSlots = {};
  const service = detectService(text);
  if (service) out.service = service;
  if (detectBusiness(text)) out.business = true;
  const beds = detectBedrooms(text);
  if (beds) out.bedrooms = beds;
  const sqm = detectSqm(text);
  if (sqm) out.sqm = sqm;
  const budget = detectBudget(text);
  if (budget) out.budget = budget;
  if (detectRejection(text)) out.rejected = true;
  return out;
}
