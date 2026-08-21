// Shared helpers for the Hermes integration layer.
// Server-to-server only: API-key auth, no CORS, rate limiting, REST helpers, event logging.

export const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
export const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

export const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

const KEYS: Array<{ label: string; value: string }> = [
  { label: "primary", value: Deno.env.get("HERMES_API_KEY") ?? "" },
  { label: "next", value: Deno.env.get("HERMES_API_KEY_NEXT") ?? "" },
].filter((k) => k.value.length > 0);

const enc = new TextEncoder();
function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export function matchKey(provided: string | null): { label: string } | null {
  if (!provided) return null;
  let hit: { label: string } | null = null;
  for (const k of KEYS) if (timingSafeEqual(provided, k.value)) hit = { label: k.label };
  return hit;
}

const RATE_LIMIT = 60;
const WINDOW_MS = 60_000;
const buckets = new Map<string, number[]>();
export function allow(key: string): boolean {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  buckets.set(key, hits);
  return hits.length <= RATE_LIMIT;
}

export function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function restHeaders(extra: Record<string, string> = {}) {
  return {
    apikey: SERVICE_ROLE_KEY,
    Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
    "Content-Type": "application/json",
    ...extra,
  };
}

const LOCAL_BACKUP_URL = Deno.env.get("LOCAL_BACKUP_URL") ?? "";
const FETCH_TIMEOUT_MS = 8000;

/** fetch with timeout — prevents edge functions from hanging when Supabase is unreachable. */
async function fetchWithTimeout(url: string, opts: RequestInit & { timeout?: number } = {}): Promise<Response> {
  const timeout = opts.timeout ?? FETCH_TIMEOUT_MS;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeout);
  try {
    return await fetch(url, { ...opts, signal: ac.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Try Supabase first; if it times out or returns 5xx, fall back to the local backup server. */
export async function restGet(path: string): Promise<any[]> {
  try {
    const res = await fetchWithTimeout(`${SUPABASE_URL}/rest/v1${path}`, {
      headers: restHeaders(),
      timeout: FETCH_TIMEOUT_MS,
    });
    if (res.ok) return res.json();
    // 5xx on Supabase → fall back; 4xx (bad query) → throw immediately
    if (res.status < 500) throw new Error(`REST ${res.status}: ${await res.text()}`);
    console.warn(`[hermes] Supabase returned ${res.status}, trying local backup...`);
  } catch (err) {
    // Network error or timeout → fall back
    console.warn(`[hermes] Supabase unreachable: ${err instanceof Error ? err.message : err}`);
  }
  // --- Local fallback ---
  if (!LOCAL_BACKUP_URL) throw new Error(`Supabase failed and no LOCAL_BACKUP_URL configured`);
  const fallbackRes = await fetchWithTimeout(`${LOCAL_BACKUP_URL}${path}`, {
    headers: restHeaders(),
    timeout: FETCH_TIMEOUT_MS,
  });
  if (!fallbackRes.ok) throw new Error(`Local backup REST ${fallbackRes.status}: ${await fallbackRes.text()}`);
  console.log(`[hermes] Served from local backup: ${path}`);
  return fallbackRes.json();
}

export async function restPost(table: string, body: unknown): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST",
    headers: restHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`REST ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function restPatch(table: string, filter: string, body: unknown): Promise<any[]> {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: "PATCH",
    headers: restHeaders({ Prefer: "return=representation" }),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`REST ${res.status}: ${await res.text()}`);
  return res.json();
}

export type HermesEvent = {
  event_type: string;
  status: "received" | "processed" | "failed" | "rejected";
  property_id?: string | null;
  property_number?: string | null;
  customer_lead_id?: string | null;
  request_id?: string | null;
  key_label?: string | null;
  payload?: unknown;
  result?: unknown;
  error_message?: string | null;
  note?: string | null;
  source?: string;
};

export async function logEvent(e: HermesEvent): Promise<string | null> {
  try {
    const rows = await restPost("hermes_events", {
      ...e,
      payload: e.payload ?? {},
      source: e.source ?? "hermes",
    });
    return rows?.[0]?.id ?? null;
  } catch (err) {
    console.error("hermes_events log failed", err);
    return null;
  }
}

/** 078/421-046 -> +38978421046 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00389")) d = d.slice(5);
  else if (d.startsWith("389")) d = d.slice(3);
  else if (d.startsWith("0")) d = d.slice(1);
  return `+389${d}`;
}

/** Standard guard: API key + method + rate limit. Returns a Response when the request must stop. */
export function guard(req: Req, method = "POST"): { key: { label: string } } | Response {
  const key = matchKey(req.headers.get("x-api-key"));
  if (!key) return json({ error: "unauthorized" }, 401);
  if (req.method !== method) return json({ error: "method not allowed" }, 405);
  if (!allow(key.label)) return json({ error: "rate limit exceeded" }, 429);
  return { key };
}

type Req = Request;

export async function resolveProperty(
  property_id?: string | null,
  property_number?: string | number | null,
): Promise<{ id: string; property_number: string; status: string | null } | null> {
  let filter: string;
  if (property_id) {
    if (!UUID_RE.test(property_id)) return null;
    filter = `id=eq.${encodeURIComponent(property_id)}`;
  } else if (property_number !== undefined && property_number !== null && `${property_number}` !== "") {
    filter = `property_number=eq.${encodeURIComponent(String(property_number))}`;
  } else {
    return null;
  }
  const rows = await restGet(`/properties?select=id,property_number,status&${filter}&limit=1`);
  return rows?.[0] ?? null;
}
