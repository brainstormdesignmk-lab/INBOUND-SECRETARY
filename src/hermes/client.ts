// The Hermes-side client — how machine B talks to Lina's /hermes/v1 API.
// Every call carries x-admin-token: <HERMES_TOKEN> (the shared admin token).

import '../compat/node16';

import { OwnerVerdict } from '../backoffice/ownerAgent';

export interface LandmarkCandidate { id?: number; address?: string; location?: string; }
export interface PriceChangeWork { id: number; eb: number; old_price: number | null; new_price: number; }
export interface AddressChangeWork { id: number; eb: number; old_address: string | null; new_address: string; }
export interface OwnerCheckWork {
  chat_id: string;
  eb: number | null;
  proposed_time: string;
  /** The ask Lina wants delivered, already composed and bank-served. Null when
   *  the check was re-armed AFTER the owner spoke (nothing to send — he is
   *  already answering that question). Send THIS, never your own wording. */
  deliver_text: string | null;
  owner_name?: string;
  owner_phone?: string;
}

export interface HermesWork {
  landmarks: LandmarkCandidate[];
  price_changes: PriceChangeWork[];
  address_changes: AddressChangeWork[];
  owner_checks: OwnerCheckWork[];
  visits: Array<Record<string, unknown>>;
}

async function request(baseUrl: string, token: string, path: string, opts: RequestInit = {}): Promise<any> {
  const res = await fetch(`${baseUrl.replace(/\/+$/, '')}${path}`, {
    ...opts,
    headers: {
      'Content-Type': 'application/json',
      'x-admin-token': token,
      ...(opts.headers as Record<string, string> | undefined),
    },
  });
  if (!res.ok) throw new Error(`Lina API ${path} → HTTP ${res.status}`);
  return res.json();
}

export function pullWork(baseUrl: string, token: string): Promise<HermesWork> {
  return request(baseUrl, token, '/hermes/v1/work');
}

export function pushLandmarks(
  baseUrl: string, token: string,
  items: Array<{ id?: number; address?: string; location?: string; landmark: string; type?: string; maps_url?: string }>,
): Promise<{ accepted: number; rejected: Array<Record<string, unknown>> }> {
  return request(baseUrl, token, '/hermes/v1/landmarks', { method: 'POST', body: JSON.stringify(items) });
}

export function reportPriceResult(baseUrl: string, token: string, id: number, ok: boolean): Promise<{ resolved: boolean }> {
  return request(baseUrl, token, `/hermes/v1/prices/${id}/result`, { method: 'POST', body: JSON.stringify({ ok }) });
}

export function reportAddressResult(baseUrl: string, token: string, id: number, ok: boolean): Promise<{ resolved: boolean }> {
  return request(baseUrl, token, `/hermes/v1/addresses/${id}/result`, { method: 'POST', body: JSON.stringify({ ok }) });
}

export function answerOwner(
  baseUrl: string, token: string, chatId: string, eb: number, verdict: OwnerVerdict,
  opts: { confirmTime?: string } = {},
): Promise<{ applied: boolean; queued?: boolean }> {
  return request(baseUrl, token, `/hermes/v1/owners/${encodeURIComponent(chatId)}/answer`, {
    method: 'POST',
    body: JSON.stringify({
      eb, status: verdict.status, owner_time: verdict.ownerTime, price: verdict.price, note: verdict.note,
      // Consent must name its object: the term the caller is agreeing to.
      confirm_time: opts.confirmTime,
    }),
  });
}

/** The owner's RAW message — Lina parses it, answers it, and returns the text to
 *  deliver. `messageId` makes a retried webhook idempotent (the same sentence,
 *  never a second turn of the conversation). This is the preferred call: it
 *  keeps ONE owner grammar and ONE copy source in the appliance. */
export function replyOwner(
  baseUrl: string, token: string, chatId: string, text: string,
  opts: { eb?: number; messageId?: string } = {},
): Promise<{ effect: string; reply_text?: string; state?: string; replay?: boolean }> {
  return request(baseUrl, token, `/hermes/v1/owners/${encodeURIComponent(chatId)}/reply`, {
    method: 'POST',
    body: JSON.stringify({ text, eb: opts.eb, message_id: opts.messageId }),
  });
}
