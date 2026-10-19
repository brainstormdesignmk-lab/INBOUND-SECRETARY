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
import { hasParkingWord } from './morphology';
import { detectPriceAsk, detectBudget } from './deterministic';

export interface InfoFacets {
  price?: boolean;
  sqm?: boolean;
  rooms?: boolean;      // "колку спални/соби"
  floor?: boolean;      // "на кој кат", "сутерен ли е"
  /** "колку ката има зградата" — the BUILDING height, not the unit's floor. */
  totalFloors?: boolean;
  /** "дали е на последен кат" — needs the unit floor AND the building height. */
  lastFloor?: boolean;
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
  new RegExp(`колку\\s+(?:саат${STEM}|годин${STEM}|далеку|други${STEM}|имоти${STEM}|недвижности${STEM}|стана${STEM}|станови${STEM}|опции${STEM}|време${STEM}|луѓе${STEM})`, 'iu');

const SQM_KOLKU_RE = new RegExp(`колку\\s*(?:квадрат${STEM}|м2|м²)|колку\\s+(?:е\\s+)?голем${STEM}`, 'iu');
const SQM_WORD_RE = /(?:површина|големина)/iu;
const ROOMS_KOLKU_RE = new RegExp(`колку\\s+(?:соби${STEM}|спалн${STEM})`, 'iu');
// кат/катови/катот… but never "каталог"/"катастрофа": the suffix is explicit.
const FLOOR_WORD_RE = new RegExp(`(?:сутерен|спрат${STEM}|приземј${STEM}|кат(?:от|а|ови|овите|че)?${TAIL})`, 'iu');
// "последен кат", "најгорниот спрат" — a yes/no about the TOP floor.
const LAST_FLOOR_RE = /(?:последен|последниот|најгорниот)\s*(?:кат|спрат)/iu;
// The ELLIPTICAL follow-up: after "на кој кат е?" → "Се наоѓа на 3 кат." the
// client types just "POSLEDEN ?" — the noun is carried by the conversation,
// and without this the message has no facet at all and fell into the
// presentation lane (the [22:23] transcript: the exhausted-options bank line
// instead of the yes/no "Да — станот е на последниот кат (3 од 3)"). It must be the
// WHOLE reply — "posledniot stan" (the last flat) or "posleden pat" (last
// time) are different questions and never match.
const BARE_LAST_FLOOR_RE = /^(?:[иа]\s+)?(?:дали\s+(?:е\s+)?)?(?:на\s+)?(?:последен|последниот|најгорниот|најгорен)$/iu;
// "колку (вкупно) ката/спратови" — a COUNT, so the noun must be PLURAL (or
// "ката"). A bare "на 3 кат" is a location inside a size question ("колку е
// голем станот на 3 кат") and must stay a size question.
const TOTAL_FLOORS_RE = new RegExp(
  `(?:(?:колку|вкупно)[^.!?]{0,30}(?:катови|спратови|ката|спрата|кати|спрати)|`
  + `(?:зграда|објект)[^.!?]{0,20}(?:има|висока)[^.!?]{0,15}(?:кат|спрат))`, 'iu');

// Feature probes: canonical name → what it looks like in the message.
// Cyrillic-only because the text is probed through normalizeMc (Latin→Cyrillic).
// NOTE: parking is NOT in this table — it is matched by hasParkingWord()
// (morphology.ts), which recognizes the whole derivational family
// (паркирање/паркинзи/паркиралиште) and one-slip typos, not just the literal
// noun. See the FEATURE block below.
const FEATURE_PROBES: Array<[RegExp, string]> = [
  [/(?:^|\s)лифт/iu, 'лифт'],
  [/(?:^|\s)гараж/iu, 'гаража'],
  [/(?:^|\s)(?:гре|парно)/iu, 'греење'],
  [/(?:^|\s)клим/iu, 'клима'],
  [/(?:^|\s)(?:двор|градин)/iu, 'двор'],
  [/(?:^|\s)(?:терас|балкон)/iu, 'тераса'],
  [/(?:^|\s)(?:наместен|опремен)/iu, 'наместен'],
  [/(?:^|\s)реновиран/iu, 'реновиран'],
];

// A SEARCH CRITERION is not a feature ask. "BARAM STAN SO PARKING?" names the
// feature the CLIENT WANTS, not one the discussed flat is being asked about —
// serving it from the bound property would answer "Има јавен паркинг" about a
// flat they never asked about. Same for "имате ли стан со паркинг?". The
// parking family made this reachable (the literal probe missed the derived
// forms), so the veto is explicit: a search verb / "имате ли стан" turns the
// feature word into intake, and the FSM owns it.
// The verb alone is not enough ("барам да знам дали има паркинг?" IS an info
// ask) — the criterion needs the property OBJECT: "барам стан со паркинг".
const SEARCH_CRITERION_RE = /(?:(?:^|[\s,.])(?:барам|бараме|барате|бара|ми\s+треба|ни\s+треба|baram|barame|barate|bara|mi\s+treba|ni\s+treba|looking\s+for)[^.!?\n]{0,25}(?:стан|станови|куќ|нешто|nesto|stan|stanovi|kuc))|(?:(?:има(?:те)?\s+ли|imate\s+li)\s+(?:стан|станови|куќ|нешто|nesto|stan|stanovi|kuc))/iu;

/** The honest answer when a facet is asked about but the feed stores nothing:
 *  the agency relays owner questions, so the line promises exactly that. */
export const INFO_NO_DATA_LINE =
  'Немам информација во системот; немам податок во базата — ќе го прашам сопственикот и ќе Ви потврдам.';

/** The BUILDING-height miss: the feed's `vkupno_katovi` is "Не е наведено".
 *  Distinct from the generic line because the client asked a countable fact —
 *  saying exactly which fact is missing (and that the owner is being asked)
 *  is the honest answer, not a restatement of the unit's floor. */
export const INFO_NO_FLOORS_LINE =
  'Немам податок во базата колку ката има зградата — ќе го прашам сопственикот и ќе Ви потврдам.';

export interface InfoAskContext {
  /** The previous assistant line already named a floor ("Се наоѓа на 3 кат" /
   *  "Зградата има 5 ката") — what makes a bare "posleden?" a last-floor ask
   *  and not a question about the last property shown. */
  floorOnTable?: boolean;
}

/** Which facets the message asks about, or undefined when it is not an info
 *  ask. Question scaffolds are mandatory for every facet except price's own
 *  detector (which carries its own keyword gate) — a criterion or an opinion
 *  can never become an info answer. */
export function detectInfoFacets(text: string, ctx: InfoAskContext = {}): InfoFacets | undefined {
  const t = normalizeMc(text); // Cyrillic-canonical — probes below are Cyrillic-only
  // "POSLEDEN ?" / "DALI E NA POSLEDNIOT?" — no noun. Only the conversation
  // can supply it, so the caller passes floorOnTable; an explicit "дали" is
  // a question on its own. A bare word with no floor on the table stays
  // ambiguous ("the last one?") and is NEVER turned into a floor answer.
  const bareLastFloor = BARE_LAST_FLOOR_RE.test(t.replace(/[\s?!.,…:;]+$/u, '').trim())
    // JS \b is ASCII-only and never fires after a Cyrillic letter — an
    // explicit lookahead is the boundary here.
    && (ctx.floorOnTable === true || /(?:^|\s)дали(?=[\s?!.,]|$)/iu.test(t));
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

  // FLOOR FAMILY — three different questions that all name a floor:
  //   "на кој кат е?"            → floor (the unit's storey)
  //   "колку ката има зградата?" → totalFloors (building height)
  //   "дали е на последен кат?"  → lastFloor (needs both facts)
  // Serving the unit's floor for the last two is the [10:40] transcript bug:
  // "KOLKU IMA SPRATOVI ZGRADATA?" was answered with "Се наоѓа на 3 кат."
  if (isQuestion && FLOOR_WORD_RE.test(t)) {
    if (LAST_FLOOR_RE.test(t)) f.lastFloor = true;
    else if (TOTAL_FLOORS_RE.test(t)) f.totalFloors = true;
    else f.floor = true;
  } else if (bareLastFloor) {
    // the noun lived in the previous turn — still a yes/no about the TOP floor
    f.lastFloor = true;
  }

  // FEATURES — feature words inside a question ("dali ima lift?", "klima?",
  // "kako e reseno parkiranjeto?"). Computed BEFORE price: a feature word
  // means the question counts the FEATURE ("kolku parking mesta ima?"), so
  // the bare-колку price branch below must yield to it — otherwise the answer
  // was the flat's price AND the parking line together.
  if (isQuestion && !SEARCH_CRITERION_RE.test(t)) {
    const asked: string[] = [];
    for (const [re, name] of FEATURE_PROBES) {
      if (re.test(t) && !asked.includes(name)) asked.push(name);
    }
    if (hasParkingWord(t)) asked.push('паркинг');
    if (asked.length) f.features = asked;
  }

  // PRICE — the established detector (keyword-gated), minus the budget sense
  // ("до 500 евра" is a criterion, never a price ask); plus bare "колку е" —
  // but never when the колку-phrase is really about size/rooms/floor.
  if (detectPriceAsk(text) && !detectBudget(text)) f.price = true;
  else if (!f.sqm && !f.rooms && !f.floor
    && new RegExp(`(?:^|\\s)колку\\s*(?:е|чини|стои)${TAIL}`, 'iu').test(t)
    && !NON_PRICE_KOLKU_RE.test(t)) f.price = true;

  if (!f.price && !f.sqm && !f.rooms && !f.floor && !f.totalFloors && !f.lastFloor
    && !f.features?.length) return undefined;
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

/** The same noun mid-sentence ("…, станот е на 3 кат од вкупно 5"). */
function typeLower(p: Property): string {
  if (p.house) return 'куќата';
  if (p.business) return 'деловниот простор';
  if (p.bedrooms === 1) return 'гарсоњерата';
  return 'станот';
}

/** Macedonian: 1 кат, 2+ ката. */
function floorsWord(n: number): string {
  return n === 1 ? 'кат' : 'ката';
}

function bedroomPhrase(n: number): string {
  if (n === 1) return 'Има една спална соба.';
  if (n === 2) return 'Има две спални соби.';
  return `Има ${n} спални соби.`;
}

/** The unit's storey: the STRUCTURED feed column first (`kat` — hand-entered
 *  or imported by Ana), the ad text only as a fallback. Reading the text first
 *  meant a row whose opis never names the floor answered "not in the data"
 *  although the feed knew the floor all along. */
function unitFloor(p: Property): number | undefined {
  if (p.floor !== undefined) return p.floor;
  if (p.totalFloors !== undefined) {
    // no structured unit floor — the text may still carry "3/5"
    const d = p.details ? normalizeMc(p.details) : '';
    const pair = d.match(/(\d{1,2})\s*\/\s*\d{1,2}/u);
    if (pair) return Number(pair[1]);
  }
  const d = p.details ? normalizeMc(p.details) : '';
  if (/сутерен/iu.test(d)) return -1;
  if (/приземј/iu.test(d)) return 0;
  const kat = d.match(/(?:на\s*)?(\d{1,2})\s*(?:ти)?\s*[-\s]?\s*(?:кат|спрат)/iu);
  return kat ? Number(kat[1]) : undefined;
}

function floorPhrase(p: Property): string | undefined {
  const n = unitFloor(p);
  if (n === undefined) return undefined;
  if (n === -1) return 'Се наоѓа во сутерен.';
  if (n === 0) return 'Се наоѓа во приземје.';
  return `Се наоѓа на ${n} кат.`;
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
    // A floor ask with no stored floor is a missing FACT, not a silent fall
    // through to the generic lane (which used to answer with something else).
    sentences.push(fl ?? INFO_NO_DATA_LINE);
    answered = true;
  }
  // "колку ката има зградата" — the BUILDING's height. Never the unit floor.
  if (facets.totalFloors) {
    if (p.totalFloors !== undefined && p.totalFloors > 0) {
      sentences.push(`${p.house ? 'Куќата' : 'Зградата'} има ${p.totalFloors} ${floorsWord(p.totalFloors)}.`);
    } else {
      sentences.push(INFO_NO_FLOORS_LINE);
    }
    answered = true;
  }
  // "дали е на последен кат" — yes/no needs BOTH facts; with the height
  // unknown, state the floor and defer the rest to the owner (never a bare
  // "Се наоѓа на 3 кат", which does not answer the question asked).
  if (facets.lastFloor) {
    const fl = unitFloor(p);
    const total = p.totalFloors;
    if (fl !== undefined && fl > 0 && total !== undefined && total > 0) {
      sentences.push(fl >= total
        ? `Да — ${typeLower(p)} е на последниот кат (${fl} од ${total}).`
        : `Не, ${typeLower(p)} е на ${fl} кат од вкупно ${total}.`);
    } else if (fl !== undefined && fl >= 0) {
      sentences.push(`${fl === 0 ? 'Се наоѓа во приземје' : `Се наоѓа на ${fl} кат`}, но немам податок во базата колку ката има зградата — ќе го прашам сопственикот и ќе Ви потврдам.`);
    } else {
      sentences.push(INFO_NO_DATA_LINE);
    }
    answered = true;
  }
  if (facets.features?.length) {
    const yes: string[] = [];
    const absent: string[] = [];
    for (const canon of facets.features) {
      const phrase = findFeaturePhrase(p, canon);
      if (phrase) yes.push(phrase);
      // The feed's explicit "Не" is a KNOWN answer — "Нема лифт", never the
      // owner-relay line (the [10:39] EB 85 lift ask).
      else if (p.noFeatures?.includes(canon)) absent.push(canon);
    }
    if (yes.length) {
      sentences.push(`Има ${yes.join(' и ')}.`);
      answered = true;
    }
    if (absent.length) {
      sentences.push(`${absent.map(x => `Нема ${x}`).join(' и ')}.`);
      answered = true;
    }
    if (!answered && sentences.length === 0
      && !facets.price && !facets.sqm && !facets.rooms
      && !facets.floor && !facets.totalFloors && !facets.lastFloor) {
      // Feature-ONLY ask about data the feed doesn't store — honest deferral,
      // never a fabricated feature. When another facet already answered
      // ("na koj kat e i ima lift?"), the stored fact must not be discarded.
      return INFO_NO_DATA_LINE;
    }
  }

  if (!answered) return undefined;
  return sentences.join(' ');
}
