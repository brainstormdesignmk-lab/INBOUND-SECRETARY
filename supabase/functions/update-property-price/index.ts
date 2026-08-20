// update-property-price — Supabase edge function for Hermes.
//
// The price-sync pipeline: Lina records an owner-dictated price change locally
// (price_changes table), Hermes POSTs it here, and this function updates the
// property price with validation + an audit trail.
//
//   POST <this function URL>
//   x-api-key: <HERMES_API_KEY>
//   { "property_number": "53", "price": 60000 }
//
// Deploy: supabase functions deploy update-property-price

import { guard, json, logEvent, resolveProperty, restGet, restPatch, restPost } from '../_shared/hermes.ts';

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: { 'Access-Control-Allow-Origin': '*' } });

  const g = guard(req, 'POST');
  if (g instanceof Response) return g;

  let body: { property_number?: unknown; evidenten_broj?: unknown; cena_eur?: unknown; price?: unknown };
  try {
    body = await req.json();
  } catch {
    return json({ error: 'invalid json' }, 400);
  }

  // Accept both naming conventions.
  const propNum = String(body.property_number ?? body.evidenten_broj ?? '').trim();
  const newPrice = Math.floor(Number(body.price ?? body.cena_eur));
  if (!propNum || propNum === '0') {
    return json({ error: 'property_number is required' }, 400);
  }
  if (!Number.isFinite(newPrice) || newPrice <= 0) {
    return json({ error: 'price must be a positive integer' }, 400);
  }

  // Resolve property by property_number.
  const prop = await resolveProperty(null, propNum);
  if (!prop) {
    await logEvent({
      event_type: 'price_write',
      status: 'rejected',
      property_number: propNum,
      payload: { price: newPrice },
      note: 'property not found',
      source: 'lina',
    });
    return json({ error: `no property with property_number ${propNum}` }, 404);
  }

  // Read the current price for the audit trail + idempotency.
  const rows = await restGet(`/properties?select=price&id=eq.${prop.id}&limit=1`);
  const existing = rows?.[0];
  const oldPrice: number | null = existing?.price ?? null;

  if (oldPrice === newPrice) {
    await logEvent({
      event_type: 'price_write',
      status: 'processed',
      property_id: prop.id,
      property_number: propNum,
      payload: { price: newPrice, old_price: oldPrice },
      note: 'unchanged',
      source: 'lina',
    });
    return json({ property_number: propNum, price: newPrice, old_price: oldPrice, unchanged: true });
  }

  // Write the new price via REST helpers.
  await restPatch('properties', `id=eq.${prop.id}`, {
    price: newPrice,
    updated_at: new Date().toISOString(),
  });

  // Audit trail — best-effort.
  await restPost('price_change_log', {
    property_id: prop.id,
    property_number: propNum,
    old_price: oldPrice,
    new_price: newPrice,
    source: 'owner',
  }).catch(e => console.error('audit insert failed:', e.message));

  await logEvent({
    event_type: 'price_write',
    status: 'processed',
    property_id: prop.id,
    property_number: propNum,
    payload: { price: newPrice, old_price: oldPrice },
    source: 'lina',
  });

  return json({ property_number: propNum, price: newPrice, old_price: oldPrice });
});
