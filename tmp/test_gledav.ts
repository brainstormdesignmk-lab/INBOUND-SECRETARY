import { buildEvent, extractSlots } from '../src/llm/deterministic';
const text = 'GO GLEDAV OVA 89';
const slots = extractSlots(text);
console.log('slots:', JSON.stringify(slots));
console.log('event:', JSON.stringify(buildEvent(text, 'discovery')));
