// /functions/v1/price-change
// Price-correction pipeline between Lina (inbound secretary) and the Metropolis app.
//
//   POST   -> Lina reports what the owner said (new price + availability). Stored in price_changes.
//             Optional { auto_apply: true } writes the price straight onto the property.
//   GET    -> Hermes corrector script pulls pending rows (?status=pending&limit=50).
//   PATCH  -> Hermes applies or rejects a pending row: { id, action: "apply" | "reject" }.
//
// Server-to-server only: x-api-key: HERMES_API_KEY, no CORS, rate limited, every step logged.

import {
  allow,
  json,
  logEvent,
  matchKey,
  resolveProperty,
  restGet,
  restPatch,
  restPost,
  UUID_RE,
} from "../_shared/hermes.ts";

const MAX_PRICE = 100_000_000;

function num(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  const n = typeof v === "number" ? v : Number(String(v).replace(/[^\d.,-]/g, "").replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

async function applyRow(row: any, keyLabel: string, requestId: string | null) {
  if (!row.property_id) throw new Error("row has no property_id");
  await restPatch("properties", `id=eq.${encodeURIComponent(row.property_id)}`, {
    price: row.new_price,
  });
  await restPatch("price_changes", `id=eq.${encodeURIComponent(row.id)}`, {
    status: "applied",
    applied_at: new Date().toISOString(),
    error_message: null,
  });
  await logEvent({
    event_type: "property.price_applied",
    status: "processed",
    property_id: row.property_id,
    property_number: row.property_number,
    request_id: requestId,
    key_label: keyLabel,
    payload: { price_change_id: row.id },
    result: { old_price: row.old_price, new_price: row.new_price },
  });
}

Deno.serve(async (req) => {
  const key = matchKey(req.headers.get("x-api-key"));
  if (!key) return json({ error: "unauthorized" }, 401);
  if (!allow(key.label)) return json({ error: "rate limit exceeded" }, 429);
  const requestId = req.headers.get("x-request-id");
  const url = new URL(req.url);

  try {
    // ---------------------------------------------------------------- GET
    if (req.method === "GET") {
      const status = url.searchParams.get("status") ?? "pending";
      const limitRaw = Number(url.searchParams.get("limit") ?? "50");
      const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 200) : 50;
      const rows = await restGet(
        `/price_changes?select=id,created_at,property_id,property_number,old_price,new_price,currency,availability,reported_by,status,note` +
          `&status=eq.${encodeURIComponent(status)}&order=created_at.asc&limit=${limit}`,
      );
      return json({ ok: true, count: rows.length, price_changes: rows });
    }

    // --------------------------------------------------------------- POST
    if (req.method === "POST") {
      let body: any;
      try {
        body = JSON.parse((await req.text()) || "{}");
      } catch {
        return json({ error: "invalid json" }, 400);
      }

      const new_price = num(body.new_price ?? body.price);
      if (new_price === null || new_price <= 0 || new_price > MAX_PRICE) {
        return json({ error: "new_price must be a positive number" }, 400);
      }

      const p = await resolveProperty(body.property_id, body.property_number);
      if (!p) {
        await logEvent({
          event_type: "property.price_reported",
          status: "rejected",
          property_number: body.property_number ? String(body.property_number) : null,
          request_id: requestId,
          key_label: key.label,
          payload: body,
          error_message: "property not found",
        });
        return json({ error: "property not found" }, 404);
      }

      const current = await restGet(
        `/properties?select=id,price&id=eq.${encodeURIComponent(p.id)}&limit=1`,
      );
      const old_price = current?.[0]?.price ?? null;

      const unchanged = old_price !== null && Number(old_price) === new_price;

      const rows = await restPost("price_changes", {
        property_id: p.id,
        property_number: p.property_number,
        old_price,
        new_price,
        currency: typeof body.currency === "string" ? body.currency.slice(0, 10) : "EUR",
        availability: typeof body.availability === "string" ? body.availability.slice(0, 200) : null,
        reported_by: typeof body.reported_by === "string" ? body.reported_by.slice(0, 50) : "lina",
        source: typeof body.source === "string" ? body.source.slice(0, 50) : "hermes",
        status: unchanged ? "applied" : "pending",
        note: typeof body.note === "string" ? body.note.slice(0, 1000) : null,
        request_id: requestId ?? (typeof body.request_id === "string" ? body.request_id : null),
        key_label: key.label,
        applied_at: unchanged ? new Date().toISOString() : null,
      });
      const row = rows?.[0];

      let applied = unchanged;
      if (!unchanged && body.auto_apply === true) {
        await applyRow({ ...row, property_id: p.id, property_number: p.property_number }, key.label, requestId);
        applied = true;
      }

      await logEvent({
        event_type: "property.price_reported",
        status: "processed",
        property_id: p.id,
        property_number: p.property_number,
        request_id: requestId,
        key_label: key.label,
        payload: body,
        result: { price_change_id: row?.id, old_price, new_price, applied, unchanged },
        note: typeof body.availability === "string" ? body.availability.slice(0, 500) : null,
      });

      return json(
        {
          ok: true,
          price_change_id: row?.id,
          property_id: p.id,
          property_number: p.property_number,
          old_price,
          new_price,
          unchanged,
          applied,
          status: applied ? "applied" : "pending",
        },
        201,
      );
    }

    // -------------------------------------------------------------- PATCH
    if (req.method === "PATCH") {
      let body: any;
      try {
        body = JSON.parse((await req.text()) || "{}");
      } catch {
        return json({ error: "invalid json" }, 400);
      }
      const id = typeof body.id === "string" ? body.id : "";
      if (!UUID_RE.test(id)) return json({ error: "id must be a uuid" }, 400);
      const action = body.action === "reject" ? "reject" : "apply";

      const rows = await restGet(
        `/price_changes?select=id,property_id,property_number,old_price,new_price,status&id=eq.${encodeURIComponent(id)}&limit=1`,
      );
      const row = rows?.[0];
      if (!row) return json({ error: "price change not found" }, 404);
      if (row.status !== "pending") {
        return json({ ok: true, id, status: row.status, note: "already resolved" });
      }

      if (action === "reject") {
        await restPatch("price_changes", `id=eq.${encodeURIComponent(id)}`, {
          status: "rejected",
          error_message: typeof body.reason === "string" ? body.reason.slice(0, 500) : null,
        });
        await logEvent({
          event_type: "property.price_rejected",
          status: "processed",
          property_id: row.property_id,
          property_number: row.property_number,
          request_id: requestId,
          key_label: key.label,
          payload: body,
        });
        return json({ ok: true, id, status: "rejected" });
      }

      await applyRow(row, key.label, requestId);
      return json({
        ok: true,
        id,
        status: "applied",
        property_number: row.property_number,
        old_price: row.old_price,
        new_price: row.new_price,
      });
    }

    return json({ error: "method not allowed" }, 405);
  } catch (e) {
    console.error("price-change error", e);
    await logEvent({
      event_type: "property.price_change",
      status: "failed",
      request_id: requestId,
      key_label: key.label,
      payload: { method: req.method, url: url.pathname },
      error_message: e instanceof Error ? e.message.slice(0, 500) : "unknown error",
    });
    return json({ error: "internal error" }, 500);
  }
});
