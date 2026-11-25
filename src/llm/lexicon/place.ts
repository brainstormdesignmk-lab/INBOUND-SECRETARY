/**
 * THE PLACE LEXICON — a POINT, an AREA, or the place already bound.
 *
 * «кај/до/близу + X» reads a landmark the map can resolve; «во + X» reads a
 * district. That distinction is a CONTRACT in this appliance (AGENTS.md §4r):
 * the place lane owns the point answer, the recall/discovery lanes own the
 * area. It was spelled out locally in three places (the one-place reading, the
 * description precedence, the recall gate) and a local copy drifts — the first
 * version of the recall gate read «до» as a landmark even when it was a PRICE
 * («имавте куќа во Скопје Север ДО 130.000»), which silently handed the turn
 * back to the criteria grill.
 *
 * The guards that make it correct, encoded here once:
 *   • the preposition must be followed by a NON-NUMERIC word (a price is not a
 *     place);
 *   • «кај вас/нас» is the AGENCY anchor (a memory line), not a place name;
 *   • «таму/тамо/там» points at the place already bound in the session.
 */

import { NB, NA, WS } from './text';
import { normalizeMc } from '../normalize';

/** Prepositions that introduce a landmark (both scripts). */
export const LANDMARK_PREPS = [
  'кај', 'kaj', 'кaj', 'до', 'do', 'близу', 'blizu', 'наспроти', 'nasproti',
  'спроти', 'sproti', 'околу', 'okolu', 'near', 'close',
];
/** The adverb that points at the place already on the table. */
export const ANCHOR_ADVERBS = ['таму', 'тамо', 'там', 'tamu', 'tamo', 'tam'];
/** Prepositions that introduce an area/district (never a point). */
export const AREA_PREPS = ['во', 'vo', 'на', 'na', 'низ', 'niz', 'по', 'po'];

/** «во близина на» — a landmark phrase, not two separate prepositions. */
const NEAR_PHRASE = `(?:во\\s+близина\\s+на|vo\\s+blizina\\s+na)`;
/** The agency anchor — a memory line, never a landmark. */
const AGENCY_ANCHOR = '(?:вас|нас|vas|nas)';

/**
 * A landmark PREPOSITION with something that can be a place after it:
 * not a digit, not the agency pronoun. Used as a test, not for extraction.
 */
export function landmarkPrepPattern(): RegExp {
  return new RegExp(
    `${NB}(?:${LANDMARK_PREPS.join('|')})${NA}${WS}`
    + `(?!\\d|${AGENCY_ANCHOR}${NA})`,
    'iu',
  );
}

/** «во близина на» alone (it carries its own «на», so it needs no complement test). */
export function nearPhrasePattern(): RegExp {
  return new RegExp(`${NB}${NEAR_PHRASE}${NA}`, 'iu');
}

export function anchorAdverbPattern(): RegExp {
  return new RegExp(`${NB}(?:${ANCHOR_ADVERBS.join('|')})${NA}`, 'iu');
}

/** Compiled matchers (the handler asks these once per message). */
export const LANDMARK_PREP_RE = landmarkPrepPattern();
export const NEAR_PHRASE_RE = nearPhrasePattern();
export const ANCHOR_ADVERB_RE = anchorAdverbPattern();

/**
 * THE ONE PREDICATE: does this clause read a POINT (a landmark or the bound
 * place) rather than a district? Every lane that has to decide between the
 * two calls THIS — never a local copy of the list.
 */
export function isLandmarkAnchored(text: string): boolean {
  return LANDMARK_PREP_RE.test(text)
    || NEAR_PHRASE_RE.test(text)
    || ANCHOR_ADVERB_RE.test(text);
}

