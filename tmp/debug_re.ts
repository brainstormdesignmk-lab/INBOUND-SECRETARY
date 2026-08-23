// Debug: check the actual regex pattern
import { detectPropertyInterest } from '../src/llm/deterministic';

// Test Cyrillic adjective + copula
const cases = [
  ['ubav e 89', true],
  ['UBAV E 89', true],
  ['убав е 89', true],
  ['89 e dobar stan', true],
  ['89 е добар стан', true],
  ['89 e prekrasen', true],
  ['89 е прекрасен', true],
  ['najubav mi e', true],
  ['најубав ми е', true],
  ['е убав', true],
  ['е добар', true],
  ['interessen mi e 89', true],
  ['заинтересиран сум', true],
  ['zainteresiran sum', true],
  ['go sakam', true],
  ['кога може да се погледне', false],
  ['дали е достапен?', false],
  ['zdravo', false],
];

for (const [t, exp] of cases) {
  const got = detectPropertyInterest(t as string);
  console.log(got === exp ? '✅' : '❌', JSON.stringify(t), 'exp:', exp, 'got:', got);
}
