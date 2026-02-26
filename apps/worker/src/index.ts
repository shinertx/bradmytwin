import dotenv from 'dotenv';
import { z } from 'zod';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { MetaWhatsAppClient, TelegramClient, TwilioClient, KmsEnvelope, type CipherBundle } from '@brad/clients';

dotenv.config();

const env = z
  .object({
    DATABASE_URL: z.string().default('postgres://postgres:postgres@postgres:5432/brad'),
    TWILIO_ACCOUNT_SID: z.string().optional(),
    TWILIO_AUTH_TOKEN: z.string().optional(),
    TWILIO_SMS_FROM: z.string().optional(),
    TWILIO_WHATSAPP_FROM: z.string().optional(),
    META_WHATSAPP_ACCESS_TOKEN: z.string().optional(),
    META_WHATSAPP_PHONE_NUMBER_ID: z.string().optional(),
    META_GRAPH_API_VERSION: z.string().default('v22.0'),
    META_APP_SECRET: z.string().optional(),
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    OPENCLAW_URL: z.string().optional(),
    OPENCLAW_API_KEY: z.string().optional(),
    OPENCLAW_MODEL_DEFAULT: z.string().default('gpt-4.1'),
    GOOGLE_CLIENT_ID: z.string().optional(),
    GOOGLE_CLIENT_SECRET: z.string().optional(),
    KMS_KEY_NAME: z.string().optional(),
    BROWSER_ALLOWLIST: z.string().default('example.com')
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
const kms = new KmsEnvelope(env.KMS_KEY_NAME);

interface ApprovalRow {
  id: string;
  person_id: string;
  action_type: string;
  tool_name: string | null;
  tool_call_id: string | null;
  tool_input_json: Record<string, unknown> | null;
  openclaw_session_id: string | null;
  openclaw_response_id: string | null;
  payload_json: Record<string, unknown>;
  origin_channel: 'SMS' | 'WHATSAPP' | 'TELEGRAM' | 'WEB' | null;
  origin_external_user_key: string | null;
}

interface ConnectorRow {
  id: string;
  token_ciphertext: unknown;
  refresh_ciphertext: unknown;
  expires_at: string | null;
}

async function query<T>(sql: string, params: unknown[] = []): Promise<T[]> {
  const res = await pool.query(sql, params);
  return res.rows as T[];
}

function parseCipherBundle(value: unknown): CipherBundle | null {
  if (!value) return null;

  let candidate: unknown = value;
  if (typeof candidate === 'string') {
    try {
      candidate = JSON.parse(candidate) as unknown;
    } catch {
      return null;
    }
  }

  if (!candidate || typeof candidate !== 'object') {
    return null;
  }

  const typed = candidate as Record<string, unknown>;
  if (
    typeof typed.wrappedDek !== 'string' ||
    typeof typed.iv !== 'string' ||
    typeof typed.authTag !== 'string' ||
    typeof typed.ciphertext !== 'string'
  ) {
    return null;
  }

  return {
    wrappedDek: typed.wrappedDek,
    iv: typed.iv,
    authTag: typed.authTag,
    ciphertext: typed.ciphertext
  };
}

async function decryptOptional(value: unknown): Promise<string | null> {
  const parsed = parseCipherBundle(value);
  if (!parsed) return null;
  return await kms.decrypt(parsed);
}

async function getGoogleAccessToken(personId: string, scope: 'calendar' | 'email'): Promise<string> {
  const rows = await query<ConnectorRow>(
    `SELECT id, token_ciphertext, refresh_ciphertext, expires_at
     FROM connectors
     WHERE person_id = $1 AND provider = 'google' AND scope = $2 AND status = 'CONNECTED'
     LIMIT 1`,
    [personId, scope]
  );

  const row = rows[0];
  if (!row) {
    throw new Error(`connector_missing:${scope}`);
  }

  const accessToken = await decryptOptional(row.token_ciphertext);
  if (!accessToken) {
    throw new Error('connector_access_token_missing');
  }

  const expiresAtMs = row.expires_at ? new Date(row.expires_at).getTime() : 0;
  if (expiresAtMs > Date.now() + 60_000) {
    return accessToken;
  }

  const refreshToken = await decryptOptional(row.refresh_ciphertext);
  if (!refreshToken) {
    return accessToken;
  }

  if (!env.GOOGLE_CLIENT_ID || !env.GOOGLE_CLIENT_SECRET) {
    throw new Error('google_oauth_not_configured');
  }

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID,
    client_secret: env.GOOGLE_CLIENT_SECRET,
    refresh_token: refreshToken,
    grant_type: 'refresh_token'
  });

  const refreshRes = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params
  });

  if (!refreshRes.ok) {
    const body = await refreshRes.text();
    throw new Error(`google_token_refresh_failed:${refreshRes.status}:${body}`);
  }

  const refreshed = (await refreshRes.json()) as { access_token: string; expires_in: number };
  const encryptedAccess = await kms.encrypt(refreshed.access_token);

  await query(
    `UPDATE connectors
     SET token_ciphertext = $2,
         expires_at = now() + ($3 || ' seconds')::interval,
         updated_at = now()
     WHERE id = $1`,
    [row.id, JSON.stringify(encryptedAccess), String(refreshed.expires_in)]
  );

  return refreshed.access_token;
}

