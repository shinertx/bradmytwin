import { randomToken, sha256 } from '../utils/hash.js';
import { randomUUID } from 'node:crypto';
import { query } from './db.js';
import { redis } from './redis.js';

export interface ApprovalCreationInput {
  personId: string;
  actionType: string;
  payload: Record<string, unknown>;
}

export interface ApprovalRecord {
  id: string;
  person_id: string;
  action_type: string;
  payload_json: Record<string, unknown>;
  status: string;
  created_at: string;
}

export class ApprovalService {
  async create(input: ApprovalCreationInput): Promise<{ approvalId: string; approvalToken: string }> {
    const approvalId = randomUUID();
    const approvalToken = randomToken(24);
    const tokenHash = sha256(approvalToken);

    await query(
      `INSERT INTO approval_requests (
         id, person_id, action_type, payload_json, status, token_hash, expires_at
       ) VALUES ($1,$2,$3,$4,'PENDING',$5,now() + interval '30 minutes')`,
      [approvalId, input.personId, input.actionType, JSON.stringify(input.payload), tokenHash]
    );

    await redis.setex(`resume:approval:${approvalId}`, 60 * 60, JSON.stringify(input.payload));

    return { approvalId, approvalToken };
  }

  async decideByToken(token: string, decision: 'APPROVED' | 'REJECTED'): Promise<ApprovalRecord | null> {
    const tokenHash = sha256(token);
    const rows = await query<ApprovalRecord>(
      `UPDATE approval_requests
       SET status = $2, decided_at = now(), updated_at = now()
       WHERE token_hash = $1 AND status = 'PENDING' AND expires_at > now()
       RETURNING id, person_id, action_type, payload_json, status, created_at`,
      [tokenHash, decision]
    );

    return rows[0] ?? null;
  }

  async listPendingByPerson(personId: string): Promise<ApprovalRecord[]> {
    return await query<ApprovalRecord>(
      `SELECT id, person_id, action_type, payload_json, status, created_at
       FROM approval_requests
       WHERE person_id = $1 AND status = 'PENDING'
       ORDER BY created_at DESC`,
      [personId]
    );
  }
}
