import dotenv from 'dotenv';
import { z } from 'zod';
import { Pool } from 'pg';
import { MetaWhatsAppClient, TelegramClient, TwilioClient } from '@brad/clients';

dotenv.config();

const env = z
  .object({
    DATABASE_URL: z.string().default('postgres://postgres:postgres@postgres:5432/brad'),
    REDIS_URL: z.string().default('redis://redis:6379'),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_SMS_FROM: z.string().optional(),
    TWILIO_WHATSAPP_FROM: z.string().optional(),
    META_WHATSAPP_ACCESS_TOKEN: z.string().optional(),
    META_WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    META_GRAPH_API_VERSION: z.string().default('v22.0'),
    META_APP_SECRET: z.string().optional(),
    TELEGRAM_BOT_TOKEN: z.string().optional()
  })
  .parse(process.env);

const pool = new Pool({ connectionString: env.DATABASE_URL });
const twilio = new TwilioClient(
  env.TWILIO_ACCOUNT_SID,
  env.TWILIO_AUTH_TOKEN,
  env.TWILIO_SMS_FROM,
  env.TWILIO_WHATSAPP_FROM
);
const metaWhatsApp = new MetaWhatsAppClient(
  env.META_WHATSAPP_ACCESS_TOKEN,
  env.META_WHATSAPP_PHONE_NUMBER_ID,
  env.META_GRAPH_API_VERSION,
  env.META_APP_SECRET
);
const telegram = new TelegramClient(env.TELEGRAM_BOT_TOKEN, undefined);

interface ApprovalRow {
  id: string;
  person_id: string;
  action_type: string;
  payload_json: {
    channel?: 'SMS' | 'WHATSAPP' | 'TELEGRAM' | 'WEB';
    externalUserKey?: string;
  };
}

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

async function sendCompletion(row: ApprovalRow): Promise<void> {
  const channel = row.payload_json.channel;
  const key = row.payload_json.externalUserKey;
  const text = `Approved action ${row.action_type} was executed.`;

  if (!channel || !key) {
    return;
  }

  if (channel === 'SMS') {
    await twilio.sendSms(key, text);
  } else if (channel === 'WHATSAPP') {
    if (metaWhatsApp.isConfigured()) {
      await metaWhatsApp.sendTextMessage(key.replace(/\D/g, ''), text);
    } else {
      await twilio.sendWhatsApp(key, text);
    }
  } else if (channel === 'TELEGRAM') {
    await telegram.sendMessage(key, text);
  }
}

async function processApprovals(): Promise<void> {
  const approvals = await query<ApprovalRow>(
    `SELECT id, person_id, action_type, payload_json
     FROM approval_requests
     WHERE status = 'APPROVED'
     ORDER BY decided_at ASC
     LIMIT 50`
  );

  for (const row of approvals) {
    try {
      await sendCompletion(row);

      await query(
        `UPDATE approval_requests
         SET status = 'EXECUTED', executed_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'APPROVED'`,
        [row.id]
      );

      await query(
        `INSERT INTO audit_logs (id, person_id, event_type, entity_type, entity_id, metadata_json)
         VALUES ($1,$2,'APPROVAL_EXECUTED','approval_request',$3,$4)`,
        [crypto.randomUUID(), row.person_id, row.id, JSON.stringify({ actionType: row.action_type })]
      );
    } catch (error) {
      console.error('approval_process_failed', { approvalId: row.id, error });
    }
  }
}

async function main(): Promise<void> {
  console.log('worker_started');
  setInterval(async () => {
    await processApprovals();
  }, 3000);
}

main().catch((error) => {
  console.error('worker_fatal', error);
  process.exit(1);
});
