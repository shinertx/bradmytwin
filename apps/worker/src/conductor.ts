import {
  AGENT_IDS,
  authorityViolation,
  nextAgentForTurn,
  redactSensitiveText,
  turnBudgetFailure,
  type AgentId,
  type AgentMessageType,
  type AuthorityEnvelope,
  type ReasoningDepth
} from '@brad/domain';
import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { AgentRunRequest, AgentRunResult, AgentRunnerRegistry } from './agent-runners.js';
import { digestPayload, sha256 } from './digest.js';

interface AgentJobRow {
  id: string;
  person_id: string;
  thread_id: string;
  trigger_message_id: string;
  assigned_agent_id: AgentId;
  request_json: Record<string, unknown>;
  request_digest: string;
  attempt_count: number;
  lease_token: string;
}

interface AgentThreadRow {
  id: string;
  person_id: string;
  objective_id: string;
  status: string;
  reasoning_depth: ReasoningDepth;
  authority_json: AuthorityEnvelope;
  consecutive_agent_turns: number;
  max_consecutive_agent_turns: number;
  cost_micros: number;
  max_cost_micros: number;
  created_at: string;
  deadline_at: string;
  version: number;
}

interface ContextRow {
  sender_agent_id: string;
  message_type: string;
  body: string;
  artifact_refs_json: Array<Record<string, unknown>>;
  evidence_refs_json: Array<Record<string, unknown>>;
}

export interface ConductorWorkerConfig {
  workerIdentity: string;
  leaseSeconds: number;
  workflowVersion: string;
}

function messageTypeFor(agentId: AgentId, hasCritique: boolean): AgentMessageType {
  if (agentId === AGENT_IDS.BRAD_KIMI) return 'DELEGATE';
  if (agentId === AGENT_IDS.HERMES) return hasCritique ? 'REVISION' : 'RESULT';
  if (agentId === AGENT_IDS.CODEX || agentId === AGENT_IDS.CLAUDE) return 'CRITIQUE';
  if (agentId === AGENT_IDS.VERIFIER) return 'VERIFY';
  return 'SYSTEM';
}

async function insertMessage(client: PoolClient, input: {
  jobId: string;
  thread: AgentThreadRow;
  senderAgentId: AgentId;
  recipients: AgentId[];
  type: AgentMessageType;
  body: string;
  artifactRefs?: Array<Record<string, unknown>>;
  evidenceRefs?: Array<Record<string, unknown>>;
  metadata?: Record<string, unknown>;
}): Promise<string> {
  await client.query(`SELECT id FROM brad_agent_threads WHERE id = $1 FOR UPDATE`, [input.thread.id]);
  const sequence = await client.query<{ next: string }>(
    `SELECT (COALESCE(MAX(sequence_no), 0) + 1)::text AS next FROM brad_agent_messages WHERE thread_id = $1`,
    [input.thread.id]
  );
  const id = randomUUID();
  const contentDigest = sha256(`${input.senderAgentId}\n${input.type}\n${input.body}`);
  const inserted = await client.query<{ id: string }>(
    `INSERT INTO brad_agent_messages (
       id, person_id, thread_id, objective_id, sender_agent_id, recipient_agent_ids,
       message_type, body, artifact_refs_json, evidence_refs_json, metadata_json,
       content_digest, idempotency_key, sequence_no
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
     ON CONFLICT (thread_id, idempotency_key) DO UPDATE
       SET idempotency_key = EXCLUDED.idempotency_key
     RETURNING id`,
    [
      id, input.thread.person_id, input.thread.id, input.thread.objective_id,
      input.senderAgentId, input.recipients, input.type, input.body,
      JSON.stringify(input.artifactRefs ?? []), JSON.stringify(input.evidenceRefs ?? []),
      JSON.stringify(input.metadata ?? {}), contentDigest, `job-result:${input.jobId}`, Number(sequence.rows[0].next)
    ]
  );
  const persistedId = inserted.rows[0].id;
  await client.query(
    `INSERT INTO brad_agent_outbox (
       person_id, thread_id, message_id, destination, event_type, payload_json, idempotency_key
     ) VALUES ($1,$2,$3,'BUZZ','AGENT_MESSAGE',$4,$5)
     ON CONFLICT (destination, idempotency_key) DO NOTHING`,
    [
      input.thread.person_id,
      input.thread.id,
      persistedId,
      JSON.stringify({
        messageId: persistedId,
        threadId: input.thread.id,
        objectiveId: input.thread.objective_id,
        sender: input.senderAgentId,
        recipients: input.recipients,
        type: input.type,
        body: redactSensitiveText(input.body)
      }),
      `buzz:${persistedId}`
    ]
  );
  return persistedId;
}

