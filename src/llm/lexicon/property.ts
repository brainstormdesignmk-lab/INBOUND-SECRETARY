/**
 * THE PROPERTY-CATEGORY LEXICON — one vocabulary, several named readings.
 *
 * WHY THIS MODULE EXISTS: the same noun was spelled out in ~60 regexes across
 * deterministic.ts and inbound.ts, and they had already drifted apart:
 *
 *   • `HOUSE_RE` knew «куќ/кука/вила» but NOT latin `kukj*`, while the memory
 *     lane (`MEMORY_NOUN_RE`) accepted `kuk*` — so «kukja» was a house for one
 *     reader and nothing at all for another;
 *   • the strict flat reader knew «станче/станцеви» and the loose type reader
 *     `стан\p{L}*` additionally matched «станбен», «стандард» — same word,
 *     opposite verdicts, depending on which site asked;
 *   • the negated-category stripper listed a THIRD set (no «апартман»).
 *
 * A detector that answers "which category is this?" must not own its own word
 * list. It reads THIS one.
 *
 * TWO READINGS, both deliberate:
 *   - LOOSE (stems + `\p{L}*`): "does the message talk about a стан at all?" —
 *     matches «станбена површина», «стандард». Correct for *mentioning* a type
 *     in prose, WRONG for deciding the client wants one.
 *   - FORM (enumerated surface forms, whole-word): "did the client NAME this
 *     category?" — «стан/станот/станови/станче», never «станбен». This is the
 *     reading every category LOCK and funnel slot must use.
 */

import { NB, NA, stems as stemList } from './text';
import { normalizeMc } from '../normalize';

export type PropertyCategory =
  | 'house'
  | 'flat'
  | 'garsonjera'
  | 'apartment'
  | 'land'
  | 'business'
  | 'garage'
  | 'generic';

interface CategoryWords {
  /** Prefixes, safe to inflect with `\p{L}*` (the LOOSE reading). */
  stems: readonly string[];
  /** Real surface forms the clients type (the FORM reading). */
  forms: readonly string[];
  /** Singular + definite singular only. «имавте КУЌИ во Центар?» is a stock
   *  question about a market, «имавте ЕДНА куќа» names one listing — only a
   *  singular form may carry a unit-less recall. */
  singularForms: readonly string[];
  /** Plural forms only — the MARKET signal («станови», «плацеви»).
   *  NOT derived as `forms − singularForms`: deriving it read the definite
   *  singular «СТАНОВ» as a plural, and a client asking «STO MOZES DA MI KAZES
   *  ZA STANOV ?» was answered with the €/m² market band. A form belongs to
   *  exactly one of singular/plural, and tests/lexicon-agreement.test.ts
   *  enforces the partition. */
  pluralForms: readonly string[];
  /** Stems that are IDENTITY-SAFE: they may be inflected inside the FORM
   *  reading, because every word they can build is still this category and a
   *  typo of it («KUKJAA» = a doubled letter, the [20:56] capture). «стан» is
   *  deliberately absent: `стан\p{L}*` also builds «станбен», «стандард». */
  formStems?: readonly string[];
  /** The noun Lina says back about it. */
  label: string;
  /** Finer nouns inside one category, for copy that must say what the client
   *  actually named («Таа ЛОКАЛ е стара понуда…» reads better than «деловен
   *  простор» for a message that said «локал»). First match wins. */
  subNouns?: ReadonlyArray<{ forms: readonly string[]; label: string }>;
}

