import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { sha256 } from './digest.js';

export interface HermesRunRequest {
  jobId: string;
  prompt: string;
  skills: string[];
  toolsets: string[];
}

export interface HermesRunResult {
  sessionId: string;
  provider: string;
  model: string;
  skills: string[];
  toolsets: string[];
  result: string;
  resultDigest: string;
  artifactUri: string;
  artifactSha256: string;
  usage: Record<string, unknown>;
}

export interface HermesRunner {
  run(request: HermesRunRequest): Promise<HermesRunResult>;
}

export interface ProcessHermesRunnerOptions {
  runnerPath: string;
  outputRoot: string;
  timeoutMs: number;
  provider: string;
  model: string;
}

export class ProcessHermesRunner implements HermesRunner {
  constructor(private readonly options: ProcessHermesRunnerOptions) {}

  private runProcess(args: string[], env: NodeJS.ProcessEnv): Promise<string> {
    return new Promise((resolve, reject) => {
      const child = spawn(this.options.runnerPath, args, {
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
      let stdout = '';
      let stderr = '';
      let timedOut = false;
      let killTimer: NodeJS.Timeout | null = null;
      const append = (current: string, chunk: Buffer): string =>
        `${current}${chunk.toString('utf8')}`.slice(-2 * 1024 * 1024);

      child.stdout.on('data', (chunk: Buffer) => {
        stdout = append(stdout, chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = append(stderr, chunk);
      });
      child.on('error', reject);

      const killGroup = (signal: NodeJS.Signals): void => {
        if (!child.pid) return;
        try {
          process.kill(-child.pid, signal);
        } catch {
          child.kill(signal);
        }
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        killGroup('SIGTERM');
        killTimer = setTimeout(() => killGroup('SIGKILL'), 5000);
      }, this.options.timeoutMs);

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (killTimer) clearTimeout(killTimer);
        if (timedOut) {
          reject(new Error(`hermes_runner_timeout_${this.options.timeoutMs}ms`));
        } else if (code !== 0) {
          reject(new Error(`hermes_runner_exit_${code}:${stderr.trim().slice(0, 500)}`));
        } else {
          resolve(stdout);
        }
      });
    });
  }

  async run(request: HermesRunRequest): Promise<HermesRunResult> {
    const taskId = request.jobId.replace(/[^a-zA-Z0-9_-]/g, '-');
    const outputDir = path.join(this.options.outputRoot, taskId);
    const promptPath = path.join(outputDir, `${taskId}-prompt.md`);
    await mkdir(outputDir, { recursive: true, mode: 0o700 });
    await writeFile(promptPath, request.prompt, { encoding: 'utf8', mode: 0o600 });

    const stdout = await this.runProcess(
      [taskId, promptPath, outputDir],
      {
        ...process.env,
        HERMES_PROVIDER: this.options.provider,
        HERMES_MODEL: this.options.model,
        HERMES_SKILLS: request.skills.length ? request.skills.join(',') : 'none',
        HERMES_TOOLSETS: request.toolsets.join(',')
      }
    );

    const receiptLine = stdout.trim().split('\n').filter(Boolean).at(-1);
    if (!receiptLine) throw new Error('hermes_runner_missing_receipt_line');
    const [returnedTaskId, sessionId, provider, model, rawSkills, rawToolsets] = receiptLine.split('\t');
    if (returnedTaskId !== taskId || !sessionId || !provider || !model) {
      throw new Error('hermes_runner_invalid_receipt_line');
    }

    const artifactUri = path.join(outputDir, `${taskId}-hermes-result.md`);
    const usagePath = path.join(outputDir, `${taskId}-usage.json`);
    const [result, usageText] = await Promise.all([
      readFile(artifactUri, 'utf8'),
      readFile(usagePath, 'utf8')
    ]);
    if (!result.trim()) throw new Error('hermes_runner_empty_result');
    const usage = JSON.parse(usageText) as Record<string, unknown>;
    if (usage.completed !== true || usage.failed === true) {
      throw new Error('hermes_runner_usage_not_successful');
    }

    return {
      sessionId,
      provider,
      model,
      skills: rawSkills && rawSkills !== 'none' ? rawSkills.split(',').filter(Boolean) : [],
      toolsets: rawToolsets ? rawToolsets.split(',').filter(Boolean) : request.toolsets,
      result,
      resultDigest: sha256(result),
      artifactUri,
      artifactSha256: sha256(result),
      usage
    };
  }
}
