import { AppConfig } from '../config';
import { Channel } from './types';

export class WhatsAppAdapter implements Channel {
  readonly name = 'whatsapp';

  constructor(private cfg: AppConfig) {}

  async send(_chatId: string, _text: string): Promise<void> {
    console.warn('[whatsapp] adapter is a stub — phase 3');
  }
}
