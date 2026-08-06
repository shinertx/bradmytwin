import { randomUUID } from 'node:crypto';
import { query } from './db.js';

export class ToolInvocationService {
  async log(input: {
    personId: string;
    messageId?: string;
    toolName: string;
    toolCallId?: string;
    input: Record<string, unknown>;
    output?: Record<string, unknown>;
    status: 'SUCCEEDED' | 'FAILED' | 'PENDING_APPROVAL';
    retryCount?: number;
    latencyMs?: number;
    errorCode?: string;
    approvalRequestId?: string;
  }): Promise<void> {
    await query(
      `INSERT INTO tool_invocations (
         id, person_id, message_id, tool_name, tool_call_id, input_json, output_json, status,
         retry_count, latency_ms, error_code, approval_request_id, attempts
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        randomUUID(),
        input.personId,
        input.messageId ?? null,
        input.toolName,
        input.toolCallId ?? null,
        JSON.stringify(input.input ?? {}),
        JSON.stringify(input.output ?? {}),
        input.status,
        input.retryCount ?? 0,
        input.latencyMs ?? null,
        input.errorCode ?? null,
        input.approvalRequestId ?? null,
        Math.max(1, (input.retryCount ?? 0) + 1)
      ]
    );
  }
}
