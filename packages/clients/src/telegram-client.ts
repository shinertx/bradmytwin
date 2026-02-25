export class TelegramClient {
  constructor(private readonly botToken?: string, private readonly webhookSecret?: string) {}

  validateSecret(secret?: string): boolean {
    if (!this.webhookSecret) {
      return true;
    }
    return secret === this.webhookSecret;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    if (!this.botToken) {
      console.log('[telegram:dev] send', { chatId, text });
      return;
    }

    const res = await fetch(`https://api.telegram.org/bot${this.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text })
    });

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`telegram_send_failed:${res.status}:${body}`);
    }
  }
}
