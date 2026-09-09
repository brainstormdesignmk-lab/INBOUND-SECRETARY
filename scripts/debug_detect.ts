import { detectPropertyDescription, detectService, detectBothServices, extractSlots } from '../src/llm/deterministic';

const text = 'dobar den. go gledav oglasot za stan vo karpos na internet. dali go imate uste ?';
console.log('detectPropertyDescription:', detectPropertyDescription(text));
console.log('detectService:', detectService(text));
console.log('detectBothServices:', detectBothServices(text));
const slots = extractSlots(text);
console.log('extractSlots:', JSON.stringify(slots));
console.log('!slots.service:', !slots.service);
console.log('BLOCK SHOULD FIRE:', detectPropertyDescription(text) && !slots.service && !detectService(text) && !detectBothServices(text));
