import type { FastifyInstance } from 'fastify';
import { ApprovalService } from '../services/approval-service.js';
import { query } from '../services/db.js';

const approvalService = new ApprovalService();

export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  app.post('/approvals/:token/confirm', async (req, reply) => {
    const params = req.params as { token: string };
    const decided = await approvalService.decideByToken(params.token, 'APPROVED');
    if (!decided) {
      return reply.status(404).send({ error: 'approval_not_found_or_expired' });
    }

    await query('UPDATE approval_requests SET status = $2, updated_at = now() WHERE id = $1', [
      decided.id,
      'APPROVED'
    ]);

    return reply.send({ ok: true, approvalId: decided.id });
  });

  app.post('/approvals/:token/reject', async (req, reply) => {
    const params = req.params as { token: string };
    const decided = await approvalService.decideByToken(params.token, 'REJECTED');
    if (!decided) {
      return reply.status(404).send({ error: 'approval_not_found_or_expired' });
    }

    return reply.send({ ok: true, approvalId: decided.id });
  });

  app.get('/approvals', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = req.user as { personId: string };
    const approvals = await approvalService.listPendingByPerson(user.personId);
    return reply.send({ approvals });
  });
}
