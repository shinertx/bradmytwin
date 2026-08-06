#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: process.env.BRAD_ENV_PATH ?? '/home/benjijmac/bradmytwin/.env' });

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const ARTIFACT_ROOT = process.env.BRAD_ARTIFACT_ROOT ?? '/home/benjijmac/server-audits/brad-hermes-jobs/';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['DISPATCH_HERMES', 'WAIT', 'REQUEST_APPROVAL']);
const MANAGED_CHANNELS = new Set(['KIMI', 'TELEGRAM']);
const TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

function emit(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function reject(code, exitCode = 2) {
  emit({ ok: false, error: code });
  process.exitCode = exitCode;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const entries = Object.entries(value)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${canonicalJson(child)}`).join(',')}}`;
}

function payloadDigest(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function decodeDecision(encoded) {
  if (!encoded || encoded.length > 24000 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('invalid_decision_encoding');
  }
  const raw = Buffer.from(encoded, 'base64url').toString('utf8');
  if (Buffer.byteLength(raw, 'utf8') > 16000) throw new Error('decision_too_large');
  return JSON.parse(raw);
}

function encodeBody(value) {
  return JSON.stringify(value);
}

function redactSensitiveText(value) {
  return value
    .replace(/-----BEGIN [^-\n]+ PRIVATE KEY-----[\s\S]*?-----END [^-\n]+ PRIVATE KEY-----/g, '[REDACTED]')
    .replace(/\b(?:sk|rk|pk)-(?:proj-)?[A-Za-z0-9_-]{16,}\b/g, '[REDACTED]')
    .replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, '[REDACTED]')
    .replace(/\b\d{6,12}:[A-Za-z0-9_-]{20,}\b/g, '[REDACTED]')
    .replace(/\b((?:api[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|token|secret|password|passwd|pwd)\s*[:=]\s*)["']?[^\s"',;]+["']?/gi, '$1[REDACTED]');
}

function redactValue(value) {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, redactValue(child)]));
  }
  return value;
}

function classifyReasoningDepth(text) {
  return text.length >= 240 || /\b(strategy|architecture|legal|financial|deploy|delete|publish|purchase|security|credential|compare|investigate|root cause|first principles|red[- ]?team|audit|design|build|send|spend|file|sign|trade|transfer|approve)\b/i.test(text)
    ? 'FULL'
    : 'LIGHT';
}

function firstPrinciplesBrief(text) {
  const objective = text.trim().replace(/^\/do\b\s*/i, '').trim() || 'Resolve the owner request.';
  const depth = classifyReasoningDepth(objective);
  if (depth === 'LIGHT') return {
    objective,
    bindingConstraint: 'The result must be produced and checked without creating an unauthorized effect.',
    hiddenAssumption: 'The request contains enough context to choose a reversible next action.',
    candidate: 'Take the smallest proof-bearing action that advances the objective.',
    strongestAttack: 'The action may only create activity rather than prove the requested outcome.',
    repair: 'Require a concrete artifact, source-of-truth observation, or precise blocker.',
    decisiveTest: 'Check the requested outcome against its source of truth before closing.',
    depth
  };
  return {
    objective,
    bindingConstraint: 'Identify and remove the constraint that prevents a verified outcome.',
    hiddenAssumption: 'The apparent task is the highest-value interpretation within the owner\'s stated scope and authority.',
    candidate: 'Form the strongest reversible solution using current evidence and available capabilities.',
    strongestAttack: 'Assume the candidate is wrong, incomplete, unsafe, duplicated, or optimized for activity instead of outcome.',
    repair: 'Revise the candidate until the strongest remaining objection no longer changes the recommended action.',
    decisiveTest: 'Run the cheapest source-of-truth test with an explicit threshold and resulting decision.',
    depth
  };
}

function defaultAuthorityEnvelope() {
  return {
    level: 'APPROVAL_REQUIRED',
    externalEffectsAllowed: false,
    allowedTools: [],
    forbiddenScopes: ['JENNI', 'CREDENTIALS', 'LEGAL_FILING', 'PAYMENTS', 'DELETION', 'PUBLICATION']
  };
}

function validateArray(value, name, maxItems = 32) {
  if (value == null) return [];
  if (!Array.isArray(value) || value.length > maxItems) throw new Error(`invalid_${name}`);
  return value;
}

