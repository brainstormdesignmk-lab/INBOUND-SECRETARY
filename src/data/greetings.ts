// Greetings that open the funnel at Phase 1: Buy vs Rent (from the prototype).
// The code-built list below is the fallback; the generated bank (responseBank.ts)
// is preferred so greetings vary across sessions and never repeat right after
// being sent.
import { pickVariant } from './responseBank';

export const INITIAL_GREETINGS = [
  "Здраво! Јас сум Лина. За почеток, кажете ми дали сте заинтересирани за купување на имот или за изнајмување?",
  "Добредојдовте! Јас сум Лина. Тука сум да Ви помогнам. Кажете ми, дали барате нов преубав дом за купување или можеби под кирија за изнајмување?",
  "Здраво! Јас сум Лина. Моја примарна задача е да го најдам идеалниот простор за Вас. Дали Ве интересира купување или изнајмување на имот?",
  "Добар ден! Добредојдовте во агенцијата Metropolis. Како Ваш личен асистент, сакам да Ве прашам - дали барате убав имот за купување или за изнајмување?",
  "Здраво и добредојдовте. Пред да ги разгледаме најубавите имоти кои ги имаме во понуда, кажете ми - дали планирате да купите или да изнајмите?",
];

/** A greeting variant, avoiding any of the given recent texts. Falls back to
 *  the hand-written INITIAL_GREETINGS when the bank has none. */
export function randomGreeting(avoid: string[] = []): string {
  return pickVariant('greeting', { recent: avoid })
    ?? INITIAL_GREETINGS[Math.floor(Math.random() * INITIAL_GREETINGS.length)];
}