export const PROPERTY_WORDS: Record<PropertyCategory, CategoryWords> = {
  house: {
    stems: ['куќ', 'куч', 'kukj', 'kuka', 'kukata', 'kukuca', 'kuc', 'хоусе', 'vila', 'вила'],
    // «куч» rides with «ќ» — the [02:00] capture itself typed «КУчА».
    forms: [
      'куќа', 'куќата', 'куќи', 'куќите', 'куќичка', 'куќичката',
      'кука', 'куката', 'кукја', 'кукји', 'кукјата', 'кукуца', 'куча', 'кучата',
      'kukja', 'kukjata', 'kukji', 'kukjite', 'kuka', 'kukata', 'kukuca', 'kuca', 'kucata',
      'house', 'хоусе', 'вила', 'вилата', 'вили', 'vila', 'vilata', 'vili',
    ],
    singularForms: [
      'куќа', 'куќата', 'куќичка', 'куќичката',
      'кука', 'куката', 'кукја', 'кукјата', 'кукуца', 'куча', 'кучата',
      'kukja', 'kukjata', 'kuka', 'kukata', 'kukuca', 'kuca', 'kucata',
      'house', 'хоусе', 'вила', 'вилата', 'vila', 'vilata',
    ],
    pluralForms: ['куќи', 'куќите', 'кукји', 'kukji', 'kukjite', 'вили', 'vili'],
    formStems: ['куќ', 'kukj', 'куч', 'kuc'],
    label: 'куќа',
  },
  flat: {
    stems: ['стан', 'stan', 'stn'],
    // «станбен»/«стандард» are NOT flats — see FLAT_WORD_RE's history: the
    // loose stem matched the most common word in this feed («станбена
    // површина») and the funnel served apartments the client never named.
    forms: [
      'стан', 'стана', 'стани', 'станот', 'станов', 'станови', 'становите',
      'станче', 'станчето', 'станце', 'станцеви', 'станцевите',
      'stan', 'stana', 'stani', 'stanot', 'stanov', 'stanovi', 'stanovite',
      'stance', 'stancevi', 'stancevite', 'stnovi', 'stnovite',
      'stn', 'stna', 'stni', 'stno', 'stnot',
    ],
    singularForms: [
      'стан', 'станот', 'стана', 'станов', 'станче', 'станчето', 'станце',
      'stan', 'stanot', 'stana', 'stanov', 'stance', 'stn', 'stna', 'stni', 'stno', 'stnot',
    ],
    pluralForms: [
      'стани', 'станови', 'становите', 'станцеви', 'станцевите',
      'stani', 'stanovi', 'stanovite', 'stancevi', 'stancevite',
      'stnovi', 'stnovite',
    ],
    // NO «стан» stem here — see formStems. `stn` is the client's shorthand and
    // builds nothing else.
    formStems: ['stn'],
    label: 'стан',
  },
  garsonjera: {
    stems: ['гарсоњер', 'garsonjer', 'garsoњer', 'garson'],
    forms: [
      'гарсоњера', 'гарсоњерата', 'гарсоњери', 'гарсоњерита', 'гарсоњерка',
      'garsonjera', 'garsonjerata', 'garsonjeri', 'garsonjerka',
      // A STUDIO IS THIS CATEGORY (AGENTS.md §4b-1: it carries no room count),
      // and the mention binder already read «студио» as one while the funnel
      // reader did not — the same word, two verdicts.
      'студио', 'студиото', 'studio', 'studioto',
    ],
    singularForms: [
      'гарсоњера', 'гарсоњерата', 'гарсоњерка',
      'garsonjera', 'garsonjerata', 'garsonjerka',
      'студио', 'студиото', 'studio', 'studioto',
    ],
    pluralForms: ['гарсоњери', 'гарсоњерита', 'garsonjeri'],
    formStems: ['гарсоњер', 'garsonjer'],
    label: 'гарсоњера',
    subNouns: [
      { forms: ['студио', 'студиото', 'studio', 'studioto'], label: 'студио' },
    ],
  },
  apartment: {
    stems: ['апартман', 'apartman', 'апартмент', 'apartment', 'дуплекс', 'duplex'],
    forms: [
      'апартман', 'апартманот', 'апартмани', 'апартманите',
      'apartman', 'apartmanot', 'apartmani', 'apartmanite',
      'апартмент', 'apartment', 'дуплекс', 'duplex',
    ],
    singularForms: [
      'апартман', 'апартманот', 'apartman', 'apartmanot',
      'апартмент', 'apartment', 'дуплекс', 'duplex',
    ],
    pluralForms: ['апартмани', 'апартманите', 'apartmani', 'apartmanite'],
    label: 'апартман',
  },
  land: {
    stems: ['плац', 'plac', 'ploc', 'плоц', 'земјишт', 'zemjist'],
    forms: [
      'плац', 'плацот', 'плацови', 'плацовите', 'plac', 'placot', 'placovi',
      'ploc', 'plocot', 'земјиште', 'земјиштето', 'zemjiste', 'zemjisteto',
      'плацеви', 'плацевите', 'placevi',
    ],
    singularForms: [
      'плац', 'плацот', 'plac', 'placot', 'ploc', 'plocot',
      'земјиште', 'земјиштето', 'zemjiste', 'zemjisteto',
    ],
    pluralForms: [
      'плацови', 'плацовите', 'placovi', 'плацеви', 'плацевите', 'placevi',
    ],
    formStems: ['плац', 'plac'],
    label: 'плац',
  },
  business: {
    stems: [
      'локал', 'lokal', 'деловен', 'deloven', 'duќан', 'дуќан', 'dukjan', 'dukan',
      'канцелари', 'kancelari', 'магацин', 'magacin', 'продавниц', 'prodavnic',
      'бизнис', 'biznis', 'офис', 'ofis', 'склад', 'sklad', 'хала', 'hala',
      'ателје', 'atelje', 'пословен', 'posloven',
    ],
    forms: [
      'локал', 'локалот', 'локали', 'локалите', 'lokal', 'lokalot', 'lokali',
      'деловен простор', 'деловниот простор', 'деловни простори',
      'deloven prostor', 'delovniot prostor', 'dukjan', 'dukjanot', 'dukan', 'dukanot',
      'дуќан', 'дуќанот', 'канцеларија', 'канцеларијата', 'kancelarija',
      'магацин', 'магацинот', 'magacin', 'склад', 'sklad', 'хала', 'hala',
      'продавница', 'продавницата', 'prodavnica', 'ателје', 'atelje',
      'бизнис простор', 'biznis prostor',
    ],
    singularForms: [
      'локал', 'локалот', 'lokal', 'lokalot', 'деловен простор', 'деловниот простор',
      'deloven prostor', 'delovniot prostor', 'дуќан', 'дуќанот', 'dukjan', 'dukjanot',
      'dukan', 'dukanot', 'канцеларија', 'канцеларијата', 'kancelarija', 'магацин',
      'магацинот', 'magacin', 'склад', 'sklad', 'хала', 'hala',
      'продавница', 'продавницата', 'prodavnica', 'ателје', 'atelje',
      'бизнис простор', 'biznis prostor',
    ],
    pluralForms: ['локали', 'локалите', 'lokali', 'деловни простори'],
    formStems: ['локал', 'lokal', 'канцелари', 'kancelari', 'магацин', 'magacin'],
    label: 'деловен простор',
    subNouns: [
      { forms: ['локал', 'локалот', 'локали', 'локалите', 'lokal', 'lokalot', 'lokali'], label: 'локал' },
      { forms: ['дуќан', 'дуќанот', 'dukjan', 'dukjanot', 'dukan', 'dukanot'], label: 'дуќан' },
      { forms: ['канцеларија', 'канцеларијата', 'kancelarija'], label: 'канцеларија' },
      { forms: ['магацин', 'магацинот', 'magacin'], label: 'магацин' },
      { forms: ['склад', 'sklad'], label: 'склад' },
      { forms: ['хала', 'hala'], label: 'хала' },
      { forms: ['продавница', 'продавницата', 'prodavnica'], label: 'продавница' },
    ],
  },
  garage: {
    stems: ['гараж', 'garaz'],
    forms: ['гаража', 'гаражата', 'гаражи', 'гаражите', 'garaza', 'garazha', 'garazhi'],
    singularForms: ['гаража', 'гаражата', 'garaza', 'garazha'],
    pluralForms: ['гаражи', 'гаражите', 'garazhi'],
    formStems: ['гараж', 'garaz'],
    label: 'гаража',
  },
  /**
   * Words about a property that name NO category — they keep a search ("what
   * do you have") alive without narrowing it. A funnel that read «имотот» as a
   * flat served the wrong cards; the tail here is what "untyped" means.
   */
  generic: {
    stems: [
      'имот', 'imot', 'недвижност', 'nedviznost', 'некретнин', 'nekretnin',
      'објект', 'objekt', 'простор', 'prostor', 'зград', 'zgrad', 'соба', 'soba',
      'дом', 'dom', 'станбен', 'stamben', 'куќишт', 'kukjisht',
    ],
    forms: [
      'имот', 'имотот', 'imot', 'imotot', 'недвижност', 'недвижноста', 'nedviznost',
      'некретнина', 'nekretnina', 'објект', 'објектот', 'objekt', 'простор',
      'просторот', 'prostor', 'зграда', 'зградата', 'zgrada', 'соба', 'собата',
      'soba', 'дом', 'домот', 'dom',
      'простори', 'просторите', 'prostori',
    ],
    singularForms: [
      'имот', 'имотот', 'imot', 'imotot', 'недвижност', 'недвижноста', 'nedviznost',
      'некретнина', 'nekretnina', 'објект', 'објектот', 'objekt',
      'зграда', 'зградата', 'zgrada', 'соба', 'собата', 'soba',
      'простор', 'просторот', 'prostor', 'дом', 'домот', 'dom',
    ],
    pluralForms: ['простори', 'просторите', 'prostori'],
    label: 'недвижност',
  },
};