// ── A DESTINATION NAMED BY ITS TYPE ─────────────────────────────────────────
// «НА КОЛКАВО РАСТОЈАНИЕ Е ОД ГРАДИНКАВА ?» (the [12:28] capture) arrived one
// turn after Lina had named the kindergarten, so «градинкава» IS that place —
// but it is a TYPE NOUN with a definite suffix, not a name: the map has nothing
// to look up, and the distance lane therefore had no destination and dropped
// the question (the POI-confirm lane then answered it with an unrelated place).
//
// This table is the other half of that reference: the client's own word for a
// place class → the map's `type` values for it. It is the vocabulary of the
// rotation, not a new taxonomy — every entry names a type the map really
// carries (see src/geo/types.ts and DURABLE_CLAIM_TYPES).
const PLACE_TYPE_NOUNS: Array<{ types: string[]; nouns: string[] }> = [
  { types: ['kindergarten', 'preschool'], nouns: ['градинка', 'градинки', 'kindergarten', 'gradinka', 'vrticka'] },
  { types: ['school', 'primary_school', 'secondary_school'], nouns: ['училиште', 'школо', 'училишта', 'uciliste', 'skolo', 'school'] },
  { types: ['university', 'faculty', 'college'], nouns: ['факултет', 'универзитет', 'fakultet', 'univerzitet', 'university'] },
  { types: ['pharmacy', 'chemist'], nouns: ['аптека', 'аптеки', 'apteka', 'apteki', 'pharmacy'] },
  { types: ['hospital'], nouns: ['болница', 'болници', 'bolnica', 'hospital'] },
  { types: ['clinic', 'doctors', 'dentist'], nouns: ['клиника', 'амбуланта', 'klinika', 'ambulanta', 'clinic'] },
  { types: ['church', 'cathedral', 'place_of_worship', 'mosque', 'monastery'], nouns: ['црква', 'цркви', 'катедрала', 'џамија', 'манастир', 'crkva', 'dzamija', 'church'] },
  { types: ['park', 'garden', 'playground'], nouns: ['парк', 'паркче', 'park', 'parkce'] },
  { types: ['square', 'plaza'], nouns: ['плоштад', 'плоштадот', 'plostad', 'square'] },
  { types: ['market', 'marketplace', 'bazaar'], nouns: ['пазар', 'пазарче', 'pazar', 'pazarce', 'market'] },
  { types: ['supermarket', 'grocery', 'convenience'], nouns: ['супермаркет', 'маркет', 'продавница', 'supermarket', 'prodavnica'] },
  { types: ['mall', 'shopping_mall', 'department_store'], nouns: ['мол', 'молот', 'трговски', 'тц', 'mol', 'molot', 'mall'] },
  { types: ['museum', 'gallery'], nouns: ['музеј', 'галерија', 'muzej', 'galerija', 'museum'] },
  { types: ['theatre', 'theater'], nouns: ['театар', 'театарот', 'teatar', 'theatre'] },
  { types: ['cinema'], nouns: ['кино', 'киното', 'kino', 'cinema'] },
  { types: ['library'], nouns: ['библиотека', 'biblioteka', 'library'] },
  { types: ['stadium', 'arena', 'sports_hall', 'hall', 'community_centre', 'cultural_center'], nouns: ['стадион', 'сала', 'салата', 'stadion', 'sala', 'stadium'] },
  { types: ['embassy', 'diplomatic'], nouns: ['амбасада', 'амбасадата', 'ambasada', 'embassy'] },
  { types: ['courthouse', 'government', 'townhall', 'police', 'post_office'], nouns: ['суд', 'општина', 'влада', 'полиција', 'пошта', 'sud', 'opstina', 'policija', 'posta'] },
  { types: ['hotel', 'hostel', 'motel'], nouns: ['хотел', 'хотелот', 'hotel', 'hotelot'] },
  { types: ['cafe', 'restaurant', 'bar', 'fast_food'], nouns: ['кафе', 'кафеана', 'кафич', 'ресторан', 'kafe', 'kafic', 'restoran', 'cafe'] },
  { types: ['bank', 'atm'], nouns: ['банка', 'банкомат', 'banka', 'bankomat', 'bank'] },
  { types: ['fitness_centre', 'gym', 'swimming_pool'], nouns: ['теретана', 'фитнес', 'базен', 'teretana', 'fitnes', 'bazen'] },
  { types: ['fuel', 'gas_station'], nouns: ['бензинска', 'пумпа', 'benzinska', 'pumpa'] },
  { types: ['bridge'], nouns: ['мост', 'мостот', 'most', 'mostot', 'bridge'] },
];