async function enqueueNext(client: PoolClient, input: {
  thread: AgentThreadRow;
  triggerMessageId: string;
  nextAgentId: AgentId;
  request: Record<string, unknown>;
  sourceJobId: string;
}): Promise<void> {
  const requestDigest = digestPayload(input.request);
  await client.query(
    `INSERT INTO brad_agent_jobs (
       person_id, thread_id, trigger_message_id, assigned_agent_id, status,
       request_json, request_digest, idempotency_key
     ) VALUES ($1,$2,$3,$4,'QUEUED',$5,$6,$7)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [
      input.thread.person_id,
      input.thread.id,
      input.triggerMessageId,
      input.nextAgentId,
      JSON.stringify(input.request),
      requestDigest,
      `next:${input.sourceJobId}:${input.nextAgentId}`
    ]
  );
  await client.query(
    `INSERT INTO brad_agent_outbox (
       person_id, thread_id, destination, event_type, payload_json, idempotency_key
     ) VALUES ($1,$2,'REDIS','AGENT_JOB_QUEUED',$3,$4)
     ON CONFLICT (destination, idempotency_key) DO NOTHING`,
    [input.thread.person_id, input.thread.id, JSON.stringify({ threadId: input.thread.id }), `redis:next:${input.sourceJobId}:${input.nextAgentId}`]
  );
}

async function enqueueOwnerBrief(client: PoolClient, input: {
  thread: AgentThreadRow;
  status: string;
  body: string;
  idempotencyKey: string;
}): Promise<void> {
  await client.query(
    `INSERT INTO brad_agent_outbox (
       person_id, thread_id, destination, event_type, payload_json, idempotency_key
     )
     SELECT $1,$2,'TELEGRAM_BRIEF','OWNER_STATUS',$3,$4
     FROM messages m
     JOIN brad_agent_threads t ON t.source_message_id = m.id
     WHERE t.id = $2 AND m.channel = 'TELEGRAM'
     ON CONFLICT (destination, idempotency_key) DO NOTHING`,
    [
      input.thread.person_id,
      input.thread.id,
      JSON.stringify({
        threadId: input.thread.id,
        objectiveId: input.thread.objective_id,
        status: input.status,
        body: input.body
      }),
      input.idempotencyKey
    ]
  );
}

export async function claimAgentJob(pool: Pool, config: ConductorWorkerConfig): Promise<AgentJobRow | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query<Omit<AgentJobRow, 'lease_token'>>(
      `SELECT j.id, j.person_id, j.thread_id, j.trigger_message_id, j.assigned_agent_id,
              j.request_json, j.request_digest, j.attempt_count
       FROM brad_agent_jobs j
       JOIN brad_agent_threads t ON t.id = j.thread_id AND t.person_id = j.person_id
       WHERE j.status = 'QUEUED' AND j.next_attempt_at <= now()
         AND t.status NOT IN ('PAUSED','CANCELLED','SUCCEEDED','FAILED')
       ORDER BY j.created_at
       FOR UPDATE OF j SKIP LOCKED LIMIT 1`
    );
    if (!selected.rows[0]) {
      await client.query('COMMIT');
      return null;
    }
    const leaseToken = randomUUID();
    const updated = await client.query<AgentJobRow>(
      `UPDATE brad_agent_jobs
       SET status = 'LEASED', lease_token = $2, leased_until = now() + ($3 || ' seconds')::interval,
           worker_identity = $4, attempt_count = attempt_count + 1, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [selected.rows[0].id, leaseToken, String(config.leaseSeconds), config.workerIdentity]
    );
    await client.query('COMMIT');
    return updated.rows[0];
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function processOneAgentJob(
  pool: Pool,
  runners: AgentRunnerRegistry,
  config: ConductorWorkerConfig
): Promise<boolean> {
  const job = await claimAgentJob(pool, config);
  if (!job) return false;

  const threadResult = await pool.query<AgentThreadRow>(`SELECT * FROM brad_agent_threads WHERE id = $1`, [job.thread_id]);
  const thread = threadResult.rows[0];
  if (!thread) throw new Error('agent_thread_missing');

  const budgetFailure = turnBudgetFailure({
    consecutiveAgentTurns: thread.consecutive_agent_turns,
    maxConsecutiveAgentTurns: thread.max_consecutive_agent_turns,
    elapsedMs: Date.now() - new Date(thread.created_at).getTime(),
    maxElapsedMs: Math.max(0, new Date(thread.deadline_at).getTime() - new Date(thread.created_at).getTime()),
    costMicros: Number(thread.cost_micros),
    maxCostMicros: Number(thread.max_cost_micros)
  });
  if (budgetFailure) {
    await blockJob(pool, job, thread, budgetFailure, `Agent execution stopped: ${budgetFailure}.`);
    return true;
  }

  if (digestPayload(job.request_json) !== job.request_digest) {
    await blockJob(pool, job, thread, 'REQUEST_DIGEST_MISMATCH', 'The queued agent request failed its integrity check.');
    return true;
  }

  const runner = runners.get(job.assigned_agent_id);
  if (!runner) {
    await blockJob(pool, job, thread, 'AGENT_ADAPTER_UNAVAILABLE', `${job.assigned_agent_id} has no healthy execution adapter.`);
    return true;
  }

  const contextResult = await pool.query<ContextRow>(
    `SELECT sender_agent_id, message_type, body, artifact_refs_json, evidence_refs_json
     FROM brad_agent_messages WHERE thread_id = $1 ORDER BY sequence_no`,
    [thread.id]
  );
  const sessionResult = await pool.query<{ provider_session_id: string | null }>(
    `SELECT provider_session_id FROM brad_agent_sessions WHERE thread_id = $1 AND agent_id = $2`,
    [thread.id, job.assigned_agent_id]
  );
  const verificationContract = typeof job.request_json.verificationContract === 'object'
    ? job.request_json.verificationContract as Record<string, unknown>
    : undefined;
  const prompt = typeof job.request_json.objective === 'string'
    ? job.request_json.objective
    : typeof job.request_json.text === 'string'
      ? job.request_json.text
      : JSON.stringify(job.request_json);

  const scopeViolation = authorityViolation(
    [prompt, ...contextResult.rows.map((message) => message.body)].join('\n'),
    thread.authority_json
  );
  if (scopeViolation) {
    await blockJob(pool, job, thread, scopeViolation, 'This objective is outside the authority granted to the personal Brad runtime.');
    return true;
  }

  await pool.query(
    `UPDATE brad_agent_jobs SET status = 'RUNNING', updated_at = now() WHERE id = $1 AND lease_token = $2`,
    [job.id, job.lease_token]
  );
  await pool.query(
    `UPDATE brad_agent_threads SET status = 'RUNNING', phase = $2, next_agent_id = $3, updated_at = now()
     WHERE id = $1`,
    [thread.id, `RUN_${job.assigned_agent_id.toUpperCase()}`, job.assigned_agent_id]
  );

  let result: AgentRunResult;
  const startedAt = Date.now();
  const renewEveryMs = Math.max(1_000, Math.floor(config.leaseSeconds * 1_000 / 3));
  const leaseHeartbeat = setInterval(() => {
    void pool.query(
      `UPDATE brad_agent_jobs
       SET leased_until = now() + ($3 || ' seconds')::interval, updated_at = now()
       WHERE id = $1 AND lease_token = $2 AND status = 'RUNNING'`,
      [job.id, job.lease_token, String(config.leaseSeconds)]
    ).catch(() => undefined);
  }, renewEveryMs);
  leaseHeartbeat.unref();
  try {
    const request: AgentRunRequest = {
      jobId: job.id,
      objectiveId: thread.objective_id,
      threadId: thread.id,
      triggerMessageId: job.trigger_message_id,
      agentId: job.assigned_agent_id,
      personId: thread.person_id,
      prompt,
      context: contextResult.rows.map((message) => ({
        sender: message.sender_agent_id,
        type: message.message_type,
        body: JSON.stringify({
          text: message.body,
          artifactRefs: message.artifact_refs_json,
          evidenceRefs: message.evidence_refs_json
        })
      })),
      authority: thread.authority_json,
      sessionId: sessionResult.rows[0]?.provider_session_id ?? undefined,
      verificationContract
    };
    result = await runner.run(request);
  } catch (error) {
    clearInterval(leaseHeartbeat);
    const message = error instanceof Error ? error.message : 'agent_runner_failed';
    await blockJob(pool, job, thread, 'AGENT_RUNNER_FAILED', message);
    return true;
  }
  clearInterval(leaseHeartbeat);

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const current = await client.query<{ job_status: string; thread_status: string }>(
      `SELECT j.status AS job_status, t.status AS thread_status
       FROM brad_agent_jobs j
       JOIN brad_agent_threads t ON t.id = j.thread_id AND t.person_id = j.person_id
       WHERE j.id = $1 AND j.lease_token = $2
       FOR UPDATE OF j, t`,
      [job.id, job.lease_token]
    );
    if (!current.rows[0] || current.rows[0].job_status !== 'RUNNING') {
      await client.query('ROLLBACK');
      return true;
    }
    if (current.rows[0].thread_status === 'CANCELLED' || current.rows[0].thread_status === 'PAUSED') {
      await client.query(
        `UPDATE brad_agent_jobs
         SET status = 'CANCELLED', leased_until = NULL, finished_at = now(),
             last_error = 'owner_stopped_during_run', updated_at = now()
         WHERE id = $1`,
        [job.id]
      );
      await client.query('COMMIT');
      return true;
    }
    if (result.deferred) {
      await insertMessage(client, {
        jobId: job.id,
        thread,
        senderAgentId: AGENT_IDS.SYSTEM,
        recipients: [job.assigned_agent_id],
        type: 'DELEGATE',
        body: `${prompt}\n\n[BRAD_THREAD:${thread.id}][BRAD_JOB:${job.id}]`,
        metadata: { deferredToBuzz: true, jobId: job.id }
      });
      await client.query(
        `UPDATE brad_agent_jobs SET status = 'WAITING', last_error = $2, leased_until = NULL, updated_at = now()
         WHERE id = $1`,
        [job.id, result.blockerCode ?? 'WAITING_BUZZ_AGENT_REPLY']
      );
      await client.query(
        `UPDATE brad_agent_threads SET status = 'WAITING', blocker_code = $2, phase = 'WAITING_BUZZ_REPLY', updated_at = now()
         WHERE id = $1`,
        [thread.id, result.blockerCode ?? 'WAITING_BUZZ_AGENT_REPLY']
      );
      await client.query('COMMIT');
      return true;
    }

    const hasCritique = contextResult.rows.some((message) => message.message_type === 'CRITIQUE');
    const type = messageTypeFor(job.assigned_agent_id, hasCritique);
    const nextAgentId = nextAgentForTurn({
      currentAgentId: job.assigned_agent_id,
      reasoningDepth: thread.reasoning_depth,
      hasCritique
    });
    const messageId = await insertMessage(client, {
      jobId: job.id,
      thread,
      senderAgentId: job.assigned_agent_id,
      recipients: nextAgentId ? [nextAgentId] : [AGENT_IDS.OWNER],
      type,
      body: result.text,
      artifactRefs: result.artifactRefs,
      evidenceRefs: result.evidenceRefs,
      metadata: { model: result.model, provider: result.provider, usage: result.usage }
    });

    if (result.sessionId) {
      await client.query(
        `INSERT INTO brad_agent_sessions (
           person_id, thread_id, agent_id, provider_session_id, model, status, last_checkpoint_json
         ) VALUES ($1,$2,$3,$4,$5,'ACTIVE',$6)
         ON CONFLICT (thread_id, agent_id) DO UPDATE SET
           provider_session_id = EXCLUDED.provider_session_id, model = EXCLUDED.model,
           status = 'ACTIVE', last_checkpoint_json = EXCLUDED.last_checkpoint_json,
           last_used_at = now(), updated_at = now()`,
        [thread.person_id, thread.id, job.assigned_agent_id, result.sessionId, result.model ?? null, JSON.stringify({ messageId })]
      );
    }

    await client.query(
      `UPDATE brad_agent_jobs SET status = 'SUCCEEDED', leased_until = NULL, finished_at = now(), updated_at = now()
       WHERE id = $1`,
      [job.id]
    );

    const addedCost = result.costMicros ?? 0;
    if (result.blockerCode) {
      await client.query(
        `UPDATE brad_agent_threads SET status = 'BLOCKED', blocker_code = $2, phase = 'AGENT_BLOCKED',
             consecutive_agent_turns = consecutive_agent_turns + 1,
             cost_micros = cost_micros + $3, version = version + 1, updated_at = now()
         WHERE id = $1`,
        [thread.id, result.blockerCode, addedCost]
      );
      await client.query(
        `UPDATE brad_objectives SET status = 'BLOCKED', current_step = 'agent_blocked', next_action = 'resolve_precise_blocker',
             last_error = $2, version = version + 1, updated_at = now() WHERE id = $1`,
        [thread.objective_id, result.blockerCode]
      );
    } else if (job.assigned_agent_id === AGENT_IDS.VERIFIER) {
      if (result.verified === true && result.evidenceRefs.length > 0) {
        await client.query(
          `UPDATE brad_agent_threads SET status = 'SUCCEEDED', phase = 'VERIFIED', next_agent_id = NULL,
               evidence_summary_json = $2, consecutive_agent_turns = consecutive_agent_turns + 1,
               cost_micros = cost_micros + $3, version = version + 1, updated_at = now(), finished_at = now()
           WHERE id = $1`,
          [thread.id, JSON.stringify({ evidenceRefs: result.evidenceRefs }), addedCost]
        );
        await client.query(
          `UPDATE brad_objectives SET status = 'SUCCEEDED', current_step = 'verified', next_action = 'none',
               final_evidence_json = $2, version = version + 1, updated_at = now(), completed_at = now()
           WHERE id = $1`,
          [thread.objective_id, JSON.stringify({ evidenceRefs: result.evidenceRefs })]
        );
        await enqueueOwnerBrief(client, {
          thread,
          status: 'SUCCEEDED',
          body: redactSensitiveText(`Done and independently verified. ${result.text}`),
          idempotencyKey: `telegram:verified:${job.id}`
        });
      } else {
        await client.query(
          `UPDATE brad_agent_threads SET status = 'WAITING_VERIFICATION', phase = 'VERIFICATION_BLOCKED',
               blocker_code = 'INDEPENDENT_VERIFICATION_REQUIRED', next_agent_id = NULL,
               consecutive_agent_turns = consecutive_agent_turns + 1,
               cost_micros = cost_micros + $2, version = version + 1, updated_at = now()
           WHERE id = $1`,
          [thread.id, addedCost]
        );
        await client.query(
          `UPDATE brad_objectives SET status = 'WAITING', current_step = 'verification',
               next_action = 'collect_independent_outcome_evidence', version = version + 1, updated_at = now()
           WHERE id = $1`,
          [thread.objective_id]
        );
        await enqueueOwnerBrief(client, {
          thread,
          status: 'WAITING_VERIFICATION',
          body: 'The work is not being called done because independent completion evidence is still missing.',
          idempotencyKey: `telegram:verification-blocked:${job.id}`
        });
      }
      await client.query(
        `INSERT INTO brad_agent_evaluations (
           person_id, thread_id, objective_id, evaluator_agent_id, workflow_version,
           verified_outcome, duration_ms, cost_micros, retry_count, evidence_json
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          thread.person_id, thread.id, thread.objective_id, AGENT_IDS.VERIFIER, config.workflowVersion,
          result.verified ? 'VERIFIED' : 'UNVERIFIED', Date.now() - startedAt, addedCost,
          Math.max(0, job.attempt_count - 1), JSON.stringify({ evidenceRefs: result.evidenceRefs })
        ]
      );
    } else if (nextAgentId) {
      await client.query(
        `UPDATE brad_agent_threads SET status = 'QUEUED', phase = 'DISPATCH', next_agent_id = $2,
             blocker_code = NULL, consecutive_agent_turns = consecutive_agent_turns + 1,
             cost_micros = cost_micros + $3, version = version + 1, updated_at = now()
         WHERE id = $1`,
        [thread.id, nextAgentId, addedCost]
      );
      await enqueueNext(client, {
        thread,
        triggerMessageId: messageId,
        nextAgentId,
        request: {
          stage: `AFTER_${job.assigned_agent_id.toUpperCase()}`,
          objective: prompt,
          priorResult: result.text,
          verificationContract
        },
        sourceJobId: job.id
      });
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  return true;
}

async function blockJob(
  pool: Pool,
  job: AgentJobRow,
  thread: AgentThreadRow,
  code: string,
  message: string
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await insertMessage(client, {
      jobId: job.id,
      thread,
      senderAgentId: AGENT_IDS.SYSTEM,
      recipients: [AGENT_IDS.OWNER],
      type: 'BLOCKER',
      body: message,
      metadata: { blockerCode: code }
    });
    await client.query(
      `UPDATE brad_agent_jobs SET status = 'FAILED', last_error = $2, leased_until = NULL,
           finished_at = now(), updated_at = now() WHERE id = $1`,
      [job.id, code]
    );
    await client.query(
      `UPDATE brad_agent_threads SET status = 'BLOCKED', blocker_code = $2, phase = 'BLOCKED',
           next_agent_id = NULL, version = version + 1, updated_at = now() WHERE id = $1`,
      [thread.id, code]
    );
    await client.query(
      `UPDATE brad_objectives SET status = 'BLOCKED', current_step = 'blocked',
           next_action = 'resolve_precise_blocker', last_error = $2,
           version = version + 1, updated_at = now() WHERE id = $1`,
      [thread.objective_id, code]
    );
    await enqueueOwnerBrief(client, {
      thread,
      status: 'BLOCKED',
      body: redactSensitiveText(`Blocked: ${message}`),
      idempotencyKey: `telegram:blocked:${job.id}:${code}`
    });
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function reconcileExpiredAgentLeases(pool: Pool): Promise<{ requeued: number; blocked: number }> {
  const requeued = await pool.query(
    `UPDATE brad_agent_jobs SET status = 'QUEUED', lease_token = NULL, leased_until = NULL,
         worker_identity = NULL, next_attempt_at = now(), updated_at = now(), last_error = 'expired_before_run'
     WHERE status = 'LEASED' AND leased_until < now() RETURNING id`
  );
  const ambiguous = await pool.query<{ id: string; thread_id: string }>(
    `UPDATE brad_agent_jobs SET status = 'RECONCILE_REQUIRED', leased_until = NULL,
         updated_at = now(), last_error = 'expired_during_agent_run'
     WHERE status = 'RUNNING' AND leased_until < now() RETURNING id, thread_id`
  );
  if (ambiguous.rows.length > 0) {
    await pool.query(
      `UPDATE brad_agent_threads SET status = 'BLOCKED', blocker_code = 'AGENT_TURN_RECONCILE_REQUIRED',
           phase = 'RECOVERY', updated_at = now()
       WHERE id = ANY($1::uuid[])`,
      [ambiguous.rows.map((row) => row.thread_id)]
    );
  }
  return { requeued: requeued.rowCount ?? 0, blocked: ambiguous.rowCount ?? 0 };
}
