#!/usr/bin/env node

import { createHash, randomUUID } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import {
  authorityViolation,
  buildFirstPrinciplesBrief,
  defaultAuthorityEnvelope,
  redactSensitiveText
} from '@brad/domain';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: process.env.BRAD_ENV_PATH ?? '/home/benjijmac/bradmytwin/.env' });

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const ARTIFACT_ROOT = process.env.BRAD_ARTIFACT_ROOT ?? '/home/benjijmac/server-audits/brad-hermes-jobs/';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['DISPATCH_HERMES', 'WAIT', 'REQUEST_APPROVAL']);
const MANAGED_CHANNELS = new Set(['KIMI', 'TELEGRAM', 'WEB']);
const SENSITIVE_KEY_PATTERN = /(?:api[_-]?key|access[_-]?token|refresh[_-]?token|bot[_-]?token|token|secret|password|passwd|pwd|private[_-]?key|credential)/i;
// A two-minute recovery scan must be able to reclaim and resume within five minutes.
const CLAIM_TTL_SECONDS = 150;
const CONTINUATION_WINDOW_SECONDS = 30;

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

function redactValue(value, key = '') {
  if (SENSITIVE_KEY_PATTERN.test(key)) return '[REDACTED]';
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map((child) => redactValue(child));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactValue(child, childKey)]));
  }
  return value;
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

function assertNoForbiddenScope(values, authority = defaultAuthorityEnvelope()) {
  const violation = authorityViolation(values.map((value) => encodeBody(value)).join('\n'), authority);
  if (violation) throw new Error(violation.toLowerCase());
}

function requestContentForScope(request) {
  if (!request || typeof request !== 'object' || Array.isArray(request)) return request;
  const { authority: _policyMetadata, ...content } = request;
  return content;
}

async function managedBinding(client) {
  const result = await client.query(
    `SELECT DISTINCT person_id
     FROM brad_kimi_assignments
     WHERE status = 'ACTIVE'
     ORDER BY person_id`
  );
  if (result.rows.length !== 1) throw new Error('managed_kimi_person_binding_ambiguous');
  return { personId: result.rows[0].person_id };
}

function validateManagedClaimPayload(payload) {
  const claimOwner = validateText(payload.claimOwner, 'claim_owner', 256);
  if (!/^[A-Za-z0-9:._-]+$/.test(claimOwner)) throw new Error('invalid_claim_owner');
  return claimOwner;
}

