import dotenv from 'dotenv';
import { z } from 'zod';
import { Pool } from 'pg';
import { randomUUID } from 'node:crypto';
import { MetaWhatsAppClient, TelegramClient, TwilioClient, KmsEnvelope, type CipherBundle } from '@brad/clients';
import { builtInRunnerRegistry } from './agent-runners.js';
import { processOneAgentJob, reconcileExpiredAgentLeases } from './conductor.js';
import { ProcessHermesRunner } from './hermes-runner.js';
import { digestPayload } from './digest.js';
import {
  acknowledgeAgentEvents,
  createAgentRedis,
  ensureAgentConsumerGroup,
  publishPendingAgentEvents,
  reconcileStaleAgentOutbox,
  waitForAgentEvents,
  type AgentStreamConfig
} from './agent-stream.js';
import { publishTelegramBriefs, reconcileStaleTelegramClaims } from './telegram-outbox.js';

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
    TELEGRAM_BOT_TOKEN: z.string().optional(),
    OPENCLAW_URL: z.string().optional(),
    OPENCLAW_API_KEY: z.string().optional(),
    OPENCLAW_MODEL_DEFAULT: z.string().default('gpt-4.1'),
    OPENCLAW_MODE: z.enum(['stub', 'http', 'cli']).default('http'),
    OPENCLAW_CLI_BIN: z.string().default('openclaw'),
    OPENCLAW_CLI_AGENT_ID: z.string().optional(),
    OPENCLAW_CLI_TIMEOUT_MS: z.coerce.number().default(90000),
    BRAD_CONDUCTOR_MODE: z.enum(['off', 'shadow', 'active']).default('shadow'),
    BRAD_AGENT_WORKER_IDENTITY: z.string().default('brad-worker'),
    BRAD_AGENT_LEASE_SECONDS: z.coerce.number().int().positive().default(300),
    BRAD_AGENT_WORKFLOW_VERSION: z.string().default('brad-conductor-v1'),
    BRAD_AGENT_STREAM_KEY: z.string().default('brad:agent:jobs'),
    BRAD_AGENT_STREAM_GROUP: z.string().default('brad-agent-workers'),
    HERMES_RUNNER_PATH: z.string().optional(),
    HERMES_OUTPUT_ROOT: z.string().default('/home/benjijmac/.hermes/brad-agent-runs'),
    HERMES_RUNNER_TIMEOUT_MS: z.coerce.number().int().positive().default(900000),
    HERMES_PROVIDER: z.string().default('openai-codex'),
    HERMES_MODEL: z.string().default('gpt-5.4-mini'),
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
const hermesRunner = env.HERMES_RUNNER_PATH
  ? new ProcessHermesRunner({
      runnerPath: env.HERMES_RUNNER_PATH,
      outputRoot: env.HERMES_OUTPUT_ROOT,
      timeoutMs: env.HERMES_RUNNER_TIMEOUT_MS,
      provider: env.HERMES_PROVIDER,
      model: env.HERMES_MODEL
    })
  : undefined;
