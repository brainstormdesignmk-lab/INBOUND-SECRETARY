// The Hermes-side client — how machine B talks to Lina's /hermes/v1 API.
// Every call carries x-admin-token: <HERMES_TOKEN> (the shared admin token).

import { OwnerVerdict } from '../backoffice/ownerAgent';

export interface LandmarkCandidate { address?: string; location?: string; }
export interface PriceChangeWork { id: number; eb: number; old_price: number | null; new_price: number; }
export interface OwnerCheckWork { chat_id: string; eb: number | null; proposed_time: string; }

export interface HermesWork {
  landmarks: LandmarkCandidate[];
  price_changes: PriceChangeWork[];
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
  items: Array<{ address?: string; location?: string; landmark: string; type?: string; maps_url?: string }>,
): Promise<{ accepted: number; rejected: Array<Record<string, unknown>> }> {
  return request(baseUrl, token, '/hermes/v1/landmarks', { method: 'POST', body: JSON.stringify(items) });
}

export function reportPriceResult(baseUrl: string, token: string, id: number, ok: boolean): Promise<{ resolved: boolean }> {
  return request(baseUrl, token, `/hermes/v1/prices/${id}/result`, { method: 'POST', body: JSON.stringify({ ok }) });
}

export function answerOwner(
  baseUrl: string, token: string, chatId: string, eb: number, verdict: OwnerVerdict,
): Promise<{ applied: boolean }> {
  return request(baseUrl, token, `/hermes/v1/owners/${encodeURIComponent(chatId)}/answer`, {
    method: 'POST',
    body: JSON.stringify({ eb, status: verdict.status, owner_time: verdict.ownerTime, price: verdict.price, note: verdict.note }),
  });
}
