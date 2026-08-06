import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { digestPayload } from './digest.js';
import type { HermesRunner, HermesRunResult } from './hermes-runner.js';
import type { LinearIssueSnapshot, LinearProjectionClient } from './linear-client.js';

export interface LinearHermesConfig {
  personId: string;
  projectId: string;
  dispatchLabel: string;
  hermesLabel: string;
  canaryLabel: string;
  skillLabelPrefix: string;
  allowedSkills: string[];
  workerIdentity: string;
  leaseSeconds: number;
}

export interface SyncResult {
  issueId: string;
  objectiveId: string;
  changed: boolean;
  enqueued: boolean;
  reason: string;
}

interface ObjectiveRow {
  id: string;
  version: number;
  status: string;
}

interface HermesJobRow {
  id: string;
  person_id: string;
  objective_id: string;
  request_digest: string;
  contract_version: number;
  input_json: Record<string, unknown>;
  skills_json: string[];
  toolsets_json: string[];
  attempt_count: number;
  max_attempts: number;
  lease_token: string;
}

interface ProjectionRow {
  id: string;
  person_id: string;
  objective_id: string | null;
  event_type: 'COMMENT' | 'SET_COMPLETED';
  idempotency_key: string;
  payload_json: Record<string, unknown>;
  lease_token: string;
}

function normalizedLabels(labels: string[]): string[] {
  return [...new Set(labels.map((label) => label.trim()).filter(Boolean))].sort((left, right) => left.localeCompare(right));
}

function hasLabel(labels: string[], expected: string): boolean {
  return labels.some((label) => label.toLowerCase() === expected.toLowerCase());
}

export function digestLinearIssue(issue: LinearIssueSnapshot): string {
  return digestPayload({
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description,
    priority: issue.priority,
    state: issue.state,
    team: issue.team,
    labels: normalizedLabels(issue.labels),
    url: issue.url
  });
}

export function deriveSkills(issue: LinearIssueSnapshot, config: LinearHermesConfig): string[] {
  const allowed = new Set(config.allowedSkills);
  return normalizedLabels(issue.labels)
    .filter((label) => label.toLowerCase().startsWith(config.skillLabelPrefix.toLowerCase()))
    .map((label) => label.slice(config.skillLabelPrefix.length).trim())
    .filter((skill) => allowed.has(skill));
}

export function deriveToolsets(issue: LinearIssueSnapshot, config: LinearHermesConfig): string[] {
  void issue;
  void config;
  // Hermes oneshot mode bypasses interactive tool approvals, so automated intake stays model-only.
  return ['clarify'];
}

function canDispatch(issue: LinearIssueSnapshot, config: LinearHermesConfig): boolean {
  return issue.state.type === 'started'
    && hasLabel(issue.labels, config.dispatchLabel)
    && hasLabel(issue.labels, config.hermesLabel);
}

function verificationSpec(issue: LinearIssueSnapshot, config: LinearHermesConfig): Record<string, unknown> | null {
  if (!hasLabel(issue.labels, config.canaryLabel)) return null;
  const marker = /^Verification marker:\s*([A-Z0-9_-]{8,120})\s*$/im.exec(issue.description)?.[1];
  return marker ? { kind: 'exact_marker', marker } : null;
}

function objectiveState(
  issue: LinearIssueSnapshot,
  dispatch: boolean,
  hasVerifiedReceipt: boolean
): { status: string; currentStep: string; nextAction: string } {
  if (issue.state.type === 'canceled') {
    return { status: 'CANCELLED', currentStep: 'linear_cancelled', nextAction: 'none' };
  }
  if (issue.state.type === 'completed') {
    return hasVerifiedReceipt
      ? { status: 'SUCCEEDED', currentStep: 'verified', nextAction: 'none' }
      : {
          status: 'WAITING',
          currentStep: 'linear_completion_claim',
          nextAction: 'independently_verify_before_accepting_done'
        };
  }
  if (dispatch) {
    return { status: 'RUNNING', currentStep: 'hermes_queued', nextAction: 'dispatch_bounded_hermes_job' };
  }
  return {
    status: issue.state.type === 'backlog' ? 'BLOCKED' : 'INTAKED',
    currentStep: 'linear_intake',
    nextAction: 'move_to_in_progress_and_add_brad_run_label'
  };
}

