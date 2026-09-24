// THE INFO-ANSWER FAMILY (scope C) — the public-add becomes quotable.
//
// The where-is family binds by mention (the 12:33 rule), but price/size/room/
// feature asks still served "the last shown property" — the same disease one
// family over. THE CONTRACT: every ask family answers about the SAME bound
// property. When the client names it by anything ("garsonjerata", "kaj 69",
// "ovoj od 99000"), the mention resolver binds it; the facets extracted here
// decide WHAT to answer — always from the feed's public-add data, never the
// LLM, never invented.
//
// GUARDS (the lessons already paid for):
//   - a SEARCH CRITERION is not an info ask: "stan od 80 m2", "so parking",
//     "do 500 evra" carry no question scaffold and never match;
//   - an OPINION is not an info ask: "цените се превисоки" is guarded by the
//     caller (investment/fee-complaint detectors) and by the kolku-gates here;
//   - a facet with no stored data gets the honest no-data line — never a
//     fabricated feature.

import { Property } from '../data/properties';
import { normalizeMc } from './normalize';
import { detectPriceAsk, detectBudget } from './deterministic';

export interface InfoFacets {
  price?: boolean;
  sqm?: boolean;
  rooms?: boolean;      // "колку спални/соби"
  floor?: boolean;      // "на кој кат", "сутерен ли е"
  features?: string[];  // canonical feature names asked about
}

// Bare "колку е / колку чини" WITHOUT a price keyword is a price ask only
// when no unit/count word follows ("колку саати", "колку други имоти" are
// different questions entirely).
// NOTE: JS \b is ASCII-\w-based — it NEVER matches after a Cyrillic letter,
// so every boundary here is an explicit lookahead/consumed class instead.
const TAIL = '(?=[\\s?!.,]|$)';
const STEM = '[а-яa-z]*';
const NON_PRICE_KOLKU_RE =
  new RegExp(`колку\\s+(?:саат${STEM}|годин${STEM}|далеку|други${STEM}|имоти${STEM}|стана${STEM}|станови${STEM}|опции${STEM}|време${STEM}|луѓе${STEM})`, 'iu');

const SQM_KOLKU_RE = new RegExp(`колку\\s*(?:квадрат${STEM}|м2|м²)|колку\\s+(?:е\\s+)?голем${STEM}`, 'iu');
const SQM_WORD_RE = /(?:површина|големина)/iu;
const ROOMS_KOLKU_RE = new RegExp(`колку\\s+(?:соби${STEM}|спалн${STEM})`, 'iu');
const FLOOR_WORD_RE = new RegExp(`(?:сутерен|спрат${STEM}|приземј${STEM}|кат${TAIL})`, 'iu');

// Feature probes: canonical name → what it looks like in the message.
// Cyrillic-only because the text is probed through normalizeMc (Latin→Cyrillic).
const FEATURE_PROBES: Array<[RegExp, string]> = [
  [/(?:^|\s)лифт/iu, 'лифт'],
  [/(?:^|\s)паркинг/iu, 'паркинг'],
  [/(?:^|\s)гараж/iu, 'гаража'],
  [/(?:^|\s)(?:гре|парно)/iu, 'греење'],
  [/(?:^|\s)клим/iu, 'клима'],
  [/(?:^|\s)(?:двор|градин)/iu, 'двор'],
  [/(?:^|\s)(?:терас|балкон)/iu, 'тераса'],
  [/(?:^|\s)(?:наместен|опремен)/iu, 'наместен'],
  [/(?:^|\s)реновиран/iu, 'реновиран'],
];

/** The honest answer when a facet is asked about but the feed stores nothing:
 *  the agency relays owner questions, so the line promises exactly that. */
export const INFO_NO_DATA_LINE =
  'Тоа не е наведено во податоците што ги имам за имотот — ќе го прашам сопственикот и ќе Ви потврдам.';

/** Which facets the message asks about, or undefined when it is not an info
 *  ask. Question scaffolds are mandatory for every facet except price's own
 *  detector (which carries its own keyword gate) — a criterion or an opinion
 *  can never become an info answer. */
export function detectInfoFacets(text: string): InfoFacets | undefined {
  const t = normalizeMc(text); // Cyrillic-canonical — probes below are Cyrillic-only
  const isQuestion = /\?/.test(text)
    || new RegExp(`(?:^|\\s)(?:колку|дали|кој|која|кое|што|каков)${TAIL}`, 'iu').test(t)
    || /(?:^|\s)има\s+ли/iu.test(t);

  const f: InfoFacets = {};

  // SQM — "колку квадрат/м2", "колку (е) голем", or a површина/големина word
  // in a question. Computed BEFORE price so the bare-колку price branch can
  // yield to it ("колку е голем" — the "е" belongs to the size question).
  if (SQM_KOLKU_RE.test(t) || (isQuestion && SQM_WORD_RE.test(t))) f.sqm = true;

  // ROOMS — "колку соби/спални".
  if (ROOMS_KOLKU_RE.test(t)) f.rooms = true;

  // FLOOR — a floor word inside a question ("на кој кат е?", "сутерен ли е?").
  if (isQuestion && FLOOR_WORD_RE.test(t)) f.floor = true;

  // PRICE — the established detector (keyword-gated), minus the budget sense
  // ("до 500 евра" is a criterion, never a price ask); plus bare "колку е" —
  // but never when the колку-phrase is really about size/rooms/floor.
  if (detectPriceAsk(text) && !detectBudget(text)) f.price = true;
  else if (!f.sqm && !f.rooms && !f.floor
    && new RegExp(`(?:^|\\s)колку\\s*(?:е|чини|стои)${TAIL}`, 'iu').test(t)
    && !NON_PRICE_KOLKU_RE.test(t)) f.price = true;

  // FEATURES — feature words inside a question ("dali ima lift?", "klima?").
  if (isQuestion) {
    const asked: string[] = [];
    for (const [re, name] of FEATURE_PROBES) {
      if (re.test(t) && !asked.includes(name)) asked.push(name);
    }
    if (asked.length) f.features = asked;
  }

  if (!f.price && !f.sqm && !f.rooms && !f.floor && !f.features?.length) return undefined;
  return f;
}