function buildRawEmail(to: string, subject: string, body: string): string {
  const mime = [
    `To: ${to}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'MIME-Version: 1.0',
    `Subject: ${subject}`,
    '',
    body
  ].join('\r\n');

  return Buffer.from(mime)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function isAllowlisted(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    const allowlist = env.BROWSER_ALLOWLIST.split(',').map((s) => s.trim()).filter(Boolean);
    return allowlist.some((allowed) => url.hostname === allowed || url.hostname.endsWith(`.${allowed}`));
  } catch {
    return false;
  }
}

async function executeWriteTool(row: ApprovalRow): Promise<Record<string, unknown>> {
  const name = row.tool_name ?? '';
  const args = row.tool_input_json ?? {};

  if (name === 'calendar.create_event') {
    const token = await getGoogleAccessToken(row.person_id, 'calendar');
    const res = await fetch('https://www.googleapis.com/calendar/v3/calendars/primary/events', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        summary: args.summary,
        description: args.description,
        location: args.location,
        start: { dateTime: args.start, timeZone: args.timezone ?? 'UTC' },
        end: { dateTime: args.end, timeZone: args.timezone ?? 'UTC' }
      })
    });

    if (!res.ok) {
      throw new Error(`calendar_create_failed:${res.status}:${await res.text()}`);
    }

    return (await res.json()) as Record<string, unknown>;
  }

  if (name === 'calendar.update_event') {
    const token = await getGoogleAccessToken(row.person_id, 'calendar');
    const eventId = String(args.eventId || '');
    const patch: Record<string, unknown> = {};
    if (args.summary) patch.summary = args.summary;
    if (args.description) patch.description = args.description;
    if (args.location) patch.location = args.location;
    if (args.start) patch.start = { dateTime: args.start, timeZone: args.timezone ?? 'UTC' };
    if (args.end) patch.end = { dateTime: args.end, timeZone: args.timezone ?? 'UTC' };

    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
      method: 'PATCH',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(patch)
    });

    if (!res.ok) {
      throw new Error(`calendar_update_failed:${res.status}:${await res.text()}`);
    }

    return (await res.json()) as Record<string, unknown>;
  }

  if (name === 'calendar.delete_event') {
    const token = await getGoogleAccessToken(row.person_id, 'calendar');
    const eventId = String(args.eventId || '');
    const res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` }
    });

    if (!res.ok && res.status !== 404) {
      throw new Error(`calendar_delete_failed:${res.status}:${await res.text()}`);
    }

    return { ok: true };
  }

  if (name === 'gmail.send_message' || name === 'gmail.draft_reply') {
    const token = await getGoogleAccessToken(row.person_id, 'email');
    const endpoint = name === 'gmail.send_message' ? 'messages/send' : 'drafts';
    const raw = buildRawEmail(String(args.to), String(args.subject), String(args.body));
    const payload = name === 'gmail.send_message'
      ? { raw, ...(args.threadId ? { threadId: args.threadId } : {}) }
      : { message: { raw, ...(args.threadId ? { threadId: args.threadId } : {}) } };

    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/${endpoint}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payload)
    });

    if (!res.ok) {
      throw new Error(`gmail_write_failed:${res.status}:${await res.text()}`);
    }

    return (await res.json()) as Record<string, unknown>;
  }

  if (name === 'gmail.archive_thread') {
    const token = await getGoogleAccessToken(row.person_id, 'email');
    const threadId = String(args.threadId || '');
    const res = await fetch(`https://gmail.googleapis.com/gmail/v1/users/me/threads/${encodeURIComponent(threadId)}/modify`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ removeLabelIds: ['INBOX'] })
    });

    if (!res.ok) {
      throw new Error(`gmail_archive_failed:${res.status}:${await res.text()}`);
    }

    return (await res.json()) as Record<string, unknown>;
  }

  if (name === 'browser.fill_form' || name === 'browser.submit_form') {
    const url = String(args.url || '');
    if (!isAllowlisted(url)) {
      throw new Error('browser_domain_not_allowlisted');
    }
    return { ok: true, status: 'accepted', url };
  }

  if (name === 'profile.set_preferences') {
    await query(
      `UPDATE persons
       SET timezone = COALESCE($2, timezone),
           email_signature_style = COALESCE($3, email_signature_style),
           updated_at = now()
       WHERE id = $1`,
      [
        row.person_id,
        typeof args.timezone === 'string' ? args.timezone : null,
        typeof args.emailSignatureStyle === 'string' ? args.emailSignatureStyle : null
      ]
    );
    return { ok: true };
  }

  if (name === 'reminder.create') {
    const rows = await query<{ id: string }>(
      `INSERT INTO reminders (person_id, title, due_at)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [row.person_id, String(args.title || 'Reminder'), args.dueAt ? String(args.dueAt) : null]
    );
    return { reminderId: rows[0]?.id };
  }

  if (name === 'reminder.cancel') {
    await query(
      `UPDATE reminders
       SET status = 'CANCELLED', updated_at = now()
       WHERE person_id = $1 AND id = $2`,
      [row.person_id, String(args.reminderId || '')]
    );
    return { cancelled: true };
  }

  if (name === 'tasks.create') {
    const rows = await query<{ id: string }>(
      `INSERT INTO tasks (person_id, title, due_at)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [row.person_id, String(args.title || 'Task'), args.dueAt ? String(args.dueAt) : null]
    );
    return { taskId: rows[0]?.id };
  }

  return {
    ok: false,
    skipped: true,
    message: `No write executor for ${name}.`
  };
}

