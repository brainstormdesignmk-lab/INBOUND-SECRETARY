// Build the regex step by step to find the issue
const adj = '(?:убава?|убаво?|ubav[aeo]?|добар|добра|добро|dobar|dobra|dobro|прекрасен|прекрасна|prekrasen|prekrasna|најубав|najubav)';
const copula = '(?:е|e|ми\\s+е|mi\\s+e)';

// Pattern 5: adjective + copula + word boundary
const p5 = new RegExp(adj + '\\s+' + copula + '\\b', 'iu');
console.log('P5 source:', p5.source.substring(0, 100));
console.log('P5 tests:');
console.log('  ubav e 89:', p5.test('ubav e 89'));
console.log('  убав е 89:', p5.test('убав е 89'));
console.log('  dobar e 89:', p5.test('dobar e 89'));
console.log('  добар е 89:', p5.test('добар е 89'));
console.log('  prekrasen e:', p5.test('prekrasen e'));
console.log('  прекрасен е:', p5.test('прекрасен е'));
console.log('  najubav mi e:', p5.test('najubav mi e'));
console.log('  најубав ми е:', p5.test('најубав ми е'));

// Pattern 6: copula + adjective
const p6 = new RegExp('|' + copula + '\\s+' + adj + '\\b', 'iu');
console.log('\nP6 tests:');
console.log('  е убав:', p6.test('е убав'));
console.log('  e ubav:', p6.test('e ubav'));
console.log('  е добар:', p6.test('е добар'));
console.log('  e dobar:', p6.test('e dobar'));
console.log('  mi e dobar:', p6.test('mi e dobar'));
console.log('  ми е добар:', p6.test('ми е добар'));

// Pattern 7: subject + copula + adjective (works!)
const p7 = new RegExp('|(?:stanot?|станот?|овој|овaa|ова|ovoj|ovaa|ova)\\s+(?:е|e)\\s+' + adj, 'iu');
console.log('\nP7 tests:');
console.log('  stanot e ubav:', p7.test('stanot e ubav'));
console.log('  станот е убав:', p7.test('станот е убав'));
console.log('  ова е убав:', p7.test('ова е убав'));