function buildHermesPrompt(issue: LinearIssueSnapshot): string {
  return [
    `Linear issue: ${issue.identifier}`,
    `Objective: ${issue.title}`,
    '',
    issue.description || 'No issue description was provided.',
    '',
    '# Authority boundary',
    'This is a bounded, read-only Brad worker assignment. Analyze only the evidence included in this issue and the managed current-state packet.',
    'Do not inspect additional files, call a terminal, run code, use a browser, or change local state.',
    'Do not send messages, make payments, file documents, deploy, change accounts or credentials, delete data, publish, or perform any other external write.',
    'Do not claim the objective is complete merely because you produced an answer. Separate actions taken, evidence, remaining blockers, and the cheapest decisive next test.',
    '',
    '# Required response',
    'Return concise sections for Result, Evidence, Actions Taken, Remaining Blockers, and Next Decisive Test.'
  ].join('\n');
}

async function insertCheckpoint(
  client: PoolClient,
  objectiveId: string,
  version: number,
  currentStep: string,
  nextAction: string,
  state: Record<string, unknown>
): Promise<void> {
  await client.query(
    `INSERT INTO brad_objective_checkpoints
       (objective_id, version, current_step, next_action, state_json)
     VALUES ($1,$2,$3,$4,$5::jsonb)
     ON CONFLICT (objective_id, version) DO NOTHING`,
    [objectiveId, version, currentStep, nextAction, JSON.stringify(state)]
  );
}

