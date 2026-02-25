import type { OpenClawResponse, ToolRequest } from '@brad/domain';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface ModelConfig {
  model: string;
  temperature: number;
  maxTokens: number;
}

export type OpenClawMode = 'stub' | 'http' | 'cli';

export interface OpenClawRuntimeBootInput {
  userId: string;
  skills: string[];
  permissions: {
    readAllowed: boolean;
    writeRequiresApproval: boolean;
  };
  connectorRefs: string[];
  runtimePolicy: {
    maxRetries: number;
    idleTimeoutMinutes: number;
  };
  modelConfig: ModelConfig;
}

export interface OpenClawExecuteInput {
  runtimeId: string;
  userId: string;
  messageId: string;
  inputText: string;
  skills: string[];
  permissions: {
    readAllowed: boolean;
    writeRequiresApproval: boolean;
  };
  connectorRefs: string[];
  runtimePolicy: {
    maxRetries: number;
    idleTimeoutMinutes: number;
  };
  modelConfig: ModelConfig;
}

export interface OpenClawClientOptions {
  mode?: OpenClawMode;
  cliBin?: string;
  cliTimeoutMs?: number;
}

export class OpenClawClient {
  private readonly mode: OpenClawMode;
  private readonly cliBin: string;
  private readonly cliTimeoutMs: number;

  constructor(
    private readonly baseUrl: string | undefined,
    private readonly apiKey: string | undefined,
    options: OpenClawClientOptions = {}
  ) {
    this.mode = options.mode ?? (baseUrl ? 'http' : 'stub');
    this.cliBin = options.cliBin ?? 'openclaw';
    this.cliTimeoutMs = options.cliTimeoutMs ?? 90_000;
  }

  async ensureRuntime(input: OpenClawRuntimeBootInput): Promise<{ runtimeId: string }> {
    if (this.mode === 'stub') {
      return { runtimeId: `local-runtime-${input.userId}` };
    }

    if (this.mode === 'cli') {
      return { runtimeId: `oc-session-${input.userId}` };
    }

    try {
      const res = await fetch(`${this.baseUrl}/v1/runtimes/ensure`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify(input)
      });

      if (!res.ok) {
        return { runtimeId: `fallback-runtime-${input.userId}` };
      }

      const body = (await res.json()) as { runtimeId?: string };
      return { runtimeId: body.runtimeId ?? `fallback-runtime-${input.userId}` };
    } catch {
      return { runtimeId: `fallback-runtime-${input.userId}` };
    }
  }

  async execute(input: OpenClawExecuteInput): Promise<OpenClawResponse> {
    if (this.mode === 'stub') {
      const toolRequests: ToolRequest[] = /schedule|calendar/i.test(input.inputText)
        ? [
            {
              id: randomUUID(),
              toolName: 'calendar.create_event',
              isWrite: true,
              actionType: 'CREATE_EVENT',
              payload: { raw: input.inputText }
            }
          ]
        : [];
      return {
        assistantText: toolRequests.length
          ? 'I can schedule that. I need your approval before creating the event.'
          : `Brad twin heard: ${input.inputText}`,
        toolRequests
      };
    }

    if (this.mode === 'cli') {
      return await this.executeViaCli(input);
    }

    try {
      const res = await fetch(`${this.baseUrl}/v1/twin/execute`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {})
        },
        body: JSON.stringify(input)
      });

      if (!res.ok) {
        return {
          assistantText: 'I could not reach the orchestration engine right now.',
          toolRequests: [],
          error: `openclaw_http_${res.status}`
        };
      }

      return (await res.json()) as OpenClawResponse;
    } catch {
      return {
        assistantText: 'I could not reach the orchestration engine right now.',
        toolRequests: [],
        error: 'openclaw_network_error'
      };
    }
  }

  private async executeViaCli(input: OpenClawExecuteInput): Promise<OpenClawResponse> {
    try {
      const { stdout } = await execFileAsync(
        this.cliBin,
        [
          'agent',
          '--session-id',
          input.runtimeId,
          '--message',
          input.inputText,
          '--json'
        ],
        {
          timeout: this.cliTimeoutMs,
          maxBuffer: 8 * 1024 * 1024
        }
      );

      const parsed = this.extractJson(stdout);
      const payloads = Array.isArray(parsed?.result?.payloads) ? parsed.result.payloads : [];
      const assistantText = payloads
        .map((p: { text?: string }) => p?.text ?? '')
        .filter(Boolean)
        .join('\n')
        .trim();

      return {
        assistantText: assistantText || 'I processed your request.',
        toolRequests: this.inferToolRequests(input.inputText)
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'unknown_cli_error';
      return {
        assistantText: 'I could not execute on the OpenClaw gateway right now.',
        toolRequests: [],
        error: `openclaw_cli_error:${message}`
      };
    }
  }

  private inferToolRequests(text: string): ToolRequest[] {
    const input = text.toLowerCase();
    const requests: ToolRequest[] = [];

    if (/(schedule|calendar|meeting|appointment)/i.test(input)) {
      requests.push({
        id: randomUUID(),
        toolName: 'calendar.create_event',
        isWrite: true,
        actionType: 'CREATE_EVENT',
        payload: { raw: text }
      });
    }

    if (/(send email|email .*send|reply to email)/i.test(input)) {
      requests.push({
        id: randomUUID(),
        toolName: 'gmail.send',
        isWrite: true,
        actionType: 'SEND_EMAIL',
        payload: { raw: text }
      });
    }

    if (/(fill out|submit form|apply on)/i.test(input)) {
      requests.push({
        id: randomUUID(),
        toolName: 'browser.submit_form',
        isWrite: true,
        actionType: 'SUBMIT_FORM',
        payload: { raw: text }
      });
    }

    return requests;
  }

  private extractJson(output: string): Record<string, any> {
    const trimmed = output.trim();
    const firstBrace = trimmed.indexOf('{');
    const lastBrace = trimmed.lastIndexOf('}');
    if (firstBrace === -1 || lastBrace === -1 || lastBrace < firstBrace) {
      return {};
    }

    const candidate = trimmed.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(candidate) as Record<string, any>;
    } catch {
      return {};
    }
  }
}
