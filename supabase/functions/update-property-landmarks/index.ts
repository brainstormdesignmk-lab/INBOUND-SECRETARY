// update-property-landmarks — Supabase edge function for Hermes.
//
// The resolver (npm run hermes:landmarks -- --feed) sends:
//   POST <this function URL>
//   x-api-key: <HERMES_API_KEY>
//   {
//     "property_number": "53",
//     "landmarks": [
//       { "landmark": "Кафе бар Ван Гог", "type": "cafe", "distance_m": 120 },
//       { "landmark": "Градежен факултет", "type": "university", "distance_m": 340 }
//     ]
//   }
//
// The `landmarks` JSONB column must exist on the `properties` table.
// Deploy: supabase functions deploy update-property-landmarks

import { guard, json, logEvent, resolveProperty, restGet, restPatch, restPost } from '../_shared/hermes.ts';

interface LandmarkEntry {
  landmark: string;
  type?: string;
  distance_m?: number;
  maps_url?: string;
}

// A landmark must be a PUBLIC PLACE — a street name hands the client the exact location.
const STREET_NAME_RE =
  /(?<![А-Яа-яA-Za-z])(?:улиц(?:а|и|ата|ите)|булевар(?:от|и)?|бул\.?|ул\.?|пат(?:от|и)?|street|boulevard)(?![А-Яа-яA-Za-z])/i;

function validEntry(e: unknown): e is LandmarkEntry {
  if (!e || typeof e !== 'object') return false;
  const o = e as Record<string, unknown>;
  const name = String(o.landmark ?? '').trim();
  if (name.length < 2 || name.length > 80) return false;
  if (STREET_NAME_RE.test(name)) return false;
  if (o.type !== undefined && typeof o.type !== 'string') return false;
  const d = Number(o.distance_m);
  if (o.distance_m !== undefined && o.distance_m !== null && (!Number.isFinite(d) || d < 0 || d > 5000)) return false;
  if (o.maps_url !== undefined && o.maps_url !== null) {
    const u = String(o.maps_url);
    if (!/^https?:\/\//.test(u) || u.length > 300) return false;
  }
  return true;
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } });

  const g = guard(req, 'POST');
  if (g instanceof Response) return g;

  let body: { property_number?: unknown; evidenten_broj?: unknown; landmarks?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  const propNum = String(body.property_number ?? body.evidenten_broj ?? '').trim();
  if (!propNum || propNum === '0') {
    return json({ error: 'property_number is required' }, 400);
  }

  const raw = Array.isArray(body.landmarks) ? body.landmarks : [];
  if (raw.length === 0 || raw.length > 10) {
    return json({ error: 'landmarks must be a non-empty array (max 10)' }, 400);
  }
  if (!raw.every(validEntry)) {
    return json({ error: 'invalid landmark entry (street names are never landmarks)' }, 400);
  }

  const landmarks: LandmarkEntry[] = raw.map((e: any) => ({
    landmark: String(e.landmark).trim(),
    type: typeof e.type === 'string' && e.type ? e.type : undefined,
    distance_m: e.distance_m != null ? Math.round(Number(e.distance_m)) : undefined,
    maps_url: typeof e.maps_url === 'string' && e.maps_url ? e.maps_url : undefined,
  }));

  // Resolve property by property_number (the real column).
  const prop = await resolveProperty(null, propNum);
  if (!prop) {
    await logEvent({
      event_type: 'landmarks_write',
      status: 'rejected',
      property_number: propNum,
      payload: { landmarks },
      note: 'property not found',
      source: 'lina',
    });
    return json({ error: `no property with property_number ${propNum}` }, 404);
  }

  // Read current landmarks for idempotency check.
  const rows = await restGet(`/properties?select=landmarks&id=eq.${prop.id}&limit=1`);
  const existing = rows?.[0];
  const prev = Array.isArray(existing?.landmarks) ? existing.landmarks : [];
  if (JSON.stringify(prev) === JSON.stringify(landmarks)) {
    await logEvent({
      event_type: 'landmarks_write',
      status: 'processed',
      property_id: prop.id,
      property_number: propNum,
      payload: { landmarks },
      note: 'unchanged',
      source: 'lina',
    });
    return json({ property_number: propNum, landmarks, unchanged: true });
  }

  // Write landmarks + audit via REST helpers (no esm.sh import needed).
  await restPatch('properties', `id=eq.${prop.id}`, {
    landmarks,
    landmarks_resolved_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });

  // Audit trail — best-effort.
  await restPost('landmark_resolution_log', {
    property_id: prop.id,
    property_number: propNum,
    landmarks,
  }).catch(e => console.error('audit insert failed:', e.message));

  await logEvent({
    event_type: 'landmarks_write',
    status: 'processed',
    property_id: prop.id,
    property_number: propNum,
    payload: { landmarks },
    source: 'lina',
  });

  return json({ property_number: propNum, landmarks });
});
