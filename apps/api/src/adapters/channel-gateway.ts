import type { ChannelType, InboundMessage, OutboundMessage } from '@brad/domain';
import { randomUUID } from 'node:crypto';
import { TelegramClient, TwilioClient } from '@brad/clients';
import { env } from '../config/env.js';
import { normalizePhoneE164Candidate } from '../utils/phone.js';

const twilio = new TwilioClient(
  env.TWILIO_ACCOUNT_SID,
  env.TWILIO_AUTH_TOKEN,
  env.TWILIO_SMS_FROM,
  env.TWILIO_WHATSAPP_FROM
);
const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN, env.TELEGRAM_WEBHOOK_SECRET);

export interface ChannelGateway {
  receiveInbound(payload: unknown): InboundMessage;
  sendOutbound(message: OutboundMessage): Promise<void>;
  normalizeIdentity(inbound: InboundMessage): { externalUserKey: string; phoneE164?: string };
  validateSignature(payload: {
    url?: string;
    params?: Record<string, string>;
    signature?: string;
    secret?: string;
  }): boolean;
}

export class TwilioSmsGateway implements ChannelGateway {
  receiveInbound(payload: unknown): InboundMessage {
    const data = payload as Record<string, string>;
    return {
      channel: 'SMS',
      externalUserKey: data.From,
      text: data.Body ?? '',
      providerMessageId: data.MessageSid ?? randomUUID(),
      phoneE164: data.From,
      metadata: payload as Record<string, unknown>
    };
  }

  async sendOutbound(message: OutboundMessage): Promise<void> {
    await twilio.sendSms(message.externalUserKey, message.text);
  }

  normalizeIdentity(inbound: InboundMessage): { externalUserKey: string; phoneE164?: string } {
    return { externalUserKey: inbound.externalUserKey, phoneE164: inbound.phoneE164 };
  }

  validateSignature(input: { url?: string; params?: Record<string, string>; signature?: string }): boolean {
    return twilio.validateSignature(input.url ?? '', input.params ?? {}, input.signature);
  }
}

export class TwilioWhatsAppGateway extends TwilioSmsGateway {
  receiveInbound(payload: unknown): InboundMessage {
    const data = payload as Record<string, string>;
    const from = (data.From ?? '').replace('whatsapp:', '');
    return {
      channel: 'WHATSAPP',
      externalUserKey: from,
      text: data.Body ?? '',
      providerMessageId: data.MessageSid ?? randomUUID(),
      phoneE164: from,
      metadata: payload as Record<string, unknown>
    };
  }

  async sendOutbound(message: OutboundMessage): Promise<void> {
    await twilio.sendWhatsApp(message.externalUserKey, message.text);
  }
}

export class TelegramGateway implements ChannelGateway {
  receiveInbound(payload: unknown): InboundMessage {
    const data = payload as {
      message?: {
        message_id: number;
        text?: string;
        chat?: { id: number | string };
        from?: { id?: number | string };
        contact?: { user_id?: number | string; phone_number?: string };
      };
    };

    const chatId = String(data.message?.chat?.id ?? data.message?.from?.id ?? '');
    const senderId = String(data.message?.from?.id ?? '');
    const contact = data.message?.contact;
    const contactIsSender = contact?.user_id !== undefined && String(contact.user_id) === senderId;
    const phoneE164 = contactIsSender
      ? normalizePhoneE164Candidate(contact.phone_number)
      : undefined;

    return {
      channel: 'TELEGRAM',
      externalUserKey: chatId,
      text: data.message?.text ?? '',
      providerMessageId: String(data.message?.message_id ?? randomUUID()),
      phoneE164,
      metadata: payload as Record<string, unknown>
    };
  }

  async sendOutbound(message: OutboundMessage): Promise<void> {
    await telegram.sendMessage(message.externalUserKey, message.text);
  }

  normalizeIdentity(inbound: InboundMessage): { externalUserKey: string; phoneE164?: string } {
    return { externalUserKey: inbound.externalUserKey, phoneE164: inbound.phoneE164 };
  }

  validateSignature(input: { secret?: string }): boolean {
    return telegram.validateSecret(input.secret);
  }
}

export class WebGateway implements ChannelGateway {
  receiveInbound(payload: unknown): InboundMessage {
    const data = payload as { personId: string; text: string; messageId?: string };
    return {
      channel: 'WEB',
      externalUserKey: data.personId,
      text: data.text,
      providerMessageId: data.messageId ?? randomUUID(),
      metadata: payload as Record<string, unknown>
    };
  }

  async sendOutbound(_message: OutboundMessage): Promise<void> {
    return;
  }

  normalizeIdentity(inbound: InboundMessage): { externalUserKey: string; phoneE164?: string } {
    return { externalUserKey: inbound.externalUserKey };
  }

  validateSignature(): boolean {
    return true;
  }
}

export function gatewayForChannel(channel: ChannelType): ChannelGateway {
  switch (channel) {
    case 'SMS':
      return new TwilioSmsGateway();
    case 'WHATSAPP':
      return new TwilioWhatsAppGateway();
    case 'TELEGRAM':
      return new TelegramGateway();
    case 'WEB':
      return new WebGateway();
  }

  throw new Error(`unsupported_channel:${String(channel)}`);
}
