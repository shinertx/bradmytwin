import { randomToken, sha256 } from '../utils/hash.js';
import { randomUUID } from 'node:crypto';
import { query } from './db.js';
import { redis } from './redis.js';

export interface ApprovalCreationInput {
  personId: string;
  actionType: string;
  payload: Record<string, unknown>;
  toolName: string;
  toolCallId: string;
  toolInput: Record<string, unknown>;
  openclawSessionId: string;
  openclawResponseId: string;
  originChannel: string;
  originExternalUserKey: string;
  idempotencyKey: string;
}

export interface ApprovalRecord {
  id: string;
  person_id: string;
  action_type: string;
  tool_name: string | null;
  tool_input_json: Record<string, unknown> | null;
  origin_channel: string | null;
  status: string;
  status_detail: string | null;
  payload_json: Record<string, unknown>;
  created_at: string;
}

export class ApprovalService {
  async create(input: ApprovalCreationInput): Promise<{ approvalId: string; approvalToken: string }> {
    const approvalId = randomUUID();
    const approvalToken = randomToken(24);
    const tokenHash = sha256(approvalToken);

    await query(
      `INSERT INTO approval_requests (
         id, person_id, action_type, payload_json, status, token_hash, expires_at,
         tool_name, tool_call_id, tool_input_json, openclaw_session_id, openclaw_response_id,
         origin_channel, origin_external_user_key, idempotency_key, status_detail
       ) VALUES ($1,$2,$3,$4,'PENDING',$5,now() + interval '30 minutes',$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
      [
        approvalId,
        input.personId,
        input.actionType,
        JSON.stringify(input.payload),
        tokenHash,
        input.toolName,
        input.toolCallId,
        JSON.stringify(input.toolInput),
        input.openclawSessionId,
        input.openclawResponseId,
        input.originChannel,
        input.originExternalUserKey,
        input.idempotencyKey,
        'awaiting_user_confirmation'
      ]
    );

    await redis.setex(
      `resume:approval:${approvalId}`,
      60 * 60,
      JSON.stringify({
        payload: input.payload,
        toolName: input.toolName,
        toolCallId: input.toolCallId,
        toolInput: input.toolInput,
        openclawSessionId: input.openclawSessionId,
        openclawResponseId: input.openclawResponseId,
        originChannel: input.originChannel,
        originExternalUserKey: input.originExternalUserKey
      })
    );

    return { approvalId, approvalToken };
  }

  async decideByToken(token: string, decision: 'APPROVED' | 'REJECTED'): Promise<ApprovalRecord | null> {
    const tokenHash = sha256(token);
    const rows = await query<ApprovalRecord>(
      `UPDATE approval_requests
       SET status = $2,
           decided_at = now(),
           updated_at = now(),
           status_detail = CASE WHEN $2 = 'APPROVED' THEN 'queued_for_execution' ELSE 'rejected_by_user' END
       WHERE token_hash = $1 AND status = 'PENDING' AND expires_at > now()
       RETURNING id, person_id, action_type, tool_name, tool_input_json, origin_channel, status, status_detail, payload_json, created_at`,
      [tokenHash, decision]
    );

    return rows[0] ?? null;
  }

  async listByPerson(personId: string): Promise<ApprovalRecord[]> {
    return await query<ApprovalRecord>(
      `SELECT id, person_id, action_type, tool_name, tool_input_json, origin_channel, status, status_detail, payload_json, created_at
       FROM approval_requests
       WHERE person_id = $1
       ORDER BY created_at DESC
       LIMIT 100`,
      [personId]
    );
  }

  async listPendingByPerson(personId: string): Promise<ApprovalRecord[]> {
    return await query<ApprovalRecord>(
      `SELECT id, person_id, action_type, tool_name, tool_input_json, origin_channel, status, status_detail, payload_json, created_at
       FROM approval_requests
       WHERE person_id = $1 AND status = 'PENDING'
       ORDER BY created_at DESC`,
      [personId]
    );
  }
}
