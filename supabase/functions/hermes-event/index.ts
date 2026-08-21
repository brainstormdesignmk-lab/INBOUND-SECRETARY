// POST /functions/v1/hermes-event
// Generic workflow-tracking sink. Hermes posts every orchestration step here.
// Write-only from Hermes' point of view: it records events, it does not mutate properties.

import { guard, json, logEvent, resolveProperty, restGet } from "../_shared/hermes.ts";

const MAX_BODY = 100_000; // ~100 KB

const ALLOWED_STATUS = new Set(["received", "processed", "failed", "rejected"]);

Deno.serve(async (req) => {
  const g = guard(req, "POST");
  if (g instanceof Response) return g;
  const { key } = g;

  const requestId = req.headers.get("x-request-id");

  let raw: string;
  try {
    raw = await req.text();
  } catch {
    return json({ error: "unreadable body" }, 400);
  }
  if (raw.length > MAX_BODY) return json({ error: "payload too large" }, 413);

  let body: any;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const event_type = typeof body.event_type === "string" ? body.event_type.trim() : "";
  if (!event_type || event_type.length > 100) {
    return json({ error: "event_type is required (1-100 chars)" }, 400);
  }

  const status = typeof body.status === "string" && ALLOWED_STATUS.has(body.status)
    ? body.status
    : "received";

  try {
    // Optional linkage — never fatal.
    let property_id: string | null = null;
    let property_number: string | null = null;
    if (body.property_id || body.property_number) {
      const p = await resolveProperty(body.property_id, body.property_number);
      if (p) {
        property_id = p.id;
        property_number = p.property_number;
      } else {
        property_number = body.property_number ? String(body.property_number) : null;
      }
    }

    let customer_lead_id: string | null = null;
    if (typeof body.customer_lead_id === "string") {
      const leads = await restGet(
        `/customer_leads?select=id&id=eq.${encodeURIComponent(body.customer_lead_id)}&limit=1`,
      ).catch(() => []);
      customer_lead_id = leads?.[0]?.id ?? null;
    }

    const id = await logEvent({
      event_type,
      status,
      property_id,
      property_number,
      customer_lead_id,
      request_id: requestId ?? (typeof body.request_id === "string" ? body.request_id : null),
      key_label: key.label,
      payload: body.payload ?? body,
      result: body.result ?? null,
      error_message: typeof body.error_message === "string" ? body.error_message.slice(0, 1000) : null,
      note: typeof body.note === "string" ? body.note.slice(0, 500) : null,
      source: typeof body.source === "string" ? body.source.slice(0, 50) : "hermes",
    });

    if (!id) return json({ error: "could not record event" }, 500);

    return json({ ok: true, event_id: id, event_type, status, property_id, property_number }, 201);
  } catch (e) {
    console.error("hermes-event error", e);
    return json({ error: "internal error" }, 500);
  }
});
