import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AgentConductorService } from '../services/agent-conductor-service.js';
import { MessageService } from '../services/message-service.js';

const service = new AgentConductorService();
const messageService = new MessageService();
const threadIdSchema = z.object({ id: z.string().uuid() });
const messageSchema = z.object({ text: z.string().min(1).max(50_000) });

export async function agentThreadRoutes(app: FastifyInstance): Promise<void> {
  app.get('/agent/threads', { preHandler: [app.authenticate] }, async (req) => {
    const user = req.user as { personId: string };
    return { ok: true, threads: await service.listThreads(user.personId) };
  });

  app.post('/agent/threads', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = req.user as { personId: string };
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_agent_thread', details: parsed.error.flatten() });
    const sourceMessageId = await messageService.insert({
      personId: user.personId,
      channel: 'WEB',
      direction: 'INBOUND',
      body: parsed.data.text,
      metadata: { source: 'agent_thread_api' }
    });
    const thread = await service.intake({
      personId: user.personId,
      sourceMessageId,
      text: parsed.data.text,
      sourceChannel: 'WEB'
    });
    return reply.status(201).send({ ok: true, ...thread });
  });

  app.get('/agent/threads/:id', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = req.user as { personId: string };
    const parsed = threadIdSchema.safeParse(req.params);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_thread_id' });
    const result = await service.getThread(user.personId, parsed.data.id);
    return result ? reply.send({ ok: true, ...result }) : reply.status(404).send({ error: 'thread_not_found' });
  });

  app.post('/agent/threads/:id/messages', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = req.user as { personId: string };
    const params = threadIdSchema.safeParse(req.params);
    const body = messageSchema.safeParse(req.body);
    if (!params.success || !body.success) return reply.status(400).send({ error: 'invalid_agent_message' });
    const message = await service.ownerMessage({ personId: user.personId, threadId: params.data.id, body: body.data.text });
    return message ? reply.status(201).send({ ok: true, message }) : reply.status(409).send({ error: 'thread_not_writable' });
  });

  for (const action of ['pause', 'resume', 'cancel'] as const) {
    app.post(`/agent/threads/:id/${action}`, { preHandler: [app.authenticate] }, async (req, reply) => {
      const user = req.user as { personId: string };
      const parsed = threadIdSchema.safeParse(req.params);
      if (!parsed.success) return reply.status(400).send({ error: 'invalid_thread_id' });
      const thread = await service.setStatus({ personId: user.personId, threadId: parsed.data.id, action });
      return thread ? reply.send({ ok: true, thread }) : reply.status(409).send({ error: 'thread_transition_rejected' });
    });
  }

  app.get('/agent/threads/:id/stream', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = req.user as { personId: string };
    const parsed = threadIdSchema.safeParse(req.params);
    if (!parsed.success) return reply.status(400).send({ error: 'invalid_thread_id' });
    const initial = await service.getThread(user.personId, parsed.data.id);
    if (!initial) return reply.status(404).send({ error: 'thread_not_found' });

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    if (req.headers.origin) {
      reply.raw.setHeader('Access-Control-Allow-Origin', req.headers.origin);
      reply.raw.setHeader('Vary', 'Origin');
    }
    const send = async (): Promise<void> => {
      const snapshot = await service.getThread(user.personId, parsed.data.id);
      reply.raw.write(`event: snapshot\ndata: ${JSON.stringify(snapshot)}\n\n`);
    };
    await send();
    const interval = setInterval(() => void send(), 2_000);
    req.raw.on('close', () => clearInterval(interval));
  });
}
