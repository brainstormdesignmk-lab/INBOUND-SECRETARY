// Property address auditor — classifies every feed property by how well its
// address resolves through the offline map. Runs once at boot (lazy, after
// feed loads) and on-demand via /audit TUI command.
//
// Categories:
//   GEOCODED    — address resolved to precise street coordinates
//   POI_MATCHED — address matched a POI by name (landmark-style address)
//   STREET_MISSING — address didn't geocode AND didn't match a POI
//   GARBAGE     — address is placeholder text (Непозната, Хфгхфгх…)
//
// The audit does NOT block startup — it's fire-and-forget with cached
// results that surface via /status.

import type { OfflineMapStore } from './geo/offlineMap';

export type AuditCategory = 'GEOCODED' | 'POI_MATCHED' | 'STREET_MISSING' | 'GARBAGE';

export interface PropertyAudit {
  eb: number;
  address: string;
  location?: string;
  category: AuditCategory;
  detail: string;
}

const GARBAGE_PATTERNS = [
  /непознат/i, /не\s+познат/i,
  /хфгх/i, /фгхф/i, /test/i, /тест/i,
  /^\s*[-–—]\s*$/,              // just a dash
  /^[a-z]{4,}$/i,               // random Latin (keyboard mash)
];

function classifyAddress(
  address: string | undefined,
  offlineMap: OfflineMapStore | undefined,
): { category: AuditCategory; detail: string } {
  const addr = (address ?? '').trim();

  // GARBAGE: placeholder or keyboard mash
  if (addr.length < 3 || GARBAGE_PATTERNS.some(p => p.test(addr))) {
    return { category: 'GARBAGE', detail: addr || '(empty)' };
  }

  if (!offlineMap?.available) {
    return { category: 'STREET_MISSING', detail: 'offline map unavailable' };
  }

  // GEOCODED: street address resolved to coordinates
  const geo = offlineMap.geocodeAddress(addr);
  if (geo) {
    return { category: 'GEOCODED', detail: `${geo.street} @ ${geo.lat},${geo.lon}` };
  }

  // POI_MATCHED: address matches a POI name (landmark-style)
  const poi = offlineMap.findPoiByName(addr);
  if (poi) {
    return { category: 'POI_MATCHED', detail: poi.name };
  }

  // STREET_MISSING: nothing matched
  return { category: 'STREET_MISSING', detail: `no match for "${addr.slice(0, 40)}"` };
}

/** Audit a batch of properties. Lightweight — no network, no DB writes. */
export function auditProperties(
  props: Array<{ eb: number; address?: string; location?: string }>,
  offlineMap: OfflineMapStore | undefined,
): PropertyAudit[] {
  return props.map(p => {
    const { category, detail } = classifyAddress(p.address, offlineMap);
    return { eb: p.eb, address: p.address ?? '', location: p.location, category, detail };
  });
}

/** Summary line for /status display. */
export function auditSummary(results: PropertyAudit[]): string {
  const counts: Record<AuditCategory, number> = { GEOCODED: 0, POI_MATCHED: 0, STREET_MISSING: 0, GARBAGE: 0 };
  for (const r of results) counts[r.category]++;
  const total = results.length;
  const clean = counts.GEOCODED + counts.POI_MATCHED;
  const needsFix = counts.STREET_MISSING + counts.GARBAGE;
  return `properties: ${total} total · ${clean} ok (${counts.GEOCODED} geocoded, ${counts.POI_MATCHED} POI) · ${needsFix} need attention (${counts.STREET_MISSING} missing, ${counts.GARBAGE} garbage)`;
}
