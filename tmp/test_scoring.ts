import { OfflineMapStore } from '../src/geo/offlineMap.js';
const map = new OfflineMapStore('data/skopje-pois.db');
const pois = map.nearestPois(41.9878895, 21.4764927, 1500, 10);
console.log('nearestPois result:');
for (const p of pois) console.log('  ' + p.name + ' ' + p.distance_m + 'm type=' + p.type);

// Also check the score
const POI_PRIORITY: Record<string, number> = {
  square: 0, hospital: 1, clinic: 1, school: 2, university: 2,
  government: 3, stadium: 4, place_of_worship: 5, museum: 6,
  hotel: 7, mall: 8, bank: 9, pharmacy: 10, park: 12,
  supermarket: 15, restaurant: 20, cafe: 20, fuel: 30, parking: 30,
};
console.log('\nScores:');
for (const p of pois) {
  const priority = POI_PRIORITY[p.type] ?? 50;
  const score = p.distance_m * (1 + priority / 10);
  console.log('  ' + p.name + ': dist=' + p.distance_m + ' priority=' + priority + ' score=' + Math.round(score));
}
