import { detectExactAddressAsk, LOCATION_FOLLOWUP_RE, EXACT_ADDRESS_RE } from '../src/llm/deterministic';

// Log the actual regex patterns
console.log('LOCATION_FOLLOWUP_RE source (first 200):', LOCATION_FOLLOWUP_RE.source.substring(0, 200));
console.log('LOCATION_FOLLOWUP_RE flags:', LOCATION_FOLLOWUP_RE.flags);

// Test the regex directly
console.log('\nDirect regex tests:');
console.log('te prasav:', LOCATION_FOLLOWUP_RE.test('te prasav za lokacija na stanot'));
console.log('те прашав:', LOCATION_FOLLOWUP_RE.test('те прашав за локација на станот'));
console.log('ova e lokacija:', LOCATION_FOLLOWUP_RE.test('ova e lokacija na parkot'));
console.log('ова е локација:', LOCATION_FOLLOWUP_RE.test('ова е локација на паркот'));
console.log('tochnata lokacija:', LOCATION_FOLLOWUP_RE.test('tochnata lokacija'));
console.log('точната локација:', LOCATION_FOLLOWUP_RE.test('точната локација'));

// Test function
console.log('\ndetectExactAddressAsk:');
console.log('te prasav:', detectExactAddressAsk('te prasav za lokacija na stanot'));
console.log('ova e lokacija:', detectExactAddressAsk('ova e lokacija na parkot'));
console.log('tochnata lokacija:', detectExactAddressAsk('tochnata lokacija'));
