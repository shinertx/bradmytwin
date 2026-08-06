import {
  AGENT_IDS,
  buildFirstPrinciplesBrief,
  defaultAuthorityEnvelope,
  inferVerificationContract,
  nextAgentForTurn,
  redactSensitiveText,
  type AgentMessageType,
  type AgentThreadStatus
} from '@brad/domain';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { env } from '../config/env.js';
import { digestPayload, sha256 } from '../utils/hash.js';
import { pool, query } from './db.js';

export interface AgentThreadRecord {
  id: string;
  objective_id: string;
  person_id: string;
  status: AgentThreadStatus;
  reasoning_depth: 'LIGHT' | 'FULL';
  phase: string;
  lead_agent_id: string;
  next_agent_id: string | null;
  current_assignment: string;
  blocker_code: string | null;
  consecutive_agent_turns: number;
  max_consecutive_agent_turns: number;
  cost_micros: number;
  max_cost_micros: number;
  version: number;
  created_at: string;
  updated_at: string;
}

export interface AgentMessageRecord {
  id: string;
  thread_id: string;
  parent_message_id: string | null;
  sender_agent_id: string;
  recipient_agent_ids: string[];
  message_type: AgentMessageType;
  body: string;
  artifact_refs_json: unknown[];
  evidence_refs_json: unknown[];
  metadata_json: Record<string, unknown>;
  buzz_event_id: string | null;
  sequence_no: number;
  created_at: string;
}

export interface AgentThreadView {
  thread: AgentThreadRecord;
  objective: {
    id: string;
    goal: string;
    definition_of_done: string;
    verification_method: string;
    authority_level: string;
    status: string;
    final_evidence_json: Record<string, unknown>;
  };
  messages: AgentMessageRecord[];
}

type ConductorMode = 'off' | 'shadow' | 'active';

function bodyDigest(input: { sender: string; type: AgentMessageType; body: string }): string {
  return sha256(`${input.sender}\n${input.type}\n${input.body}`);
}

export class AgentConductorService {
  readonly mode: ConductorMode;

  constructor(mode: ConductorMode = env.BRAD_CONDUCTOR_MODE) {
    this.mode = mode;
  }