/** Nouns that LOOK like a class word but name something else («паркинг» is a
 *  parking lot, not a park) — checked before the table so a stem never wins on
 *  a prefix. */
const NOUN_FALSE_FRIENDS = ['паркинг', 'паркет', 'паркиралиште', 'parking', 'parket', 'parkiraliste'];

/** The words that may STAND BESIDE a class noun without turning the phrase into
 *  a NAME: prepositions and the demonstratives the client wraps around it
 *  («до градинкава», «во молот», «кај тоа училиште»). Everything else is
 *  content — a name, a district, a street — and a name is the map search's
 *  job. This is not pedantry: the bare-suffix match read «SITI MOL» as the
 *  shopping-mall CLASS (a real name ends in the noun) and bound a mall
 *  question to the last mall slot on the rotation (the [04:46] regression). */
const CLASS_FILLER_WORDS = new Set([
  ...LANDMARK_PREPS, ...AREA_PREPS,
  'од', 'od', 'кон', 'kon', 'покрај', 'pokraj', 'измеѓу', 'izmegju',
  'близина', 'blizina', 'наспроти', 'nasproti', 'спроти', 'sproti',
  'тој', 'таа', 'тоа', 'ова', 'оваа', 'оваа', 'тие', 'тој', 'истиот', 'истата', 'истото',
  'toj', 'taa', 'toa', 'ova', 'ovaa', 'tie', 'istiot', 'istata', 'istoto',
]);

/**
 * The map TYPE values a destination phrase names — «градинкава» →
 * ['kindergarten'], «од училиштето» → the school family — or undefined when
 * the phrase is not a bare class noun (a real name belongs to the map search).
 *
 * A noun matches as a whole word with at most three inflection letters after
 * it (градинка|та/ва/те, училиште|то, аптека|ва): a phrase carrying a NAME
 * («училиште Димитар Миладинов») is not a class reference, so only a phrase
 * whose words are the noun plus a short suffix is accepted.
 */
export function placeTypesFromNoun(phrase: string): string[] | undefined {
  const raw = String(phrase ?? '').toLowerCase().replace(/[^\p{L}\s]+/gu, ' ').replace(/\s+/g, ' ').trim();
  if (!raw) return undefined;
  const forms = [raw];
  const norm = normalizeMc(raw);
  if (norm && norm !== raw) forms.push(norm.toLowerCase());
  for (const f of forms) {
    if (NOUN_FALSE_FRIENDS.some(w => new RegExp(`(?:^|\\s)${w}\\p{L}*`, 'u').test(f))) return undefined;
  }
  for (const row of PLACE_TYPE_NOUNS) {
    for (const noun of row.nouns) {
      // THE NOUN MUST BE THE WHOLE PHRASE (fillers aside). «градинкава» is the
      // class; «Kindergarten "Kocho Racin"» and «SITI MOL» are NAMES — the
      // word appearing inside them says nothing about what the client means,
      // and a name lookup is exactly what the map search is for.
      const bare = new RegExp(`^${noun.trim()}\\p{L}{0,3}$`, 'u');
      const words = forms.map(f => f.split(' '))
        .map(ws => ws.filter(w => !CLASS_FILLER_WORDS.has(w)));
      if (words.some(ws => ws.length === 1 && bare.test(ws[0]!))) return row.types;
    }
  }
  return undefined;
}
