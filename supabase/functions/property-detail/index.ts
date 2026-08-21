import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://qkgioqotxjxffiaufgwd.supabase.co";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFrZ2lvcW90eGp4ZmZpYXVmZ3dkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxMTU0NjUsImV4cCI6MjA3MDY5MTQ2NX0.WVno6c6_rvFqFwj1fN8UWHYmlit0C-6J_h57P8d5eOI";

async function fetchJSON(path: string) {
  const res = await fetch(`${SUPABASE_URL}${path}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
  });
  if (!res.ok) throw new Error(`Supabase REST error ${res.status}: ${await res.text()}`);
  return res.json();
}

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const url = new URL(req.url);
    const id = url.searchParams.get("id");
    const format = url.searchParams.get("format") ?? "";
    const accept = req.headers.get("accept") ?? "";
    const wantsJSON = format.toLowerCase() === "json" || accept.includes("application/json");
    const origin = req.headers.get("x-forwarded-host")
      ? `${req.headers.get("x-forwarded-proto") ?? "https"}://${req.headers.get("x-forwarded-host")}`
      : "";

    if (!id) {
      return new Response("Missing id query parameter", { 
        status: 400,
        headers: corsHeaders,
      });
    }

    const properties: Array<any> = await fetchJSON(`/rest/v1/properties?select=*&id=eq.${encodeURIComponent(id)}&is_published=eq.true`);
    const p = properties?.[0];
    if (!p) return new Response("Property not found", { 
      status: 404,
      headers: corsHeaders,
    });

    const images: Array<any> = await fetchJSON(`/rest/v1/property_images?select=id,image_url,display_order&property_id=eq.${encodeURIComponent(id)}&order=display_order.asc`);

    // If JSON requested, return machine-readable format
    if (wantsJSON) {
      const payload = {
        id: p.id,
        property_number: p.property_number,
        title: p.title,
        property_type: p.property_type,
        room_type: p.room_type,
        location: p.location,
        neighborhood: p.neighborhood,
        address: p.address,
        price: p.price,
        area: p.area,
        floor: p.floor,
        year_built: p.year_built,
        service_type: p.service_type,
        heating: p.heating,
        furnished: p.furnished ?? null,
        garage: p.garage ?? null,
        elevator: p.elevator ?? null,
        yard: p.yard ?? null,
        parking: p.parking ?? null,
        orientation: p.orientation ?? null,
        total_floors: p.total_floors ?? null,
        comments: p.comments,
        description: p.description,
        created_at: p.created_at,
        updated_at: p.updated_at,
        images: images.map((i: any) => ({
          id: i.id,
          url: i.image_url,
          display_order: i.display_order,
        })),
        detail_url: origin ? `${origin}/property/${p.id}` : `/property/${p.id}`,
      } as const;
      return new Response(JSON.stringify(payload), {
        status: 200,
        headers: {
          ...corsHeaders,
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        },
      });
    }

    const jsonLd = {
      "@context": "https://schema.org",
      "@type": "RealEstateListing",
      name: p.title,
      description: p.comments ?? p.title,
      url: origin ? `${origin}/property/${p.id}` : undefined,
      identifier: p.property_number,
      address: {
        "@type": "PostalAddress",
        addressLocality: p.location ?? p.neighborhood,
        streetAddress: p.address ?? undefined,
        addressCountry: "MK",
      },
      offers: {
        "@type": "Offer",
        price: p.price,
        priceCurrency: "EUR",
        availability: "https://schema.org/InStock",
      },
      numberOfRooms: p.room_type,
      floorSize: { "@type": "QuantitativeValue", value: p.area, unitCode: "MTK" },
      floorLevel: p.floor,
      yearBuilt: p.year_built,
      image: images?.map((i) => i.image_url) ?? [],
      additionalProperty: [
        { "@type": "PropertyValue", name: "propertyType", value: p.property_type },
        { "@type": "PropertyValue", name: "serviceType", value: p.service_type },
        { "@type": "PropertyValue", name: "furnished", value: p.furnished ?? "Не е наведено" },
        { "@type": "PropertyValue", name: "garage", value: p.garage === true ? "Да" : p.garage === false ? "Не" : "Не е наведено" },
        { "@type": "PropertyValue", name: "elevator", value: p.elevator === true ? "Да" : p.elevator === false ? "Не" : "Не е наведено" },
        { "@type": "PropertyValue", name: "parking", value: p.parking ?? "Не е наведено" },
      ],
      provider: {
        "@type": "RealEstateAgent",
        name: "METROPOLIS REAL ESTATE AGENCY",
        telephone: "078/914-198",
        email: "metropolis.realestate@gmail.com",
      },
    } as const;

    const imgHTML = images
      .map((i) => `<img src="${i.image_url}" alt="${p.title}" style="max-width:260px;height:auto;border-radius:6px;margin-right:8px;" />`)
      .join("");

    const html = `<!doctype html>
<html lang="mk">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${p.title} | METROPOLIS</title>
  <meta name="description" content="${(p.comments ?? p.title)?.toString().slice(0,150)}" />
  ${origin ? `<link rel="canonical" href="${origin}/property/${p.id}" />` : ""}
  <script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
  <style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,Ubuntu,Helvetica,Arial,sans-serif;padding:20px;max-width:960px;margin:0 auto;background:#fff;color:#111} a{color:#c21d1d;text-decoration:none} a:hover{text-decoration:underline}</style>
</head>
<body>
  <header>
    <h1 itemprop="name">${p.title}</h1>
    <p><strong>Ев. бр:</strong> ${p.property_number}</p>
  </header>
  <main>
    <p><strong>Локација:</strong> ${p.location ?? p.neighborhood ?? ""}</p>
    <p><strong>Цена:</strong> ${(p.price ?? "").toLocaleString?.("mk-MK") ?? p.price} €</p>
    <p><strong>Површина:</strong> ${p.area ?? ""} m²</p>
    <p><strong>Кат:</strong> ${p.floor ?? ""}</p>
    <section>${imgHTML}</section>
    <p>${p.comments ?? ""}</p>
  </main>
</body>
</html>`;

    return new Response(html, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
      },
    });
  } catch (e) {
    return new Response(`Error: ${e instanceof Error ? e.message : String(e)}`, { 
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "text/plain; charset=utf-8" },
    });
  }
});