function extractAssistantText(body: unknown): string {
  if (!body || typeof body !== 'object') return '';
  const obj = body as Record<string, unknown>;

  if (typeof obj.output_text === 'string' && obj.output_text.trim()) {
    return obj.output_text.trim();
  }

  const output = Array.isArray(obj.output) ? obj.output : [];
  const chunks: string[] = [];

  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const typed = item as Record<string, unknown>;
    if (typed.type === 'message' && Array.isArray(typed.content)) {
      for (const content of typed.content) {
        if (content && typeof content === 'object') {
          const c = content as Record<string, unknown>;
          if (typeof c.text === 'string') chunks.push(c.text);
          const nested = c.text as Record<string, unknown> | undefined;
          if (nested && typeof nested.value === 'string') chunks.push(nested.value);
        }
      }
    }
  }

  return chunks.join('\n').trim();
}

async function continueOpenClaw(row: ApprovalRow, toolResult: Record<string, unknown>): Promise<string> {
  if (!env.OPENCLAW_URL || !row.openclaw_session_id || !row.tool_call_id) {
    return `Approved action ${row.action_type} was executed.`;
  }

  const payload: Record<string, unknown> = {
    model: (row.payload_json.model as string | undefined) ?? env.OPENCLAW_MODEL_DEFAULT,
    input: [
      {
        type: 'function_call_output',
        call_id: row.tool_call_id,
        output: JSON.stringify({ ok: true, result: toolResult })
      }
    ],
    metadata: {
      run_id: row.payload_json.runId ?? row.id,
      approval_id: row.id
    }
  };

  if (row.openclaw_response_id) {
    payload.previous_response_id = row.openclaw_response_id;
  }

  const res = await fetch(`${env.OPENCLAW_URL}/v1/responses`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(env.OPENCLAW_API_KEY ? { Authorization: `Bearer ${env.OPENCLAW_API_KEY}` } : {}),
      'x-openclaw-session-key': row.openclaw_session_id
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    const body = await res.text();
    return `Approved action ${row.action_type} executed, but continuation failed: ${body.slice(0, 120)}`;
  }

  const data = (await res.json()) as unknown;
  const assistant = extractAssistantText(data);
  return assistant || `Approved action ${row.action_type} was executed.`;
}

