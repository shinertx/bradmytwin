import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { TwinRouter } from '../services/twin-router.js';
import { MessageService } from '../services/message-service.js';

const router = new TwinRouter();
const messageService = new MessageService();

export async function webChatRoutes(app: FastifyInstance): Promise<void> {
  app.post('/web/chat/messages', {
    preHandler: [app.authenticate],
    config: {
      rateLimit: {
        max: 30,
        timeWindow: '1 minute'
      }
    }
  }, async (req, reply) => {
    const user = req.user as { personId: string };
    const body = req.body as { text: string };

    if (!body?.text?.trim()) {
      return reply.status(400).send({ error: 'text_required' });
    }

    const result = await router.handleInbound({
      channel: 'WEB',
      externalUserKey: user.personId,
      text: body.text,
      providerMessageId: randomUUID(),
      metadata: { source: 'web' }
    });

    return reply.send({ ok: true, reply: result.text });
  });

  app.get('/web/chat/stream', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = req.user as { personId: string };

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');

    const sendSnapshot = async (): Promise<void> => {
      const messages = await messageService.listByPerson(user.personId, 100);
      reply.raw.write(`event: snapshot\n`);
      reply.raw.write(`data: ${JSON.stringify(messages)}\n\n`);
    };

    await sendSnapshot();

    const interval = setInterval(async () => {
      await sendSnapshot();
    }, 5000);

    req.raw.on('close', () => {
      clearInterval(interval);
    });
  });
}
