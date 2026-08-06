import crypto from 'node:crypto';

export class TwilioClient {
  constructor(
    private readonly accountSid?: string,
    private readonly authToken?: string,
    private readonly fromPhone?: string,
    private readonly whatsappFrom?: string,
    private readonly voiceFrom?: string
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

  async startIvrCall(input: {
    to: string;
    goal: string;
    digitSequence: string;
    introText?: string;
    waitBeforeDigitsSeconds?: number;
    record?: boolean;
  }): Promise<Record<string, unknown>> {
    const from = this.voiceFrom ?? this.fromPhone;
    if (!this.accountSid || !this.authToken || !from) {
      console.log('[twilio:dev] IVR call', {
        to: input.to,
        goal: input.goal,
        digitSequence: input.digitSequence,
        waitBeforeDigitsSeconds: input.waitBeforeDigitsSeconds ?? 2,
        record: input.record ?? true
      });
      return {
        sid: 'dev-twilio-ivr-call',
        status: 'dev_logged',
        provider: 'twilio',
        to: input.to
      };
    }

    const waitSeconds = Math.max(0, Math.min(30, input.waitBeforeDigitsSeconds ?? 2));
    const introText = input.introText ?? 'This is an automated assistant call. Please hold.';
    const twiml = [
      '<Response>',
      `<Say voice="alice">${this.escapeXml(introText)}</Say>`,
      waitSeconds > 0 ? `<Pause length="${waitSeconds}" />` : '',
      `<Play digits="${this.escapeXml(input.digitSequence)}" />`,
      '</Response>'
    ].filter(Boolean).join('');

    const encoded = new URLSearchParams({
      To: input.to,
      From: from,
      Twiml: twiml,
      Record: String(input.record ?? true)
    });

    return await this.twilioRequest('POST', `Calls.json`, encoded);
  }

  async getCall(callSid: string): Promise<Record<string, unknown>> {
    if (!this.accountSid || !this.authToken) {
      return {
        sid: callSid,
        status: 'dev_unconfigured',
        provider: 'twilio'
      };
    }

    return await this.twilioRequest('GET', `Calls/${encodeURIComponent(callSid)}.json`);
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

    const res = await this.rawTwilioRequest('POST', 'Messages.json', encoded);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`twilio_send_failed:${res.status}:${text}`);
    }
  }

  private async twilioRequest(method: 'GET' | 'POST', path: string, body?: URLSearchParams): Promise<Record<string, unknown>> {
    const res = await this.rawTwilioRequest(method, path, body);

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`twilio_voice_failed:${res.status}:${text}`);
    }

    return (await res.json()) as Record<string, unknown>;
  }

  private async rawTwilioRequest(method: 'GET' | 'POST', path: string, body?: URLSearchParams): Promise<Response> {
    const token = Buffer.from(`${this.accountSid}:${this.authToken}`).toString('base64');
    return await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${this.accountSid}/${path}`,
      {
        method,
        headers: {
          Authorization: `Basic ${token}`,
          ...(body ? { 'Content-Type': 'application/x-www-form-urlencoded' } : {})
        },
        body
      }
    );
  }

  private escapeXml(value: string): string {
    return value
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');
  }
}