  async intake(input: {
    personId: string;
    sourceMessageId: string;
    text: string;
    sourceChannel: string;
    sessionKey?: string;
  }): Promise<{ threadId: string; objectiveId: string; mode: ConductorMode } | null> {
    if (this.mode === 'off') return null;

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const brief = buildFirstPrinciplesBrief(input.text);
      const verificationContract = inferVerificationContract(input.text);
      const objectiveKey = `message:${input.sourceMessageId}`;
      const objectiveId = randomUUID();
      const objectiveResult = await client.query<{ id: string }>(
        `INSERT INTO brad_objectives (
           id, person_id, source_message_id, session_key, goal, definition_of_done,
           verification_method, authority_level, status, current_step, next_action,
           idempotency_key
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'APPROVAL_REQUIRED','RUNNING','first_principles','dispatch_executive',$8)
         ON CONFLICT (person_id, idempotency_key) DO UPDATE SET updated_at = now()
         RETURNING id`,
        [
          objectiveId,
          input.personId,
          input.sourceMessageId,
          input.sessionKey ?? null,
          brief.objective,
          'The requested outcome is independently verified, or a precise blocker is recorded.',
          brief.decisiveTest,
          objectiveKey
        ]
      );
      const persistedObjectiveId = objectiveResult.rows[0].id;

      const existingThread = await client.query<{ id: string }>(
        `SELECT id FROM brad_agent_threads WHERE person_id = $1 AND objective_id = $2`,
        [input.personId, persistedObjectiveId]
      );
      if (existingThread.rows[0]) {
        await client.query('COMMIT');
        return { threadId: existingThread.rows[0].id, objectiveId: persistedObjectiveId, mode: this.mode };
      }

      const threadId = randomUUID();
      const status: AgentThreadStatus = this.mode === 'active' ? 'QUEUED' : 'SHADOW';
      const authority = defaultAuthorityEnvelope();
      await client.query(
        `INSERT INTO brad_agent_threads (
           id, person_id, objective_id, source_message_id, status, reasoning_depth,
           phase, lead_agent_id, next_agent_id, current_assignment, authority_json,
           max_consecutive_agent_turns, max_cost_micros
         ) VALUES ($1,$2,$3,$4,$5,$6,'INTAKE',$7,$7,$8,$9,$10,$11)`,
        [
          threadId,
          input.personId,
          persistedObjectiveId,
          input.sourceMessageId,
          status,
          brief.depth,
          AGENT_IDS.BRAD_KIMI,
          brief.objective,
          JSON.stringify(authority),
          env.BRAD_AGENT_MAX_TURNS,
          env.BRAD_AGENT_MAX_COST_MICROS
        ]
      );

      await client.query(
        `INSERT INTO brad_agent_thread_participants (thread_id, agent_id)
         SELECT $1, unnest($2::text[])
         ON CONFLICT DO NOTHING`,
        [threadId, [AGENT_IDS.OWNER, AGENT_IDS.SYSTEM, AGENT_IDS.BRAD_KIMI, AGENT_IDS.HERMES, AGENT_IDS.CODEX, AGENT_IDS.CLAUDE, AGENT_IDS.VERIFIER]]
      );

      const ownerMessage = await this.insertMessage(client, {
        personId: input.personId,
        threadId,
        objectiveId: persistedObjectiveId,
        senderAgentId: AGENT_IDS.OWNER,
        recipientAgentIds: [AGENT_IDS.BRAD_KIMI],
        messageType: 'OWNER_REQUEST',
        body: input.text,
        metadata: { sourceChannel: input.sourceChannel },
        idempotencyKey: `owner:${input.sourceMessageId}`
      });

      await this.insertMessage(client, {
        personId: input.personId,
        threadId,
        objectiveId: persistedObjectiveId,
        parentMessageId: ownerMessage.id,
        senderAgentId: AGENT_IDS.SYSTEM,
        recipientAgentIds: [AGENT_IDS.BRAD_KIMI],
        messageType: 'FIRST_PRINCIPLES',
        body: JSON.stringify(brief),
        metadata: { brief },
        idempotencyKey: `first-principles:${input.sourceMessageId}`
      });

      if (this.mode === 'active') {
        await this.enqueueJob(client, {
          personId: input.personId,
          threadId,
          triggerMessageId: ownerMessage.id,
          assignedAgentId: AGENT_IDS.BRAD_KIMI,
          request: {
            stage: 'EXECUTIVE_INTAKE',
            objective: brief.objective,
            brief,
            authority,
            ...(verificationContract ? { verificationContract } : {})
          },
          idempotencyKey: `job:executive:${input.sourceMessageId}`
        });
      }

      await client.query('COMMIT');
      return { threadId, objectiveId: persistedObjectiveId, mode: this.mode };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async getThread(personId: string, threadId: string): Promise<AgentThreadView | null> {
    const threads = await query<AgentThreadRecord>(
      `SELECT id, objective_id, person_id, status, reasoning_depth, phase, lead_agent_id,
              next_agent_id, current_assignment, blocker_code, consecutive_agent_turns,
              max_consecutive_agent_turns, cost_micros, max_cost_micros, version, created_at, updated_at
       FROM brad_agent_threads WHERE id = $1 AND person_id = $2`,
      [threadId, personId]
    );
    if (!threads[0]) return null;

    const objectives = await query<AgentThreadView['objective']>(
      `SELECT id, goal, definition_of_done, verification_method, authority_level, status, final_evidence_json
       FROM brad_objectives WHERE id = $1 AND person_id = $2`,
      [threads[0].objective_id, personId]
    );
    const messages = await query<AgentMessageRecord>(
      `SELECT id, thread_id, parent_message_id, sender_agent_id, recipient_agent_ids,
              message_type, body, artifact_refs_json, evidence_refs_json, metadata_json,
              buzz_event_id, sequence_no, created_at
       FROM brad_agent_messages WHERE thread_id = $1 AND person_id = $2 ORDER BY sequence_no`,
      [threadId, personId]
    );
    return { thread: threads[0], objective: objectives[0], messages };
  }

  async listThreads(personId: string, limit = 50): Promise<AgentThreadRecord[]> {
    return await query<AgentThreadRecord>(
      `SELECT id, objective_id, person_id, status, reasoning_depth, phase, lead_agent_id,
              next_agent_id, current_assignment, blocker_code, consecutive_agent_turns,
              max_consecutive_agent_turns, cost_micros, max_cost_micros, version, created_at, updated_at
       FROM brad_agent_threads WHERE person_id = $1 ORDER BY updated_at DESC LIMIT $2`,
      [personId, limit]
    );
  }

  async ownerMessage(input: { personId: string; threadId: string; body: string }): Promise<AgentMessageRecord | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const threadResult = await client.query<AgentThreadRecord>(
        `SELECT * FROM brad_agent_threads WHERE id = $1 AND person_id = $2 FOR UPDATE`,
        [input.threadId, input.personId]
      );
      const thread = threadResult.rows[0];
      if (!thread || ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(thread.status)) {
        await client.query('ROLLBACK');
        return null;
      }

      const idempotencyKey = `owner-followup:${sha256(input.body)}:${thread.version}`;
      const message = await this.insertMessage(client, {
        personId: input.personId,
        threadId: thread.id,
        objectiveId: thread.objective_id,
        senderAgentId: AGENT_IDS.OWNER,
        recipientAgentIds: [AGENT_IDS.BRAD_KIMI],
        messageType: 'OWNER_REQUEST',
        body: input.body,
        idempotencyKey
      });
      await client.query(
        `UPDATE brad_agent_threads
         SET status = CASE WHEN status = 'SHADOW' THEN status ELSE 'QUEUED' END,
             phase = 'OWNER_FOLLOWUP', next_agent_id = $2, consecutive_agent_turns = 0,
             blocker_code = NULL, version = version + 1, updated_at = now()
         WHERE id = $1`,
        [thread.id, AGENT_IDS.BRAD_KIMI]
      );
      if (this.mode === 'active') {
        await this.enqueueJob(client, {
          personId: input.personId,
          threadId: thread.id,
          triggerMessageId: message.id,
          assignedAgentId: AGENT_IDS.BRAD_KIMI,
          request: { stage: 'OWNER_FOLLOWUP', text: input.body },
          idempotencyKey: `job:${idempotencyKey}`
        });
      }
      await client.query('COMMIT');
      return message;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async setStatus(input: {
    personId: string;
    threadId: string;
    action: 'pause' | 'resume' | 'cancel';
  }): Promise<AgentThreadRecord | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const selected = await client.query<AgentThreadRecord>(
        `SELECT * FROM brad_agent_threads WHERE id = $1 AND person_id = $2 FOR UPDATE`,
        [input.threadId, input.personId]
      );
      const thread = selected.rows[0];
      if (!thread || ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(thread.status)) {
        await client.query('ROLLBACK');
        return null;
      }

      const status = input.action === 'pause'
        ? 'PAUSED'
        : input.action === 'cancel'
          ? 'CANCELLED'
          : this.mode === 'active' ? 'QUEUED' : 'SHADOW';
      const updated = await client.query<AgentThreadRecord>(
        `UPDATE brad_agent_threads
         SET status = $3,
             blocker_code = CASE WHEN $3 = 'PAUSED' THEN 'OWNER_PAUSED' ELSE NULL END,
             consecutive_agent_turns = CASE WHEN $3 = 'QUEUED' THEN 0 ELSE consecutive_agent_turns END,
             next_agent_id = CASE WHEN $3 = 'QUEUED' THEN COALESCE(next_agent_id, $4) ELSE next_agent_id END,
             phase = CASE WHEN $3 = 'QUEUED' THEN 'OWNER_RESUME' ELSE phase END,
             version = version + 1, updated_at = now(),
             finished_at = CASE WHEN $3 = 'CANCELLED' THEN now() ELSE finished_at END
         WHERE id = $1 AND person_id = $2
         RETURNING *`,
        [input.threadId, input.personId, status, AGENT_IDS.BRAD_KIMI]
      );

      if (status === 'CANCELLED') {
        await client.query(
          `UPDATE brad_agent_jobs SET status = 'CANCELLED', finished_at = now(), updated_at = now()
           WHERE thread_id = $1 AND person_id = $2 AND status IN ('QUEUED','WAITING','LEASED')`,
          [input.threadId, input.personId]
        );
        await client.query(
          `UPDATE brad_objectives
           SET status = 'CANCELLED', current_step = 'cancelled', next_action = 'none',
               version = version + 1, updated_at = now(), completed_at = now()
           WHERE id = $1 AND person_id = $2`,
          [thread.objective_id, input.personId]
        );
      } else if (status === 'QUEUED' && this.mode === 'active') {
        const activeJobs = await client.query<{ id: string }>(
          `SELECT id FROM brad_agent_jobs
           WHERE thread_id = $1 AND person_id = $2
             AND status IN ('QUEUED','WAITING','LEASED','RUNNING')
           LIMIT 1`,
          [thread.id, input.personId]
        );
        if (!activeJobs.rows[0]) {
          const trigger = await client.query<{ id: string }>(
            `SELECT id FROM brad_agent_messages
             WHERE thread_id = $1 AND person_id = $2
             ORDER BY sequence_no DESC LIMIT 1`,
            [thread.id, input.personId]
          );
          if (!trigger.rows[0]) throw new Error('agent_thread_resume_message_missing');
          await this.enqueueJob(client, {
            personId: input.personId,
            threadId: thread.id,
            triggerMessageId: trigger.rows[0].id,
            assignedAgentId: AGENT_IDS.BRAD_KIMI,
            request: { stage: 'OWNER_RESUME', objectiveId: thread.objective_id },
            idempotencyKey: `resume:${thread.id}:${thread.version}`
          });
        }
      }

      await client.query('COMMIT');
      return updated.rows[0] ?? null;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async claimBuzzOutbox(limit = 20): Promise<Array<Record<string, unknown>>> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `UPDATE brad_agent_outbox
         SET status = 'FAILED', last_error = 'stale_buzz_publish_claim',
             next_attempt_at = now(), updated_at = now()
         WHERE destination = 'BUZZ' AND status = 'PUBLISHING'
           AND updated_at < now() - interval '2 minutes'`
      );
      const rows = await client.query<Record<string, unknown>>(
        `WITH picked AS (
           SELECT id FROM brad_agent_outbox
           WHERE destination = 'BUZZ' AND status IN ('PENDING','FAILED') AND next_attempt_at <= now()
             AND attempt_count < 8
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $1
         )
         UPDATE brad_agent_outbox o
         SET status = 'PUBLISHING', attempt_count = attempt_count + 1, updated_at = now()
         FROM picked WHERE o.id = picked.id
         RETURNING o.*`,
        [limit]
      );
      await client.query('COMMIT');
      return rows.rows;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async completeBuzzOutbox(input: {
    outboxId: string;
    status: 'PUBLISHED' | 'FAILED' | 'RECONCILE_REQUIRED';
    externalEventId?: string;
    error?: string;
  }): Promise<boolean> {
    const rows = await query<{ id: string }>(
      `UPDATE brad_agent_outbox
       SET status = $2, external_event_id = $3, last_error = $4,
           next_attempt_at = CASE WHEN $2 = 'FAILED' THEN now() + interval '30 seconds' ELSE next_attempt_at END,
           published_at = CASE WHEN $2 = 'PUBLISHED' THEN now() ELSE published_at END,
           updated_at = now()
       WHERE id = $1 AND status = 'PUBLISHING' RETURNING id`,
      [input.outboxId, input.status, input.externalEventId ?? null, input.error ?? null]
    );
    if (input.status === 'PUBLISHED' && input.externalEventId) {
      await query(
        `UPDATE brad_agent_messages m SET buzz_event_id = $2
         FROM brad_agent_outbox o
         WHERE o.id = $1 AND o.message_id = m.id`,
        [input.outboxId, input.externalEventId]
      );
    }
    return Boolean(rows[0]);
  }

