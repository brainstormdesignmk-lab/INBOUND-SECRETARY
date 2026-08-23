import { OfflineMapStore } from '../src/geo/offlineMap.js';
const map = new OfflineMapStore('data/skopje-pois.db');
console.log('available:', map.available);
const r1 = map.findPoiByName('Бул. АСНОМ Бр.134');
console.log('findPoiByName "Бул. АСНОМ Бр.134":', r1);
const r2 = map.findPoiByName('Златна вилушка');
console.log('findPoiByName "Златна вилушка":', r2);
// Check: does the contains query match "АСНОМ" inside a POI name?
import Database from 'better-sqlite3';
const db = new Database('data/skopje-pois.db', { readonly: true });
const rows = db.prepare("SELECT name, lat, lon FROM pois WHERE name LIKE '%АСНОМ%' OR name LIKE '%asn%' OR name LIKE '%ASNOM%'").all();
console.log('POIs containing ASNOM:', rows);
