import { spawn } from 'node:child_process';

type JsonObject = Record<string, unknown>;

export interface CallEClientOptions {
  cliBin?: string;
  timeoutSeconds?: number;
  telemetry?: boolean;
  timezone?: string;
}

export interface CallEStartCallInput {
  toPhones: string[];
  goal: string;
  language?: string;
  region?: string;
  timezone?: string;
  ttlSeconds?: number;
}

export interface CallECallStatusInput {
  runId: string;
  cursor?: string;
  limit?: number;
  timezone?: string;
}

export class CallEClient {
  constructor(private readonly options: CallEClientOptions = {}) {}

  async authStatus(): Promise<JsonObject> {
    return await this.runJson(['auth', 'status']);
  }

  async startCall(input: CallEStartCallInput): Promise<JsonObject> {
    const args = ['call', 'start'];

    for (const phone of input.toPhones) {
      args.push('--to-phone', phone);
    }

    args.push('--goal', input.goal);
    this.pushOptional(args, '--language', input.language);
    this.pushOptional(args, '--region', input.region);
    this.pushOptional(args, '--timezone', input.timezone ?? this.options.timezone);
    this.pushOptional(args, '--ttl-seconds', input.ttlSeconds);

    return await this.runJson(args);
  }

  async getCallStatus(input: CallECallStatusInput): Promise<JsonObject> {
    const args = ['call', 'status', '--run-id', input.runId];
    this.pushOptional(args, '--cursor', input.cursor);
    this.pushOptional(args, '--limit', input.limit);
    this.pushOptional(args, '--timezone', input.timezone ?? this.options.timezone);
    return await this.runJson(args);
  }

  private pushOptional(args: string[], flag: string, value?: string | number): void {
    if (value === undefined || value === null || value === '') {
      return;
    }
    args.push(flag, String(value));
  }

  private async runJson(args: string[]): Promise<JsonObject> {
    const command = this.options.cliBin ?? 'npx';
    const commandArgs = command === 'npx' ? ['--no-install', 'calle', ...args] : args;
    if (this.options.telemetry === false) {
      commandArgs.push('--no-telemetry');
    }
    if (this.options.timeoutSeconds) {
      commandArgs.push('--timeout-seconds', String(this.options.timeoutSeconds));
    }

    const stdout = await new Promise<string>((resolve, reject) => {
      const child = spawn(command, commandArgs, {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          CALLE_TELEMETRY: this.options.telemetry === false ? '0' : process.env.CALLE_TELEMETRY
        }
      });

      let out = '';
      let err = '';
      child.stdout.setEncoding('utf8');
      child.stderr.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        out += chunk;
      });
      child.stderr.on('data', (chunk) => {
        err += chunk;
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) {
          resolve(out);
          return;
        }
        reject(new Error(`calle_cli_failed:${code}:${err.slice(0, 500)}`));
      });
    });

    try {
      return JSON.parse(stdout) as JsonObject;
    } catch {
      throw new Error(`calle_cli_invalid_json:${stdout.slice(0, 500)}`);
    }
  }
}
