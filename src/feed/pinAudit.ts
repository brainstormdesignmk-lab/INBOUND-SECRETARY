// THE FEED AUDIT FOR THE PIN/AREA CONTRADICTION — and WHICH SIDE IS WRONG.
//
// The [05:32] capture served «Станот под Евидентен број 85 е трисобен стан во
// Ново Лисиче. Се наоѓа во близина на ТЦ Мавровка.» — Ново Лисиче is 3,4 km from
// that pin and ТЦ Мавровка is 54 m from it. The card-side guard
// (LandmarkService.enrich) drops the landmark, which stops the contradiction from
// reaching a client, but it cannot repair the FEED row: every other reader (the
// public page, where-is, availability) still sees a flat labelled Ново Лисиче
// with a pin in Пајко Маало.
//
// TWO READERS, ONE RULER: `scripts/audit-pin-location.ts` is the repair, and the
// operator's own panel (`/status`, `/audit`) reports the same findings, so drift
// shows up before a client sees it. The comparison therefore lives HERE, not in
// the script — two implementations would drift apart and one of them would be
// the wrong one.
//
// WHICH SIDE IS WRONG is never assumed. `location` is the naselba the AGENCY
// typed; the pin is a machine geocode. Usually the geocode is the broken side
// (EB 46: a Кисела Вода row whose pin was resolved to a Kipper branch in Чаир by
// NAME), but sometimes the PIN is right and the LABEL is the wrong side (EB 44:
// «куќа во Визбегово» whose pin sits 518 m from Визбегово village and 2,4 km from
// the Скопје Север row). Moving that pin would have destroyed a good coordinate.
//
// THE RULE THAT DECIDES: a settlement row of the map (SETTLEMENT_TYPES — a
// suburb/village/quarter centroid, never a shop) that the row's OWN address or
// description names, and that stands within NASELBA_WINS_M of the pin while the
// typed naselba is DECISIVE_M further away, means the label is the wrong side.
// Shops cannot trigger it on purpose: «КИПЕР МАРКЕТ» is a chain with twenty
// branches, and matching a shop name would "prove" the pin is right in whichever
// branch the geocoder happened to land on.
import type { Property } from '../data/properties';
import type { OfflineMapStore, LocalPoi } from '../geo/offlineMap';
import { isSettlementType } from '../geo/offlineMap';
import { pinContradictsLocation, stripPoiAnnotation } from '../geo/landmarks';
import { distM } from '../geo/precision';
import { normalizeMc } from '../llm/normalize';

/** How near the pin a settlement named by the row must stand before its own
 *  words are taken as evidence of where it is. A village centroid is a coarse
 *  point: 518 m was EB 44's real gap. */
export const NASELBA_WINS_M = 1500;

/** How much nearer than the typed naselba that settlement must be before the
 *  verdict flips. A margin, not a tie-break, because the two sides are
 *  different kinds of point (a village centroid vs a suburb centroid). */
export const DECISIVE_M = 1000;

/** The side of the contradiction a repair should rewrite. */
export type PinSide = 'pin' | 'naselba';

/** One row the audit looked at, with the two facts it compared. */
export interface PinLocationFinding {
  eb: number;
  id?: string;
  location: string;
  address?: string;
  lat: number;
  lon: number;
  /** The map's nearest quarter to the pin, and how far it is. */
  pinQuarter?: { name: string; distance_m: number };
  /** The named naselba's own map position, and how far the pin is from it. */
  namedAt?: { lat: number; lon: number; distance_m: number };
  /** True when the pin contradicts the named naselba. */
  contradicts: boolean;
  /** Which side a repair must rewrite. Always present on a contradiction: a
   *  finding the audit cannot attribute is left `pin` only when the row says
   *  nothing about a settlement at all — the geocode is the machine value. */
  side?: PinSide;
  /** For `side === 'naselba'`: the settlement the row's own words name, with
   *  its distance from the (correct) pin. This is the value to write. */
  naselbaAt?: { name: string; lat: number; lon: number; distance_m: number };
  /** Why the row was NOT judged (never a false "healthy"). */
  skipped?: string;
}

/** The text a row uses to describe where it is — the evidence a verdict rests
 *  on. Address first (typed by the agency for this feed), description second
 *  (the owner's own words, which is where «во Визбегово» lives). */
function rowText(row: Pick<Property, 'address' | 'details'>): string {
  return `${row.address ?? ''}\n${row.details ?? ''}`;
}

/** The settlement rows of the map near `lat/lon`, nearest first, excluding the
 *  typed naselba itself (it is the other side of the question). */
function settlementsNear(map: OfflineMapStore, lat: number, lon: number, typed: string): LocalPoi[] {
  const typedNorm = normalizeMc(stripPoiAnnotation(typed).replace(/\s*\([^)]*\)\s*$/u, '').trim());
  return map.nearestPois(lat, lon, NASELBA_WINS_M, 400)
    .filter(p => isSettlementType(p.type))
    .filter(p => normalizeMc(stripPoiAnnotation(p.name)) !== typedNorm)
    .sort((a, b) => a.distance_m - b.distance_m);
}

