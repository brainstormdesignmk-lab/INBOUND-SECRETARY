// _shared/hermes.ts — shared helpers for Hermes edge functions.
// Uses the Supabase REST API (PostgREST) for all DB access — no direct
// postgres connection, no esm.sh imports, Deno-native fetch only.

import { createClient } from 'jsr:@supabase/supabase-js@2';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const ADMIN_TOKEN = Deno.env.get('ADMIN_TOKEN') || Deno.env.get('HERMES_API_KEY') || '';

const HEADERS = {
  'Content-Type': 'application/json',
  'apikey': SUPABASE_ANON_KEY,
  'Authorization': `Bearer ${SUPABASE_SERVICE_ROLE_KEY}`,
};

// ── guard ──────────────────────────────────────────────────────────
/** Auth guard: checks x-api-key header against ADMIN_TOKEN. Returns
 *  Response (401) on failure, or null on success. */
export function guard(req: Request, method: string): Response | null {
  if (req.method === 'OPTIONS') return null;
  if (req.method !== method) {
    return json({ error: `method not allowed: ${req.method}` }, 405);
  }
  if (!ADMIN_TOKEN) {
    console.error('[hermes] ADMIN_TOKEN not set');
    return json({ error: 'server misconfigured' }, 500);
  }
  const key = req.headers.get('x-api-key') ?? req.headers.get('x-admin-token') ?? '';
  if (key !== ADMIN_TOKEN) {
    return json({ error: 'unauthorized' }, 401);
  }
  return null;
}

// ── json ───────────────────────────────────────────────────────────
export function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
  });
}

// ── REST helpers ───────────────────────────────────────────────────
/** GET from PostgREST. Returns the parsed JSON array. */
export async function restGet(path: string): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: HEADERS,
  });
  if (!res.ok) {
    console.error(`[hermes] restGet ${path} failed: ${res.status} ${await res.text()}`);
    return [];
  }
  return res.json();
}

/** PATCH via PostgREST. */
export async function restPatch(table: string, filter: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: 'PATCH',
    headers: HEADERS,
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[hermes] restPatch ${table} failed: ${res.status} ${text}`);
    throw new Error(`restPatch failed: ${res.status}`);
  }
}

/** POST via PostgREST. */
export async function restPost(table: string, body: Record<string, unknown>): Promise<any> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: 'POST',
    headers: { ...HEADERS, 'Prefer': 'return=representation' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    console.error(`[hermes] restPost ${table} failed: ${res.status} ${text}`);
    throw new Error(`restPost failed: ${res.status}`);
  }
  return res.json();
}

// ── resolveProperty ────────────────────────────────────────────────
/** Look up a property by property_number (or evidenten_broj alias). */
export async function resolveProperty(
  _supabase: any,
  propertyNumber: string,
): Promise<{ id: string; property_number: string } | null> {
  const rows = await restGet(
    `/properties?select=id,property_number&property_number=eq.${encodeURIComponent(propertyNumber)}&limit=1`
  );
  return rows?.[0] ?? null;
}

// ── logEvent ───────────────────────────────────────────────────────
/** Write an event to the hermes_events audit table (best-effort). */
export async function logEvent(event: {
  event_type: string;
  status: string;
  property_id?: string;
  property_number?: string;
  payload?: unknown;
  note?: string;
  source?: string;
}): Promise<void> {
  try {
    await restPost('hermes_events', {
      ...event,
      payload: event.payload ? JSON.stringify(event.payload) : null,
      created_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error('[hermes] logEvent failed:', (e as Error).message);
  }
}