async function insertAgentOutbox(client, input) {
  await client.query(
    `INSERT INTO brad_agent_outbox (
       person_id, thread_id, message_id, destination, event_type, payload_json, idempotency_key
     ) VALUES ($1,$2,$3,'BUZZ','AGENT_MESSAGE',$4,$5)
     ON CONFLICT (destination, idempotency_key) DO NOTHING`,
    [
      input.personId,
      input.threadId,
      input.messageId,
      encodeBody({
        messageId: input.messageId,
        threadId: input.threadId,
        objectiveId: input.objectiveId,
        sender: input.sender,
        recipients: input.recipients,
        type: input.type,
        body: redactSensitiveText(input.body)
      }),
      `buzz:${input.messageId}`
    ]
  );
}

function validateText(value, name, maxLength, required = true) {
  if (typeof value !== 'string') {
    if (!required && value == null) return null;
    throw new Error(`invalid_${name}`);
  }
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > maxLength || normalized.includes('\0')) {
    throw new Error(`invalid_${name}`);
  }
  return normalized;
}

async function health(pool) {
  const result = await pool.query(
    `SELECT
       (SELECT count(*)::int FROM brad_kimi_assignments WHERE status = 'ACTIVE') AS active_assignments,
       (SELECT count(*)::int FROM brad_worker_jobs WHERE worker_kind = 'HERMES' AND status IN ('QUEUED','LEASED','RUNNING')) AS active_hermes_jobs`
  );
  emit({ ok: true, operation: 'health', ...result.rows[0] });
}

async function managedPersonId(client) {
  const result = await client.query(
    `SELECT DISTINCT person_id
     FROM brad_kimi_assignments
     WHERE status = 'ACTIVE'
     ORDER BY person_id`
  );
  if (result.rows.length !== 1) throw new Error('managed_kimi_person_binding_ambiguous');
  return result.rows[0].person_id;
}

