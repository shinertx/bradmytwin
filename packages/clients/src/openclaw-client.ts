import type { OpenClawResponse, ToolRequest } from '@brad/domain';
import { randomUUID } from 'node:crypto';

export interface ModelConfig {
  model: string;
  temperature: number;
  maxTokens: number;
}

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

export class OpenClawClient {
  constructor(private readonly baseUrl: string | undefined, private readonly apiKey: string | undefined) {}

  async ensureRuntime(input: OpenClawRuntimeBootInput): Promise<{ runtimeId: string }> {
    if (!this.baseUrl) {
      return { runtimeId: `local-runtime-${input.userId}` };
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
    if (!this.baseUrl) {
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
}