const ALL: readonly PropertyCategory[] = [
  'house', 'flat', 'garsonjera', 'apartment', 'land', 'business', 'garage', 'generic',
];

/** Categories that ARE a home (a гapсоњера and an апартман are flats too). */
export const HOME_CATEGORIES: readonly PropertyCategory[] = ['house', 'flat', 'garsonjera', 'apartment'];

/** The words Lina uses for a category in copy. */
export function categoryLabel(cat: PropertyCategory): string {
  return PROPERTY_WORDS[cat].label;
}

/**
 * LOOSE reading — stem + `\p{L}*`, whole-word bounded. For "is this message
 * about a стан?" (mention/description reading), never for a category lock.
 */
export function looseTypePattern(cats: readonly PropertyCategory[] = ALL): string {
  // Stems AND forms: a form whose prefix is not a safe stem («кука», which
  // shares no stem with «куќа» because «кук» alone would match «кукуруз») must
  // still be inside the wider class — the FORM reading is a SUBSET of LOOSE by
  // contract, and the agreement sweep enforces it.
  const list = cats.flatMap((c) => [...PROPERTY_WORDS[c].stems, ...PROPERTY_WORDS[c].forms]);
  return `${NB}${stemList(list)}${NA}`;
}

/**
 * FORM reading — the category is NAMED: enumerated surface forms, whole word.
 * Every category lock, funnel slot and negated-span stripper reads this.
 */
