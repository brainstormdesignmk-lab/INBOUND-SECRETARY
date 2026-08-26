// The visit-protocol messages — the exact staged disclosures the agency uses
// to keep the property address secret until the visit is locked in:
//
//   Turn 0 (immediately after the visit is arranged)  — address confirm (owner only)
//   Turn 1 (after owner confirms address)              — DOGOVORENA POSETA (client)
//   Turn 2 (morning of the visit day)                  — confirmation + agent
//   Turn 3 (2 hours before the visit)                  — EXACT location + maps link
//
// These are protocol lines with structured fields — code-built, never
// LLM-written, so the format can't drift. The exact street address appears in
// ONLY ONE message: the turn-3 location (the visit is already arranged by then,
// the client no longer bypasses the agency).

import { formatDateOnly, formatTimeOnly } from './time';
import { googleMapsLink } from '../geo/landmarks';

/** Turn 0 — sent to OWNER ONLY: confirm the property address is correct.
 *  The client does NOT see this message. Turn 1 to the client only fires
 *  after the owner confirms. Includes the written address for elderly people
 *  who can't use Google Maps. */
export function buildAddressConfirm(eb: number, when: Date, address: string, mapsUrl: string): string {
  return `ДОГОВОРЕНА ПОСЕТА НА ЕВИДЕНТЕН БРОЈ ${eb}; ${formatDateOnly(when)}; ${formatTimeOnly(when)}\nАдреса: ${address}\n${mapsUrl}\n\nМи треба потврда од ваша страна за точната локација на недвижноста. Дали адресата е точна?`;
}

/** Turn 0 bump — sent to OWNER when no address confirmation received.
 *  Sent every 2 hours until the owner confirms. */
export const ADDRESS_CONFIRM_BUMP =
  'Ми треба ваша потврда за точноста на локацијата, за организирање на посетата.';

/** Cancellation by CLIENT — sent to both owner and client. */
export function buildCancelledByClient(eb: number): string {
  return `Откажана посета по желба на клиент за Евидентен број ${eb}.\n\nМетрополис се извинува за непланираните околности.\nЌе бидеме во контакт.`;
}

/** Cancellation by OWNER — sent to both owner and client. */
export function buildCancelledByOwner(eb: number): string {
  return `Откажана посета по желба на сопственикот за Евидентен број ${eb}.\n\nМетрополис се извинува за непланираните околности.\nЌе бидеме во контакт.`;
}

/** Turn 1 — sent to BOTH owner and client (after owner confirms address).
 *  Includes the written address + Google Maps link for elderly clients. */
export function buildArrangedVisit(eb: number, when: Date, address?: string): string {
  const addrLine = address ? `\nАдреса: ${address}` : '';
  return `ДОГОВОРЕНА ПОСЕТА НА ЕВИДЕНТЕН БРОЈ ${eb}; ${formatDateOnly(when)}; ${formatTimeOnly(when)}${addrLine}`;
}

/** Turn 2 — morning confirmation, sent to BOTH, with the agent contact. */
export function buildMorningConfirm(eb: number, when: Date, agentPhone: string, address?: string): string {
  const addrLine = address ? `\nАдреса: ${address}` : '';
  return `ДОГОВОРЕНА ПОСЕТА НА ЕВИДЕНТЕН БРОЈ ${eb}; ${formatDateOnly(when)}; ${formatTimeOnly(when)}; АГЕНТ ЗА КОНТАКТ ${agentPhone}${addrLine}`;
}

/** Turn 2 — the client's follow-up after the morning confirmation. */
export const CLIENT_LOCATION_FOLLOWUP =
  'Ќе бидете известени за деталите и локацијата 2 часа пред посетата.';

/**
 * Turn 3 — the EXACT location, 2 hours before the visit, to BOTH. The maps
 * link is the one allowed disclosure of the real address (visit arranged).
 */
export function buildLocationMsg(eb: number, when: Date, agentPhone: string, address: string, mapsUrl: string): string {
  return `ЛОКАЦИЈА ЗА ЕВИДЕНТЕН БРОЈ ${eb}; ${formatDateOnly(when)}; ${formatTimeOnly(when)}; АГЕНТ ЗА КОНТАКТ ${agentPhone}\nАдреса: ${address}\n${mapsUrl}`;
}

/** Google Maps link for the REAL address (visit day) — built through the
 *  shared googleMapsLink so the customer always lands on Google Maps, never
 *  OSM. No API key needed.
 *  When precise coordinates are available they are PREFERRED: a raw Cyrillic
 *  address percent-encodes into an unreadable %D0%A2… wall of junk, while
 *  `query=lat,lon` is short, clean, and lands on the exact building (full
 *  precision is ALLOWED here — the visit-day unlock sends the street anyway). */
export function mapsLinkFor(address: string | undefined, location: string | undefined, coords?: { lat: number; lon: number }): string {
  if (coords) return googleMapsLink(`${coords.lat},${coords.lon}`);
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