  async listWaitingBuzzJobs(): Promise<Array<Record<string, unknown>>> {
    return await query<Record<string, unknown>>(
      `SELECT j.id AS job_id, j.thread_id, j.assigned_agent_id,
              m.id AS message_id, m.buzz_event_id
       FROM brad_agent_jobs j
       JOIN brad_agent_messages m
         ON m.thread_id = j.thread_id AND m.metadata_json->>'jobId' = j.id::text
       WHERE j.status = 'WAITING'
         AND j.assigned_agent_id IN ('codex','claude')
         AND m.buzz_event_id IS NOT NULL
       ORDER BY j.updated_at`
    );
  }

  async ingestDeferredAgentReply(input: {
    jobId: string;
    agentId: 'codex' | 'claude';
    buzzEventId: string;
    text: string;
    artifactRefs?: unknown[];
    evidenceRefs?: unknown[];
    sessionId?: string;
  }): Promise<{ threadId: string; nextAgentId: string } | null> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const jobResult = await client.query<{
        id: string;
        person_id: string;
        thread_id: string;
        trigger_message_id: string;
        assigned_agent_id: 'codex' | 'claude';
        status: string;
      }>(
        `SELECT id, person_id, thread_id, trigger_message_id, assigned_agent_id, status
         FROM brad_agent_jobs WHERE id = $1 FOR UPDATE`,
        [input.jobId]
      );
      const job = jobResult.rows[0];
      if (!job || job.status !== 'WAITING' || job.assigned_agent_id !== input.agentId) {
        await client.query('ROLLBACK');
        return null;
      }
      const threadResult = await client.query<AgentThreadRecord & { authority_json: Record<string, unknown> }>(
        `SELECT * FROM brad_agent_threads WHERE id = $1 AND person_id = $2 FOR UPDATE`,
        [job.thread_id, job.person_id]
      );
      const thread = threadResult.rows[0];
      if (!thread || ['CANCELLED','SUCCEEDED','FAILED'].includes(thread.status)) {
        await client.query('ROLLBACK');
        return null;
      }

