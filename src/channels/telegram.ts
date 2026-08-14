import { AppConfig } from '../config';
import { Channel } from './types';

export class TelegramAdapter implements Channel {
  readonly name = 'telegram';

  constructor(private cfg: AppConfig) {}

  async send(_chatId: string, _text: string): Promise<void> {
    console.warn('[telegram] adapter is a stub — phase 2 (uses sendChatAction typing)');
  }
}
