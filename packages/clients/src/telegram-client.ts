export class TelegramClient {
  constructor(private readonly botToken?: string, private readonly webhookSecret?: string) {}

  validateSecret(secret?: string): boolean {
    if (!this.webhookSecret) {
      return true;
    }
    return secret === this.webhookSecret;
  }

  async sendMessage(chatId: string, text: string): Promise<void> {
    await this.sendMessageWithReceipt(chatId, text);
  }

  async sendMessageWithReceipt(chatId: string, text: string): Promise<{ messageId: string }> {
    if (!this.botToken) {
      throw new Error('telegram_bot_not_configured');
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
    const payload = await res.json() as { ok?: boolean; result?: { message_id?: number } };
    const messageId = payload.result?.message_id;
    if (!payload.ok || typeof messageId !== 'number') throw new Error('telegram_send_missing_receipt');
    return { messageId: String(messageId) };
  }
}
