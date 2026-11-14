/** THE PRICE-SCOPE PREDICATES (Phase 4 lift).
 *
 *  The price-extreme block and the `PRICE_AVG_NASELBA` lane read the SAME
 *  criteria: the type inheritance, the room count, the €/m² ceiling, the
 *  segment, and the rankable per-м² set. They were inline in a 40-line stretch
 *  of `inbound.ts`, which is why the naselba row could not be mirrored without
 *  a second copy of the whole query layer.
 *
 *  Here they are ONE implementation with two readers — the executor's block and
 *  the routing mirror's evidence probe. Nothing about the predicates changed:
 *  the comments travel with the code because they are the reasons.
 */
import type { Property } from '../data/properties';
import { pricePerM2, isNumberedArea } from '../data/properties';

/** The slot surface these predicates read (a structural copy of the session's
 *  slots, so this module stays free of the session type). */
export interface PriceSlots {
  business?: boolean;
  house?: boolean;
  plac?: boolean;
  yard?: boolean;
  garsonjera?: boolean;
  bedrooms?: number;
  service?: 'buy' | 'rent';
  sqmRate?: number;
}

/** WHERE THE TYPE CRITERIA COME FROM: the message's own type words, else the
 *  funnel's (the message-type test is what makes an explicit word win). Exported
 *  because the block also LABELS its reply from these sources, and a second
 *  derivation of them is the drift this module exists to prevent. */
export function priceTypeSources(
  slots: PriceSlots, sessionSlots: PriceSlots,
): { srcBusiness: boolean; srcHouse: boolean | undefined; srcPlac: boolean; yardWant: boolean; isLand: boolean } {
  const msgTyped = !!slots.business || slots.house !== undefined || !!slots.plac
    || !!slots.yard || !!slots.garsonjera;
  const srcBusiness = !!slots.business || (!msgTyped && !!sessionSlots.business);
  const srcHouse = slots.house ?? (!msgTyped ? sessionSlots.house : undefined);
  const srcPlac = !!slots.plac || (!msgTyped && !!sessionSlots.plac);
  const yardWant = !msgTyped && !!sessionSlots.yard;
  return { srcBusiness, srcHouse, srcPlac, yardWant, isLand: srcPlac };
}

/** TYPE INHERITANCE (the [12:34] capture): the message names no property type,
 *  so a mid-funnel stock ask rides the FUNNEL's own type (the деловен funnel
 *  served гарсоњера + трисобен стан apartments). An explicit type word in THIS
 *  message keeps its own scope; with nothing armed anywhere the residential
 *  default stands. */
export function priceTypeOk(
  slots: PriceSlots, sessionSlots: PriceSlots,
): (p: Property) => boolean {
  const { srcBusiness, srcHouse, yardWant, isLand } = priceTypeSources(slots, sessionSlots);
  return (p: Property): boolean => isLand
    ? !!p.plac
    : srcBusiness ? !!p.business
      : srcHouse === true || yardWant ? !!p.house
        : srcHouse === false ? !p.business && !p.house && !p.plac
          : !p.business && !p.house && !p.plac;
}

/** THE ROOM COUNT IS A CRITERION TOO (the [10:24] capture): «КОИ ТИ СЕ
 *  НАЈЕВТИНИ ДВОСОБНИ СТАНОВИ» served a ТРИСОБЕН in the lead — the lane
 *  filtered by category and ignored the rooms the client had just named (the
 *  message's own count, else the funnel's). */
export function priceRoomOk(
  slots: PriceSlots, sessionSlots: PriceSlots,
): (p: Property) => boolean {
  const wantRooms = slots.bedrooms ?? sessionSlots.bedrooms;
  const wantStudio = !!slots.garsonjera || (wantRooms === undefined && !!sessionSlots.garsonjera);
  return (p: Property): boolean => wantStudio
    ? (p.studio === true || p.bedrooms === 1)
    : wantRooms === undefined ? true
      : p.studio === true ? wantRooms === 1 : p.bedrooms === wantRooms;
}

/** A €/m² CEILING IS A CRITERION OF THE ASK (the [10:11] capture): the band the
 *  client set must hold in the cheapest/dearest listing too. */
export function priceRateOk(sessionSlots: PriceSlots): (p: Property) => boolean {
  const rateCap = sessionSlots.sqmRate;
  return (p: Property): boolean => rateCap === undefined
    || (pricePerM2(p) !== undefined && (pricePerM2(p) as number) <= rateCap);
}

/** The segment, chosen once: the MESSAGE's declared service wins, then the
 *  funnel's, then whatever the scope actually holds (a mixed band would compare
 *  a monthly rent to a sale price). */
export function priceSegment(
  msgService: 'buy' | 'rent' | undefined,
  sessionService: 'buy' | 'rent' | undefined,
  inScope: Property[],
): 'buy' | 'rent' {
  return msgService ?? sessionService
    ?? (inScope.some(p => p.service === 'buy') ? 'buy' : 'rent');
}

/** The rankable per-м² set: €/m² comes from `pricePerM2()` — a sale row with no
 *  м² has NO metric (never price/1, which made a surface-less flat the
 *  permanent "most expensive"). */
export function perM2RankableOf(rows: Property[]): Array<{ p: Property; m: number }> {
  return rows
    .map(p => ({ p, m: pricePerM2(p) }))
    .filter((x): x is { p: Property; m: number } => typeof x.m === 'number');
}

/** THE NASELBA COMPARISON'S OWN GATE (inbound.ts, PRICE_AVG_NASELBA) — lifted
 *  verbatim so the mirror row and the executor read one predicate:
 *
 *  „VO KOJA NASELBA SE NAJEFTINI STANOVITE“ compares NEIGHBOURHOODS, not rows.
 *  It fires only when the message itself says «населба/naselba» (ordinary
 *  cheapest asks keep their row listing), only with NO area named (naming one
 *  is a row listing), only for a €/м² measurement (a rent rate is not one), and
 *  only where per-м² exists.
 */
export function naselbaComparisonGate(args: {
  mode: string;
  text: string;
  areaNames: string[];
  segment: 'buy' | 'rent' | undefined;
  perM2Rankable: Array<{ p: Property; m: number }>;
}): boolean {
  return args.mode === 'cheapest'
    && /(?<![\p{L}\p{N}])(?:населб|naselb)\p{L}*/iu.test(args.text)
    && args.areaNames.length === 0
    && args.segment === 'buy'
    && args.perM2Rankable.length > 0;
}

/** The AREA NAMES of a price scope, from the raw scope string: a comma-joined
 *  detectLocation value splits back into the areas the client actually named,
 *  and a bare family word („KARPOS“) groups its numbered sub-areas while an
 *  explicit numeral stays exact. Lifted verbatim from the extreme block. */
export function areaNamesOf(
  areaRaw: string | undefined,
  namedArea: string | undefined,
  numbered: string[],
): string[] {
  const areaForScope = (a: string): string =>
    namedArea !== undefined && numbered.length === 0 && isNumberedArea(a)
      ? a.replace(/\s+(?:I{1,3}V?|IV|[1-4])\s*$/u, '').trim() || a
      : a;
  return [...new Set((areaRaw ?? '').split(/,\s*/u)
    .map(s => s.trim()).filter(Boolean).map(areaForScope))];
}
