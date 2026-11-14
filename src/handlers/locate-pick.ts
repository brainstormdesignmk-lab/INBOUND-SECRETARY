/** The locate funnel's two PURE text gates, lifted out of `inbound.ts` so the
 *  routing mirror (`router.ts` ROUTING_ORDER) can read the SAME code the
 *  executor runs instead of inventing a second copy of it.
 *
 *  Phase 4 rule: a mirror row is only honest when its predicate IS the
 *  executor's gate. These two lived as module-local consts in `inbound.ts`,
 *  which the router cannot import (inbound → router is the edge, and the
 *  reverse would be a cycle). Moving them here is the fix; neither the regex
 *  nor `pickDescribed` changed by a single byte.
 */
import { inferPropertyId } from '../llm/classify';

/** A bare refusal while choosing among described flats. It is the locate
 *  funnel's "none of these" (inbound.ts LOCATE_CONTINUE), never a rejection of
 *  the offer, never a farewell: the bye/soft-refusal lanes read «NE» as goodbye
 *  and ended the whole chat with offers still unexplored (the [10:01] capture).
 *  «NE FALA» / «CAO» are NOT this — those stay goodbyes. */
export const BARE_REFUSAL_ONLY_RE = /^(?:ne|no|не)[\s.!?,]*$/iu;

/** How far from the named landmark the continuation of a locate hunt may serve
 *  before the other-neighbourhoods question is asked (the [09:59] embassy pair
 *  and its 300–700 m neighbours are in; another municipality's stock is out). */
export const NEAR_ANCHOR_SCOPE_M = 900;

/** Which of the flats just described the client points at: by Евидентен број
 *  (only when it IS one of the described set) or by ordinal. */
export function pickDescribed(text: string, ebs: number[]): number | undefined {
  const pid = inferPropertyId(text);
  if (pid !== undefined && ebs.includes(pid)) return pid;
  // The ordinal forms carry suffixes (првата, prvata, втората, vtorata), so
  // the stem is what is matched — but «прв пат» (first time) is not a choice.
  const ORDINALS: Array<[RegExp, number]> = [
    [/(?<![\p{L}\p{N}])(?:прв|prv)(?!\p{L}*(?:пат|pat))\p{L}*/iu, 0],
    [/(?<![\p{L}\p{N}])(?:втор|vtor)\p{L}*/iu, 1],
  ];
  for (const [re, idx] of ORDINALS) {
    if (re.test(text) && ebs[idx] !== undefined) return ebs[idx];
  }
  return undefined;
}
