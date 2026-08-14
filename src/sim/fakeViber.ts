import { Channel } from '../channels/types';

export interface SimMessage {
  role: 'user' | 'assistant';
  text: string;
  at: number;
}

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

export class FakeViber implements Channel {
  readonly name = 'viber';
  readonly log: Record<string, SimMessage[]> = {};
  sends = 0;

  constructor(private fast = false) {}

  pushUser(chatId: string, text: string): void {
    this.log[chatId] ??= [];
    this.log[chatId].push({ role: 'user', text, at: Date.now() });
  }

  async send(chatId: string, text: string): Promise<void> {
    if (!this.fast) await sleep(rand(120, 350)); // keep realistic ordering while overlapped
    this.sends += 1;
    this.log[chatId] ??= [];
    this.log[chatId].push({ role: 'assistant', text, at: Date.now() });
  }

  assistant(chatId: string): SimMessage[] {
    return (this.log[chatId] ?? []).filter(m => m.role === 'assistant');
  }
}
