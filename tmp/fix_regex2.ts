const fs = require('fs');
const file = 'src/llm/deterministic.ts';
let src = fs.readFileSync(file, 'utf8');

// The file has \s (single backslash) in the regex literal
const oldStr = '(?:те|te)\\s+(?:праш(ав|ам)|pras(av|ам))\\s+(?:за\\s+)?(?:локација|адреса|улица|lokacija|adresa|ulica)|ова\\s+(?:е|e)\\s+(?:локација|адреса|lokacija|adresa)\\s+на|точн(ата|а|о)\\s+(?:локација|адреса|lokacija|adresa)';
const newStr = '(?:те|te)\\s+(?:праш(ав|ам)|pras(av|ам))\\s+(?:за|za)\\s+(?:локација|адреса|улица|lokacija|adresa|ulica)|(?:ова|ova)\\s+(?:е|e)\\s+(?:локација|адреса|lokacija|adresa)\\s+на|(?:точн|tochn)(ата|а|о)\\s+(?:локација|адреса|lokacija|adresa)';

const idx = src.indexOf(oldStr);
if (idx > -1) {
  src = src.substring(0, idx) + newStr + src.substring(idx + oldStr.length);
  fs.writeFileSync(file, src, 'utf8');
  console.log('Fixed LOCATION_FOLLOWUP_RE');
  
  // Verify
  const verify = fs.readFileSync(file, 'utf8');
  const vidx = verify.indexOf('LOCATION_FOLLOWUP_RE');
  console.log('Verify:', verify.substring(vidx, vidx + 200));
} else {
  console.log('Pattern not found');
}
