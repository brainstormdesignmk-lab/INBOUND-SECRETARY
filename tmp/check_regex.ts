// Check the regex behavior
import { detectPropertyInterest } from '../src/llm/deterministic';

// These should all work — check which ones fail
console.log('=== POSITIVE (should all be true) ===');
console.log('go sakam:', detectPropertyInterest('go sakam'));
console.log('ми се свиѓа:', detectPropertyInterest('ми се свиѓа'));
console.log('заинтересиран:', detectPropertyInterest('заинтересиран сум'));
console.log('ubav e 89:', detectPropertyInterest('ubav e 89'));
console.log('убав е 89:', detectPropertyInterest('убав е 89'));
console.log('89 e dobar stan:', detectPropertyInterest('89 e dobar stan'));
console.log('89 е добар стан:', detectPropertyInterest('89 е добар стан'));
console.log('е убав:', detectPropertyInterest('е убав'));
console.log('е добар:', detectPropertyInterest('е добар'));
console.log('најубав ми е:', detectPropertyInterest('најубав ми е'));
console.log('interessen mi e:', detectPropertyInterest('interessen mi e 89'));

console.log('\n=== NEGATIVE (should all be false) ===');
console.log('кога може:', detectPropertyInterest('кога може да се погледне'));
console.log('дали е достапен:', detectPropertyInterest('дали е достапен?'));
console.log('zdravo:', detectPropertyInterest('zdravo'));