export async function syncLinearIssue(
  pool: Pool,
  issue: LinearIssueSnapshot,
  config: LinearHermesConfig
): Promise<SyncResult> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const digest = digestLinearIssue(issue);
    const mirror = await client.query<{ payload_digest: string; objective_id: string }>(
      `SELECT payload_digest, objective_id
       FROM brad_linear_issues
       WHERE person_id = $1 AND linear_issue_id = $2
       FOR UPDATE`,
      [config.personId, issue.id]
    );

    if (mirror.rows[0]?.payload_digest === digest) {
      await client.query(
        `UPDATE brad_linear_issues SET last_synced_at = now()
         WHERE person_id = $1 AND linear_issue_id = $2`,
        [config.personId, issue.id]
      );
      await client.query('COMMIT');
      return {
        issueId: issue.id,
        objectiveId: mirror.rows[0].objective_id,
        changed: false,
        enqueued: false,
        reason: 'unchanged'
      };
    }

    const existingObjective = await client.query<ObjectiveRow>(
      `SELECT id, version, status
       FROM brad_objectives
       WHERE person_id = $1 AND source_system = 'LINEAR' AND source_external_id = $2
       FOR UPDATE`,
      [config.personId, issue.id]
    );
    const verifiedReceipt = existingObjective.rows[0]
      ? await client.query<{ present: boolean }>(
          `SELECT EXISTS (
             SELECT 1 FROM brad_worker_receipts
             WHERE objective_id = $1 AND verification_status = 'VERIFIED'
           ) AS present`,
          [existingObjective.rows[0].id]
        )
      : { rows: [{ present: false }] };
    const dispatch = canDispatch(issue, config);
    const next = objectiveState(issue, dispatch, verifiedReceipt.rows[0]?.present === true);
    const assignedWorker = hasLabel(issue.labels, config.hermesLabel) ? 'HERMES' : null;
    let objective: ObjectiveRow;

    if (!existingObjective.rows[0]) {
      const inserted = await client.query<ObjectiveRow>(
        `INSERT INTO brad_objectives (
           person_id, goal, definition_of_done, verification_method, authority_level,
           status, current_step, next_action, idempotency_key, source_system,
           source_external_id, source_external_url, assigned_worker, source_updated_at
         ) VALUES (
           $1,$2,$3,$4,'APPROVAL_REQUIRED',$5,$6,$7,$8,'LINEAR',$9,$10,$11,$12
         )
         RETURNING id, version, status`,
        [
          config.personId,
          issue.title,
          `${issue.title} is complete and supported by an independently verified Brad receipt.`,
          'Use source-backed evidence or a provider receipt. A Linear status or worker answer alone is not proof.',
          next.status,
          next.currentStep,
          next.nextAction,
          `linear:${issue.id}`,
          issue.id,
          issue.url,
          assignedWorker,
          issue.updatedAt
        ]
      );
      objective = inserted.rows[0];
    } else {
      const updated = await client.query<ObjectiveRow>(
        `UPDATE brad_objectives
         SET goal = $2,
             status = $3,
             current_step = $4,
             next_action = $5,
             source_external_url = $6,
             assigned_worker = $7,
             source_updated_at = $8,
             version = version + 1,
             updated_at = now(),
             completed_at = CASE WHEN $3 IN ('SUCCEEDED','FAILED','CANCELLED') THEN now() ELSE NULL END
         WHERE id = $1
         RETURNING id, version, status`,
        [
          existingObjective.rows[0].id,
          issue.title,
          next.status,
          next.currentStep,
          next.nextAction,
          issue.url,
          assignedWorker,
          issue.updatedAt
        ]
      );
      objective = updated.rows[0];
    }

    await insertCheckpoint(client, objective.id, objective.version, next.currentStep, next.nextAction, {
      source: 'LINEAR',
      linearIssueId: issue.id,
      linearIdentifier: issue.identifier,
      sourceDigest: digest,
      sourceState: issue.state.name,
      sourceStateType: issue.state.type,
      linearCompletionIsProof: false
    });

    await client.query(
      `INSERT INTO brad_linear_issues (
         person_id, objective_id, linear_issue_id, linear_identifier, title, description,
         state_id, state_name, state_type, team_id, priority, labels_json, issue_url,
         source_updated_at, payload_digest
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12::jsonb,$13,$14,$15)
       ON CONFLICT (person_id, linear_issue_id) DO UPDATE SET
         objective_id = EXCLUDED.objective_id,
         linear_identifier = EXCLUDED.linear_identifier,
         title = EXCLUDED.title,
         description = EXCLUDED.description,
         state_id = EXCLUDED.state_id,
         state_name = EXCLUDED.state_name,
         state_type = EXCLUDED.state_type,
         team_id = EXCLUDED.team_id,
         priority = EXCLUDED.priority,
         labels_json = EXCLUDED.labels_json,
         issue_url = EXCLUDED.issue_url,
         source_updated_at = EXCLUDED.source_updated_at,
         payload_digest = EXCLUDED.payload_digest,
         last_synced_at = now()`,
      [
        config.personId,
        objective.id,
        issue.id,
        issue.identifier,
        issue.title,
        issue.description,
        issue.state.id,
        issue.state.name,
        issue.state.type,
        issue.team.id,
        issue.priority,
        JSON.stringify(normalizedLabels(issue.labels)),
        issue.url,
        issue.updatedAt,
        digest
      ]
    );

    let enqueued = false;
    if (dispatch && assignedWorker === 'HERMES') {
      const skills = deriveSkills(issue, config);
      const toolsets = deriveToolsets(issue, config);
      const input = {
        source: 'LINEAR',
        linearIssueId: issue.id,
        linearIdentifier: issue.identifier,
        teamId: issue.team.id,
        title: issue.title,
        description: issue.description,
        issueUrl: issue.url,
        authority: 'READ_ONLY_ANALYSIS',
        prompt: buildHermesPrompt(issue),
        toolsets,
        verification: verificationSpec(issue, config)
      };
      const requestDigest = digestPayload(input);
      const inserted = await client.query(
        `INSERT INTO brad_worker_jobs (
           person_id, objective_id, worker_kind, idempotency_key, request_digest,
           contract_version, input_json, skills_json, toolsets_json
         ) VALUES ($1,$2,'HERMES',$3,$4,$5,$6::jsonb,$7::jsonb,$8::jsonb)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          config.personId,
          objective.id,
          `linear:${issue.id}:hermes:${requestDigest}`,
          requestDigest,
          objective.version,
          JSON.stringify(input),
          JSON.stringify(skills),
          JSON.stringify(toolsets)
        ]
      );
      enqueued = inserted.rowCount === 1;
    }

    if (issue.state.type === 'canceled') {
      await client.query(
        `UPDATE brad_worker_jobs
         SET status = 'CANCELLED', updated_at = now(), finished_at = now()
         WHERE objective_id = $1 AND status IN ('QUEUED','LEASED')`,
        [objective.id]
      );
    }

    await client.query('COMMIT');
    return {
      issueId: issue.id,
      objectiveId: objective.id,
      changed: true,
      enqueued,
      reason: enqueued ? 'hermes_job_enqueued' : dispatch ? 'job_already_exists' : 'intake_only'
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function syncLinearProject(
  pool: Pool,
  linear: LinearProjectionClient,
  config: LinearHermesConfig
): Promise<SyncResult[]> {
  const issues = await linear.listProjectIssues(config.projectId);
  const results: SyncResult[] = [];
  for (const issue of issues) results.push(await syncLinearIssue(pool, issue, config));
  return results;
}

export async function claimHermesJob(pool: Pool, config: LinearHermesConfig): Promise<HermesJobRow | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query<{ id: string }>(
      `SELECT id FROM brad_worker_jobs
       WHERE worker_kind = 'HERMES'
         AND status = 'QUEUED'
         AND available_at <= now()
         AND attempt_count < max_attempts
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`
    );
    if (!selected.rows[0]) {
      await client.query('COMMIT');
      return null;
    }
    const leaseToken = randomUUID();
    const claimed = await client.query<HermesJobRow>(
      `UPDATE brad_worker_jobs
       SET status = 'LEASED', lease_owner = $2, lease_token = $3,
           leased_until = now() + ($4::text || ' seconds')::interval,
           attempt_count = attempt_count + 1, updated_at = now()
       WHERE id = $1
       RETURNING id, person_id, objective_id, request_digest, contract_version,
                 input_json, skills_json, toolsets_json, attempt_count, max_attempts, lease_token`,
      [selected.rows[0].id, config.workerIdentity, leaseToken, config.leaseSeconds]
    );
    await client.query('COMMIT');
    return claimed.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

async function startHermesAttempt(pool: Pool, job: HermesJobRow, config: LinearHermesConfig): Promise<string> {
  const attemptId = randomUUID();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const started = await client.query(
      `UPDATE brad_worker_jobs
       SET status = 'RUNNING', started_at = COALESCE(started_at, now()), updated_at = now()
       WHERE id = $1 AND status = 'LEASED' AND lease_token = $2
       RETURNING id`,
      [job.id, job.lease_token]
    );
    if (!started.rowCount) throw new Error('hermes_job_lease_lost');
    await client.query(
      `INSERT INTO brad_worker_job_attempts (
         id, job_id, attempt_no, lease_token, worker_identity, skills_json,
         toolsets_json, status, request_digest
       ) VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,'STARTED',$8)`,
      [
        attemptId,
        job.id,
        job.attempt_count,
        job.lease_token,
        config.workerIdentity,
        JSON.stringify(job.skills_json ?? []),
        JSON.stringify(job.toolsets_json ?? []),
        job.request_digest
      ]
    );
    await client.query('COMMIT');
    return attemptId;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function exactMarkerVerified(job: HermesJobRow, result: HermesRunResult): { verified: boolean; evidence: Record<string, unknown> } {
  const spec = job.input_json.verification;
  if (!spec || typeof spec !== 'object') return { verified: false, evidence: {} };
  const typed = spec as Record<string, unknown>;
  if (typed.kind !== 'exact_marker' || typeof typed.marker !== 'string') return { verified: false, evidence: {} };
  const verified = result.result.includes(typed.marker) && result.usage.completed === true && result.usage.failed !== true;
  return {
    verified,
    evidence: {
      kind: 'exact_marker',
      markerDigest: digestPayload(typed.marker),
      markerPresent: result.result.includes(typed.marker),
      usageCompleted: result.usage.completed === true,
      usageFailed: result.usage.failed === true
    }
  };
}

function receiptComment(
  job: HermesJobRow,
  result: HermesRunResult,
  verificationStatus: 'VERIFIED' | 'PENDING'
): string {
  return [
    'Brad worker receipt',
    '',
    `- Worker: Hermes (${result.provider}/${result.model})`,
    `- Toolsets: ${result.toolsets.join(', ') || 'none'}`,
    `- Session: ${result.sessionId}`,
    `- Result digest: ${result.resultDigest}`,
    `- Artifact digest: ${result.artifactSha256}`,
    `- Verification: ${verificationStatus}`,
    '',
    verificationStatus === 'VERIFIED'
      ? 'The configured independent canary check passed, so Brad accepted this objective as complete.'
      : 'The worker run finished, but the objective remains open until its real-world outcome is independently verified.'
  ].join('\n');
}

async function enqueueProjection(
  client: PoolClient,
  input: {
    personId: string;
    objectiveId: string;
    eventType: 'COMMENT' | 'SET_COMPLETED';
    idempotencyKey: string;
    payload: Record<string, unknown>;
  }
): Promise<void> {
  await client.query(
    `INSERT INTO brad_projection_outbox (
       person_id, objective_id, destination, event_type, idempotency_key, payload_json
     ) VALUES ($1,$2,'LINEAR',$3,$4,$5::jsonb)
     ON CONFLICT (idempotency_key) DO NOTHING`,
    [input.personId, input.objectiveId, input.eventType, input.idempotencyKey, JSON.stringify(input.payload)]
  );
}

async function finalizeHermesSuccess(
  pool: Pool,
  job: HermesJobRow,
  attemptId: string,
  result: HermesRunResult
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const verification = exactMarkerVerified(job, result);
    const verificationStatus = verification.verified ? 'VERIFIED' : 'PENDING';
    await client.query(
      `UPDATE brad_worker_job_attempts
       SET status = 'SUCCEEDED', provider = $2, model = $3, provider_session_id = $4,
           usage_json = $5::jsonb, artifact_uri = $6, artifact_sha256 = $7,
           result_digest = $8, finished_at = now()
       WHERE id = $1`,
      [
        attemptId,
        result.provider,
        result.model,
        result.sessionId,
        JSON.stringify(result.usage),
        result.artifactUri,
        result.artifactSha256,
        result.resultDigest
      ]
    );
    await client.query(
      `INSERT INTO brad_worker_receipts (
         job_id, attempt_id, objective_id, outcome, verification_status, result_digest,
         artifact_uri, artifact_sha256, worker_identity, provider, model, skills_json,
         toolsets_json, usage_json, verifier_kind, verifier_evidence_json, verified_at
       ) VALUES (
         $1,$2,$3,'WORKER_SUCCEEDED',$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12::jsonb,$13::jsonb,$14,$15::jsonb,
         CASE WHEN $4 = 'VERIFIED' THEN now() ELSE NULL END
       )`,
      [
        job.id,
        attemptId,
        job.objective_id,
        verificationStatus,
        result.resultDigest,
        result.artifactUri,
        result.artifactSha256,
        'hermes',
        result.provider,
        result.model,
        JSON.stringify(result.skills),
        JSON.stringify(result.toolsets),
        JSON.stringify(result.usage),
        verification.verified ? 'exact_marker_and_usage_receipt' : null,
        JSON.stringify(verification.evidence)
      ]
    );
    await client.query(
      `UPDATE brad_worker_jobs
       SET status = 'SUCCEEDED', lease_owner = NULL, lease_token = NULL, leased_until = NULL,
           finished_at = now(), updated_at = now(), last_error = NULL
       WHERE id = $1 AND lease_token = $2`,
      [job.id, job.lease_token]
    );

    const objective = await client.query<{ version: number }>(
      `UPDATE brad_objectives
       SET status = $2,
           current_step = $3,
           next_action = $4,
           version = version + 1,
           final_evidence_json = jsonb_build_object(
             'workerReceiptAttemptId', $5::text,
             'resultDigest', $6::text,
             'verificationStatus', $7::text
           ),
           completed_at = CASE WHEN $2 = 'SUCCEEDED' THEN now() ELSE NULL END,
           updated_at = now()
       WHERE id = $1
       RETURNING version`,
      [
        job.objective_id,
        verification.verified ? 'SUCCEEDED' : 'WAITING',
        verification.verified ? 'verified' : 'worker_receipt_recorded',
        verification.verified ? 'none' : 'independently_verify_objective_outcome',
        attemptId,
        result.resultDigest,
        verificationStatus
      ]
    );
    const version = objective.rows[0]?.version;
    if (!version) throw new Error('hermes_objective_missing');
    await insertCheckpoint(
      client,
      job.objective_id,
      version,
      verification.verified ? 'verified' : 'worker_receipt_recorded',
      verification.verified ? 'none' : 'independently_verify_objective_outcome',
      {
        jobId: job.id,
        attemptId,
        workerOutcome: 'SUCCEEDED',
        objectiveVerified: verification.verified,
        resultDigest: result.resultDigest
      }
    );

    // Only Linear-originated jobs may write receipts back to Linear. Jobs created
    // by the bounded Kimi gateway keep their receipt in Brad's control plane.
    if (job.input_json.source === 'LINEAR') {
      const linearIssueId = String(job.input_json.linearIssueId ?? '');
      const teamId = String(job.input_json.teamId ?? '');
      if (!linearIssueId) throw new Error('linear_projection_missing_issue_id');
      await enqueueProjection(client, {
        personId: job.person_id,
        objectiveId: job.objective_id,
        eventType: 'COMMENT',
        idempotencyKey: `hermes-receipt-comment:${attemptId}`,
        payload: {
          issueId: linearIssueId,
          body: receiptComment(job, result, verificationStatus)
        }
      });
      if (verification.verified) {
        if (!teamId) throw new Error('linear_projection_missing_team_id');
        await enqueueProjection(client, {
          personId: job.person_id,
          objectiveId: job.objective_id,
          eventType: 'SET_COMPLETED',
          idempotencyKey: `hermes-verified-complete:${attemptId}`,
          payload: { issueId: linearIssueId, teamId }
        });
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 1000) : String(error).slice(0, 1000);
}

async function finalizeHermesFailure(
  pool: Pool,
  job: HermesJobRow,
  attemptId: string,
  error: unknown
): Promise<void> {
  const message = errorText(error);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `UPDATE brad_worker_job_attempts
       SET status = 'FAILED', error = $2, finished_at = now()
       WHERE id = $1`,
      [attemptId, message]
    );
    await client.query(
      `INSERT INTO brad_worker_receipts (
         job_id, attempt_id, objective_id, outcome, verification_status,
         worker_identity, skills_json, toolsets_json, verifier_kind, verifier_evidence_json
       ) VALUES ($1,$2,$3,'WORKER_FAILED','REJECTED','hermes',$4::jsonb,$5::jsonb,'runner_exit',$6::jsonb)`,
      [
        job.id,
        attemptId,
        job.objective_id,
        JSON.stringify(job.skills_json ?? []),
        JSON.stringify(job.toolsets_json ?? []),
        JSON.stringify({ error: message })
      ]
    );
    await client.query(
      `UPDATE brad_worker_jobs
       SET status = 'RECONCILE_REQUIRED', lease_owner = NULL, lease_token = NULL,
           leased_until = NULL, finished_at = now(), updated_at = now(), last_error = $3
       WHERE id = $1 AND lease_token = $2`,
      [job.id, job.lease_token, message]
    );
    const objective = await client.query<{ version: number }>(
      `UPDATE brad_objectives
       SET status = 'BLOCKED', current_step = 'hermes_failure_reconciliation',
           next_action = 'inspect_worker_artifacts_before_retry', version = version + 1,
           last_error = $2, updated_at = now()
       WHERE id = $1
       RETURNING version`,
      [job.objective_id, message]
    );
    if (objective.rows[0]) {
      await insertCheckpoint(
        client,
        job.objective_id,
        objective.rows[0].version,
        'hermes_failure_reconciliation',
        'inspect_worker_artifacts_before_retry',
        { jobId: job.id, attemptId, error: message, automaticRetry: false }
      );
    }
    if (job.input_json.source === 'LINEAR') {
      const linearIssueId = String(job.input_json.linearIssueId ?? '');
      if (!linearIssueId) throw new Error('linear_projection_missing_issue_id');
      await enqueueProjection(client, {
        personId: job.person_id,
        objectiveId: job.objective_id,
        eventType: 'COMMENT',
        idempotencyKey: `hermes-failure-comment:${attemptId}`,
        payload: {
          issueId: linearIssueId,
          body: [
            'Brad worker receipt',
            '',
            '- Worker: Hermes',
            '- Outcome: RECONCILE REQUIRED',
            `- Error: ${message}`,
            '',
            'Brad will not retry automatically because the prior run may have produced local effects. Inspect the attempt evidence first.'
          ].join('\n')
        }
      });
    }
    await client.query('COMMIT');
  } catch (finalizeError) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw finalizeError;
  } finally {
    client.release();
  }
}

export async function processOneHermesJob(
  pool: Pool,
  runner: HermesRunner,
  config: LinearHermesConfig
): Promise<boolean> {
  const job = await claimHermesJob(pool, config);
  if (!job) return false;
  const attemptId = await startHermesAttempt(pool, job, config);
  try {
    const result = await runner.run({
      jobId: job.id,
      prompt: String(job.input_json.prompt ?? ''),
      skills: Array.isArray(job.skills_json) ? job.skills_json : [],
      toolsets: Array.isArray(job.toolsets_json) ? job.toolsets_json : ['clarify'],
      objectiveId: job.objective_id,
      threadId: String(job.input_json.threadId ?? job.objective_id),
      messageId: job.id,
      sessionId: typeof job.input_json.sessionId === 'string' ? job.input_json.sessionId : undefined,
      authorityEnvelope: {
        scope: 'linear_clarify_only',
        readOnly: true,
        externalWrites: false,
        allowedToolsets: Array.isArray(job.toolsets_json) ? job.toolsets_json : ['clarify']
      },
      artifactRoot: process.env.HERMES_OUTPUT_ROOT ?? '/home/benjijmac/.hermes/brad-agent-runs',
      mode: 'RESEARCH',
      replyTo: typeof job.input_json.linearIssueId === 'string' ? job.input_json.linearIssueId : undefined
    });
    await finalizeHermesSuccess(pool, job, attemptId, result);
  } catch (error) {
    await finalizeHermesFailure(pool, job, attemptId, error);
  }
  return true;
}

export async function reconcileExpiredHermesLeases(pool: Pool): Promise<{ requeued: number; blocked: number }> {
  const requeued = await pool.query(
    `UPDATE brad_worker_jobs j
     SET status = 'QUEUED', lease_owner = NULL, lease_token = NULL, leased_until = NULL,
         available_at = now(), updated_at = now(), last_error = 'lease_expired_before_attempt'
     WHERE j.status = 'LEASED' AND j.leased_until < now()
       AND NOT EXISTS (
         SELECT 1 FROM brad_worker_job_attempts a
         WHERE a.job_id = j.id AND a.attempt_no = j.attempt_count
       )
     RETURNING id`
  );
  const blocked = await pool.query<{ id: string; objective_id: string }>(
    `UPDATE brad_worker_jobs
     SET status = 'RECONCILE_REQUIRED', lease_owner = NULL, lease_token = NULL,
         leased_until = NULL, updated_at = now(), last_error = 'running_lease_expired'
     WHERE status IN ('LEASED','RUNNING') AND leased_until < now()
     RETURNING id, objective_id`
  );
  for (const row of blocked.rows) {
    await pool.query(
      `UPDATE brad_objectives
       SET status = 'BLOCKED', current_step = 'hermes_stale_attempt',
           next_action = 'reconcile_worker_artifacts_before_retry',
           last_error = 'running_lease_expired', version = version + 1, updated_at = now()
       WHERE id = $1`,
      [row.objective_id]
    );
  }
  return { requeued: requeued.rowCount ?? 0, blocked: blocked.rowCount ?? 0 };
}

async function claimProjection(pool: Pool, config: LinearHermesConfig): Promise<ProjectionRow | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query<{ id: string }>(
      `SELECT id FROM brad_projection_outbox
       WHERE destination = 'LINEAR' AND status = 'PENDING' AND available_at <= now()
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`
    );
    if (!selected.rows[0]) {
      await client.query('COMMIT');
      return null;
    }
    const leaseToken = randomUUID();
    const claimed = await client.query<ProjectionRow>(
      `UPDATE brad_projection_outbox
       SET status = 'LEASED', lease_owner = $2, lease_token = $3,
           leased_until = now() + ($4::text || ' seconds')::interval,
           attempt_count = attempt_count + 1, updated_at = now()
       WHERE id = $1
       RETURNING id, person_id, objective_id, event_type, idempotency_key,
                 payload_json, lease_token`,
      [selected.rows[0].id, config.workerIdentity, leaseToken, config.leaseSeconds]
    );
    await client.query('COMMIT');
    return claimed.rows[0];
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function outboxMarker(idempotencyKey: string): string {
  return `<!-- brad-outbox:${digestPayload(idempotencyKey)} -->`;
}

export async function processOneLinearProjection(
  pool: Pool,
  linear: LinearProjectionClient,
  config: LinearHermesConfig
): Promise<boolean> {
  const row = await claimProjection(pool, config);
  if (!row) return false;
  const issueId = String(row.payload_json.issueId ?? '');
  if (!issueId) {
    await pool.query(
      `UPDATE brad_projection_outbox
       SET status = 'FAILED', last_error = 'linear_projection_missing_issue_id', updated_at = now(),
           lease_owner = NULL, lease_token = NULL, leased_until = NULL
       WHERE id = $1 AND lease_token = $2`,
      [row.id, row.lease_token]
    );
    return true;
  }
  try {
    await pool.query(
      `UPDATE brad_projection_outbox
       SET status = 'PROVIDER_SUBMITTED', updated_at = now()
       WHERE id = $1 AND lease_token = $2`,
      [row.id, row.lease_token]
    );
    let providerEffectId: string;
    if (row.event_type === 'COMMENT') {
      const marker = outboxMarker(row.idempotency_key);
      const existing = await linear.findCommentByMarker(issueId, marker);
      providerEffectId = existing ?? await linear.createComment(
        issueId,
        `${String(row.payload_json.body ?? '')}\n\n${marker}`
      );
    } else {
      const teamId = String(row.payload_json.teamId ?? '');
      if (!teamId) throw new Error('linear_projection_missing_team_id');
      const stateId = await linear.resolveCompletedState(teamId);
      providerEffectId = await linear.setIssueState(issueId, stateId);
    }
    await pool.query(
      `UPDATE brad_projection_outbox
       SET status = 'SENT', provider_effect_id = $3, sent_at = now(), updated_at = now(),
           lease_owner = NULL, lease_token = NULL, leased_until = NULL, last_error = NULL
       WHERE id = $1 AND lease_token = $2`,
      [row.id, row.lease_token, providerEffectId]
    );
  } catch (error) {
    await pool.query(
      `UPDATE brad_projection_outbox
       SET status = 'RECONCILE_REQUIRED', last_error = $3, updated_at = now(),
           lease_owner = NULL, lease_token = NULL, leased_until = NULL
       WHERE id = $1 AND lease_token = $2`,
      [row.id, row.lease_token, errorText(error)]
    );
  }
  return true;
}

export async function reconcileLinearProjection(
  pool: Pool,
  linear: LinearProjectionClient
): Promise<{ sent: number; retried: number }> {
  const rows = await pool.query<{
    id: string;
    event_type: 'COMMENT' | 'SET_COMPLETED';
    idempotency_key: string;
    payload_json: Record<string, unknown>;
  }>(
    `SELECT id, event_type, idempotency_key, payload_json
     FROM brad_projection_outbox
     WHERE destination = 'LINEAR' AND status IN ('PROVIDER_SUBMITTED','RECONCILE_REQUIRED')
     ORDER BY created_at
     LIMIT 50`
  );
  let sent = 0;
  let retried = 0;
  for (const row of rows.rows) {
    const issueId = String(row.payload_json.issueId ?? '');
    if (!issueId) {
      await pool.query(
        `UPDATE brad_projection_outbox
         SET status = 'FAILED', last_error = 'linear_projection_missing_issue_id', updated_at = now(),
             lease_owner = NULL, lease_token = NULL, leased_until = NULL
         WHERE id = $1`,
        [row.id]
      );
      continue;
    }
    if (row.event_type === 'COMMENT') {
      const existing = await linear.findCommentByMarker(issueId, outboxMarker(row.idempotency_key));
      if (existing) {
        await pool.query(
          `UPDATE brad_projection_outbox
           SET status = 'SENT', provider_effect_id = $2, sent_at = now(), updated_at = now(), last_error = NULL
           WHERE id = $1`,
          [row.id, existing]
        );
        sent += 1;
        continue;
      }
    }
    await pool.query(
      `UPDATE brad_projection_outbox
       SET status = 'PENDING', available_at = now(), updated_at = now()
       WHERE id = $1`,
      [row.id]
    );
    retried += 1;
  }
  return { sent, retried };
}
