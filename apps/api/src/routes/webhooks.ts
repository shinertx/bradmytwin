import type { FastifyInstance } from 'fastify';
import { TelegramGateway, TwilioSmsGateway, TwilioWhatsAppGateway } from '../adapters/channel-gateway.js';
import { TwinRouter } from '../services/twin-router.js';

const router = new TwinRouter();
const smsGateway = new TwilioSmsGateway();
const whatsappGateway = new TwilioWhatsAppGateway();
const telegramGateway = new TelegramGateway();

export async function webhookRoutes(app: FastifyInstance): Promise<void> {
  app.post('/webhooks/twilio/sms', async (req, reply) => {
    const payload = req.body as Record<string, string>;
    const signature = req.headers['x-twilio-signature'];

    if (!smsGateway.validateSignature({
      url: `${app.initialConfig.https ? 'https' : 'http'}://${req.headers.host}${req.url}`,
      params: payload,
      signature: Array.isArray(signature) ? signature[0] : signature
    })) {
      return reply.status(403).send({ error: 'invalid_twilio_signature' });
    }

    const inbound = smsGateway.receiveInbound(payload);
    await router.handleInbound(inbound);
    return reply.type('text/xml').send('<Response></Response>');
  });

  app.post('/webhooks/twilio/whatsapp', async (req, reply) => {
    const payload = req.body as Record<string, string>;
    const signature = req.headers['x-twilio-signature'];

    if (!whatsappGateway.validateSignature({
      url: `${app.initialConfig.https ? 'https' : 'http'}://${req.headers.host}${req.url}`,
      params: payload,
      signature: Array.isArray(signature) ? signature[0] : signature
    })) {
      return reply.status(403).send({ error: 'invalid_twilio_signature' });
    }

    const inbound = whatsappGateway.receiveInbound(payload);
    await router.handleInbound(inbound);
    return reply.type('text/xml').send('<Response></Response>');
  });

  app.post('/webhooks/telegram', async (req, reply) => {
    const secret = req.headers['x-telegram-bot-api-secret-token'];
    if (!telegramGateway.validateSignature({ secret: Array.isArray(secret) ? secret[0] : secret })) {
      return reply.status(403).send({ error: 'invalid_telegram_secret' });
    }

    const inbound = telegramGateway.receiveInbound(req.body);
    await router.handleInbound(inbound);
    return reply.send({ ok: true });
  });
}
