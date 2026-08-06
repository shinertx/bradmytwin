import os from 'node:os';
import dotenv from 'dotenv';
import { Pool } from 'pg';
import { z } from 'zod';
import { ProcessHermesRunner } from './hermes-runner.js';
import { LinearGraphqlClient } from './linear-client.js';
import {
  processOneHermesJob,
  processOneLinearProjection,
  reconcileExpiredHermesLeases,
  reconcileLinearProjection,
  syncLinearProject,
  type LinearHermesConfig
} from './linear-hermes-control.js';

dotenv.config();

const env = z
  .object({
    DATABASE_URL: z.string(),
    BRAD_OWNER_PERSON_ID: z.string().uuid(),
    LINEAR_API_KEY: z.string().min(20).optional(),
    LINEAR_PROJECT_ID: z.string().default('18f0f6f2-60ae-49fb-a632-1e82e761f5cf'),
    LINEAR_DISPATCH_LABEL: z.string().default('Brad Run'),
    LINEAR_HERMES_LABEL: z.string().default('Hermes'),
    LINEAR_CANARY_LABEL: z.string().default('Brad Canary'),
    LINEAR_SKILL_LABEL_PREFIX: z.string().default('Skill:'),
    HERMES_ALLOWED_SKILLS: z.string().default(''),
    HERMES_RUNNER_PATH: z.string().default('/home/benjijmac/bin/hermes-task-runner.sh'),
    HERMES_OUTPUT_ROOT: z.string().default('/home/benjijmac/server-audits/brad-hermes-jobs'),
    HERMES_TASK_TIMEOUT_MS: z.coerce.number().int().positive().default(240000),
    HERMES_PROVIDER: z.string().default('openai-codex'),
    HERMES_MODEL: z.string().default('gpt-5.4-mini'),
    LINEAR_SYNC_INTERVAL_MS: z.coerce.number().int().positive().default(30000),
    LINEAR_REQUEST_TIMEOUT_MS: z.coerce.number().int().positive().default(15000),
    HERMES_DISPATCH_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
    LINEAR_PROJECTION_INTERVAL_MS: z.coerce.number().int().positive().default(10000),
    BRAD_WORKER_LEASE_SECONDS: z.coerce.number().int().positive().default(600)
  })
  .parse(process.env);

const config: LinearHermesConfig = {
  personId: env.BRAD_OWNER_PERSON_ID,
  projectId: env.LINEAR_PROJECT_ID,
  dispatchLabel: env.LINEAR_DISPATCH_LABEL,
  hermesLabel: env.LINEAR_HERMES_LABEL,
  canaryLabel: env.LINEAR_CANARY_LABEL,
  skillLabelPrefix: env.LINEAR_SKILL_LABEL_PREFIX,
  allowedSkills: env.HERMES_ALLOWED_SKILLS.split(',').map((skill) => skill.trim()).filter(Boolean),
  workerIdentity: `brad-linear-hermes:${os.hostname()}:${process.pid}`,
  leaseSeconds: env.BRAD_WORKER_LEASE_SECONDS
};

const pool = new Pool({ connectionString: env.DATABASE_URL, max: 6 });
const linear = env.LINEAR_API_KEY
  ? new LinearGraphqlClient(
      env.LINEAR_API_KEY,
      'https://api.linear.app/graphql',
      fetch,
      env.LINEAR_REQUEST_TIMEOUT_MS
    )
  : null;
const runner = new ProcessHermesRunner({
  runnerPath: env.HERMES_RUNNER_PATH,
  outputRoot: env.HERMES_OUTPUT_ROOT,
  timeoutMs: env.HERMES_TASK_TIMEOUT_MS,
  provider: env.HERMES_PROVIDER,
  model: env.HERMES_MODEL
});

function log(event: string, details: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ event, at: new Date().toISOString(), ...details }));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function serializedLoop(name: string, work: () => Promise<void>): () => void {
  let running = false;
  return () => {
    if (running) return;
    running = true;
    void work()
      .catch((error) => log(`${name}_failed`, { error: errorMessage(error).slice(0, 1000) }))
      .finally(() => {
        running = false;
      });
  };
}

const sync = serializedLoop('linear_sync', async () => {
  if (!linear) return;
  const results = await syncLinearProject(pool, linear, config);
  const changed = results.filter((result) => result.changed).length;
  const enqueued = results.filter((result) => result.enqueued).length;
  if (changed || enqueued) log('linear_sync_completed', { issues: results.length, changed, enqueued });
});

const dispatch = serializedLoop('hermes_dispatch', async () => {
  const processed = await processOneHermesJob(pool, runner, config);
  if (processed) log('hermes_job_processed');
});

const project = serializedLoop('linear_projection', async () => {
  if (!linear) return;
  const reconciled = await reconcileLinearProjection(pool, linear);
  const processed = await processOneLinearProjection(pool, linear, config);
  if (processed || reconciled.sent || reconciled.retried) {
    log('linear_projection_processed', { processed, ...reconciled });
  }
});

const recover = serializedLoop('lease_recovery', async () => {
  const result = await reconcileExpiredHermesLeases(pool);
  if (result.requeued || result.blocked) log('lease_recovery_completed', result);
});

async function main(): Promise<void> {
  await pool.query('SELECT 1 FROM brad_worker_jobs LIMIT 1');
  log('linear_hermes_daemon_started', {
    linearConfigured: Boolean(linear),
    projectId: config.projectId,
    model: env.HERMES_MODEL,
    provider: env.HERMES_PROVIDER,
    dispatchLabel: config.dispatchLabel,
    linearRequestTimeoutMs: env.LINEAR_REQUEST_TIMEOUT_MS
  });

  recover();
  sync();
  dispatch();
  project();

  const timers = [
    setInterval(recover, 60000),
    setInterval(sync, env.LINEAR_SYNC_INTERVAL_MS),
    setInterval(dispatch, env.HERMES_DISPATCH_INTERVAL_MS),
    setInterval(project, env.LINEAR_PROJECTION_INTERVAL_MS)
  ];

  await new Promise<void>((resolve) => {
    const shutdown = (): void => resolve();
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
  });
  for (const timer of timers) clearInterval(timer);
  await pool.end();
  log('linear_hermes_daemon_stopped');
}

main().catch((error) => {
  log('linear_hermes_daemon_fatal', { error: errorMessage(error).slice(0, 1000) });
  process.exit(1);
});
