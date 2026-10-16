// update-property-address — Supabase edge function for Hermes.
//
// The address-sync pipeline: Lina confirms the address with the OWNER at Turn 0
// of the visit protocol, the owner answers with a different one, and Lina queues
// it locally (address_changes). The same Hermes pass that carries price changes
// POSTs it here, and this function applies it to the public listing with
// validation + an audit event.
//
//   POST <this function URL>
//   x-api-key: <HERMES_API_KEY>
//   { "property_number": "53", "address": "Васил Стефановски 16" }
//
// WHY THE OWNER WINS: the feed's address comes from the listing site; the owner
// owns the building and answers Lina's confirmation question directly. When the
// two disagree, the owner is right.
//
// NOTE ON SCOPE: this writes the street address only. It deliberately does NOT
// re-resolve landmarks or coordinates — the offline map is a fixed artifact, and
// landmark/geo work is human-gated (see the no-cron policy in the maps repo).
// The listing's public-facing location text is unaffected by a street fix.
//
// Deploy: supabase functions deploy update-property-address

import { guard, json, logEvent, resolveProperty, restGet, restPatch } from '../_shared/hermes.ts';

/** The app's address column is capped at 300 chars (create-property validates it). */
const MAX_ADDRESS_LEN = 300;

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } });

  const g = guard(req, 'POST');
  if (g instanceof Response) return g;

  let body: { property_number?: unknown; evidenten_broj?: unknown; address?: unknown; new_address?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  // Accept both naming conventions (the hub sends `address`, Lina's queue row is
  // `new_address`).
  const propNum = String(body.property_number ?? body.evidenten_broj ?? '').trim();
  const rawAddr = body.address ?? body.new_address;
  if (!propNum || propNum === '0') {
    return json({ error: 'property_number is required' }, 400);
  }
  if (typeof rawAddr !== 'string' || !rawAddr.trim()) {
    return json({ error: 'address must be a non-empty string' }, 400);
  }
  // Collapse whitespace: a one-line field, and an owner's paste must not smuggle
  // a newline into the listing.
  const newAddress = rawAddr.replace(/\s+/g, ' ').trim();
  if (newAddress.length > MAX_ADDRESS_LEN) {
    return json({ error: `address must be at most ${MAX_ADDRESS_LEN} characters` }, 400);
  }

  const prop = await resolveProperty(null, propNum);
  if (!prop) {
    await logEvent({
      event_type: 'address_write',
      status: 'rejected',
      property_number: propNum,
      payload: { address: newAddress },
      note: 'property not found',
      source: 'lina',
    });
    return json({ error: `no property with property_number ${propNum}` }, 404);
  }

  // Read the stored address for the audit trail + idempotency.
  const rows = await restGet(`/properties?select=address&id=eq.${prop.id}&limit=1`);
  const existing = rows?.[0];
  const oldAddress: string | null = existing?.address ?? null;

  // Idempotent: an unchanged address is a no-op, not an error. Comparisons are
  // whitespace/case-insensitive so "ул. Партизанска 16 " does not churn a write.
  const same = (a: string | null, b: string) =>
    (a ?? '').replace(/\s+/g, ' ').trim().toLowerCase() === b.trim().toLowerCase();
  if (same(oldAddress, newAddress)) {
    await logEvent({
      event_type: 'address_write',
      status: 'processed',
      property_id: prop.id,
      property_number: propNum,
      payload: { address: newAddress, old_address: oldAddress },
      note: 'unchanged',
      source: 'lina',
    });
    return json({ property_number: propNum, address: newAddress, old_address: oldAddress, unchanged: true });
  }

  // Write the corrected address.
  await restPatch('properties', `id=eq.${prop.id}`, {
    address: newAddress,
    updated_at: new Date().toISOString(),
  });

  await logEvent({
    event_type: 'address_write',
    status: 'processed',
    property_id: prop.id,
    property_number: propNum,
    payload: { address: newAddress, old_address: oldAddress },
    note: 'owner-corrected at address confirmation (Turn 0)',
    source: 'lina',
  });

  return json({ property_number: propNum, address: newAddress, old_address: oldAddress });
});