async function sendCompletion(row: ApprovalRow, text: string): Promise<void> {
  const channel = row.origin_channel;
  const key = row.origin_external_user_key;

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

async function claimApprovals(limit = 20): Promise<ApprovalRow[]> {
  return await query<ApprovalRow>(
    `WITH picked AS (
       SELECT id
       FROM approval_requests
       WHERE status = 'APPROVED'
         AND (status_detail = 'queued_for_execution' OR status_detail IS NULL)
       ORDER BY decided_at ASC
       LIMIT $1
     )
     UPDATE approval_requests ar
     SET status_detail = 'processing',
         updated_at = now()
     FROM picked
     WHERE ar.id = picked.id
     RETURNING ar.id, ar.person_id, ar.action_type, ar.tool_name, ar.tool_call_id, ar.tool_input_json,
               ar.openclaw_session_id, ar.openclaw_response_id, ar.payload_json, ar.origin_channel, ar.origin_external_user_key`,
    [limit]
  );
}

async function processApprovals(): Promise<void> {
  const approvals = await claimApprovals(20);

  for (const row of approvals) {
    try {
      const result = await executeWriteTool(row);
      const assistantText = await continueOpenClaw(row, result);
      await sendCompletion(row, assistantText);

      await query(
        `UPDATE approval_requests
         SET status = 'EXECUTED', status_detail = 'executed', executed_at = now(), updated_at = now()
         WHERE id = $1 AND status = 'APPROVED'`,
        [row.id]
      );

      await query(
        `INSERT INTO audit_logs (id, person_id, event_type, entity_type, entity_id, metadata_json)
         VALUES ($1,$2,'APPROVAL_EXECUTED','approval_request',$3,$4)`,
        [randomUUID(), row.person_id, row.id, JSON.stringify({ actionType: row.action_type, toolName: row.tool_name })]
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_error';

      await query(
        `UPDATE approval_requests
         SET status = 'FAILED', status_detail = $2, updated_at = now()
         WHERE id = $1`,
        [row.id, message.slice(0, 500)]
      );

      await query(
        `INSERT INTO audit_logs (id, person_id, event_type, entity_type, entity_id, metadata_json)
         VALUES ($1,$2,'APPROVAL_FAILED','approval_request',$3,$4)`,
        [randomUUID(), row.person_id, row.id, JSON.stringify({ error: message })]
      );

      console.error('approval_process_failed', { approvalId: row.id, error: message });
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