const agentRunners = builtInRunnerRegistry({
  openclaw: {
    baseUrl: env.OPENCLAW_URL,
    apiKey: env.OPENCLAW_API_KEY,
    mode: env.OPENCLAW_MODE,
    cliBin: env.OPENCLAW_CLI_BIN,
    cliAgentId: env.OPENCLAW_CLI_AGENT_ID,
    timeoutMs: env.OPENCLAW_CLI_TIMEOUT_MS,
    model: env.OPENCLAW_MODEL_DEFAULT
  },
  hermes: hermesRunner ? { runner: hermesRunner, artifactRoot: env.HERMES_OUTPUT_ROOT } : undefined
});

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
  objective_id: string | null;
  payload_digest: string | null;
  contract_version: number | null;
  attempt_id?: string;
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
               ar.openclaw_session_id, ar.openclaw_response_id, ar.payload_json, ar.origin_channel,
               ar.origin_external_user_key, ar.objective_id, ar.payload_digest, ar.contract_version`,
    [limit]
  );
}

async function beginApprovalAttempt(row: ApprovalRow): Promise<string> {
  const verifiedDigest = digestPayload({
    actionType: row.action_type,
    payload: row.payload_json,
    toolName: row.tool_name,
    toolInput: row.tool_input_json
  });
  if (!row.payload_digest || verifiedDigest !== row.payload_digest) {
    throw new Error('approval_payload_digest_mismatch');
  }
  const rows = await query<{ id: string }>(
    `WITH next_attempt AS (
       SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no
       FROM brad_approval_attempts WHERE approval_id = $1
     )
     INSERT INTO brad_approval_attempts (
       approval_id, attempt_no, request_digest, verified_digest, digest_match, status
     ) SELECT $1, attempt_no, $2, $3, true, 'started' FROM next_attempt
     RETURNING id`,
    [row.id, row.payload_digest, verifiedDigest]
  );
  return rows[0].id;
}

function providerEffectId(result: Record<string, unknown>): string | null {
  for (const key of ['id', 'sid', 'call_id', 'callId', 'messageId', 'eventId', 'taskId']) {
    const value = result[key];
    if (typeof value === 'string' || typeof value === 'number') return String(value);
  }
  return null;
}

async function quarantineStaleApprovalClaims(): Promise<void> {
  await query(
    `UPDATE approval_requests ar
     SET status_detail = 'reconcile_required', updated_at = now()
     WHERE ar.status = 'APPROVED' AND ar.status_detail = 'processing'
       AND EXISTS (
         SELECT 1 FROM brad_approval_attempts a
         WHERE a.approval_id = ar.id AND a.status = 'provider_submitted'
       )`
  );
  await query(
    `UPDATE approval_requests ar
     SET status_detail = 'queued_for_execution', updated_at = now()
     WHERE ar.status = 'APPROVED' AND ar.status_detail = 'processing'
       AND ar.updated_at < now() - interval '10 minutes'
       AND NOT EXISTS (SELECT 1 FROM brad_approval_attempts a WHERE a.approval_id = ar.id)`
  );
}

async function processApprovals(): Promise<void> {
  const approvals = await claimApprovals(20);

  for (const row of approvals) {
    let attemptId: string | null = null;
    try {
      attemptId = await beginApprovalAttempt(row);
      await query(
        `UPDATE brad_approval_attempts
         SET status = 'provider_submitted', provider_submitted_at = now()
         WHERE id = $1`,
        [attemptId]
      );
      const result = await executeWriteTool(row);
      const effectId = providerEffectId(result);
      await query(
        `UPDATE brad_approval_attempts
         SET status = 'succeeded', provider_effect_id = $2, finished_at = now()
         WHERE id = $1`,
        [attemptId, effectId]
      );
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

      if (attemptId) {
        await query(
          `UPDATE brad_approval_attempts
           SET status = 'unknown', error = $2, finished_at = now()
           WHERE id = $1 AND status = 'provider_submitted'`,
          [attemptId, message.slice(0, 500)]
        );
      }

      await query(
        `UPDATE approval_requests
         SET status = CASE WHEN $3::boolean THEN 'APPROVED' ELSE 'FAILED' END,
             status_detail = CASE WHEN $3::boolean THEN 'reconcile_required' ELSE $2 END,
             updated_at = now()
         WHERE id = $1`,
        [row.id, message.slice(0, 500), Boolean(attemptId)]
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

async function drainAgentJobs(): Promise<number> {
  let processed = 0;
  for (; processed < 50; processed++) {
    const found = await processOneAgentJob(pool, agentRunners, {
      workerIdentity: env.BRAD_AGENT_WORKER_IDENTITY,
      leaseSeconds: env.BRAD_AGENT_LEASE_SECONDS,
      workflowVersion: env.BRAD_AGENT_WORKFLOW_VERSION
    });
    if (!found) break;
  }
  return processed;
}

async function main(): Promise<void> {
  console.log('worker_started');
  setInterval(async () => {
    await processApprovals();
  }, 3000);
  setInterval(async () => {
    await quarantineStaleApprovalClaims();
  }, 60000);

  if (env.BRAD_CONDUCTOR_MODE === 'active') {
    const publisherRedis = createAgentRedis(env.REDIS_URL);
    const consumerRedis = createAgentRedis(env.REDIS_URL);
    const streamConfig: AgentStreamConfig = {
      streamKey: env.BRAD_AGENT_STREAM_KEY,
      groupName: env.BRAD_AGENT_STREAM_GROUP,
      consumerName: `${env.BRAD_AGENT_WORKER_IDENTITY}-${process.pid}`
    };
    let publishing = false;
    let shuttingDown = false;

    const publish = async (): Promise<void> => {
      if (publishing) return;
      publishing = true;
      try {
        await Promise.all([
          publishPendingAgentEvents(pool, publisherRedis, env.BRAD_AGENT_STREAM_KEY),
          publishTelegramBriefs(pool, telegram)
        ]);
      } catch (error) {
        console.error('agent_stream_publish_failed', error);
      } finally {
        publishing = false;
      }
    };

    await ensureAgentConsumerGroup(consumerRedis, streamConfig);
    await reconcileStaleAgentOutbox(pool);
    await publish();
    await drainAgentJobs();
    const publishTimer = setInterval(() => void publish(), 500);

    void (async () => {
      while (!shuttingDown) {
        try {
          await ensureAgentConsumerGroup(consumerRedis, streamConfig);
          const eventIds = await waitForAgentEvents(consumerRedis, streamConfig);
          if (eventIds.length === 0) continue;
          await drainAgentJobs();
          await acknowledgeAgentEvents(consumerRedis, streamConfig, eventIds);
        } catch (error) {
          console.error('agent_stream_consume_failed', error);
          await new Promise((resolve) => setTimeout(resolve, 2_000));
        }
      }
    })();

    setInterval(async () => {
      try {
        const [leases, staleOutbox, staleTelegram] = await Promise.all([
          reconcileExpiredAgentLeases(pool),
          reconcileStaleAgentOutbox(pool),
          reconcileStaleTelegramClaims(pool)
        ]);
        await publish();
        const recovered = await drainAgentJobs();
        if (leases.requeued || leases.blocked || staleOutbox || staleTelegram || recovered) {
          console.warn('agent_conductor_recovery', { ...leases, staleOutbox, staleTelegram, recovered });
        }
      } catch (error) {
        console.error('agent_conductor_recovery_failed', error);
      }
    }, 120000);

    const stop = (): void => {
      shuttingDown = true;
      clearInterval(publishTimer);
      publisherRedis.disconnect();
      consumerRedis.disconnect();
    };
    process.once('SIGTERM', stop);
    process.once('SIGINT', stop);
  }
}

main().catch((error) => {
  console.error('worker_fatal', error);
  process.exit(1);
});
