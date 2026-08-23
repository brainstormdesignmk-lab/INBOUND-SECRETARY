import { extractSlots, detectWidenIntent, detectBusiness, detectHouse, buildEvent, detectSeeOffers, detectAgreement, detectSuggestAlternatives } from '../src/llm/deterministic';

// Simulate the flow step by step
const msgs = [
  'zdravo',                    // greeting → intent ask
  'I TOA I TOA',               // user says both
  'DUKJAN',                    // user says property type
  'KE KUPAM DUKJAN',           // user specifies service + type
];

for (const text of msgs) {
  const s = extractSlots(text);
  const w = detectWidenIntent(text);
  const b = detectBusiness(text);
  const h = detectHouse(text);
  console.log(`"${text}" → service:${s.service} business:${b} house:${h} widen:${w} intent:${s.intent} location:${s.location}`);
}
