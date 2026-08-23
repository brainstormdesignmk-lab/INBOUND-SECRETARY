import { detectVisitInterest, buildEvent, extractSlots, inferPropertyId } from '../src/llm/deterministic';
import { parseClassified, Classifier } from '../src/llm/classify';
import { transition } from '../src/fsm/machine';

const variants = [
  'zaInteresiran sum za 89',
  'zaInteresiran sam za 89',
  'zaInteresirana sum za 89',
  'zainteresiran sum',
  'ZAINTERESIRAN SAM',
  'mi se svigja 89',
  'mi se sviga 89',
  'MI SE SVIGJA 89',
  'mi se dopaga 89',
  'mi se sviduva 89',
  'ke zemam 89',
  'go sakam 89',
  'go sakaam 89',
  'svigja mi',
  'svigja mi e',
  'odlicen e 89',
  'svigja mi ovoj stan',
];

for (const v of variants) {
  const interest = detectVisitInterest(v);
  const eb = inferPropertyId(v);
  const slots = extractSlots(v);
  console.log(`"${v}" → visitInterest=${interest}, eb=${eb}, slots=${JSON.stringify({service: slots.service, location: slots.location, bedrooms: slots.bedrooms})}`);
}
