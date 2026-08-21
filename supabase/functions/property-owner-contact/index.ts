// Private, server-to-server endpoint. Consumed by Hermes Agent (OwnerAgent) only.
// Read-only: no writes to properties/contacts, no scheduling logic. NO CORS by design.

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const KEYS: Array<{ label: string; value: string }> = [
  { label: "primary", value: Deno.env.get("HERMES_API_KEY") ?? "" },
  { label: "next", value: Deno.env.get("HERMES_API_KEY_NEXT") ?? "" },
].filter((k) => k.value.length > 0);

const JSON_HEADERS = { "Content-Type": "application/json; charset=utf-8" };

// ---------- timing-safe compare ----------
const enc = new TextEncoder();
function timingSafeEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  // compare a fixed-size digest-ish buffer to avoid length leak
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function matchKey(provided: string | null): { label: string } | null {
  if (!provided) return null;
  let hit: { label: string } | null = null;
  for (const k of KEYS) {
    if (timingSafeEqual(provided, k.value)) hit = { label: k.label };
  }
  return hit;
}

// ---------- rate limit: ~60 req/min per key ----------
const RATE_LIMIT = 60;
const WINDOW_MS = 60_000;
const buckets = new Map<string, number[]>();
function allow(key: string): boolean {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < WINDOW_MS);
  hits.push(now);
  buckets.set(key, hits);
  return hits.length <= RATE_LIMIT;
}

// ---------- phone normalization: 078/421-046 -> +38978421046 ----------
function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let d = String(raw).replace(/\D/g, "");
  if (!d) return null;
  if (d.startsWith("00389")) d = d.slice(5);
  else if (d.startsWith("389")) d = d.slice(3);
  else if (d.startsWith("0")) d = d.slice(1);
  return `+389${d}`;
}

async function rest(path: string) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1${path}`, {
    headers: {
      apikey: SERVICE_ROLE_KEY,
      Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`REST ${res.status}: ${await res.text()}`);
  return res.json();
}

async function logLookup(entry: {
  key_label: string | null;
  property_number: string | null;
  property_id: string | null;
  request_id: string | null;
  response_status: number;
  note?: string | null;
}) {
  try {
    await fetch(`${SUPABASE_URL}/rest/v1/owner_lookup_log`, {
      method: "POST",
      headers: {
        apikey: SERVICE_ROLE_KEY,
        Authorization: `Bearer ${SERVICE_ROLE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify(entry),
    });
  } catch (e) {
    console.error("audit log failed", e);
  }
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  const url = new URL(req.url);
  const requestId = req.headers.get("x-request-id");
  const propertyNumberParam = url.searchParams.get("property_number");
  const propertyIdParam = url.searchParams.get("property_id");

  const key = matchKey(req.headers.get("x-api-key"));
  if (!key) {
    await logLookup({
      key_label: null,
      property_number: propertyNumberParam,
      property_id: null,
      request_id: requestId,
      response_status: 401,
      note: "invalid or missing api key",
    });
    return new Response(JSON.stringify({ error: "unauthorized" }), { status: 401, headers: JSON_HEADERS });
  }

  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "method not allowed" }), { status: 405, headers: JSON_HEADERS });
  }

  if (!allow(key.label)) {
    await logLookup({
      key_label: key.label,
      property_number: propertyNumberParam,
      property_id: null,
      request_id: requestId,
      response_status: 429,
      note: "rate limited",
    });
    return new Response(JSON.stringify({ error: "rate limit exceeded" }), { status: 429, headers: JSON_HEADERS });
  }

  try {
    if (!propertyNumberParam && !propertyIdParam) {
      await logLookup({
        key_label: key.label,
        property_number: null,
        property_id: null,
        request_id: requestId,
        response_status: 400,
        note: "missing lookup key",
      });
      return new Response(
        JSON.stringify({ error: "provide property_number or property_id" }),
        { status: 400, headers: JSON_HEADERS },
      );
    }

    if (propertyIdParam && !UUID_RE.test(propertyIdParam)) {
      await logLookup({
        key_label: key.label,
        property_number: propertyNumberParam,
        property_id: null,
        request_id: requestId,
        response_status: 400,
        note: "malformed property_id",
      });
      return new Response(JSON.stringify({ error: "malformed property_id" }), { status: 400, headers: JSON_HEADERS });
    }

    const filter = propertyIdParam
      ? `id=eq.${encodeURIComponent(propertyIdParam)}`
      : `property_number=eq.${encodeURIComponent(propertyNumberParam!)}`;

    const props: any[] = await rest(
      `/properties?select=id,property_number,title,address&${filter}&limit=1`,
    );
    const p = props?.[0];
    if (!p) {
      await logLookup({
        key_label: key.label,
        property_number: propertyNumberParam,
        property_id: propertyIdParam,
        request_id: requestId,
        response_status: 404,
        note: "property not found",
      });
      return new Response(JSON.stringify({ error: "property not found" }), { status: 404, headers: JSON_HEADERS });
    }

    const contacts: any[] = await rest(
      `/property_contacts?select=id,client_name,client_surname,client_phone,is_primary,created_at,broker_name` +
        `&property_id=eq.${encodeURIComponent(p.id)}` +
        `&order=is_primary.desc,created_at.asc,id.asc`,
    );

    const toOwner = (c: any) => ({
      name: c.client_name ?? null,
      surname: c.client_surname ?? null,
      phone: normalizePhone(c.client_phone),
      viber_ok: false, // not tracked in CRM — reported honestly
    });

    const primary = contacts[0] ?? null;
    const rest_ = contacts.slice(1);

    const numericEb = Number(p.property_number);
    const payload = {
      property_number: Number.isFinite(numericEb) ? numericEb : p.property_number,
      property_id: p.id,
      address: p.address ?? null,
      title: p.title ?? null,
      status: "unknown", // live status is not tracked in the CRM; never derived from available_from
      last_confirmed_at: null, // not tracked
      owner_preferred_windows: [] as string[], // not tracked
      owner: primary ? toOwner(primary) : null,
      co_owners: rest_.map(toOwner),
      broker_name: primary?.broker_name ?? null,
    };

    await logLookup({
      key_label: key.label,
      property_number: String(p.property_number),
      property_id: p.id,
      request_id: requestId,
      response_status: 200,
      note: primary ? null : "no contact on file",
    });

    return new Response(JSON.stringify(payload), { status: 200, headers: JSON_HEADERS });
  } catch (e) {
    console.error("property-owner-contact error", e);
    await logLookup({
      key_label: key.label,
      property_number: propertyNumberParam,
      property_id: propertyIdParam,
      request_id: requestId,
      response_status: 500,
      note: e instanceof Error ? e.message.slice(0, 300) : "unknown error",
    });
    return new Response(JSON.stringify({ error: "internal error" }), { status: 500, headers: JSON_HEADERS });
  }
});