async function intake(pool, encoded) {
  const payload = decodeDecision(encoded);
  const channel = validateText(payload.channel, 'channel', 20);
  const externalMessageId = validateText(payload.externalMessageId, 'external_message_id', 256);
  const conversationId = validateText(payload.conversationId, 'conversation_id', 512);
  const sessionKey = validateText(payload.sessionKey, 'session_key', 512);
  const senderId = validateText(payload.senderId, 'sender_id', 256, false);
  const claimOwner = validateManagedClaimPayload(payload);
  const text = validateText(payload.text, 'text', 100000);
  if (!MANAGED_CHANNELS.has(channel)) throw new Error('invalid_channel');
  assertNoForbiddenScope([channel, conversationId, senderId, text]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { personId } = await managedBinding(client);
    const contentDigest = digest(text);
    const identityKey = `${personId}:${channel}:${conversationId}:${externalMessageId}`;
    await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [identityKey]);
    const existing = await client.query(
      `SELECT b.id, b.objective_id, b.thread_id, b.executive_job_id, b.content_digest,
              b.status, b.claim_token, b.claim_owner, b.claim_expires_at,
              b.response_digest, b.settled_at, b.delivery_status,
              b.delivery_message_id, b.delivered_at, j.status AS executive_job_status
       FROM brad_managed_kimi_inbound b
       JOIN brad_agent_jobs j ON j.id = b.executive_job_id AND j.person_id = b.person_id
       WHERE b.person_id = $1 AND b.channel = $2 AND b.conversation_id = $3 AND b.external_message_id = $4
       FOR UPDATE OF b, j`,
      [personId, channel, conversationId, externalMessageId]
    );
    if (existing.rows[0]) {
      const inbound = existing.rows[0];
      if (inbound.content_digest !== contentDigest) throw new Error('managed_kimi_inbound_digest_conflict');
      if (inbound.status === 'RECONCILE_REQUIRED') throw new Error('managed_kimi_reconcile_required');
      if (inbound.status === 'SETTLED') {
        if (!inbound.response_digest || !inbound.settled_at || inbound.executive_job_status !== 'SUCCEEDED') {
          throw new Error('managed_kimi_settlement_invalid');
        }
        await client.query('COMMIT');
        emit({
          ok: true,
          operation: 'intake',
          deduplicated: true,
          settled: true,
          deliveryStatus: inbound.delivery_status,
          inboundId: inbound.id,
          objectiveId: inbound.objective_id,
          threadId: inbound.thread_id,
          jobId: inbound.executive_job_id
        });
        return;
      }
      const claimIsLive = inbound.status === 'CLAIMED'
        && inbound.claim_expires_at
        && new Date(inbound.claim_expires_at).getTime() > Date.now();
      if (claimIsLive && inbound.claim_owner !== claimOwner) throw new Error('managed_kimi_inbound_busy');
      const claimToken = claimIsLive ? inbound.claim_token : randomUUID();
      if (!claimIsLive) {
        await client.query(
          `UPDATE brad_managed_kimi_inbound
           SET status = 'CLAIMED', claim_token = $2, claim_owner = $3,
               claim_expires_at = now() + ($4 || ' seconds')::interval, updated_at = now()
           WHERE id = $1`,
          [inbound.id, claimToken, claimOwner, String(CLAIM_TTL_SECONDS)]
        );
      }
      await client.query('COMMIT');
      emit({
        ok: true,
        operation: 'intake',
        deduplicated: true,
        settled: false,
        inboundId: inbound.id,
        objectiveId: inbound.objective_id,
        threadId: inbound.thread_id,
        jobId: inbound.executive_job_id,
        claimToken
      });
      return;
    }

    const inboundId = randomUUID();
    const claimToken = randomUUID();
    const baseThreadId = randomUUID();
    const sourceMessageId = randomUUID();
    const objectiveId = randomUUID();
    const threadId = randomUUID();
    const ownerMessageId = randomUUID();
    const briefMessageId = randomUUID();
    const jobId = randomUUID();
    const databaseChannel = channel === 'TELEGRAM' ? 'TELEGRAM' : 'WEB';
    const brief = buildFirstPrinciplesBrief(text);
    const authority = defaultAuthorityEnvelope();
    const objectiveKey = `managed-kimi:${inboundId}`;

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
        sessionKey,
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
       ) VALUES ($1,$2,$3,$4,'WAITING',$5,'WAITING_MANAGED_KIMI','brad-kimi','brad-kimi',$6,$7::jsonb,8,5000000)`,
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
        `owner:${inboundId}`
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
        `first-principles:${inboundId}`
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
       ) VALUES ($1,$2,$3,$4,'brad-kimi','WAITING',$5::jsonb,$6,$7)`,
      [jobId, personId, threadId, ownerMessageId, encodeBody(request), payloadDigest(request), `job:executive:${inboundId}`]
    );
    await client.query(
      `UPDATE brad_agent_jobs SET last_error = 'WAITING_MANAGED_KIMI_REPLY' WHERE id = $1`,
      [jobId]
    );
    await client.query(
      `INSERT INTO brad_managed_kimi_inbound (
         id, person_id, channel, external_message_id, conversation_id, sender_id,
         content_digest, source_message_id, objective_id, thread_id, executive_job_id,
         status, claim_token, claim_owner, claim_expires_at
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'CLAIMED',$12,$13,
         now() + ($14 || ' seconds')::interval)`,
      [
        inboundId, personId, channel, externalMessageId, conversationId, senderId,
        contentDigest, sourceMessageId, objectiveId, threadId, jobId,
        claimToken, claimOwner, String(CLAIM_TTL_SECONDS)
      ]
    );
    await client.query('COMMIT');
    emit({
      ok: true,
      operation: 'intake',
      deduplicated: false,
      settled: false,
      inboundId,
      objectiveId,
      threadId,
      jobId,
      claimToken
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function loadManagedAssignment(client, inboundId, claimToken) {
  const result = await client.query(
    `SELECT
       b.id AS inbound_id, b.channel, b.conversation_id, b.claim_token,
       j.id AS job_id, j.status AS job_status, j.request_json, j.request_digest,
       t.id AS thread_id, t.status AS thread_status, t.reasoning_depth, t.authority_json,
       t.consecutive_agent_turns, t.max_consecutive_agent_turns,
       o.id AS objective_id, o.session_key, o.goal, o.definition_of_done, o.verification_method,
       o.status AS objective_status, o.version AS objective_version,
       COALESCE(jsonb_agg(jsonb_build_object(
         'sender', m.sender_agent_id,
         'type', m.message_type,
         'body', m.body,
         'artifactRefs', m.artifact_refs_json,
         'evidenceRefs', m.evidence_refs_json,
         'sequence', m.sequence_no
       ) ORDER BY m.sequence_no) FILTER (WHERE m.id IS NOT NULL), '[]'::jsonb) AS messages
     FROM brad_managed_kimi_inbound b
     JOIN brad_agent_jobs j ON j.id = b.executive_job_id AND j.person_id = b.person_id
     JOIN brad_agent_threads t ON t.id = b.thread_id AND t.person_id = b.person_id
     JOIN brad_objectives o ON o.id = b.objective_id AND o.person_id = b.person_id
     LEFT JOIN brad_agent_messages m ON m.thread_id = t.id AND m.person_id = t.person_id
     WHERE b.id = $1 AND b.status = 'CLAIMED' AND b.claim_token = $2
     GROUP BY b.id, j.id, t.id, o.id`,
    [inboundId, claimToken]
  );
  return result.rows[0] ?? null;
}

async function threadTransfer(pool, encoded) {
  const payload = decodeDecision(encoded);
  const inboundId = validateText(payload.inboundId, 'inbound_id', 36);
  const claimToken = validateText(payload.claimToken, 'claim_token', 36);
  const claimOwner = validateManagedClaimPayload(payload);
  const newClaimOwner = validateText(payload.newClaimOwner, 'new_claim_owner', 256);
  if (![inboundId, claimToken].every((value) => UUID_PATTERN.test(value))) throw new Error('invalid_identifier');
  if (!/^[A-Za-z0-9:._-]+$/.test(newClaimOwner)) throw new Error('invalid_new_claim_owner');
  if (newClaimOwner === claimOwner) throw new Error('claim_owner_unchanged');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { personId } = await managedBinding(client);
    const nextClaimToken = randomUUID();
    const transferred = await client.query(
      `UPDATE brad_managed_kimi_inbound b
       SET claim_token = $5, claim_owner = $6,
           claim_expires_at = now() + ($7 || ' seconds')::interval,
           updated_at = now()
       WHERE b.person_id = $1
         AND b.id = $2
         AND b.status = 'CLAIMED'
         AND b.claim_token = $3
         AND b.claim_owner = $4
         AND b.claim_expires_at > now()
         AND EXISTS (
           SELECT 1
           FROM brad_agent_jobs j
           JOIN brad_agent_threads t ON t.id = j.thread_id AND t.person_id = j.person_id
           JOIN brad_objectives o ON o.id = t.objective_id AND o.person_id = t.person_id
           WHERE j.id = b.executive_job_id AND j.person_id = b.person_id
             AND j.status = 'WAITING' AND j.last_error = 'WAITING_MANAGED_KIMI_REPLY'
             AND t.id = b.thread_id AND t.status = 'WAITING' AND t.phase = 'WAITING_MANAGED_KIMI'
             AND o.id = b.objective_id AND o.status IN ('RUNNING','WAITING')
         )
       RETURNING b.id`,
      [
        personId,
        inboundId,
        claimToken,
        claimOwner,
        nextClaimToken,
        newClaimOwner,
        String(CLAIM_TTL_SECONDS)
      ]
    );
    if (transferred.rowCount !== 1) throw new Error('managed_kimi_claim_not_transferable');
    const assignment = await loadManagedAssignment(client, inboundId, nextClaimToken);
    if (!assignment) throw new Error('managed_kimi_assignment_missing');
    const redactedAssignment = redactValue(assignment);
    delete redactedAssignment.claim_token;
    redactedAssignment.claimToken = nextClaimToken;
    await client.query('COMMIT');
    emit({ ok: true, operation: 'thread-transfer', assignment: redactedAssignment });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function managedContinuation(pool, encoded) {
  const payload = decodeDecision(encoded);
  const claimOwner = validateManagedClaimPayload(payload);
  const text = validateText(payload.text, 'text', 100000);
  const bootConversationId = validateText(payload.bootConversationId, 'boot_conversation_id', 512);
  const mainSessionKey = validateText(payload.mainSessionKey, 'main_session_key', 512);
  if (!/^agent:[A-Za-z0-9][A-Za-z0-9._-]*:boot$/.test(bootConversationId)) {
    throw new Error('invalid_boot_conversation_id');
  }
  if (mainSessionKey !== `${bootConversationId.slice(0, -4)}main`) {
    throw new Error('invalid_main_session_key');
  }
  if (!claimOwner.startsWith('openclaw-run:')) throw new Error('invalid_continuation_claim_owner');
  assertNoForbiddenScope([text]);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { personId } = await managedBinding(client);
    const candidates = await client.query(
      `SELECT b.id
       FROM brad_managed_kimi_inbound b
       JOIN brad_agent_jobs j ON j.id = b.executive_job_id AND j.person_id = b.person_id
       JOIN brad_agent_threads t ON t.id = b.thread_id AND t.person_id = b.person_id
       JOIN brad_objectives o ON o.id = b.objective_id AND o.person_id = b.person_id
       WHERE b.person_id = $1
         AND b.channel = 'KIMI'
         AND b.conversation_id = $2
         AND b.external_message_id LIKE 'openclaw-run:boot-%'
         AND b.content_digest = $3
         AND b.status = 'CLAIMED'
         AND b.claim_owner LIKE 'openclaw-run:boot-%'
         AND b.claim_expires_at > now()
         AND b.created_at >= now() - ($4 || ' seconds')::interval
         AND j.status = 'WAITING' AND j.last_error = 'WAITING_MANAGED_KIMI_REPLY'
         AND t.status = 'WAITING' AND t.phase = 'WAITING_MANAGED_KIMI'
         AND o.status IN ('RUNNING','WAITING')
       ORDER BY b.created_at DESC
       FOR UPDATE OF b, j, t, o`,
      [personId, bootConversationId, digest(text), String(CONTINUATION_WINDOW_SECONDS)]
    );
    if (candidates.rowCount === 0) {
      await client.query('COMMIT');
      emit({ ok: true, operation: 'continuation', assignment: null });
      return;
    }
    if (candidates.rowCount !== 1) throw new Error('managed_kimi_continuation_ambiguous');

    const inboundId = candidates.rows[0].id;
    const claimToken = randomUUID();
    const transferred = await client.query(
      `UPDATE brad_managed_kimi_inbound
       SET claim_token = $2, claim_owner = $3,
           claim_expires_at = now() + ($4 || ' seconds')::interval,
           updated_at = now()
       WHERE id = $1 AND status = 'CLAIMED'
       RETURNING objective_id`,
      [inboundId, claimToken, claimOwner, String(CLAIM_TTL_SECONDS)]
    );
    if (transferred.rowCount !== 1) throw new Error('managed_kimi_continuation_not_transferable');
    const objectiveUpdated = await client.query(
      `UPDATE brad_objectives
       SET session_key = $3, version = version + 1, updated_at = now()
       WHERE person_id = $1 AND id = $2 AND status IN ('RUNNING','WAITING')`,
      [personId, transferred.rows[0].objective_id, mainSessionKey]
    );
    if (objectiveUpdated.rowCount !== 1) throw new Error('managed_kimi_continuation_objective_missing');
    const assignment = await loadManagedAssignment(client, inboundId, claimToken);
    if (!assignment) throw new Error('managed_kimi_assignment_missing');
    const redactedAssignment = redactValue(assignment);
    delete redactedAssignment.claim_token;
    redactedAssignment.claimToken = claimToken;
    await client.query('COMMIT');
    emit({ ok: true, operation: 'continuation', assignment: redactedAssignment });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function threadPull(pool, encoded, recoveryOnly = false) {
  const payload = decodeDecision(encoded);
  const claimOwner = validateManagedClaimPayload(payload);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { personId } = await managedBinding(client);
    const selected = await client.query(
      `SELECT b.id
       FROM brad_managed_kimi_inbound b
       JOIN brad_agent_jobs j ON j.id = b.executive_job_id AND j.person_id = b.person_id
       JOIN brad_agent_threads t ON t.id = b.thread_id AND t.person_id = b.person_id
       JOIN brad_objectives o ON o.id = b.objective_id AND o.person_id = b.person_id
       WHERE b.person_id = $1
         AND (b.status = 'PENDING' OR (b.status = 'CLAIMED' AND b.claim_expires_at < now()))
         AND j.assigned_agent_id = 'brad-kimi'
         AND j.status = 'WAITING' AND j.last_error = 'WAITING_MANAGED_KIMI_REPLY'
         AND t.status = 'WAITING' AND t.phase = 'WAITING_MANAGED_KIMI'
         AND o.status IN ('RUNNING','WAITING')
         AND ($2::boolean = false OR b.updated_at < now() - interval '2 minutes')
       ORDER BY b.created_at
       FOR UPDATE OF b SKIP LOCKED
       LIMIT 1`,
      [personId, recoveryOnly]
    );
    if (!selected.rows[0]) {
      await client.query('COMMIT');
      emit({ ok: true, operation: recoveryOnly ? 'recover' : 'thread-pull', assignment: null });
      return;
    }
    const claimToken = randomUUID();
    const inboundId = selected.rows[0].id;
    await client.query(
      `UPDATE brad_managed_kimi_inbound
       SET status = 'CLAIMED', claim_token = $2, claim_owner = $3,
           claim_expires_at = now() + ($4 || ' seconds')::interval, updated_at = now()
       WHERE id = $1`,
      [inboundId, claimToken, claimOwner, String(CLAIM_TTL_SECONDS)]
    );
    const assignment = await loadManagedAssignment(client, inboundId, claimToken);
    if (!assignment) throw new Error('managed_kimi_assignment_missing');
    const redactedAssignment = redactValue(assignment);
    delete redactedAssignment.claim_token;
    redactedAssignment.claimToken = claimToken;
    await client.query('COMMIT');
    emit({
      ok: true,
      operation: recoveryOnly ? 'recover' : 'thread-pull',
      assignment: redactedAssignment
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function threadReply(pool, encoded) {
  const payload = decodeDecision(encoded);
  const jobId = validateText(payload.jobId, 'job_id', 36);
  const threadId = validateText(payload.threadId, 'thread_id', 36);
  const objectiveId = validateText(payload.objectiveId, 'objective_id', 36);
  const claimToken = validateText(payload.claimToken, 'claim_token', 36);
  const claimOwner = validateManagedClaimPayload(payload);
  const sessionId = validateText(payload.sessionId, 'session_id', 512, false);
  const text = validateText(payload.text, 'text', 100000);
  const artifactRefs = validateArray(payload.artifactRefs, 'artifact_refs');
  const evidenceRefs = validateArray(payload.evidenceRefs, 'evidence_refs');
  if (![jobId, threadId, objectiveId, claimToken].every((value) => UUID_PATTERN.test(value))) throw new Error('invalid_identifier');
  assertNoForbiddenScope([text, artifactRefs, evidenceRefs]);
  const responseDigest = payloadDigest({ text, artifactRefs, evidenceRefs });

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { personId } = await managedBinding(client);
    const result = await client.query(
      `SELECT
         j.*, b.id AS inbound_id, b.status AS inbound_status, b.claim_token, b.claim_owner,
         b.claim_expires_at, b.response_digest,
         t.objective_id, t.status AS thread_status, t.phase AS thread_phase,
         t.authority_json, t.reasoning_depth,
         t.consecutive_agent_turns, t.max_consecutive_agent_turns,
         o.goal, o.definition_of_done, o.verification_method, o.status AS objective_status
       FROM brad_managed_kimi_inbound b
       JOIN brad_agent_jobs j ON j.id = b.executive_job_id AND j.person_id = b.person_id
       JOIN brad_agent_threads t ON t.id = j.thread_id AND t.person_id = j.person_id
       JOIN brad_objectives o ON o.id = t.objective_id AND o.person_id = t.person_id
       WHERE b.person_id = $1 AND j.id = $2 AND j.thread_id = $3 AND t.objective_id = $4
       FOR UPDATE OF b, j, t, o`,
      [personId, jobId, threadId, objectiveId]
    );
    const job = result.rows[0];
    if (!job || job.assigned_agent_id !== 'brad-kimi') throw new Error('managed_kimi_job_not_available');
    if (job.inbound_status === 'SETTLED') {
      if (job.status !== 'SUCCEEDED' || job.response_digest !== responseDigest) {
        throw new Error('managed_kimi_reply_digest_conflict');
      }
      await client.query('COMMIT');
      emit({
        ok: true,
        operation: 'thread-reply',
        deduplicated: true,
        responseDigest,
        jobId,
        threadId,
        objectiveId
      });
      return;
    }
    if (job.inbound_status !== 'CLAIMED' || job.claim_token !== claimToken || job.claim_owner !== claimOwner) {
      throw new Error('managed_kimi_claim_mismatch');
    }
    if (!job.claim_expires_at || new Date(job.claim_expires_at).getTime() < Date.now()) throw new Error('managed_kimi_claim_expired');
    if (job.thread_status !== 'WAITING' || job.thread_phase !== 'WAITING_MANAGED_KIMI') throw new Error('managed_kimi_thread_not_waiting');
    if (job.objective_status !== 'RUNNING') throw new Error('managed_kimi_objective_not_running');
    if (job.status !== 'WAITING' || job.last_error !== 'WAITING_MANAGED_KIMI_REPLY') throw new Error('managed_kimi_job_not_waiting');
    if (job.consecutive_agent_turns >= job.max_consecutive_agent_turns) throw new Error('loop_budget_exhausted');
    if (payloadDigest(job.request_json) !== job.request_digest) throw new Error('request_digest_mismatch');

    const storedContext = await client.query(
      `SELECT sender_agent_id, message_type, body, artifact_refs_json, evidence_refs_json
       FROM brad_agent_messages
       WHERE person_id = $1 AND thread_id = $2
       ORDER BY sequence_no`,
      [personId, threadId]
    );
    assertNoForbiddenScope([
      job.goal,
      job.definition_of_done,
      job.verification_method,
      requestContentForScope(job.request_json),
      storedContext.rows,
      text,
      artifactRefs,
      evidenceRefs
    ], job.authority_json);

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
         ) VALUES ($1,$2,'brad-kimi',$3,'kimi-coding/k2p6','ACTIVE',$4::jsonb)
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
       SET status = 'SUCCEEDED', leased_until = NULL, lease_token = NULL,
           worker_identity = NULL, last_error = NULL, finished_at = now(), updated_at = now()
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
    await client.query(
      `UPDATE brad_managed_kimi_inbound
       SET status = 'SETTLED', response_digest = $2, settled_at = now(),
           claim_token = NULL, claim_owner = NULL, claim_expires_at = NULL, updated_at = now()
       WHERE id = $1`,
      [job.inbound_id, responseDigest]
    );
    await client.query('COMMIT');
    emit({
      ok: true,
      operation: 'thread-reply',
      deduplicated: false,
      responseDigest,
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

async function threadDelivery(pool, encoded) {
  const payload = decodeDecision(encoded);
  const inboundId = validateText(payload.inboundId, 'inbound_id', 36);
  const jobId = validateText(payload.jobId, 'job_id', 36);
  const responseDigest = validateText(payload.responseDigest, 'response_digest', 64);
  const messageId = validateText(payload.messageId, 'message_id', 512, false);
  const success = payload.success;
  if (![inboundId, jobId].every((value) => UUID_PATTERN.test(value))) throw new Error('invalid_identifier');
  if (!/^[0-9a-f]{64}$/i.test(responseDigest)) throw new Error('invalid_response_digest');
  if (typeof success !== 'boolean') throw new Error('invalid_delivery_success');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { personId } = await managedBinding(client);
    const result = await client.query(
      `SELECT b.status, b.response_digest, b.delivery_status,
              b.delivery_message_id, b.delivered_at, j.status AS job_status
       FROM brad_managed_kimi_inbound b
       JOIN brad_agent_jobs j ON j.id = b.executive_job_id AND j.person_id = b.person_id
       WHERE b.person_id = $1 AND b.id = $2 AND b.executive_job_id = $3
       FOR UPDATE OF b, j`,
      [personId, inboundId, jobId]
    );
    const delivery = result.rows[0];
    if (!delivery) throw new Error('managed_kimi_delivery_not_available');
    if (
      delivery.status !== 'SETTLED'
      || delivery.job_status !== 'SUCCEEDED'
      || delivery.response_digest !== responseDigest
    ) throw new Error('managed_kimi_delivery_settlement_mismatch');

    if (success) {
      if (delivery.delivery_status === 'RECONCILE_REQUIRED') {
        throw new Error('managed_kimi_delivery_reconcile_required');
      }
      if (delivery.delivery_status === 'DELIVERED') {
        if (
          messageId
          && delivery.delivery_message_id
          && messageId !== delivery.delivery_message_id
        ) throw new Error('managed_kimi_delivery_message_conflict');
        await client.query('COMMIT');
        emit({ ok: true, operation: 'thread-delivery', deduplicated: true, status: 'DELIVERED' });
        return;
      }
      await client.query(
        `UPDATE brad_managed_kimi_inbound
         SET delivery_status = 'DELIVERED', delivery_message_id = $2,
             delivered_at = now(), updated_at = now()
         WHERE id = $1`,
        [inboundId, messageId]
      );
      await client.query('COMMIT');
      emit({ ok: true, operation: 'thread-delivery', deduplicated: false, status: 'DELIVERED' });
      return;
    }

    if (delivery.delivery_status === 'DELIVERED') throw new Error('managed_kimi_delivery_already_delivered');
    if (delivery.delivery_status === 'PENDING') {
      await client.query(
        `UPDATE brad_managed_kimi_inbound
         SET delivery_status = 'RECONCILE_REQUIRED', delivery_message_id = NULL,
             delivered_at = NULL, updated_at = now()
         WHERE id = $1`,
        [inboundId]
      );
    }
    await client.query('COMMIT');
    emit({
      ok: true,
      operation: 'thread-delivery',
      deduplicated: delivery.delivery_status === 'RECONCILE_REQUIRED',
      status: 'RECONCILE_REQUIRED'
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function threadRenew(pool, encoded) {
  const payload = decodeDecision(encoded);
  const jobId = validateText(payload.jobId, 'job_id', 36);
  const claimToken = validateText(payload.claimToken, 'claim_token', 36);
  const claimOwner = validateManagedClaimPayload(payload);
  if (!UUID_PATTERN.test(jobId) || !UUID_PATTERN.test(claimToken)) throw new Error('invalid_identifier');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { personId } = await managedBinding(client);
    const renewed = await client.query(
      `UPDATE brad_managed_kimi_inbound b
       SET claim_expires_at = now() + ($4 || ' seconds')::interval, updated_at = now()
       FROM brad_agent_jobs j, brad_agent_threads t
       WHERE b.person_id = $1
         AND b.executive_job_id = $2
         AND b.status = 'CLAIMED'
         AND b.claim_token = $3
         AND b.claim_owner = $5
         AND b.claim_expires_at > now()
         AND j.id = b.executive_job_id AND j.person_id = b.person_id
         AND j.status = 'WAITING' AND j.last_error = 'WAITING_MANAGED_KIMI_REPLY'
         AND t.id = b.thread_id AND t.person_id = b.person_id
         AND t.status = 'WAITING' AND t.phase = 'WAITING_MANAGED_KIMI'
       RETURNING b.id`,
      [personId, jobId, claimToken, String(CLAIM_TTL_SECONDS), claimOwner]
    );
    if (renewed.rowCount !== 1) throw new Error('managed_kimi_claim_not_renewable');
    await client.query('COMMIT');
    emit({ ok: true, operation: 'thread-renew', jobId });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function threadStatus(pool, jobId) {
  if (!UUID_PATTERN.test(jobId ?? '')) throw new Error('invalid_job_id');
  const client = await pool.connect();
  try {
    const { personId } = await managedBinding(client);
    const result = await client.query(
      `SELECT j.id AS job_id, j.status AS job_status, t.id AS thread_id,
              t.status AS thread_status, t.phase, t.blocker_code,
              o.id AS objective_id, o.status AS objective_status,
              b.status AS bridge_status,
              t.consecutive_agent_turns, t.max_consecutive_agent_turns
       FROM brad_managed_kimi_inbound b
       JOIN brad_agent_jobs j ON j.id = b.executive_job_id AND j.person_id = b.person_id
       JOIN brad_agent_threads t ON t.id = j.thread_id AND t.person_id = j.person_id
       JOIN brad_objectives o ON o.id = t.objective_id AND o.person_id = t.person_id
       WHERE b.person_id = $1 AND j.id = $2 AND j.assigned_agent_id = 'brad-kimi'`,
      [personId, jobId]
    );
    if (!result.rows[0]) throw new Error('managed_kimi_job_not_available');
    emit({ ok: true, operation: 'thread-status', ...result.rows[0] });
  } finally {
    client.release();
  }
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
  const allowed = ['health', 'pull', 'decide', 'receipt', 'intake', 'continuation', 'thread-pull', 'thread-transfer', 'thread-renew', 'thread-reply', 'thread-delivery', 'thread-status', 'recover'];
  if (!operation || parts.length > 2 || !allowed.includes(operation)) {
    reject('command_not_allowed');
    return;
  }
  const requiresArgument = ['decide', 'receipt', 'intake', 'continuation', 'thread-pull', 'thread-transfer', 'thread-renew', 'thread-reply', 'thread-delivery', 'thread-status', 'recover'].includes(operation);
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
    if (operation === 'continuation') await managedContinuation(pool, argument);
    if (operation === 'thread-pull') await threadPull(pool, argument, false);
    if (operation === 'thread-transfer') await threadTransfer(pool, argument);
    if (operation === 'thread-renew') await threadRenew(pool, argument);
    if (operation === 'thread-reply') await threadReply(pool, argument);
    if (operation === 'thread-delivery') await threadDelivery(pool, argument);
    if (operation === 'thread-status') await threadStatus(pool, argument);
    if (operation === 'recover') await threadPull(pool, argument, true);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'gateway_error';
    reject(/^[a-z0-9_]+$/.test(code) ? code : 'gateway_error', 1);
  } finally {
    await pool.end();
  }
}

await main();
