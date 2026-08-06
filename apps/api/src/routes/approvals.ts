import type { FastifyInstance } from 'fastify';
import { ApprovalService } from '../services/approval-service.js';

const approvalService = new ApprovalService();

export async function approvalRoutes(app: FastifyInstance): Promise<void> {
  app.post('/approvals/:token/confirm', async (req, reply) => {
    const params = req.params as { token: string };
    const decided = await approvalService.decideByToken(params.token, 'APPROVED');
    if (!decided) {
      return reply.status(404).send({ error: 'approval_not_found_or_expired' });
    }

    return reply.send({ ok: true, approvalId: decided.id, executionState: 'QUEUED' as const });
  });

  app.post('/approvals/:token/reject', async (req, reply) => {
    const params = req.params as { token: string };
    const decided = await approvalService.decideByToken(params.token, 'REJECTED');
    if (!decided) {
      return reply.status(404).send({ error: 'approval_not_found_or_expired' });
    }

    return reply.send({ ok: true, approvalId: decided.id, executionState: 'FAILED' as const });
  });

  app.get('/approvals', { preHandler: [app.authenticate] }, async (req, reply) => {
    const user = req.user as { personId: string };
    const approvals = await approvalService.listByPerson(user.personId);
    return reply.send({
      approvals: approvals.map((approval) => ({
        id: approval.id,
        person_id: approval.person_id,
        action_type: approval.action_type,
        status: approval.status,
        status_detail: approval.status_detail,
        tool_name: approval.tool_name,
        tool_input_preview: approval.tool_input_json,
        origin_channel: approval.origin_channel,
        payload_json: approval.payload_json,
        created_at: approval.created_at
      }))
    });
  });
}
