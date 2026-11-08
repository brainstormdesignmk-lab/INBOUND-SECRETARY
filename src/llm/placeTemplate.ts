/**
 * placeTemplate — the PLACE SLOT of a learned answer (A of the closed loop).
 *
 * A generated answer that names a place is true ONLY for that place:
 * «Во близина на Капитол Мол имаме одлични понуди…» is right for Капитол and a
 * fabricated location for Ѓорче. Stored verbatim it can only ever answer the
 * place it was taught, so the store also keeps the same sentence with the place
 * span replaced by `{place}` — plus the anchor it was written for. The serve
 * path renders that template with the place the CURRENT client named, and
 * re-validates it like any generated answer.
 *
 * THE DISTRICT GUARD is the safety rule: a sentence that names a FEED AREA
 * («во Аеродром имаме…») is district-bound, not place-bound. Templating it would
 * hand one district's stock claim to another place that happens to be elsewhere,
 * so such an answer is never templated — it keeps verbatim-only recall, exactly
 * as before this module existed.
 *
 * Everything here is pure string work: no map, no DB, no model.
 */

import { KNOWN_NEIGHBORHOODS } from './deterministic';
import { placeLooseKey } from '../data/properties';

/** The slot the place occupies in a template. Kept as a literal in
 *  `BankStore` too (it must not import this module — see the cycle note there). */
export const PLACE_SLOT = '{place}';

/** The bank key the PROMOTED copies live under (B). The deterministic copy
 *  layer serves it through `pickVariant`, so a promoted template survives the
 *  dynamic-store purge and serves places that never had a row. */
export const PLACE_TEMPLATE_KEY = 'discovery.place.inventory';

/** Clean serves before a template is promoted into the copy layer (B). Three:
 *  one serve can be luck, three is the wording actually working. */
export const PLACE_PROMOTE_AFTER = 3;

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Words-only, SCRIPT-FOLDED comparison form — a place check must survive
 *  case, punctuation, the feed's own «(населба)» tag and the script the turn
 *  was typed in («Центар» / «CENTAR», «Лисиче» / «Lisice» are one place each).
 *  `placeLooseKey` is the repo's canonical place-identity key (the matcher's
 *  own table, which knows that Latin «c» may be ч), so no second
 *  transliteration exists here to drift. */
export function placeWordKey(s: string): string {
  const words = (s ?? '')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return words ? placeLooseKey(words) : '';
}

/** The scan list, computed once: longest key first, so «Ново Лисиче» consumes
 *  its span before the bare «Лисиче» can claim it (sibling settlements are
 *  distinct places — the rule `locMatches` states). */
const SCANNED_AREAS = KNOWN_NEIGHBORHOODS
  .filter(area => !area.includes('(') && area.length >= 5)
  .map(area => ({ area, key: placeWordKey(area) }))
  .filter(entry => entry.key.length > 0)
  .sort((a, b) => b.key.length - a.key.length);

/**
 * The FEED AREAS a sentence names, or [] when it names none.
 *
 * ONE READER for two rules that must never disagree: the district guard below
 * (a district-bound sentence is never a {place} template) and the dynamic
 * answer contract (an answer may name only a place the CLIENT named — the
 * #29/#30 rows: «A NESTO MALKU POSKAPO ?» answered «…во Центар…», and «KOJ E
 * TOJ STAN ?» answered «…тој стан во Аеродром…», both stored and both servable
 * to a client who never said the area; a place that appears only in the ANSWER
 * was invisible to the old message-vs-message comparison).
 *
 * Areas shorter than five characters («Бег», «Хром», «Влае») are skipped: as
 * whole words they collide with ordinary Macedonian («бег»), and the old
 * district guard made the same call for the same reason. A multi-word area is
 * matched as a phrase, so «Ново Лисиче» never fires on «Лисиче» alone.
 */
export function feedAreasIn(text: string): string[] {
  let hay = ` ${placeWordKey(text)} `;
  if (!hay.trim()) return [];
  const found: string[] = [];
  for (const { area, key } of SCANNED_AREAS) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(key)}(?![\\p{L}\\p{N}])`, 'gu');
    if (!re.test(hay)) continue;
    found.push(area);
    // Consume the span: a shorter sibling («Лисиче») must not re-match inside
    // the longer area («Ново Лисиче») that already claimed these words.
    hay = hay.replace(re, ' § ');
  }
  return found;
}

/**
 * The templated form of `answer`, or undefined when it may NOT be templated.
 *
 * `forms` are every surface spelling of the anchor available to the caller (the
 * map's own name and the client's wish). The LONGEST form that occurs wins —
 * «ТЦ Капитол» before «Капитол» — so the slot covers the whole reference and no
 * orphan word of the name survives the substitution.
 */
export function placeTemplateFrom(answer: string, forms: Array<string | undefined>): string | undefined {
  const text = (answer ?? '').trim();
  if (!text) return undefined;
  // THE DISTRICT GUARD — a district-bound sentence is not a place template.
  if (feedAreasIn(text).length > 0) return undefined;
  const candidates = [...new Set(forms.map(f => (f ?? '').trim()).filter(f => f.length >= 3))]
    .sort((a, b) => b.length - a.length);
  for (const form of candidates) {
    const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(form)}(?![\\p{L}\\p{N}])`, 'iu');
    if (!re.test(text)) continue;
    const once = text.replace(re, PLACE_SLOT);
    if (once.includes(PLACE_SLOT)) return once;
  }
  return undefined;
}

/**
 * True when the sentence ASSERTS INVENTORY AT THE PLACE — «имаме одлични
 * понуди», «имаме интересни опции околу X», «имаме неколку станови». That is
 * a claim about stock we have not looked at when the prose is served (the
 * [20:38] capture: «Имаме одлични опции во регионот околу Беверли Хилс» as the
 * FIRST thing a client heard — it reads as «we have something special
 * everywhere», and the owner killed it). The place prose is the market
 * question, never a stock claim, so a stored/promoted template of that shape
 * must not serve even though it names the place correctly.
 *
 * Only a CLAIM fires: the owner-specified wording («Дали Ве интересира
 * купување…») and questions in general are untouched, and the feed's own card
 * copy is out of scope (this predicate is consulted by the place-prose lane
 * only).
 */
const STOCK_CLAIM_RE = /(?<![\p{L}])(?:имаме|има|имаат|располагаме)(?:\s+[^.!?\n]{0,40}?)?\s*(?:понуд|опци|интересн\w*|избор|станов|недвижност|нешто)/iu;

export function assertsStockAtPlace(text: string): boolean {
  const t = (text ?? '').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  return STOCK_CLAIM_RE.test(t);
}

/** The template with the client's place in it. A blank place is never
 *  substituted (an empty slot in client copy is worse than no template). */
export function renderPlaceTemplate(template: string, place: string): string {
  const name = (place ?? '').trim();
  if (!name) return (template ?? '').split(PLACE_SLOT).join('');
  return (template ?? '').split(PLACE_SLOT).join(name);
}
