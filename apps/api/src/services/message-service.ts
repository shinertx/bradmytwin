import type { ChannelType } from '@brad/domain';
import { randomUUID } from 'node:crypto';
import { query } from './db.js';

export interface MessageRecord {
  id: string;
  personId: string;
  channel: ChannelType;
  direction: 'INBOUND' | 'OUTBOUND';
  body: string;
  createdAt: string;
}

interface MessageRow {
  id: string;
  person_id: string;
  channel: ChannelType;
  direction: 'INBOUND' | 'OUTBOUND';
  body: string;
  created_at: string;
}

function mapRow(row: MessageRow): MessageRecord {
  return {
    id: row.id,
    personId: row.person_id,
    channel: row.channel,
    direction: row.direction,
    body: row.body,
    createdAt: row.created_at
  };
}

export class MessageService {
  async insert(input: {
    personId: string;
    channel: ChannelType;
    threadId?: string;
    direction: 'INBOUND' | 'OUTBOUND';
    body: string;
    providerMessageId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<string> {
    const id = randomUUID();
    const threadId = input.threadId ?? (await this.ensureThread(input.personId, input.channel));

    await query(
      `INSERT INTO messages (
         id, person_id, channel, thread_id, direction, body, provider_msg_id, metadata_json
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [
        id,
        input.personId,
        input.channel,
        threadId,
        input.direction,
        input.body,
        input.providerMessageId ?? null,
        input.metadata ? JSON.stringify(input.metadata) : '{}'
      ]
    );

    return id;
  }

  async listByPerson(personId: string, limit = 100): Promise<MessageRecord[]> {
    const rows = await query<MessageRow>(
      `SELECT id, person_id, channel, direction, body, created_at
       FROM messages
       WHERE person_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [personId, limit]
    );
    return rows.map(mapRow).reverse();
  }

  private async ensureThread(personId: string, channel: ChannelType): Promise<string> {
    const rows = await query<{ id: string }>(
      `SELECT id FROM threads WHERE person_id = $1 AND status = 'ACTIVE'
       ORDER BY updated_at DESC LIMIT 1`,
      [personId]
    );

    if (rows[0]) {
      return rows[0].id;
    }

    const id = randomUUID();
    await query(
      `INSERT INTO threads (id, person_id, primary_channel, status)
       VALUES ($1, $2, $3, 'ACTIVE')`,
      [id, personId, channel]
    );
    return id;
  }
}
