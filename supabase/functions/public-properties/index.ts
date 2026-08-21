// Version: 2025-02-02-v7 - Added available_from filtering
import { serve } from "https://deno.land/std@0.177.0/http/server.ts";

const DEPLOY_VERSION = "v7-20250202-fallback";
const SUPABASE_URL = Deno.env.get("SUPABASE_URL") ?? "https://qkgioqotxjxffiaufgwd.supabase.co";
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY") ?? "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFrZ2lvcW90eGp4ZmZpYXVmZ3dkIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTUxMTU0NjUsImV4cCI6MjA3MDY5MTQ2NX0.WVno6c6_rvFqFwj1fN8UWHYmlit0C-6J_h57P8d5eOI";
const LOCAL_BACKUP_URL = Deno.env.get("LOCAL_BACKUP_URL") ?? "";
const FETCH_TIMEOUT_MS = 8000;

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

async function fetchJSON(path: string) {
  try {
    const res = await fetchWithTimeout(`${SUPABASE_URL}${path}`, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        "Content-Type": "application/json",
      },
      timeout: FETCH_TIMEOUT_MS,
    });
    if (res.ok) return res.json();
    if (res.status < 500) throw new Error(`Supabase REST error ${res.status}: ${await res.text()}`);
    console.warn(`[public-properties] Supabase returned ${res.status}, trying local backup...`);
  } catch (err) {
    console.warn(`[public-properties] Supabase unreachable: ${err instanceof Error ? err.message : err}`);
  }
  // --- Local fallback ---
  if (!LOCAL_BACKUP_URL) throw new Error(`Supabase failed and no LOCAL_BACKUP_URL configured`);
  const fallbackRes = await fetchWithTimeout(`${LOCAL_BACKUP_URL}${path}`, {
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
    },
    timeout: FETCH_TIMEOUT_MS,
  });
  if (!fallbackRes.ok) throw new Error(`Local backup error ${fallbackRes.status}: ${await fallbackRes.text()}`);
  console.log(`[public-properties] Served from local backup: ${path}`);
  return fallbackRes.json();
}

