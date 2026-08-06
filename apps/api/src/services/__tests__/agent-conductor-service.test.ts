import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { digestPayload } from '../../utils/hash.js';
import { pool as servicePool } from '../db.js';
import { AgentConductorService } from '../agent-conductor-service.js';

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../..');
const DATABASE_URL = 'postgres://postgres:postgres@127.0.0.1:55433/brad_test';
const PERSON_A = '00000000-0000-4000-8000-000000000201';
const PERSON_B = '00000000-0000-4000-8000-000000000202';

async function canConnect(): Promise<boolean> {
  const probe = new Pool({ connectionString: DATABASE_URL, connectionTimeoutMillis: 1_000 });
  try {
    await probe.query('SELECT 1');
    return true;
  } catch {
    return false;
  } finally {
    await probe.end().catch(() => undefined);
  }
}

async function database(): Promise<Pool | null> {
  if (!(await canConnect())) {
    try {
      await execFileAsync('docker', ['compose', '-f', 'infra/docker/docker-compose.test.yml', 'up', '-d'], {
        cwd: REPO_ROOT,
        timeout: 120_000
      });
    } catch {
      return null;
    }
    const deadline = Date.now() + 60_000;
    while (Date.now() < deadline && !(await canConnect())) await new Promise((resolve) => setTimeout(resolve, 500));
  }
  if (!(await canConnect())) return null;
  const pool = new Pool({ connectionString: DATABASE_URL, max: 4 });
  for (const migration of ['005_brad_ownership_kernel.sql', '006_kernel_slice_1.sql', '010_agent_conductor.sql']) {
    await pool.query(await readFile(path.join(REPO_ROOT, 'infra/postgres/init', migration), 'utf8'));
  }
  return pool;
}

async function seedSource(pool: Pool, personId: string, text: string): Promise<string> {
  const baseThreadId = randomUUID();
  const messageId = randomUUID();
  await pool.query(
    `INSERT INTO persons (id, preferred_name, onboarding_state) VALUES ($1,$2,'ACTIVE')`,
    [personId, `Person ${personId.slice(-1)}`]
  );
  await pool.query(`INSERT INTO threads (id, person_id, primary_channel, status) VALUES ($1,$2,'WEB','ACTIVE')`, [baseThreadId, personId]);
  await pool.query(
    `INSERT INTO messages (id, person_id, channel, thread_id, direction, body)
     VALUES ($1,$2,'WEB',$3,'INBOUND',$4)`,
    [messageId, personId, baseThreadId, text]
  );
  return messageId;
}