export function typeFormPattern(cats: readonly PropertyCategory[] = ALL): string {
  return `${NB}${typeFormAlternation(cats)}${NA}`;
}

/**
 * The FORM alternation WITHOUT boundaries — for a caller that already sits
 * inside its own guard (the recall detector composes `${NB}…${NA}` around it,
 * and two boundary pairs in one pattern is how a lookbehind silently eats the
 * word before it).
 */
export function typeFormAlternation(cats: readonly PropertyCategory[] = ALL): string {
  // LONGEST FIRST: «деловен простор» must win over «простор» alone, and
  // «гарсоњера» over the «гарсон»-prefixed accidents.
  //
  // An IDENTITY-SAFE stem (formStems) joins INFLECTED — a stem is a prefix by
  // definition, so the bare letters would match nothing («kukj» in «KUKJAA»).
  // Every other entry joins verbatim, which is what keeps «станбен» out.
  const list = cats
    .flatMap((c) => [
      ...PROPERTY_WORDS[c].forms,
      ...(PROPERTY_WORDS[c].formStems ?? []).map((stem) => `${stem}\\p{L}*`),
    ])
    .sort((a, b) => b.length - a.length);
  return `(?:${list.join('|')})`;
}

/**
 * PLURAL FORM alternation (no boundaries) — «станови», «куќи», «плацеви».
 * The plural is the MARKET signal (a segment question), the singular is one
 * listing; deriving it from the same table is what keeps the two readers
 * honest (the router and `hasMarketTypePlural` each had their own list).
 */
