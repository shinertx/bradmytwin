import type { FastifyInstance } from 'fastify';
import {
  MetaWhatsAppGateway,
  TelegramGateway,
  TwilioSmsGateway,
  TwilioWhatsAppGateway
} from '../adapters/channel-gateway.js';
import { env } from '../config/env.js';
import { TwinRouter } from '../services/twin-router.js';

const router = new TwinRouter();
const smsGateway = new TwilioSmsGateway();
const whatsappGateway = new TwilioWhatsAppGateway();
const metaWhatsAppGateway = new MetaWhatsAppGateway();
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

  app.get('/webhooks/meta/whatsapp', async (req, reply) => {
    if (!env.META_WEBHOOK_VERIFY_TOKEN) {
      return reply.status(503).send({ error: 'meta_webhook_verify_token_missing' });
    }

    const query = req.query as Record<string, string | undefined>;
    const mode = query['hub.mode'];
    const verifyToken = query['hub.verify_token'];
    const challenge = query['hub.challenge'];

    if (mode !== 'subscribe' || !challenge) {
      return reply.status(400).send({ error: 'invalid_meta_verification_request' });
    }

    if (verifyToken !== env.META_WEBHOOK_VERIFY_TOKEN) {
      return reply.status(403).send({ error: 'invalid_meta_verify_token' });
    }

    return reply.type('text/plain').send(challenge);
  });

  app.post('/webhooks/meta/whatsapp', { config: { rawBody: true } }, async (req, reply) => {
    const signature = req.headers['x-hub-signature-256'];
    const rawBody = (req as { rawBody?: string }).rawBody;
    if (!metaWhatsAppGateway.validateSignature({
      signature: Array.isArray(signature) ? signature[0] : signature,
      rawBody
    })) {
      return reply.status(403).send({ error: 'invalid_meta_signature' });
    }

    const inbounds = metaWhatsAppGateway.receiveInboundBatch(req.body);
    for (const inbound of inbounds) {
      await router.handleInbound(inbound);
    }

    return reply.send({ ok: true, processed: inbounds.length });
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
