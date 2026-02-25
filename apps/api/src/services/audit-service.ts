import { randomUUID } from 'node:crypto';
import { query } from './db.js';

export class AuditService {
  async log(input: {
    personId: string;
    eventType: string;
    entityType: string;
    entityId: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await query(
      `INSERT INTO audit_logs (id, person_id, event_type, entity_type, entity_id, metadata_json)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [
        randomUUID(),
        input.personId,
        input.eventType,
        input.entityType,
        input.entityId,
        JSON.stringify(input.metadata ?? {})
      ]
    );
  }
}
