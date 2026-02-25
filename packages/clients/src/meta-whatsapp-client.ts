import crypto from 'node:crypto';

export class MetaWhatsAppClient {
  constructor(
    private readonly accessToken?: string,
    private readonly phoneNumberId?: string,
    private readonly graphApiVersion = 'v22.0',
    private readonly appSecret?: string
  ) {}

  isConfigured(): boolean {
    return Boolean(this.accessToken && this.phoneNumberId);
  }

  validateWebhookSignature(signature?: string, rawBody?: string): boolean {
    if (!this.appSecret) {
      return true;
    }

    if (!signature || !rawBody) {
      return false;
    }

    const expected = `sha256=${crypto
      .createHmac('sha256', this.appSecret)
      .update(rawBody)
      .digest('hex')}`;

    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  async sendTextMessage(to: string, text: string): Promise<void> {
    if (!this.isConfigured()) {
      console.log('[meta-whatsapp:dev] send', { to, text });
      return;
    }

    const res = await fetch(
      `https://graph.facebook.com/${this.graphApiVersion}/${this.phoneNumberId}/messages`,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          messaging_product: 'whatsapp',
          to,
          type: 'text',
          text: { body: text }
        })
      }
    );

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`meta_whatsapp_send_failed:${res.status}:${body}`);
    }
  }
}
