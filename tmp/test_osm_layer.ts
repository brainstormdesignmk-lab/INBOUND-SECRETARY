// Test what the live OSM layer returns
import { readFileSync } from 'fs';

const address = 'Бул. АСНОМ Бр.134';
const location = 'Аеродром';

// Test Nominatim geocode
const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(address + ', ' + location + ', Skopje')}&format=json&limit=1&addressdetails=1`;
console.log('Nominatim URL:', url);

try {
  const res = await fetch(url, { headers: { 'User-Agent': 'metropolis-lina/1.0' } });
  const data = await res.json();
  console.log('Nominatim result:', JSON.stringify(data[0]?.display_name ?? 'none'));
  if (data[0]) {
    console.log('lat:', data[0].lat, 'lon:', data[0].lon);
    console.log('type:', data[0].type, 'class:', data[0].class);
  }
} catch (e) {
  console.log('Nominatim error:', e);
}