describe('AgentConductorService', () => {
  let pool: Pool | null = null;
  const service = new AgentConductorService('active');

  beforeAll(async () => { pool = await database(); });
  afterAll(async () => {
    await pool?.end();
    await servicePool.end();
  });
  beforeEach(async () => {
    if (!pool) return;
    await pool.query(`TRUNCATE brad_agent_outbox, brad_agent_evaluations, brad_agent_jobs, brad_agent_sessions,
      brad_agent_messages, brad_agent_thread_participants, brad_agent_threads, brad_objective_checkpoints,
      brad_objective_attempts, brad_objectives, messages, threads, persons CASCADE`);
  });

  it('isolates thread reads by person and writes a worker-compatible request digest', async () => {
    if (!pool) return;
    const sourceA = await seedSource(pool, PERSON_A, 'Investigate the source and prove the result.');
    const sourceB = await seedSource(pool, PERSON_B, 'Create a private bounded plan.');
    const threadA = await service.intake({ personId: PERSON_A, sourceMessageId: sourceA, text: 'Investigate the source and prove the result.', sourceChannel: 'WEB' });
    const threadB = await service.intake({ personId: PERSON_B, sourceMessageId: sourceB, text: 'Create a private bounded plan.', sourceChannel: 'WEB' });
    expect(threadA).not.toBeNull();
    expect(threadB).not.toBeNull();
    expect(await service.getThread(PERSON_B, threadA!.threadId)).toBeNull();
    expect((await service.listThreads(PERSON_A)).map((thread) => thread.id)).toEqual([threadA!.threadId]);

    const job = await pool.query<{ request_json: Record<string, unknown>; request_digest: string }>(
      `SELECT request_json, request_digest FROM brad_agent_jobs WHERE thread_id = $1`,
      [threadA!.threadId]
    );
    expect(job.rows[0].request_digest).toBe(digestPayload(job.rows[0].request_json));
  });

  it('creates a new durable job when blocked work is resumed', async () => {
    if (!pool) return;
    const source = await seedSource(pool, PERSON_A, 'Run a bounded recovery test.');
    const created = await service.intake({ personId: PERSON_A, sourceMessageId: source, text: 'Run a bounded recovery test.', sourceChannel: 'WEB' });
    await pool.query(`UPDATE brad_agent_jobs SET status = 'FAILED' WHERE thread_id = $1`, [created!.threadId]);
    await pool.query(`UPDATE brad_agent_threads SET status = 'BLOCKED', blocker_code = 'TEST_BLOCKER' WHERE id = $1`, [created!.threadId]);
    const resumed = await service.setStatus({ personId: PERSON_A, threadId: created!.threadId, action: 'resume' });
    expect(resumed?.status).toBe('QUEUED');
    const jobs = await pool.query(`SELECT assigned_agent_id, status FROM brad_agent_jobs WHERE thread_id = $1 ORDER BY created_at`, [created!.threadId]);
    expect(jobs.rows).toEqual([
      { assigned_agent_id: 'brad-kimi', status: 'FAILED' },
      { assigned_agent_id: 'brad-kimi', status: 'QUEUED' }
    ]);
  });

  it('cancels the thread, objective, and all not-yet-running jobs atomically', async () => {
    if (!pool) return;
    const source = await seedSource(pool, PERSON_A, 'Cancel this test safely.');
    const created = await service.intake({ personId: PERSON_A, sourceMessageId: source, text: 'Cancel this test safely.', sourceChannel: 'WEB' });
    const cancelled = await service.setStatus({ personId: PERSON_A, threadId: created!.threadId, action: 'cancel' });
    expect(cancelled?.status).toBe('CANCELLED');
    expect((await pool.query(`SELECT status FROM brad_objectives WHERE id = $1`, [created!.objectiveId])).rows[0].status).toBe('CANCELLED');
    expect((await pool.query(`SELECT status FROM brad_agent_jobs WHERE thread_id = $1`, [created!.threadId])).rows[0].status).toBe('CANCELLED');
  });

  it('accepts a deferred critique only for the exact waiting agent and only once', async () => {
    if (!pool) return;
    const objective = 'Run a signed bridge test and include the exact marker BRIDGE_PROOF_OK.';
    const source = await seedSource(pool, PERSON_A, objective);
    const created = await service.intake({ personId: PERSON_A, sourceMessageId: source, text: objective, sourceChannel: 'WEB' });
    const job = await pool.query<{ id: string }>(`SELECT id FROM brad_agent_jobs WHERE thread_id = $1`, [created!.threadId]);
    await pool.query(`UPDATE brad_agent_jobs SET status = 'WAITING', assigned_agent_id = 'codex' WHERE id = $1`, [job.rows[0].id]);
    expect(await service.ingestDeferredAgentReply({ jobId: job.rows[0].id, agentId: 'claude', buzzEventId: 'evt-wrong', text: 'wrong signer' })).toBeNull();
    const accepted = await service.ingestDeferredAgentReply({ jobId: job.rows[0].id, agentId: 'codex', buzzEventId: 'evt-right', text: 'Require independent proof.' });
    expect(accepted).toMatchObject({ threadId: created!.threadId, nextAgentId: 'hermes' });
    expect(await service.ingestDeferredAgentReply({ jobId: job.rows[0].id, agentId: 'codex', buzzEventId: 'evt-right', text: 'duplicate' })).toBeNull();
    const nextJob = await pool.query<{ request_json: Record<string, unknown> }>(
      `SELECT request_json FROM brad_agent_jobs WHERE thread_id = $1 AND assigned_agent_id = 'hermes'`,
      [created!.threadId]
    );
    expect(nextJob.rows[0].request_json).toMatchObject({
      stage: 'AFTER_CODEX',
      objective,
      priorResult: 'Require independent proof.',
      verificationContract: { kind: 'EXACT_MARKER', expected: 'BRIDGE_PROOF_OK' }
    });
  });
});