// ---------------------------------------------------------------------------
// Answer builders — from the bound property's public-add data
// ---------------------------------------------------------------------------

function typeWord(p: Property): string {
  if (p.house) return 'Куќата';
  if (p.business) return 'Деловниот простор';
  if (p.bedrooms === 1) return 'Гарсоњерата';
  return 'Станот';
}

function bedroomPhrase(n: number): string {
  if (n === 1) return 'Има една спална соба.';
  if (n === 2) return 'Има две спални соби.';
  return `Има ${n} спални соби.`;
}

function floorPhrase(p: Property): string | undefined {
  const d = p.details ? normalizeMc(p.details) : '';
  if (/сутерен/iu.test(d)) return 'Се наоѓа во сутерен.';
  if (/приземј/iu.test(d)) return 'Се наоѓа во приземје.';
  const kat = d.match(/(?:на\s*)?(\d{1,2})\s*(?:ти)?\s*[-\s]?\s*(?:кат|спрат)/iu);
  if (kat) return `Се наоѓа на ${kat[1]} кат.`;
  return undefined;
}

function findFeaturePhrase(p: Property, canon: string): string | undefined {
  const feats = p.features ?? [];
  switch (canon) {
    case 'лифт': return feats.find(x => x.includes('лифт'));
    case 'паркинг': return feats.find(x => x.includes('паркинг'));
    case 'гаража': return feats.find(x => x.includes('гаража'));
    case 'греење': return feats.find(x => x.startsWith('греење') || x === 'парно');
    case 'клима': return feats.find(x => x.includes('клима'));
    case 'двор': return feats.find(x => x.includes('двор') || x.includes('градина'));
    case 'тераса': return feats.find(x => x.includes('тераса') || x.includes('балкон'));
    case 'наместен': return feats.find(x => x.includes('наместен'));
    case 'реновиран': {
      const d = p.details ? normalizeMc(p.details) : '';
      if (!/реновиран/iu.test(d)) return undefined;
      const yr = d.match(/реновиран(?:а)?(?:\s+во)?\s+(\d{4})/iu);
      return yr ? `реновиран во ${yr[1]}` : 'реновиран';
    }
    default: return undefined;
  }
}

/** Build the deterministic answer for the bound property, or undefined when
 *  nothing is stored for the asked facets (the message then falls through to
 *  the existing paths — owner-check relay, FSM price fallback). A feature-only
 *  ask about unstored data gets the honest no-data line. */
export function buildInfoAnswer(p: Property, facets: InfoFacets): string | undefined {
  const type = typeWord(p);
  const sentences: string[] = [];
  let answered = false;

  if (facets.price && p.price !== undefined) {
    // Rent-aware wording (the [22:53] contract): the client asked KOLKU MU E
    // KIRIJA — a rental's price is "киријата", not "чини".
    sentences.push(p.service === 'rent'
      ? `${type} со Евидентен број ${p.eb} — киријата изнесува ${p.price.toLocaleString('mk-MK')} евра.`
      : `${type} со Евидентен број ${p.eb} чини ${p.price.toLocaleString('mk-MK')} евра.`);
    answered = true;
  }
  if (facets.sqm && p.sqm !== undefined) {
    sentences.push(`Има ${p.sqm} м² станбена површина.`);
    answered = true;
  }
  if (facets.rooms) {
    if (p.bedrooms !== undefined) {
      sentences.push(bedroomPhrase(p.bedrooms));
      answered = true;
    } else if ((p.sqm ?? 99) < 35) {
      sentences.push('Тоа е гарсоњера — еден простор, без посебна спална соба.');
      answered = true;
    }
  }
  if (facets.floor) {
    const fl = floorPhrase(p);
    if (fl) {
      sentences.push(fl);
      answered = true;
    }
  }
  if (facets.features?.length) {
    const yes: string[] = [];
    for (const canon of facets.features) {
      const phrase = findFeaturePhrase(p, canon);
      if (phrase) yes.push(phrase);
    }
    if (yes.length) {
      sentences.push(`Има ${yes.join(' и ')}.`);
      answered = true;
    } else if (!facets.price && !facets.sqm && !facets.rooms && !facets.floor) {
      // Feature-only ask about data the feed doesn't store — honest deferral,
      // never a fabricated feature.
      return INFO_NO_DATA_LINE;
    }
  }

  if (!answered) return undefined;
  return sentences.join(' ');
}