export function typePluralAlternation(cats: readonly PropertyCategory[] = ALL): string {
  const list = cats
    .flatMap((c) => [...PROPERTY_WORDS[c].pluralForms])
    .sort((a, b) => b.length - a.length);
  return `(?:${list.join('|')})`;
}

/** Singular-only FORM alternation (no boundaries) — the unit-less recall arm. */
export function typeSingularAlternation(cats: readonly PropertyCategory[] = ALL): string {
  const list = cats
    .flatMap((c) => [...PROPERTY_WORDS[c].singularForms])
    .sort((a, b) => b.length - a.length);
  return `(?:${list.join('|')})`;
}

/** Compiled loose matcher (stems + inflection), for the mention reading. */
export const PROPERTY_TYPE_LOOSE_RE = new RegExp(looseTypePattern(), 'iu');

/**
 * THE ONE READER: which categories does this message NAME? Both scripts, raw
 * and normalised (a Latin spelling the normaliser cannot map still counts —
 * the FORM list carries the Latin forms itself).
 *
 * Build it once and reuse: `new RegExp(typeFormPattern(), 'iu')` is costly to
 * construct per message, so the module keeps the default matcher.
 */
let FORM_RE: RegExp | undefined;
function formRe(): RegExp {
  FORM_RE ??= new RegExp(typeFormPattern(), 'iu');
  return FORM_RE;
}

export function propertyCategoriesIn(text: string): PropertyCategory[] {
  const seen: PropertyCategory[] = [];
  const probe = `${text}\n${normalizeMc(text)}`;
  for (const cat of ALL) {
    const forms = PROPERTY_WORDS[cat].forms;
    const re = new RegExp(`${NB}(?:${forms.map(escapeRe).join('|')})${NA}`, 'iu');
    if (re.test(probe)) seen.push(cat);
  }
  return seen;
}

/** Does the message NAME this category (or, for a home, a narrower one)? */
export function namesCategory(text: string, cat: PropertyCategory): boolean {
  const named = propertyCategoriesIn(text);
  if (named.includes(cat)) return true;
  // A гapсоњера / апартман IS a flat; a flat is a home but not a house.
  if (cat === 'flat') return named.some((c) => c === 'garsonjera' || c === 'apartment');
  if (cat === 'house') return named.includes('house');
  return false;
}

/**
 * The single strongest category the message names, for the copy that has to
 * say one noun back («Таа куќа е стара понуда…»). Business first: a
 * «деловен простор» contains the generic «простор» and must never read as one.
 */
export function readPropertyCategory(text: string): PropertyCategory | undefined {
  const named = propertyCategoriesIn(text);
  const order: PropertyCategory[] = [
    'business', 'land', 'garsonjera', 'apartment', 'house', 'flat', 'garage', 'generic',
  ];
  return order.find((c) => named.includes(c));
}

/**
 * The NOUN to say back — the finest form the message names («локал» for a
 * локал, «деловен простор» for the family, «куќа» for a куќа). Used by the copy
 * readers so the ack never calls a локал a деловен простор.
 */
export function readPropertyNoun(text: string): string | undefined {
  const probe = `${text}\n${normalizeMc(text)}`;
  const order: PropertyCategory[] = [
    'business', 'land', 'garsonjera', 'apartment', 'house', 'flat', 'garage', 'generic',
  ];
  for (const cat of order) {
    const words = PROPERTY_WORDS[cat];
    for (const sub of words.subNouns ?? []) {
      if (new RegExp(`${NB}(?:${sub.forms.map(escapeRe).join('|')})${NA}`, 'iu').test(probe)) {
        return sub.label;
      }
    }
    const forms = words.forms;
    if (new RegExp(`${NB}(?:${forms.map(escapeRe).join('|')})${NA}`, 'iu').test(probe)) {
      return words.label;
    }
  }
  return undefined;
}

/** `true` when the message names a category the funnel can serve as a home. */
export function namesHomeCategory(text: string): boolean {
  return propertyCategoriesIn(text).some((c) => HOME_CATEGORIES.includes(c));
}

/** Unused import guard (formRe is kept for callers that want the raw matcher). */
export function propertyFormMatcher(): RegExp {
  return formRe();
}

function escapeRe(word: string): string {
  return word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
