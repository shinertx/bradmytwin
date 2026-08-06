#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { readFile, realpath, stat } from 'node:fs/promises';
import dotenv from 'dotenv';
import pg from 'pg';

dotenv.config({ path: '/home/benjijmac/bradmytwin/.env' });

const { Pool } = pg;
const DATABASE_URL = process.env.DATABASE_URL;
const ARTIFACT_ROOT = '/home/benjijmac/server-audits/brad-hermes-jobs/';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTIONS = new Set(['DISPATCH_HERMES', 'WAIT', 'REQUEST_APPROVAL']);

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

function decodeDecision(encoded) {
  if (!encoded || encoded.length > 24000 || !/^[A-Za-z0-9_-]+$/.test(encoded)) {
    throw new Error('invalid_decision_encoding');
  }
  const raw = Buffer.from(encoded, 'base64url').toString('utf8');
  if (Buffer.byteLength(raw, 'utf8') > 16000) throw new Error('decision_too_large');
  return JSON.parse(raw);
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
  if (!operation || parts.length > 2 || !['health', 'pull', 'decide', 'receipt'].includes(operation)) {
    reject('command_not_allowed');
    return;
  }
  if ((operation === 'decide' || operation === 'receipt') !== Boolean(argument)) {
    reject('invalid_arguments');
    return;
  }

  const pool = new Pool({ connectionString: DATABASE_URL, max: 1 });
  try {
    if (operation === 'health') await health(pool);
    if (operation === 'pull') await pull(pool);
    if (operation === 'decide') await decide(pool, argument);
    if (operation === 'receipt') await receipt(pool, argument);
  } catch (error) {
    const code = error instanceof Error ? error.message : 'gateway_error';
    reject(/^[a-z0-9_]+$/.test(code) ? code : 'gateway_error', 1);
  } finally {
    await pool.end();
  }
}

await main();
