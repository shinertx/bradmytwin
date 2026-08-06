import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { AgentConductorService } from '../services/agent-conductor-service.js';

const service = new AgentConductorService();

function authorized(request: FastifyRequest): boolean {
  if (!env.BRAD_AGENT_BRIDGE_TOKEN) return false;
  const header = request.headers.authorization;
  if (typeof header !== 'string') return false;
  const expected = Buffer.from(`Bearer ${env.BRAD_AGENT_BRIDGE_TOKEN}`);
  const provided = Buffer.from(header);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

const receiptSchema = z.object({
  status: z.enum(['PUBLISHED', 'FAILED', 'RECONCILE_REQUIRED']),
  externalEventId: z.string().optional(),
  error: z.string().max(1000).optional()
}).superRefine((value, context) => {
  if (value.status === 'PUBLISHED' && !value.externalEventId) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'published_receipt_requires_external_event_id' });
  }
});

const replySchema = z.object({
  jobId: z.string().uuid(),
  agentId: z.enum(['codex', 'claude']),
  buzzEventId: z.string().min(1),
  text: z.string().min(1).max(100_000),
  artifactRefs: z.array(z.record(z.unknown())).optional(),
  evidenceRefs: z.array(z.record(z.unknown())).optional(),
  sessionId: z.string().optional()
});

export async function agentBridgeRoutes(app: FastifyInstance): Promise<void> {
  app.get('/internal/agent/buzz-outbox', async (req, reply) => {
    if (!authorized(req)) return reply.status(401).send({ error: 'bridge_unauthorized' });
    return { ok: true, items: await service.claimBuzzOutbox(20) };
  });

  app.post('/internal/agent/buzz-outbox/:id/receipt', async (req, reply) => {
    if (!authorized(req)) return reply.status(401).send({ error: 'bridge_unauthorized' });
    const id = z.string().uuid().safeParse((req.params as { id?: string }).id);
    const body = receiptSchema.safeParse(req.body);
    if (!id.success || !body.success) return reply.status(400).send({ error: 'invalid_bridge_receipt' });
    const updated = await service.completeBuzzOutbox({ outboxId: id.data, ...body.data });
    return updated ? reply.send({ ok: true }) : reply.status(409).send({ error: 'outbox_receipt_rejected' });
  });

  app.get('/internal/agent/buzz-waiting-jobs', async (req, reply) => {
    if (!authorized(req)) return reply.status(401).send({ error: 'bridge_unauthorized' });
    return { ok: true, jobs: await service.listWaitingBuzzJobs() };
  });

  app.post('/internal/agent/buzz-replies', async (req, reply) => {
    if (!authorized(req)) return reply.status(401).send({ error: 'bridge_unauthorized' });
    const body = replySchema.safeParse(req.body);
    if (!body.success) return reply.status(400).send({ error: 'invalid_buzz_reply', details: body.error.flatten() });
    const result = await service.ingestDeferredAgentReply(body.data);
    return result ? reply.status(202).send({ ok: true, ...result }) : reply.status(409).send({ error: 'buzz_reply_rejected' });
  });
}
