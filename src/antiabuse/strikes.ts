import { ChatSession } from '../fsm/session';
import { Classified } from '../llm/classify';

export const OFFENSE_WARNINGS: Record<number, string> = {
  1: "Господине, да останеме професионални, ве молам.",
  2: "Господине, ова е последна опомена. Доколку продолжите со ваков речник, ќе морам да го прекинам разговорот.",
};

export type StrikeOutcome = 'none' | 'warn' | 'warnFinal' | 'terminate';

export function applyStrike(session: ChatSession, classified: Classified): StrikeOutcome {
  if (!classified.offensive || classified.offenseLevel < 1) return 'none';
  // Severe abuse / threats = instant termination (3rd-strike equivalent).
  if (classified.offenseLevel >= 3) {
    session.strikes = 3;
    return 'terminate';
  }
  session.strikes += 1;
  if (session.strikes >= 3) return 'terminate';
  return session.strikes === 2 ? 'warnFinal' : 'warn';
}
