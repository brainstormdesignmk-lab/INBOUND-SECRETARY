/**
 * IS THIS ANCHOR THE CARD'S OWN AREA? — ONE RULE, EVERY SERVE SITE (§4p).
 *
 * The [09:03] capture: «Станот под Евидентен број 82 е трисобен стан во
 * Аеродром. … Се наоѓа на 490 m од Аеродром.» The card named the flat's own
 * naselba and then measured the flat FROM it — a tautology about a district
 * centroid, which tells the client nothing about where inside the district the
 * flat is. The nested case is the same defect one level down: a flat in Ново
 * Лисиче, served for Аеродром (the municipality Ново Лисиче belongs to), read
 * «830 m од Аеродром».
 *
 * Two serve sites build anchors — the handler's pair/place queues (which mark
 * the anchors it stores in the session) and the responder's LLM-less fallback
 * (which pins the session anchor itself) — so the predicate lives HERE, once.
 * A second copy is how the deterministic lanes and the fallback start
 * disagreeing about the same flat (the reason `isSettlementType` was lifted out
 * of the handler as well).
 *
 * The decision uses two map facts: the anchor row's CLASS (only a RESIDENTIAL
 * AREA can be "the area the flat is in" — a mall, hospital or school anchor is
 * always real geography, and keeps its distance) and which settlement CENTRE is
 * nearer to the flat, because the map stores settlements as points, not
 * polygons. An invented containment would be worse than the tautology, so an
 * unknown class, a missing row or missing coordinates leaves the anchor alone.
 * The plain same-name case needs no map at all.
 */
import { Property } from '../data/properties';
import { distM } from '../geo/precision';
import { isSettlementType } from '../geo/offlineMap';

/** The minimum a caller must offer for the map lookups this rule needs. The
 *  handler passes its LandmarkService; the responder passes the resolver the
 *  handler wired into it (which now carries the row's `type` for this reason). */
export interface PlaceLookup {
  findPlace(name: string): { lat: number; lon: number; type?: string | null } | undefined;
}

/** The feed appends an internal class marker to some naselba names
 *  («Аеродром (општина)»); it is not part of the place's name. */
export function stripAreaMarker(s: string | undefined | null): string {
  return (s ?? '').replace(/\s*\((?:населба|општина|naselba|opstina)\)\s*$/iu, '').trim();
}

const norm = (s: string): string => s.trim().toLocaleLowerCase('mk-MK');

/** How far from the anchor's own centre its district may still reach. The map
 *  stores settlements as coarse POINTS, so «Ново Лисиче belongs to Аеродром»
 *  shows up as two centroids about 980 m apart — inside this band. A flat in a
 *  genuinely different part of town is kilometres away (Центар is 4,4 km from
 *  Аеродром), and there the anchor is NOT the flat's district, so the card
 *  keeps its distance. Without this condition every flat was "inside" every
 *  anchor that happened to be farther away than its own naselba's centre —
 *  which removed real measurements from cards across town. */
export const OWN_AREA_RADIUS_M = 1500;

export function anchorIsOwnArea(
  p: Property,
  a: { name: string; lat: number; lon: number },
  map?: PlaceLookup | null,
): boolean {
  const own = stripAreaMarker(p.location);
  if (!own) return false;
  if (norm(own) === norm(a.name)) return true;
  if (!map || typeof p.lat !== 'number' || typeof p.lon !== 'number'
    || p.lat === 0 || p.lon === 0) return false;
  const anchorRow = map.findPlace(a.name);
  if (!anchorRow || !isSettlementType(anchorRow.type)) return false;
  const ownRow = map.findPlace(own);
  if (!ownRow || !isSettlementType(ownRow.type)) return false;
  const dOwn = distM(p.lat, p.lon, ownRow.lat, ownRow.lon);
  const dAnchor = distM(p.lat, p.lon, a.lat, a.lon);
  return Number.isFinite(dOwn) && Number.isFinite(dAnchor)
    && dAnchor <= OWN_AREA_RADIUS_M && dOwn <= dAnchor;
}
