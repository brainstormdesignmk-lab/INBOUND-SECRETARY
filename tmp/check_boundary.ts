// Does \\b (word boundary) work after Cyrillic characters?
const re1 = /(?:убав|dobar)\s+(?:е|e)\b/iu;
const re2 = /(?:убав|dobar)\s+(?:е|e)(?=[^\p{L}\p{N}]|$)/iu;
console.log('re1 (\\b):', re1.test('убав е 89'), re1.test('ubav e 89'));
console.log('re2 (lookahead):', re2.test('убав е 89'), re2.test('ubav e 89'));
