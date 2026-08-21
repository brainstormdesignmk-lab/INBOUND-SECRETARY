// POST /functions/v1/update-property-status
// Hermes updates the lifecycle status of a property (sold / rented / reserved / active / archived).
// Scope: only `status`, `blocked_until` and `is_published` are ever touched.

import { guard, json, logEvent, resolveProperty, restPatch } from "../_shared/hermes.ts";

const ALLOWED = new Set(["active", "reserved", "rented", "sold", "archived"]);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

Deno.serve(async (req) => {
  const g = guard(req, "POST");
  if (g instanceof Response) return g;
  const { key } = g;
  const requestId = req.headers.get("x-request-id");

  let body: any;
  try {
    body = JSON.parse((await req.text()) || "{}");
  } catch {
    return json({ error: "invalid json" }, 400);
  }

  const status = typeof body.status === "string" ? body.status.trim().toLowerCase() : "";
  if (!ALLOWED.has(status)) {
    return json({ error: `status must be one of: ${[...ALLOWED].join(", ")}` }, 400);
  }

  let blocked_until: string | null = null;
  if (body.blocked_until !== undefined && body.blocked_until !== null && body.blocked_until !== "") {
    if (typeof body.blocked_until !== "string" || !DATE_RE.test(body.blocked_until)) {
      return json({ error: "blocked_until must be YYYY-MM-DD" }, 400);
    }
    blocked_until = body.blocked_until;
  }

  try {
    const p = await resolveProperty(body.property_id, body.property_number);
    if (!p) {
      await logEvent({
        event_type: "property.status_update",
        status: "rejected",
        property_number: body.property_number ? String(body.property_number) : null,
        request_id: requestId,
        key_label: key.label,
        payload: body,
        error_message: "property not found",
      });
      return json({ error: "property not found" }, 404);
    }

    const patch: Record<string, unknown> = { status };
    // Rentals blocked for a period; clearing the block when back to active.
    patch.blocked_until = status === "rented" || status === "reserved" ? blocked_until : null;
    // Sold / archived listings must disappear from the public feed.
    if (status === "sold" || status === "archived") patch.is_published = false;
    if (typeof body.is_published === "boolean" && status !== "sold" && status !== "archived") {
      patch.is_published = body.is_published;
    }

    const rows = await restPatch("properties", `id=eq.${encodeURIComponent(p.id)}`, patch);
    const updated = rows?.[0];

    await logEvent({
      event_type: "property.status_update",
      status: "processed",
      property_id: p.id,
      property_number: p.property_number,
      request_id: requestId,
      key_label: key.label,
      payload: body,
      result: { previous_status: p.status, status, blocked_until: patch.blocked_until },
      note: typeof body.note === "string" ? body.note.slice(0, 500) : null,
    });

    return json({
      ok: true,
      property_id: p.id,
      property_number: p.property_number,
      previous_status: p.status,
      status: updated?.status ?? status,
      blocked_until: updated?.blocked_until ?? patch.blocked_until,
      is_published: updated?.is_published ?? null,
    });
  } catch (e) {
    console.error("update-property-status error", e);
    await logEvent({
      event_type: "property.status_update",
      status: "failed",
      request_id: requestId,
      key_label: key.label,
      payload: body,
      error_message: e instanceof Error ? e.message.slice(0, 500) : "unknown error",
    });
    return json({ error: "internal error" }, 500);
  }
});
