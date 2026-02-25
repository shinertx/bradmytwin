export class TelegramClient {
    botToken;
    webhookSecret;
    constructor(botToken, webhookSecret) {
        this.botToken = botToken;
        this.webhookSecret = webhookSecret;
    }
    validateSecret(secret) {
        if (!this.webhookSecret) {
            return true;
        }
        return secret === this.webhookSecret;
    }
    async sendMessage(chatId, text) {
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
//# sourceMappingURL=telegram-client.js.map