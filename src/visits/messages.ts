// The visit-protocol messages — the exact staged disclosures the agency uses
// to keep the property address secret until the visit is locked in:
//
//   Turn 1 (immediately after the visit is arranged)   — DOGOVORENA POSETA
//   Turn 2 (morning of the visit day)                  — confirmation + agent
//   Turn 3 (2 hours before the visit)                  — EXACT location + maps link
//
// These are protocol lines with structured fields — code-built, never
// LLM-written, so the format can't drift. The exact street address appears in
// ONLY ONE message: the turn-3 location (the visit is already arranged by then,
// the client no longer bypasses the agency).

import { formatDateOnly, formatTimeOnly } from './time';
import { googleMapsLink } from '../geo/landmarks';

/** Turn 1 — sent to BOTH owner and client verbatim. */
export function buildArrangedVisit(eb: number, when: Date): string {
  return `ДОГОВОРЕНА ПОСЕТА НА ЕВИДЕНТЕН БРОЈ ${eb}; ${formatDateOnly(when)}; ${formatTimeOnly(when)}`;
}

/** Turn 2 — morning confirmation, sent to BOTH, with the agent contact. */
export function buildMorningConfirm(eb: number, when: Date, agentPhone: string): string {
  return `ДОГОВОРЕНА ПОСЕТА НА ЕВИДЕНТЕН БРОЈ ${eb}; ${formatDateOnly(when)}; ${formatTimeOnly(when)}; АГЕНТ ЗА КОНТАКТ ${agentPhone}`;
}

/** Turn 2 — the client's follow-up after the morning confirmation. */
export const CLIENT_LOCATION_FOLLOWUP =
  'Ќе бидете известени за деталите и локацијата 2 часа пред посетата.';

/**
 * Turn 3 — the EXACT location, 2 hours before the visit, to BOTH. The maps
 * link is the one allowed disclosure of the real address (visit arranged).
 */
export function buildLocationMsg(eb: number, when: Date, agentPhone: string, mapsUrl: string): string {
  return `ЛОКАЦИЈА ЗА ЕВИДЕНТЕН БРОЈ ${eb}; ${formatDateOnly(when)}; ${formatTimeOnly(when)}; АГЕНТ ЗА КОНТАКТ ${agentPhone}\n${mapsUrl}`;
}

/** Google Maps link for the REAL address (visit day) — built through the
 *  shared googleMapsLink so the customer always lands on Google Maps, never
 *  OSM. No API key needed. */
export function mapsLinkFor(address: string | undefined, location: string | undefined): string {
  return googleMapsLink([address, location, 'Скопје'].filter(Boolean).join(', '));
}

export interface Party { name: string; phone: string; }

/** Operator log line per turn: who (owner/client) got what. */
export function buildOperatorLog(
  eb: number,
  turn: 'arranged' | 'confirm' | 'location',
  owner: Party | undefined,
  client: Party | undefined,
  status: { owner: 'OK' | 'FAIL' | '-//-'; client: 'OK' | 'FAIL' | '-//-' },
): string {
  const p = (x: Party | undefined, st: string): string =>
    x ? `${x.name} (${x.phone}) ${st}` : `непознат ${st}`;
  const label =
    turn === 'arranged' ? 'ARRANGED VISIT'
      : turn === 'confirm' ? 'VISIT CONFIRMATION 2 TURN'
        : '3 TURN LOCATION SENT';
  return `[ЛОГ ПОСЕТА ЕБ ${eb}] ${label} — OWNER: ${p(owner, status.owner)} / CLIENT: ${p(client, status.client)}`;
}
