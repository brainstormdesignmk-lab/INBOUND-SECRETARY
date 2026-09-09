// Test Photon directly via HTTP
import '../src/compat/node16';

async function main() {
  const addresses = [
    ['Васил Стефановски 16', 'Центар'],
    ['Народен Фронт 23', 'Капиштец'],
    ['Беверли Хилс', 'Капиштец'],
    ['Бул. АСНОМ 134', 'Аеродром'],
  ];
  
  for (const [addr, loc] of addresses) {
    const q = [addr, loc, 'Skopje'].filter(Boolean).join(' ');
    const url = `https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=1&osm_tag=building`;
    const res = await fetch(url);
    const data = await res.json();
    const f = data?.features?.[0];
    if (f?.geometry?.coordinates) {
      const [lon, lat] = f.geometry.coordinates;
      const street = f.properties?.street ?? f.properties?.name ?? '';
      console.log(`${addr}, ${loc} → ${lat.toFixed(6)}, ${lon.toFixed(6)} (${street})`);
    } else {
      console.log(`${addr}, ${loc} → FAILED`);
    }
  }
}

main().catch(console.error);