      const message = await this.insertMessage(client, {
        personId: job.person_id,
        threadId: thread.id,
        objectiveId: thread.objective_id,
        parentMessageId: job.trigger_message_id,
        senderAgentId: input.agentId,
        recipientAgentIds: [AGENT_IDS.HERMES],
        messageType: 'CRITIQUE',
        body: input.text,
        artifactRefs: input.artifactRefs,
        evidenceRefs: input.evidenceRefs,
        metadata: { source: 'buzz_bridge' },
        buzzEventId: input.buzzEventId,
        publishToBuzz: false,
        idempotencyKey: `buzz-reply:${input.buzzEventId}`
      });
      if (input.sessionId) {
        await client.query(
          `INSERT INTO brad_agent_sessions (person_id, thread_id, agent_id, provider_session_id, status, last_checkpoint_json)
           VALUES ($1,$2,$3,$4,'ACTIVE',$5)
           ON CONFLICT (thread_id, agent_id) DO UPDATE SET
             provider_session_id = EXCLUDED.provider_session_id, status = 'ACTIVE',
             last_checkpoint_json = EXCLUDED.last_checkpoint_json, last_used_at = now(), updated_at = now()`,
          [job.person_id, thread.id, input.agentId, input.sessionId, JSON.stringify({ messageId: message.id, buzzEventId: input.buzzEventId })]
        );
      }
      const nextAgent = nextAgentForTurn({ currentAgentId: input.agentId, reasoningDepth: thread.reasoning_depth, hasCritique: true });
      if (!nextAgent) throw new Error('deferred_reply_next_agent_missing');
      await client.query(
        `UPDATE brad_agent_jobs SET status = 'SUCCEEDED', finished_at = now(), leased_until = NULL, updated_at = now()
         WHERE id = $1`,
        [job.id]
      );
      await client.query(
        `UPDATE brad_agent_threads SET status = 'QUEUED', phase = 'DISPATCH', next_agent_id = $2,
             blocker_code = NULL, consecutive_agent_turns = consecutive_agent_turns + 1,
             version = version + 1, updated_at = now() WHERE id = $1`,
        [thread.id, nextAgent]
      );
      await this.enqueueJob(client, {
        personId: job.person_id,
        threadId: thread.id,
        triggerMessageId: message.id,
        assignedAgentId: nextAgent,
        request: { stage: `AFTER_${input.agentId.toUpperCase()}`, text: input.text },
        idempotencyKey: `next:${job.id}:${nextAgent}`
      });
      await client.query('COMMIT');
      return { threadId: thread.id, nextAgentId: nextAgent };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  private async insertMessage(client: PoolClient, input: {
    personId: string;
    threadId: string;
    objectiveId: string;
    parentMessageId?: string;
    senderAgentId: string;
    recipientAgentIds: string[];
    messageType: AgentMessageType;
    body: string;
    metadata?: Record<string, unknown>;
    artifactRefs?: unknown[];
    evidenceRefs?: unknown[];
    buzzEventId?: string;
    publishToBuzz?: boolean;
    idempotencyKey: string;
  }): Promise<AgentMessageRecord> {
    await client.query(`SELECT id FROM brad_agent_threads WHERE id = $1 FOR UPDATE`, [input.threadId]);
    const sequence = await client.query<{ next: string }>(
      `SELECT (COALESCE(MAX(sequence_no), 0) + 1)::text AS next FROM brad_agent_messages WHERE thread_id = $1`,
      [input.threadId]
    );
    const digest = bodyDigest({ sender: input.senderAgentId, type: input.messageType, body: input.body });
    const result = await client.query<AgentMessageRecord>(
      `INSERT INTO brad_agent_messages (
         id, person_id, thread_id, objective_id, parent_message_id, sender_agent_id,
         recipient_agent_ids, message_type, body, artifact_refs_json, evidence_refs_json,
         metadata_json, content_digest, idempotency_key, sequence_no
         , buzz_event_id
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
       ON CONFLICT (thread_id, idempotency_key) DO UPDATE SET idempotency_key = EXCLUDED.idempotency_key
       RETURNING *`,
      [
        randomUUID(), input.personId, input.threadId, input.objectiveId, input.parentMessageId ?? null,
        input.senderAgentId, input.recipientAgentIds, input.messageType, input.body,
        JSON.stringify(input.artifactRefs ?? []), JSON.stringify(input.evidenceRefs ?? []),
        JSON.stringify(input.metadata ?? {}), digest, input.idempotencyKey, Number(sequence.rows[0].next), input.buzzEventId ?? null
      ]
    );
    const message = result.rows[0];
    if (input.publishToBuzz !== false) await client.query(
      `INSERT INTO brad_agent_outbox (
         person_id, thread_id, message_id, destination, event_type, payload_json, idempotency_key
       ) VALUES ($1,$2,$3,'BUZZ','AGENT_MESSAGE',$4,$5)
       ON CONFLICT (destination, idempotency_key) DO NOTHING`,
      [
        input.personId,
        input.threadId,
        message.id,
        JSON.stringify({
          messageId: message.id,
          threadId: input.threadId,
          objectiveId: input.objectiveId,
          sender: input.senderAgentId,
          recipients: input.recipientAgentIds,
          type: input.messageType,
          body: redactSensitiveText(input.body)
        }),
        `buzz:${message.id}`
      ]
    );
    return message;
  }

  private async enqueueJob(client: PoolClient, input: {
    personId: string;
    threadId: string;
    triggerMessageId: string;
    assignedAgentId: string;
    request: Record<string, unknown>;
    idempotencyKey: string;
  }): Promise<void> {
    const requestJson = JSON.stringify(input.request);
    await client.query(
      `INSERT INTO brad_agent_jobs (
         person_id, thread_id, trigger_message_id, assigned_agent_id, status,
         request_json, request_digest, idempotency_key
       ) VALUES ($1,$2,$3,$4,'QUEUED',$5,$6,$7)
       ON CONFLICT (idempotency_key) DO NOTHING`,
      [input.personId, input.threadId, input.triggerMessageId, input.assignedAgentId, requestJson, digestPayload(input.request), input.idempotencyKey]
    );
    await client.query(
      `INSERT INTO brad_agent_outbox (
         person_id, thread_id, destination, event_type, payload_json, idempotency_key
       ) VALUES ($1,$2,'REDIS','AGENT_JOB_QUEUED',$3,$4)
       ON CONFLICT (destination, idempotency_key) DO NOTHING`,
      [input.personId, input.threadId, JSON.stringify({ threadId: input.threadId }), `redis:${input.idempotencyKey}`]
    );
  }
}