/**
 * WHICH SIDE IS WRONG, as a value instead of a comment.
 *
 * `naselba` only when ALL of these hold, because a wrong label rewrite is as
 * damaging as a wrong pin:
 *   • a settlement row stands within NASELBA_WINS_M of the pin,
 *   • the row's own address/description NAMES that settlement,
 *   • the typed naselba's map row is at least DECISIVE_M FURTHER from the pin.
 * Everything else is the geocode's fault (`pin`), which is the safe default:
 * the typed naselba is what the client asked about and what the page shows.
 */
export function pinSide(
  map: OfflineMapStore | undefined,
  row: Pick<Property, 'location' | 'address' | 'details' | 'lat' | 'lon'>,
  namedAt?: { distance_m: number },
): { side: PinSide; naselbaAt?: { name: string; lat: number; lon: number; distance_m: number } } {
  const fallback = { side: 'pin' as const };
  if (!map?.available) return fallback;
  const lat = row.lat, lon = row.lon;
  if (typeof lat !== 'number' || typeof lon !== 'number' || !lat || !lon) return fallback;
  const text = normalizeMc(rowText(row));
  if (!text.trim()) return fallback;
  for (const p of settlementsNear(map, lat, lon, String(row.location ?? ''))) {
    const name = stripPoiAnnotation(p.name);
    const key = normalizeMc(name);
    if (key.length < 4 || !text.includes(key)) continue;
    // A named settlement is evidence about the LABEL only when the label is
    // decisively further from the pin than the settlement is.
    if (namedAt && namedAt.distance_m < p.distance_m + DECISIVE_M) continue;
    const plat = typeof p.lat === 'number' ? p.lat : lat;
    const plon = typeof p.lon === 'number' ? p.lon : lon;
    return { side: 'naselba', naselbaAt: { name, lat: plat, lon: plon, distance_m: Math.round(p.distance_m) } };
  }
  return fallback;
}

/** What the audit needs from a row: a feed `Property`, or the same facts
 *  straight out of the edge function's JSON (no `id`). */
export type AuditRow = Pick<Property, 'eb' | 'location' | 'address' | 'details' | 'lat' | 'lon'>
  & { id?: string | number };

/** The comparison, row by row — pure except for the map, so it is testable and
 *  every reader can never disagree about which rows are broken. */
export function auditRows(rows: AuditRow[], map: OfflineMapStore): PinLocationFinding[] {
  const out: PinLocationFinding[] = [];
  for (const r of rows) {
    const location = String(r.location ?? '').trim();
    const lat = r.lat, lon = r.lon;
    const base = {
      eb: r.eb, id: r.id === undefined ? undefined : String(r.id),
      location, address: r.address, lat: Number(lat), lon: Number(lon), contradicts: false,
    };
    if (typeof lat !== 'number' || typeof lon !== 'number' || !lat || !lon) {
      out.push({ ...base, skipped: 'no pin' });
      continue;
    }
    if (!location) {
      out.push({ ...base, skipped: 'no location' });
      continue;
    }
    const named = stripPoiAnnotation(location).replace(/\s*\([^)]*\)\s*$/u, '').trim();
    const place = map.findPoiByName(named, { lat, lon });
    const near = map.areaAt(lat, lon, 3000);
    if (!place) {
      out.push({ ...base, skipped: 'the map has no row for that naselba' });
      continue;
    }
    const namedDistance = distM(lat, lon, place.lat, place.lon);
    const contradicts = pinContradictsLocation(map, { location, lat, lon });
    const namedAt = { lat: place.lat, lon: place.lon, distance_m: Math.round(namedDistance) };
    const verdict: { side?: PinSide; naselbaAt?: { name: string; lat: number; lon: number; distance_m: number } } =
      contradicts ? pinSide(map, { ...r, location, lat, lon }, namedAt) : {};
    out.push({
      ...base,
      pinQuarter: near ? { name: near.name, distance_m: Math.round(near.distance_m) } : undefined,
      namedAt,
      contradicts,
      ...(contradicts ? { side: verdict.side, naselbaAt: verdict.naselbaAt } : {}),
    });
  }
  return out;
}

/** The one-line health summary both the script and the operator panel print. */
export function pinDriftSummary(findings: PinLocationFinding[]): string {
  const broken = findings.filter(f => f.contradicts);
  const skipped = findings.filter(f => f.skipped);
  if (findings.length === 0) return 'pin/location: no rows read — nothing was compared';
  if (broken.length === 0) {
    return `pin/location: ${findings.length} row(s) checked, no contradiction`
      + (skipped.length > 0 ? ` (${skipped.length} not judged)` : '');
  }
  return `pin/location: ${broken.length} of ${findings.length} row(s) have a pin in another quarter`
    + ` (EB ${broken.map(f => f.eb).join(', ')})`
    + (skipped.length > 0 ? ` · ${skipped.length} not judged` : '');
}
