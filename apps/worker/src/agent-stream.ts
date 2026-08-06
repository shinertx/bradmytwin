import { Redis } from 'ioredis';
import type { Pool } from 'pg';

interface RedisOutboxRow {
  id: string;
  thread_id: string;
  event_type: string;
  payload_json: Record<string, unknown>;
}

export interface AgentStreamConfig {
  streamKey: string;
  groupName: string;
  consumerName: string;
}

export function createAgentRedis(url: string): Redis {
  const redis = new Redis(url, {
    enableReadyCheck: true,
    maxRetriesPerRequest: null,
    retryStrategy: (attempt) => Math.min(5_000, 250 * 2 ** Math.min(attempt, 5))
  });
  redis.on('error', (error) => console.error('agent_stream_redis_error', error.message));
  return redis;
}

export async function publishPendingAgentEvents(
  pool: Pool,
  redis: Redis,
  streamKey: string,
  limit = 50
): Promise<number> {
  const client = await pool.connect();
  let rows: RedisOutboxRow[] = [];
  try {
    await client.query('BEGIN');
    const selected = await client.query<RedisOutboxRow>(
      `WITH picked AS (
         SELECT id FROM brad_agent_outbox
         WHERE destination = 'REDIS' AND status IN ('PENDING','FAILED')
           AND next_attempt_at <= now() AND attempt_count < 20
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE brad_agent_outbox o
       SET status = 'PUBLISHING', attempt_count = attempt_count + 1, updated_at = now()
       FROM picked WHERE o.id = picked.id
       RETURNING o.id, o.thread_id, o.event_type, o.payload_json`,
      [limit]
    );
    rows = selected.rows;
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }

  let published = 0;
  for (const row of rows) {
    try {
      const streamId = await redis.xadd(
        streamKey,
        'MAXLEN', '~', '10000', '*',
        'outbox_id', row.id,
        'thread_id', row.thread_id,
        'event_type', row.event_type,
        'payload', JSON.stringify(row.payload_json)
      );
      if (!streamId) throw new Error('redis_xadd_missing_stream_id');
      const updated = await pool.query(
        `UPDATE brad_agent_outbox
         SET status = 'PUBLISHED', external_event_id = $2, published_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'PUBLISHING'`,
        [row.id, streamId]
      );
      if ((updated.rowCount ?? 0) !== 1) throw new Error('redis_outbox_receipt_rejected');
      published += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'redis_publish_failed';
      await pool.query(
        `UPDATE brad_agent_outbox
         SET status = 'FAILED', last_error = $2,
             next_attempt_at = now() + interval '5 seconds', updated_at = now()
         WHERE id = $1 AND status = 'PUBLISHING'`,
        [row.id, message.slice(0, 1000)]
      );
    }
  }
  return published;
}

export async function reconcileStaleAgentOutbox(pool: Pool): Promise<number> {
  const result = await pool.query(
    `UPDATE brad_agent_outbox
     SET status = 'FAILED', last_error = 'stale_publish_claim',
         next_attempt_at = now(), updated_at = now()
     WHERE destination = 'REDIS' AND status = 'PUBLISHING'
       AND updated_at < now() - interval '2 minutes'
     RETURNING id`
  );
  return result.rowCount ?? 0;
}

export async function ensureAgentConsumerGroup(redis: Redis, config: AgentStreamConfig): Promise<void> {
  try {
    await redis.xgroup('CREATE', config.streamKey, config.groupName, '0', 'MKSTREAM');
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('BUSYGROUP')) throw error;
  }
}

export async function waitForAgentEvents(
  redis: Redis,
  config: AgentStreamConfig,
  blockMs = 5_000
): Promise<string[]> {
  const result = await redis.xreadgroup(
    'GROUP', config.groupName, config.consumerName,
    'COUNT', 50,
    'BLOCK', blockMs,
    'STREAMS', config.streamKey, '>'
  ) as Array<[string, Array<[string, string[]]>]> | null;
  if (!result) return [];
  return result.flatMap(([, events]) => events.map(([id]) => id));
}

export async function acknowledgeAgentEvents(
  redis: Redis,
  config: AgentStreamConfig,
  eventIds: string[]
): Promise<void> {
  if (eventIds.length > 0) await redis.xack(config.streamKey, config.groupName, ...eventIds);
}
