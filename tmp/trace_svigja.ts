import { buildEvent, detectSeenProperty, detectVisitInterest, detectAvailabilityAsk } from '../src/llm/deterministic';

const text = 'mi se svigja 89';
console.log('buildEvent:', buildEvent(text, 'idle'));
console.log('detectSeenProperty:', detectSeenProperty(text));
console.log('detectVisitInterest:', detectVisitInterest(text));
console.log('detectAvailabilityAsk:', detectAvailabilityAsk(text));

// Also test other "like" variants
const variants = [
  'mi se svigja 89',
  'ми се свига 89',
  'ми се допаѓа 89',
  'ми се свиѓа 89',
  'mI like 89',
  'sviduva mi se 89',
  'svigja mi',
  'svigja mi 89',
  'Mi se svigja ova 89',
  'KE ZEMAM 89',
  'go sakam 89',
  'go sakaam 89',
  'svigja mi e',
  'mi e svigja',
  'odlicen e 89',
];
for (const v of variants) {
  const ev = buildEvent(v, 'idle');
  const sp = detectSeenProperty(v);
  const vi = detectVisitInterest(v);
  console.log(`"${v}" → event=${ev.type}, seenProperty=${JSON.stringify(sp)}, visitInterest=${vi}`);
}
