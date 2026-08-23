import { OfflineMapStore } from '../src/geo/offlineMap.js';
import path from 'path';

const dbPath = process.env.SKOPJE_POIS_DB || path.join(process.cwd(), 'data', 'skopje-pois.db');
const map = new OfflineMapStore(dbPath);

// EB 89: Бул. Асном 134 → should be near Парк Авионче
let g = map.geocodeAddress('Бул. Асном 134');
console.log('EB 89:', g?.lat?.toFixed(6), g?.lon?.toFixed(6));
if (g) { const p = map.nearestPois(g.lat, g.lon, 300, 3); console.log('  top POIs:', p.map(x => x.name+' '+x.distance_m+'m').join(', ')); }

// EB 47: Јордан Мијалков 64 → should be near Факултет за физичка култура
g = map.geocodeAddress('Јордан Мијалков 64');
console.log('EB 47:', g?.lat?.toFixed(6), g?.lon?.toFixed(6));
if (g) { const p = map.nearestPois(g.lat, g.lon, 300, 3); console.log('  top POIs:', p.map(x => x.name+' '+x.distance_m+'m').join(', ')); }

// EB 78: Народен Фронт 23 → should be near Беверли Хилс
g = map.geocodeAddress('Народен Фронт 23');
console.log('EB 78:', g?.lat?.toFixed(6), g?.lon?.toFixed(6));
if (g) { const p = map.nearestPois(g.lat, g.lon, 300, 3); console.log('  top POIs:', p.map(x => x.name+' '+x.distance_m+'m').join(', ')); }
