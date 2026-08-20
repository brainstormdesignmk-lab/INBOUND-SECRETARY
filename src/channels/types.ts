export interface Channel {
  name: string;
  /** source: which brain produced the reply ('gemini:1', 'groq',
   *  'deterministic', 'fallback') — real adapters ignore it, the TUI shows it. */
  send(chatId: string, text: string, source?: string): Promise<void>;
}

export class ChannelRegistry {
  private channels = new Map<string, Channel>();

  register(c: Channel): void {
    this.channels.set(c.name, c);
  }

  get(name: string): Channel | undefined {
    return this.channels.get(name);
  }

  async send(name: string, chatId: string, text: string, source?: string): Promise<void> {
    const ch = this.channels.get(name);
    if (!ch) {
      console.warn(`[channels] unknown channel "${name}" — message dropped`);
      return;
    }
    await ch.send(chatId, text, source);
  }
}
