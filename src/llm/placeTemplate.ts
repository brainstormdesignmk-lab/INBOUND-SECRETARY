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

/** Words-only comparison form — the district check must survive case,
 *  punctuation and the feed's own «(населба)» tag. */
function loose(s: string): string {
  return (s ?? '')
    .toLowerCase()
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
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
  const low = ` ${loose(text)} `;
  for (const area of KNOWN_NEIGHBORHOODS) {
    if (area.includes('(') || area.length < 5) continue;
    if (low.includes(` ${loose(area)} `)) return undefined;
  }
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

/** The template with the client's place in it. A blank place is never
 *  substituted (an empty slot in client copy is worse than no template). */
export function renderPlaceTemplate(template: string, place: string): string {
  const name = (place ?? '').trim();
  if (!name) return (template ?? '').split(PLACE_SLOT).join('');
  return (template ?? '').split(PLACE_SLOT).join(name);
}