serve(async (req) => {
  try {
    const url = new URL(req.url);
    const format = url.searchParams.get("format");
    
    const origin = req.headers.get("x-forwarded-host")
      ? `${req.headers.get("x-forwarded-proto") ?? "https"}://${req.headers.get("x-forwarded-host")}`
      : "";

    // Get today's date for filtering
    const today = new Date().toISOString().split('T')[0];

    // 1) Fetch published properties with ALL existing details for AI assistant
    // Filter out properties with future available_from dates
    const properties: Array<any> = await fetchJSON(
      `/rest/v1/properties?select=id,property_number,title,property_type,room_type,neighborhood,address,price,area,floor,service_type,front_image_id,created_at,garage,elevator,heating,yard,orientation,year_built,total_floors,comments,description,parking,furnished,available_from&is_published=eq.true&or=(available_from.is.null,available_from.lte.${today})&order=created_at.desc`
    );
    
    // If JSON format requested, return formatted data for AI systems like Lina
    if (format === "json") {
      const formattedProperties = properties.map((p: any) => ({
        id: p.id,
        evidenten_broj: p.property_number,
        naslov: p.title,
        tip_na_nedviznina: p.property_type,
        tip_na_sobi: p.room_type,
        servis: p.service_type,
        naselba: p.neighborhood,
        adresa: p.address,
        cena_eur: p.price,
        povrsina_m2: p.area,
        kat: p.floor,
        vkupno_katovi: p.total_floors ?? "Не е наведено",
        godina_na_gradba: p.year_built ?? "Не е наведено",
        orientacija: p.orientation ?? "Не е наведено",
        // KEY FEATURES - explicit human readable for AI
        garaza: p.garage === true ? "Да" : p.garage === false ? "Не" : "Не е наведено",
        lift: p.elevator === true ? "Да" : p.elevator === false ? "Не" : "Не е наведено",
        greenje: p.heating ?? "Не е наведено",
        dvor: p.yard === true ? "Да" : p.yard === false ? "Не" : (typeof p.yard === "string" ? p.yard : "Не е наведено"),
        parking: p.parking ?? "Не е наведено",
        opremenost: p.furnished ?? "Не е наведено",
        dostapno_od: p.available_from ?? "Веднаш",
        // Text fields
        opis: p.description ?? "",
        komentari: p.comments ?? "",
        url: `/property/${p.id}`,
      }));
      
      return new Response(JSON.stringify({ 
        version: DEPLOY_VERSION,
        properties: formattedProperties, 
        count: formattedProperties.length,
        napomena: "Koristi garaza, lift, greenje, dvor, parking, opremenost za karakteristiki na imotot."
      }), {
        headers: {
          "Content-Type": "application/json",
          "Access-Control-Allow-Origin": "*",
        },
      });
    }

    // 2) Fetch front images in bulk
    const imageIds = Array.from(new Set(properties.map((p) => p.front_image_id).filter(Boolean)));
    const imageMap = new Map<string, string>();
    if (imageIds.length > 0) {
      const inList = imageIds.map((id) => encodeURIComponent(id)).join(",");
      const images: Array<any> = await fetchJSON(`/rest/v1/property_images?id=in.(${inList})&select=id,image_url`);
      images.forEach((img) => imageMap.set(img.id, img.image_url));
    }

    // 3) Build JSON-LD ItemList
    const listJSONLD = {
      "@context": "https://schema.org",
      "@type": "ItemList",
      name: "METROPOLIS Properties",
      description: "Live list of published properties",
      url: origin ? `${origin}/properties` : undefined,
      numberOfItems: properties.length,
      itemListElement: properties.map((p: any, idx: number) => ({
        "@type": "ListItem",
        position: idx + 1,
        item: {
          "@type": "RealEstateListing",
          "@id": origin ? `${origin}/property/${p.id}` : p.id,
          url: origin ? `${origin}/property/${p.id}` : undefined,
          name: p.title,
          identifier: p.property_number,
          description: p.description ?? p.comments ?? "",
          address: {
            "@type": "PostalAddress",
            addressLocality: p.neighborhood,
            streetAddress: p.address,
            addressCountry: "MK",
          },
          offers: {
            "@type": "Offer",
            price: p.price,
            priceCurrency: "EUR",
            availability: "https://schema.org/InStock",
          },
          numberOfRooms: p.room_type,
          floorSize: {
            "@type": "QuantitativeValue",
            value: p.area,
            unitCode: "MTK",
          },
          floorLevel: p.floor,
          image: p.front_image_id ? imageMap.get(p.front_image_id) : undefined,
          additionalProperty: [
            { "@type": "PropertyValue", name: "propertyType", value: p.property_type },
            { "@type": "PropertyValue", name: "serviceType", value: p.service_type },
            {
              "@type": "PropertyValue",
              name: "garageAvailable",
              value: p.garage === null || p.garage === undefined ? "Не е наведено" : p.garage ? "Да" : "Не",
            },
            {
              "@type": "PropertyValue",
              name: "elevator",
              value: p.elevator === null || p.elevator === undefined ? "Не е наведено" : p.elevator ? "Да" : "Не",
            },
            {
              "@type": "PropertyValue",
              name: "heating",
              value: p.heating ?? "Не е наведено",
            },
            {
              "@type": "PropertyValue",
              name: "yard",
              value: p.yard === null || p.yard === undefined ? "Не е наведено" : p.yard ? "Да" : "Не",
            },
            {
              "@type": "PropertyValue",
              name: "orientation",
              value: p.orientation || "Не е наведено",
            },
            {
              "@type": "PropertyValue",
              name: "buildYear",
              value: p.year_built ?? "Не е наведено",
            },
            {
              "@type": "PropertyValue",
              name: "totalFloors",
              value: p.total_floors ?? "Не е наведено",
            },
            {
              "@type": "PropertyValue",
              name: "furnished",
              value: p.furnished ?? "Не е наведено",
            },
            {
              "@type": "PropertyValue",
              name: "comments",
              value: p.comments ?? "",
            },
          ],
        },
      })),
    } as const;

    // 4) Build simple, crawlable HTML
    const itemsHTML = properties
      .map((p) => {
        const img = p.front_image_id ? imageMap.get(p.front_image_id) : undefined;
        const propUrl = origin ? `${origin}/property/${p.id}` : `/property/${p.id}`;
        return `
<article>
  <h2>Ев. бр: ${p.property_number} - ${p.title}</h2>
  ${img ? `<img src="${img}" alt="${p.title}" style="max-width:300px;">` : ""}
  <p><strong>${p.neighborhood ?? ""}</strong></p>
  <p>Тип: ${p.property_type ?? ""} • ${p.room_type ?? ""}</p>
  <p>Плош: ${p.area ?? ""} m²</p>
  <p>Цена: ${(p.price ?? "").toLocaleString?.("mk-MK") ?? p.price} €</p>
  <a href="${propUrl}">Повеќе</a>
</article>`;
      })
      .join("\n");

    const html = `<!DOCTYPE html>
<html lang="mk">
<head>
  <meta charset="utf-8">
  <title>METROPOLIS Properties</title>
  ${origin ? `<link rel="canonical" href="${origin}/properties">` : ""}
  <script type="application/ld+json">${JSON.stringify(listJSONLD)}</script>
</head>
<body>
  <header>
    <h1>METROPOLIS REAL ESTATE AGENCY</h1>
    <p>Прикажани резултати: ${properties.length}</p>
  </header>
  <main>
    ${itemsHTML || "<p>Нема објавени недвижности.</p>"}
  </main>
</body>
</html>`;

    return new Response(html, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "public, s-maxage=300, stale-while-revalidate=600",
        "Access-Control-Allow-Origin": "*",
      },
    });
  } catch (e) {
    return new Response(`Error: ${e instanceof Error ? e.message : String(e)}`, { status: 500 });
  }
});
