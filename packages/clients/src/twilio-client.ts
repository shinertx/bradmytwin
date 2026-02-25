import crypto from 'node:crypto';

export class TwilioClient {
  constructor(
    private readonly accountSid?: string,
    private readonly authToken?: string,
    private readonly fromPhone?: string,
    private readonly whatsappFrom?: string
  ) {}

  async sendSms(to: string, body: string): Promise<void> {
    if (!this.accountSid || !this.authToken || !this.fromPhone) {
      console.log('[twilio:dev] SMS', { to, body });
      return;
    }

    await this.sendMessage({ to, body, from: this.fromPhone });
  }

  async sendWhatsApp(to: string, body: string): Promise<void> {
    if (!this.accountSid || !this.authToken || !this.whatsappFrom) {
      console.log('[twilio:dev] WhatsApp', { to, body });
      return;
    }

    await this.sendMessage({ to: `whatsapp:${to}`, body, from: this.whatsappFrom });
  }

  validateSignature(url: string, params: Record<string, string>, signature?: string): boolean {
    if (!this.authToken || !signature) {
      return true;
    }

    const data = Object.keys(params)
      .sort()
      .reduce((acc, key) => acc + key + params[key], url);

    const expected = crypto.createHmac('sha1', this.authToken).update(data).digest('base64');
    return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature));
  }

  private async sendMessage(input: { to: string; from: string; body: string }): Promise<void> {
    const encoded = new URLSearchParams({
      To: input.to,
      From: input.from,
      Body: input.body
    });

    const token = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    const res = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          Authorization: `Basic ${token}`,
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: encoded
      }
    );

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`twilio_send_failed:${res.status}:${text}`);
    }
  }
}