async function intake(pool, encoded) {
  const payload = decodeDecision(encoded);
  const channel = validateText(payload.channel, 'channel', 20);
  const externalMessageId = validateText(payload.externalMessageId, 'external_message_id', 256);
  const conversationId = validateText(payload.conversationId, 'conversation_id', 512);
  const senderId = validateText(payload.senderId, 'sender_id', 256, false);
  const text = validateText(payload.text, 'text', 100000);
  if (!MANAGED_CHANNELS.has(channel)) throw new Error('invalid_channel');
  if (/\bjenni(?:pro)?\b/i.test(text)) throw new Error('forbidden_scope_jenni');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = await client.query(
      `SELECT objective_id, thread_id, executive_job_id
       FROM brad_managed_kimi_inbound
       WHERE channel = $1 AND external_message_id = $2
       FOR UPDATE`,
      [channel, externalMessageId]
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      emit({
        ok: true,
        operation: 'intake',
        deduplicated: true,
        objectiveId: existing.rows[0].objective_id,
        threadId: existing.rows[0].thread_id,
        jobId: existing.rows[0].executive_job_id
      });
      return;
    }

    const personId = await managedPersonId(client);
    const baseThreadId = randomUUID();
    const sourceMessageId = randomUUID();
    const objectiveId = randomUUID();
    const threadId = randomUUID();
    const ownerMessageId = randomUUID();
    const briefMessageId = randomUUID();
    const jobId = randomUUID();
    const databaseChannel = channel === 'TELEGRAM' ? 'TELEGRAM' : 'WEB';
    const brief = firstPrinciplesBrief(text);
    const authority = defaultAuthorityEnvelope();
    const objectiveKey = `managed-kimi:${channel}:${externalMessageId}`;

    await client.query(
      `INSERT INTO threads (id, person_id, primary_channel, status)
       VALUES ($1,$2,$3,'ACTIVE')`,
      [baseThreadId, personId, databaseChannel]
    );
    await client.query(
      `INSERT INTO messages (
         id, person_id, channel, thread_id, direction, body, provider_msg_id, metadata_json
       ) VALUES ($1,$2,$3,$4,'INBOUND',$5,$6,$7::jsonb)`,
      [
        sourceMessageId,
        personId,
        databaseChannel,
        baseThreadId,
        text,
        externalMessageId,
        encodeBody({ source: 'managed_kimi', channel, conversationId, senderId })
      ]
    );
    await client.query(
      `INSERT INTO brad_objectives (
         id, person_id, source_message_id, session_key, goal, definition_of_done,
         verification_method, authority_level, status, current_step, next_action, idempotency_key
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,'APPROVAL_REQUIRED','RUNNING','first_principles','dispatch_executive',$8)`,
      [
        objectiveId,
        personId,
        sourceMessageId,
        `managed-kimi:${conversationId}`,
        brief.objective,
        'The requested outcome is independently verified, or a precise blocker is recorded.',
        brief.decisiveTest,
        objectiveKey
      ]
    );
    await client.query(
      `INSERT INTO brad_agent_threads (
         id, person_id, objective_id, source_message_id, status, reasoning_depth,
         phase, lead_agent_id, next_agent_id, current_assignment, authority_json,
         max_consecutive_agent_turns, max_cost_micros
       ) VALUES ($1,$2,$3,$4,'QUEUED',$5,'INTAKE','brad-kimi','brad-kimi',$6,$7::jsonb,8,5000000)`,
      [threadId, personId, objectiveId, sourceMessageId, brief.depth, brief.objective, encodeBody(authority)]
    );
    await client.query(
      `INSERT INTO brad_agent_thread_participants (thread_id, agent_id)
       SELECT $1, unnest($2::text[])
       ON CONFLICT DO NOTHING`,
      [threadId, ['owner', 'system', 'brad-kimi', 'hermes', 'codex', 'claude', 'verifier']]
    );
    await client.query(
      `INSERT INTO brad_agent_messages (
         id, person_id, thread_id, objective_id, sender_agent_id, recipient_agent_ids,
         message_type, body, metadata_json, content_digest, idempotency_key, sequence_no
       ) VALUES ($1,$2,$3,$4,'owner',ARRAY['brad-kimi'],'OWNER_REQUEST',$5,$6::jsonb,$7,$8,1)`,
      [
        ownerMessageId,
        personId,
        threadId,
        objectiveId,
        text,
        encodeBody({ sourceChannel: channel, conversationId }),
        digest({ sender: 'owner', type: 'OWNER_REQUEST', body: text }),
        `owner:${externalMessageId}`
      ]
    );
    await insertAgentOutbox(client, {
      personId, threadId, objectiveId, messageId: ownerMessageId,
      sender: 'owner', recipients: ['brad-kimi'], type: 'OWNER_REQUEST', body: text
    });
    const briefBody = encodeBody(brief);
    await client.query(
      `INSERT INTO brad_agent_messages (
         id, person_id, thread_id, objective_id, parent_message_id, sender_agent_id,
         recipient_agent_ids, message_type, body, metadata_json, content_digest,
         idempotency_key, sequence_no
       ) VALUES ($1,$2,$3,$4,$5,'system',ARRAY['brad-kimi'],'FIRST_PRINCIPLES',$6,$7::jsonb,$8,$9,2)`,
      [
        briefMessageId,
        personId,
        threadId,
        objectiveId,
        ownerMessageId,
        briefBody,
        encodeBody({ brief }),
        digest({ sender: 'system', type: 'FIRST_PRINCIPLES', body: briefBody }),
        `first-principles:${externalMessageId}`
      ]
    );
    await insertAgentOutbox(client, {
      personId, threadId, objectiveId, messageId: briefMessageId,
      sender: 'system', recipients: ['brad-kimi'], type: 'FIRST_PRINCIPLES', body: briefBody
    });

    const request = { stage: 'EXECUTIVE_INTAKE', objective: brief.objective, brief, authority };
    await client.query(
      `INSERT INTO brad_agent_jobs (
         id, person_id, thread_id, trigger_message_id, assigned_agent_id, status,
         request_json, request_digest, idempotency_key
       ) VALUES ($1,$2,$3,$4,'brad-kimi','QUEUED',$5::jsonb,$6,$7)`,
      [jobId, personId, threadId, ownerMessageId, encodeBody(request), payloadDigest(request), `job:executive:${externalMessageId}`]
    );
    await client.query(
      `INSERT INTO brad_agent_outbox (
         person_id, thread_id, destination, event_type, payload_json, idempotency_key
       ) VALUES ($1,$2,'REDIS','AGENT_JOB_QUEUED',$3::jsonb,$4)
       ON CONFLICT (destination, idempotency_key) DO NOTHING`,
      [personId, threadId, encodeBody({ threadId }), `redis:job:executive:${externalMessageId}`]
    );
    await client.query(
      `INSERT INTO brad_managed_kimi_inbound (
         person_id, channel, external_message_id, conversation_id, sender_id,
         content_digest, source_message_id, objective_id, thread_id, executive_job_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [personId, channel, externalMessageId, conversationId, senderId, digest(text), sourceMessageId, objectiveId, threadId, jobId]
    );
    await client.query('COMMIT');
    emit({ ok: true, operation: 'intake', deduplicated: false, objectiveId, threadId, jobId });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function threadPull(pool, recoveryOnly = false) {
  const result = await pool.query(
    `SELECT
       j.id AS job_id, j.status AS job_status, j.request_json, j.request_digest,
       t.id AS thread_id, t.status AS thread_status, t.reasoning_depth, t.authority_json,
       t.consecutive_agent_turns, t.max_consecutive_agent_turns,
       o.id AS objective_id, o.goal, o.definition_of_done, o.verification_method,
       o.status AS objective_status, o.version AS objective_version,
       COALESCE(jsonb_agg(jsonb_build_object(
         'sender', m.sender_agent_id,
         'type', m.message_type,
         'body', m.body,
         'sequence', m.sequence_no
       ) ORDER BY m.sequence_no) FILTER (WHERE m.id IS NOT NULL), '[]'::jsonb) AS messages
     FROM brad_agent_jobs j
     JOIN brad_agent_threads t ON t.id = j.thread_id AND t.person_id = j.person_id
     JOIN brad_objectives o ON o.id = t.objective_id AND o.person_id = t.person_id
     LEFT JOIN brad_agent_messages m ON m.thread_id = t.id AND m.person_id = t.person_id
     WHERE j.assigned_agent_id = 'brad-kimi'
       AND j.status IN ('QUEUED','WAITING')
       AND t.status NOT IN ('PAUSED','CANCELLED','SUCCEEDED','FAILED')
       AND ($1::boolean = false OR j.updated_at < now() - interval '2 minutes')
     GROUP BY j.id, t.id, o.id
     ORDER BY j.created_at
     LIMIT 1`,
    [recoveryOnly]
  );
  const row = result.rows[0];
  if (!row) {
    emit({ ok: true, operation: recoveryOnly ? 'recover' : 'thread-pull', assignment: null });
    return;
  }
  emit({
    ok: true,
    operation: recoveryOnly ? 'recover' : 'thread-pull',
    assignment: redactValue(row)
  });
}

async function threadReply(pool, encoded) {
  const payload = decodeDecision(encoded);
  const jobId = validateText(payload.jobId, 'job_id', 36);
  const threadId = validateText(payload.threadId, 'thread_id', 36);
  const objectiveId = validateText(payload.objectiveId, 'objective_id', 36);
  const sessionId = validateText(payload.sessionId, 'session_id', 512, false);
  const text = validateText(payload.text, 'text', 100000);
  const artifactRefs = validateArray(payload.artifactRefs, 'artifact_refs');
  const evidenceRefs = validateArray(payload.evidenceRefs, 'evidence_refs');
  if (![jobId, threadId, objectiveId].every((value) => UUID_PATTERN.test(value))) throw new Error('invalid_identifier');
  if (/\bjenni(?:pro)?\b/i.test(text)) throw new Error('forbidden_scope_jenni');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query(
      `SELECT
         j.*, t.objective_id, t.status AS thread_status, t.reasoning_depth,
         t.consecutive_agent_turns, t.max_consecutive_agent_turns,
         o.goal, o.status AS objective_status
       FROM brad_agent_jobs j
       JOIN brad_agent_threads t ON t.id = j.thread_id AND t.person_id = j.person_id
       JOIN brad_objectives o ON o.id = t.objective_id AND o.person_id = t.person_id
       WHERE j.id = $1 AND j.thread_id = $2 AND t.objective_id = $3
       FOR UPDATE OF j, t, o`,
      [jobId, threadId, objectiveId]
    );
    const job = result.rows[0];
    if (!job || job.assigned_agent_id !== 'brad-kimi') throw new Error('managed_kimi_job_not_available');
    if (TERMINAL_STATUSES.has(job.thread_status) || TERMINAL_STATUSES.has(job.objective_status)) throw new Error('objective_terminal');

    const existing = await client.query(
      `SELECT id FROM brad_agent_messages
       WHERE thread_id = $1 AND metadata_json->>'managedKimiJobId' = $2
       LIMIT 1`,
      [threadId, jobId]
    );
    if (existing.rows[0] && job.status === 'SUCCEEDED') {
      await client.query('COMMIT');
      emit({ ok: true, operation: 'thread-reply', deduplicated: true, jobId, threadId, objectiveId });
      return;
    }
    if (!['QUEUED', 'WAITING'].includes(job.status)) throw new Error('managed_kimi_job_busy');
    if (job.consecutive_agent_turns >= job.max_consecutive_agent_turns) throw new Error('loop_budget_exhausted');

    const sequence = await client.query(
      `SELECT (COALESCE(MAX(sequence_no), 0) + 1)::bigint AS next
       FROM brad_agent_messages WHERE thread_id = $1`,
      [threadId]
    );
    const messageId = randomUUID();
    const messageDigest = digest({ sender: 'brad-kimi', type: 'DECISION', body: text });
    await client.query(
      `INSERT INTO brad_agent_messages (
         id, person_id, thread_id, objective_id, parent_message_id, sender_agent_id,
         recipient_agent_ids, message_type, body, artifact_refs_json, evidence_refs_json,
         metadata_json, content_digest, idempotency_key, sequence_no
       ) VALUES ($1,$2,$3,$4,$5,'brad-kimi',ARRAY['hermes'],'DECISION',$6,$7::jsonb,$8::jsonb,$9::jsonb,$10,$11,$12)`,
      [
        messageId,
        job.person_id,
        threadId,
        objectiveId,
        job.trigger_message_id,
        text,
        encodeBody(artifactRefs),
        encodeBody(evidenceRefs),
        encodeBody({ source: 'managed_kimi', managedKimiJobId: jobId }),
        messageDigest,
        `managed-kimi-reply:${jobId}`,
        Number(sequence.rows[0].next)
      ]
    );
    await insertAgentOutbox(client, {
      personId: job.person_id, threadId, objectiveId, messageId,
      sender: 'brad-kimi', recipients: ['hermes'], type: 'DECISION', body: text
    });
    if (sessionId) {
      await client.query(
        `INSERT INTO brad_agent_sessions (
           person_id, thread_id, agent_id, provider_session_id, model, status, last_checkpoint_json
         ) VALUES ($1,$2,'brad-kimi',$3,'kimi/k2p6','ACTIVE',$4::jsonb)
         ON CONFLICT (thread_id, agent_id) DO UPDATE SET
           provider_session_id = EXCLUDED.provider_session_id,
           model = EXCLUDED.model,
           status = 'ACTIVE',
           last_checkpoint_json = EXCLUDED.last_checkpoint_json,
           last_used_at = now(), updated_at = now()`,
        [job.person_id, threadId, sessionId, encodeBody({ messageId, jobId })]
      );
    }
    await client.query(
      `UPDATE brad_agent_jobs
       SET status = 'SUCCEEDED', leased_until = NULL, finished_at = now(), updated_at = now()
       WHERE id = $1`,
      [jobId]
    );
    await client.query(
      `UPDATE brad_agent_threads
       SET status = 'QUEUED', phase = 'DISPATCH', next_agent_id = 'hermes',
           blocker_code = NULL, consecutive_agent_turns = consecutive_agent_turns + 1,
           version = version + 1, updated_at = now()
       WHERE id = $1`,
      [threadId]
    );
    const nextRequest = {
      stage: 'AFTER_BRAD_KIMI',
      objective: job.goal,
      priorResult: text,
      verificationContract: job.request_json?.verificationContract ?? null
    };
    const nextJobId = randomUUID();
    await client.query(
      `INSERT INTO brad_agent_jobs (
         id, person_id, thread_id, trigger_message_id, assigned_agent_id, status,
         request_json, request_digest, idempotency_key
       ) VALUES ($1,$2,$3,$4,'hermes','QUEUED',$5::jsonb,$6,$7)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [nextJobId, job.person_id, threadId, messageId, encodeBody(nextRequest), payloadDigest(nextRequest), `next:${jobId}:hermes`]
    );
    await client.query(
      `INSERT INTO brad_agent_outbox (
         person_id, thread_id, destination, event_type, payload_json, idempotency_key
       ) VALUES ($1,$2,'REDIS','AGENT_JOB_QUEUED',$3::jsonb,$4)
       ON CONFLICT (destination, idempotency_key) DO NOTHING`,
      [job.person_id, threadId, encodeBody({ threadId }), `redis:next:${jobId}:hermes`]
    );
    await client.query('COMMIT');
    emit({
      ok: true,
      operation: 'thread-reply',
      deduplicated: false,
      jobId,
      threadId,
      objectiveId,
      nextAgentId: 'hermes'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function threadStatus(pool, jobId) {
  if (!UUID_PATTERN.test(jobId ?? '')) throw new Error('invalid_job_id');
  const result = await pool.query(
    `SELECT j.id AS job_id, j.status AS job_status, t.id AS thread_id,
            t.status AS thread_status, t.phase, t.blocker_code,
            o.id AS objective_id, o.status AS objective_status,
            t.consecutive_agent_turns, t.max_consecutive_agent_turns
     FROM brad_agent_jobs j
     JOIN brad_agent_threads t ON t.id = j.thread_id AND t.person_id = j.person_id
     JOIN brad_objectives o ON o.id = t.objective_id AND o.person_id = t.person_id
     WHERE j.id = $1 AND j.assigned_agent_id = 'brad-kimi'`,
    [jobId]
  );
  if (!result.rows[0]) throw new Error('managed_kimi_job_not_available');
  emit({ ok: true, operation: 'thread-status', ...result.rows[0] });
}

async function pull(pool) {
  const result = await pool.query(
    `SELECT
       a.id AS assignment_id,
       a.objective_id,
       a.authority,
       a.last_decision_digest,
       o.version AS objective_version,
       o.goal,
       o.definition_of_done,
       o.verification_method,
       o.authority_level,
       o.status AS objective_status,
       o.current_step,
       o.next_action,
       li.linear_identifier,
       j.id AS latest_job_id,
       j.status AS latest_job_status,
       r.outcome AS latest_receipt_outcome,
       r.verification_status AS latest_receipt_verification_status,
       r.result_digest AS latest_receipt_result_digest
     FROM brad_kimi_assignments a
     JOIN brad_objectives o ON o.id = a.objective_id
     LEFT JOIN brad_linear_issues li ON li.objective_id = o.id
     LEFT JOIN LATERAL (
       SELECT id, status
       FROM brad_worker_jobs
       WHERE objective_id = o.id AND worker_kind = 'HERMES'
       ORDER BY created_at DESC
       LIMIT 1
     ) j ON true
     LEFT JOIN LATERAL (
       SELECT outcome, verification_status, result_digest
       FROM brad_worker_receipts
       WHERE job_id = j.id
       ORDER BY created_at DESC
       LIMIT 1
     ) r ON true
     WHERE a.status = 'ACTIVE'
       AND o.status NOT IN ('SUCCEEDED','FAILED','CANCELLED')
     ORDER BY a.updated_at, a.created_at
     LIMIT 1`
  );

  if (!result.rows[0]) {
    emit({ ok: true, operation: 'pull', assignment: null });
    return;
  }

  await pool.query(
    'UPDATE brad_kimi_assignments SET last_pulled_at = now(), updated_at = now() WHERE id = $1',
    [result.rows[0].assignment_id]
  );
  emit({ ok: true, operation: 'pull', assignment: result.rows[0] });
}

function buildHermesPrompt(objective, rationale, hermesPrompt) {
  return [
    `Kimi Brad assignment for objective ${objective.linear_identifier ?? objective.id}`,
    `Objective: ${objective.goal}`,
    '',
    '# Kimi decision rationale',
    rationale,
    '',
    '# Requested analysis',
    hermesPrompt,
    '',
    '# Enforced authority boundary',
    'This is read-only analysis. Use only the supplied packet and model reasoning.',
    'Do not call tools, inspect files, browse, execute commands, install anything, change state, send messages, pay, deploy, publish, delete, or access credentials.',
    'Do not claim the objective is complete. Separate evidence, inference, blockers, and the cheapest decisive next test.',
    '',
    '# Required response',
    'Return concise sections: Result, Evidence, Actions Taken, Remaining Blockers, Next Decisive Test.'
  ].join('\n');
}

async function decide(pool, encoded) {
  const payload = decodeDecision(encoded);
  const assignmentId = validateText(payload.assignmentId, 'assignment_id', 36);
  const objectiveId = validateText(payload.objectiveId, 'objective_id', 36);
  const action = validateText(payload.action, 'action', 40);
  const rationale = validateText(payload.rationale, 'rationale', 2000);
  const objectiveVersion = Number(payload.objectiveVersion);
  const hermesPrompt = action === 'DISPATCH_HERMES'
    ? validateText(payload.hermesPrompt, 'hermes_prompt', 8000)
    : null;

  if (!UUID_PATTERN.test(assignmentId) || !UUID_PATTERN.test(objectiveId)) throw new Error('invalid_identifier');
  if (!Number.isInteger(objectiveVersion) || objectiveVersion < 1) throw new Error('invalid_objective_version');
  if (!ACTIONS.has(action)) throw new Error('invalid_action');

  const normalized = { assignmentId, objectiveId, objectiveVersion, action, rationale, hermesPrompt };
  const requestDigest = digest(normalized);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const assignmentResult = await client.query(
      `SELECT
         a.id, a.person_id, a.objective_id, a.authority, a.max_dispatches_per_hour,
         o.version, o.goal, o.status, li.linear_identifier
       FROM brad_kimi_assignments a
       JOIN brad_objectives o ON o.id = a.objective_id
       LEFT JOIN brad_linear_issues li ON li.objective_id = o.id
       WHERE a.id = $1 AND a.objective_id = $2 AND a.status = 'ACTIVE'
       FOR UPDATE OF a, o`,
      [assignmentId, objectiveId]
    );
    const assignment = assignmentResult.rows[0];
    if (!assignment) throw new Error('assignment_not_active');
    if (assignment.authority !== 'READ_ONLY_ANALYSIS') throw new Error('authority_not_allowed');
    if (assignment.version !== objectiveVersion) throw new Error('stale_objective_version');
    if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(assignment.status)) throw new Error('objective_terminal');

    const existing = await client.query(
      'SELECT id, worker_job_id FROM brad_kimi_decisions WHERE request_digest = $1',
      [requestDigest]
    );
    if (existing.rows[0]) {
      await client.query('COMMIT');
      emit({
        ok: true,
        operation: 'decide',
        deduplicated: true,
        decisionId: existing.rows[0].id,
        jobId: existing.rows[0].worker_job_id,
        requestDigest
      });
      return;
    }

    if (action === 'DISPATCH_HERMES') {
      const rate = await client.query(
        `SELECT count(*)::int AS count
         FROM brad_kimi_decisions
         WHERE assignment_id = $1
           AND action = 'DISPATCH_HERMES'
           AND created_at >= now() - interval '1 hour'`,
        [assignmentId]
      );
      if (rate.rows[0].count >= assignment.max_dispatches_per_hour) throw new Error('dispatch_rate_limited');
      const active = await client.query(
        `SELECT id FROM brad_worker_jobs
         WHERE objective_id = $1 AND worker_kind = 'HERMES'
           AND status IN ('QUEUED','LEASED','RUNNING')
         LIMIT 1`,
        [objectiveId]
      );
      if (active.rows[0]) throw new Error('hermes_job_already_active');
    }

    let workerJobId = null;
    if (action === 'DISPATCH_HERMES') {
      const prompt = buildHermesPrompt(assignment, rationale, hermesPrompt);
      const input = {
        source: 'KIMI_CLAW',
        assignmentId,
        objectiveId,
        objectiveVersion,
        linearIdentifier: assignment.linear_identifier,
        title: assignment.goal,
        authority: 'READ_ONLY_ANALYSIS',
        prompt,
        toolsets: ['clarify'],
        verification: null
      };
      const job = await client.query(
        `INSERT INTO brad_worker_jobs (
           person_id, objective_id, worker_kind, idempotency_key, request_digest,
           contract_version, input_json, skills_json, toolsets_json
         ) VALUES ($1,$2,'HERMES',$3,$4,$5,$6::jsonb,'[]'::jsonb,'["clarify"]'::jsonb)
         ON CONFLICT (idempotency_key) DO UPDATE SET updated_at = brad_worker_jobs.updated_at
         RETURNING id`,
        [
          assignment.person_id,
          objectiveId,
          `kimi:${assignmentId}:${objectiveVersion}:${requestDigest}`,
          requestDigest,
          objectiveVersion,
          JSON.stringify(input)
        ]
      );
      workerJobId = job.rows[0].id;
    }

    const decision = await client.query(
      `INSERT INTO brad_kimi_decisions (
         assignment_id, objective_id, objective_version, action, request_digest,
         rationale, hermes_prompt, worker_job_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       RETURNING id`,
      [assignmentId, objectiveId, objectiveVersion, action, requestDigest, rationale, hermesPrompt, workerJobId]
    );
    await client.query(
      `UPDATE brad_kimi_assignments
       SET last_decision_digest = $2, last_decision_at = now(), updated_at = now()
       WHERE id = $1`,
      [assignmentId, requestDigest]
    );
    await client.query('COMMIT');
    emit({
      ok: true,
      operation: 'decide',
      deduplicated: false,
      decisionId: decision.rows[0].id,
      jobId: workerJobId,
      requestDigest
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function receipt(pool, jobId) {
  if (!UUID_PATTERN.test(jobId ?? '')) throw new Error('invalid_job_id');
  const result = await pool.query(
    `SELECT
       j.id AS job_id, j.status AS job_status, j.finished_at,
       r.outcome, r.verification_status, r.result_digest, r.artifact_uri,
       r.artifact_sha256, r.provider, r.model, r.created_at
     FROM brad_worker_jobs j
     JOIN brad_kimi_assignments a ON a.objective_id = j.objective_id
     LEFT JOIN LATERAL (
       SELECT * FROM brad_worker_receipts
       WHERE job_id = j.id
       ORDER BY created_at DESC
       LIMIT 1
     ) r ON true
     WHERE j.id = $1 AND j.worker_kind = 'HERMES' AND a.status <> 'REVOKED'
     LIMIT 1`,
    [jobId]
  );
  const row = result.rows[0];
  if (!row) throw new Error('job_not_available');

  let workerResult = null;
  if (row.artifact_uri) {
    const resolvedRoot = await realpath(ARTIFACT_ROOT);
    const resolvedArtifact = await realpath(row.artifact_uri);
    if (!resolvedArtifact.startsWith(`${resolvedRoot}/`)) throw new Error('artifact_outside_root');
    const artifactStat = await stat(resolvedArtifact);
    if (!artifactStat.isFile() || artifactStat.size > 131072) throw new Error('artifact_not_readable');
    workerResult = await readFile(resolvedArtifact, 'utf8');
  }

  delete row.artifact_uri;
  emit({ ok: true, operation: 'receipt', receipt: row, result: workerResult });
}

async function main() {
  if (!DATABASE_URL) {
    reject('gateway_not_configured', 1);
    return;
  }
  const rawCommand = (process.env.SSH_ORIGINAL_COMMAND ?? process.argv.slice(2).join(' ')).trim();
  const parts = rawCommand.split(/\s+/).filter(Boolean);
  const operation = parts[0];
  const argument = parts[1];
  const allowed = ['health', 'pull', 'decide', 'receipt', 'intake', 'thread-pull', 'thread-reply', 'thread-status', 'recover'];
  if (!operation || parts.length > 2 || !allowed.includes(operation)) {
    reject('command_not_allowed');
    return;
  }
  const requiresArgument = ['decide', 'receipt', 'intake', 'thread-reply', 'thread-status'].includes(operation);
  if (requiresArgument !== Boolean(argument)) {
    reject('invalid_arguments');
    return;
  }

  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    if (operation === 'health') await health(pool);
    if (operation === 'pull') await pull(pool);
    if (operation === 'decide') await decide(pool, argument);
    if (operation === 'receipt') await receipt(pool, argument);
    if (operation === 'intake') await intake(pool, argument);
    if (operation === 'thread-pull') await threadPull(pool, false);
    if (operation === 'thread-reply') await threadReply(pool, argument);
    if (operation === 'thread-status') await threadStatus(pool, argument);
    if (operation === 'recover') await threadPull(pool, true);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'gateway_error';
    reject(/^[a-z0-9_]+$/.test(code) ? code : 'gateway_error', 1);
  } finally {
    await pool.end();
  }
}

await main();
