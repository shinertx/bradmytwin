import type { Pool } from 'pg';

interface TelegramOutboxRow {
  id: string;
  person_id: string;
  payload_json: { body?: string };
}

export interface TelegramReceiptSender {
  sendMessageWithReceipt(chatId: string, text: string): Promise<{ messageId: string }>;
}

export async function reconcileStaleTelegramClaims(pool: Pool): Promise<number> {
  const result = await pool.query(
    `UPDATE brad_agent_outbox
     SET status = 'RECONCILE_REQUIRED', last_error = 'ambiguous_stale_telegram_claim', updated_at = now()
     WHERE destination = 'TELEGRAM_BRIEF' AND status = 'PUBLISHING'
       AND updated_at < now() - interval '2 minutes'
     RETURNING id`
  );
  return result.rowCount ?? 0;
}

export async function publishTelegramBriefs(
  pool: Pool,
  sender: TelegramReceiptSender,
  limit = 20
): Promise<number> {
  const client = await pool.connect();
  let rows: TelegramOutboxRow[] = [];
  try {
    await client.query('BEGIN');
    const selected = await client.query<TelegramOutboxRow>(
      `WITH picked AS (
         SELECT id FROM brad_agent_outbox
         WHERE destination = 'TELEGRAM_BRIEF' AND status IN ('PENDING','FAILED')
           AND next_attempt_at <= now() AND attempt_count < 5
         ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1
       )
       UPDATE brad_agent_outbox o
       SET status = 'PUBLISHING', attempt_count = attempt_count + 1, updated_at = now()
       FROM picked WHERE o.id = picked.id
       RETURNING o.id, o.person_id, o.payload_json`,
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
    const identity = await pool.query<{ external_user_key: string }>(
      `SELECT external_user_key FROM channel_identities
       WHERE person_id = $1 AND channel = 'TELEGRAM'
       ORDER BY updated_at DESC LIMIT 1`,
      [row.person_id]
    );
    const chatId = identity.rows[0]?.external_user_key;
    const body = row.payload_json.body;
    if (!chatId || !body) {
      await pool.query(
        `UPDATE brad_agent_outbox
         SET status = 'RECONCILE_REQUIRED', last_error = 'telegram_identity_or_body_missing', updated_at = now()
         WHERE id = $1 AND status = 'PUBLISHING'`,
        [row.id]
      );
      continue;
    }

    try {
      const receipt = await sender.sendMessageWithReceipt(chatId, body);
      await pool.query(
        `UPDATE brad_agent_outbox
         SET status = 'PUBLISHED', external_event_id = $2,
             published_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'PUBLISHING'`,
        [row.id, receipt.messageId]
      );
      published += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'telegram_publish_failed';
      const definitelyRejected = message.startsWith('telegram_send_failed:') || message === 'telegram_bot_not_configured';
      await pool.query(
        `UPDATE brad_agent_outbox
         SET status = $2, last_error = $3,
             next_attempt_at = CASE WHEN $2 = 'FAILED' THEN now() + interval '30 seconds' ELSE next_attempt_at END,
             updated_at = now()
         WHERE id = $1 AND status = 'PUBLISHING'`,
        [row.id, definitelyRejected ? 'FAILED' : 'RECONCILE_REQUIRED', message.slice(0, 1000)]
      );
    }
  }
  return published;
}
