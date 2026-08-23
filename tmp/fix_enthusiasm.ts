const fs = require('fs');
const file = 'src/handlers/inbound.ts';
let src = fs.readFileSync(file, 'utf8');

// Fix: exclude availability asks from the enthusiasm block.
// "дали е достапен?" → detectVisitInterest returns true AND detectAvailabilityAsk returns true.
// We must NOT intercept these — they go through the existing availability ack path.
const old = `    } else if (next === 'closing'
        && ev.type === 'INTERESTED'
        && before !== 'closing'
        && (before === 'property_query' || before === 'presentation' || before === 'discovery')) {
      // Enthusiasm: the client said 'mi se svigja 89' / 'zainteresiran sum' /
      // 'go sakam' — positive interest WITHOUT an explicit visit time or
      // availability ask. Send enthusiasm + visit offer, NOT the fee yet.
      // The fee is disclosed ONLY after the client confirms ('да').
      const eb = session.slots.propertyId ?? session.slots.interestedPropertyId ?? props[0]?.eb;
      if (eb) {
        session.slots.interestedPropertyId = eb;
        session.slots.ownerContactPending = true;
        session.state = 'closing';
      }
      reply = pickVariant('property.liked', { recent: assistantTexts(session) })
        ?? 'Одличен избор! Дали би сакале да организирам посета, за да го погледнете во живо?';`;

const fix = `    } else if (next === 'closing'
        && ev.type === 'INTERESTED'
        && before !== 'closing'
        && !detectAvailabilityAsk(text)
        && !detectVisitTime(text)
        && (before === 'property_query' || before === 'presentation' || before === 'discovery')) {
      // Enthusiasm: the client said 'mi se svigja 89' / 'zainteresiran sum' /
      // 'go sakam' — positive interest WITHOUT an explicit visit time or
      // availability ask (those have their own handlers above).
      // Send enthusiasm + visit offer, NOT the fee yet.
      // The fee is disclosed ONLY after the client confirms ('да').
      const eb = session.slots.propertyId ?? session.slots.interestedPropertyId ?? props[0]?.eb;
      if (eb) {
        session.slots.interestedPropertyId = eb;
        session.slots.ownerContactPending = true;
        session.state = 'closing';
      }
      reply = pickVariant('property.liked', { recent: assistantTexts(session) })
        ?? 'Одличен избор! Дали би сакале да организирам посета, за да го погледнете во живо?';`;

if (!src.includes(old)) { console.error('OLD BLOCK NOT FOUND'); process.exit(1); }
src = src.replace(old, fix);
fs.writeFileSync(file, src);
console.log('OK: enthusiasm block fixed with exclusions');
